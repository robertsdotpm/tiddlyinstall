#!/bin/bash
# WebKitWebDriver (the distro's webkit2gtk-driver) with a display of its
# own: starts Xvfb on a free display (-displayfd), runs the driver there
# with the harness's arguments, and stops both when the driver exits or
# this script is killed. Xvfb, the driver and MiniBrowser are run through
# links in this folder so the harness's `pkill -f ibbrowsers/` finds them.
D=$(cd "$(dirname "$0")" && pwd)
f=$(mktemp "${TMPDIR:-/tmp}/ib-xvfb.XXXXXX")
"$D/Xvfb" -displayfd 3 -screen 0 1280x1024x24 -nolisten tcp 3>"$f" 2>/dev/null &
xp=$!
wp=
trap 'kill $wp $xp 2>/dev/null; rm -f "$f"' EXIT
trap 'exit 143' TERM INT HUP
for i in $(seq 100); do [ -s "$f" ] && break; sleep 0.1; done
[ -s "$f" ] || { echo "Xvfb did not start" >&2; exit 1; }
export DISPLAY=":$(head -1 "$f")"
rm -f "$f"
"$D/WebKitWebDriver" "$@" &
wp=$!
wait $wp
