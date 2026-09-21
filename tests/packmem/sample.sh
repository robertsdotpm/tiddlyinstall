#!/bin/sh
# Samples what a browser's whole process tree is using, from outside it.
#
#   sample.sh PATTERN OUT_FILE [INTERVAL_MS] [CHILD_PATTERN]
#
# One line per sample:
#   <epoch_ms> <sum_rss_kb> <sum_vsz_kb> <procs> <max_rss_kb> <max_vsz_kb>
#   <child_rss_kb> <child_vsz_kb> <child_procs>
# over every process whose command line matches PATTERN. The sum is what the
# machine has handed the browser as a whole (shared pages counted once per
# process, so it reads a little high); the max is the biggest single process,
# which is the renderer during a build and the number that hits a 32-bit
# address-space ceiling. VSZ is reserved address space, not memory in use.
#
# The `child_*` columns are the subset matching CHILD_PATTERN -- by default
# the content processes (Chromium's `--type=renderer`, Firefox's
# `-contentproc`), which is where a build's arrays actually live. Those are
# the cleanest numbers: the sums above them count pages shared between
# processes once per process and read a little high.
#
# Kill it with SIGTERM.
#
# Deliberately shell and ps: the oldest machines here have no Python new
# enough to be worth relying on, and psutil is not installed anywhere.
pat=${1:?pattern}
out=${2:?out file}
ms=${3:-200}
kid=${4:-type=renderer|contentproc|Web Content}
: > "$out"
trap 'exit 0' TERM INT
while :; do
  now=$(date +%s%3N 2>/dev/null) || now=$(( $(date +%s) * 1000 ))
  case "$now" in *N*) now=$(( $(date +%s) * 1000 ));; esac
  ps -eo rss=,vsz=,args= 2>/dev/null | grep -- "$pat" | grep -v 'grep' | awk -v t="$now" -v kid="$kid" '
    { rss += $1; vsz += $2; n++; if ($1 > mr) mr = $1; if ($2 > mv) mv = $2
      if ($0 ~ kid) { kr += $1; kv += $2; kn++ } }
    END { printf "%s %d %d %d %d %d %d %d %d\n", t, rss, vsz, n, mr, mv, kr, kv, kn }' >> "$out"
  # busybox sleep takes fractions on Alpine; POSIX sleep may not.
  sleep 0.$(printf '%03d' "$ms") 2>/dev/null || sleep 1
done
