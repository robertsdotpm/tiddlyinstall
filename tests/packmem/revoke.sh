#!/bin/bash
# When can an object URL be revoked without truncating the download?
#
#   tests/packmem/revoke.sh SIZE_MB DELAY_MS [DOWNLOAD_DIR]
#
# Runs revoke.html in Chrome with its downloads going to DOWNLOAD_DIR (a
# deliberately slow filesystem, if the caller made one), then prints the size
# of the file that landed against the size the page said it wrote. A short
# file means the revoke beat the browser to the bytes.
#
# Chrome only: Firefox and Safari have no way to point a headless download
# anywhere the harness can watch, and the race is a Chromium implementation
# detail either way. Never on the operator's display: headless.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
MB=${1:?size in MB}
DELAY=${2:-0}
DIR=${3:-/mnt/packmemslow}
PORT=${PORT:-8099}
RUN="revoke-${MB}mb-${DELAY}ms"
RUNS="$HERE/runs"
mkdir -p "$RUNS" "$DIR"
rm -f "$DIR"/packmem-*.bin
rm -f "$RUNS/$RUN.jsonl"
curl -s "http://127.0.0.1:$PORT/reset?run=$RUN" > /dev/null

mkdir -p "$HOME/.cache/packmem"
PROFILE=$(mktemp -d "$HOME/.cache/packmem/rev-XXXXXX")
# Chrome's headless downloads follow the profile's own setting.
mkdir -p "$PROFILE/Default"
cat > "$PROFILE/Default/Preferences" <<JSON
{"download":{"default_directory":"$DIR","prompt_for_download":false,"directory_upgrade":true},
 "profile":{"default_content_setting_values":{"automatic_downloads":1}},
 "safebrowsing":{"enabled":false}}
JSON

URL="http://127.0.0.1:$PORT/revoke.html?run=$RUN&report=http://127.0.0.1:$PORT/r&mb=$MB&delay=$DELAY"
google-chrome --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$PROFILE" --disable-dev-shm-usage --safebrowsing-disable-download-protection \
  --disable-features=SafeBrowsing "$URL" > "$RUNS/$RUN.browser.log" 2>&1 &
BPID=$!

# Watch the file grow; stop when it stops changing, or after 180 s.
last=-1; same=0
for i in $(seq 1 180); do
  f=$(ls "$DIR"/packmem-*.bin 2>/dev/null | head -1)
  n=0
  [ -n "${f:-}" ] && n=$(stat -c%s "$f" 2>/dev/null || echo 0)
  part=$(ls "$DIR"/*.crdownload 2>/dev/null | head -1)
  p=0
  [ -n "${part:-}" ] && p=$(stat -c%s "$part" 2>/dev/null || echo 0)
  if [ "$n" = "$last" ] && [ "$p" = 0 ] && [ "$n" != 0 ]; then
    same=$((same + 1))
    [ $same -ge 4 ] && break
  else
    same=0
  fi
  last=$n
  sleep 1
done
sleep 2
kill $BPID 2>/dev/null; wait $BPID 2>/dev/null

want=$((MB * 1024 * 1024))
f=$(ls "$DIR"/packmem-*.bin 2>/dev/null | head -1)
got=0
[ -n "${f:-}" ] && got=$(stat -c%s "$f")
leftover=$(ls "$DIR"/*.crdownload 2>/dev/null | wc -l)
printf '%s delay=%sms want=%s got=%s %s%s\n' "$RUN" "$DELAY" "$want" "$got" \
  "$([ "$got" = "$want" ] && echo COMPLETE || echo SHORT)" \
  "$([ "$leftover" != 0 ] && echo ' (+unfinished .crdownload)' || echo '')"
rm -f "$DIR"/packmem-*.bin "$DIR"/*.crdownload
rm -rf "$PROFILE"
