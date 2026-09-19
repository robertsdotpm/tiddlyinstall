// ECDSA on the NIST curves P-256, P-384 and P-521 (FIPS 186-4, SEC 1) over
// js/bignum.js, for browsers without WebCrypto. js/cryptox.js uses this
// only when the native ECDSA is missing. Written for this project; no
// dependencies but ours.
//
// Signatures are deterministic (RFC 6979, HMAC-DRBG with the message hash),
// so no random number is needed to sign. Signatures are r||s, as WebCrypto
// returns them.
//
//   parsePkcs8(der) -> key {curve, d, Q?}      parseSpki(der) -> key {curve, Q}
//   sign(key, hash, data) -> Uint8Array        verify(key, hash, data, sig) -> boolean
//   publicKey(key) -> uncompressed point bytes
import * as B from './bignum.js';
import * as der from './der.js';
import { sha, hashName } from './sha.js';
import { hmacKey } from './hmac-pbkdf2.js';

const OID_EC = '1.2.840.10045.2.1';
const CURVE_OIDS = { '1.2.840.10045.3.1.7': 'P-256', '1.3.132.0.34': 'P-384', '1.3.132.0.35': 'P-521' };

// SEC 2 domain parameters (a = -3 for all three).
const PARAMS = {
  'P-256': {
    p: 'ffffffff00000001000000000000000000000000ffffffffffffffffffffffff',
    b: '5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b',
    gx: '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296',
    gy: '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5',
    n: 'ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',
  },
  'P-384': {
    p: 'fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffff',
    b: 'b3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aef',
    gx: 'aa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7',
    gy: '3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5f',
    n: 'ffffffffffffffffffffffffffffffffffffffffffffffffc7634d81f4372ddf581a0db248b0a77aecec196accc52973',
  },
  'P-521': {
    p: '01ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    b: '0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00',
    gx: '00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66',
    gy: '011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650',
    n: '01fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffa51868783bf2f966b7fcc0148f709a5d03bb5c9b8899c47aebb6fb71e91386409',
  },
};

const cache = {};

function curve(name) {
  if (cache[name]) return cache[name];
  const P = PARAMS[name];
  if (!P) throw new Error('ECDSA: unsupported curve ' + name);
  const c = { name };
  c.p = B.fromHex(P.p); c.n = B.fromHex(P.n);
  c.F = new B.Mont(c.p);                     // field
  c.N = new B.Mont(c.n);                     // scalars
  c.bytes = (B.bitLength(c.p) + 7) >> 3;
  c.nbits = B.bitLength(c.n);
  c.b = c.F.to(B.fromHex(P.b));
  c.G = { X: c.F.to(B.fromHex(P.gx)), Y: c.F.to(B.fromHex(P.gy)), Z: c.F.one };
  const F = c.F;
  c.three = F.to([3]);
  // (p + 1) / 4 for square roots (all three primes are 3 mod 4).
  c.sqrtExp = B.shr(B.add(c.p, B.ONE), 2);
  cache[name] = c;
  return c;
}

/* ---------- points in Jacobian coordinates (Montgomery form) ---------- */

const INF = null;

function dbl(c, P) {
  if (P === INF) return INF;
  const F = c.F;
  if (F.isZero(P.Y)) return INF;
  // dbl-2001-b (a = -3)
  const delta = F.sqr(P.Z), gamma = F.sqr(P.Y), beta = F.mul(P.X, gamma);
  const alpha = F.mul(c.three, F.mul(F.sub(P.X, delta), F.add(P.X, delta)));
  const beta4 = F.add(F.add(beta, beta), F.add(beta, beta));
  const beta8 = F.add(beta4, beta4);
  const X3 = F.sub(F.sqr(alpha), beta8);
  const yz = F.add(P.Y, P.Z);
  const Z3 = F.sub(F.sub(F.sqr(yz), gamma), delta);
  const g2 = F.sqr(gamma), g4 = F.add(g2, g2), g8 = F.add(g4, g4);
  const Y3 = F.sub(F.mul(alpha, F.sub(beta4, X3)), F.add(g8, g8));
  return { X: X3, Y: Y3, Z: Z3 };
}

function add(c, P, Q) {
  if (P === INF) return Q;
  if (Q === INF) return P;
  const F = c.F;
  // add-2007-bl
  const z1z1 = F.sqr(P.Z), z2z2 = F.sqr(Q.Z);
  const u1 = F.mul(P.X, z2z2), u2 = F.mul(Q.X, z1z1);
  const s1 = F.mul(F.mul(P.Y, Q.Z), z2z2), s2 = F.mul(F.mul(Q.Y, P.Z), z1z1);
  const h = F.sub(u2, u1);
  const rr = F.sub(s2, s1);
  if (F.isZero(h)) return F.isZero(rr) ? dbl(c, P) : INF;
  const h2 = F.add(h, h), i = F.sqr(h2), j = F.mul(h, i);
  const r = F.add(rr, rr);
  const v = F.mul(u1, i);
  const X3 = F.sub(F.sub(F.sqr(r), j), F.add(v, v));
  const s1j = F.mul(s1, j);
  const Y3 = F.sub(F.mul(r, F.sub(v, X3)), F.add(s1j, s1j));
  const zz = F.add(P.Z, Q.Z);
  const Z3 = F.mul(F.sub(F.sub(F.sqr(zz), z1z1), z2z2), h);
  return { X: X3, Y: Y3, Z: Z3 };
}

// k * P, 4-bit fixed window.
function mulPoint(c, P, k) {
  const tbl = [INF, P];
  for (let i = 2; i < 16; i++) tbl.push(add(c, tbl[i - 1], P));
  let acc = INF;
  const nb = B.bitLength(k);
  for (let i = Math.ceil(nb / 4) * 4 - 1; i >= 0; i -= 4) {
    acc = dbl(c, dbl(c, dbl(c, dbl(c, acc))));
    const v = (B.testBit(k, i) << 3) | (B.testBit(k, i - 1) << 2) | (B.testBit(k, i - 2) << 1) | B.testBit(k, i - 3);
    if (v) acc = add(c, acc, tbl[v]);
  }
  return acc;
}

function affine(c, P) {
  if (P === INF) return INF;
  const F = c.F;
  const zi = F.invPrime(P.Z), zi2 = F.sqr(zi);
  return { x: F.from(F.mul(P.X, zi2)), y: F.from(F.mul(P.Y, F.mul(zi2, zi))) };
}

function onCurve(c, x, y) {
  if (B.cmp(x, c.p) >= 0 || B.cmp(y, c.p) >= 0) return false;
  const F = c.F, X = F.to(x), Y = F.to(y);
  // y^2 = x^3 - 3x + b
  const rhs = F.add(F.sub(F.mul(F.sqr(X), X), F.mul(c.three, X)), c.b);
  return F.eq(F.sqr(Y), rhs);
}

function decodePoint(c, u8) {
  const n = c.bytes;
  let x, y;
  if (u8[0] === 4 && u8.length === 1 + 2 * n) {
    x = B.fromBytes(u8.subarray(1, 1 + n)); y = B.fromBytes(u8.subarray(1 + n));
  } else if ((u8[0] === 2 || u8[0] === 3) && u8.length === 1 + n) {
    const F = c.F;
    x = B.fromBytes(u8.subarray(1));
    const X = F.to(x);
    const rhs = F.add(F.sub(F.mul(F.sqr(X), X), F.mul(c.three, X)), c.b);
    y = F.from(F.pow(rhs, c.sqrtExp));
    if ((y.length ? y[0] & 1 : 0) !== (u8[0] & 1)) y = B.sub(c.p, y);
  } else throw new Error('ECDSA: bad public key encoding');
  if (!onCurve(c, x, y)) throw new Error('ECDSA: the public key is not on the curve');
  return { x, y };
}

const jac = (c, pt) => ({ X: c.F.to(pt.x), Y: c.F.to(pt.y), Z: c.F.one });

/* ---------- keys ---------- */

function curveOf(algNode) {
  if (der.readOid(algNode.kid(0)) !== OID_EC) throw new Error('Not an EC key');
  const name = CURVE_OIDS[der.readOid(algNode.kid(1))];
  if (!name) throw new Error('ECDSA: unsupported curve');
  return name;
}

export function parsePkcs8(bytes) {
  const pki = der.decode(bytes);
  let name = curveOf(pki.kid(1));
  const ecpk = der.decode(der.readOctets(pki.kid(2)));
  const d = B.fromBytes(der.readOctets(ecpk.kid(1)));
  const key = { curve: name, d };
  for (const k of ecpk.kids.slice(2)) {
    if (k.cls === 2 && k.num === 1) key.Q = decodePoint(curve(name), der.readBits(k.kid(0)));
  }
  const c = curve(name);
  if (!d.length || B.cmp(d, c.n) >= 0) throw new Error('ECDSA: bad private key');
  return key;
}

export function parseSpki(bytes) {
  const spki = der.decode(bytes);
  const name = curveOf(spki.kid(0));
  return { curve: name, Q: decodePoint(curve(name), der.readBits(spki.kid(1))) };
}

export function fromPrivate(name, dBytes) {
  return { curve: name, d: B.fromBytes(dBytes) };
}

export function publicKey(key) {
  const c = curve(key.curve);
  if (!key.Q) key.Q = affine(c, mulPoint(c, c.G, key.d));
  const out = new Uint8Array(1 + 2 * c.bytes);
  out[0] = 4;
  out.set(B.toBytes(key.Q.x, c.bytes), 1);
  out.set(B.toBytes(key.Q.y, c.bytes), 1 + c.bytes);
  return out;
}

/* ---------- ECDSA ---------- */

// The leftmost nbits bits of the hash as an integer (SEC 1 4.1.3 step 5).
function bits2int(c, h) {
  let x = B.fromBytes(h);
  const hb = h.length * 8;
  if (hb > c.nbits) x = B.shr(x, hb - c.nbits);
  return x;
}

const nlen = (c) => (c.nbits + 7) >> 3;

function cat() {
  let n = 0;
  for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
  const out = new Uint8Array(n);
  for (let i = 0, o = 0; i < arguments.length; i++) { out.set(arguments[i], o); o += arguments[i].length; }
  return out;
}

// RFC 6979 section 3.2: the nonce k from the key and the message hash.
function* nonces(c, hash, d, h1) {
  const rlen = nlen(c);
  const x = B.toBytes(d, rlen);
  let z = bits2int(c, h1);
  if (B.cmp(z, c.n) >= 0) z = B.sub(z, c.n);
  const hb = B.toBytes(z, rlen);
  const hlen = h1.length;
  let V = new Uint8Array(hlen).fill(1), K = new Uint8Array(hlen);
  let mac = hmacKey(hash, K);
  K = mac(cat(V, [0], x, hb)); mac = hmacKey(hash, K); V = mac(V);
  K = mac(cat(V, [1], x, hb)); mac = hmacKey(hash, K); V = mac(V);
  for (;;) {
    let T = new Uint8Array(0);
    while (T.length < rlen) { V = mac(V); T = cat(T, V); }
    const k = bits2int(c, T.subarray(0, rlen));      // = bits2int(T): rlen*8 >= qlen
    if (k.length && B.cmp(k, c.n) < 0) yield k;
    K = mac(cat(V, [0])); mac = hmacKey(hash, K); V = mac(V);
  }
}

export function sign(key, hash, data) {
  const c = curve(key.curve), N = c.N;
  const hname = hashName(hash);
  const h1 = sha(hname, data);
  const e = B.mod(bits2int(c, h1), c.n);
  const it = nonces(c, hname, key.d, h1);
  for (;;) {
    const k = it.next().value;
    const R = affine(c, mulPoint(c, c.G, k));
    const r = B.mod(R.x, c.n);
    if (!r.length) continue;
    // s = k^-1 (e + r d) mod n
    const kinv = N.invPrime(N.to(k));
    const rd = N.mul(N.to(r), N.to(key.d));
    const s = N.from(N.mul(kinv, N.add(N.to(e), rd)));
    if (!s.length) continue;
    const out = new Uint8Array(2 * nlen(c));
    out.set(B.toBytes(r, nlen(c)), 0);
    out.set(B.toBytes(s, nlen(c)), nlen(c));
    return out;
  }
}

export function verify(key, hash, data, sig) {
  const c = curve(key.curve), N = c.N, L = nlen(c);
  if (sig.length !== 2 * L) return false;
  const r = B.fromBytes(sig.subarray(0, L)), s = B.fromBytes(sig.subarray(L));
  if (!r.length || !s.length || B.cmp(r, c.n) >= 0 || B.cmp(s, c.n) >= 0) return false;
  if (!key.Q) publicKey(key);
  const e = B.mod(bits2int(c, sha(hashName(hash), data)), c.n);
  const w = N.invPrime(N.to(s));
  const u1 = N.from(N.mul(N.to(e), w)), u2 = N.from(N.mul(N.to(r), w));
  const X = affine(c, add(c, mulPoint(c, c.G, u1), mulPoint(c, jac(c, key.Q), u2)));
  if (X === INF) return false;
  return B.cmp(B.mod(X.x, c.n), r) === 0;
}
