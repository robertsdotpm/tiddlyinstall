/*
 * The runtime-script check, with no windows.h in it so the host cc can
 * build it and test_host can run it on real plans (plugin-src/build.sh).
 * tisig.c does the file reading and the NSIS stack; this decides.
 */
#include "rtcheck.h"
#include "plancheck.h"
#include "sha256.h"

/* One tab-separated field of a line, or NULL. `line` points at the
 * start of a line in the plan; `end` is the end of the file. */
static const char *field(const char *line, const char *end, int n, unsigned long *len)
{
  const char *p = line;
  int at = 0;
  const char *start = p;
  while (p < end && *p != '\n') {
    if (*p == '\t') {
      if (at == n) { *len = (unsigned long)(p - start); return start; }
      at++;
      start = p + 1;
    }
    p++;
  }
  if (at == n) {
    const char *e = p;
    if (e > start && e[-1] == '\r') e--;
    *len = (unsigned long)(e - start);
    return start;
  }
  return 0;
}

static int line_is(const char *line, const char *end, const char *key)
{
  unsigned long n = 0, i;
  const char *f = field(line, end, 0, &n);
  if (!f) return 0;
  for (i = 0; key[i]; i++) if (i >= n || f[i] != key[i]) return 0;
  return key[i] == 0 && n == i;
}

static const char *next_line(const char *p, const char *end)
{
  while (p < end && *p != '\n') p++;
  return p < end ? p + 1 : end;
}

/* The start of the Nth [target] block (1-based), or NULL. */
static const char *target_at(const char *p, const char *end, long want)
{
  long n = 0;
  while (p < end) {
    if (line_is(p, end, "[target]")) {
      n++;
      if (n == want) return next_line(p, end);
    }
    p = next_line(p, end);
  }
  return 0;
}

static int skip_line(const char *line, const char *end)
{
  return line_is(line, end, "launch") || line_is(line, end, "rtproof") ||
         line_is(line, end, "rtroots") || line_is(line, end, "rtsig") ||
         line_is(line, end, "sig");
}

static int hexeq(const char *a, const char *b, int n)
{
  int i;
  for (i = 0; i < n; i++) if (a[i] != b[i]) return 0;
  return 1;
}


int ti_rt_check(const unsigned char *plan_bytes, unsigned long n,
                const unsigned char pk[32], long idx,
                char issued[64], const char **why)
{
  const char *plan = (const char *)plan_bytes, *end = plan + n;
  const char *p, *rt = 0, *tgt, *proof = 0;
  unsigned long rtlen = 0, dlen = 0, i;
  static unsigned char doc[64 + 65536];
  static unsigned char canon[1 << 16];
  char leaf[65], cur[65], want[65];
  unsigned long cl = 0;
  int r, malformed = 0;

  *why = "";
  issued[0] = 0;
  want[0] = 0;

  p = plan;
  while (p < end) {
    if (line_is(p, end, "[target]")) break;
    if (line_is(p, end, "rtroots")) { rt = field(p, end, 1, &rtlen); break; }
    p = next_line(p, end);
  }
  if (!rt || !rtlen) { *why = "this plan carries no runtime-script roots"; return TI_RT_NONE; }
  if (rtlen > 65000) { *why = "the roots document is too large"; return TI_RT_NONE; }

  dlen = (rtlen / 4) * 3;
  while (rtlen && rt[rtlen - 1] == '=') { dlen--; rtlen--; }
  if (ti_b64decode((const unsigned char *)rt, (rtlen + 3) & ~3UL, doc + 64, dlen)) {
    *why = "the roots document could not be decoded";
    return TI_RT_BAD;
  }
  r = ti_doc_check(doc, dlen, pk, "ti-rtscripts\t", why);
  if (r != TI_PLAN_OK) return r == TI_PLAN_UNSIGNED ? TI_RT_NONE : TI_RT_BAD;

  {
    const char *d = (const char *)doc + 64, *de = d + dlen, *q, *f, *rtname = 0;
    unsigned long fl = 0, rl = 0;
    for (q = d; q < de; q = next_line(q, de)) {
      if (line_is(q, de, "issued")) {
        f = field(q, de, 1, &fl);
        if (f) { for (i = 0; i < fl && i < 63; i++) issued[i] = f[i]; issued[i] = 0; }
        break;
      }
    }
    for (q = plan; q < end && !line_is(q, end, "[target]"); q = next_line(q, end)) {
      if (line_is(q, end, "runtime")) { rtname = field(q, end, 1, &rl); break; }
    }
    if (!rtname) { *why = "the plan names no runtime"; return TI_RT_NONE; }
    for (q = d; q < de; q = next_line(q, de)) {
      if (!line_is(q, de, "root")) continue;
      {
        const char *nm = field(q, de, 1, &fl);
        if (nm && fl == rl && hexeq(nm, rtname, (int)rl)) {
          const char *v = field(q, de, 2, &fl);
          if (v && fl == 64) { for (i = 0; i < 64; i++) want[i] = v[i]; want[64] = 0; }
          break;
        }
      }
    }
  }
  if (!want[0]) { *why = "the roots document names no root for this runtime"; return TI_RT_NONE; }

  tgt = target_at(plan, end, idx);
  if (!tgt) { *why = "the plan has no such target"; return TI_RT_NONE; }
  {
    const char *q = tgt;
    while (q < end && !line_is(q, end, "[target]")) {
      const char *e = q, *ce;
      while (e < end && *e != '\n') e++;
      ce = e;
      if (ce > q && ce[-1] == '\r') ce--;
      if (ce > q && !skip_line(q, end)) {
        if (cl + (unsigned long)(ce - q) + 1 >= sizeof canon) { *why = "the target block is too large"; return TI_RT_NONE; }
        for (i = 0; i < (unsigned long)(ce - q); i++) canon[cl++] = (unsigned char)q[i];
        canon[cl++] = '\n';
      }
      q = e < end ? e + 1 : end;
    }
  }
  ti_sha256_hex(canon, cl, leaf);
  for (i = 0; i < 65; i++) cur[i] = leaf[i];

  for (p = tgt; p < end && !line_is(p, end, "[target]"); p = next_line(p, end)) {
    if (line_is(p, end, "rtproof")) { proof = p; break; }
  }
  if (!proof) { *why = "this target carries no proof"; return TI_RT_NONE; }
  {
    int step;
    for (step = 1; ; step++) {
      unsigned long fl = 0;
      const char *f = field(proof, end, step, &fl);
      unsigned char pair[8 + 128];
      unsigned long k = 0;
      if (!f || fl == 0) break;
      if (fl == 1 && f[0] == '-') continue;
      if (fl != 65 || (f[0] != 'L' && f[0] != 'R')) { malformed = 1; break; }
      pair[k++] = 't'; pair[k++] = 'i'; pair[k++] = '-'; pair[k++] = 'n';
      pair[k++] = 'o'; pair[k++] = 'd'; pair[k++] = 'e'; pair[k++] = '\n';
      if (f[0] == 'R') {
        for (i = 0; i < 64; i++) pair[k++] = (unsigned char)cur[i];
        for (i = 0; i < 64; i++) pair[k++] = (unsigned char)f[1 + i];
      } else {
        for (i = 0; i < 64; i++) pair[k++] = (unsigned char)f[1 + i];
        for (i = 0; i < 64; i++) pair[k++] = (unsigned char)cur[i];
      }
      ti_sha256_hex(pair, k, cur);
    }
  }
  if (malformed) { *why = "the proof in this plan is malformed"; return TI_RT_BAD; }
  if (!hexeq(cur, want, 64)) { *why = "the proof does not lead to the signed root"; return TI_RT_BAD; }
  return TI_RT_OK;
}
