#!/bin/sh
# Stale plans (design.md 7.1, format.md sections 3 and 7), against the
# real Linux engine:
#
#   the nonce       a fetched plan that echoes the nonce installs; one
#                   that echoes another is refused; one that echoes none
#                   installs and says the backend is an older one
#   the list        a carried plan whose record, source or a file it
#                   downloads is revoked is refused; a list that says
#                   nothing lets it through; an unsigned or wrongly
#                   signed list is ignored; the last good list is used
#                   when the backend can't be reached
#   expiry          a carried plan older than the hard limit is refused,
#                   one past `maxage` warns and installs, and **a base
#                   whose build time is in the future -- a machine whose
#                   clock can't be believed -- refuses nothing**
#   old and new     a plan with the new fields installs on a base built
#                   without them, and a plan without them installs here
#
#   sh test_freshness.sh [SHELL]
#   TI_TEST_KEEP=1 keeps the work folder.
#   TI_OLD_ENGINE_FILE=PATH uses that copy of the old engine instead of
#   reading it out of git, for a machine with no checkout.
#
# Needs Node.js (tools/plansig.mjs; $NODE, else node on PATH, else
# ~/.local/node/bin/node) and python3 (a local HTTP backend: it serves
# files and ignores the query string, which is what lets a pre-signed
# answer stand in for one the server made for this nonce).
#
# It runs on macOS as well as Linux: `date`, `sha256sum` and the git
# checkout are the three things that differ, and each has a fallback.
set -u
here=$(cd "$(dirname "$0")" && pwd)
node=${NODE:-$(command -v node || echo "$HOME/.local/node/bin/node")}
plansig() { "$node" "$here/../../../tools/plansig.mjs" "$@"; }
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# The engine as it was before stale-plan handling (design.md 7.1). It
# comes from git; TI_OLD_ENGINE_FILE names a copy of it instead, for a
# machine with no checkout (the Mac).
#
# Every hash below was re-pinned on 2026-09-22, after the history was
# rewritten to purge prompts/ and every commit changed hash. A pin that
# does not resolve fails loudly (the `bad` below), which is how this one
# was noticed; do the same if the history is ever rewritten again.
#
# The pin must sit before 25d13cd (stale plans in the engines,
# 2026-09-20 17:05) or the case tests nothing, and every such commit is
# also before the ib -> ti rename (fecccb4, 2026-09-21 00:25): the two
# windows do not overlap, so there is no post-rename commit to move the
# pin to. That is why the old engine gets its own copies of the record
# and the plan in the old spelling (prepare and sign_all, "old_magic")
# rather than the pin being moved forward. Only the first token of each
# file differs, so the cases still test one thing: a plan carrying
# `signed`, `maxage` and a nonce, read by an engine built before any of
# them existed.
OLD_REV=${TI_OLD_ENGINE_REV:-c886007}
NONCE=0123456789abcdef0123456789abcdef
OTHER=fedcba9876543210fedcba9876543210
DAY=86400

# RFC 3339 from an epoch. GNU date and BSD date spell this differently,
# and this runs on macOS too, where only the second form exists.
at() { date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ; }
# Days-old RFC 3339, for `signed`.
ago() { at $(($(date -u +%s) - $1 * DAY)); }
# macOS has shasum, not sha256sum.
sha256_of() {
	if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
	else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# On macOS the cases run the **.app**, not the .run, and that is not a
# convenience: the engine finds its Ed25519 verifier either after the
# .run's script (TI_VERIFY_BLOBS, Linux binaries only) or in
# `<app>/Contents/Resources/tiverify-<arch>`. A .run on a Mac therefore
# has no verifier that runs, falls back to `openssl pkeyutl`, and macOS
# ships LibreSSL 3.3.6, which cannot check Ed25519 -- so every plan is
# refused before any of this is reached. The .app is also what macOS
# actually ships. `make_app.sh` must run here for the same reason the
# base must be built here: only a Mac has `codesign` and `ditto`.
MACOS=0
[ "$(uname -s)" = Darwin ] && MACOS=1
# Build base $1 ($D/$1.run, or $D/$1.app), with $2 as SOURCE_DATE_EPOCH
# if it is given: both honour it, which is how the base whose clock
# cannot be believed is made.
build_base() { # name [SOURCE_DATE_EPOCH]
	(
		[ -n "${2:-}" ] && { SOURCE_DATE_EPOCH=$2; export SOURCE_DATE_EPOCH; }
		TI_PLAN_PUBKEY_FILE=$D/key/plan-signing-key.pub
		export TI_PLAN_PUBKEY_FILE
		if [ "$MACOS" = 1 ]; then
			rm -rf "$D/mk-$1" "$D/$1.app"
			mkdir -p "$D/mk-$1"
			sh "$here/make_app.sh" "$D/mk-$1" > /dev/null || exit 1
			mv "$D/mk-$1/TiddlyInstall.app" "$D/$1.app" || exit 1
			rm -rf "$D/mk-$1"
		else
			sh "$here/make_run.sh" "$D/$1.run" > /dev/null || exit 1
		fi
	) || exit 1
}
# What to run for base $1.
eng() {
	if [ "$MACOS" = 1 ]; then printf '%s' "$D/$1.app/Contents/MacOS/install"
	else printf '%s' "$D/$1.run"; fi
}
# A copy of base $1 named so that mode A finds the record hash in it.
name_as() { # base name-stem
	if [ "$MACOS" = 1 ]; then rm -rf "$D/$2.app"; cp -R "$D/$1.app" "$D/$2.app"
	else cp "$D/$1.run" "$D/$2.run"; fi
}
# Where the engine keeps the revocation list it cached.
cache_file() {
	if [ "$MACOS" = 1 ]; then printf '%s' "$1/Library/Caches/TiddlyInstall/revocations.txt"
	else printf '%s' "$1/.cache/tiddlyinstall/revocations.txt"; fi
}

prepare() {
	D=$1
	mkdir -p "$D/key" "$D/rt/pkg/bin" "$D/srv/api/plan" "$D/srv/api/records" "$D/srv/api" "$D/srv/f"
	plansig -data "$D/key" sign /dev/null > /dev/null 2>&1
	[ -f "$D/key/plan-signing-key.pub" ] || { echo "could not make a key"; exit 1; }
	build_base base
	# A second base whose build time is ten years from now: to it, this
	# machine's clock looks impossible, which is the case that must never
	# refuse an install.
	build_base future $(($(date -u +%s) + 10 * 365 * DAY))
	# ...and the engine as it was before any of this, to check that an
	# installer already in the wild copes with a plan carrying the new
	# fields. A pinned commit, not HEAD: once this change is committed,
	# HEAD is the new engine and the case would test nothing.
	old_engine=""
	got_old=""
	if [ -n "${TI_OLD_ENGINE_FILE:-}" ]; then
		cp "$TI_OLD_ENGINE_FILE" "$D/old-engine.raw" && got_old=1
	elif git -C "$here/../../.." show "$OLD_REV:src/installers/unix/ti-engine.sh" > "$D/old-engine.raw" 2>/dev/null; then
		got_old=1
	# Between the two reorganisations it was installer/unix/ (2026-09-20
	# 23:21 to 2026-09-22), and before the first it was bases/unix/.
	# $OLD_REV is deliberately a commit from before both, so the oldest
	# path is the one that answers today. All of them are tried so that
	# neither moving the pin forward nor leaving it where it is silently
	# skips these cases.
	elif git -C "$here/../../.." show "$OLD_REV:installer/unix/ti-engine.sh" > "$D/old-engine.raw" 2>/dev/null; then
		got_old=1
	elif git -C "$here/../../.." show "$OLD_REV:bases/unix/ti-engine.sh" > "$D/old-engine.raw" 2>/dev/null; then
		got_old=1
	# ...and before the rename it was bases/unix/ib-engine.sh. All three
	# spellings are tried because the pin has to sit *before* stale-plan
	# handling (25d13cd, 2026-09-20 17:05) and there is no commit after
	# the ib -> ti rename (fecccb4, 2026-09-21 00:25) that also predates
	# it: the two windows do not overlap, so the pin is necessarily an
	# old-spelling engine and will stay one. Missing it is a failure
	# below, not a note.
	elif git -C "$here/../../.." show "$OLD_REV:bases/unix/ib-engine.sh" > "$D/old-engine.raw" 2>/dev/null; then
		got_old=1
	fi
	if [ -n "$got_old" ]; then
		key=$(tr -d ' \r\n' < "$D/key/plan-signing-key.pub")
		keyid=$(printf '%s' "$key" | openssl base64 -d -A | openssl dgst -sha256 | awk '{ print substr($NF, 1, 16) }')
		# Both spellings of the baked lines: before the rename they were
		# IB_PLAN_PUBKEY / IB_PLAN_KEYID. Filling neither leaves the old
		# engine with no key, which refuses every plan -- a "failure"
		# that would say nothing about what these cases are for.
		sed -e "s|^TI_PLAN_PUBKEY=\$|TI_PLAN_PUBKEY=$key|" -e "s|^TI_PLAN_KEYID=\$|TI_PLAN_KEYID=$keyid|" \
			-e "s|^IB_PLAN_PUBKEY=\$|IB_PLAN_PUBKEY=$key|" -e "s|^IB_PLAN_KEYID=\$|IB_PLAN_KEYID=$keyid|" \
			"$D/old-engine.raw" > "$D/old-engine.sh"
		grep -q '^\(TI\|IB\)_PLAN_PUBKEY=.\+' "$D/old-engine.sh" ||
			bad "old engine: no TI_/IB_PLAN_PUBKEY line was filled in; it would refuse every plan"
		# Which spelling of the format it reads. The pin is a pre-rename
		# engine today and may not be forever, so this follows the file
		# rather than the date.
		old_magic=ti
		grep -q 'ib-record' "$D/old-engine.raw" && old_magic=ib
		chmod 755 "$D/old-engine.sh"
		old_engine=$D/old-engine.sh
		if [ "$MACOS" = 1 ]; then
			# The old engine needs a bundle around it too, for the same
			# reason as the bases: the verifier lives in Resources.
			name_as base old
			cp "$D/old-engine.sh" "$D/old.app/Contents/MacOS/install"
			chmod 755 "$D/old.app/Contents/MacOS/install"
			old_engine=$D/old.app/Contents/MacOS/install
		fi
	else
		# Not a note. These two cases went quiet for a day because the
		# fallback path was never updated past the rename, and a skip
		# that reads like a limitation is indistinguishable from a
		# clean pass. If the old engine cannot be got, the suite fails
		# and says what to do about it.
		bad "old engine: no $OLD_REV:{src/installers,installer}/unix/ti-engine.sh and no $OLD_REV:bases/unix/{ti,ib}-engine.sh in git, and no TI_OLD_ENGINE_FILE; the old-engine cases cannot run. Set TI_OLD_ENGINE_REV to a commit before 25d13cd, or TI_OLD_ENGINE_FILE to a copy of that engine."
	fi
	printf '#!/bin/sh\necho hello\n' > "$D/rt/pkg/bin/hello"
	chmod 755 "$D/rt/pkg/bin/hello"
	(cd "$D/rt" && tar -cf - pkg | gzip -c > "$D/srv/f/rt.tar.gz")
	sha=$(sha256_of "$D/srv/f/rt.tar.gz")
	echo "$sha" > "$D/rtsha"
	size=$(wc -c < "$D/srv/f/rt.tar.gz" | tr -d ' ')
	printf 'ti-record\t1\nname\tFresh\nproject\thello\nruntime\tnone\nselect\tnewest\nsource\tgithub\tOwner/Repo\tabc\nlaunch\t{runtime}\nconsole\t1\nmenu\t0\ndesktop\t0\nroot\tuser\nrootname\tti\n' > "$D/record.txt"
	h=$(python3 "$here/append_meta.py" hash "$D/record.txt")
	echo "$h" > "$D/hash"
	cp "$D/record.txt" "$D/srv/api/records/$h"
	# The target block has to name the OS this is running on, or the
	# engine stops at "nothing for this machine" before any of the
	# freshness work is reached.
	when_os=linux
	[ "$MACOS" = 1 ] && when_os=macos
	# The old engine's own copy of the record, in whichever spelling it
	# reads (old_magic, set above). Everything but the first token is
	# the same bytes, so its cases still test "a plan with the new
	# fields on an engine built before them" and nothing else. Its hash
	# differs from $h because the bytes do, so it is served separately.
	old_magic=${old_magic:-ti}
	sed "1s/^ti-record/$old_magic-record/" "$D/record.txt" > "$D/old-record.txt"
	oldh=$(python3 "$here/append_meta.py" hash "$D/old-record.txt")
	echo "$oldh" > "$D/oldhash"
	cp "$D/old-record.txt" "$D/srv/api/records/$oldh"
	# $1 the header lines to add, $2 the request lines to add.
	# $plan_magic and $plan_rec pick the spelling and the record hash,
	# so the same plan can be written for either engine.
	plan_magic=ti-plan
	plan_rec=$h
	plan() {
		printf '%s\t1\n%srecord\t%s\nname\tFresh\nproject\thello\nappid\tfreshtestaaa\nconsole\t1\nmenu\t0\ndesktop\t0\nroot\tuser\nrootname\tti\n%s\n[target]\nwhen\t%s\t0\t9999\t*\nruntime\tnone\t1\nfile\trt\trt.tar.gz\t%s\t%s\nurl\t@BACKEND@/f/rt.tar.gz\nstep\tunpack\ttar.gz\t{dir}\t1\nexe\tbin/hello\nlaunch\t"{runtime}"\n' \
			"$plan_magic" "$2" "$plan_rec" "$1" "$when_os" "$sha" "$size"
	}
}

# Sign each plan variant, with the backend's URL filled in.
sign_all() {
	D=$1 B=$2
	mk() { # name header-lines request-lines
		plan "$2" "$3" | sed "s|@BACKEND@|$B|" > "$D/$1.unsigned"
		# -kind follows $plan_magic: the signature is over the whole
		# file, first token included, so an old-spelling plan has to be
		# signed as one rather than rewritten afterwards.
		plansig -data "$D/key" -kind "$plan_magic" sign "$D/$1.unsigned" > "$D/$1.txt" || exit 1
	}
	mk fresh "" ""
	mk nonce-ok "" "request$(printf '\t')nonce$(printf '\t')$NONCE
"
	mk nonce-other "" "request$(printf '\t')nonce$(printf '\t')$OTHER
"
	mk old-plan "signed$(printf '\t')$(ago 400)
maxage$(printf '\t')7776000
" ""
	mk warn-plan "signed$(printf '\t')$(ago 120)
maxage$(printf '\t')7776000
" ""
	mk new-plan "signed$(printf '\t')$(ago 1)
maxage$(printf '\t')7776000
" ""
	# The same two plans the old-engine cases use, in that engine's
	# spelling and naming its copy of the record.
	plan_magic=$old_magic-plan
	plan_rec=$oldh
	mk old-plan-for-old "signed$(printf '\t')$(ago 400)
maxage$(printf '\t')7776000
" ""
	mk nonce-ok-for-old "" "request$(printf '\t')nonce$(printf '\t')$NONCE
"
	plan_magic=ti-plan
	plan_rec=$h
	# The revocation lists.
	iss=$(date -u +%Y-%m-%dT%H:00:00Z)
	rl() { # name serial entries...
		n=$1 ser=$2
		shift 2
		{ printf 'ti-revocations\t1\nissued\t%s\nexpires\t%s\nserial\t%s\n' "$iss" "$iss" "$ser"
		  for e in "$@"; do printf 'revoke\t%s\n' "$e"; done
		} > "$D/rev-$n.unsigned"
		plansig -data "$D/key" -kind ti-revocations sign "$D/rev-$n.unsigned" > "$D/rev-$n.txt" || exit 1
	}
	rl none 10
	rl record 11 "record$(printf '\t')$(cat "$D/hash")"
	rl source 12 "source$(printf '\t')github$(printf '\t')owner/repo"
	rl file 13 "file$(printf '\t')$(cat "$D/rtsha")"
	rl other 14 "record$(printf '\t')aaaaaaaaaaaaaaaaaaaaaaaaaa" "sometingnew$(printf '\t')x"
	# A list signed as a plan must not be taken for a revocation list.
	sed '1s/^ti-revocations/ti-plan/' "$D/rev-record.unsigned" > "$D/rev-asplan.unsigned"
	plansig -data "$D/key" sign "$D/rev-asplan.unsigned" > "$D/rev-asplan.txt" 2>/dev/null ||
		cp "$D/rev-record.unsigned" "$D/rev-asplan.txt"
	name_as base "app_$(cat "$D/hash")"
	name_as future "future_$(cat "$D/hash")"
}

cases() {
	D=$1 B=$2 SH=$3
	P=/usr/bin:/bin:/usr/sbin:/sbin
	one() { # name want-exit want-text args...
		n=$1 want=$2 grepfor=$3
		shift 3
		rm -rf "$D/home" "$D/tmp"
		mkdir -p "$D/home" "$D/tmp"
		env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C TI_TEST_NONCE="$NONCE" \
			$SH "$@" --yes --log="$D/$n.log" > "$D/$n.out" 2>&1
		rc=$?
		if [ "$rc" = "$want" ] && grep -q "$grepfor" "$D/$n.log" "$D/$n.out"; then ok "$n (exit $rc)"
		else bad "$n (exit $rc, want $want and '$grepfor')"; tail -n 6 "$D/$n.out" | sed 's/^/     | /'; fi
	}

	# ---- the nonce, on a plan fetched by record hash
	cp "$D/nonce-ok.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	one nonce-echoed 0 "Nonce $NONCE echoed" "$(eng "app_$(cat "$D/hash")")" --backend="$B"
	cp "$D/nonce-other.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	one nonce-replayed 1 "answer to another request" "$(eng "app_$(cat "$D/hash")")" --backend="$B"
	cp "$D/fresh.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	one nonce-older-backend 0 "the plan carries none" "$(eng "app_$(cat "$D/hash")")" --backend="$B"

	# ---- the revocation list, on a plan this installer carries
	cp "$D/rev-none.txt" "$D/srv/api/revocations"
	one rev-nothing 0 "checked against the list" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-record.txt" "$D/srv/api/revocations"
	one rev-record 1 "has been withdrawn" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-source.txt" "$D/srv/api/revocations"
	one rev-source 1 "has been withdrawn" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-file.txt" "$D/srv/api/revocations"
	one rev-file 1 "has been withdrawn" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-other.txt" "$D/srv/api/revocations"
	one rev-other 0 "checked against the list" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	# Signed as a plan, not as a revocation list: ignored, not obeyed.
	cp "$D/rev-asplan.txt" "$D/srv/api/revocations"
	one rev-wrong-kind 0 "not a ti-revocations" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	# The list is kept, and used when the backend can't be reached: this
	# run gets it from the backend and refuses, and the next has nowhere
	# to fetch from and must refuse all the same. The same HOME, so the
	# cache written by the first is there for the second.
	cp "$D/rev-record.txt" "$D/srv/api/revocations"
	rm -rf "$D/home" "$D/tmp"
	mkdir -p "$D/home" "$D/tmp"
	env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C $SH "$(eng base)" --record="$D/record.txt" \
		--plan="$D/fresh.txt" --backend="$B" --yes --log="$D/warm.log" > /dev/null 2>&1
	if [ -f "$(cache_file "$D/home")" ]; then ok "rev-cached (the list was kept)"
	else bad "rev-cached (nothing in $(cache_file '~'))"; fi
	env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C $SH "$(eng base)" --record="$D/record.txt" \
		--plan="$D/fresh.txt" --backend="http://127.0.0.1:1" --yes --log="$D/offline.log" > "$D/offline.out" 2>&1
	rc=$?
	if [ "$rc" = 1 ] && grep -q "has been withdrawn" "$D/offline.log" "$D/offline.out"; then ok "rev-offline (the cached list still refuses)"
	else bad "rev-offline (exit $rc)"; tail -n 4 "$D/offline.out" | sed 's/^/     | /'; fi
	rm -rf "$D/home"
	cp "$D/rev-none.txt" "$D/srv/api/revocations"

	# ---- expiry, on a plan this installer carries
	one age-fresh 0 "Plan signed" "$(eng base)" --record="$D/record.txt" --plan="$D/new-plan.txt" --backend="$B"
	one age-warn 0 "meant to be used within" "$(eng base)" --record="$D/record.txt" --plan="$D/warn-plan.txt" --backend="$B"
	one age-refused 1 "past the 365-day limit" "$(eng base)" --record="$D/record.txt" --plan="$D/old-plan.txt" --backend="$B"
	# The same plan on a base built "in the future": the clock can't be
	# believed, so nothing is refused (the operator's rule).
	one age-bad-clock 0 "can't be right" "$(eng future)" --record="$D/record.txt" --plan="$D/old-plan.txt" --backend="$B"

	# ---- old engine, new plan; new engine, old plan
	if [ -n "$old_engine" ]; then
		# The engine from before this change, given a plan with `signed`,
		# `maxage` and a `request nonce` line: unknown keys, so it installs.
		one old-engine-new-plan 0 "Fresh" "$old_engine" --record="$D/old-record.txt" --plan="$D/old-plan-for-old.txt" --backend="$B"
		cp "$D/nonce-ok-for-old.txt" "$D/srv/api/plan/$(cat "$D/oldhash")"
		one old-engine-nonce-plan 0 "Fresh" "$old_engine" --record="$D/old-record.txt" --backend="$B"
		cp "$D/fresh.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	fi
	one new-engine-old-plan 0 "Fresh" "$(eng base)" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	rm -rf "$D/home" "$D/tmp"
}

shell=${1:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/tifresh.XXXXXX")
trap '[ -n "${TI_TEST_KEEP:-}" ] || { kill $srv 2>/dev/null; rm -rf "$T"; }' EXIT
prepare "$T"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
(cd "$T/srv" && exec python3 -m http.server "$port" --bind 127.0.0.1 > /dev/null 2>&1) &
srv=$!
sign_all "$T" "http://127.0.0.1:$port"
sleep 1
cases "$T" "http://127.0.0.1:$port" "$shell"
[ $fails = 0 ] && echo "all passed ($shell)" || echo "$fails failed ($shell)"
[ $fails = 0 ]
