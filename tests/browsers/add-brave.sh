#!/bin/sh
# Put Brave on a Linux test machine and add it to that machine's
# browsers.json, so tests/browsers/run.mjs will pick it up.
#
#   tests/browsers/add-brave.sh <name>...     (names from tests/vms.json)
#   tests/browsers/add-brave.sh --all
#
# Why Brave and not "another Chromium". It ships behaviour Chrome does
# not -- its own Shields, storage partitioning, and an HTTPS-by-Default
# upgrade that stops a download from a plain-http server reaching us at
# all (docs/release.md). A real share of the people this is built for use
# it, and on 2026-09-23 it was on one machine of twenty-one: the Mac.
#
# It is installed from Brave's own apt/dnf repository, so the packages are
# signed and apt/dnf checks them. The driver is the chromedriver already
# on the machine: Brave is Chromium, and chromedriver drives any Chromium
# of its own major version. That is also how the Mac's entry works.
#
# Brave needs a glibc newer than the oldest machines have, and does not
# build for musl, so CentOS 6/7, Ubuntu 14.04/16.04 and Alpine are out.
# The script says so and skips rather than half-installing.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

names=$*
[ -n "$names" ] || { echo "usage: add-brave.sh <name>... | --all" >&2; exit 2; }
if [ "$names" = "--all" ]; then
	names=$(python3 -c "
import sys; sys.path.insert(0, '$repo/tests'); import vmlab
print(' '.join(sorted(vmlab.linux())))")
fi

for name in $names; do
	ssh=$(python3 -c "
import sys; sys.path.insert(0, '$repo/tests'); import vmlab
print(vmlab.linux().get('$name', ''))")
	if [ -z "$ssh" ]; then printf '%-14s %s\n' "$name" 'not a Linux machine in tests/vms.json'; continue; fi
	out=$(ssh -o ConnectTimeout=8 -o BatchMode=yes "$ssh" 'sh -s' <<'REMOTE' 2>&1 | tail -3 || true
set -eu
r=$HOME/tibrowsers
[ -d "$r" ] || { echo "no tibrowsers here"; exit 0; }

# Brave needs glibc 2.26 or newer, and does not build against musl.
if ! ldd --version 2>/dev/null | head -1 | grep -qi glibc; then echo "skipped: not glibc (Brave has no musl build)"; exit 0; fi
v=$(ldd --version | head -1 | sed 's/.* //')
maj=${v%%.*}; min=${v#*.}; min=${min%%.*}
if [ "$maj" -lt 2 ] || { [ "$maj" -eq 2 ] && [ "$min" -lt 26 ]; }; then echo "skipped: glibc $v is older than Brave needs (2.26)"; exit 0; fi

if ! command -v brave-browser >/dev/null 2>&1; then
	if command -v apt-get >/dev/null 2>&1; then
		sudo curl -fsSLo /usr/share/keyrings/brave-browser-archive-keyring.gpg \
			https://brave-browser-apt-release.s3.brave.com/brave-browser-archive-keyring.gpg
		echo "deb [signed-by=/usr/share/keyrings/brave-browser-archive-keyring.gpg arch=amd64] https://brave-browser-apt-release.s3.brave.com/ stable main" |
			sudo tee /etc/apt/sources.list.d/brave-browser-release.list >/dev/null
		sudo apt-get update -qq && sudo apt-get install -y -qq brave-browser
	elif command -v dnf >/dev/null 2>&1; then
		sudo dnf install -y -q dnf-plugins-core
		sudo dnf config-manager --add-repo https://brave-browser-rpm-release.s3.brave.com/brave-browser.repo
		sudo rpm --import https://brave-browser-rpm-release.s3.brave.com/brave-core.asc
		sudo dnf install -y -q brave-browser
	else
		echo "skipped: no apt-get or dnf"; exit 0
	fi
fi

bin=$(command -v brave-browser) || { echo "install failed"; exit 1; }
bv=$($bin --version 2>/dev/null | sed 's/[^0-9.]*//; s/ .*//')
major=${bv%%.*}
drv=$(ls -d "$r"/drivers/chromedriver-"$major".* 2>/dev/null | tail -1)
[ -n "$drv" ] || { echo "no chromedriver for Chromium $major here; Brave $bv installed but not added"; exit 0; }
d="$drv/chromedriver.sh"; [ -f "$d" ] || d="$drv/chromedriver"

python3 - "$r/browsers.json" "$bin" "$bv" "$d" <<'PY'
import json, sys, shutil
p, binary, ver, driver = sys.argv[1:5]
j = json.load(open(p))
bs = j.setdefault('browsers', [])
if any(b.get('id') == 'brave' for b in bs):
    print('already listed'); raise SystemExit
shutil.copy(p, p + '.bak-brave')
bs.append({
    'id': 'brave', 'name': 'Brave', 'version': ver, 'binary': binary,
    'driverKind': 'chromedriver', 'driver': driver,
    'driverVersion': driver.split('chromedriver-')[-1].split('/')[0],
    'args': ['--headless=new', '--no-sandbox'], 'headless': True,
    'source': "Brave's own signed apt/dnf repository (brave-browser-apt-release.s3.brave.com / brave-browser-rpm-release.s3.brave.com); the package manager checks the signatures",
    'driverSource': 'the chromedriver already on this machine: Brave is Chromium, and chromedriver drives any Chromium of its own major version',
    'notes': 'added by tests/browsers/add-brave.sh. Brave ships behaviour Chrome does not (Shields, storage partitioning, HTTPS-by-Default upgrades), which is why it is tested rather than treated as another Chromium.',
})
json.dump(j, open(p, 'w'), indent=1)
print('added Brave ' + ver)
PY
REMOTE
)
	printf '%-14s %s\n' "$name" "${out:-unreachable}"
done
