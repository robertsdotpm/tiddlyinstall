// RSA PKCS#1 v1.5 signatures (RFC 8017) over web/lib/bignum.js, for browsers
// without WebCrypto. web/lib/cryptox.js uses this only when the native RSA is
// missing. Written for this project; no dependencies but ours.
//
//   parsePkcs8(der) / parseSpki(der) -> key {n, e, d?, p?, q?, dp?, dq?, qi?}
//                                        (bignums; see bignum.js)
//   fromParts({n, e, d, p, q}) -> key   (big-endian byte arrays)
//   sign(key, hash, data) -> Uint8Array  (hashes data itself, like WebCrypto)
//   verify(key, hash, data, sig) -> boolean
//   generate(bits) -> key               (e = 65537)
//   toBytesParts(key) -> {n, e, d, p, q, dp, dq, qi} as byte arrays
import * as B from './bignum.js';
import * as der from './der.js';
import { sha, hashName } from './sha.js';

const OID_RSA = '1.2.840.113549.1.1.1';

// DER DigestInfo prefixes (RFC 8017 section 9.2, note 1).
const DIGEST_INFO = {
  'SHA-1': '3021300906052b0e03021a05000414',
  'SHA-256': '3031300d060960864801650304020105000420',
  'SHA-384': '3041300d060960864801650304020205000430',
  'SHA-512': '3051300d060960864801650304020305000440',
};

function hexBytes(h) {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
  return out;
}

const int = (node) => B.fromBytes(der.readUint(node));

// Completes a private key: CRT values and the Montgomery contexts.
function complete(k) {
  k.bits = B.bitLength(k.n);
  k.len = (k.bits + 7) >> 3;
  if (k.p && k.q) {
    const one = B.ONE;
    if (!k.dp) k.dp = B.mod(k.d, B.sub(k.p, one));
    if (!k.dq) k.dq = B.mod(k.d, B.sub(k.q, one));
    if (!k.qi) k.qi = B.modInv(k.q, k.p);
  }
  return k;
}

// RSAPrivateKey inside a PKCS#8 PrivateKeyInfo.
export function parsePkcs8(bytes) {
  const pki = der.decode(bytes);
  if (der.readOid(pki.kid(1).kid(0)) !== OID_RSA) throw new Error('Not an RSA private key');
  const k = der.decode(der.readOctets(pki.kid(2)));
  return complete({
    n: int(k.kid(1)), e: int(k.kid(2)), d: int(k.kid(3)), p: int(k.kid(4)), q: int(k.kid(5)),
    dp: int(k.kid(6)), dq: int(k.kid(7)), qi: int(k.kid(8)),
  });
}

export function parseSpki(bytes) {
  const spki = der.decode(bytes);
  if (der.readOid(spki.kid(0).kid(0)) !== OID_RSA) throw new Error('Not an RSA public key');
  const k = der.decode(der.readBits(spki.kid(1)));
  return complete({ n: int(k.kid(0)), e: int(k.kid(1)) });
}

export function fromParts(parts) {
  const k = { n: B.fromBytes(parts.n), e: B.fromBytes(parts.e) };
  if (parts.d) k.d = B.fromBytes(parts.d);
  if (parts.p && parts.q) { k.p = B.fromBytes(parts.p); k.q = B.fromBytes(parts.q); }
  return complete(k);
}

export function toBytesParts(k) {
  const o = {};
  for (const name of ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi']) if (k[name]) o[name] = B.toBytes(k[name]);
  return o;
}

// EMSA-PKCS1-v1_5 encoding of a message's hash.
function encode(hash, data, len) {
  const h = hashName(hash);
  const prefix = DIGEST_INFO[h];
  if (!prefix) throw new Error('RSA: unsupported hash ' + hash);
  const t = hexBytes(prefix), d = sha(h, data);
  if (len < t.length + d.length + 11) throw new Error('RSA: the key is too short for this hash');
  const em = new Uint8Array(len);
  em[1] = 1;
  em.fill(0xff, 2, len - t.length - d.length - 1);
  em.set(t, len - t.length - d.length);
  em.set(d, len - d.length);
  return em;
}

// Blinding (Kocher 1996; RFC 8017 section 10 note). The private
// exponentiation below runs in software we wrote, with a running time
// and a memory access pattern that depend on the value being signed.
// Blinding makes that value a random one the caller never chose: pick r
// coprime to n, exponentiate r^e * m instead of m, and divide the answer
// by r afterwards. Because (r^e * m)^d = r * m^d (mod n), the signature
// is exactly the one the unblinded operation would have produced -- the
// arithmetic is exact, so only the timing changes, never the output.
//
// It costs one small exponentiation (e is 65537: 17 squarings and a
// multiply), one inversion and two multiplications per signature.
//
// A browser with no crypto.getRandomValues cannot sign at all
// (web/browser-check.js says so, and key generation needs it too), but
// this module is also used on its own, so with no random source it signs
// unblinded rather than refusing.
const canRandom = () => {
  try {
    const g = typeof globalThis !== 'undefined' ? globalThis : self;
    return !!(g.crypto && g.crypto.getRandomValues);
  } catch (e) { return false; }
};

// {m: the value to exponentiate, ri: what to multiply the result by},
// or null to sign m as it is.
function blind(k, m) {
  if (!k.n || !k.e || !canRandom()) return null;
  // n - 2 is the largest r worth trying; randomBelow gives [1, max).
  const max = B.sub(k.n, B.ONE);
  for (let tries = 0; tries < 8; tries++) {
    const r = B.randomBelow(max);
    if (B.cmp(r, B.ONE) <= 0) continue;
    let ri;
    // Not invertible means gcd(r, n) > 1, which would have factored the
    // key; with a real modulus it never happens, so just draw again.
    try { ri = B.modInv(r, k.n); } catch (e) { continue; }
    return { m: B.mod(B.mul(m, B.modPow(r, k.e, k.n)), k.n), ri };
  }
  return null;
}

// m^d mod n by the Chinese remainder theorem, blinded, and checked with
// the public exponent (a wrong result would leak the key).
function privateOp(k, m) {
  let s;
  const b = blind(k, m);
  const x = b ? b.m : m;
  if (k.p && k.q) {
    const mp = new B.Mont(k.p), mq = new B.Mont(k.q);
    const s1 = mp.from(mp.pow(mp.to(x), k.dp));
    const s2 = mq.from(mq.pow(mq.to(x), k.dq));
    // h = qi * (s1 - s2) mod p
    const diff = B.cmp(s1, B.mod(s2, k.p)) >= 0 ? B.sub(s1, B.mod(s2, k.p)) : B.sub(B.add(s1, k.p), B.mod(s2, k.p));
    const h = B.mod(B.mul(k.qi, diff), k.p);
    s = B.add(s2, B.mul(h, k.q));
  } else {
    s = B.modPow(x, k.d, k.n);
  }
  if (b) s = B.mod(B.mul(s, b.ri), k.n);
  // Against the message as it was given, not the blinded one: this is the
  // fault check, and it has to cover the unblinding too.
  if (B.cmp(B.modPow(s, k.e, k.n), m) !== 0) throw new Error('RSA: the private key is inconsistent');
  return s;
}

export function sign(k, hash, data) {
  if (!k.d) throw new Error('RSA: not a private key');
  const m = B.fromBytes(encode(hash, data, k.len));
  return B.toBytes(privateOp(k, m), k.len);
}

export function verify(k, hash, data, sig) {
  if (sig.length !== k.len) return false;
  const s = B.fromBytes(sig);
  if (B.cmp(s, k.n) >= 0) return false;
  const em = B.toBytes(B.modPow(s, k.e, k.n), k.len);
  let want;
  try { want = encode(hash, data, k.len); } catch (e) { return false; }
  let diff = 0;
  for (let i = 0; i < em.length; i++) diff |= em[i] ^ want[i];
  return diff === 0;
}

/* ---------- key generation ---------- */

let SMALL = null;
function smallPrimes() {
  if (SMALL) return SMALL;
  const lim = 8192, sieve = new Uint8Array(lim);
  SMALL = [];
  for (let i = 3; i < lim; i += 2) {
    if (sieve[i]) continue;
    SMALL.push(i);
    for (let j = i * i; j < lim; j += 2 * i) sieve[j] = 1;
  }
  return SMALL;
}

// Miller-Rabin with random bases.
function probablePrime(n, rounds) {
  const n1 = B.sub(n, B.ONE);
  let s = 0;
  while (!B.testBit(n1, s)) s++;
  const d = B.shr(n1, s);
  const mt = new B.Mont(n);
  const minus1 = mt.to(n1);
  for (let r = 0; r < rounds; r++) {
    const a = r === 0 ? [2] : B.add(B.randomBelow(B.sub(n1, B.ONE)), B.ONE);
    let x = mt.pow(mt.to(a), d);
    if (mt.eq(x, mt.one) || mt.eq(x, minus1)) continue;
    let ok = false;
    for (let i = 1; i < s; i++) {
      x = mt.sqr(x);
      if (mt.eq(x, minus1)) { ok = true; break; }
      if (mt.eq(x, mt.one)) break;
    }
    if (!ok) return false;
  }
  return true;
}

// A random prime of exactly `bits` bits with the top two bits set (so
// p*q has the full length) and p - 1 coprime to e.
function randomPrime(bits, e) {
  const primes = smallPrimes();
  const rounds = bits >= 1300 ? 4 : bits >= 850 ? 5 : 8;     // FIPS 186-4 table C.3
  for (;;) {
    const u8 = crypto.getRandomValues(new Uint8Array((bits + 7) >> 3));
    const extra = u8.length * 8 - bits;
    u8[0] &= 0xff >> extra;
    u8[0] |= 0xc0 >> extra;
    if (extra > 6) u8[1] |= 0x80;                           // (bits = 8k + 1 edge case)
    u8[u8.length - 1] |= 1;
    const base = B.fromBytes(u8);
    const rem = primes.map((p) => B.modSmall(base, p));
    for (let delta = 0; delta < 1 << 16; delta += 2) {
      let ok = true;
      for (let i = 0; i < primes.length; i++) if ((rem[i] + delta) % primes[i] === 0) { ok = false; break; }
      if (!ok) continue;
      const c = B.add(base, B.fromNumber(delta));
      if (B.bitLength(c) !== bits) break;
      if (B.modSmall(B.sub(c, B.ONE), e) === 0) continue;
      if (probablePrime(c, rounds)) return c;
    }
  }
}

export function generate(bits, eNum = 65537) {
  const e = B.fromNumber(eNum);
  for (;;) {
    const p = randomPrime(bits >> 1, eNum), q = randomPrime(bits - (bits >> 1), eNum);
    if (B.cmp(p, q) === 0) continue;
    const n = B.mul(p, q);
    if (B.bitLength(n) !== bits) continue;
    const phi = B.mul(B.sub(p, B.ONE), B.sub(q, B.ONE));
    const d = B.modInv(e, phi);
    return complete({ n, e, d, p, q });
  }
}
