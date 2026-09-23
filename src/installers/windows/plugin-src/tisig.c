/*
 * tisig: an NSIS plugin (x86-unicode) that checks a plan's Ed25519
 * signature (docs/format.md "Plan signature"). Windows XP SP3 and later: it
 * uses only kernel32 functions XP has, and no C runtime.
 *
 *   tisig::check "<plan file>" "<public key, base64 of 32 bytes>"
 *   tisig::checkdoc "<file>" "<public key>" "<kind>"   (kind: ti-revocations)
 *   Pop $0    ; "ok", "unsigned: <why>", "bad: <why>" or "error: <why>"
 *
 *   tisig::cleanstr / tisig::cleanfile: below (display hygiene)
 */
#include <windows.h>
#include "plancheck.h"
#include "linepaint.h"
#include "sha256.h"
#include "rtcheck.h"

typedef struct _stack_t {
  struct _stack_t *next;
  WCHAR text[1];
} stack_t;

#define MAX_PLAN (16u * 1024u * 1024u)

/* The compiler may emit calls to these even without a C runtime. */
void *memset(void *d, int c, size_t n)
{
  unsigned char *p = d;
  while (n--) *p++ = (unsigned char)c;
  return d;
}

void *memcpy(void *d, const void *s, size_t n)
{
  unsigned char *p = d;
  const unsigned char *q = s;
  while (n--) *p++ = *q++;
  return d;
}

static int pop(stack_t **top, WCHAR *out, int size)
{
  stack_t *t = *top;
  if (!t) return -1;
  lstrcpynW(out, t->text, size);
  *top = t->next;
  GlobalFree((HGLOBAL)t);
  return 0;
}

static void push(stack_t **top, const WCHAR *s, int size)
{
  stack_t *t = (stack_t *)GlobalAlloc(GPTR, sizeof(stack_t) + (size_t)size * sizeof(WCHAR));
  if (!t) return;
  lstrcpynW(t->text, s, size);
  t->next = *top;
  *top = t;
}

/* "<tag>: <ascii why>" into a wide buffer. */
static void result(stack_t **top, int size, const char *tag, const char *why)
{
  WCHAR w[256];
  int n = 0;
  while (*tag && n < 250) w[n++] = (WCHAR)(unsigned char)*tag++;
  if (*why) {
    w[n++] = ':';
    w[n++] = ' ';
    while (*why && n < 255) w[n++] = (WCHAR)(unsigned char)*why++;
  }
  w[n] = 0;
  push(top, w, size);
}

/*
 * check and checkdoc: the same, with the header the signed bytes must
 * start with. `head` is ASCII and at most 30 characters plus the tab.
 */
static void docheck(int size, stack_t **top, const char *head, int have_kind)
{
  WCHAR *path, key[128], kind[32];
  unsigned char pk[32], kb[44];
  char headbuf[40];
  HANDLE h;
  DWORD n = 0, got = 0;
  unsigned char *buf;
  const char *why = "";
  int i, r;

  path = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  if (!path) return;
  if (pop(top, path, size) || pop(top, key, 128) || (have_kind && pop(top, kind, 32))) {
    GlobalFree(path);
    result(top, size, "error", "tisig::check needs a file and a key");
    return;
  }
  if (have_kind) {
    for (i = 0; i < 30 && kind[i]; ++i) headbuf[i] = kind[i] < 128 ? (char)kind[i] : '?';
    if (i == 0 || kind[i]) {
      GlobalFree(path);
      result(top, size, "error", "tisig::checkdoc needs a document kind");
      return;
    }
    headbuf[i++] = '\t';
    headbuf[i] = 0;
    head = headbuf;
  }
  for (i = 0; i < 44 && key[i]; ++i) kb[i] = key[i] < 128 ? (unsigned char)key[i] : '?';
  if (i != 44 || key[44] || ti_b64decode(kb, 44, pk, 32)) {
    GlobalFree(path);
    result(top, size, "error", "the installer's public key is malformed");
    return;
  }
  h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  GlobalFree(path);
  if (h == INVALID_HANDLE_VALUE) {
    result(top, size, "error", "can't open the plan");
    return;
  }
  n = GetFileSize(h, NULL);
  if (n == INVALID_FILE_SIZE || n > MAX_PLAN) {
    CloseHandle(h);
    result(top, size, "error", "the plan is too large");
    return;
  }
  buf = (unsigned char *)GlobalAlloc(GPTR, (SIZE_T)n + 64);
  if (!buf) {
    CloseHandle(h);
    result(top, size, "error", "out of memory");
    return;
  }
  if (n && (!ReadFile(h, buf + 64, n, &got, NULL) || got != n)) {
    CloseHandle(h);
    GlobalFree(buf);
    result(top, size, "error", "can't read the plan");
    return;
  }
  CloseHandle(h);
  r = ti_doc_check(buf, n, pk, head, &why);
  GlobalFree(buf);
  result(top, size, r == TI_PLAN_OK ? "ok" : r == TI_PLAN_UNSIGNED ? "unsigned" : "bad", r == TI_PLAN_OK ? "" : why);
}

void __declspec(dllexport) __cdecl check(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  (void)parent; (void)vars; (void)extra;
  docheck(size, top, "ti-plan\t", 0);
}

/*
 *   tisig::checkdoc "<file>" "<public key>" "<kind>"   ("ti-revocations")
 */
void __declspec(dllexport) __cdecl checkdoc(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  (void)parent; (void)vars; (void)extra;
  docheck(size, top, "", 1);
}

/* ---------------------------------------------------------------- rtverify
 *
 *   tisig::rtverify "<plan file>" "<public key>" "<target index>"
 *   Pop $0    ; "ok", "none: <why>" or "bad: <why>"
 *   Pop $1    ; when the roots document was published, or ""
 *
 * The deciding is in rtcheck.c, which has no windows.h in it and is
 * tested on Linux by test_host (plugin-src/build.sh). This is the file
 * reading and the stack plumbing, which is all that has to be Windows.
 *
 * In C rather than NSIS for two reasons. The roots document is about
 * 1,560 characters of base64 and an NSIS string is 1,024, so a script
 * reading that line would truncate it and never know it had. And a
 * proof walk is twelve SHA-256s of a short string, which NSIS can only
 * do by writing twelve temporary files.
 */
void __declspec(dllexport) __cdecl rtverify(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  WCHAR *path, key[128], idxs[32], w[80];
  unsigned char pk[32], kb[44];
  HANDLE h;
  DWORD n = 0, got = 0;
  unsigned char *buf;
  const char *why = "";
  char issued[64];
  long idx = 0;
  int i, r;

  (void)parent; (void)vars; (void)extra;
  issued[0] = 0;
  path = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  if (!path) return;
  if (pop(top, path, size) || pop(top, key, 128) || pop(top, idxs, 32)) {
    GlobalFree(path);
    push(top, L"", 1);
    result(top, size, "none", "tisig::rtverify needs a plan, a key and a target index");
    return;
  }
  for (i = 0; idxs[i] >= '0' && idxs[i] <= '9'; i++) idx = idx * 10 + (idxs[i] - '0');
  for (i = 0; i < 44 && key[i]; ++i) kb[i] = key[i] < 128 ? (unsigned char)key[i] : '?';
  if (i != 44 || key[44] || ti_b64decode(kb, 44, pk, 32) || idx < 1) {
    GlobalFree(path);
    push(top, L"", 1);
    result(top, size, "none", "this installer carries no usable key");
    return;
  }
  h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  GlobalFree(path);
  if (h == INVALID_HANDLE_VALUE) { push(top, L"", 1); result(top, size, "none", "the plan could not be opened"); return; }
  n = GetFileSize(h, NULL);
  if (n == INVALID_FILE_SIZE || n > MAX_PLAN) { CloseHandle(h); push(top, L"", 1); result(top, size, "none", "the plan is too large"); return; }
  buf = (unsigned char *)GlobalAlloc(GPTR, (SIZE_T)n + 1);
  if (!buf) { CloseHandle(h); push(top, L"", 1); result(top, size, "none", "out of memory"); return; }
  if (n && (!ReadFile(h, buf, n, &got, NULL) || got != n)) {
    CloseHandle(h); GlobalFree(buf); push(top, L"", 1);
    result(top, size, "none", "the plan could not be read"); return;
  }
  CloseHandle(h);
  r = ti_rt_check(buf, n, pk, idx, issued, &why);
  GlobalFree(buf);
  for (i = 0; i < 63 && issued[i]; i++) w[i] = (WCHAR)(unsigned char)issued[i];
  w[i] = 0;
  push(top, w, i + 1);
  result(top, size, r == TI_RT_OK ? "ok" : r == TI_RT_NONE ? "none" : "bad", r == TI_RT_OK ? "" : why);
}

/*
 * Characters that must not reach the transparency screen or a dialog:
 * C0 controls other than tab, CR and LF, DEL, C1 controls, and the bidi
 * controls that reorder text (U+200E/F, U+202A-202E, U+2066-2069).
 */
static int unsafe(WCHAR c)
{
  if (c < 0x20) return c != '\t' && c != '\r' && c != '\n';
  if (c == 0x7F || (c >= 0x80 && c <= 0x9F)) return 1;
  if (c == 0x200E || c == 0x200F) return 1;
  if (c >= 0x202A && c <= 0x202E) return 1;
  if (c >= 0x2066 && c <= 0x2069) return 1;
  return 0;
}

/*
 *   tisig::cleanstr "<text>"   Pop $0: the text with unsafe characters as '?'
 *   (tab, CR and LF become spaces too: the result is one line)
 */
void __declspec(dllexport) __cdecl cleanstr(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  WCHAR *s;
  int i;
  (void)parent; (void)vars; (void)extra;
  s = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  if (!s) return;
  if (pop(top, s, size)) s[0] = 0;
  for (i = 0; s[i]; ++i) {
    if (s[i] == '\t' || s[i] == '\r' || s[i] == '\n') s[i] = ' ';
    else if (unsafe(s[i])) s[i] = '?';
  }
  push(top, s, size);
  GlobalFree(s);
}

/*
 *   tisig::cleanfile "<UTF-16LE file>"   rewrites it in place, unsafe
 *   characters as '?'. Pop $0: "ok" or "error: <why>".
 */
void __declspec(dllexport) __cdecl cleanfile(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  WCHAR *path, *w;
  HANDLE h;
  DWORD n, got = 0, put = 0, i;
  unsigned char *buf;
  (void)parent; (void)vars; (void)extra;
  path = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  if (!path) return;
  if (pop(top, path, size)) {
    GlobalFree(path);
    result(top, size, "error", "tisig::cleanfile needs a file");
    return;
  }
  h = CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  GlobalFree(path);
  if (h == INVALID_HANDLE_VALUE) {
    result(top, size, "error", "can't open the file");
    return;
  }
  n = GetFileSize(h, NULL);
  if (n == INVALID_FILE_SIZE || n > 4 * MAX_PLAN) {
    CloseHandle(h);
    result(top, size, "error", "the file is too large");
    return;
  }
  buf = (unsigned char *)GlobalAlloc(GPTR, (SIZE_T)n + 2);
  if (!buf) {
    CloseHandle(h);
    result(top, size, "error", "out of memory");
    return;
  }
  if (n && (!ReadFile(h, buf, n, &got, NULL) || got != n)) {
    CloseHandle(h);
    GlobalFree(buf);
    result(top, size, "error", "can't read the file");
    return;
  }
  w = (WCHAR *)buf;
  for (i = 0; i < n / 2; ++i)
    if (unsafe(w[i])) w[i] = '?';
  if (SetFilePointer(h, 0, NULL, FILE_BEGIN) != 0 || (n && (!WriteFile(h, buf, n, &put, NULL) || put != n))) {
    CloseHandle(h);
    GlobalFree(buf);
    result(top, size, "error", "can't write the file");
    return;
  }
  CloseHandle(h);
  GlobalFree(buf);
  result(top, size, "ok", "");
}

/*
 * ---------------------------------------------------------------- richtext
 *
 *   tisig::richtext "<hwnd, decimal>" "<UTF-16LE text file>"
 *   Pop $0    ; "ok" or "error: <why>"
 *
 * The review page's text (design.md section 3) is the same on every
 * platform: one plain-text file, written by the engine, which is also
 * what goes in the log. Windows shows it in a rich edit control, so the
 * headings, the warnings and the hashes can be told apart at a glance.
 * Rather than have NSIS build RTF -- which would mean escaping every
 * backslash and brace in a record someone else wrote -- the plain text
 * is marked up here, by the same rules the Linux and macOS engine paints
 * a terminal with (ti_paint in src/installers/unix/ti-engine.sh):
 *
 *   `!! ...`               bold red      something you would want to know
 *   `!  ...`               amber         worth noticing
 *   A HEADING IN CAPITALS  bold          a section
 *   `  Key: value`         bold key      the short summary's rows
 *   indented four or more  monospace     hashes, URLs, paths, commands
 *   ==== or ----           grey          a rule
 *
 * The text has already been through cleanfile, so it carries no control
 * characters; everything that is left is escaped for RTF here.
 */

#define EM_SETTEXTEX_MSG (WM_USER + 97)

typedef struct {
  DWORD flags;
  UINT codepage;
} ti_settextex;

typedef struct {
  char *p;
  DWORD n;
  DWORD cap;
} ti_buf;

static void bput(ti_buf *b, char c)
{
  if (b->n < b->cap) b->p[b->n++] = c;
}

static void bstr(ti_buf *b, const char *s)
{
  while (*s) bput(b, *s++);
}

static void bnum(ti_buf *b, unsigned v)
{
  char t[12];
  int i = 0;
  if (!v) { bput(b, '0'); return; }
  while (v && i < 11) { t[i++] = (char)('0' + v % 10); v /= 10; }
  while (i) bput(b, t[--i]);
}

/* One character of the text, escaped for RTF. */
static void brtf(ti_buf *b, WCHAR c)
{
  if (c == '\\' || c == '{' || c == '}') { bput(b, '\\'); bput(b, (char)c); }
  else if (c == '\t') bstr(b, "\\tab ");
  else if (c < 0x80) bput(b, (char)c);
  else {
    /* \uN? with a signed 16-bit N, and '?' for a reader that cannot show it */
    long v = (long)c;
    if (v > 32767) v -= 65536;
    bstr(b, "\\u");
    if (v < 0) { bput(b, '-'); bnum(b, (unsigned)(-v)); } else bnum(b, (unsigned)v);
    bstr(b, "?");
  }
}

static int indent_of(const WCHAR *l, int len)
{
  int i = 0;
  while (i < len && l[i] == ' ') i++;
  return i;
}

void __declspec(dllexport) __cdecl richtext(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  int prev_blank;
  WCHAR *arg, *path, *w;
  HANDLE h;
  HWND ctl;
  DWORD n, got = 0, i, start;
  unsigned char *raw;
  ti_buf b;
  ti_settextex st;
  LRESULT r;
  int mono_section = 0, short_section = 0;
  (void)parent; (void)vars; (void)extra;

  arg = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  path = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  if (!arg || !path) {
    if (arg) GlobalFree(arg);
    if (path) GlobalFree(path);
    return;
  }
  if (pop(top, arg, size) || pop(top, path, size)) {
    GlobalFree(arg); GlobalFree(path);
    result(top, size, "error", "tisig::richtext needs a window and a file");
    return;
  }
  {
    unsigned long v = 0;
    const WCHAR *q = arg;
    while (*q == ' ') q++;
    while (*q >= '0' && *q <= '9') v = v * 10 + (unsigned long)(*q++ - '0');
    ctl = (HWND)(ULONG_PTR)v;
  }
  GlobalFree(arg);
  if (!ctl || !IsWindow(ctl)) {
    GlobalFree(path);
    result(top, size, "error", "not a window");
    return;
  }
  h = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
  GlobalFree(path);
  if (h == INVALID_HANDLE_VALUE) {
    result(top, size, "error", "can't open the file");
    return;
  }
  n = GetFileSize(h, NULL);
  if (n == INVALID_FILE_SIZE || n > MAX_PLAN) {
    CloseHandle(h);
    result(top, size, "error", "the file is too large");
    return;
  }
  raw = (unsigned char *)GlobalAlloc(GPTR, (SIZE_T)n + 2);
  if (!raw) {
    CloseHandle(h);
    result(top, size, "error", "out of memory");
    return;
  }
  if (n && (!ReadFile(h, raw, n, &got, NULL) || got != n)) {
    CloseHandle(h);
    GlobalFree(raw);
    result(top, size, "error", "can't read the file");
    return;
  }
  CloseHandle(h);

  w = (WCHAR *)raw;
  n = got / 2;
  if (n && w[0] == 0xFEFF) { w++; n--; }             /* the BOM the engine writes */

  b.cap = got * 6 + 4096;
  b.n = 0;
  b.p = (char *)GlobalAlloc(GPTR, b.cap + 1);
  if (!b.p) {
    GlobalFree(raw);
    result(top, size, "error", "out of memory");
    return;
  }

  /* Tahoma and Courier New: both are on every Windows from XP on.
   * Colours: 1 text, 2 warning, 3 note, 4 the quiet detail. */
  bstr(&b, "{\\rtf1\\ansi\\ansicpg1252\\deff0"
           "{\\fonttbl{\\f0\\fswiss Tahoma;}{\\f1\\fmodern Courier New;}}"
           "{\\colortbl;\\red0\\green0\\blue0;\\red168\\green0\\blue0;"
           "\\red128\\green80\\blue0;\\red90\\green90\\blue90;}"
           "\\viewkind4\\pard\\f0\\fs17\\cf1 ");

  start = 0;
  prev_blank = 1;                      /* the first line follows nothing */
  for (i = 0; i <= n; ++i) {
    int len, ind, kl, was_blank;
    const WCHAR *l;
    int j;
    if (i < n && w[i] != '\n') continue;
    l = w + start;
    len = (int)(i - start);
    if (len && l[len - 1] == '\r') len--;
    start = i + 1;
    /* Read and updated here, before any branch below can continue out
     * of the loop and skip it. */
    was_blank = prev_blank;
    prev_blank = (len == 0);

    if (ti_is_indented_verdict(l, len) || ti_is_subheading(l, len, was_blank)) {
      bstr(&b, "\\pard\\sb100\\sa20\\b ");
      for (j = 0; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\b0\\par\n");
      continue;
    }
    if (ti_is_heading(l, len)) {
      mono_section = 0;
      short_section = (len == 8 && l[0] == 'I' && l[1] == 'N' && l[2] == ' ' && l[3] == 'S');
      for (j = 0; j + 4 <= len; ++j) {
        if (l[j] == 'R' && l[j + 1] == 'U' && l[j + 2] == 'N' && l[j + 3] == 'S') mono_section = 1;
        if (l[j] == 'G' && l[j + 1] == 'O') mono_section = 1;
      }
      bstr(&b, "\\pard\\sb160\\sa40\\b\\fs19 ");
      for (j = 0; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\b0\\fs17\\par\n");
      continue;
    }
    if (ti_is_rule(l, len)) {
      bstr(&b, "\\pard\\cf4 ");
      for (j = 0; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\cf1\\par\n");
      continue;
    }
    if (len >= 3 && l[0] == '!' && l[1] == '!' && l[2] == ' ') {
      bstr(&b, "\\pard\\cf2\\b ");
      for (j = 0; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\b0\\cf1\\par\n");
      continue;
    }
    if (len >= 3 && l[0] == '!' && l[1] == ' ' && l[2] == ' ') {
      bstr(&b, "\\pard\\cf3 ");
      for (j = 0; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\cf1\\par\n");
      continue;
    }
    ind = indent_of(l, len);
    /* A wrapped value in the short summary is prose, and lines up under
     * the value column rather than becoming another hash-looking line. */
    if (short_section && ind >= 10 && len > ind) {
      bstr(&b, "\\pard\\li1500\\fi0 ");
      for (j = ind; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\par\n");
      continue;
    }
    if (ind >= 4 || (mono_section && len > 0)) {
      bstr(&b, "\\pard\\f1\\fs16\\cf4 ");
      for (j = 0; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\cf1\\f0\\fs17\\par\n");
      continue;
    }
    kl = ti_key_len(l, len);
    if (kl) {
      /* A proportional font cannot be lined up with spaces, so the run
       * of padding after the colon becomes a tab to a fixed stop. */
      int v = kl;
      while (v < len && l[v] == ' ') v++;
      bstr(&b, "\\pard\\tx1500\\li1500\\fi-1500\\b ");
      for (j = 0; j < kl; ++j) brtf(&b, l[j]);
      bstr(&b, "\\b0\\tab ");
      for (j = v; j < len; ++j) brtf(&b, l[j]);
      bstr(&b, "\\par\n");
      continue;
    }
    bstr(&b, "\\pard ");
    for (j = 0; j < len; ++j) brtf(&b, l[j]);
    bstr(&b, "\\par\n");
  }
  bstr(&b, "}");
  b.p[b.n < b.cap ? b.n : b.cap] = 0;

  st.flags = 0;               /* ST_DEFAULT */
  st.codepage = 1252;         /* not 1200: that is what makes it read RTF */
  r = SendMessageA(ctl, EM_SETTEXTEX_MSG, (WPARAM)&st, (LPARAM)b.p);
  GlobalFree(b.p);
  GlobalFree(raw);
  if (r == 0) {
    result(top, size, "error", "the control would not take the text");
    return;
  }
  result(top, size, "ok", "");
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
  (void)inst; (void)reason; (void)reserved;
  return TRUE;
}
