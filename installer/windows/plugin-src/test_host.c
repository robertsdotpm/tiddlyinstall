/*
 * Host test for plancheck.c + ed25519_verify.c (built and run by build.sh
 * with the host's cc):
 *   test_host rfc8032               RFC 8032 section 7.1 vectors 1-3
 *   test_host <plan> <pubkey-b64>   prints ok / unsigned / bad and why
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "plancheck.h"

int ed25519_verify(unsigned char *buf, unsigned long long n, const unsigned char *s, const unsigned char *pk);

static void hex(const char *h, unsigned char *out)
{
  size_t i;
  for (i = 0; h[2 * i]; ++i) sscanf(h + 2 * i, "%2hhx", &out[i]);
}

static int rfc8032(void)
{
  static const char *v[][3] = {
    {"d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
     "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
    {"3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
     "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
    {"fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025", "af82",
     "6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a"},
  };
  int i, fails = 0;
  for (i = 0; i < 3; ++i) {
    unsigned char pk[32], sig[64], buf[64 + 8];
    size_t mlen = strlen(v[i][1]) / 2;
    hex(v[i][0], pk);
    hex(v[i][2], sig);
    hex(v[i][1], buf + 64);
    memcpy(buf, sig, 32);
    if (ed25519_verify(buf, 64 + mlen, sig + 32, pk)) { printf("vector %d: FAIL\n", i + 1); fails++; }
    else printf("vector %d: ok\n", i + 1);
    /* one flipped bit must fail */
    memcpy(buf, sig, 32);
    buf[5] ^= 1;
    if (!ed25519_verify(buf, 64 + mlen, sig + 32, pk)) { printf("vector %d tampered: ACCEPTED\n", i + 1); fails++; }
  }
  return fails ? 1 : 0;
}

int main(int argc, char **argv)
{
  FILE *f;
  long n;
  unsigned char *buf, pk[32];
  const char *why;
  int r;
  if (argc == 2 && !strcmp(argv[1], "rfc8032")) return rfc8032();
  if (argc != 3) { fprintf(stderr, "usage: test_host rfc8032 | test_host plan pubkey\n"); return 2; }
  if (strlen(argv[2]) != 44 || ib_b64decode((unsigned char *)argv[2], 44, pk, 32)) { printf("error: bad key\n"); return 2; }
  f = fopen(argv[1], "rb");
  if (!f) { printf("error: can't open\n"); return 2; }
  fseek(f, 0, SEEK_END);
  n = ftell(f);
  fseek(f, 0, SEEK_SET);
  buf = malloc((size_t)n + 64);
  if (fread(buf + 64, 1, (size_t)n, f) != (size_t)n) return 2;
  fclose(f);
  r = ib_plan_check(buf, (unsigned long)n, pk, &why);
  printf("%s%s%s\n", r == IB_PLAN_OK ? "ok" : r == IB_PLAN_UNSIGNED ? "unsigned" : "bad", *why ? ": " : "", why);
  return r;
}
