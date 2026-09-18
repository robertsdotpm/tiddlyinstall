/*
 * Checks a signed ib-plan (docs/format.md "Plan signature"). Portable C, no
 * libc: used by the ibsig NSIS plugin and by the host test.
 *
 * The last line of a signed plan is
 *     sig<TAB>ed25519<TAB><88 characters of base64>
 * optionally followed by "\n" or "\r\n", and nothing else. The signature
 * covers every byte before that line; those bytes must start with
 * "ib-plan<TAB>".
 */
#include "plancheck.h"

typedef unsigned char u8;
typedef unsigned long long u64;

int ed25519_verify(u8 *buf, u64 n, const u8 *s, const u8 *pk);

static int b64val(u8 c)
{
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

/* Strict standard base64 of exactly `outlen` bytes (with '=' padding). */
int ib_b64decode(const u8 *in, unsigned long inlen, u8 *out, unsigned long outlen)
{
  unsigned long i, o = 0, want = (outlen + 2) / 3 * 4;
  if (inlen != want) return -1;
  for (i = 0; i < inlen; i += 4) {
    int v[4], k, pad = 0;
    for (k = 0; k < 4; ++k) {
      if (in[i + k] == '=' && i + 4 == inlen && k >= 2) { v[k] = 0; ++pad; continue; }
      if (pad) return -1;                 /* data after '=' */
      v[k] = b64val(in[i + k]);
      if (v[k] < 0) return -1;
    }
    {
      unsigned long x = ((unsigned long)v[0] << 18) | ((unsigned long)v[1] << 12) | ((unsigned long)v[2] << 6) | (unsigned long)v[3];
      u8 b[3];
      b[0] = (u8)(x >> 16); b[1] = (u8)(x >> 8); b[2] = (u8)x;
      for (k = 0; k < 3 - pad; ++k) {
        if (o >= outlen) return -1;
        out[o++] = b[k];
      }
      /* The unused bits of the last character must be zero (canonical). */
      if (pad == 1 && b[2] != 0) return -1;
      if (pad == 2 && (b[1] != 0 || b[2] != 0)) return -1;
    }
  }
  return o == outlen ? 0 : -1;
}

static int starts(const u8 *p, unsigned long n, const char *s)
{
  unsigned long i;
  for (i = 0; s[i]; ++i)
    if (i >= n || p[i] != (u8)s[i]) return 0;
  return 1;
}

int ib_plan_check(u8 *buf, unsigned long len, const u8 pk[32], const char **why)
{
  u8 *doc = buf + 64;
  unsigned long end = len, nl, lastlen, i;
  const u8 *last;
  u8 sig[64];
  static const char prefix[] = "sig\ted25519\t";

  *why = "";
  if (end > 0 && doc[end - 1] == '\n') {
    --end;
    if (end > 0 && doc[end - 1] == '\r') --end;
  }
  nl = end;
  while (nl > 0 && doc[nl - 1] != '\n') --nl;
  if (nl == 0) { *why = "no signature line"; return IB_PLAN_UNSIGNED; }
  last = doc + nl;
  lastlen = end - nl;
  if (!(lastlen == 3 && starts(last, 3, "sig")) && !starts(last, lastlen, "sig\t")) {
    *why = "no signature line";
    return IB_PLAN_UNSIGNED;
  }
  if (!starts(last, lastlen, prefix)) { *why = "unknown signature type"; return IB_PLAN_BAD; }
  if (ib_b64decode(last + sizeof(prefix) - 1, lastlen - (sizeof(prefix) - 1), sig, 64)) {
    *why = "malformed signature";
    return IB_PLAN_BAD;
  }
  if (!starts(doc, nl, "ib-plan\t")) { *why = "the signed bytes are not an ib-plan"; return IB_PLAN_BAD; }
  /* Lay out R || (room for A) || message: the message is already at buf+64. */
  for (i = 0; i < 32; ++i) buf[i] = sig[i];
  if (ed25519_verify(buf, (u64)nl + 64, sig + 32, pk)) {
    *why = "the signature does not match this plan and key";
    return IB_PLAN_BAD;
  }
  return IB_PLAN_OK;
}
