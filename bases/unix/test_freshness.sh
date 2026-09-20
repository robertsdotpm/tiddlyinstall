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
#   IB_TEST_KEEP=1 keeps the work folder.
#
# Needs Node.js (tools/plansig.mjs; $NODE, else node on PATH, else
# ~/.local/node/bin/node) and python3 (a local HTTP backend: it serves
# files and ignores the query string, which is what lets a pre-signed
# answer stand in for one the server made for this nonce).
set -u
here=$(cd "$(dirname "$0")" && pwd)
node=${NODE:-$(command -v node || echo "$HOME/.local/node/bin/node")}
plansig() { "$node" "$here/../../tools/plansig.mjs" "$@"; }
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# The engine as it was before stale-plan handling (design.md 7.1).
OLD_REV=${IB_OLD_ENGINE_REV:-0bc46a6}
NONCE=0123456789abcdef0123456789abcdef
OTHER=fedcba9876543210fedcba9876543210
DAY=86400

# Days-old RFC 3339, for `signed`.
ago() { date -u -d "@$(($(date -u +%s) - $1 * DAY))" +%Y-%m-%dT%H:%M:%SZ; }

prepare() {
	D=$1
	mkdir -p "$D/key" "$D/rt/pkg/bin" "$D/srv/api/plan" "$D/srv/api/records" "$D/srv/api" "$D/srv/f"
	plansig -data "$D/key" sign /dev/null > /dev/null 2>&1
	[ -f "$D/key/plan-signing-key.pub" ] || { echo "could not make a key"; exit 1; }
	IB_PLAN_PUBKEY_FILE=$D/key/plan-signing-key.pub sh "$here/make_run.sh" "$D/base.run" > /dev/null || exit 1
	# A second base whose build time is ten years from now: to it, this
	# machine's clock looks impossible, which is the case that must never
	# refuse an install.
	SOURCE_DATE_EPOCH=$(($(date -u +%s) + 10 * 365 * DAY)) \
		IB_PLAN_PUBKEY_FILE=$D/key/plan-signing-key.pub sh "$here/make_run.sh" "$D/future.run" > /dev/null || exit 1
	# ...and the engine as it was before any of this, to check that an
	# installer already in the wild copes with a plan carrying the new
	# fields. A pinned commit, not HEAD: once this change is committed,
	# HEAD is the new engine and the case would test nothing.
	old_engine=""
	if git -C "$here/../.." show "$OLD_REV:bases/unix/ib-engine.sh" > "$D/old-engine.raw" 2>/dev/null; then
		key=$(tr -d ' \r\n' < "$D/key/plan-signing-key.pub")
		keyid=$(printf '%s' "$key" | openssl base64 -d -A | openssl dgst -sha256 | awk '{ print substr($NF, 1, 16) }')
		sed -e "s|^IB_PLAN_PUBKEY=\$|IB_PLAN_PUBKEY=$key|" -e "s|^IB_PLAN_KEYID=\$|IB_PLAN_KEYID=$keyid|" \
			"$D/old-engine.raw" > "$D/old-engine.sh"
		chmod 755 "$D/old-engine.sh"
		old_engine=$D/old-engine.sh
	else
		printf 'note: no %s in git; the old-engine cases are skipped\n' "$OLD_REV"
	fi
	printf '#!/bin/sh\necho hello\n' > "$D/rt/pkg/bin/hello"
	chmod 755 "$D/rt/pkg/bin/hello"
	(cd "$D/rt" && tar -cf - pkg | gzip -c > "$D/srv/f/rt.tar.gz")
	sha=$(sha256sum "$D/srv/f/rt.tar.gz" | cut -d' ' -f1)
	echo "$sha" > "$D/rtsha"
	size=$(wc -c < "$D/srv/f/rt.tar.gz" | tr -d ' ')
	printf 'ib-record\t1\nname\tFresh\nproject\thello\nruntime\tnone\nselect\tnewest\nsource\tgithub\tOwner/Repo\tabc\nlaunch\t{runtime}\nconsole\t1\nmenu\t0\ndesktop\t0\nroot\tuser\nrootname\tib\n' > "$D/record.txt"
	h=$(python3 "$here/append_meta.py" hash "$D/record.txt")
	echo "$h" > "$D/hash"
	cp "$D/record.txt" "$D/srv/api/records/$h"
	# $1 the header lines to add, $2 the request lines to add.
	plan() {
		printf 'ib-plan\t1\n%srecord\t%s\nname\tFresh\nproject\thello\nappid\tfreshtestaaa\nconsole\t1\nmenu\t0\ndesktop\t0\nroot\tuser\nrootname\tib\n%s\n[target]\nwhen\tlinux\t0\t9999\t*\nruntime\tnone\t1\nfile\trt\trt.tar.gz\t%s\t%s\nurl\t@BACKEND@/f/rt.tar.gz\nstep\tunpack\ttar.gz\t{dir}\t1\nexe\tbin/hello\nlaunch\t"{runtime}"\n' \
			"$2" "$h" "$1" "$sha" "$size"
	}
}

# Sign each plan variant, with the backend's URL filled in.
sign_all() {
	D=$1 B=$2
	mk() { # name header-lines request-lines
		plan "$2" "$3" | sed "s|@BACKEND@|$B|" > "$D/$1.unsigned"
		plansig -data "$D/key" sign "$D/$1.unsigned" > "$D/$1.txt" || exit 1
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
	# The revocation lists.
	iss=$(date -u +%Y-%m-%dT%H:00:00Z)
	rl() { # name serial entries...
		n=$1 ser=$2
		shift 2
		{ printf 'ib-revocations\t1\nissued\t%s\nexpires\t%s\nserial\t%s\n' "$iss" "$iss" "$ser"
		  for e in "$@"; do printf 'revoke\t%s\n' "$e"; done
		} > "$D/rev-$n.unsigned"
		plansig -data "$D/key" -kind ib-revocations sign "$D/rev-$n.unsigned" > "$D/rev-$n.txt" || exit 1
	}
	rl none 10
	rl record 11 "record$(printf '\t')$(cat "$D/hash")"
	rl source 12 "source$(printf '\t')github$(printf '\t')owner/repo"
	rl file 13 "file$(printf '\t')$(cat "$D/rtsha")"
	rl other 14 "record$(printf '\t')aaaaaaaaaaaaaaaaaaaaaaaaaa" "sometingnew$(printf '\t')x"
	# A list signed as a plan must not be taken for a revocation list.
	sed '1s/^ib-revocations/ib-plan/' "$D/rev-record.unsigned" > "$D/rev-asplan.unsigned"
	plansig -data "$D/key" sign "$D/rev-asplan.unsigned" > "$D/rev-asplan.txt" 2>/dev/null ||
		cp "$D/rev-record.unsigned" "$D/rev-asplan.txt"
	cp "$D/base.run" "$D/app_$(cat "$D/hash").run"
	cp "$D/future.run" "$D/future_$(cat "$D/hash").run"
}

cases() {
	D=$1 B=$2 SH=$3
	P=/usr/bin:/bin:/usr/sbin:/sbin
	one() { # name want-exit want-text args...
		n=$1 want=$2 grepfor=$3
		shift 3
		rm -rf "$D/home" "$D/tmp"
		mkdir -p "$D/home" "$D/tmp"
		env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C IB_TEST_NONCE="$NONCE" \
			$SH "$@" --yes --log="$D/$n.log" > "$D/$n.out" 2>&1
		rc=$?
		if [ "$rc" = "$want" ] && grep -q "$grepfor" "$D/$n.log" "$D/$n.out"; then ok "$n (exit $rc)"
		else bad "$n (exit $rc, want $want and '$grepfor')"; tail -n 6 "$D/$n.out" | sed 's/^/     | /'; fi
	}

	# ---- the nonce, on a plan fetched by record hash
	cp "$D/nonce-ok.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	one nonce-echoed 0 "Nonce $NONCE echoed" "$D/app_$(cat "$D/hash").run" --backend="$B"
	cp "$D/nonce-other.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	one nonce-replayed 1 "answer to another request" "$D/app_$(cat "$D/hash").run" --backend="$B"
	cp "$D/fresh.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	one nonce-older-backend 0 "the plan carries none" "$D/app_$(cat "$D/hash").run" --backend="$B"

	# ---- the revocation list, on a plan this installer carries
	cp "$D/rev-none.txt" "$D/srv/api/revocations"
	one rev-nothing 0 "checked against the list" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-record.txt" "$D/srv/api/revocations"
	one rev-record 1 "has been withdrawn" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-source.txt" "$D/srv/api/revocations"
	one rev-source 1 "has been withdrawn" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-file.txt" "$D/srv/api/revocations"
	one rev-file 1 "has been withdrawn" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	cp "$D/rev-other.txt" "$D/srv/api/revocations"
	one rev-other 0 "checked against the list" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	# Signed as a plan, not as a revocation list: ignored, not obeyed.
	cp "$D/rev-asplan.txt" "$D/srv/api/revocations"
	one rev-wrong-kind 0 "not an ib-revocations" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	# The list is kept, and used when the backend can't be reached: this
	# run gets it from the backend and refuses, and the next has nowhere
	# to fetch from and must refuse all the same. The same HOME, so the
	# cache written by the first is there for the second.
	cp "$D/rev-record.txt" "$D/srv/api/revocations"
	rm -rf "$D/home" "$D/tmp"
	mkdir -p "$D/home" "$D/tmp"
	env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C $SH "$D/base.run" --record="$D/record.txt" \
		--plan="$D/fresh.txt" --backend="$B" --yes --log="$D/warm.log" > /dev/null 2>&1
	if [ -f "$D/home/.cache/tiddlyinstall/revocations.txt" ]; then ok "rev-cached (the list was kept)"
	else bad "rev-cached (nothing in ~/.cache/tiddlyinstall)"; fi
	env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C $SH "$D/base.run" --record="$D/record.txt" \
		--plan="$D/fresh.txt" --backend="http://127.0.0.1:1" --yes --log="$D/offline.log" > "$D/offline.out" 2>&1
	rc=$?
	if [ "$rc" = 1 ] && grep -q "has been withdrawn" "$D/offline.log" "$D/offline.out"; then ok "rev-offline (the cached list still refuses)"
	else bad "rev-offline (exit $rc)"; tail -n 4 "$D/offline.out" | sed 's/^/     | /'; fi
	rm -rf "$D/home"
	cp "$D/rev-none.txt" "$D/srv/api/revocations"

	# ---- expiry, on a plan this installer carries
	one age-fresh 0 "Plan signed" "$D/base.run" --record="$D/record.txt" --plan="$D/new-plan.txt" --backend="$B"
	one age-warn 0 "meant to be used within" "$D/base.run" --record="$D/record.txt" --plan="$D/warn-plan.txt" --backend="$B"
	one age-refused 1 "past the 365-day limit" "$D/base.run" --record="$D/record.txt" --plan="$D/old-plan.txt" --backend="$B"
	# The same plan on a base built "in the future": the clock can't be
	# believed, so nothing is refused (the operator's rule).
	one age-bad-clock 0 "can't be right" "$D/future.run" --record="$D/record.txt" --plan="$D/old-plan.txt" --backend="$B"

	# ---- old engine, new plan; new engine, old plan
	if [ -n "$old_engine" ]; then
		# The engine from before this change, given a plan with `signed`,
		# `maxage` and a `request nonce` line: unknown keys, so it installs.
		one old-engine-new-plan 0 "Fresh" "$old_engine" --record="$D/record.txt" --plan="$D/old-plan.txt" --backend="$B"
		cp "$D/nonce-ok.txt" "$D/srv/api/plan/$(cat "$D/hash")"
		one old-engine-nonce-plan 0 "Fresh" "$old_engine" --record="$D/record.txt" --backend="$B"
		cp "$D/fresh.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	fi
	one new-engine-old-plan 0 "Fresh" "$D/base.run" --record="$D/record.txt" --plan="$D/fresh.txt" --backend="$B"
	rm -rf "$D/home" "$D/tmp"
}

shell=${1:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/ibfresh.XXXXXX")
trap '[ -n "${IB_TEST_KEEP:-}" ] || { kill $srv 2>/dev/null; rm -rf "$T"; }' EXIT
prepare "$T"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
(cd "$T/srv" && exec python3 -m http.server "$port" --bind 127.0.0.1 > /dev/null 2>&1) &
srv=$!
sign_all "$T" "http://127.0.0.1:$port"
sleep 1
cases "$T" "http://127.0.0.1:$port" "$shell"
[ $fails = 0 ] && echo "all passed ($shell)" || echo "$fails failed ($shell)"
[ $fails = 0 ]
