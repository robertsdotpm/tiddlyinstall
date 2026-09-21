// Arbitrary-precision non-negative integers without BigInt, for the pure
// JavaScript RSA and ECDSA (src/web_client/lib/rsa.js, src/web_client/lib/ec.js) that browsers without
// WebCrypto use. Written for this project; no dependencies.
//
// A number is a plain Array of 26-bit limbs, least significant first, with
// no high zero limbs (zero is []). 26 bits keeps a limb product plus a
// carry below 2^53, so every step is exact in a double.
//
// Modular exponentiation uses Montgomery multiplication (CIOS) on
// fixed-length Float64Arrays; see class Mont.

const BITS = 26, R = 1 << BITS, M = R - 1;

function norm(a) {
  let n = a.length;
  while (n > 0 && a[n - 1] === 0) n--;
  if (n !== a.length) a.length = n;
  return a;
}

export const ZERO = [];
export const ONE = [1];

export function fromNumber(x) {
  if (x < 0 || x !== Math.floor(x) || x > Number.MAX_SAFE_INTEGER) throw new RangeError('bignum: bad number ' + x);
  const a = [];
  while (x > 0) { a.push(x % R); x = Math.floor(x / R); }
  return a;
}

export function toNumber(a) {
  let x = 0;
  for (let i = a.length - 1; i >= 0; i--) x = x * R + a[i];
  return x;
}

// Unsigned big-endian bytes.
export function fromBytes(u8) {
  const a = [];
  let acc = 0, bits = 0;
  for (let i = u8.length - 1; i >= 0; i--) {
    acc |= u8[i] << bits;
    bits += 8;
    if (bits >= BITS) { a.push(acc & M); acc = u8[i] >>> (8 - (bits - BITS)); bits -= BITS; }
  }
  if (bits > 0) a.push(acc & M);
  return norm(a);
}

// Big-endian bytes, left-padded to len (or the minimum, at least 1).
export function toBytes(a, len) {
  const nb = Math.max(1, (bitLength(a) + 7) >> 3);
  if (len === undefined) len = nb;
  if (nb > len && !(a.length === 0)) throw new RangeError('bignum: value does not fit in ' + len + ' bytes');
  const out = new Uint8Array(len);
  let acc = 0, bits = 0, li = 0, o = len - 1;
  while (o >= 0 && (li < a.length || bits > 0)) {
    if (bits < 8 && li < a.length) { acc += a[li++] * Math.pow(2, bits); bits += BITS; }
    out[o--] = acc % 256;
    acc = Math.floor(acc / 256);
    bits -= 8;
    if (bits < 0) bits = 0;
  }
  return out;
}

export function fromHex(h) {
  h = h.replace(/[^0-9a-f]/gi, '');
  if (h.length % 2) h = '0' + h;
  const u8 = new Uint8Array(h.length / 2);
  for (let i = 0; i < u8.length; i++) u8[i] = parseInt(h.substr(2 * i, 2), 16);
  return fromBytes(u8);
}

export function toHex(a) {
  let s = '';
  const b = toBytes(a);
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}

export const isZero = (a) => a.length === 0;
export const isOdd = (a) => a.length > 0 && (a[0] & 1) === 1;

export function bitLength(a) {
  if (!a.length) return 0;
  return (a.length - 1) * BITS + (32 - Math.clz32(a[a.length - 1]));
}

export function testBit(a, i) {
  const l = Math.floor(i / BITS);
  return l < a.length ? (a[l] >>> (i % BITS)) & 1 : 0;
}

export function cmp(a, b) {
  if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

export function add(a, b) {
  const n = Math.max(a.length, b.length), out = new Array(n + 1);
  let c = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] || 0) + (b[i] || 0) + c;
    out[i] = x & M; c = x >>> BITS;
  }
  out[n] = c;
  return norm(out);
}

// a - b; a >= b required.
export function sub(a, b) {
  if (cmp(a, b) < 0) throw new RangeError('bignum: negative result');
  const out = new Array(a.length);
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] - (b[i] || 0) - c;
    if (x < 0) { x += R; c = 1; } else c = 0;
    out[i] = x;
  }
  return norm(out);
}

export function mul(a, b) {
  if (!a.length || !b.length) return [];
  const out = new Float64Array(a.length + b.length);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    let c = 0;
    for (let j = 0; j < b.length; j++) {
      const x = out[i + j] + ai * b[j] + c;
      const lo = x & M;
      c = (x - lo) / R;
      out[i + j] = lo;
    }
    out[i + b.length] = c;
  }
  return norm(Array.prototype.slice.call(out));
}

export function mulSmall(a, s) {
  const out = new Array(a.length + 2);
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] * s + c;
    const lo = x & M;
    out[i] = lo; c = (x - lo) / R;
  }
  out[a.length] = c & M;
  out[a.length + 1] = Math.floor(c / R);
  return norm(out);
}

export function shl(a, n) {
  if (!a.length) return [];
  const w = Math.floor(n / BITS), b = n % BITS;
  const out = new Array(a.length + w + 1).fill(0);
  const f = 1 << b;
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] * f + c;             // < 2^52
    const lo = x % R;
    out[i + w] = lo;
    c = (x - lo) / R;
  }
  out[a.length + w] = c;
  return norm(out);
}

export function shr(a, n) {
  const w = Math.floor(n / BITS), b = n % BITS;
  if (w >= a.length) return [];
  const out = new Array(a.length - w);
  for (let i = 0; i < out.length; i++) {
    const lo = a[i + w] >>> b;
    const hi = i + w + 1 < a.length ? (a[i + w + 1] << (BITS - b)) & M : 0;
    out[i] = b ? (lo | hi) & M : a[i + w];
  }
  return norm(out);
}

// [quotient, remainder] of a / d for 0 < d < 2^26.
export function divSmall(a, d) {
  const q = new Array(a.length);
  let r = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const x = r * R + a[i];
    q[i] = Math.floor(x / d);
    r = x - q[i] * d;
  }
  return [norm(q), r];
}

export function modSmall(a, d) {
  let r = 0;
  for (let i = a.length - 1; i >= 0; i--) r = (r * R + a[i]) % d;
  return r;
}

// [quotient, remainder] by binary long division: O(bits(a) * limbs(b)),
// which is plenty for key setup; the hot paths use Montgomery.
export function divmod(a, b) {
  if (!b.length) throw new RangeError('bignum: division by zero');
  if (cmp(a, b) < 0) return [[], a.slice()];
  if (b.length === 1) { const qr = divSmall(a, b[0]); return [qr[0], fromNumber(qr[1])]; }
  const shift = bitLength(a) - bitLength(b);
  let r = a.slice();
  let d = shl(b, shift);
  const q = new Array(Math.floor(shift / BITS) + 1).fill(0);
  for (let i = shift; i >= 0; i--) {
    if (cmp(r, d) >= 0) {
      r = subInPlace(r, d);
      q[Math.floor(i / BITS)] |= 1 << (i % BITS);
    }
    d = shr1(d);
  }
  return [norm(q), r];
}

function subInPlace(a, b) {
  let c = 0;
  for (let i = 0; i < a.length; i++) {
    let x = a[i] - (b[i] || 0) - c;
    if (x < 0) { x += R; c = 1; } else c = 0;
    a[i] = x;
  }
  return norm(a);
}

function shr1(a) {
  for (let i = 0; i < a.length; i++) {
    a[i] = (a[i] >>> 1) | (i + 1 < a.length ? (a[i + 1] & 1) << (BITS - 1) : 0);
  }
  return norm(a);
}

export const mod = (a, m) => divmod(a, m)[1];

// Inverse of a modulo m (gcd must be 1), by the extended Euclidean
// algorithm with signs kept beside the magnitudes.
export function modInv(a, m) {
  let r0 = m.slice(), r1 = mod(a, m);
  let s0 = [], s0neg = false, s1 = [1], s1neg = false;
  while (r1.length) {
    const qr = divmod(r0, r1);
    // s2 = s0 - q * s1
    const t = mul(qr[0], s1);
    let s2, s2neg;
    if (s0neg === s1neg) {
      // same sign: s0 - q*s1 = sign * (|s0| - |q*s1|)
      if (cmp(s0, t) >= 0) { s2 = sub(s0, t); s2neg = s0neg; } else { s2 = sub(t, s0); s2neg = !s0neg; }
    } else { s2 = add(s0, t); s2neg = s0neg; }
    r0 = r1; r1 = qr[1];
    s0 = s1; s0neg = s1neg; s1 = s2; s1neg = s2neg;
  }
  if (cmp(r0, ONE) !== 0) throw new RangeError('bignum: not invertible');
  s0 = mod(s0, m);
  return s0neg && s0.length ? sub(m, s0) : s0;
}

// Montgomery arithmetic modulo an odd m. Values inside are Float64Arrays
// of exactly n limbs, in Montgomery form (x * R^n mod m).
export class Mont {
  constructor(m) {
    if (!isOdd(m)) throw new RangeError('Montgomery needs an odd modulus');
    this.m = m;
    const n = this.n = m.length;
    this.mm = Float64Array.from(m);
    // -m^-1 mod 2^26 by Newton's iteration (mod 2^32 with Math.imul).
    let inv = m[0];
    for (let i = 0; i < 5; i++) inv = Math.imul(inv, 2 - Math.imul(m[0], inv));
    this.minv = (-inv) & M;
    this.t = new Float64Array(n + 2);
    this.r2 = this.fix(mod(shl([1], 2 * n * BITS), m));      // R^2 mod m
    this.one = this.to([1]);
  }

  // A normalized number (< m) as a fixed-length limb array.
  fix(a) {
    const out = new Float64Array(this.n);
    for (let i = 0; i < a.length; i++) out[i] = a[i];
    return out;
  }

  // Back to a normalized number (not converted out of Montgomery form).
  unfix(x) { return norm(Array.prototype.slice.call(x)); }

  // x * y / R^n mod m.
  mul(x, y) {
    const n = this.n, m = this.mm, t = this.t, minv = this.minv;
    t.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = x[i];
      let c = 0, v, lo;
      for (let j = 0; j < n; j++) {
        v = t[j] + xi * y[j] + c;
        lo = v & M; c = (v - lo) / R; t[j] = lo;
      }
      v = t[n] + c; lo = v & M; t[n] = lo; t[n + 1] += (v - lo) / R;
      const u = Math.imul(t[0], minv) & M;
      v = t[0] + u * m[0];
      c = (v - (v & M)) / R;
      for (let j = 1; j < n; j++) {
        v = t[j] + u * m[j] + c;
        lo = v & M; c = (v - lo) / R; t[j - 1] = lo;
      }
      v = t[n] + c; lo = v & M; t[n - 1] = lo;
      t[n] = t[n + 1] + (v - lo) / R;
      t[n + 1] = 0;
    }
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = t[i];
    if (t[n] || !lessThanM(out, m)) subM(out, m);
    return out;
  }

  sqr(x) { return this.mul(x, x); }

  to(a) { return this.mul(this.fix(cmp(a, this.m) >= 0 ? mod(a, this.m) : a), this.r2); }

  from(x) {
    const one = new Float64Array(this.n);
    one[0] = 1;
    return this.unfix(this.mul(x, one));
  }

  add(x, y) {
    const n = this.n, out = new Float64Array(n);
    let c = 0;
    for (let i = 0; i < n; i++) { const v = x[i] + y[i] + c; out[i] = v & M; c = v >>> BITS; }
    if (c || !lessThanM(out, this.mm)) subM(out, this.mm);
    return out;
  }

  sub(x, y) {
    const n = this.n, out = new Float64Array(n);
    let c = 0;
    for (let i = 0; i < n; i++) {
      let v = x[i] - y[i] - c;
      if (v < 0) { v += R; c = 1; } else c = 0;
      out[i] = v;
    }
    if (c) {                           // went negative: add m back
      let k = 0;
      for (let i = 0; i < n; i++) { const v = out[i] + this.mm[i] + k; out[i] = v & M; k = v >>> BITS; }
    }
    return out;
  }

  isZero(x) {
    for (let i = 0; i < this.n; i++) if (x[i]) return false;
    return true;
  }

  eq(x, y) {
    for (let i = 0; i < this.n; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  // x^e (x in Montgomery form, e a normalized number), 5-bit fixed window.
  pow(x, e) {
    const W = 5, tbl = [this.one, x];
    for (let i = 2; i < 1 << W; i++) tbl.push(this.mul(tbl[i - 1], x));
    let acc = this.one;
    const nb = bitLength(e);
    let i = nb - 1;
    const top = nb % W || W;          // first window may be short
    let started = false;
    for (let w = top; i >= 0; w = W) {
      let v = 0;
      for (let k = 0; k < w; k++, i--) {
        if (started) acc = this.sqr(acc);
        v = (v << 1) | testBit(e, i);
      }
      if (v) acc = started ? this.mul(acc, tbl[v]) : tbl[v];
      if (v) started = true;
    }
    return acc;
  }

  // x^-1 for prime m (Fermat).
  invPrime(x) { return this.pow(x, sub(this.m, [2])); }
}

function lessThanM(x, m) {
  for (let i = x.length - 1; i >= 0; i--) if (x[i] !== m[i]) return x[i] < m[i];
  return false;
}

function subM(x, m) {
  let c = 0;
  for (let i = 0; i < x.length; i++) {
    let v = x[i] - m[i] - c;
    if (v < 0) { v += R; c = 1; } else c = 0;
    x[i] = v;
  }
}

// b^e mod m for odd m.
export function modPow(b, e, m) {
  const mt = new Mont(m);
  return mt.from(mt.pow(mt.to(b), e));
}

// Uniform in [1, max) from crypto.getRandomValues.
export function randomBelow(max) {
  const nb = bitLength(max), bytes = (nb + 7) >> 3;
  for (;;) {
    const u8 = crypto.getRandomValues(new Uint8Array(bytes));
    if (nb % 8) u8[0] &= (1 << (nb % 8)) - 1;
    const x = fromBytes(u8);
    if (x.length && cmp(x, max) < 0) return x;
  }
}
