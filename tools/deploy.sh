#!/bin/sh
# Build the one-file site from committed code and serve it, then prove it.
#
#   tools/deploy.sh [--no-restart]
#
# The invariant this exists to keep: **the page the build server serves was
# built from the commit the repository is on, with the bases that are in the
# tree.** It has been broken three times by hand, each time silently, and each
# time someone tested a stale build and reported a bug that was already fixed.
# So the check is the point of the script, not the build.
#
# Whoever lands the last change runs this. It takes about fifteen seconds
# because the catalogue snapshot is reused (docs/format.md section 6); pass
# TI_FRESH_CATALOG=1 after changing registry/, or the page will carry
# yesterday's catalogue.
#
# Always builds from a clean worktree of HEAD, never from the working tree:
# several agents share this checkout, and an out/ built from someone's
# half-finished edit is how unreviewed code reaches the server.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
cd "$here"
restart=1
[ "${1:-}" = "--no-restart" ] && restart=0

rev=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- ':!prompts' 2>/dev/null)" ]; then
	echo "note: the working tree is dirty; building HEAD ($rev) and ignoring it." >&2
fi

cat=${TI_CATALOG_DIR:-$HOME/projects/installer-builder-runtimes/catalog}
# The clean checkout goes in $wt/co, not $wt/src: the repository has a
# src/ of its own since 2026-09-22, and $wt/src/src/... read as a mistake.
wt=$(mktemp -d "${TMPDIR:-/tmp}/ti-deploy.XXXXXX")
trap 'git worktree remove "$wt/co" --force >/dev/null 2>&1 || true; rm -rf "$wt"' EXIT

git worktree add -q --detach "$wt/co" HEAD
# The bases and the ES5 toolchain are build outputs, not tracked files.
for p in src/installers/windows/out src/installers/unix/out tools/es5/node_modules; do
	[ -e "$here/$p" ] && ln -sfn "$here/$p" "$wt/co/$p"
done

# The catalogue snapshot is most of the build's two minutes and changes only
# when registry/ does, so it is cached and reused. The cache is keyed
# on the newest file in registry/, which is the only thing the
# snapshot is made from -- so it cannot serve a stale catalogue without the
# metadata having been touched, and touching the metadata invalidates it.
cache=${TI_CATALOG_CACHE:-$HOME/.cache/tiddlyinstall}
newest=$(find "$here/registry" -type f -newer "$here/tools/snapshot.mjs" -printf '%T@\n' 2>/dev/null |
	sort -rn | head -1)
newest=${newest:-0}
stamp="$cache/stamp"
opts=""
if [ "${TI_FRESH_CATALOG:-0}" != "1" ] &&
   [ -f "$cache/catalog.gz" ] && [ -f "$cache/runtimes.json" ] &&
   [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$newest" ]; then
	opts="--catalog $cache"
	echo "reusing the cached catalogue snapshot" >&2
else
	echo "making the catalogue snapshot (registry/ changed, or no cache)" >&2
	mkdir -p "$cache"
	if (cd "$here" && PATH="$HOME/.local/node/bin:$PATH" node tools/snapshot.mjs -o "$cache" >"$wt/snap.log" 2>&1); then
		printf '%s' "$newest" > "$stamp"
		opts="--catalog $cache"
	else
		tail -5 "$wt/snap.log" >&2
		echo "note: could not cache the snapshot; letting the build make its own." >&2
	fi
fi

# shellcheck disable=SC2086
(cd "$wt/co" && python3 tools/build_site.py $opts -o "$wt/co/out" >"$wt/build.log" 2>&1) || {
	tail -20 "$wt/build.log" >&2
	echo "deploy: the build failed; nothing was changed." >&2
	exit 1
}

cp -r "$wt/co/out/." "$here/out/"
[ "$restart" = 1 ] && systemctl --user restart ti-server && sleep 3

# ---- the checks, which are why this script exists ----
fail=0
url=${TI_SERVE_URL:-http://127.0.0.1:8080}

served=$(curl -fsS "$url/" 2>/dev/null | grep -o 'Built from [0-9a-f]*' | head -1 | awk '{print $3}' || true)
if [ "$served" = "$rev" ]; then
	echo "ok    served page is $rev, which is HEAD"
else
	echo "FAIL  served page says '${served:-nothing}', HEAD is $rev"
	fail=1
fi

# The bases the server hands out must be the ones in the tree: a page built
# with a stale base ships an old engine to everyone who downloads from it.
for b in windows:src/installers/windows/out/base.exe \
         linux:src/installers/unix/out/ti-base.run \
         macos:src/installers/unix/out/ti-base-macos.zip; do
	name=${b%%:*}
	path=${b#*:}
	[ -f "$here/$path" ] || continue
	local_sum=$(sha256sum "$here/$path" | cut -c1-16)
	served_sum=$(curl -fsS "$url/bases/$name" 2>/dev/null | sha256sum | cut -c1-16)
	if [ "$local_sum" = "$served_sum" ]; then
		echo "ok    base $name matches ($local_sum)"
	else
		echo "FAIL  base $name: serving $served_sum, built $local_sum"
		fail=1
	fi
done

if [ "$fail" != 0 ]; then
	echo "deploy: the server is NOT serving what this tree holds. Do not tell anyone to test it." >&2
	exit 1
fi
echo "deployed $rev"
