#!/bin/bash
# One measurement run in a browser on this machine, with the sampler outside it.
#
#   tests/packmem/local.sh RUN_NAME BROWSER 'QUERY'
#
# BROWSER is `chrome` or `firefox`. Headless, on a profile of its own, and
# never on the operator's display. The sampler's output lands in
# tests/packmem/runs/RUN_NAME.rss, the page's events in RUN_NAME.jsonl.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=${1:?run name}
BROWSER=${2:-chrome}
QUERY=${3:-}
PORT=${PORT:-8099}
RUNS="$HERE/runs"
mkdir -p "$RUNS"
# Under $HOME, not /tmp: this machine's Firefox is a snap and cannot read /tmp.
mkdir -p "$HOME/.cache/packmem"
PROFILE=$(mktemp -d "$HOME/.cache/packmem/run-XXXXXX")
rm -f "$RUNS/$RUN.jsonl"
curl -s "http://127.0.0.1:$PORT/reset?run=$RUN" > /dev/null

URL="http://127.0.0.1:$PORT/${PAGE:-packmem.html}?run=$RUN&report=http://127.0.0.1:$PORT/r&$QUERY"

case "$BROWSER" in
  chrome)
    # Scoped to this run's profile: every Chrome process (browser, zygote,
    # renderers, GPU) carries --user-data-dir, and another Chrome may well
    # be running on this machine.
    PAT="$PROFILE"
    google-chrome --headless=new --disable-gpu --no-first-run --no-default-browser-check \
      --user-data-dir="$PROFILE" --disable-dev-shm-usage "$URL" > "$RUNS/$RUN.browser.log" 2>&1 &
    ;;
  firefox)
    PAT="$PROFILE"
    firefox --headless --no-remote --new-instance --profile "$PROFILE" "$URL" > "$RUNS/$RUN.browser.log" 2>&1 &
    ;;
  *) echo "unknown browser $BROWSER"; exit 2;;
esac
BPID=$!
sh "$HERE/sample.sh" "$PAT" "$RUNS/$RUN.rss" 100 &
SPID=$!
python3 "$HERE/sample-linux.py" "$PAT" "$RUNS/$RUN.pss" 120 &
SPID2=$!

# Done when the page says so, or after the timeout.
for _ in $(seq 1 "${TIMEOUT:-900}"); do
  [ "$(curl -s "http://127.0.0.1:$PORT/done?run=$RUN")" = yes ] && break
  kill -0 $BPID 2>/dev/null || { echo "browser exited"; break; }
  sleep 1
done
sleep 1
kill $SPID $SPID2 2>/dev/null
kill $BPID 2>/dev/null
wait $BPID 2>/dev/null
rm -rf "$PROFILE"
python3 "$HERE/report.py" "$RUNS/$RUN"
[ -s "$RUNS/$RUN.pss" ] && python3 "$HERE/report.py" "$RUNS/$RUN" --pss
