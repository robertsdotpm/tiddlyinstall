#!/bin/sh
# Samples Chrome's processes on an Android device or emulator, from the host.
#
#   sample-android.sh OUT_FILE [INTERVAL_MS]
#
# Columns: <epoch_ms> <sum_rss_kb> <renderer_rss_kb> <procs>. The renderer is
# Chrome's sandboxed_process0, which is where a build's arrays live. Android
# gives no VSZ worth reading and no OOM message to the page: when the limit
# is reached the whole tab (or the browser) is killed by the low-memory
# killer, so the last sample before the drop is the ceiling.
out=${1:?out file}
ms=${2:-1000}
A=${ADB:-$HOME/.local/android/platform-tools/adb}
: > "$out"
while :; do
  t=$(date +%s%3N)
  $A shell "ps -A -o RSS,NAME 2>/dev/null | grep com.android.chrome" 2>/dev/null | tr -d '\r' | awk -v t="$t" '
    { rss += $1; n++; if ($2 ~ /sandboxed_process0/) r = $1 }
    END { printf "%s %d %d %d\n", t, rss, r, n }' >> "$out"
  sleep $(echo "$ms" | awk '{printf "%.3f", $1/1000}')
done
