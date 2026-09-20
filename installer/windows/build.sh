#!/bin/sh
# Build the Windows base: launcher.exe first (base.exe embeds it), then
# base.exe. Output goes to out/.
#
#   ./build.sh                       -> out/launcher.exe, out/base.exe
#   TI_BACKEND=http://host:port ./build.sh
#                                    -> a base with a different default backend
#   TI_OUTFILE=out/other.exe ./build.sh
#   TI_PLAN_PUBKEY_FILE=/path/plan-signing-key.pub ./build.sh
#                                    -> the plan signing key to trust
#                                       (default: ../../server/data/, which
#                                       the server writes on first start)
set -eu
cd "$(dirname "$0")"
PATH="$HOME/.local/bin:$PATH"
export PATH
command -v makensis >/dev/null || { echo "makensis not found (expected ~/.local/bin/makensis)" >&2; exit 1; }
mkdir -p out

# The plan signing key (docs/format.md "Plan signature"): one line, base64 of 32 bytes.
keyfile=${TI_PLAN_PUBKEY_FILE:-../../server/data/plan-signing-key.pub}
[ -f "$keyfile" ] || { echo "no plan signing key at $keyfile: start the server once (it makes one), or set TI_PLAN_PUBKEY_FILE" >&2; exit 1; }
key=$(tr -d ' \r\n' < "$keyfile")
case $key in *[!A-Za-z0-9+/=]*) echo "$keyfile: not base64" >&2; exit 1 ;; esac
[ ${#key} -eq 44 ] && [ "$(printf '%s' "$key" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ||
	{ echo "$keyfile: not a 32-byte Ed25519 public key" >&2; exit 1; }
keyid=$(printf '%s' "$key" | base64 -d | sha256sum | cut -c1-16)
echo "plan signing key $keyid ($keyfile)"

# When this base was built. The engine uses it as the floor below which a
# machine's clock cannot be believed (design.md 7.1, "Clocks"); days, not
# seconds, because NSIS arithmetic is 32-bit signed and seconds overflow
# it in 2038. SOURCE_DATE_EPOCH is honoured for reproducible builds.
build_epoch=${SOURCE_DATE_EPOCH:-$(date -u +%s)}
case $build_epoch in '' | *[!0-9]*) echo "bad SOURCE_DATE_EPOCH" >&2; exit 1 ;; esac
build_days=$((build_epoch / 86400))
build_time=$(date -u -d "@$build_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
echo "built $build_time (day $build_days)"

defs="-DTI_PLAN_PUBKEY=$key -DTI_PLAN_KEYID=$keyid -DTI_BUILD_TIME=$build_time -DTI_BUILD_DAYS=$build_days"
[ -n "${TI_BACKEND:-}" ] && defs="$defs -DTI_BACKEND=$TI_BACKEND"
[ -n "${TI_OUTFILE:-}" ] && defs="$defs -DTI_OUTFILE=$TI_OUTFILE"

makensis -V2 -WX launcher.nsi
# shellcheck disable=SC2086
makensis -V2 -WX $defs base.nsi
ls -l out/launcher.exe "${TI_OUTFILE:-out/base.exe}"
sha256sum out/launcher.exe "${TI_OUTFILE:-out/base.exe}"
