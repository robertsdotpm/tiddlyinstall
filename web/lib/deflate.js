// Deflate (RFC 1951) with the zlib and gzip wrappers, in plain JavaScript,
// for browsers without CompressionStream. web/lib/zlib.js uses this only when the
// native stream is missing. Written for this project; no dependencies.
//
// LZ77 with hash chains (greedy, 32 KiB window), then per block the
// smaller of dynamic Huffman codes and a stored block. Output is valid
// deflate that any inflater reads, a little larger than zlib's level 6.
//
//   deflate(u8, format) -> Uint8Array   format: 'deflate-raw' | 'deflate' | 'gzip'
import { crc32, adler32 } from './inflate.js';

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Length (3..258) -> length code index; distance -> distance code.
const LEN_CODE = new Uint8Array(259);
for (let i = 0; i < 29; i++) for (let l = LEN_BASE[i]; l < (i < 28 ? LEN_BASE[i + 1] : 259); l++) LEN_CODE[l] = i;
LEN_CODE[258] = 28;
function distCode(d) {
  let lo = 0, hi = 29;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (DIST_BASE[m] <= d) lo = m; else hi = m - 1; }
  return lo;
}

class BitWriter {
  constructor(size) { this.buf = new Uint8Array(Math.max(256, size)); this.pos = 0; this.bits = 0; this.n = 0; }
  ensure(k) {
    if (this.pos + k <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + k));
    b.set(this.buf.subarray(0, this.pos));
    this.buf = b;
  }
  put(v, n) {                           // n <= 16
    this.bits |= v << this.n;
    this.n += n;
    if (this.n >= 16) {
      this.ensure(2);
      this.buf[this.pos++] = this.bits & 255;
      this.buf[this.pos++] = (this.bits >>> 8) & 255;
      this.bits >>>= 16;
      this.n -= 16;
    }
  }
  align() {
    this.ensure(2);
    while (this.n > 0) { this.buf[this.pos++] = this.bits & 255; this.bits >>>= 8; this.n -= 8; }
    this.n = 0; this.bits = 0;
  }
  bytes(u8) { this.ensure(u8.length); this.buf.set(u8, this.pos); this.pos += u8.length; }
  result() { this.align(); return this.buf.subarray(0, this.pos); }
}

// Code lengths (at most `limit`) for the frequencies, by Huffman's
// algorithm; if the tree is too deep, the frequencies are flattened and
// it is built again.
function codeLengths(freq, limit) {
  const n = freq.length;
  const lens = new Uint8Array(n);
  let f = Array.prototype.slice.call(freq);
  for (;;) {
    const syms = [];
    for (let i = 0; i < n; i++) if (f[i]) syms.push(i);
    if (syms.length === 0) return lens;
    if (syms.length === 1) { lens[syms[0]] = 1; return lens; }
    // Nodes: leaves 0..n-1, internal from n. Two-queue Huffman on sorted leaves.
    syms.sort((a, b) => f[a] - f[b] || a - b);
    const weight = [], parent = [];
    for (const s of syms) { weight.push(f[s]); parent.push(-1); }
    const q2 = [];
    let i1 = 0, i2 = 0;
    const take = () => {
      if (i2 < q2.length && (i1 >= syms.length || weight[q2[i2]] < weight[i1])) return q2[i2++];
      return i1++;
    };
    for (let k = 0; k < syms.length - 1; k++) {
      const a = take(), b = take();
      const id = weight.length;
      weight.push(weight[a] + weight[b]); parent.push(-1);
      parent[a] = id; parent[b] = id;
      q2.push(id);
    }
    let max = 0;
    const depth = new Array(weight.length).fill(0);
    for (let id = weight.length - 2; id >= 0; id--) depth[id] = depth[parent[id]] + 1;
    for (let k = 0; k < syms.length; k++) { lens[syms[k]] = depth[k]; if (depth[k] > max) max = depth[k]; }
    if (max <= limit) return lens;
    f = f.map((x) => (x ? (x >> 1) + 1 : 0));
    lens.fill(0);
  }
}

// Canonical codes, bit-reversed for LSB-first output.
function codes(lens) {
  const count = new Uint16Array(16), next = new Uint16Array(16), out = new Uint16Array(lens.length);
  for (let i = 0; i < lens.length; i++) count[lens[i]]++;
  count[0] = 0;
  for (let l = 1, c = 0; l <= 15; l++) { c = (c + count[l - 1]) << 1; next[l] = c; }
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i];
    if (!l) continue;
    let c = next[l]++, r = 0;
    for (let k = 0; k < l; k++) { r = (r << 1) | (c & 1); c >>= 1; }
    out[i] = r;
  }
  return out;
}

// Run-length codes for the code lengths (symbols 16, 17, 18).
function rle(lens) {
  const out = [];
  for (let i = 0; i < lens.length;) {
    const v = lens[i];
    let r = 1;
    while (i + r < lens.length && lens[i + r] === v) r++;
    i += r;
    if (v === 0) {
      while (r >= 11) { const k = Math.min(r, 138); out.push([18, k - 11]); r -= k; }
      if (r >= 3) { out.push([17, r - 3]); r = 0; }
    } else {
      out.push([v]); r--;
      while (r >= 3) { const k = Math.min(r, 6); out.push([16, k - 3]); r -= k; }
    }
    while (r-- > 0) out.push([v]);
  }
  return out;
}

const WINDOW = 32768, HASH_BITS = 15, MAX_CHAIN = 64, BLOCK_SYMS = 1 << 15;

// Writes one block of symbols (lit < 256, or 256 + length-1 with a
// distance) from src[start, end), dynamic or stored, whichever is smaller.
function writeBlock(w, src, start, end, syms, nsyms, last) {
  const lf = new Uint32Array(286), df = new Uint32Array(30);
  for (let i = 0; i < nsyms; i += 2) {
    const s = syms[i];
    if (s < 256) lf[s]++;
    else { lf[257 + LEN_CODE[s - 256]]++; df[distCode(syms[i + 1])]++; }
  }
  lf[256] = 1;
  const ll = codeLengths(lf, 15), dl = codeLengths(df, 15);
  if (!dl.some((x) => x)) dl[0] = 1;          // at least one distance code
  let hlit = 286; while (hlit > 257 && !ll[hlit - 1]) hlit--;
  let hdist = 30; while (hdist > 1 && !dl[hdist - 1]) hdist--;
  const all = new Uint8Array(hlit + hdist);
  all.set(ll.subarray(0, hlit)); all.set(dl.subarray(0, hdist), hlit);
  const runs = rle(all);
  const cf = new Uint32Array(19);
  for (const r of runs) cf[r[0]]++;
  const cl = codeLengths(cf, 7);
  let hclen = 19; while (hclen > 4 && !cl[CL_ORDER[hclen - 1]]) hclen--;

  // Size of the dynamic block in bits, against a stored block.
  let bits = 3 + 14 + 3 * hclen;
  for (const r of runs) bits += cl[r[0]] + (r[0] === 16 ? 2 : r[0] === 17 ? 3 : r[0] === 18 ? 7 : 0);
  for (let s = 0; s < 286; s++) if (lf[s]) bits += lf[s] * (ll[s] + (s > 256 ? LEN_EXTRA[s - 257] : 0));
  for (let s = 0; s < 30; s++) if (df[s]) bits += df[s] * (dl[s] + DIST_EXTRA[s]);
  const storedBits = (end - start) * 8 + 5 * 8 * Math.ceil((end - start) / 65535 || 1) + 8;

  if (storedBits < bits) {
    for (let o = start; o < end || o === start;) {
      const n = Math.min(65535, end - o);
      const fin = last && o + n >= end;
      w.put(fin ? 1 : 0, 3);
      w.align();
      w.ensure(4);
      w.buf[w.pos++] = n & 255; w.buf[w.pos++] = n >> 8;
      w.buf[w.pos++] = ~n & 255; w.buf[w.pos++] = (~n >> 8) & 255;
      w.bytes(src.subarray(o, o + n));
      o += n;
      if (o >= end) break;
    }
    return;
  }

  const lc = codes(ll), dc = codes(dl), cc = codes(cl);
  w.put(last ? 1 : 0, 1);
  w.put(2, 2);
  w.put(hlit - 257, 5); w.put(hdist - 1, 5); w.put(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.put(cl[CL_ORDER[i]], 3);
  for (const r of runs) {
    w.put(cc[r[0]], cl[r[0]]);
    if (r[0] === 16) w.put(r[1], 2);
    else if (r[0] === 17) w.put(r[1], 3);
    else if (r[0] === 18) w.put(r[1], 7);
  }
  for (let i = 0; i < nsyms; i += 2) {
    const s = syms[i];
    if (s < 256) { w.put(lc[s], ll[s]); continue; }
    const len = s - 256, li = LEN_CODE[len];
    w.put(lc[257 + li], ll[257 + li]);
    if (LEN_EXTRA[li]) w.put(len - LEN_BASE[li], LEN_EXTRA[li]);
    const d = syms[i + 1], di = distCode(d);
    w.put(dc[di], dl[di]);
    if (DIST_EXTRA[di]) w.put(d - DIST_BASE[di], DIST_EXTRA[di]);
  }
  w.put(lc[256], ll[256]);
}

export function deflateRaw(src) {
  const n = src.length;
  const w = new BitWriter((n >> 1) + 64);
  if (!n) { w.put(3, 3); w.put(0, 7); return w.result().slice(); }  // one empty fixed block
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(WINDOW);
  const syms = new Uint32Array(2 * BLOCK_SYMS + 2);
  let nsyms = 0, blockStart = 0;
  const hash = (i) => (((src[i] << 10) ^ (src[i + 1] << 5) ^ src[i + 2]) * 0x9e3779b1 >>> (32 - HASH_BITS));
  const insert = (i) => {
    if (i + 2 >= n) return;
    const h = hash(i);
    prev[i & (WINDOW - 1)] = head[h];
    head[h] = i;
  };
  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      const h = hash(i);
      let cand = head[h], chain = MAX_CHAIN;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WINDOW - 1 && chain-- > 0) {
        if (src[cand + bestLen] === src[i + bestLen] && src[cand] === src[i]) {
          let l = 0;
          while (l < maxLen && src[cand + l] === src[i + l]) l++;
          if (l > bestLen) { bestLen = l; bestDist = i - cand; if (l === maxLen) break; }
        }
        const p = prev[cand & (WINDOW - 1)];
        if (p >= cand) break;
        cand = p;
      }
    }
    if (bestLen >= 3) {
      syms[nsyms++] = 256 + bestLen; syms[nsyms++] = bestDist;
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      syms[nsyms++] = src[i]; syms[nsyms++] = 0;
      insert(i);
      i++;
    }
    if (nsyms >= 2 * BLOCK_SYMS) {
      writeBlock(w, src, blockStart, i, syms, nsyms, i >= n);
      nsyms = 0; blockStart = i;
    }
  }
  if (nsyms || blockStart < n) writeBlock(w, src, blockStart, n, syms, nsyms, true);
  return w.result().slice();
}

export function deflate(u8, format) {
  if (format === 'deflate-raw') return deflateRaw(u8);
  const body = deflateRaw(u8);
  if (format === 'deflate') {
    const out = new Uint8Array(body.length + 6);
    out[0] = 0x78; out[1] = 0x9c;
    out.set(body, 2);
    new DataView(out.buffer).setUint32(2 + body.length, adler32(u8));
    return out;
  }
  if (format === 'gzip') {
    const out = new Uint8Array(body.length + 18);
    out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff]);
    out.set(body, 10);
    const dv = new DataView(out.buffer);
    dv.setUint32(10 + body.length, crc32(u8), true);
    dv.setUint32(14 + body.length, u8.length >>> 0, true);
    return out;
  }
  throw new TypeError('deflate: unknown format ' + format);
}
