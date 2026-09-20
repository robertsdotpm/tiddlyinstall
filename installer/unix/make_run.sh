#!/bin/sh
# Build the Linux base: out/ti-base.run.
#
# The plan signing key is baked in (plankey.sh): TI_PLAN_PUBKEY_FILE, or
# ../../server/data/plan-signing-key.pub.
#
# The engine IS the .run. A metadata block (format.md section 4) may be
# appended later, after the engine's final `exit $?` line: sh stops
# reading at `exit`, so the appended bytes are never parsed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/out/ti-base.run}
mkdir -p "$(dirname "$out")"
eng=$here/ti-engine.sh

# The file must end with a top-level `exit` line and a newline, or sh
# would go on to read the appended block as commands.
last=$(tail -n 1 "$eng")
[ "$last" = 'exit $?' ] || { echo "make_run: $eng must end with 'exit \$?'" >&2; exit 1; }
[ "$(tail -c 1 "$eng" | od -An -c | tr -d ' ')" = '\n' ] || { echo "make_run: no final newline" >&2; exit 1; }
# No TIMETA1 footer may already be present.
case $(tail -c 64 "$eng") in TIMETA1*) echo "make_run: engine already has a block" >&2; exit 1 ;; esac
# Syntax check with every POSIX shell we have.
for sh in dash sh "bash --posix" "busybox sh"; do
	set -- $sh
	command -v "$1" >/dev/null 2>&1 || continue
	$sh -n "$eng" || { echo "make_run: syntax error under $sh" >&2; exit 1; }
done

. "$here/plankey.sh"
bake_engine "$eng" "$out.tmp"

# Our Ed25519 verifiers (verify/, format.md "Plan signature") go after the
# script's final `exit` line, before any metadata block added later, and
# the script's TI_VERIFY_BLOBS= line says where: <arch>:<offset>:<length>,
# offsets from the start of the file. The numbers are fixed width, so the
# script's size is known before they are filled in.
[ "$(grep -c '^TI_VERIFY_BLOBS=$' "$out.tmp")" = 1 ] || { echo "make_run: no empty TI_VERIFY_BLOBS= line" >&2; exit 1; }
blobs="amd64:$here/verify/bin/tiverify-linux-x86_64 arm64:$here/verify/bin/tiverify-linux-aarch64 x86:$here/verify/bin/tiverify-linux-i386"
zero=
for b in $blobs; do zero="$zero ${b%%:*}:0000000000:0000000000"; done
sed "s|^TI_VERIFY_BLOBS=\$|TI_VERIFY_BLOBS='${zero# }'|" "$out.tmp" > "$out.tmp2"
off=$(wc -c < "$out.tmp2" | tr -d ' ')
table=
for b in $blobs; do
	f=${b#*:}
	[ -f "$f" ] || { echo "make_run: $f missing (verify/build.sh)" >&2; exit 1; }
	len=$(wc -c < "$f" | tr -d ' ')
	table="$table $(printf '%s:%010d:%010d' "${b%%:*}" "$off" "$len")"
	off=$((off + len))
done
sed "s|^TI_VERIFY_BLOBS=\$|TI_VERIFY_BLOBS='${table# }'|" "$out.tmp" > "$out"
[ "$(wc -c < "$out" | tr -d ' ')" = "$(wc -c < "$out.tmp2" | tr -d ' ')" ] || { echo "make_run: table width changed" >&2; exit 1; }
for b in $blobs; do cat "${b#*:}" >> "$out"; done
rm -f "$out.tmp" "$out.tmp2"
[ "$(wc -c < "$out" | tr -d ' ')" = "$off" ] || { echo "make_run: size mismatch" >&2; exit 1; }
chmod 755 "$out"
echo "$out ($(wc -c < "$out" | tr -d ' ') bytes)"
