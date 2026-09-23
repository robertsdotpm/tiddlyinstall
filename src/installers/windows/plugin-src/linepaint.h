#ifndef TI_LINEPAINT_H
#define TI_LINEPAINT_H

/*
 * Which shape is this line of the review screen?
 *
 * The review text is written once and painted twice: as RTF for the
 * RichEdit control on Windows (tisig.c richtext), and as ANSI for a
 * terminal on Linux (ti-engine.sh ti_paint, in awk). Two implementations
 * of one rule set drift, and they already did once silently -- the awk
 * side never had the twenty-character cap on a label that this side has
 * always had, so a wrapped sentence containing a colon was bolded as a
 * label on Linux and not on Windows.
 *
 * So the rules live here, on their own, compilable by the host cc with
 * no windows.h, and test_host.c exposes them to test_paint.sh, which
 * runs the same text through both painters and compares.
 *
 * `unsigned short`, not WCHAR: mingw's WCHAR is wchar_t is unsigned
 * short, and this file must also build for a Linux host that has no
 * idea what a WCHAR is.
 */
typedef unsigned short ti_wchar;

/* A section heading at the left margin: capitals, digits and a little
 * punctuation. "BEFORE YOU TRUST IT". */
int ti_is_heading(const ti_wchar *l, int len);

/* A verdict on a line of its own, indented and shouting: "  UNSIGNED",
 * "  SIGNED BY TIDDLYINSTALL". Anchored at both ends, so a summary row
 * such as "  PATH             Not changed" stays a row. */
int ti_is_indented_verdict(const ti_wchar *l, int len);

/* A sub-heading inside a section: indented two, a few words, no colon,
 * no column gap, and following a blank line. */
int ti_is_subheading(const ti_wchar *l, int len, int prev_blank);

/* A rule: nothing but = or -. */
int ti_is_rule(const ti_wchar *l, int len);

/* `  Key: ` -> the length up to and including the colon, else 0. */
int ti_key_len(const ti_wchar *l, int len);

#endif
