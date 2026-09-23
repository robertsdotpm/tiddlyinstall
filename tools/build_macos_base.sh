#!/bin/sh
# Build the macOS base on a Mac, and bring it back.
#
# make_app.sh has to run on macOS: it ad-hoc signs the .app with
# codesign and zips it with ditto, and neither has a Linux equivalent
# that produces the same bytes. So the tree goes over, the build runs
# there, and out/ti-base-macos.zip comes back.
#
#   TI_MAC=user@host tools/build_macos_base.sh
#
# The address is not written down here on purpose -- the Mac is on the
# public internet and still accepts passwords. Ask the operator, or see
# docs/local/test-vms.md.
#
# Three things the build needs are not in git, which is the whole
# reason this script exists rather than a line in a README that is
# wrong by the time anyone reads it:
#
#   - the engine from the commit being built. `git archive HEAD`, not a
#     copy of the working tree: a base built from uncommitted edits is
#     a base nobody can reproduce, and deploy.sh will compare its hash
#     against one built from HEAD.
#   - src/build_server/data/plan-signing-key.pub, which is gitignored
#     and gets baked into the base. Without it the base is built with
#     no key and Verify silently cannot check a signature.
#   - verify/bin/tiverify-macos-*, which are in git but arrive without
#     their executable bit through some paths; set it there.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
: "${TI_MAC:?set TI_MAC=user@host (the Mac that builds the base)}"
rev=$(git -C "$here" rev-parse --short HEAD)
key=$here/src/build_server/data/plan-signing-key.pub
[ -f "$key" ] || { echo "no $key; the base would carry no signing key" >&2; exit 1; }

if ! git -C "$here" diff --quiet -- src/installers/unix; then
	echo "src/installers/unix has uncommitted changes; the base is built from HEAD ($rev)" >&2
	echo "commit them first, or the base will not match what anyone else can build" >&2
	exit 1
fi

echo "building the macOS base from $rev on $TI_MAC"
git -C "$here" archive HEAD src/installers/unix |
	ssh "$TI_MAC" 'rm -rf ~/ti-build && mkdir -p ~/ti-build && tar -x -C ~/ti-build'
ssh "$TI_MAC" 'mkdir -p ~/ti-build/src/build_server/data'
scp -q "$key" "$TI_MAC:ti-build/src/build_server/data/plan-signing-key.pub"
ssh "$TI_MAC" "printf 'HEAD %s\n' '$rev' > ~/ti-build/COMMIT
	chmod +x ~/ti-build/src/installers/unix/verify/bin/tiverify-macos-*
	cd ~/ti-build/src/installers/unix && sh make_app.sh"

mkdir -p "$here/src/installers/unix/out"
scp -q "$TI_MAC:ti-build/src/installers/unix/out/ti-base-macos.zip" \
	"$here/src/installers/unix/out/ti-base-macos.zip"
echo "$rev  $(sha256sum "$here/src/installers/unix/out/ti-base-macos.zip")"

# The point of building it on a Mac: prove the signature survived the
# trip back, here, where a broken one would otherwise be found by a
# person double-clicking it.
unzip -o -q "$here/src/installers/unix/out/ti-base-macos.zip" -d "$here/src/installers/unix/out/macapp-check"
if [ -d "$here/src/installers/unix/out/macapp-check/TiddlyInstall.app" ]; then
	echo "ok    the zip contains TiddlyInstall.app"
else
	echo "FAIL  the zip has no TiddlyInstall.app in it"; exit 1
fi
rm -rf "$here/src/installers/unix/out/macapp-check"
