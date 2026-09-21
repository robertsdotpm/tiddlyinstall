#!/bin/sh
# Plan signatures checked by the engine's built-in verifier (verify/,
# format.md "Plan signature"): a good plan (fetched over plain HTTP, and
# given with --plan), a tampered one, one replayed for another record, and
# an unsigned one. `openssl` is shadowed on PATH by a stub that fails, so
# only the built-in verifier can pass. Needs Node.js (to sign with a
# throwaway key: tools/plansig.mjs; $NODE, else node on PATH, else
# ~/.local/node/bin/node) and python3 (a local HTTP backend).
#
#   sh test_verify.sh [SHELL]
#   TI_TEST_KEEP=1 keeps the work folder.
set -u
here=$(cd "$(dirname "$0")" && pwd)
node=${NODE:-$(command -v node || echo "$HOME/.local/node/bin/node")}
plansig() { "$node" "$here/../../../tools/plansig.mjs" "$@"; }
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }

# The cases, run from DIR holding base files made by prepare. $1 DIR,
# $2 backend URL (serving DIR/srv), $3 shell.
cases() {
	D=$1 B=$2 SH=$3
	mkdir -p "$D/stub"
	printf '#!/bin/sh\nexit 1\n' > "$D/stub/openssl"
	chmod 755 "$D/stub/openssl"
	P=$D/stub:/usr/bin:/bin:/usr/sbin:/sbin
	one() { # name want-exit want-log args...
		n=$1 want=$2 grepfor=$3
		shift 3
		rm -rf "$D/home" "$D/tmp"
		mkdir -p "$D/home" "$D/tmp"
		env -i HOME="$D/home" PATH="$P" TMPDIR="$D/tmp" LANG=C $SH "$@" --yes --log="$D/$n.log" > "$D/$n.out" 2>&1
		rc=$?
		if [ "$rc" = "$want" ] && grep -q "$grepfor" "$D/$n.log" "$D/$n.out"; then ok "$n (exit $rc)"
		else bad "$n (exit $rc, want $want and '$grepfor')"; tail -n 5 "$D/$n.out" | sed 's/^/     | /'; fi
	}
	one fetched-http 0 "Plan signature: ok:tiverify" "$D/app_$(cat "$D/hash").run" --backend="$B"
	one given-plan 0 "Plan signature: ok:tiverify" "$D/base.run" --record="$D/record.txt" --plan="$D/plan.txt"
	one tampered 1 "does not match this plan" "$D/base.run" --record="$D/record.txt" --plan="$D/tampered.txt"
	one replayed 1 "install plan is for record" "$D/base.run" --record="$D/record2.txt" --plan="$D/plan.txt"
	one unsigned 1 "not signed by the TiddlyInstall key" "$D/base.run" --record="$D/record.txt" --plan="$D/unsigned.txt"
	rm -rf "$D/home" "$D/tmp"
}

# Make DIR: a base with a throwaway key, a record and its signed plan
# (a tiny packed-free runtime from DIR/srv), the bad variants, and the
# backend's files under DIR/srv.
prepare() {
	D=$1
	mkdir -p "$D/key" "$D/rt/pkg/bin" "$D/srv/api/plan" "$D/srv/api/records" "$D/srv/f"
	plansig -data "$D/key" sign /dev/null > /dev/null 2>&1
	[ -f "$D/key/plan-signing-key.pub" ] || { echo "could not make a key"; exit 1; }
	TI_PLAN_PUBKEY_FILE=$D/key/plan-signing-key.pub sh "$here/make_run.sh" "$D/base.run" > /dev/null || exit 1
	printf '#!/bin/sh\necho hello\n' > "$D/rt/pkg/bin/hello"
	chmod 755 "$D/rt/pkg/bin/hello"
	(cd "$D/rt" && tar -cf - pkg | gzip -c > "$D/srv/f/rt.tar.gz")
	sha=$(sha256sum "$D/srv/f/rt.tar.gz" | cut -d' ' -f1)
	size=$(wc -c < "$D/srv/f/rt.tar.gz" | tr -d ' ')
	rec() { printf 'ti-record\t1\nname\tVerify %s\nproject\thello\nruntime\tnone\nselect\tnewest\nlaunch\t{runtime}\nconsole\t1\nmenu\t0\ndesktop\t0\nroot\tuser\nrootname\tti\n' "$1"; }
	rec one > "$D/record.txt"
	rec two > "$D/record2.txt"
	h=$(python3 "$here/append_meta.py" hash "$D/record.txt")
	echo "$h" > "$D/hash"
	printf 'ti-plan\t1\nrecord\t%s\nname\tVerify one\nproject\thello\nappid\tverifytestaa\nconsole\t1\nmenu\t0\ndesktop\t0\nroot\tuser\nrootname\tti\n\n[target]\nwhen\tlinux\t0\t9999\t*\nruntime\tnone\t1\nfile\trt\trt.tar.gz\t%s\t%s\nurl\t@BACKEND@/f/rt.tar.gz\nstep\tunpack\ttar.gz\t{dir}\t1\nexe\tbin/hello\nlaunch\t"{runtime}"\n' \
		"$h" "$sha" "$size" > "$D/unsigned.tmpl"
}

sign() { # DIR BACKEND: the plan with the backend's URL, signed, and its variants
	D=$1
	sed "s|@BACKEND@|$2|" "$D/unsigned.tmpl" > "$D/unsigned.txt"
	plansig -data "$D/key" sign "$D/unsigned.txt" > "$D/plan.txt" || exit 1
	sed 's/^name\tVerify one$/name\tVerify 0ne/' "$D/plan.txt" > "$D/tampered.txt"
	cp "$D/record.txt" "$D/srv/api/records/$(cat "$D/hash")"
	cp "$D/plan.txt" "$D/srv/api/plan/$(cat "$D/hash")"
	cp "$D/base.run" "$D/app_$(cat "$D/hash").run"
}

shell=${1:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/tiver.XXXXXX")
trap '[ -n "${TI_TEST_KEEP:-}" ] || { kill $srv 2>/dev/null; rm -rf "$T"; }' EXIT
prepare "$T"
port=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')
(cd "$T/srv" && exec python3 -m http.server "$port" --bind 127.0.0.1 > /dev/null 2>&1) &
srv=$!
sign "$T" "http://127.0.0.1:$port"
sleep 1
cases "$T" "http://127.0.0.1:$port" "$shell"
[ $fails = 0 ] && echo "all passed ($shell)" || echo "$fails failed ($shell)"
[ $fails = 0 ]
