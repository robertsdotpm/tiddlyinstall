#!/bin/sh
# The review screen, rendered and read back.
#
# Why this exists. On 2026-09-22 four faults shipped or nearly shipped in
# this screen, and test_verify, test_freshness and test_prereqs passed
# through every one of them, because they check what the engine *does*
# and these are faults in what it *says*:
#
#   - "installer signed by nothing - Linux checks no signature when it
#     runs a .run file, into /path" -- a label was reworded and a
#     `case` match on the old wording stopped matching, so the one-line
#     summary fell through to a branch meant for real signers.
#   - "From: package requests, version" -- a trailing word, because the
#     version is empty whenever nothing pinned one, which is the common
#     case.
#   - "the files listed above", in a section printed above the list.
#   - a program name dropped unquoted into a sentence: "we did not write
#     test recent unsigned a and have not checked" has no program in it.
#
# Each was found by a person reading the screen. None is subtle once
# seen, and none was catchable by reading the diff. So: render it, and
# assert on the text.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail=0
say() { printf '%s\n' "$1"; }
no() { fail=1; printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; }
ok() { printf 'ok   %s\n' "$1"; }

[ -f "$here/out/ti-base.run" ] || { echo "no out/ti-base.run; run make_run.sh first" >&2; exit 1; }

# A minimal installer: a runtime-less app with one packed file, one
# command and no signature. Enough to print every section.
mkdir -p "$T/rt/pkg/bin" "$T/pack" "$T/home"
printf '#!/bin/sh\necho hi\n' > "$T/rt/pkg/bin/hello"
chmod 755 "$T/rt/pkg/bin/hello"
(cd "$T/rt" && tar -czf "$T/pack/rt.tar.gz" pkg)
rsha=$(sha256sum "$T/pack/rt.tar.gz" | cut -d' ' -f1)
rsize=$(wc -c < "$T/pack/rt.tar.gz" | tr -d ' ')

# A name with spaces, which is what made the unquoted case visible.
printf 'ti-record\t1\nname\ttest recent unsigned a\nproject\thello\nruntime\tnone\nselect\tnewest\nsource\tpackage\thello\nlaunch\t{runtime}\nconsole\t0\nmenu\t1\ndesktop\t0\nroot\tuser\nrootname\tti\n' > "$T/a.rec"
h=$(python3 "$here/append_meta.py" hash "$T/a.rec")
printf 'ti-plan\t1\nrecord\t%s\nname\ttest recent unsigned a\nproject\thello\nappid\tscreentestaa\nconsole\t0\nmenu\t1\ndesktop\t0\nroot\tuser\nrootname\tti\n\n[target]\nwhen\tlinux\t0\t9999\t*\nruntime\tnone\t1\nfile\trt\trt.tar.gz\t%s\t%s\nurl\thttps://example.invalid/rt.tar.gz\nstep\tunpack\ttar.gz\t{dir}\t1\nexe\tbin/hello\nlaunch\t"{runtime}"\n' "$h" "$rsha" "$rsize" > "$T/a.plan"
python3 "$here/append_meta.py" run "$here/out/ti-base.run" -o "$T/i.run" \
	--record "$T/a.rec" --plan "$T/a.plan" --pack "$T/pack" > /dev/null

# Answer no: the screen is printed before anything is installed.
printf 'n\n' | env -u DISPLAY -u WAYLAND_DISPLAY TI_NO_GUI=1 HOME="$T/home" \
	script -qec "sh $T/i.run --log=/dev/null" /dev/null 2>&1 | sed 's/\r$//' > "$T/out" || true

has() { grep -qF "$1" "$T/out"; }
hasnt() { ! grep -qF "$1" "$T/out"; }

# The screen rendered at all, or every check below is vacuously true.
if has 'WHAT THIS INSTALL CAN DO'; then ok 'the review screen printed'
else no 'the review screen printed' "$(head -5 "$T/out")"; fi

# The two labels, and the gloss that says which is which.
has 'Choices:' && ok 'the choices row is there' || no 'the choices row is there'
has 'Recipe:' && ok 'the recipe row is there' || no 'the recipe row is there'
has 'choices are what was picked in the web client' &&
	ok 'and the pair is explained once, under the heading' ||
	no 'and the pair is explained once, under the heading'
hasnt 'Settings:' && ok 'and nothing still says Settings' || no 'and nothing still says Settings'
hasnt 'Plan:' && ok 'and nothing still says Plan' || no 'and nothing still says Plan'

# An unsigned .run says so in one word where it is used inside a
# sentence, and at length only where it has a line of its own.
hasnt 'signed by nothing -' &&
	ok 'the one-line summary does not read "signed by nothing - Linux checks..."' ||
	no 'the one-line summary does not read "signed by nothing - Linux checks..."' "$(grep -n 'signed by nothing' "$T/out" | head -2)"
has 'unsigned, into' && ok 'it says "unsigned" there instead' || no 'it says "unsigned" there instead'

# A name with spaces has to be quoted or it dissolves into the sentence.
has 'we did' && has '"test recent unsigned a"' &&
	ok 'the program name is quoted where we disclaim it' ||
	no 'the program name is quoted where we disclaim it' "$(grep -n 'did not write' "$T/out" | head -1)"

# No label left with an empty value after it.
# Only label rows: "  Label:" with nothing after it. Lines like
# "Starting it (this is what the menu entry runs):" are headings for
# what follows and end in a colon on purpose -- the first run of this
# check flagged both of them, which is the same class of fault it is
# here to catch.
bad=$(grep -nE ', version *$|\(sha256 *\)|^  [A-Za-z][A-Za-z ]*: *$' "$T/out" || true)
if [ -n "$bad" ]; then
	no 'no label is left with nothing after it' "$(printf '%s' "$bad" | head -3)"
else ok 'no label is left with nothing after it'; fi

# The capability sentence points the right way: it is printed above the
# file list, so it cannot say the files are listed above.
hasnt 'files listed above' && ok 'the capability line does not point the wrong way' ||
	no 'the capability line does not point the wrong way'

[ "$fail" = 0 ] && say 'all passed (screen)' || { say 'FAILED (screen)'; exit 1; }
