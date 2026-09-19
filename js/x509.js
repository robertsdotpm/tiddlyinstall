// Just enough X.509 for signing: who a certificate names, its serial,
// its public key, and whether a key and a signature belong to it.
import * as der from './der.js';
import { verifySpki } from './cryptox.js';

const NAMES = {
  '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C', '2.5.4.7': 'L',
  '2.5.4.8': 'ST', '2.5.4.5': 'serialNumber', '1.2.840.113549.1.9.1': 'E',
};
export const CURVES = { '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521' };
export const OID_RSA = '1.2.840.113549.1.1.1';
export const OID_EC = '1.2.840.10045.2.1';

export function nameString(node) {
  const parts = [];
  for (const rdn of node.kids) {
    for (const atv of rdn.kids) {
      const o = der.readOid(atv.kid(0));
      let v;
      try { v = der.readStr(atv.kid(1)); } catch (e) { v = '?'; }
      parts.push((NAMES[o] || o) + '=' + v);
    }
  }
  return parts.join(', ');
}

function nameField(node, key) {
  for (const rdn of node.kids) for (const atv of rdn.kids) {
    if (NAMES[der.readOid(atv.kid(0))] === key) return der.readStr(atv.kid(1));
  }
  return '';
}

export function parseCert(bytes) {
  const u8 = bytes.slice();
  const c = der.decode(u8);
  const tbs = c.kid(0);
  let i = 0;
  if (tbs.kid(0).cls === 2 && tbs.kid(0).num === 0) i = 1;     // [0] version
  const serial = tbs.kid(i), issuer = tbs.kid(i + 2), validity = tbs.kid(i + 3),
    subject = tbs.kid(i + 4), spki = tbs.kid(i + 5);
  const alg = spki.kid(0);
  const keyOid = der.readOid(alg.kid(0));
  const curve = keyOid === OID_EC ? CURVES[der.readOid(alg.kid(1))] || null : null;
  return {
    der: c.raw,
    serialRaw: serial.raw,
    serialHex: der.hex(der.readUint(serial)),
    issuerRaw: issuer.raw,
    subjectRaw: subject.raw,
    issuer: nameString(issuer),
    subject: nameString(subject),
    commonName: nameField(subject, 'CN') || nameField(subject, 'O') || nameString(subject),
    notBefore: der.readTime(validity.kid(0)),
    notAfter: der.readTime(validity.kid(1)),
    spki: spki.raw,
    keyType: keyOid === OID_RSA ? 'rsa' : keyOid === OID_EC ? 'ec' : keyOid,
    curve,
    selfIssued: der.eqBytes(issuer.raw, subject.raw),
  };
}

// Certificates from PEM text, base64 DER, raw DER, or a PKCS#7 bundle (.p7b).
export function parseCertBundle(input) {
  let blobs = [];
  if (typeof input === 'string') {
    const re = /-----BEGIN (?:CERTIFICATE|PKCS7)-----([\s\S]*?)-----END (?:CERTIFICATE|PKCS7)-----/g;
    const pem = [];
    for (let m; (m = re.exec(input));) pem.push(m[1]);
    if (pem.length) blobs = pem.map((b) => der.unb64(b));
    else if (input.trim()) blobs = [der.unb64(input.trim())];
  } else {
    const t = new TextDecoder().decode(input.subarray(0, 64));
    if (t.includes('-----BEGIN')) return parseCertBundle(new TextDecoder().decode(input));
    blobs = [input];
  }
  const out = [];
  for (const b of blobs) {
    const n = der.decode(b);
    if (n.kid(0).tag === 0x06 && der.readOid(n.kid(0)) === '1.2.840.113549.1.7.2') {
      const sd = n.kid(1).kid(0);
      const certs = sd.ctx(0);
      if (certs) for (const k of certs.kids) if (k.tag === 0x30) out.push(parseCert(k.raw));
    } else out.push(parseCert(n.raw));
  }
  if (!out.length) throw new Error('No certificates found.');
  return out;
}

// WebCrypto parameters for a certificate's key.
export function keyParams(cert) {
  if (cert.keyType === 'rsa') return { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  if (cert.keyType === 'ec' && cert.curve) return { name: 'ECDSA', namedCurve: cert.curve, hash: 'SHA-256' };
  throw new Error('Unsupported key type in the certificate: ' + cert.keyType);
}

export function curveBytes(curve) { return curve === 'P-256' ? 32 : curve === 'P-384' ? 48 : 66; }

// ECDSA: WebCrypto uses r||s, CMS and OpenPGP use DER or MPIs.
export function ecdsaRawToDer(raw) {
  const h = raw.length / 2;
  return der.seq(der.int(raw.subarray(0, h)), der.int(raw.subarray(h)));
}
export function ecdsaDerToRaw(sig, n) {
  const s = der.decode(sig);
  const out = new Uint8Array(2 * n);
  for (const [i, k] of [[0, s.kid(0)], [1, s.kid(1)]]) {
    const v = der.readUint(k);
    if (v.length > n) throw new Error('ECDSA signature value too long');
    out.set(v, (i + 1) * n - v.length);
  }
  return out;
}

// Does `sig` over `data` verify with the certificate's key? For ECDSA, sig
// may be DER or r||s.
export async function verifyWith(cert, data, sig) {
  const p = keyParams(cert);
  let s = sig;
  if (p.name === 'ECDSA' && sig.length !== 2 * curveBytes(cert.curve)) {
    try { s = ecdsaDerToRaw(sig, curveBytes(cert.curve)); } catch (e) { return false; }
  }
  return verifySpki(p, cert.spki, s, data);
}

// Leaf first, then each issuer in turn, then anything left over.
export function orderChain(leaf, certs) {
  const out = [leaf];
  const rest = certs.filter((c) => !der.eqBytes(c.der, leaf.der));
  let cur = leaf;
  for (;;) {
    if (cur.selfIssued) break;
    const i = rest.findIndex((c) => der.eqBytes(c.subjectRaw, cur.issuerRaw));
    if (i < 0) break;
    cur = rest.splice(i, 1)[0];
    out.push(cur);
  }
  return out.concat(rest);
}
