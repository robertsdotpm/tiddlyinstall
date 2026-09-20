// Inflate (RFC 1951) with the zlib (RFC 1950) and gzip (RFC 1952) wrappers,
// in plain JavaScript, for browsers without DecompressionStream (before
// Chrome 80, Firefox 113 and Safari 16.4) or without its 'deflate-raw'.
// web/lib/zlib.js uses this only when the native stream is missing. Written for
// this project; no dependencies. Whole buffers only (no streaming).
//
//   inflate(u8, format, sizeHint) -> Uint8Array
//     format: 'deflate-raw' | 'deflate' (zlib) | 'gzip'
//   crc32(u8, crc?) -> number     adler32(u8) -> number

export class InflateError extends Error {}
const fail = (m) => { throw new InflateError('inflate: ' + m); };

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// A decoding table indexed by the next `bits` input bits (LSB first):
// entry = symbol << 4 | code length, or 0 for no code.
function buildTable(lengths, n) {
  let max = 0;
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) { count[lengths[i]]++; if (lengths[i] > max) max = lengths[i]; }
  count[0] = 0;
  if (!max) return { table: new Int32Array(1), bits: 1 };
  // Over-subscribed codes are invalid; incomplete ones are allowed (a lone
  // distance code is common).
  let left = 1;
  for (let l = 1; l <= 15; l++) { left = 2 * left - count[l]; if (left < 0) fail('bad Huffman code'); }
  const next = new Uint16Array(16);
  for (let l = 1, code = 0; l <= 15; l++) { code = (code + count[l - 1]) << 1; next[l] = code; }
  const table = new Int32Array(1 << max);
  for (let s = 0; s < n; s++) {
    const l = lengths[s];
    if (!l) continue;
    let c = next[l]++, r = 0;
    for (let i = 0; i < l; i++) { r = (r << 1) | (c & 1); c >>= 1; }
    const entry = (s << 4) | l;
    for (let i = r; i < table.length; i += 1 << l) table[i] = entry;
  }
  return { table, bits: max };
}

let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
  const d = new Uint8Array(30).fill(5);
  FIXED = [buildTable(l, 288), buildTable(d, 30)];
  return FIXED;
}

// Inflates raw deflate data from src[start]. Returns {out, end}, end
// being the offset just past the last block (for a trailer after it).
export function inflateRawAt(src, start, sizeHint) {
  let out = new Uint8Array(Math.max(1024, sizeHint || src.length * 4));
  let op = 0;
  let pos = start, bitbuf = 0, bitcnt = 0;
  const len = src.length;

  const need = (n) => {
    while (bitcnt < n) {
      if (pos >= len) fail('unexpected end of data');
      bitbuf |= src[pos++] << bitcnt;
      bitcnt += 8;
    }
  };
  const bits = (n) => {
    need(n);
    const v = bitbuf & ((1 << n) - 1);
    bitbuf >>>= n; bitcnt -= n;
    return v;
  };
  const grow = (n) => {
    if (op + n <= out.length) return;
    let size = out.length * 2;
    while (size < op + n) size *= 2;
    const o2 = new Uint8Array(size);
    o2.set(out.subarray(0, op));
    out = o2;
  };
  // Decodes one symbol: fills up to the table's width, tolerating a short
  // tail at the end of the input as long as the code itself fits.
  const decode = (t) => {
    while (bitcnt < t.bits && pos < len) { bitbuf |= src[pos++] << bitcnt; bitcnt += 8; }
    const e = t.table[bitbuf & ((1 << t.bits) - 1)];
    const l = e & 15;
    if (!l || l > bitcnt) fail(l ? 'unexpected end of data' : 'bad code');
    bitbuf >>>= l; bitcnt -= l;
    return e >> 4;
  };

  let final = 0;
  while (!final) {
    final = bits(1);
    const type = bits(2);
    if (type === 0) {
      // Stored: skip to a byte boundary; give back whole bytes still buffered.
      bitbuf >>>= bitcnt & 7; bitcnt -= bitcnt & 7;
      pos -= bitcnt >> 3; bitbuf = 0; bitcnt = 0;
      if (pos + 4 > len) fail('unexpected end of data');
      const n = src[pos] | (src[pos + 1] << 8), nn = src[pos + 2] | (src[pos + 3] << 8);
      if ((n ^ 0xffff) !== nn) fail('bad stored block length');
      pos += 4;
      if (pos + n > len) fail('unexpected end of data');
      grow(n);
      out.set(src.subarray(pos, pos + n), op);
      op += n; pos += n;
      continue;
    }
    let lit, dist;
    if (type === 1) { const f = fixedTables(); lit = f[0]; dist = f[1]; }
    else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clt = buildTable(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const s = decode(clt);
        if (s < 16) lens[i++] = s;
        else {
          let rep, v = 0;
          if (s === 16) { if (!i) fail('repeat with no previous length'); v = lens[i - 1]; rep = 3 + bits(2); }
          else if (s === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (i + rep > hlit + hdist) fail('too many code lengths');
          lens.fill(v, i, i + rep);
          i += rep;
        }
      }
      if (!lens[256]) fail('no end-of-block code');
      lit = buildTable(lens.subarray(0, hlit), hlit);
      dist = buildTable(lens.subarray(hlit), hdist);
    } else fail('bad block type');

    for (;;) {
      const s = decode(lit);
      if (s < 256) {
        if (op >= out.length) grow(1);
        out[op++] = s;
      } else if (s === 256) break;
      else {
        const li = s - 257;
        if (li >= 29) fail('bad length code');
        const n = LEN_BASE[li] + (LEN_EXTRA[li] ? bits(LEN_EXTRA[li]) : 0);
        const di = decode(dist);
        if (di >= 30) fail('bad distance code');
        const d = DIST_BASE[di] + (DIST_EXTRA[di] ? bits(DIST_EXTRA[di]) : 0);
        if (d > op) fail('distance too far back');
        grow(n);
        let from = op - d;
        if (d >= n) { out.copyWithin(op, from, from + n); op += n; }
        else for (let i = 0; i < n; i++) out[op++] = out[from++];
      }
    }
  }
  // Unused whole bytes in the bit buffer belong to what follows.
  pos -= bitcnt >> 3;
  return { out: out.subarray(0, op), end: pos };
}

let CRC_TABLE = null;
export function crc32(u8, crc) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = (crc === undefined ? 0 : crc) ^ -1;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function adler32(u8) {
  let a = 1, b = 0;
  for (let i = 0; i < u8.length;) {
    const end = Math.min(u8.length, i + 3800);
    for (; i < end; i++) { a += u8[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32le = (u8, o) => (u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24)) >>> 0;
const u32be = (u8, o) => ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;

function gunzip(src) {
  const parts = [];
  let o = 0;
  do {
    if (src.length < o + 18 || src[o] !== 0x1f || src[o + 1] !== 0x8b) fail('not gzip data');
    if (src[o + 2] !== 8) fail('unknown gzip compression method');
    const flg = src[o + 3];
    let p = o + 10;
    if (flg & 4) p += 2 + (src[p] | (src[p + 1] << 8));                // FEXTRA
    if (flg & 8) { while (p < src.length && src[p]) p++; p++; }        // FNAME
    if (flg & 16) { while (p < src.length && src[p]) p++; p++; }       // FCOMMENT
    if (flg & 2) p += 2;                                               // FHCRC
    if (p > src.length) fail('truncated gzip header');
    // ISIZE (the size mod 2^32) is only a hint for a single member.
    const hint = o === 0 ? u32le(src, src.length - 4) : 0;
    const r = inflateRawAt(src, p, Math.min(hint, 1032 * src.length + 1024));   // 1032:1 is deflate's best
    if (r.end + 8 > src.length) fail('truncated gzip trailer');
    if (crc32(r.out) !== u32le(src, r.end)) fail('gzip CRC mismatch');
    if ((r.out.length >>> 0) !== u32le(src, r.end + 4)) fail('gzip size mismatch');
    parts.push(r.out);
    o = r.end + 8;
  } while (o < src.length && src[o] === 0x1f);                      // concatenated members
  if (o !== src.length) fail('junk after the gzip data');
  if (parts.length === 1) return parts[0];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  n = 0;
  for (const p of parts) { out.set(p, n); n += p.length; }
  return out;
}

function unzlib(src) {
  if (src.length < 6) fail('truncated zlib data');
  const cmf = src[0], flg = src[1];
  if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31) fail('not zlib data');
  if (flg & 32) fail('zlib preset dictionaries are not supported');
  const r = inflateRawAt(src, 2);
  if (r.end + 4 > src.length) fail('truncated zlib trailer');
  if (adler32(r.out) !== u32be(src, r.end)) fail('zlib checksum mismatch');
  if (r.end + 4 !== src.length) fail('junk after the zlib data');
  return r.out;
}

export function inflate(u8, format, sizeHint) {
  if (format === 'gzip') return gunzip(u8);
  if (format === 'deflate') return unzlib(u8);
  if (format === 'deflate-raw') {
    const r = inflateRawAt(u8, 0, sizeHint);
    if (r.end !== u8.length) fail('junk after the deflate data');
    return r.out;
  }
  throw new TypeError('inflate: unknown format ' + format);
}
