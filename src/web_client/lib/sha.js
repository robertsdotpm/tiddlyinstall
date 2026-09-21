// SHA-1, SHA-256, SHA-384 and SHA-512 in plain JavaScript (FIPS 180-4), for
// browsers without WebCrypto (crypto.subtle is missing on plain-http pages
// and in old browsers). src/web_client/lib/cryptox.js uses these only when the native
// digest is unavailable. Written for this project; no dependencies.
//
//   sha(name, bytes) -> Uint8Array   name: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'
//   sha1(b), sha256(b), sha384(b), sha512(b)
//
// Plain 32-bit arithmetic only (no BigInt): SHA-512's 64-bit words are
// kept as high and low halves.

const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

// High and low halves of the SHA-512 round constants.
const K512 = new Int32Array([
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc,
  0x3956c25b, 0xf348b538, 0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118,
  0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe, 0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2,
  0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235, 0xc19bf174, 0xcf692694,
  0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5,
  0x983e5152, 0xee66dfab, 0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4,
  0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725, 0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70,
  0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed, 0x53380d13, 0x9d95b3df,
  0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30,
  0xd192e819, 0xd6ef5218, 0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8,
  0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53, 0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8,
  0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373, 0x682e6ff3, 0xd6b2b8a3,
  0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b,
  0xca273ece, 0xea26619c, 0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178,
  0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6, 0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b,
  0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc, 0x431d67c4, 0x9c100d4c,
  0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817,
]);

// The message padded to whole blocks (`block` bytes) with the bit length
// in the last `lenBytes` bytes, big-endian.
function pad(msg, block, lenBytes) {
  const n = msg.length;
  const total = Math.ceil((n + 1 + lenBytes) / block) * block;
  const out = new Uint8Array(total);
  out.set(msg);
  out[n] = 0x80;
  // Bit length: n * 8, split so it stays exact past 2^32 bits.
  const hi = Math.floor(n / 0x20000000), lo = (n * 8) >>> 0;
  const dv = new DataView(out.buffer);
  dv.setUint32(total - 8, hi);
  dv.setUint32(total - 4, lo);
  return out;
}

function bytesOut(words, n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = words[i >> 2] >>> (24 - 8 * (i & 3));
  return out;
}

function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return new Uint8Array(b);
}

export function sha1(data) {
  const m = pad(toBytes(data), 64, 8);
  const dv = new DataView(m.buffer);
  const w = new Int32Array(80);
  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  for (let o = 0; o < m.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + 4 * i);
    for (let i = 16; i < 80; i++) { const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return bytesOut([h0, h1, h2, h3, h4], 20);
}

const IV256 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

// One 64-byte block at `o`, folded into `h`. `w` is scratch, reused.
function sha256Block(h, dv, o, w) {
  for (let i = 0; i < 16; i++) w[i] = dv.getInt32(o + 4 * i);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
}

export function sha256(data) {
  const m = pad(toBytes(data), 64, 8);
  const dv = new DataView(m.buffer);
  const w = new Int32Array(64);
  const h = new Int32Array(IV256);
  for (let o = 0; o < m.length; o += 64) sha256Block(h, dv, o, w);
  return bytesOut(h, 32);
}

// SHA-256 a piece at a time, so a caller with several ranges of a large
// file need not join them into one buffer first (WebCrypto's digest takes
// only a whole buffer, which is a second copy of the file; src/web_client/lib/authenticode.js
// hashes a PE that way). Slower than the native digest, so it is for the
// sizes where the copy is what hurts.
//
//   const h = sha256Stream(); h.update(a); h.update(b); h.digest() -> Uint8Array
export function sha256Stream() {
  const h = new Int32Array(IV256);
  const w = new Int32Array(64);
  const block = new Uint8Array(64);
  const dv = new DataView(block.buffer);
  let held = 0;            // bytes waiting in `block`
  let total = 0;           // bytes fed in, for the length at the end
  let done = false;
  return {
    update(data) {
      if (done) throw new Error('sha256Stream: update after digest');
      const u8 = toBytes(data);
      total += u8.length;
      let i = 0;
      if (held) {          // fill the part-block first
        const take = Math.min(64 - held, u8.length);
        block.set(u8.subarray(0, take), held);
        held += take;
        i = take;
        if (held < 64) return;
        sha256Block(h, dv, 0, w);
        held = 0;
      }
      // Whole blocks straight out of the caller's bytes. A DataView needs
      // the byte offset within the underlying buffer, not within `u8`.
      if (u8.length - i >= 64) {
        const src = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        for (; i + 64 <= u8.length; i += 64) sha256Block(h, src, i, w);
      }
      if (i < u8.length) {
        block.set(u8.subarray(i), 0);
        held = u8.length - i;
      }
    },
    digest() {
      if (done) throw new Error('sha256Stream: digest called twice');
      done = true;
      block.fill(0, held);
      block[held] = 0x80;
      if (held >= 56) {    // no room for the length: one more block
        sha256Block(h, dv, 0, w);
        block.fill(0);
      }
      dv.setUint32(56, Math.floor(total / 0x20000000));
      dv.setUint32(60, (total * 8) >>> 0);
      sha256Block(h, dv, 0, w);
      return bytesOut(h, 32);
    },
  };
}

const IV512 = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
  0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
const IV384 = [0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939,
  0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4];

// SHA-512 core over 64-bit words as (hi, lo) Int32 pairs.
function sha512core(data, iv, outLen) {
  const m = pad(toBytes(data), 128, 16);
  const dv = new DataView(m.buffer);
  const w = new Int32Array(160);
  const h = new Int32Array(iv);
  for (let o = 0; o < m.length; o += 128) {
    for (let i = 0; i < 32; i++) w[i] = dv.getInt32(o + 4 * i);
    for (let i = 16; i < 80; i++) {
      // s0 = rotr1 ^ rotr8 ^ shr7 of w[i-15]; s1 = rotr19 ^ rotr61 ^ shr6 of w[i-2]
      let xh = w[2 * (i - 15)], xl = w[2 * (i - 15) + 1];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = w[2 * (i - 2)]; xl = w[2 * (i - 2) + 1];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      // w[i] = w[i-16] + s0 + w[i-7] + s1, with carries through 16-bit pieces.
      const a = w[2 * (i - 16) + 1], b = w[2 * (i - 7) + 1];
      let lo = (a & 0xffff) + (s0l & 0xffff) + (b & 0xffff) + (s1l & 0xffff);
      let mid = (a >>> 16) + (s0l >>> 16) + (b >>> 16) + (s1l >>> 16) + (lo >>> 16);
      w[2 * i + 1] = (mid << 16) | (lo & 0xffff);
      w[2 * i] = (w[2 * (i - 16)] + s0h + w[2 * (i - 7)] + s1h + Math.floor(mid / 0x10000)) | 0;
    }
    let ah = h[0], al = h[1], bh = h[2], bl = h[3], ch = h[4], cl = h[5], dh = h[6], dl = h[7];
    let eh = h[8], el = h[9], fh = h[10], fl = h[11], gh = h[12], gl = h[13], hh = h[14], hl = h[15];
    for (let i = 0; i < 80; i++) {
      // S1 = rotr14 ^ rotr18 ^ rotr41 of e
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      // t1 = h + S1 + ch + K + w
      const kl = K512[2 * i + 1], wl = w[2 * i + 1];
      let lo = (hl & 0xffff) + (S1l & 0xffff) + (chl & 0xffff) + (kl & 0xffff) + (wl & 0xffff);
      let mid = (hl >>> 16) + (S1l >>> 16) + (chl >>> 16) + (kl >>> 16) + (wl >>> 16) + (lo >>> 16);
      const t1l = (mid << 16) | (lo & 0xffff);
      const t1h = (hh + S1h + chh + K512[2 * i] + w[2 * i] + Math.floor(mid / 0x10000)) | 0;
      // S0 = rotr28 ^ rotr34 ^ rotr39 of a
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      lo = (S0l & 0xffff) + (mjl & 0xffff);
      mid = (S0l >>> 16) + (mjl >>> 16) + (lo >>> 16);
      const t2l = (mid << 16) | (lo & 0xffff);
      const t2h = (S0h + mjh + (mid >>> 16)) | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      // e = d + t1
      lo = (dl & 0xffff) + (t1l & 0xffff);
      mid = (dl >>> 16) + (t1l >>> 16) + (lo >>> 16);
      el = (mid << 16) | (lo & 0xffff);
      eh = (dh + t1h + (mid >>> 16)) | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      // a = t1 + t2
      lo = (t1l & 0xffff) + (t2l & 0xffff);
      mid = (t1l >>> 16) + (t2l >>> 16) + (lo >>> 16);
      al = (mid << 16) | (lo & 0xffff);
      ah = (t1h + t2h + (mid >>> 16)) | 0;
    }
    const v = [ah, al, bh, bl, ch, cl, dh, dl, eh, el, fh, fl, gh, gl, hh, hl];
    for (let j = 0; j < 16; j += 2) {
      const lo = (h[j + 1] & 0xffff) + (v[j + 1] & 0xffff);
      const mid = (h[j + 1] >>> 16) + (v[j + 1] >>> 16) + (lo >>> 16);
      h[j + 1] = (mid << 16) | (lo & 0xffff);
      h[j] = (h[j] + v[j] + (mid >>> 16)) | 0;
    }
  }
  return bytesOut(h, outLen);
}

export const sha512 = (data) => sha512core(data, IV512, 64);
export const sha384 = (data) => sha512core(data, IV384, 48);

const BY_NAME = { 'SHA-1': sha1, 'SHA-256': sha256, 'SHA-384': sha384, 'SHA-512': sha512 };
export const HASH_LEN = { 'SHA-1': 20, 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 };
export const BLOCK_LEN = { 'SHA-1': 64, 'SHA-256': 64, 'SHA-384': 128, 'SHA-512': 128 };

export function hashName(h) {
  const n = typeof h === 'string' ? h : h && h.name;
  const u = String(n).toUpperCase().replace(/^SHA(\d)/, 'SHA-$1');
  if (!BY_NAME[u]) throw new Error('Unsupported hash: ' + n);
  return u;
}

export function sha(name, data) {
  return BY_NAME[hashName(name)](data);
}
