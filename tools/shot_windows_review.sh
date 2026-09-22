#!/bin/sh
# Render the Windows review page on Windows, and bring the pictures back.
#
#   TI_WIN=user@host tools/shot_windows_review.sh <installer.exe> [outdir]
#
# Why this exists: until 2026-09-22 the review page had never been
# rendered on Windows. Every suite checks what the engine *says* -- the
# plain summary text, which is also what goes in the log -- and none of
# them can see what tisig::richtext then makes of it. Three faults were
# sitting on that screen, and all three were invisible in the text:
# a headline that was not bold because the line had lower case in it, a
# heading with nothing under it, and a path split at its drive letter
# because "C:" looked like a label. Rendering it found all three in one
# afternoon.
#
# What it does on the machine: starts the installer in the interactive
# session through a scheduled task (an SSH session is session 0, where
# a window has no desktop to appear on), waits for the window, pages
# down through the rich edit capturing each screenful, and kills the
# process. **Nothing is installed** -- the review page is the first
# page, and it never leaves it.
#
# It captures the installer's own window rectangle, never the desktop.
# These machines have logged-in console sessions and a full-screen grab
# would take whatever else is on them; docs/test-vms.md has the rule and
# why it was written. Do not point this at 10.0.1.123, which is the
# operator's own screen.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
: "${TI_WIN:?set TI_WIN=user@host (a Windows test VM, never 10.0.1.123)}"
exe=${1:?usage: shot_windows_review.sh <installer.exe> [outdir]}
out=${2:-$here/out/win-review}
case $TI_WIN in
*10.0.1.123) echo "that is the operator's own screen; pick another VM" >&2; exit 1 ;;
esac

ps1=$here/src/installers/windows/shot_review.ps1
scp -q "$ps1" "$exe" "$TI_WIN:C:/titest/"
name=$(basename "$exe")
ssh "$TI_WIN" "schtasks /Create /TN TIShotReview /TR \"powershell -NoProfile -ExecutionPolicy Bypass -File C:\\titest\\shot_review.ps1 -Exe C:\\titest\\$name -Dir C:\\titest\\shots\" /SC ONCE /ST 23:59 /IT /F" >/dev/null
# A leftover shots/ from a previous run is how a stale screenshot gets
# reported as a fresh one: done.txt is already there, the wait returns
# at once, and the pictures are yesterday's. Ask PowerShell to remove
# it -- cmd's `rmdir` fails here with "cannot find the path specified",
# because the SSH session's working directory does not exist.
ssh "$TI_WIN" 'powershell -NoProfile -Command "Remove-Item -Recurse -Force C:\titest\shots -ErrorAction SilentlyContinue"'
ssh "$TI_WIN" 'schtasks /Run /TN TIShotReview' >/dev/null

i=0
while [ "$i" -lt 60 ]; do
	ssh "$TI_WIN" 'powershell -NoProfile -Command "Test-Path C:\titest\shots\done.txt"' 2>/dev/null |
		grep -q True && break
	i=$((i + 1))
	sleep 5
done
[ "$i" -lt 60 ] || { echo "the capture did not finish in five minutes" >&2; exit 1; }

mkdir -p "$out"
rm -f "$out"/page*.png
scp -q "$TI_WIN:C:/titest/shots/page*.png" "$out/"
ssh "$TI_WIN" 'schtasks /Delete /TN TIShotReview /F' >/dev/null 2>&1 || true
ls "$out"/page*.png
