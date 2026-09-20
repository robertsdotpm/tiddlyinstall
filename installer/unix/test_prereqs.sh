#!/bin/sh
# Local tests of the Linux engine's system-wide prerequisites (format.md
# "Prerequisites") and the record's `icon` key. Offline: every file comes
# from the pack. Each run uses a clean environment (env -i, a throwaway
# HOME, no DISPLAY / WAYLAND_DISPLAY / DBUS_SESSION_BUS_ADDRESS), so no
# dialog can open, and it never touches the system: the package manager
# and sudo are fakes, and a fake sudo is always ahead of the real one on
# PATH (on a machine with passwordless sudo the real one would install).
#
#   sh test_prereqs.sh [SHELL]      (default sh; also dash, bash, "busybox sh")
#   KEEP=1 keeps the work folder (logs, installers) for a look afterwards.
set -u
here=$(cd "$(dirname "$0")" && pwd)
shell=${1:-sh}
T=$(mktemp -d "${TMPDIR:-/tmp}/tiprq.XXXXXX")
trap '[ -n "${KEEP:-}" ] || rm -rf "$T"' EXIT
tab=$(printf '\t')
fails=0
ok() { printf 'ok   %s\n' "$1"; }
bad() { printf 'FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if eval "$2"; then ok "$1"; else bad "$1"; [ -f "$T/out" ] && sed 's/^/     | /' "$T/out" | tail -n 12; fi; }

TI_PLAN_PUBKEY_FILE=${TI_PLAN_PUBKEY_FILE:-$here/../../server/data/plan-signing-key.pub} \
	sh "$here/make_run.sh" "$T/base.run" > /dev/null || { echo "make_run failed"; exit 1; }

# A tiny "runtime": bin/hello prints a line.
mkdir -p "$T/rt/pkg/bin" "$T/pack"
printf '#!/bin/sh\necho hello from the runtime\n' > "$T/rt/pkg/bin/hello"
chmod 755 "$T/rt/pkg/bin/hello"
(cd "$T/rt" && tar -czf "$T/pack/rt.tar.gz" pkg)
rsha=$(sha256sum "$T/pack/rt.tar.gz" | cut -d' ' -f1)
rsize=$(wc -c < "$T/pack/rt.tar.gz" | tr -d ' ')
# A 1x1 PNG for the icon.
python3 -c 'import base64,sys; sys.stdout.buffer.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))' > "$T/icon.png"
isha=$(sha256sum "$T/icon.png" | cut -d' ' -f1)

# make NAME NEEDS-FILE [icon]: an installer whose block has the given need lines.
make() {
	{
		printf 'ti-record\t1\nname\tPrereq %s\nproject\thello\nruntime\tnone\nselect\tnewest\nlaunch\t{runtime}\nconsole\t1\nmenu\t1\ndesktop\t0\nroot\tuser\nrootname\tti\n' "$1"
		[ "${3:-}" = icon ] && printf 'icon\t%s\n' "$isha"
	} > "$T/$1.rec"
	h=$(python3 "$here/append_meta.py" hash "$T/$1.rec")
	{
		printf 'ti-plan\t1\nrecord\t%s\nname\tPrereq %s\nproject\thello\nappid\t%s\nconsole\t1\nmenu\t1\ndesktop\t0\nroot\tuser\nrootname\tti\n\n[target]\nwhen\tlinux\t0\t9999\t*\nruntime\tnone\t1\n' \
			"$h" "$1" "$(printf '%s' "$1" | sha256sum | python3 -c 'import sys,base64; print(base64.b32encode(bytes.fromhex(sys.stdin.read().split()[0])).decode().lower()[:12])')"
		cat "$2"
		printf 'file\trt\trt.tar.gz\t%s\t%s\nstep\tunpack\ttar.gz\t{dir}\t1\nexe\tbin/hello\nlaunch\t"{runtime}"\n' "$rsha" "$rsize"
	} > "$T/$1.plan"
	pk=$T/pack
	[ "${3:-}" = icon ] && { mkdir -p "$T/pack-icon"; cp "$T/pack/rt.tar.gz" "$T/icon.png" "$T/pack-icon/"; pk=$T/pack-icon; }
	[ "${3:-}" = noicon ] && printf 'icon\t%s\n' "$isha" >> "$T/$1.rec"
	[ "${3:-}" = noicon ] && sed -i "s/^record\t.*/record\t$(python3 "$here/append_meta.py" hash "$T/$1.rec")/" "$T/$1.plan"
	python3 "$here/append_meta.py" run "$T/base.run" -o "$T/$1.run" --record "$T/$1.rec" --plan "$T/$1.plan" --pack "$pk" > /dev/null
}

# run NAME PATH [args]: the engine in a clean environment; output in $T/out.
run() {
	n=$1 p=$2
	shift 2
	rm -rf "$T/home"
	mkdir -p "$T/home"
	env -i HOME="$T/home" PATH="$p" TMPDIR="$T" FAKE="$T/fake" LANG=C.UTF-8 \
		$shell "$T/$n.run" --yes --log="$T/$n.log" "$@" > "$T/out" 2>&1
	rc=$?
	cat "$T/$n.log" >> "$T/out" 2>/dev/null
	return 0
}
appdir() { ls -d "$T/home/.local/share/ti/"* 2>/dev/null | while read -r d; do [ -f "$d/manifest.txt" ] && echo "$d"; done; }

# Fakes: sudo that allows -n (passwordless), a package manager that
# "installs" by creating commands and libraries the fake ldconfig reports.
mkdir -p "$T/fake/bin" "$T/nosudo/bin"
cat > "$T/fake/bin/sudo" <<'EOF'
#!/bin/sh
echo "sudo $*" >> "$FAKE/calls"
[ "$1" = -n ] || { echo "fake sudo: interactive use in a test" >&2; exit 1; }
shift
[ "$1" = true ] && exit 0
exec "$@"
EOF
cat > "$T/fake/bin/apt-get" <<'EOF'
#!/bin/sh
echo "apt-get $*" >> "$FAKE/calls"
[ -f "$FAKE/fail" ] && exit 100
case $1 in
update) : > "$FAKE/updated"; exit 0 ;;
install) ;;
*) exit 1 ;;
esac
# Like a fresh cloud image: nothing installs until the lists are fetched.
[ -f "$FAKE/needs-update" ] && [ ! -f "$FAKE/updated" ] && { echo "E: Unable to locate package" >&2; exit 100; }
shift
for p in "$@"; do
	case $p in
	-y) ;;
	ti-fake-cc) printf '#!/bin/sh\nexit 0\n' > "$FAKE/bin/tifakecc"; chmod 755 "$FAKE/bin/tifakecc" ;;
	libtifake1) echo "	libtifake.so.1 (libc6,x86-64) => /usr/lib/x86_64-linux-gnu/libtifake.so.1" >> "$FAKE/libs"
		echo "	libtifake.so.1 (libc6,AArch64) => /usr/lib/aarch64-linux-gnu/libtifake.so.1" >> "$FAKE/libs" ;;
	*) echo "E: Unable to locate package $p" >&2; exit 100 ;;
	esac
done
EOF
cat > "$T/fake/bin/ldconfig" <<'EOF'
#!/bin/sh
[ "$1" = -p ] || exit 1
for l in /sbin/ldconfig /usr/sbin/ldconfig; do [ -x "$l" ] && { "$l" -p; break; }; done
cat "$FAKE/libs" 2>/dev/null
EOF
cat > "$T/nosudo/bin/sudo" <<'EOF'
#!/bin/sh
echo "sudo $*" >> "$FAKE/calls"
exit 1
EOF
chmod 755 "$T/fake/bin/"* "$T/nosudo/bin/sudo"
reset_fake() { rm -f "$T/fake/calls" "$T/fake/libs" "$T/fake/updated" "$T/fake/needs-update" "$T/fake/fail" "$T/fake/bin/tifakecc" "$T/started"; }

printf 'need\tlibc\tThe C library\nnwhy\tEverything links it.\nncheck\tlib\tlibc.so.6\nnpkg\tapt-get\tlibc6\n' > "$T/present.need"
printf 'need\tfakecc\tA fake C compiler\nnwhy\tTo link.\nncheck\tcmd\ttifakecc\nnpkg\tapt-get\tti-fake-cc\nnpkg\tdnf\tti-fake-cc\nneed\tfakelib\tlibtifake.so.1\nncheck\tlib\tlibtifake.so.1\nnpkg\tapt-get\tlibtifake1\n' > "$T/missing.need"
printf 'need\tclt\tSome tools\nncheck\tfile\t/nonexistent/ti/tools\nnstart\ttouch %s/started\nnhow\tInstall the tools by hand, then run this installer again.\n' "$T" > "$T/manual.need"
printf 'need\tbad\tBad\nncheck\tcmd\ttifakecc\nnpkg\tapt-get\tfoo;touch${IFS}%s/pwned\n' "$T" > "$T/badpkg.need"

base=/usr/bin:/bin
reset_fake

# 1. Present: nothing to install, no root asked for.
make present "$T/present.need"
run present "$T/fake/bin:$base"
check "present: installs (exit $rc)" '[ $rc = 0 ] && [ -n "$(appdir)" ]'
check "present: listed as present" 'grep -q "The C library: present" "$T/out"'
check "present: sudo never called" '[ ! -f "$T/fake/calls" ]'
check "present: runs" '[ "$(sh "$(appdir)/launch.sh")" = "hello from the runtime" ]'

# 2. Missing, --yes, no way to root (sudo -n fails): exit 2 with the command to run.
reset_fake
make missing "$T/missing.need"
# fake apt-get, and a sudo that refuses (ahead of fake/bin's)
run missing "$T/nosudo/bin:$T/fake/bin:$base"
check "no root: exit 2 (got $rc)" '[ $rc = 2 ]'
check "no root: says the exact command" 'grep -q "sudo apt-get update && sudo apt-get install -y ti-fake-cc libtifake1" "$T/out"'
check "no root: nothing installed" '[ -z "$(appdir)" ] && [ ! -d "$T/home/.local/share/ti" ]'
check "no root: package manager not run" '! grep -q "^apt-get" "$T/fake/calls"'
check "no root: only sudo -n tried" '! grep -v "^sudo -n" "$T/fake/calls" | grep -q .'
check "no root: transparency lists both as missing" '[ "$(grep -c "MISSING, will be installed" "$T/out")" -ge 2 ]'

# 3. Missing, passwordless sudo, fake apt-get: installs packages, checks again, installs the app.
reset_fake
run missing "$T/fake/bin:$base"
check "install: exit 0 (got $rc)" '[ $rc = 0 ] && [ -n "$(appdir)" ]'
check "install: one apt-get call with both packages" 'grep -q "^apt-get install -y ti-fake-cc libtifake1$" "$T/fake/calls"'
check "install: through sudo -n sh -c" 'grep -q "^sudo -n sh -c .*apt-get install -y ti-fake-cc libtifake1" "$T/fake/calls"'
check "install: app runs" '[ "$(sh "$(appdir)/launch.sh")" = "hello from the runtime" ]'

# 4. apt lists empty: install fails, update, retry.
reset_fake
: > "$T/fake/needs-update"
run missing "$T/fake/bin:$base"
check "apt update retry: exit 0 (got $rc)" '[ $rc = 0 ] && grep -q "^apt-get update" "$T/fake/calls"'

# 5. The package manager fails: exit 1, nothing installed, command in the message.
reset_fake
: > "$T/fake/fail"
run missing "$T/fake/bin:$base"
check "apt fails: exit 1 (got $rc)" '[ $rc = 1 ] && [ -z "$(appdir)" ] && grep -q "apt-get exit code" "$T/out"'

# 6. Can't be installed here (no package for this manager), --yes: exit 2 with the plan's how; nstart not run.
reset_fake
make manual "$T/manual.need"
run manual "$T/fake/bin:$base"
check "manual: exit 2 (got $rc)" '[ $rc = 2 ] && grep -q "Install the tools by hand" "$T/out" && [ -z "$(appdir)" ]'
check "manual: nstart not run under --yes" '[ ! -f "$T/started" ]'

# 7. A package name with shell in it is refused before anything runs.
reset_fake
make badpkg "$T/badpkg.need"
run badpkg "$T/fake/bin:$base"
check "bad package name: refused (got $rc)" '[ $rc != 0 ] && [ ! -f "$T/pwned" ] && ! grep -q "^apt-get" "$T/fake/calls" 2>/dev/null'

# 8. The real system's ldconfig, library folders and apt-get detection,
# with a sudo that refuses (never the real one: on a machine with
# passwordless sudo that would really install packages).
reset_fake
run missing "$T/nosudo/bin:$base"
check "real PATH, no root: exit 2 (got $rc)" '[ $rc = 2 ] && grep -q "sudo apt-get update && sudo apt-get install -y ti-fake-cc libtifake1" "$T/out"'
run present "$T/nosudo/bin:$base"
check "real PATH, present: exit 0 (got $rc)" '[ $rc = 0 ]'

# 9. Icon: the packed PNG goes into the app folder and Icon= names it.
reset_fake
make icon "$T/present.need" icon
run icon "$T/fake/bin:$base"
d=$(appdir)
desk=$T/home/.local/share/applications/ti-$(basename "$d").desktop
check "icon: installed (got $rc)" '[ $rc = 0 ] && cmp -s "$d/icon.png" "$T/icon.png"'
check "icon: Icon= is its absolute path" 'grep -qx "Icon=$d/icon.png" "$desk"'
check "icon: uninstall removes it" 'env -i HOME="$T/home" PATH="$base" TMPDIR="$T" sh "$d/uninstall.sh" --yes > /dev/null 2>&1; [ ! -e "$d" ] && [ ! -e "$desk" ]'

# 10. Icon in the record but not packed: the generic icon.
make noicon "$T/present.need" noicon
run noicon "$T/fake/bin:$base"
d=$(appdir)
check "icon not packed: generic (got $rc)" '[ $rc = 0 ] && grep -qx "Icon=application-x-executable" "$T/home/.local/share/applications/ti-$(basename "$d").desktop" && [ ! -e "$d/icon.png" ]'

echo
[ $fails = 0 ] && echo "all passed ($shell)" || echo "$fails failed ($shell)"
[ $fails = 0 ]
