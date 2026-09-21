// HMAC (RFC 2104) and PBKDF2 (RFC 8018) over src/web_client/lib/sha.js, for browsers
// without WebCrypto. src/web_client/lib/cryptox.js uses these only when the native ones
// are missing. Written for this project; no dependencies.
//
//   hmac(hash, key, data) -> Uint8Array
//   pbkdf2(hash, password, salt, iterations, length) -> Uint8Array
//
// hash: 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512'. key, password, salt
// and data are Uint8Arrays.
import { sha, hashName, BLOCK_LEN, HASH_LEN } from './sha.js';

function concat2(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// Returns mac(data) for a fixed key: the padded keys are made once.
export function hmacKey(hash, key) {
  const h = hashName(hash);
  const B = BLOCK_LEN[h];
  let k = key.length > B ? sha(h, key) : key;
  const ipad = new Uint8Array(B), opad = new Uint8Array(B);
  for (let i = 0; i < B; i++) {
    const x = i < k.length ? k[i] : 0;
    ipad[i] = x ^ 0x36;
    opad[i] = x ^ 0x5c;
  }
  k = null;
  return (data) => sha(h, concat2(opad, sha(h, concat2(ipad, data))));
}

export function hmac(hash, key, data) {
  return hmacKey(hash, key)(data);
}

export function pbkdf2(hash, password, salt, iterations, length) {
  const h = hashName(hash);
  const hLen = HASH_LEN[h];
  if (!(iterations >= 1)) throw new Error('PBKDF2: iterations must be at least 1');
  const mac = hmacKey(h, password);
  const out = new Uint8Array(length);
  const block = new Uint8Array(salt.length + 4);
  block.set(salt);
  for (let i = 1, o = 0; o < length; i++, o += hLen) {
    block[salt.length] = i >>> 24;
    block[salt.length + 1] = (i >>> 16) & 255;
    block[salt.length + 2] = (i >>> 8) & 255;
    block[salt.length + 3] = i & 255;
    let u = mac(block);
    const t = u.slice();
    for (let c = 1; c < iterations; c++) {
      u = mac(u);
      for (let j = 0; j < hLen; j++) t[j] ^= u[j];
    }
    out.set(t.subarray(0, Math.min(hLen, length - o)), o);
  }
  return out;
}
