// AES (FIPS 197) with CBC and CFB modes, for browsers without WebCrypto.
// src/web_client/lib/cryptox.js uses this only when the native AES-CBC is missing. Written
// for this project from the standard; no dependencies. Tables are computed
// at first use rather than stored. The round tables are indexed by secret
// bytes, as in most software AES, so this is not constant-time against a
// cache-timing attacker on the same machine.
//
//   aesCbcEncrypt(key, iv, data) -> Uint8Array   PKCS#7 padding added
//   aesCbcDecrypt(key, iv, data) -> Uint8Array   PKCS#7 padding checked and
//                                                removed (throws if wrong)
//   aesCfb(key, iv, data, decrypt) -> Uint8Array  full-block CFB (OpenPGP's)
//
// key: 16, 24 or 32 bytes.

let SBOX, INV, TE, TD;   // S-box, its inverse, and the round tables

function tables() {
  SBOX = new Uint8Array(256); INV = new Uint8Array(256);
  TE = [new Int32Array(256), new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  TD = [new Int32Array(256), new Int32Array(256), new Int32Array(256), new Int32Array(256)];
  // Powers of 3 generate GF(2^8)*; log/exp tables give the inverses.
  const exp = new Uint8Array(256), log = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    exp[i] = x; log[x] = i;
    x ^= (x << 1) ^ (x & 0x80 ? 0x11b : 0);
    x &= 0xff;
  }
  const mul = (a, b) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
  for (let i = 0; i < 256; i++) {
    let s = i ? exp[(255 - log[i]) % 255] : 0;
    s ^= ((s << 1) | (s >> 7)) ^ ((s << 2) | (s >> 6)) ^ ((s << 3) | (s >> 5)) ^ ((s << 4) | (s >> 4)) ^ 0x63;
    s &= 0xff;
    SBOX[i] = s; INV[s] = i;
  }
  for (let i = 0; i < 256; i++) {
    const s = SBOX[i];
    const e = (mul(s, 2) << 24) | (s << 16) | (s << 8) | mul(s, 3);
    const v = INV[i];
    const d = (mul(v, 14) << 24) | (mul(v, 9) << 16) | (mul(v, 13) << 8) | mul(v, 11);
    for (let r = 0; r < 4; r++) {
      TE[r][i] = (e >>> (8 * r)) | (e << (32 - 8 * r));
      TD[r][i] = (d >>> (8 * r)) | (d << (32 - 8 * r));
    }
  }
}

// Round keys for encryption and for the equivalent inverse cipher.
function expandKey(key) {
  if (!SBOX) tables();
  const nk = key.length / 4;
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('AES: the key must be 16, 24 or 32 bytes');
  const nr = nk + 6, n = 4 * (nr + 1);
  const ek = new Int32Array(n);
  for (let i = 0; i < nk; i++) ek[i] = (key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3];
  for (let i = nk, rcon = 1; i < n; i++) {
    let t = ek[i - 1];
    if (i % nk === 0) {
      t = (t << 8) | (t >>> 24);
      t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255];
      t ^= rcon << 24;
      rcon = (rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0);
    } else if (nk > 6 && i % nk === 4) {
      t = (SBOX[t >>> 24] << 24) | (SBOX[(t >>> 16) & 255] << 16) | (SBOX[(t >>> 8) & 255] << 8) | SBOX[t & 255];
    }
    ek[i] = ek[i - nk] ^ t;
  }
  // Decryption keys: reversed rounds, InvMixColumns applied to the middle ones.
  const dk = new Int32Array(n);
  for (let r = 0; r <= nr; r++) {
    for (let c = 0; c < 4; c++) {
      const w = ek[4 * (nr - r) + c];
      dk[4 * r + c] = r === 0 || r === nr ? w
        : TD[0][SBOX[w >>> 24]] ^ TD[1][SBOX[(w >>> 16) & 255]] ^ TD[2][SBOX[(w >>> 8) & 255]] ^ TD[3][SBOX[w & 255]];
    }
  }
  return { ek, dk, nr };
}

// One block: s (4 Int32 words, big-endian) in, result written to s.
function encryptWords(k, s) {
  const ek = k.ek, T0 = TE[0], T1 = TE[1], T2 = TE[2], T3 = TE[3];
  let a = s[0] ^ ek[0], b = s[1] ^ ek[1], c = s[2] ^ ek[2], d = s[3] ^ ek[3];
  let o = 4;
  for (let r = 1; r < k.nr; r++, o += 4) {
    const a2 = T0[a >>> 24] ^ T1[(b >>> 16) & 255] ^ T2[(c >>> 8) & 255] ^ T3[d & 255] ^ ek[o];
    const b2 = T0[b >>> 24] ^ T1[(c >>> 16) & 255] ^ T2[(d >>> 8) & 255] ^ T3[a & 255] ^ ek[o + 1];
    const c2 = T0[c >>> 24] ^ T1[(d >>> 16) & 255] ^ T2[(a >>> 8) & 255] ^ T3[b & 255] ^ ek[o + 2];
    d = T0[d >>> 24] ^ T1[(a >>> 16) & 255] ^ T2[(b >>> 8) & 255] ^ T3[c & 255] ^ ek[o + 3];
    a = a2; b = b2; c = c2;
  }
  const S = SBOX;
  s[0] = ((S[a >>> 24] << 24) | (S[(b >>> 16) & 255] << 16) | (S[(c >>> 8) & 255] << 8) | S[d & 255]) ^ ek[o];
  s[1] = ((S[b >>> 24] << 24) | (S[(c >>> 16) & 255] << 16) | (S[(d >>> 8) & 255] << 8) | S[a & 255]) ^ ek[o + 1];
  s[2] = ((S[c >>> 24] << 24) | (S[(d >>> 16) & 255] << 16) | (S[(a >>> 8) & 255] << 8) | S[b & 255]) ^ ek[o + 2];
  s[3] = ((S[d >>> 24] << 24) | (S[(a >>> 16) & 255] << 16) | (S[(b >>> 8) & 255] << 8) | S[c & 255]) ^ ek[o + 3];
}

function decryptWords(k, s) {
  const dk = k.dk, T0 = TD[0], T1 = TD[1], T2 = TD[2], T3 = TD[3];
  let a = s[0] ^ dk[0], b = s[1] ^ dk[1], c = s[2] ^ dk[2], d = s[3] ^ dk[3];
  let o = 4;
  for (let r = 1; r < k.nr; r++, o += 4) {
    const a2 = T0[a >>> 24] ^ T1[(d >>> 16) & 255] ^ T2[(c >>> 8) & 255] ^ T3[b & 255] ^ dk[o];
    const b2 = T0[b >>> 24] ^ T1[(a >>> 16) & 255] ^ T2[(d >>> 8) & 255] ^ T3[c & 255] ^ dk[o + 1];
    const c2 = T0[c >>> 24] ^ T1[(b >>> 16) & 255] ^ T2[(a >>> 8) & 255] ^ T3[d & 255] ^ dk[o + 2];
    d = T0[d >>> 24] ^ T1[(c >>> 16) & 255] ^ T2[(b >>> 8) & 255] ^ T3[a & 255] ^ dk[o + 3];
    a = a2; b = b2; c = c2;
  }
  const S = INV;
  s[0] = ((S[a >>> 24] << 24) | (S[(d >>> 16) & 255] << 16) | (S[(c >>> 8) & 255] << 8) | S[b & 255]) ^ dk[o];
  s[1] = ((S[b >>> 24] << 24) | (S[(a >>> 16) & 255] << 16) | (S[(d >>> 8) & 255] << 8) | S[c & 255]) ^ dk[o + 1];
  s[2] = ((S[c >>> 24] << 24) | (S[(b >>> 16) & 255] << 16) | (S[(a >>> 8) & 255] << 8) | S[d & 255]) ^ dk[o + 2];
  s[3] = ((S[d >>> 24] << 24) | (S[(c >>> 16) & 255] << 16) | (S[(b >>> 8) & 255] << 8) | S[a & 255]) ^ dk[o + 3];
}

function load(u8, o, s) {
  for (let i = 0; i < 4; i++) s[i] = (u8[o + 4 * i] << 24) | (u8[o + 4 * i + 1] << 16) | (u8[o + 4 * i + 2] << 8) | u8[o + 4 * i + 3];
}
function store(s, u8, o) {
  for (let i = 0; i < 4; i++) {
    u8[o + 4 * i] = s[i] >>> 24; u8[o + 4 * i + 1] = s[i] >>> 16; u8[o + 4 * i + 2] = s[i] >>> 8; u8[o + 4 * i + 3] = s[i];
  }
}

// One block with a key schedule (for tests and single-block uses).
export function aesEncryptBlock(key, block) {
  const k = expandKey(key), s = new Int32Array(4), out = new Uint8Array(16);
  load(block, 0, s); encryptWords(k, s); store(s, out, 0);
  return out;
}

export function aesCbcEncrypt(key, iv, data) {
  const k = expandKey(key);
  const padN = 16 - (data.length % 16);
  const out = new Uint8Array(data.length + padN);
  out.set(data);
  out.fill(padN, data.length);
  const s = new Int32Array(4), p = new Int32Array(4);
  load(iv, 0, s);
  for (let o = 0; o < out.length; o += 16) {
    load(out, o, p);
    for (let i = 0; i < 4; i++) s[i] ^= p[i];
    encryptWords(k, s);
    store(s, out, o);
  }
  return out;
}

export function aesCbcDecrypt(key, iv, data) {
  if (data.length % 16 || !data.length) throw new Error('AES-CBC: the data is not a whole number of blocks');
  const k = expandKey(key);
  const out = new Uint8Array(data.length);
  const prev = new Int32Array(4), cur = new Int32Array(4), s = new Int32Array(4);
  load(iv, 0, prev);
  for (let o = 0; o < data.length; o += 16) {
    load(data, o, cur);
    s.set(cur);
    decryptWords(k, s);
    for (let i = 0; i < 4; i++) s[i] ^= prev[i];
    store(s, out, o);
    prev.set(cur);
  }
  // All 16 bytes are examined whatever they hold (no early exit).
  const n = out[out.length - 1];
  let bad = (n < 1 || n > 16) ? 1 : 0;
  for (let i = 0; i < 16; i++) bad |= (i < n ? 1 : 0) & (out[out.length - 1 - i] !== n ? 1 : 0);
  if (bad) throw new Error('AES-CBC: bad padding');
  return out.subarray(0, out.length - n);
}

// CFB with a full-block feedback, as OpenPGP uses it (RFC 4880 13.9, no
// resync). The last block may be short.
export function aesCfb(key, iv, data, decrypt) {
  const k = expandKey(key);
  const out = new Uint8Array(data.length);
  const s = new Int32Array(4), ks = new Uint8Array(16), fb = new Uint8Array(16);
  fb.set(iv.subarray(0, 16));
  for (let o = 0; o < data.length; o += 16) {
    load(fb, 0, s);
    encryptWords(k, s);
    store(s, ks, 0);
    const n = Math.min(16, data.length - o);
    for (let i = 0; i < n; i++) out[o + i] = data[o + i] ^ ks[i];
    fb.fill(0);
    fb.set((decrypt ? data : out).subarray(o, o + n));
  }
  return out;
}
