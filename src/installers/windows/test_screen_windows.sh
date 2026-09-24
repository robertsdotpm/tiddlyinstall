#!/bin/sh
# The review screen this engine prints, read back as text.
#
# Why it needs a Windows machine. The screen is built by NSIS out of the
# plan, and nothing on Linux can run that. Until 2026-09-23 it had never
# been read by a test at all: every suite here checks what the engine
# *does*, and every fault found in this screen was in what it *says* --
# our own proof keys reported as things the installer could not
# describe, 500 bytes of base64 printed as the name of one of them, and
# a red WARNINGS block on the commonest installer there is. A person
# found all three.
#
#   TI_WIN=user@host src/installers/windows/test_screen_windows.sh
#
# The installer is run with /ti-review=<file>, which writes the review
# text and installs nothing. It is the same file the review page shows
# and the log keeps, so this cannot pass against text nobody sees.
#
# The assertions are ../screen-checks.sh, which test_screen_cases.sh
# runs over the other engine's screen from the same fixture.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../screen-checks.sh"
fail=0
no() { fail=1; printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; return 0; }
ok() { printf 'ok   %s\n' "$1"; }

if [ -z "${TI_WIN:-}" ]; then
	# Exit 2, not 0. Not run and passed are different facts, and a caller
	# collecting exit codes cannot tell them apart if this says 0 -- which
	# is how "every engine suite is green" came to include this one on
	# machines that never ran it.
	echo 'not run: set TI_WIN=user@host to run this (see the operator notes)'
	exit 2
fi
# These machines have logged-in console sessions and one of them is the
# operator's own screen. Nothing here takes a picture, but the rule is
# the rule and the address is easy to paste by mistake.
# Never the machine somebody is sitting in front of: a window on their
# screen, and a grab that takes whatever else is on it. Which machine
# that is lives with the other addresses (tests/vmlab.py), not here.
if python3 -c "
import sys, pathlib
sys.path.insert(0, str(pathlib.Path('$here/../../../tests').resolve()))
import vmlab
sys.exit(0 if vmlab.is_console('$TI_WIN') else 1)
" 2>/dev/null; then
	echo "that is a machine somebody is logged in to; pick another VM" >&2
	exit 1
fi
command -v node >/dev/null || { echo 'node is needed to build the fixtures' >&2; exit 1; }
[ -f "$here/out/base.exe" ] || { echo 'no out/base.exe; run build.sh first' >&2; exit 1; }

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PLAN=$here/../test-proved.plan
REC=$here/../test-proved.rec

# The same plan with pieces taken away: a page holds no signing key, so
# an installer built without a server has no `sig` line, and a catalogue
# we have not signed for leaves its targets with no proof either.
cp "$PLAN" "$T/proved.plan"
awk -F'\t' '$1 != "sig"' "$PLAN" > "$T/unsigned.plan"
awk -F'\t' '$1 != "sig" && $1 != "rtroots" && $1 != "rtproof"' "$PLAN" > "$T/bare.plan"

ssh "$TI_WIN" 'if not exist C:\titest mkdir C:\titest' > /dev/null 2>&1 || true
for case in proved unsigned bare; do
	node "$here/make_test_exe.mjs" "$here/out/base.exe" "$REC" "$T/$case.plan" "$T/ti-$case.exe"
	scp -q "$T/ti-$case.exe" "$TI_WIN:C:/titest/"
	# `del` first: a review.txt left by the run before is how a stale
	# screen gets read as a fresh one.
	ssh "$TI_WIN" "del C:\\titest\\review-$case.txt & C:\\titest\\ti-$case.exe /ti-review=C:\\titest\\review-$case.txt" > /dev/null 2>&1 || true
	if ! scp -q "$TI_WIN:C:/titest/review-$case.txt" "$T/$case.u16" 2>/dev/null; then
		no "windows/$case: the installer wrote the review text" 'no review file came back'
		continue
	fi
	# UTF-16LE with a BOM and CRLF, which is what NSIS writes.
	iconv -f UTF-16LE -t UTF-8 "$T/$case.u16" | sed -e 's/\r$//' -e '1s/^\xef\xbb\xbf//' > "$T/$case.txt"
	[ -n "${TI_SCREEN_DIR:-}" ] && cp "$T/$case.txt" "$TI_SCREEN_DIR/windows-$case.txt"
	screen_check "$T/$case.txt" "$case" windows
done
ssh "$TI_WIN" 'del C:\titest\ti-proved.exe C:\titest\ti-unsigned.exe C:\titest\ti-bare.exe C:\titest\review-*.txt' > /dev/null 2>&1 || true

[ "$fail" = 0 ] && echo 'all passed (screen, windows)' || { echo 'FAILED (screen, windows)'; exit 1; }
