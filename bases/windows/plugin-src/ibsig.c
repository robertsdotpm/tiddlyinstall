/*
 * ibsig: an NSIS plugin (x86-unicode) that checks a plan's Ed25519
 * signature (docs/format.md "Plan signature"). Windows XP SP3 and later: it
 * uses only kernel32 functions XP has, and no C runtime.
 *
 *   ibsig::check "<plan file>" "<public key, base64 of 32 bytes>"
 *   ibsig::checkdoc "<file>" "<public key>" "<kind>"   (kind: ib-revocations)
 *   Pop $0    ; "ok", "unsigned: <why>", "bad: <why>" or "error: <why>"
 *
 *   ibsig::cleanstr / ibsig::cleanfile: below (display hygiene)
 */
#include <windows.h>
#include "plancheck.h"

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
    result(top, size, "error", "ibsig::check needs a file and a key");
    return;
  }
  if (have_kind) {
    for (i = 0; i < 30 && kind[i]; ++i) headbuf[i] = kind[i] < 128 ? (char)kind[i] : '?';
    if (i == 0 || kind[i]) {
      GlobalFree(path);
      result(top, size, "error", "ibsig::checkdoc needs a document kind");
      return;
    }
    headbuf[i++] = '\t';
    headbuf[i] = 0;
    head = headbuf;
  }
  for (i = 0; i < 44 && key[i]; ++i) kb[i] = key[i] < 128 ? (unsigned char)key[i] : '?';
  if (i != 44 || key[44] || ib_b64decode(kb, 44, pk, 32)) {
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
  r = ib_doc_check(buf, n, pk, head, &why);
  GlobalFree(buf);
  result(top, size, r == IB_PLAN_OK ? "ok" : r == IB_PLAN_UNSIGNED ? "unsigned" : "bad", r == IB_PLAN_OK ? "" : why);
}

void __declspec(dllexport) __cdecl check(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  (void)parent; (void)vars; (void)extra;
  docheck(size, top, "ib-plan\t", 0);
}

/*
 *   ibsig::checkdoc "<file>" "<public key>" "<kind>"   ("ib-revocations")
 */
void __declspec(dllexport) __cdecl checkdoc(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  (void)parent; (void)vars; (void)extra;
  docheck(size, top, "", 1);
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
 *   ibsig::cleanstr "<text>"   Pop $0: the text with unsafe characters as '?'
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
 *   ibsig::cleanfile "<UTF-16LE file>"   rewrites it in place, unsafe
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
    result(top, size, "error", "ibsig::cleanfile needs a file");
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
 *   ibsig::richtext "<hwnd, decimal>" "<UTF-16LE text file>"
 *   Pop $0    ; "ok" or "error: <why>"
 *
 * The review page's text (design.md section 3) is the same on every
 * platform: one plain-text file, written by the engine, which is also
 * what goes in the log. Windows shows it in a rich edit control, so the
 * headings, the warnings and the hashes can be told apart at a glance.
 * Rather than have NSIS build RTF -- which would mean escaping every
 * backslash and brace in a record someone else wrote -- the plain text
 * is marked up here, by the same rules the Linux and macOS engine paints
 * a terminal with (ib_paint in bases/unix/ib-engine.sh):
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
} ib_settextex;

typedef struct {
  char *p;
  DWORD n;
  DWORD cap;
} ib_buf;

static void bput(ib_buf *b, char c)
{
  if (b->n < b->cap) b->p[b->n++] = c;
}

static void bstr(ib_buf *b, const char *s)
{
  while (*s) bput(b, *s++);
}

static void bnum(ib_buf *b, unsigned v)
{
  char t[12];
  int i = 0;
  if (!v) { bput(b, '0'); return; }
  while (v && i < 11) { t[i++] = (char)('0' + v % 10); v /= 10; }
  while (i) bput(b, t[--i]);
}

/* One character of the text, escaped for RTF. */
static void brtf(ib_buf *b, WCHAR c)
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

/* Is the line a heading: capitals, digits and a little punctuation. */
static int is_heading(const WCHAR *l, int len)
{
  int i, letters = 0;
  if (len < 3 || l[0] < 'A' || l[0] > 'Z') return 0;
  for (i = 0; i < len; ++i) {
    WCHAR c = l[i];
    if (c >= 'A' && c <= 'Z') { letters++; continue; }
    if (c >= '0' && c <= '9') continue;
    if (c == ' ' || c == ',' || c == '.' || c == ':' || c == '(' || c == ')' ||
        c == '/' || c == '+' || c == '-' || c == '\'') continue;
    return 0;
  }
  return letters >= 3;
}

/* A rule: nothing but = or -. */
static int is_rule(const WCHAR *l, int len)
{
  int i;
  if (len < 4) return 0;
  for (i = 0; i < len; ++i)
    if (l[i] != '=' && l[i] != '-') return 0;
  return 1;
}

/* `  Key: ` -> the length up to and including the colon, else 0. */
static int key_len(const WCHAR *l, int len)
{
  int i = 2;
  if (len < 5 || l[0] != ' ' || l[1] != ' ') return 0;
  if (!((l[2] >= 'A' && l[2] <= 'Z') || (l[2] >= 'a' && l[2] <= 'z'))) return 0;
  while (i < len && l[i] != ':') {
    WCHAR c = l[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == ' ')) return 0;
    if (++i > 20) return 0;
  }
  return (i < len && l[i] == ':') ? i + 1 : 0;
}

static int indent_of(const WCHAR *l, int len)
{
  int i = 0;
  while (i < len && l[i] == ' ') i++;
  return i;
}

void __declspec(dllexport) __cdecl richtext(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  WCHAR *arg, *path, *w;
  HANDLE h;
  HWND ctl;
  DWORD n, got = 0, i, start;
  unsigned char *raw;
  ib_buf b;
  ib_settextex st;
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
    result(top, size, "error", "ibsig::richtext needs a window and a file");
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
  for (i = 0; i <= n; ++i) {
    int len, ind, kl;
    const WCHAR *l;
    int j;
    if (i < n && w[i] != '\n') continue;
    l = w + start;
    len = (int)(i - start);
    if (len && l[len - 1] == '\r') len--;
    start = i + 1;

    if (is_heading(l, len)) {
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
    if (is_rule(l, len)) {
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
    if (len >= 3 && l[0] == '!' && l[1] == ' ') {
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
    kl = key_len(l, len);
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
