// PKCS#12 (.pfx / .p12) reading (RFC 7292, RFC 8018), with WebCrypto or,
// without it, plain JavaScript (src/web_client/lib/cryptox.js).
// Supports what OpenSSL 3 and current Windows write: PBES2 with PBKDF2 and
// AES-CBC, an HMAC (PKCS#12 KDF) or PBMAC1 integrity check, and unencrypted
// bags. The older 3DES and RC2 encryptions go through legacy.js.
import * as der from './der.js';
import { parseCert, keyParams, verifyWith, orderChain, CURVES, OID_RSA, OID_EC } from './x509.js';
import { des3CbcDecrypt, rc2CbcDecrypt } from './legacy.js';
import * as X from './cryptox.js';

const OID = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  envelopedData: '1.2.840.113549.1.7.3',
  keyBag: '1.2.840.113549.1.12.10.1.1',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
  certBag: '1.2.840.113549.1.12.10.1.3',
  safeContentsBag: '1.2.840.113549.1.12.10.1.6',
  x509Certificate: '1.2.840.113549.1.9.22.1',
  localKeyId: '1.2.840.113549.1.9.21',
  friendlyName: '1.2.840.113549.1.9.20',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  pbmac1: '1.2.840.113549.1.5.14',
  pbeSha3Des: '1.2.840.113549.1.12.1.3',
  pbeSha2Des: '1.2.840.113549.1.12.1.4',
  pbeShaRc2_128: '1.2.840.113549.1.12.1.5',
  pbeShaRc2_40: '1.2.840.113549.1.12.1.6',
  desEde3Cbc: '1.2.840.113549.3.7',
};
const HASHES = {
  '1.3.14.3.2.26': 'SHA-1', '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384', '2.16.840.1.101.3.4.2.3': 'SHA-512',
};
const HMACS = {
  '1.2.840.113549.2.7': 'SHA-1', '1.2.840.113549.2.9': 'SHA-256',
  '1.2.840.113549.2.10': 'SHA-384', '1.2.840.113549.2.11': 'SHA-512',
};
const AES = { '2.16.840.1.101.3.4.1.2': 16, '2.16.840.1.101.3.4.1.22': 24, '2.16.840.1.101.3.4.1.42': 32 };
const HLEN = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };
const VLEN = { 'SHA-1': 64, 'SHA-256': 64, 'SHA-384': 128, 'SHA-512': 128 };

export class Pkcs12Error extends Error {
  constructor(msg, code) { super(msg); this.code = code; }
}

export const REWRITE_HELP =
  'Rewrite it with OpenSSL 3 (AES-256 and SHA-256, the default), then open the new file:\n' +
  '  openssl pkcs12 -in old.pfx -legacy -nodes | openssl pkcs12 -export -out new.pfx\n' +
  '(OpenSSL 1.1 has no -legacy option; leave it out.)';

const utf8 = (s) => new TextEncoder().encode(s);

// Password as PKCS#12 wants it for its own KDF: UTF-16BE plus a NUL.
function bmpPassword(pw) {
  if (pw === null) return new Uint8Array(0);
  return der.concat([der.bmpBytes(pw), new Uint8Array(2)]);
}

// RFC 7292 appendix B.2.
async function p12kdf(hash, pwBytes, salt, id, iter, n) {
  const u = HLEN[hash], v = VLEN[hash];
  const fill = (src) => {
    if (!src.length) return new Uint8Array(0);
    const out = new Uint8Array(v * Math.ceil(src.length / v));
    for (let i = 0; i < out.length; i++) out[i] = src[i % src.length];
    return out;
  };
  const D = new Uint8Array(v).fill(id);
  const I = der.concat([fill(salt), fill(pwBytes)]);
  const out = new Uint8Array(Math.ceil(n / u) * u);
  for (let c = 0; c * u < n; c++) {
    let A = der.concat([D, I]);
    for (let r = 0; r < iter; r++) A = await X.digest(hash, A);
    out.set(A, c * u);
    const B = new Uint8Array(v);
    for (let i = 0; i < v; i++) B[i] = A[i % u];
    for (let j = 0; j < I.length; j += v) {
      let carry = 1;
      for (let k = v - 1; k >= 0; k--) {
        const x = I[j + k] + B[k] + carry;
        I[j + k] = x & 0xff;
        carry = x >> 8;
      }
    }
  }
  return out.subarray(0, n);
}

async function pbkdf2(pw, params) {
  if (der.readOid(params.kid(0)) !== OID.pbkdf2) throw new Pkcs12Error('Unsupported key derivation in this file.', 'unsupported');
  const p = params.kid(1);
  const salt = der.readOctets(p.kid(0));
  const iter = Number(der.readInt(p.kid(1)));
  let keyLen = null, hash = 'SHA-1';
  for (const k of p.kids.slice(2)) {
    if (k.tag === 0x02) keyLen = Number(der.readInt(k));
    else if (k.tag === 0x30) {
      hash = HMACS[der.readOid(k.kid(0))];
      if (!hash) throw new Pkcs12Error('Unsupported PBKDF2 hash in this file.', 'unsupported');
    }
  }
  if (iter > 10000000) throw new Pkcs12Error('This file asks for an unreasonable number of iterations.', 'unsupported');
  return (n) => X.pbkdf2(hash, utf8(pw || ''), salt, iter, keyLen || n);
}

const aesCbcDecrypt = (key, iv, data) => X.aesCbcDecrypt(key, iv, data);

function legacyError() {
  return new Pkcs12Error('This file uses an old encryption (RC2 or 3DES) that this page does not support.\n' + REWRITE_HELP, 'legacy');
}

// Decrypts `data` with the AlgorithmIdentifier `alg`. Throws 'badpass' when
// the padding is wrong, which is what a wrong password looks like.
async function decrypt(alg, data, pw) {
  const o = der.readOid(alg.kid(0));
  try {
    if (o === OID.pbes2) {
      const params = alg.kid(1);
      const derive = await pbkdf2(pw, params.kid(0));
      const scheme = params.kid(1);
      const so = der.readOid(scheme.kid(0));
      const iv = der.readOctets(scheme.kid(1));
      if (AES[so]) return await aesCbcDecrypt(await derive(AES[so]), iv, data);
      if (so === OID.desEde3Cbc) return des3CbcDecrypt(await derive(24), iv, data);
      throw new Pkcs12Error('Unsupported cipher in this file (' + so + ').', 'unsupported');
    }
    const legacy = { [OID.pbeSha3Des]: [24, 'des3'], [OID.pbeShaRc2_128]: [16, 'rc2'], [OID.pbeShaRc2_40]: [5, 'rc2'] }[o];
    if (legacy) {
      const p = alg.kid(1);
      const salt = der.readOctets(p.kid(0));
      const iter = Number(der.readInt(p.kid(1)));
      const pwb = bmpPassword(pw);
      const key = await p12kdf('SHA-1', pwb, salt, 1, iter, legacy[0]);
      const iv = await p12kdf('SHA-1', pwb, salt, 2, iter, 8);
      if (legacy[1] === 'des3') return des3CbcDecrypt(key, iv, data);
      return rc2CbcDecrypt(key, legacy[0] * 8, iv, data);
    }
    if (o === OID.pbeSha2Des) throw legacyError();
    throw new Pkcs12Error('Unsupported encryption in this file (' + o + ').', 'unsupported');
  } catch (e) {
    if (e instanceof Pkcs12Error) throw e;
    if (e && e.code === 'unsupported-legacy') throw legacyError();
    throw new Pkcs12Error('Wrong password (the file would not decrypt).', 'badpass');
  }
}

async function checkMac(pfx, authSafeData, pw) {
  const mac = pfx.kids[2];
  if (!mac) return null;           // no integrity check in the file
  const digestInfo = mac.kid(0);
  const algOid = der.readOid(digestInfo.kid(0).kid(0));
  const want = der.readOctets(digestInfo.kid(1));
  if (algOid === OID.pbmac1) {
    const params = digestInfo.kid(0).kid(1);
    const derive = await pbkdf2(pw, params.kid(0));
    const hash = HMACS[der.readOid(params.kid(1).kid(0))];
    if (!hash) throw new Pkcs12Error('Unsupported PBMAC1 HMAC in this file.', 'unsupported');
    const got = await X.hmac(hash, await derive(HLEN[hash]), authSafeData);
    return der.eqBytes(got, want);
  }
  const hash = HASHES[algOid];
  if (!hash) throw new Pkcs12Error('Unsupported integrity check in this file (' + algOid + ').', 'unsupported');
  const salt = der.readOctets(mac.kid(1));
  const iter = mac.kids[2] ? Number(der.readInt(mac.kid(2))) : 1;
  if (iter > 10000000) throw new Pkcs12Error('This file asks for an unreasonable number of iterations.', 'unsupported');
  const key = await p12kdf(hash, bmpPassword(pw), salt, 3, iter, HLEN[hash]);
  const got = await X.hmac(hash, key, authSafeData);
  return der.eqBytes(got, want);
}

function bagAttrs(bag) {
  const out = {};
  const attrs = bag.kids[2];
  if (!attrs) return out;
  for (const a of attrs.kids) {
    const o = der.readOid(a.kid(0));
    const v = a.kid(1).kids[0];
    if (!v) continue;
    if (o === OID.localKeyId) out.localKeyId = der.hex(der.readOctets(v));
    if (o === OID.friendlyName) out.friendlyName = der.readStr(v);
  }
  return out;
}

async function readBags(safeContents, pw, out) {
  for (const bag of der.decode(safeContents).kids) {
    const id = der.readOid(bag.kid(0));
    const val = bag.kid(1).kid(0);
    const attrs = bagAttrs(bag);
    if (id === OID.certBag) {
      if (der.readOid(val.kid(0)) !== OID.x509Certificate) continue;
      const cert = parseCert(der.readOctets(val.kid(1).kid(0)));
      out.certs.push(Object.assign(cert, { localKeyId: attrs.localKeyId, friendlyName: attrs.friendlyName }));
    } else if (id === OID.keyBag) {
      out.keys.push(Object.assign({ pkcs8: val.raw.slice() }, attrs));
    } else if (id === OID.shroudedKeyBag) {
      const pkcs8 = await decrypt(val.kid(0), der.readOctets(val.kid(1)), pw);
      out.keys.push(Object.assign({ pkcs8 }, attrs));
    } else if (id === OID.safeContentsBag) {
      await readBags(val.raw, pw, out);
    }
  }
}

function keyAlgorithm(pkcs8) {
  const pki = der.decode(pkcs8);
  const alg = pki.kid(1);
  const o = der.readOid(alg.kid(0));
  if (o === OID_RSA) return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  if (o === OID_EC) {
    const curve = CURVES[der.readOid(alg.kid(1))];
    if (!curve) throw new Pkcs12Error('This key uses an elliptic curve Windows code signing does not support.', 'unsupported');
    return { name: 'ECDSA', namedCurve: curve, hash: 'SHA-256' };
  }
  throw new Pkcs12Error('This key type (' + o + ') is not supported for code signing.', 'unsupported');
}

// Opens a .pfx. Returns {key (a src/web_client/lib/cryptox.js key: a non-extractable
// CryptoKey, or the plain-JavaScript key where WebCrypto can't), cert (the leaf),
// chain (leaf first), algorithm}. `password` is a string ('' for none).
export async function openPfx(bytes, password) {
  let pfx;
  try {
    pfx = der.decode(bytes);
    if (Number(der.readInt(pfx.kid(0))) !== 3) throw new Error('version');
  } catch (e) {
    throw new Pkcs12Error('This is not a .pfx/.p12 file.', 'format');
  }
  const authSafe = pfx.kid(1);
  if (der.readOid(authSafe.kid(0)) !== OID.data) {
    throw new Pkcs12Error('This .pfx is protected with a public key, not a password; that is not supported.', 'unsupported');
  }
  const authSafeData = der.readOctets(authSafe.kid(1).kid(0));

  // An empty password can mean "no password" or "the empty string"; try both.
  let pw = password;
  const macOk = await checkMac(pfx, authSafeData, pw);
  if (macOk === false) {
    if (password === '' && await checkMac(pfx, authSafeData, null)) pw = null;
    else throw new Pkcs12Error('Wrong password.', 'badpass');
  }

  const out = { certs: [], keys: [] };
  for (const ci of der.decode(authSafeData).kids) {
    const type = der.readOid(ci.kid(0));
    if (type === OID.data) {
      await readBags(der.readOctets(ci.kid(1).kid(0)), pw, out);
    } else if (type === OID.encryptedData) {
      const eci = ci.kid(1).kid(0).kid(1);
      const enc = eci.kid(2);
      const data = enc.cons ? der.concat(enc.kids.map(der.readOctets)) : enc.value;
      await readBags(await decrypt(eci.kid(1), data, pw), pw, out);
    } else {
      throw new Pkcs12Error('This .pfx uses public-key encryption for its contents; that is not supported.', 'unsupported');
    }
  }
  if (!out.keys.length) throw new Pkcs12Error('There is no private key in this file.', 'nokey');
  if (!out.certs.length) throw new Pkcs12Error('There is no certificate in this file.', 'nocert');
  if (out.keys.length > 1) throw new Pkcs12Error('This file holds more than one private key; export just the code-signing one.', 'manykeys');

  const k = out.keys[0];
  const algorithm = keyAlgorithm(k.pkcs8);
  let key;
  try {
    key = await X.importPkcs8(k.pkcs8, algorithm);
  } catch (e) {
    throw new Pkcs12Error('The browser could not use this private key: ' + (e && e.message || e), 'import');
  }
  k.pkcs8.fill(0);

  // The leaf: the certificate with the key's localKeyId, else the one whose
  // public key verifies a test signature.
  let leaf = k.localKeyId && out.certs.find((c) => c.localKeyId === k.localKeyId);
  const probe = crypto.getRandomValues(new Uint8Array(32));
  let sig = await X.sign(key, probe);
  if (leaf && !(await verifyWith(leaf, probe, sig))) leaf = null;
  if (!leaf) {
    for (const c of out.certs) {
      try { keyParams(c); } catch (e) { continue; }
      if (await verifyWith(c, probe, sig)) { leaf = c; break; }
    }
  }
  if (!leaf) throw new Pkcs12Error('None of the certificates in this file matches its private key.', 'nomatch');
  return { key, algorithm, cert: leaf, chain: orderChain(leaf, out.certs) };
}

