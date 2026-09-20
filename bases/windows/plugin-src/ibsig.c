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

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
  (void)inst; (void)reason; (void)reserved;
  return TRUE;
}
