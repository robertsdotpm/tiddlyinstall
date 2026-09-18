#!/bin/sh
# Build the macOS base: out/Install.app and out/ib-base-macos.zip.
#
#   Install.app/Contents/Info.plist
#   Install.app/Contents/MacOS/install      = ib-engine.sh
#   Install.app/Contents/Resources/ibverify-{x86_64,arm64}   Ed25519 verifiers
#   Install.app/Contents/Resources/ib/      empty; modes B/C put record.txt,
#                                           plan.txt and pack/ here
#
# The plan signing key is baked in (plankey.sh): IB_PLAN_PUBKEY_FILE, or
# ../../server/data/plan-signing-key.pub.
#
# On a Mac the bundle is ad-hoc signed (codesign -s -) and zipped with
# ditto, which keeps permissions and the signature's extended attributes.
# Elsewhere it is zipped with `zip -r -y` (permissions kept, unsigned).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
outdir=${1:-$here/out}
app=$outdir/Install.app
zipf=$outdir/ib-base-macos.zip
rm -rf "$app" "$zipf"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/ib"
. "$here/plankey.sh"
bake_engine "$here/ib-engine.sh" "$app/Contents/MacOS/install"
chmod 755 "$app/Contents/MacOS/install"
# Our Ed25519 verifiers (verify/), picked by `uname -m`.
for a in x86_64 arm64; do
	cp "$here/verify/bin/ibverify-macos-$a" "$app/Contents/Resources/ibverify-$a"
	chmod 755 "$app/Contents/Resources/ibverify-$a"
done
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>install</string>
	<key>CFBundleIdentifier</key><string>pm.ib.installer</string>
	<key>CFBundleName</key><string>Install</string>
	<key>CFBundleDisplayName</key><string>Installer Builder</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key><string>0.1</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>10.9</string>
	<key>NSHumanReadableCopyright</key><string>Installer Builder base installer</string>
</dict>
</plist>
PLIST
if [ "$(uname -s)" = Darwin ]; then
	codesign -s - --force "$app"
	codesign --verify --verbose "$app"
	(cd "$outdir" && ditto -c -k --keepParent Install.app "$zipf")
else
	echo "make_app: not on macOS; the bundle is NOT signed" >&2
	(cd "$outdir" && zip -q -r -y "$zipf" Install.app)
fi
echo "$zipf ($(wc -c < "$zipf" | tr -d ' ') bytes)"
