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
# The plan signing public key lives in the server's data folder, which is
# gitignored, so a clean worktree of HEAD has no key and the page is built
# without one -- which is how 81c3435 shipped a Verify page that could not
# check a single signature. The key is public (it is already inside every
# base in the page); this makes it reachable from the checkout.
if [ -f "$here/src/build_server/data/plan-signing-key.pub" ]; then
	mkdir -p "$wt/co/src/build_server/data"
	cp "$here/src/build_server/data/plan-signing-key.pub" "$wt/co/src/build_server/data/"
fi

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

url=${TI_SERVE_URL:-http://127.0.0.1:8080}
cp -r "$wt/co/out/." "$here/out/"
if [ "$restart" = 1 ]; then
	systemctl --user restart ti-server
	# Wait for it, rather than guessing. A flat `sleep 3` reported every
	# check as failed on 2026-09-22 because that start took four
	# seconds: "serving e3b0c442..." is the SHA-256 of nothing, which is
	# what curl returns from a socket that is not listening yet. A
	# deploy script whose job is proving what is served must not cry
	# wolf about a server that is merely still starting.
	i=0
	while [ "$i" -lt 30 ]; do
		curl -fsS -o /dev/null "$url/api/health" 2>/dev/null && break
		i=$((i + 1))
		sleep 1
	done
fi

# ---- the checks, which are why this script exists ----
fail=0

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

# One line of the release ledger, appended only once the page served has
# been proved to be HEAD's (src/shared/ledger.js). A page cannot carry
# its own hash, so this entry is written after the page exists and the
# page carries the root from *before* it -- the same reason a
# transparency log's tree head never covers the entry being added.
#
# Appended, never rewritten: the whole value of the chain is that an
# older copy of the page holds a root that a rewrite would contradict.
if [ "$fail" = 0 ] && [ -f "$here/out/index.html" ]; then
	ledger=$here/src/build_server/data/releases.txt
	page_sha=$(sha256sum "$here/out/index.html" | cut -d' ' -f1)
	if [ -f "$ledger" ] && grep -q "	$page_sha\$" "$ledger"; then
		echo "ok    the release ledger already has these bytes"
	else
		mkdir -p "$(dirname "$ledger")"
		seq=$(awk -F'\t' 'NF >= 4 && $1 + 0 > n { n = $1 + 0 } END { print n + 1 }' "$ledger" 2>/dev/null)
		[ -n "$seq" ] || seq=1
		printf '%s\t%s\t%s\t%s\n' "$seq" "$(date -u +%Y-%m-%d)" "$rev" "$page_sha" >> "$ledger"
		echo "ok    release $seq added to the ledger ($(echo "$page_sha" | cut -c1-16))"
	fi
fi

# The page must carry the plan signing key, or Verify silently cannot
# check anything and says so in wording nobody reads as a failure.
if curl -fsS "$url/" 2>/dev/null | grep -q 'id="ti-plan-pubkey"'; then
	echo "ok    the page carries the plan signing key"
else
	echo "FAIL  the page has no plan signing key; Verify cannot check a signature"
	fail=1
fi

if [ "$fail" != 0 ]; then
	echo "deploy: the server is NOT serving what this tree holds. Do not tell anyone to test it." >&2
	exit 1
fi
echo "deployed $rev"
