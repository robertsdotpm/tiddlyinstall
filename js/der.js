// A small DER encoder and BER/DER decoder: enough ASN.1 for PKCS#12,
// CMS (Authenticode) and RFC 3161. No dependencies.
//
// Encoding: every function returns the complete TLV as a Uint8Array.
// Decoding: parse() returns a node {tag, cls, cons, num, start, end, vstart,
// vend, u8} with .raw (the whole TLV), .value (the contents) and .kids.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function lenBytes(n) {
  if (n < 0x80) return [n];
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return [0x80 | b.length, ...b];
}

// tag: the identifier byte. content: bytes or an array of byte arrays.
export function tlv(tag, content = new Uint8Array(0)) {
  const body = Array.isArray(content) ? concat(content) : content;
  const l = lenBytes(body.length);
  const out = new Uint8Array(1 + l.length + body.length);
  out[0] = tag;
  out.set(l, 1);
  out.set(body, 1 + l.length);
  return out;
}

export const seq = (...parts) => tlv(0x30, parts);
export const set = (...parts) => tlv(0x31, parts);

function cmpBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
// DER SET OF: members sorted by their encodings.
export const setOf = (parts) => tlv(0x31, parts.slice().sort(cmpBytes));

// Context-specific tag n, constructed (explicit, or an implicit SEQUENCE/SET).
export const ctx = (n, ...parts) => tlv(0xa0 | n, parts);
// Context-specific tag n, primitive (implicit over a primitive type).
export const ctxPrim = (n, bytes) => tlv(0x80 | n, bytes);
// Re-tag an encoded TLV (an IMPLICIT tag over it).
export function retag(t, tag) { const o = t.slice(); o[0] = tag; return o; }

export const nul = () => new Uint8Array([5, 0]);
export const bool = (v) => new Uint8Array([1, 1, v ? 0xff : 0]);
export const octets = (b) => tlv(0x04, b);
export const bits = (b, unused = 0) => tlv(0x03, concat([new Uint8Array([unused]), b]));
export const utf8 = (s) => tlv(0x0c, enc.encode(s));
export const ia5 = (s) => tlv(0x16, enc.encode(s));
export const printable = (s) => tlv(0x13, enc.encode(s));
export function bmpBytes(s) {
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { out[2 * i] = s.charCodeAt(i) >> 8; out[2 * i + 1] = s.charCodeAt(i) & 0xff; }
  return out;
}
export const bmp = (s) => tlv(0x1e, bmpBytes(s));

// INTEGER from a non-negative number (up to 2^53) or unsigned big-endian bytes.
export function int(v) {
  let b;
  if (v instanceof Uint8Array) {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    b = v.subarray(i);
    if (!b.length) b = new Uint8Array([0]);
    if (b[0] & 0x80) b = concat([new Uint8Array([0]), b]);
  } else {
    let n = Number(v);
    if (n < 0 || n !== Math.floor(n) || n > Number.MAX_SAFE_INTEGER) throw new RangeError('INTEGER out of range: ' + v);
    const a = [];
    do { a.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0);
    if (a[0] & 0x80) a.unshift(0);
    b = new Uint8Array(a);
  }
  return tlv(0x02, b);
}

// Base-128 digits of a decimal string (OID arcs can exceed 2^53).
function arcDigits(dec) {
  const out = [];
  let d = dec.split('').map(Number);
  do {
    let rem = 0;
    const q = [];
    for (const x of d) {
      const cur = rem * 10 + x;
      const qd = Math.floor(cur / 128);
      rem = cur % 128;
      if (q.length || qd) q.push(qd);
    }
    out.unshift(rem);
    d = q;
  } while (d.length);
  return out;
}

export function oidBytes(s) {
  const p = s.split('.');
  const out = [];
  const push = (dec) => {
    const a = arcDigits(dec);
    for (let i = 0; i < a.length - 1; i++) a[i] |= 0x80;
    out.push(...a);
  };
  // The first two arcs share a subidentifier: 40 * first + second.
  const second = p[1];
  if (second.length < 15) push(String(Number(p[0]) * 40 + Number(second)));
  else push(addDec(String(Number(p[0]) * 40), second));
  for (let i = 2; i < p.length; i++) push(p[i]);
  return new Uint8Array(out);
}

// Decimal string arithmetic for OID arcs past 2^53.
function addDec(a, b) {
  let out = '', c = 0;
  for (let i = a.length - 1, j = b.length - 1; i >= 0 || j >= 0 || c; i--, j--) {
    const x = (i >= 0 ? +a[i] : 0) + (j >= 0 ? +b[j] : 0) + c;
    out = (x % 10) + out;
    c = x >= 10 ? 1 : 0;
  }
  return out;
}
function mulDecSmall(a, m) {
  let out = '', c = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    const x = +a[i] * m + c;
    out = (x % 10) + out;
    c = Math.floor(x / 10);
  }
  while (c) { out = (c % 10) + out; c = Math.floor(c / 10); }
  return out.replace(/^0+(?=\d)/, '');
}
export const oid = (s) => tlv(0x06, oidBytes(s));

const pad2 = (n) => String(n).padStart(2, '0');
export function utcTime(d) {
  const s = pad2(d.getUTCFullYear() % 100) + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  return tlv(0x17, enc.encode(s));
}
// RFC 5280: UTCTime through 2049, GeneralizedTime after.
export function genTime(d) {
  const s = String(d.getUTCFullYear()).padStart(4, '0') + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) + pad2(d.getUTCMinutes()) + pad2(d.getUTCSeconds()) + 'Z';
  return tlv(0x18, enc.encode(s));
}
export const time = (d) => (d.getUTCFullYear() < 2050 ? utcTime(d) : genTime(d));

// AlgorithmIdentifier; params: undefined for NULL, null for absent, or bytes.
export const algId = (o, params) => (params === null ? seq(oid(o)) : seq(oid(o), params || nul()));

/* ---------- decoding ---------- */

export class Node {
  constructor(u8, start, tag, vstart, vend, end) {
    this.u8 = u8; this.start = start; this.tag = tag; this.vstart = vstart; this.vend = vend; this.end = end;
    this.cls = tag >> 6;
    this.cons = !!(tag & 0x20);
    this.num = tag & 0x1f;
    this._kids = null;
  }
  get raw() { return this.u8.subarray(this.start, this.end); }
  get value() { return this.u8.subarray(this.vstart, this.vend); }
  get kids() {
    if (this._kids) return this._kids;
    if (!this.cons) throw new Error('ASN.1: not a constructed value');
    const k = [];
    let o = this.vstart;
    while (o < this.vend) {
      const n = parse(this.u8, o, this.vend);
      if (n === null) break;          // end-of-contents of an indefinite length
      k.push(n);
      o = n.end;
    }
    return (this._kids = k);
  }
  kid(i) {
    const k = this.kids[i];
    if (!k) throw new Error('ASN.1: missing element ' + i);
    return k;
  }
  // Context-specific child [n], or undefined.
  ctx(n) { return this.kids.find((k) => k.cls === 2 && k.num === n); }
}

// Parses one TLV at off. Returns null at a BER end-of-contents (00 00).
export function parse(u8, off = 0, limit = u8.length) {
  if (off + 2 > limit) throw new Error('ASN.1: truncated');
  const tag = u8[off];
  if ((tag & 0x1f) === 0x1f) throw new Error('ASN.1: high tag numbers are not supported');
  if (tag === 0 && u8[off + 1] === 0) return null;
  let o = off + 1;
  let len = u8[o++];
  if (len === 0x80) {
    if (!(tag & 0x20)) throw new Error('ASN.1: indefinite length on a primitive');
    const n = new Node(u8, off, tag, o, limit, limit);
    let p = o;
    for (;;) {
      if (p + 2 > limit) throw new Error('ASN.1: unterminated indefinite length');
      if (u8[p] === 0 && u8[p + 1] === 0) break;
      p = parse(u8, p, limit).end;
    }
    n.vend = p;
    n.end = p + 2;
    return n;
  }
  if (len & 0x80) {
    const nb = len & 0x7f;
    if (nb > 6) throw new Error('ASN.1: length too long');
    len = 0;
    for (let i = 0; i < nb; i++) len = len * 256 + u8[o++];
  }
  if (o + len > limit) throw new Error('ASN.1: value runs past its container');
  return new Node(u8, off, tag, o, o + len, o + len);
}

export function decode(u8) {
  const n = parse(u8, 0, u8.length);
  if (!n) throw new Error('ASN.1: empty');
  return n;
}

export function readOid(n) {
  if (n.tag !== 0x06) throw new Error('ASN.1: expected an OBJECT IDENTIFIER');
  const v = n.value;
  const out = [];
  let x = 0, big = null;           // big: the arc as a decimal string once past 2^46
  for (let i = 0; i < v.length; i++) {
    const d = v[i] & 0x7f;
    if (big !== null) big = addDec(mulDecSmall(big, 128), String(d));
    else if (x >= 0x400000000000) big = addDec(mulDecSmall(String(x), 128), String(d));
    else x = x * 128 + d;
    if (!(v[i] & 0x80)) {
      if (!out.length) {
        if (big !== null) out.push('2', subDec(big, '80'));
        else {
          const first = x < 80 ? Math.floor(x / 40) : 2;
          out.push(String(first), String(x - first * 40));
        }
      } else out.push(big !== null ? big : String(x));
      x = 0; big = null;
    }
  }
  return out.join('.');
}

function subDec(a, b) {                 // a - b, a >= b
  let out = '', br = 0;
  for (let i = a.length - 1, j = b.length - 1; i >= 0; i--, j--) {
    let x = +a[i] - (j >= 0 ? +b[j] : 0) - br;
    br = x < 0 ? 1 : 0;
    if (x < 0) x += 10;
    out = x + out;
  }
  return out.replace(/^0+(?=\d)/, '');
}

// A small INTEGER as a Number (versions, counts, iterations); exact up to
// 2^53. Use readUint for big values such as serial numbers.
export function readInt(n) {
  if (n.tag !== 0x02) throw new Error('ASN.1: expected an INTEGER');
  let x = 0;
  for (const b of n.value) x = x * 256 + b;
  if (n.value.length && n.value[0] & 0x80) x -= Math.pow(2, 8 * n.value.length);
  return x;
}

// Unsigned big-endian bytes of a non-negative INTEGER, without leading zeros.
export function readUint(n) {
  const v = n.value;
  let i = 0;
  while (i < v.length - 1 && v[i] === 0) i++;
  return v.subarray(i);
}

// OCTET STRING contents, joining BER constructed pieces.
export function readOctets(n) {
  if ((n.tag & 0x1f) !== 0x04 && n.cls === 0) throw new Error('ASN.1: expected an OCTET STRING');
  if (!n.cons) return n.value;
  return concat(n.kids.map(readOctets));
}

export function readBits(n) {
  if (n.tag !== 0x03) throw new Error('ASN.1: expected a BIT STRING');
  return n.value.subarray(1);
}

export function readStr(n) {
  const v = n.value;
  if (n.tag === 0x1e) {
    let s = '';
    for (let i = 0; i + 1 < v.length; i += 2) s += String.fromCharCode((v[i] << 8) | v[i + 1]);
    return s;
  }
  return dec.decode(v);
}

export function readTime(n) {
  const s = dec.decode(n.value);
  let m;
  if (n.tag === 0x17 && (m = /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?Z$/.exec(s))) {
    const y = Number(m[1]);
    return new Date(Date.UTC(y < 50 ? 2000 + y : 1900 + y, m[2] - 1, m[3], m[4], m[5], m[6] || 0));
  }
  if (n.tag === 0x18 && (m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\.\d+)?Z$/.exec(s))) {
    return new Date(Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6], m[7] ? Math.round(Number(m[7]) * 1000) : 0));
  }
  throw new Error('ASN.1: unsupported time ' + JSON.stringify(s.slice(0, 20)));
}

/* ---------- small byte helpers shared by the signing modules ---------- */

export function hex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

export function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(s) {
  // Accepts standard or URL-safe base64, with or without padding or line breaks.
  let t = String(s).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(t)) throw new Error('not base64');
  while (t.length % 4) t += '=';
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Equal bytes? Examines every byte (no early exit), so comparing a MAC or a
// check value takes the same time wherever they differ.
export function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
