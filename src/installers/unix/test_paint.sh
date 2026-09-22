#!/bin/sh
# One rule set, two painters: do they still agree?
#
# The review text is written once and painted twice -- as RTF for the
# RichEdit control on Windows (plugin-src/linepaint.c, called from
# tisig.c richtext) and as ANSI for a terminal on Linux (ti_paint, in
# awk, in ti-engine.sh). Nothing makes them agree except care, and on
# 2026-09-22 they were found to have drifted silently: the awk side had
# never had the twenty-character cap on a label that the C side always
# had, so a wrapped sentence containing a colon was bolded as a label on
# Linux and left alone on Windows. Nobody noticed for as long as the
# trust section's sentences were short enough not to wrap.
#
# So: run the same text through both and compare, line by line.
#
# What is compared, and what is not. Both painters sort a line into the
# same small set of shapes -- blank, bold (a heading, an indented
# verdict, or a sub-heading), label, warning, note, body -- and that
# sorting is the shared rule set, so it must match exactly. How a shape
# is then drawn is not shared and is not compared: a RichEdit control
# can switch to a grey monospace font for indented detail and a terminal
# cannot, so each de-emphasises a different set of body lines. That
# difference is deliberate. Bolding a sentence as though it were a
# label is not.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
plug=$here/../windows/plugin-src
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail=0
no() { fail=1; printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '%s\n' "$2"; }
ok() { printf 'ok   %s\n' "$1"; }

# The C side, built with the host cc -- no mingw and no Windows needed,
# which is the whole reason the classifiers live in a file of their own.
${CC:-cc} -O2 -w -o "$T/classify" "$plug/test_host.c" "$plug/plancheck.c" \
	"$plug/ed25519_verify.c" "$plug/linepaint.c"

# The awk side, lifted out of the engine so the real function is what
# runs -- a copy here would be a third implementation to keep in step.
sed -n '/^ti_paint() {/,/^}/p' "$here/ti-engine.sh" > "$T/paint.sh"
grep -q '^ti_paint() {' "$T/paint.sh" ||
	{ echo "could not lift ti_paint out of ti-engine.sh" >&2; exit 1; }
grep -q '^}$' "$T/paint.sh" ||
	{ echo "ti_paint did not close; check the sed range" >&2; exit 1; }

# ANSI back to a shape name. The painter marks a whole line or a label's
# key, and which one it did is what the reader sees.
cat > "$T/decode.awk" <<'AWK'
BEGIN { e = sprintf("%c", 27) }
/^[ \t]*$/                { print "blank"; next }
index($0, e "[1;31m") == 1 { print "warn"; next }
index($0, e "[33m") == 1   { print "note"; next }
index($0, e "[1m") == 1 {
	r = index($0, e "[0m")
	if (r + 4 <= length($0)) { print "label"; next }
	# The bold run reaches the end of the line, which a whole-line
	# shape and a label with an empty value both do -- "Uninstaller:"
	# with the path underneath is a label the screen really uses.
	# Indented and ending in a colon is the label; the bold shapes are
	# either at the left margin or all capitals, and neither rule lets
	# a colon in.
	t = substr($0, 5, r - 5)
	print (t ~ /^  / && t ~ /:$/) ? "label" : "bold"
	next
}
{ print "body" }
AWK

# The C side names each rule; fold the three bold shapes together,
# because the terminal has one bold and cannot tell them apart.
fold() { sed -e 's/^verdict$/bold/' -e 's/^subheading$/bold/' -e 's/^heading$/bold/' \
	-e 's/^rule$/body/' -e 's/^plain$/body/'; }

compare() { # name plaintext
	sh -c ". \"$T/paint.sh\"; ti_paint" < "$2" | awk -f "$T/decode.awk" > "$T/awk.cls"
	"$T/classify" classify "$2" | fold > "$T/c.cls"
	if cmp -s "$T/awk.cls" "$T/c.cls"; then
		ok "$1 ($(wc -l < "$T/c.cls" | tr -d ' ') lines agree)"
		return
	fi
	# Say which lines, and what each painter made of them.
	d=$(paste -d'|' "$T/awk.cls" "$T/c.cls" | nl -ba |
		awk -F'|' '{ split($1, a, "\t"); if (a[2] != $2) print a[1] "\t" a[2] "\t" $2 }' |
		while IFS="$(printf '\t')" read -r n terminal windows; do
			printf '     line %s: terminal=%s windows=%s\n' "$n" "$terminal" "$windows"
			sed -n "${n}p" "$2" | sed 's/^/       /'
		done)
	no "$1" "$d"
}

# A corpus of the shapes the screen uses, and of every line that has
# ever been painted wrong. Checked in, so a rule change has to face
# them again.
compare 'the corpus of known shapes' "$here/paint-corpus.txt"

# And a real screen, in case the corpus has fallen behind the engine.
if [ -f "$here/out/ti-base.run" ]; then
	if TI_SCREEN_OUT="$T/screen.txt" sh "$here/test_screen.sh" > "$T/screen.log" 2>&1 &&
		[ -s "$T/screen.txt" ]; then
		compare 'a rendered review screen' "$T/screen.txt"
	else
		no 'a rendered review screen' "$(tail -5 "$T/screen.log")"
	fi
else
	printf 'skip a rendered review screen (no out/ti-base.run)\n'
fi

[ "$fail" = 0 ] && echo 'all passed (paint)' || { echo 'FAILED (paint)'; exit 1; }
