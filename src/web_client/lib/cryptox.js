// The page's cryptography: WebCrypto (crypto.subtle) where the browser has
// it and supports the algorithm, else the plain JavaScript in sha.js,
// hmac-pbkdf2.js, aes.js, rsa.js, ec.js and ed25519.js.
//
// crypto.subtle is missing on plain-http pages and in old browsers, and
// many browsers with it lack Ed25519 (Chrome before 137, Firefox before 129,
// Safari before 17) or PBKDF2 (EdgeHTML). So each operation tries the
// native call first; if that throws, it runs the plain one, and if that
// fails too the native error is what's reported. USE_NATIVE below turns the
// native calls off for good; globalThis.TI_PURE_JS = true does it for a test.
//
// Private keys stay in the page either way: a native key is a
// non-extractable CryptoKey; a plain one is an object in this page's memory.
//
// Keys are {alg, native?: CryptoKey, pure?: object}; alg is WebCrypto-style:
// {name: 'RSASSA-PKCS1-v1_5', hash}, {name: 'ECDSA', namedCurve, hash} or
// {name: 'Ed25519'}. ECDSA signatures are r||s, as WebCrypto makes them;
// the plain ECDSA is deterministic (RFC 6979).
import { sha } from './sha.js';
import { hmac as pureHmac, pbkdf2 as purePbkdf2 } from './hmac-pbkdf2.js';
import * as AES from './aes.js';
import * as RSA from './rsa.js';
import * as EC from './ec.js';
import * as ED from './ed25519.js';

// The one switch: true uses the browser's (or Node's) WebCrypto wherever it
// works, with our code as the fallback; false uses our code everywhere.
const USE_NATIVE = true;

const G = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
const ED25519_PKCS8 = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export function subtle() {
  if (!USE_NATIVE || G.TI_PURE_JS) return null;
  const c = G.crypto;
  return (c && c.subtle) || null;
}

const u8 = (b) => new Uint8Array(b);

// Native first; on failure the plain one; the native error if both fail.
async function either(native, pure) {
  const s = subtle();
  if (!s) return pure();
  try {
    return await native(s);
  } catch (e) {
    try { return pure(); } catch (e2) { throw e; }
  }
}

export function randomBytes(n) {
  return G.crypto.getRandomValues(new Uint8Array(n));
}

// hash: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'
export function digest(hash, data) {
  return either(async (s) => u8(await s.digest(hash, data)), () => sha(hash, data));
}

export function hmac(hash, key, data) {
  return either(async (s) => {
    const k = await s.importKey('raw', key, { name: 'HMAC', hash }, false, ['sign']);
    return u8(await s.sign('HMAC', k, data));
  }, () => pureHmac(hash, key, data));
}

export function pbkdf2(hash, password, salt, iterations, length) {
  return either(async (s) => {
    const k = await s.importKey('raw', password, 'PBKDF2', false, ['deriveBits']);
    return u8(await s.deriveBits({ name: 'PBKDF2', salt, iterations, hash }, k, 8 * length));
  }, () => purePbkdf2(hash, password, salt, iterations, length));
}

// PKCS#7 padding; decrypt throws if it is wrong (a wrong key, usually).
export function aesCbcDecrypt(key, iv, data) {
  return either(async (s) => {
    const k = await s.importKey('raw', key, 'AES-CBC', false, ['decrypt']);
    return u8(await s.decrypt({ name: 'AES-CBC', iv }, k, data));
  }, () => AES.aesCbcDecrypt(key, iv, data));
}

export function aesCbcEncrypt(key, iv, data) {
  return either(async (s) => {
    const k = await s.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    return u8(await s.encrypt({ name: 'AES-CBC', iv }, k, data));
  }, () => AES.aesCbcEncrypt(key, iv, data));
}

// Full-block CFB (OpenPGP's). WebCrypto has no CFB; its AES-CBC with a zero
// IV encrypts one block at a time.
export function aesCfb(key, iv, data, decrypt) {
  return either(async (s) => {
    const k = await s.importKey('raw', key, 'AES-CBC', false, ['encrypt']);
    const zero = new Uint8Array(16), out = new Uint8Array(data.length);
    let prev = iv.subarray(0, 16);
    for (let o = 0; o < data.length; o += 16) {
      const ks = u8(await s.encrypt({ name: 'AES-CBC', iv: zero }, k, prev)).subarray(0, 16);
      const n = Math.min(16, data.length - o);
      for (let i = 0; i < n; i++) out[o + i] = data[o + i] ^ ks[i];
      prev = new Uint8Array(16);
      prev.set((decrypt ? data : out).subarray(o, o + n));
    }
    return out;
  }, () => AES.aesCfb(key, iv, data, decrypt));
}

/* ---------- signatures ---------- */

function signParams(alg) {
  if (alg.name === 'ECDSA') return { name: 'ECDSA', hash: alg.hash };
  if (alg.name === 'Ed25519') return { name: 'Ed25519' };
  return { name: alg.name };
}

function purePrivate(alg, pkcs8) {
  if (alg.name === 'ECDSA') {
    const k = EC.parsePkcs8(pkcs8);
    if (alg.namedCurve && k.curve !== alg.namedCurve) throw new Error('ECDSA: the key is on ' + k.curve + ', not ' + alg.namedCurve);
    return k;
  }
  if (alg.name === 'RSASSA-PKCS1-v1_5') return RSA.parsePkcs8(pkcs8);
  throw new Error('Unsupported key algorithm ' + alg.name);
}

// A signing key from PKCS#8 DER.
export async function importPkcs8(pkcs8, alg) {
  const s = subtle();
  let err = null;
  if (s) {
    try { return { alg, native: await s.importKey('pkcs8', pkcs8, alg, false, ['sign']) }; } catch (e) { err = e; }
  }
  try { return { alg, pure: purePrivate(alg, pkcs8) }; } catch (e) { throw err || e; }
}

// RSA from its parts (big-endian bytes {n, e, d, p, q}); the CRT values are
// worked out here.
export async function importRsaParts(parts, hash) {
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: hash || 'SHA-256' };
  const k = RSA.fromParts(parts);
  const s = subtle();
  if (s) {
    try {
      const p = RSA.toBytesParts(k);
      const jwk = { kty: 'RSA', ext: false, key_ops: ['sign'] };
      for (const name of ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi']) jwk[name] = b64url(p[name]);
      return { alg, native: await s.importKey('jwk', jwk, alg, false, ['sign']) };
    } catch (e) { /* the plain key below */ }
  }
  return { alg, pure: k };
}

// A new RSA key: {key, parts: {n, e, d, p, q} as bytes}.
export async function generateRsa(bits, hash) {
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: hash || 'SHA-256' };
  const s = subtle();
  if (s) {
    try {
      const kp = await s.generateKey(Object.assign({ modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]) }, alg), true, ['sign', 'verify']);
      const jwk = await s.exportKey('jwk', kp.privateKey);
      const parts = {};
      for (const name of ['n', 'e', 'd', 'p', 'q']) parts[name] = unb64url(jwk[name]);
      return { key: { alg, native: kp.privateKey }, parts };
    } catch (e) { /* the plain generator below */ }
  }
  const k = RSA.generate(bits);
  return { key: { alg, pure: k }, parts: RSA.toBytesParts(k) };
}

// Ed25519 from its 32-byte seed.
export async function importEd25519(seed) {
  const alg = { name: 'Ed25519' };
  const s = subtle();
  if (s) {
    try {
      const der = new Uint8Array(48);
      der.set(ED25519_PKCS8); der.set(seed, 16);
      return { alg, native: await s.importKey('pkcs8', der, 'Ed25519', false, ['sign']) };
    } catch (e) { /* the plain key below */ }
  }
  return { alg, pure: { seed: seed.slice(), pub: ED.publicFromSeed(seed) } };
}

// A new Ed25519 key pair as bytes: {pub, seed}.
export async function generateEd25519() {
  const s = subtle();
  if (s) {
    try {
      const kp = await s.generateKey('Ed25519', true, ['sign', 'verify']);
      const pub = u8(await s.exportKey('raw', kp.publicKey));
      const seed = u8(await s.exportKey('pkcs8', kp.privateKey)).slice(-32);
      return { pub, seed };
    } catch (e) { /* the plain one below */ }
  }
  const seed = randomBytes(32);
  return { pub: ED.publicFromSeed(seed), seed };
}


// Signs data (hashing it as the algorithm says). RSA: PKCS#1 v1.5;
// ECDSA: r||s; Ed25519: the 64-byte signature.
export async function sign(key, data) {
  if (key.native) return u8(await subtle().sign(signParams(key.alg), key.native, data));
  const k = key.pure, alg = key.alg;
  if (alg.name === 'ECDSA') return EC.sign(k, alg.hash, data);
  if (alg.name === 'Ed25519') return ED.sign(k.seed, data, k.pub);
  return RSA.sign(k, alg.hash, data);
}

// Does sig verify over data with this SubjectPublicKeyInfo (DER)? False,
// not an exception, for a bad key or signature.
export async function verifySpki(alg, spki, sig, data) {
  const s = subtle();
  if (s) {
    try {
      const key = await s.importKey('spki', spki, alg, false, ['verify']);
      return await s.verify(signParams(alg), key, sig, data);
    } catch (e) { /* the plain check below */ }
  }
  try {
    if (alg.name === 'ECDSA') {
      const k = EC.parseSpki(spki);
      if (alg.namedCurve && k.curve !== alg.namedCurve) return false;
      return EC.verify(k, alg.hash, data, sig);
    }
    if (alg.name === 'RSASSA-PKCS1-v1_5') return RSA.verify(RSA.parseSpki(spki), alg.hash, data, sig);
    if (alg.name === 'Ed25519') return ED.verify(spki.subarray(spki.length - 32), data, sig);
  } catch (e) { /* not a key we can read */ }
  return false;
}

// Which operations run natively here (for tests and diagnostics).
export async function nativeReport() {
  const s = subtle(), out = { subtle: !!s };
  if (!s) return out;
  const tryIt = async (f) => { try { await f(); return true; } catch (e) { return false; } };
  out.sha256 = await tryIt(() => s.digest('SHA-256', new Uint8Array(1)));
  out.pbkdf2 = await tryIt(() => s.importKey('raw', new Uint8Array(8), 'PBKDF2', false, ['deriveBits']));
  out.ed25519 = await tryIt(() => s.generateKey('Ed25519', false, ['sign', 'verify']));
  return out;
}

/* ---------- base64url for JWK ---------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    s += B64[n >> 18] + B64[(n >> 12) & 63];
    if (i + 1 < bytes.length) s += B64[(n >> 6) & 63];
    if (i + 2 < bytes.length) s += B64[n & 63];
  }
  return s;
}
function unb64url(s) {
  s = s.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor(s.length * 3 / 4));
  let acc = 0, bits = 0, o = 0;
  for (let i = 0; i < s.length; i++) {
    const v = B64.indexOf(s[i] === '+' ? '-' : s[i] === '/' ? '_' : s[i]);
    if (v < 0) throw new Error('bad base64url');
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return out;
}
