#!/bin/sh
# The review screen, rendered by this engine and read back, in the three
# states that decide what it is allowed to claim. The assertions are in
# ../screen-checks.sh, which test_screen_windows.sh runs over the other
# engine's screen from the same fixture: one plan, two engines, one set
# of checks, so the two cannot drift in what they say.
#
# test_screen.sh is the other half and stays: it covers what only this
# engine has (the GUI fallback, the one-line summary above the prompt,
# the prerequisites block) and a plan with no proof at all.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
. "$here/../screen-checks.sh"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail=0
no() { fail=1; printf 'FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '     %s\n' "$2"; return 0; }
ok() { printf 'ok   %s\n' "$1"; }

[ -f "$here/out/ti-base.run" ] || { echo "no out/ti-base.run; run make_run.sh first" >&2; exit 1; }
PLAN=$here/../test-proved.plan
REC=$here/../test-proved.rec
[ -f "$PLAN" ] || { echo "no $PLAN" >&2; exit 1; }

# The same plan with pieces taken away, which is how an installer built
# in a page differs from one the server signed: the page holds no key,
# so there is no `sig` line, and a catalogue we have not signed for
# leaves the target with no proof either.
awk -F'\t' '$1 != "sig"' "$PLAN" > "$T/unsigned.plan"
awk -F'\t' '$1 != "sig" && $1 != "rtroots" && $1 != "rtproof"' "$PLAN" > "$T/bare.plan"
cp "$PLAN" "$T/proved.plan"

for case in proved unsigned bare; do
	mkdir -p "$T/home-$case"
	python3 "$here/append_meta.py" run "$here/out/ti-base.run" -o "$T/$case.run" \
		--record "$REC" --plan "$T/$case.plan" > /dev/null
	# NO_COLOR because `script` gives the engine a pty and an escape
	# landing inside a phrase breaks every grep below.
	printf 'n\n' | env -u DISPLAY -u WAYLAND_DISPLAY TI_NO_GUI=1 NO_COLOR=1 HOME="$T/home-$case" \
		script -qec "sh $T/$case.run --log=/dev/null" /dev/null 2>&1 | sed 's/\r$//' > "$T/$case.raw" || true
	# The screen only. What follows it is the one-line summary above the
	# prompt, which repeats a `!!` on purpose and is test_screen.sh's.
	sed -n '/^TiddlyInstall - Review before installing/,/^Ready to install/p' "$T/$case.raw" > "$T/$case.txt"
	if [ ! -s "$T/$case.txt" ]; then
		no "linux/$case: the screen printed at all" "$(head -5 "$T/$case.raw")"
		continue
	fi
	[ -n "${TI_SCREEN_DIR:-}" ] && cp "$T/$case.txt" "$TI_SCREEN_DIR/linux-$case.txt"
	screen_check "$T/$case.txt" "$case" linux
done

[ "$fail" = 0 ] && echo 'all passed (screen cases)' || { echo 'FAILED (screen cases)'; exit 1; }
