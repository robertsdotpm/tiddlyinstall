#!/bin/sh
# Build the Linux base: out/ib-base.run.
#
# The plan signing key is baked in (plankey.sh): IB_PLAN_PUBKEY_FILE, or
# ../../server/data/plan-signing-key.pub.
#
# The engine IS the .run. A metadata block (format.md section 4) may be
# appended later, after the engine's final `exit $?` line: sh stops
# reading at `exit`, so the appended bytes are never parsed.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
out=${1:-$here/out/ib-base.run}
mkdir -p "$(dirname "$out")"
eng=$here/ib-engine.sh

# The file must end with a top-level `exit` line and a newline, or sh
# would go on to read the appended block as commands.
last=$(tail -n 1 "$eng")
[ "$last" = 'exit $?' ] || { echo "make_run: $eng must end with 'exit \$?'" >&2; exit 1; }
[ "$(tail -c 1 "$eng" | od -An -c | tr -d ' ')" = '\n' ] || { echo "make_run: no final newline" >&2; exit 1; }
# No IBMETA1 footer may already be present.
case $(tail -c 64 "$eng") in IBMETA1*) echo "make_run: engine already has a block" >&2; exit 1 ;; esac
# Syntax check with every POSIX shell we have.
for sh in dash sh "bash --posix" "busybox sh"; do
	set -- $sh
	command -v "$1" >/dev/null 2>&1 || continue
	$sh -n "$eng" || { echo "make_run: syntax error under $sh" >&2; exit 1; }
done

. "$here/plankey.sh"
bake_engine "$eng" "$out"
chmod 755 "$out"
echo "$out ($(wc -c < "$out" | tr -d ' ') bytes)"
