#!/bin/sh
# Build the macOS base: out/TiddlyInstall.app and out/ti-base-macos.zip.
#
#   Read Me First.txt                     macos-readme.txt, beside the app
#   TiddlyInstall.app/Contents/Info.plist
#   TiddlyInstall.app/Contents/MacOS/install      = ti-engine.sh
#   TiddlyInstall.app/Contents/Resources/tiverify-{x86_64,arm64}   Ed25519 verifiers
#   TiddlyInstall.app/Contents/Resources/ti/      empty; modes B/C put record.txt,
#                                           plan.txt and pack/ here
#
# The plan signing key is baked in (plankey.sh): TI_PLAN_PUBKEY_FILE, or
# ../../build_server/data/plan-signing-key.pub.
#
# On a Mac the bundle is ad-hoc signed (codesign -s -) and zipped with
# ditto, which keeps permissions and the signature's extended attributes.
# Elsewhere it is zipped with `zip -r -y` (permissions kept, unsigned).
#
# `Read Me First.txt` sits **beside** the app, not inside it: Finder shows
# a bundle as one item, so anything under Contents/ is invisible to the
# person who just extracted the zip. Being a second top-level entry, it
# also makes Archive Utility extract into a folder rather than dropping a
# bare .app in Downloads. src/shared/builder.js renames the .app per installer
# and rewrites Contents/Resources/ti/; a top-level entry is outside both,
# so it is carried through modes A, B and C untouched.
set -eu

# Refuse a verifier this repository does not expect (SHA256SUMS).
#
# tiverify is what decides whether a plan's signature is good on this
# platform. Its recorded hashes were all wrong until 2026-09-24 -- the
# binaries were rebuilt and the table was not -- and nothing compared
# them, so "the bytes we published" was an unbacked claim about the one
# component the whole chain rests on. The known-answer test in the engine
# is not this check: a verifier backdoored to accept one extra key still
# answers the RFC 8032 vectors correctly.
ti_check_blobs() { # file...
	root=$1; shift
	sums=$root/SHA256SUMS
	[ -f "$sums" ] || { echo "no $sums to check binaries against" >&2; exit 1; }
	for f in "$@"; do
		[ -f "$root/$f" ] || { echo "$f is missing" >&2; exit 1; }
		want=$(awk -v p="$f" '$2 == p || $2 == "./" p { print $1; exit }' "$sums")
		[ -n "$want" ] || { echo "$f is not recorded in $sums" >&2; exit 1; }
		got=$(sha256sum "$root/$f" 2>/dev/null | cut -d" " -f1)
		[ "$got" = "$want" ] || { echo "$f does not match $sums ($got, expected $want)" >&2; exit 1; }
	done
}
here=$(cd "$(dirname "$0")" && pwd)
outdir=${1:-$here/out}
app=$outdir/TiddlyInstall.app
zipf=$outdir/ti-base-macos.zip
readme='Read Me First.txt'
rm -rf "$app" "$zipf" "$outdir/$readme"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/ti"
. "$here/plankey.sh"
bake_engine "$here/ti-engine.sh" "$app/Contents/MacOS/install"
chmod 755 "$app/Contents/MacOS/install"
# Our Ed25519 verifiers (verify/), picked by `uname -m`.
for a in x86_64 arm64; do
	ti_check_blobs "$here/../../.." "src/installers/unix/verify/bin/tiverify-macos-$a"
	cp "$here/verify/bin/tiverify-macos-$a" "$app/Contents/Resources/tiverify-$a"
	chmod 755 "$app/Contents/Resources/tiverify-$a"
done
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>install</string>
	<key>CFBundleIdentifier</key><string>pm.ti.installer</string>
	<key>CFBundleName</key><string>TiddlyInstall</string>
	<key>CFBundleDisplayName</key><string>TiddlyInstall</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>10.9</string>
	<key>NSHumanReadableCopyright</key><string>TiddlyInstall base installer</string>
</dict>
</plist>
PLIST
# Beside the app, never inside it. A missing readme is a build failure, not
# a zip quietly short of a file nobody would notice was gone.
[ -f "$here/macos-readme.txt" ] || { echo "make_app: $here/macos-readme.txt is missing" >&2; exit 1; }
cp "$here/macos-readme.txt" "$outdir/$readme"
chmod 644 "$outdir/$readme"
if [ "$(uname -s)" = Darwin ]; then
	codesign -s - --force "$app"
	codesign --verify --verbose "$app"
	# ditto signs nothing and takes one item, so the readme is appended
	# after it; `zip` copies the existing entries through unchanged.
	(cd "$outdir" && ditto -c -k --keepParent TiddlyInstall.app "$zipf" && zip -q "$zipf" "$readme")
else
	echo "make_app: not on macOS; the bundle is NOT signed" >&2
	(cd "$outdir" && zip -q -r -y "$zipf" TiddlyInstall.app "$readme")
fi
echo "$zipf ($(wc -c < "$zipf" | tr -d ' ') bytes)"
