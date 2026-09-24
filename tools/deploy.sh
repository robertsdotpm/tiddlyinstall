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
# TI_FRESH_CATALOG=1 to rebuild the snapshot regardless, or the page will carry
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

# The catalogue snapshot is most of the build's two minutes, so it is
# cached and reused. The key is the newest file in what the snapshot is
# actually made from, so it cannot serve a stale catalogue without that
# having been touched, and touching it invalidates the cache.
#
# That used to be registry/, and the comment here said registry/ was
# "the only thing the snapshot is made from". It is not, and never was:
# tools/snapshot.mjs reads ~/projects/installer-builder-runtimes and
# nothing else. So updating the catalogue left the key unchanged and
# deploy reused a snapshot from before it -- the one thing the key
# exists to prevent (2026-09-23). registry/ is where the catalogue was
# researched; the catalogue is a different directory, outside this repo.
cache=${TI_CATALOG_CACHE:-$HOME/.cache/tiddlyinstall}
snapsrc=${TI_RUNTIMES:-$HOME/projects/installer-builder-runtimes}
# Key the cache on what the snapshot is made of, not on mtimes measured
# against one file in this repository. `-newer tools/snapshot.mjs` asks
# whether a catalogue file is newer than a script it has nothing to do
# with: today that is true of 1 file in 3,114, and a restore that
# preserves mtimes -- rsync -a, a tarball, a pulled release -- leaves
# every file "older" and silently reuses the previous catalogue.
newest=$(find "$snapsrc" -type f -printf '%s %T@ %p\n' 2>/dev/null | sort | sha256sum | cut -d' ' -f1)
newest=${newest:-0}
stamp="$cache/stamp"
opts=""
if [ "${TI_FRESH_CATALOG:-0}" != "1" ] &&
   [ -f "$cache/catalog.gz" ] && [ -f "$cache/runtimes.json" ] &&
   [ -f "$stamp" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$newest" ]; then
	opts="--catalog $cache"
	echo "reusing the cached catalogue snapshot" >&2
else
	echo "making the catalogue snapshot (the catalogue changed, or no cache)" >&2
	mkdir -p "$cache"
	if (cd "$here" && PATH="$HOME/.local/node/bin:$PATH" node tools/snapshot.mjs -o "$cache" >"$wt/snap.log" 2>&1); then
		printf '%s' "$newest" > "$stamp"
		opts="--catalog $cache"
	else
		tail -5 "$wt/snap.log" >&2
		echo "note: could not cache the snapshot; letting the build make its own." >&2
	fi
fi

# Sign the runtime install scripts whenever the catalogue has moved.
#
# This has to happen here or not at all. The leaf of every proof is the
# SHA-256 of a resolved target block, so a catalogue that moves without
# being re-signed moves every leaf: proofs stop matching, and what an
# installer then shows is "not signed" -- a silent, total loss of the
# claim, with nothing anywhere that looks broken. The signer takes about
# fifteen seconds and only runs when it must.
rtdir=$here/src/build_server/data/rtscripts
if [ -f "$cache/catalog.gz" ]; then
	if [ ! -f "$rtdir/roots.txt" ] || [ "$cache/catalog.gz" -nt "$rtdir/roots.txt" ]; then
		echo "signing the runtime install scripts (the catalogue has moved)" >&2
		if PATH="$HOME/.local/node/bin:$PATH" node "$here/tools/sign_runtime_scripts.mjs" \
			--catalog "$cache" --out "$rtdir" > "$wt/sign.log" 2>&1; then
			tail -3 "$wt/sign.log" >&2
		else
			tail -5 "$wt/sign.log" >&2
			echo "deploy: signing failed; nothing was changed." >&2
			exit 1
		fi
	else
		echo "the runtime install scripts are already signed for this catalogue" >&2
	fi
fi

# The catalogue as one file, where the server can serve it
# (GET /api/catalog/archive). A saved copy of the page refreshes its
# catalogue from that plus the attestation next to it, and checks the
# pair against the key it was built with -- so this has to be the same
# catalog.gz the signer just attested, not a fresh one.
if [ -f "$cache/catalog.gz" ]; then
	cp "$cache/catalog.gz" "$here/src/build_server/data/catalog.gz"
fi
# The page bakes the roots and leaf lists in, and a clean worktree has
# neither -- they are generated, not tracked.
if [ -d "$rtdir" ]; then
	mkdir -p "$wt/co/src/build_server/data"
	cp -r "$rtdir" "$wt/co/src/build_server/data/"
fi

# The bases must be newer than the engine they are built from.
#
# deploy.sh does not build them, and the macOS one cannot be built here at
# all: it is made on a rented Mac and copied in. So the failure that has
# to be caught is a deploy that quietly ships an engine from before the
# last change to it. The check below compares to the served copy, which
# does not help -- a stale base matches a stale base perfectly.
#
# A base is also stale when the signing key it was baked with has moved,
# so plan-key.id counts as a source.
stale=0
check_base() {
	name=$1
	out=$2
	shift 2
	if [ ! -f "$here/$out" ]; then
		echo "deploy: no $name base at $out; build it first." >&2
		stale=1
		return
	fi
	for src in "$@"; do
		[ -e "$here/$src" ] || continue
		newer=$(find "$here/$src" -newer "$here/$out" -print -quit 2>/dev/null || true)
		if [ -n "$newer" ]; then
			echo "deploy: the $name base is older than $newer." >&2
			stale=1
			return
		fi
	done
	echo "ok    $name base is newer than its engine"
}
check_base windows src/installers/windows/out/base.exe \
	src/installers/windows/base.nsi src/installers/windows/include \
	src/installers/windows/plugin-src src/installers/windows/build.sh plan-key.id
check_base linux src/installers/unix/out/ti-base.run \
	src/installers/unix/ti-engine.sh src/installers/unix/make_run.sh \
	src/installers/unix/plankey.sh plan-key.id
check_base macos src/installers/unix/out/ti-base-macos.zip \
	src/installers/unix/ti-engine.sh src/installers/unix/make_app.sh \
	src/installers/unix/plankey.sh plan-key.id
if [ "$stale" = 1 ]; then
	echo "deploy: refusing to build a page around a stale base. Rebuild it:" >&2
	echo "  windows  (cd src/installers/windows && ./build.sh)" >&2
	echo "  linux    (cd src/installers/unix && sh make_run.sh)" >&2
	echo "  macos    on the Mac: see src/installers/unix/README.md, then copy the zip back" >&2
	echo "  or set TI_ALLOW_STALE_BASE=1 if you mean it." >&2
	[ "${TI_ALLOW_STALE_BASE:-0}" = 1 ] || exit 1
	echo "deploy: TI_ALLOW_STALE_BASE=1, carrying on." >&2
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
	# The field, not the end of the line: releases.txt grew a fifth
	# column (the runtime-roots hash) and this anchor stopped matching,
	# so the branch below was dead and a redeploy of identical bytes
	# appended a duplicate row to an append-only hash-chained ledger.
	if [ -f "$ledger" ] && grep -qE "	$page_sha(	|\$)" "$ledger"; then
		echo "ok    the release ledger already has these bytes"
	else
		mkdir -p "$(dirname "$ledger")"
		seq=$(awk -F'\t' 'NF >= 4 && $1 + 0 > n { n = $1 + 0 } END { print n + 1 }' "$ledger" 2>/dev/null)
		[ -n "$seq" ] || seq=1
		rtall=
		if [ -f "$rtdir/roots.txt" ]; then
			rtall=$(awk -F'\t' '$1 == "root" { printf "%s\t%s\n", $2, $3 }' "$rtdir/roots.txt" |
				sha256sum | cut -d' ' -f1)
		fi
		printf '%s\t%s\t%s\t%s%s\n' "$seq" "$(date -u +%Y-%m-%d)" "$rev" "$page_sha" \
			"${rtall:+	$rtall}" >> "$ledger"
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
