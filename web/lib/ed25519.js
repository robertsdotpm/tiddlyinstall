// Ed25519 signatures (RFC 8032) in plain JavaScript, for browsers whose
// WebCrypto has no Ed25519 (most before 2024) or no WebCrypto at all.
// web/lib/cryptox.js uses this only when the native Ed25519 is missing.
//
// Ported from TweetNaCl-js (https://github.com/dchest/tweetnacl-js), which
// is in the public domain; field arithmetic over 16 limbs of 16 bits in
// Float64Arrays. The curve constants are computed at first use instead of
// being copied. SHA-512 comes from web/lib/sha.js.
//
//   publicFromSeed(seed32) -> pub32
//   sign(seed32, msg) -> sig64
//   verify(pub32, msg, sig64) -> boolean
import { sha512 } from './sha.js';

const gf = (init) => {
  const r = new Float64Array(16);
  if (init) for (let i = 0; i < init.length; i++) r[i] = init[i];
  return r;
};
const gf0 = gf(), gf1 = gf([1]);
let D, D2, X, Y, I;     // d, 2d, the base point, sqrt(-1)

function set25519(r, a) { for (let i = 0; i < 16; i++) r[i] = a[i] | 0; }

function car25519(o) {
  let c = 1;
  for (let i = 0; i < 16; i++) {
    const v = o[i] + c + 65535;
    c = Math.floor(v / 65536);
    o[i] = v - c * 65536;
  }
  o[0] += c - 1 + 37 * (c - 1);
}

function sel25519(p, q, b) {
  const c = ~(b - 1);
  for (let i = 0; i < 16; i++) {
    const t = c & (p[i] ^ q[i]);
    p[i] ^= t;
    q[i] ^= t;
  }
}

function pack25519(o, n) {
  const m = gf(), t = gf();
  for (let i = 0; i < 16; i++) t[i] = n[i];
  car25519(t); car25519(t); car25519(t);
  for (let j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (let i = 1; i < 15; i++) {
      m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1);
      m[i - 1] &= 0xffff;
    }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    const b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    sel25519(t, m, 1 - b);
  }
  for (let i = 0; i < 16; i++) {
    o[2 * i] = t[i] & 0xff;
    o[2 * i + 1] = t[i] >> 8;
  }
}

function neq25519(a, b) {
  const c = new Uint8Array(32), d = new Uint8Array(32);
  pack25519(c, a); pack25519(d, b);
  let x = 0;
  for (let i = 0; i < 32; i++) x |= c[i] ^ d[i];
  return x !== 0;
}

function par25519(a) {
  const d = new Uint8Array(32);
  pack25519(d, a);
  return d[0] & 1;
}

function unpack25519(o, n) {
  for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}

function A(o, a, b) { for (let i = 0; i < 16; i++) o[i] = a[i] + b[i]; }
function Z(o, a, b) { for (let i = 0; i < 16; i++) o[i] = a[i] - b[i]; }

function M(o, a, b) {
  const t = new Float64Array(31);
  for (let i = 0; i < 16; i++) {
    const ai = a[i];
    for (let j = 0; j < 16; j++) t[i + j] += ai * b[j];
  }
  for (let i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (let i = 0; i < 16; i++) o[i] = t[i];
  car25519(o);
  car25519(o);
}

function S(o, a) { M(o, a, a); }

// a^e where e has `top` + 1 bits, all set except those in `zeros`.
function powOnes(o, a, top, zeros) {
  const c = gf();
  for (let i = 0; i < 16; i++) c[i] = a[i];
  for (let k = top - 1; k >= 0; k--) {
    S(c, c);
    if (zeros.indexOf(k) < 0) M(c, c, a);
  }
  for (let i = 0; i < 16; i++) o[i] = c[i];
}
// a^(p-2) = a^(2^255 - 21): bits 254..0 set except bits 2 and 4.
const inv25519 = (o, a) => powOnes(o, a, 254, [2, 4]);
// a^((p-5)/8) = a^(2^252 - 3): bits 251..0 set except bit 1.
const pow2523 = (o, a) => powOnes(o, a, 251, [1]);

function init() {
  if (D) return;
  // d = -121665 / 121666
  const num = gf([121665 & 0xffff, 121665 >> 16]), den = gf([121666 & 0xffff, 121666 >> 16]), t = gf();
  D = gf(); D2 = gf(); X = gf(); Y = gf(); I = gf();
  inv25519(t, den);
  M(D, num, t);
  Z(D, gf0, D);
  car25519(D);
  A(D2, D, D);
  car25519(D2);
  // sqrt(-1) = 2^((p-1)/4) = 2^(2^253 - 5): bits 252..0 set except bit 2.
  powOnes(I, gf([2]), 252, [2]);
  // The base point: y = 4/5, x the even root.
  const five = gf([5]);
  inv25519(t, five);
  M(Y, gf([4]), t);
  const yb = new Uint8Array(32);
  pack25519(yb, Y);
  const q = [gf(), gf(), gf(), gf()];
  if (unpackneg(q, yb) !== 0) throw new Error('Ed25519: bad base point');
  Z(X, gf0, q[0]);                    // unpackneg returns -P
  car25519(X);
  if (par25519(X) !== 0) throw new Error('Ed25519: base point sign');
}

function add(p, q) {
  const a = gf(), b = gf(), c = gf(), d = gf(), e = gf(), f = gf(), g = gf(), h = gf(), t = gf();
  Z(a, p[1], p[0]); Z(t, q[1], q[0]); M(a, a, t);
  A(b, p[0], p[1]); A(t, q[0], q[1]); M(b, b, t);
  M(c, p[3], q[3]); M(c, c, D2);
  M(d, p[2], q[2]); A(d, d, d);
  Z(e, b, a); Z(f, d, c); A(g, d, c); A(h, b, a);
  M(p[0], e, f); M(p[1], h, g); M(p[2], g, f); M(p[3], e, h);
}

function cswap(p, q, b) { for (let i = 0; i < 4; i++) sel25519(p[i], q[i], b); }

function pack(r, p) {
  const tx = gf(), ty = gf(), zi = gf();
  inv25519(zi, p[2]);
  M(tx, p[0], zi);
  M(ty, p[1], zi);
  pack25519(r, ty);
  r[31] ^= par25519(tx) << 7;
}

function scalarmult(p, q, s) {
  set25519(p[0], gf0); set25519(p[1], gf1); set25519(p[2], gf1); set25519(p[3], gf0);
  for (let i = 255; i >= 0; --i) {
    const b = (s[(i / 8) | 0] >> (i & 7)) & 1;
    cswap(p, q, b);
    add(q, p);
    add(p, p);
    cswap(p, q, b);
  }
}

function scalarbase(p, s) {
  const q = [gf(), gf(), gf(), gf()];
  set25519(q[0], X); set25519(q[1], Y); set25519(q[2], gf1); M(q[3], X, Y);
  scalarmult(p, q, s);
}

// The group order l, little-endian.
const L = new Float64Array([0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10]);

function modL(r, x) {
  let carry, i, j, k;
  for (i = 63; i >= 32; --i) {
    carry = 0;
    for (j = i - 32, k = i - 12; j < k; ++j) {
      x[j] += carry - 16 * x[i] * L[j - (i - 32)];
      carry = Math.floor((x[j] + 128) / 256);
      x[j] -= carry * 256;
    }
    x[j] += carry;
    x[i] = 0;
  }
  carry = 0;
  for (j = 0; j < 32; j++) {
    x[j] += carry - (x[31] >> 4) * L[j];
    carry = x[j] >> 8;
    x[j] &= 255;
  }
  for (j = 0; j < 32; j++) x[j] -= carry * L[j];
  for (i = 0; i < 32; i++) {
    x[i + 1] += x[i] >> 8;
    r[i] = x[i] & 255;
  }
}

function reduce(r) {
  const x = new Float64Array(64);
  for (let i = 0; i < 64; i++) x[i] = r[i];
  for (let i = 0; i < 64; i++) r[i] = 0;
  modL(r, x);
}

function unpackneg(r, p) {
  const t = gf(), chk = gf(), num = gf(), den = gf(), den2 = gf(), den4 = gf(), den6 = gf();
  set25519(r[2], gf1);
  unpack25519(r[1], p);
  S(num, r[1]);
  M(den, num, D);
  Z(num, num, r[2]);
  A(den, r[2], den);
  S(den2, den);
  S(den4, den2);
  M(den6, den4, den2);
  M(t, den6, num);
  M(t, t, den);
  pow2523(t, t);
  M(t, t, num);
  M(t, t, den);
  M(t, t, den);
  M(r[0], t, den);
  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) M(r[0], r[0], I);
  S(chk, r[0]);
  M(chk, chk, den);
  if (neq25519(chk, num)) return -1;
  if (par25519(r[0]) === (p[31] >> 7)) Z(r[0], gf0, r[0]);
  M(r[3], r[0], r[1]);
  return 0;
}

function cat(a, b, c) {
  const out = new Uint8Array(a.length + b.length + (c ? c.length : 0));
  out.set(a); out.set(b, a.length);
  if (c) out.set(c, a.length + b.length);
  return out;
}

// The clamped secret scalar and the prefix (RFC 8032 5.1.5).
function expand(seed) {
  if (seed.length !== 32) throw new Error('Ed25519: the seed must be 32 bytes');
  const d = sha512(seed);
  d[0] &= 248; d[31] &= 127; d[31] |= 64;
  return d;
}

export function publicFromSeed(seed) {
  init();
  const d = expand(seed);
  const p = [gf(), gf(), gf(), gf()];
  scalarbase(p, d);
  const pk = new Uint8Array(32);
  pack(pk, p);
  return pk;
}

export function sign(seed, msg, pub) {
  init();
  const d = expand(seed);
  const pk = pub || publicFromSeed(seed);
  const r = sha512(cat(d.subarray(32), msg));
  reduce(r);
  const p = [gf(), gf(), gf(), gf()];
  scalarbase(p, r);
  const sig = new Uint8Array(64);
  pack(sig, p);
  const h = sha512(cat(sig.subarray(0, 32), pk, msg));
  reduce(h);
  const x = new Float64Array(64);
  for (let i = 0; i < 32; i++) x[i] = r[i];
  for (let i = 0; i < 32; i++) for (let j = 0; j < 32; j++) x[i + j] += h[i] * d[j];
  modL(sig.subarray(32), x);
  return sig;
}

export function verify(pub, msg, sig) {
  init();
  if (sig.length !== 64 || pub.length !== 32) return false;
  // S must be below l (RFC 8032 5.1.7; TweetNaCl does not check this).
  for (let i = 31; i >= 0; i--) {
    if (sig[32 + i] < L[i]) break;
    if (sig[32 + i] > L[i] || i === 0) return false;
  }
  const q = [gf(), gf(), gf(), gf()];
  if (unpackneg(q, pub) !== 0) return false;
  const h = sha512(cat(sig.subarray(0, 32), pub, msg));
  reduce(h);
  const p = [gf(), gf(), gf(), gf()];
  scalarmult(p, q, h);
  const s = sig.subarray(32);
  const q2 = [gf(), gf(), gf(), gf()];
  scalarbase(q2, s);
  add(p, q2);
  const t = new Uint8Array(32);
  pack(t, p);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= t[i] ^ sig[i];
  return diff === 0;
}
