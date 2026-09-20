/*
 * ibverify: Ed25519 (RFC 8032, pure) signature check for the Linux and
 * macOS engine, so plan signatures can be checked where openssl can't
 * (OpenSSL < 1.1.1 or builds whose `pkeyutl -rawin` fails, LibreSSL, no
 * openssl at all). The same TweetNaCl-based verifier as the Windows ibsig
 * plugin (../../windows/plugin-src/ed25519_verify.c, with the S < L check).
 *
 *   ibverify <public-key-base64> <signature-base64> < message
 *
 * The key is 32 bytes (44 base64 characters), the signature 64 (88).
 * Exit 0: valid. 1: not valid. 2: usage, bad base64, or a read error.
 */
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include "../../windows/plugin-src/plancheck.h"

int ed25519_verify(unsigned char *buf, unsigned long long n, const unsigned char *s, const unsigned char *pk);

int main(int argc, char **argv)
{
  unsigned char pk[32], sig[64], *buf;
  size_t cap = 65536, n = 64;
  if (argc != 3) return 2;
  if (strlen(argv[1]) != 44 || ib_b64decode((const unsigned char *)argv[1], 44, pk, 32)) return 2;
  if (strlen(argv[2]) != 88 || ib_b64decode((const unsigned char *)argv[2], 88, sig, 64)) return 2;
  /* R || room for A || message, as ed25519_verify wants it. */
  buf = malloc(cap);
  if (!buf) return 2;
  for (;;) {
    ssize_t r;
    if (n == cap) {
      unsigned char *b;
      if (cap > ((size_t)1 << 30)) return 2;
      b = realloc(buf, cap * 2);
      if (!b) return 2;
      buf = b;
      cap *= 2;
    }
    r = read(0, buf + n, cap - n);
    if (r < 0) return 2;
    if (r == 0) break;
    n += (size_t)r;
  }
  memcpy(buf, sig, 32);
  return ed25519_verify(buf, n, sig + 32, pk) ? 1 : 0;
}
