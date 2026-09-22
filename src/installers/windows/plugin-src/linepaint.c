/*
 * The shape of a line of the review screen. See linepaint.h for why
 * these five rules live in a file of their own.
 */
#include "linepaint.h"

/* Is the line a heading: capitals, digits and a little punctuation. */
int ti_is_heading(const ti_wchar *l, int len)
{
  int i, letters = 0;
  if (len < 3 || l[0] < 'A' || l[0] > 'Z') return 0;
  for (i = 0; i < len; ++i) {
    ti_wchar c = l[i];
    if (c >= 'A' && c <= 'Z') { letters++; continue; }
    if (c >= '0' && c <= '9') continue;
    if (c == ' ' || c == ',' || c == '.' || c == ':' || c == '(' || c == ')' ||
        c == '/' || c == '+' || c == '-' || c == '\'') continue;
    return 0;
  }
  return letters >= 3;
}

/* An indented verdict on a line of its own: UNSIGNED, SIGNED BY
 * TIDDLYINSTALL, NO SIGNATURE... Two spaces then capitals to the end of
 * the line. Anchored at both ends on purpose: a summary row such as
 * "  PATH             Not changed" starts with capitals too and must
 * stay a row. */
int ti_is_indented_verdict(const ti_wchar *l, int len)
{
  int i, letters = 0;
  if (len < 5 || l[0] != ' ' || l[1] != ' ') return 0;
  if (l[2] < 'A' || l[2] > 'Z') return 0;
  for (i = 2; i < len; ++i) {
    ti_wchar c = l[i];
    if (c >= 'A' && c <= 'Z') { letters++; continue; }
    if (c >= '0' && c <= '9') continue;
    if (c == ' ' || c == ',' || c == '.' || c == '(' || c == ')' ||
        c == '/' || c == '+' || c == '-') continue;
    return 0;
  }
  return letters >= 4;
}

/* A sub-heading inside a section: two spaces, a few words, no colon and
 * no column gap. The gap is what separates a heading from a row:
 * "Installer signature" is a heading, "Application      requests" is
 * not, and the run of spaces is the only thing that tells them apart. */
int ti_is_subheading(const ti_wchar *l, int len, int prev_blank)
{
  int i;
  /* After a blank line, and starting with a capital. Both are there to
   * keep wrapped prose out: a sentence broken across lines can leave a
   * fragment like "out)" sitting alone, which is short, has no colon
   * and no column gap, and is not a heading. */
  if (!prev_blank) return 0;
  if (len < 5 || len > 42 || l[0] != ' ' || l[1] != ' ') return 0;
  if (!(l[2] >= 'A' && l[2] <= 'Z')) return 0;
  for (i = 2; i < len; ++i) {
    ti_wchar c = l[i];
    if (c == ' ' && i + 1 < len && l[i + 1] == ' ') return 0;   /* a column gap */
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')) continue;
    if (c == ' ' || c == '(' || c == ')' || c == '-') continue;
    return 0;
  }
  return l[len - 1] != ' ';
}

/* A rule: nothing but = or -. */
int ti_is_rule(const ti_wchar *l, int len)
{
  int i;
  if (len < 4) return 0;
  for (i = 0; i < len; ++i)
    if (l[i] != '=' && l[i] != '-') return 0;
  return 1;
}

/* `  Key: ` -> the length up to and including the colon, else 0. */
int ti_key_len(const ti_wchar *l, int len)
{
  int i = 2;
  if (len < 5 || l[0] != ' ' || l[1] != ' ') return 0;
  /* A capital, not any letter: wrapped prose can start a line with a
   * lowercase word and a colon -- "opinion: use the SHA-256 above for
   * that" -- which is a sentence, not a label. */
  if (!(l[2] >= 'A' && l[2] <= 'Z')) return 0;
  while (i < len && l[i] != ':') {
    ti_wchar c = l[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == ' ')) return 0;
    if (++i > 20) return 0;
  }
  if (i >= len || l[i] != ':') return 0;
  /* A lone letter before the colon is a drive, not a label. Windows put
   * "  All of it in C:" on the screen and this said label, so the path
   * lost its drive to the value column and read "All of it in C:" then
   * "\Users\...". Nothing on Linux has this shape, which is why it took
   * rendering the screen on Windows to see it. */
  if (l[i - 2] == ' ') return 0;
  return i + 1;
}
