/*
 * SHA-256, for the runtime-script proofs (src/shared/merkle.js).
 *
 * The plugin already carries SHA-512, because Ed25519 needs it, but the
 * Merkle tree is SHA-256 and so is every leaf. NSIS gets SHA-256 from
 * HashInfo, which hashes *files*; a proof walk hashes a 135-byte string
 * twelve times, and writing twelve temp files to avoid 200 lines of C is
 * the wrong trade.
 *
 * FIPS 180-4. No allocation, no C runtime: this links into a DLL that
 * imports nothing but kernel32.
 */
#include "sha256.h"

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))
#define CH(x, y, z) (((x) & (y)) ^ (~(x) & (z)))
#define MAJ(x, y, z) (((x) & (y)) ^ ((x) & (z)) ^ ((y) & (z)))
#define BS0(x) (ROR(x, 2) ^ ROR(x, 13) ^ ROR(x, 22))
#define BS1(x) (ROR(x, 6) ^ ROR(x, 11) ^ ROR(x, 25))
#define SS0(x) (ROR(x, 7) ^ ROR(x, 18) ^ ((x) >> 3))
#define SS1(x) (ROR(x, 17) ^ ROR(x, 19) ^ ((x) >> 10))

static const unsigned long K[64] = {
  0x428a2f98UL,0x71374491UL,0xb5c0fbcfUL,0xe9b5dba5UL,0x3956c25bUL,0x59f111f1UL,0x923f82a4UL,0xab1c5ed5UL,
  0xd807aa98UL,0x12835b01UL,0x243185beUL,0x550c7dc3UL,0x72be5d74UL,0x80deb1feUL,0x9bdc06a7UL,0xc19bf174UL,
  0xe49b69c1UL,0xefbe4786UL,0x0fc19dc6UL,0x240ca1ccUL,0x2de92c6fUL,0x4a7484aaUL,0x5cb0a9dcUL,0x76f988daUL,
  0x983e5152UL,0xa831c66dUL,0xb00327c8UL,0xbf597fc7UL,0xc6e00bf3UL,0xd5a79147UL,0x06ca6351UL,0x14292967UL,
  0x27b70a85UL,0x2e1b2138UL,0x4d2c6dfcUL,0x53380d13UL,0x650a7354UL,0x766a0abbUL,0x81c2c92eUL,0x92722c85UL,
  0xa2bfe8a1UL,0xa81a664bUL,0xc24b8b70UL,0xc76c51a3UL,0xd192e819UL,0xd6990624UL,0xf40e3585UL,0x106aa070UL,
  0x19a4c116UL,0x1e376c08UL,0x2748774cUL,0x34b0bcb5UL,0x391c0cb3UL,0x4ed8aa4aUL,0x5b9cca4fUL,0x682e6ff3UL,
  0x748f82eeUL,0x78a5636fUL,0x84c87814UL,0x8cc70208UL,0x90befffaUL,0xa4506cebUL,0xbef9a3f7UL,0xc67178f2UL
};

static void block(unsigned long *h, const unsigned char *p)
{
  unsigned long w[64], a, b, c, d, e, f, g, hh, t1, t2;
  int i;
  for (i = 0; i < 16; i++)
    w[i] = ((unsigned long)p[i * 4] << 24) | ((unsigned long)p[i * 4 + 1] << 16) |
           ((unsigned long)p[i * 4 + 2] << 8) | (unsigned long)p[i * 4 + 3];
  for (i = 16; i < 64; i++)
    w[i] = (SS1(w[i - 2]) + w[i - 7] + SS0(w[i - 15]) + w[i - 16]) & 0xffffffffUL;
  a = h[0]; b = h[1]; c = h[2]; d = h[3]; e = h[4]; f = h[5]; g = h[6]; hh = h[7];
  for (i = 0; i < 64; i++) {
    t1 = (hh + BS1(e) + CH(e, f, g) + K[i] + w[i]) & 0xffffffffUL;
    t2 = (BS0(a) + MAJ(a, b, c)) & 0xffffffffUL;
    hh = g; g = f; f = e; e = (d + t1) & 0xffffffffUL;
    d = c; c = b; b = a; a = (t1 + t2) & 0xffffffffUL;
  }
  h[0] = (h[0] + a) & 0xffffffffUL; h[1] = (h[1] + b) & 0xffffffffUL;
  h[2] = (h[2] + c) & 0xffffffffUL; h[3] = (h[3] + d) & 0xffffffffUL;
  h[4] = (h[4] + e) & 0xffffffffUL; h[5] = (h[5] + f) & 0xffffffffUL;
  h[6] = (h[6] + g) & 0xffffffffUL; h[7] = (h[7] + hh) & 0xffffffffUL;
}

void ti_sha256(const unsigned char *msg, unsigned long len, unsigned char out[32])
{
  unsigned long h[8];
  unsigned char tail[128];
  unsigned long i, n, bits_lo, bits_hi;
  h[0] = 0x6a09e667UL; h[1] = 0xbb67ae85UL; h[2] = 0x3c6ef372UL; h[3] = 0xa54ff53aUL;
  h[4] = 0x510e527fUL; h[5] = 0x9b05688cUL; h[6] = 0x1f83d9abUL; h[7] = 0x5be0cd19UL;
  for (i = 0; i + 64 <= len; i += 64) block(h, msg + i);
  n = len - i;
  for (bits_lo = 0; bits_lo < n; bits_lo++) tail[bits_lo] = msg[i + bits_lo];
  tail[n++] = 0x80;
  while ((n % 64) != 56) tail[n++] = 0;
  bits_lo = (len << 3) & 0xffffffffUL;
  bits_hi = (len >> 29) & 0xffffffffUL;
  tail[n++] = (unsigned char)(bits_hi >> 24); tail[n++] = (unsigned char)(bits_hi >> 16);
  tail[n++] = (unsigned char)(bits_hi >> 8);  tail[n++] = (unsigned char)bits_hi;
  tail[n++] = (unsigned char)(bits_lo >> 24); tail[n++] = (unsigned char)(bits_lo >> 16);
  tail[n++] = (unsigned char)(bits_lo >> 8);  tail[n++] = (unsigned char)bits_lo;
  for (i = 0; i < n; i += 64) block(h, tail + i);
  for (i = 0; i < 8; i++) {
    out[i * 4] = (unsigned char)(h[i] >> 24); out[i * 4 + 1] = (unsigned char)(h[i] >> 16);
    out[i * 4 + 2] = (unsigned char)(h[i] >> 8); out[i * 4 + 3] = (unsigned char)h[i];
  }
}

void ti_sha256_hex(const unsigned char *msg, unsigned long len, char out[65])
{
  static const char HEX[] = "0123456789abcdef";
  unsigned char d[32];
  int i;
  ti_sha256(msg, len, d);
  for (i = 0; i < 32; i++) { out[i * 2] = HEX[d[i] >> 4]; out[i * 2 + 1] = HEX[d[i] & 15]; }
  out[64] = 0;
}
