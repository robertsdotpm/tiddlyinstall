/*
 * ibsig: an NSIS plugin (x86-unicode) that checks a plan's Ed25519
 * signature (docs/format.md section 3.2). Windows XP SP3 and later: it
 * uses only kernel32 functions XP has, and no C runtime.
 *
 *   ibsig::check "<plan file>" "<public key, base64 of 32 bytes>"
 *   Pop $0    ; "ok", "unsigned: <why>", "bad: <why>" or "error: <why>"
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

void __declspec(dllexport) __cdecl check(HWND parent, int size, WCHAR *vars, stack_t **top, void *extra)
{
  WCHAR *path, key[128];
  unsigned char pk[32], kb[44];
  HANDLE h;
  DWORD n = 0, got = 0;
  unsigned char *buf;
  const char *why = "";
  int i, r;
  (void)parent; (void)vars; (void)extra;

  path = (WCHAR *)GlobalAlloc(GPTR, (size_t)size * sizeof(WCHAR));
  if (!path) return;
  if (pop(top, path, size) || pop(top, key, 128)) {
    GlobalFree(path);
    result(top, size, "error", "ibsig::check needs a file and a key");
    return;
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
  r = ib_plan_check(buf, n, pk, &why);
  GlobalFree(buf);
  result(top, size, r == IB_PLAN_OK ? "ok" : r == IB_PLAN_UNSIGNED ? "unsigned" : "bad", r == IB_PLAN_OK ? "" : why);
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved)
{
  (void)inst; (void)reason; (void)reserved;
  return TRUE;
}
