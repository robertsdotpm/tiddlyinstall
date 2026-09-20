#!/bin/sh
# Build the macOS base: out/TiddlyInstall.app and out/ti-base-macos.zip.
#
#   TiddlyInstall.app/Contents/Info.plist
#   TiddlyInstall.app/Contents/MacOS/install      = ti-engine.sh
#   TiddlyInstall.app/Contents/Resources/tiverify-{x86_64,arm64}   Ed25519 verifiers
#   TiddlyInstall.app/Contents/Resources/ti/      empty; modes B/C put record.txt,
#                                           plan.txt and pack/ here
#
# The plan signing key is baked in (plankey.sh): TI_PLAN_PUBKEY_FILE, or
# ../../server/data/plan-signing-key.pub.
#
# On a Mac the bundle is ad-hoc signed (codesign -s -) and zipped with
# ditto, which keeps permissions and the signature's extended attributes.
# Elsewhere it is zipped with `zip -r -y` (permissions kept, unsigned).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
outdir=${1:-$here/out}
app=$outdir/TiddlyInstall.app
zipf=$outdir/ti-base-macos.zip
rm -rf "$app" "$zipf"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/ti"
. "$here/plankey.sh"
bake_engine "$here/ti-engine.sh" "$app/Contents/MacOS/install"
chmod 755 "$app/Contents/MacOS/install"
# Our Ed25519 verifiers (verify/), picked by `uname -m`.
for a in x86_64 arm64; do
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
if [ "$(uname -s)" = Darwin ]; then
	codesign -s - --force "$app"
	codesign --verify --verbose "$app"
	(cd "$outdir" && ditto -c -k --keepParent TiddlyInstall.app "$zipf")
else
	echo "make_app: not on macOS; the bundle is NOT signed" >&2
	(cd "$outdir" && zip -q -r -y "$zipf" TiddlyInstall.app)
fi
echo "$zipf ($(wc -c < "$zipf" | tr -d ' ') bytes)"
