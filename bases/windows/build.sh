#!/bin/sh
# Build the Windows base: launcher.exe first (base.exe embeds it), then
# base.exe. Output goes to out/.
#
#   ./build.sh                       -> out/launcher.exe, out/base.exe
#   IB_BACKEND=http://host:port ./build.sh
#                                    -> a base with a different default backend
#   IB_OUTFILE=out/other.exe ./build.sh
#   IB_PLAN_PUBKEY_FILE=/path/plan-signing-key.pub ./build.sh
#                                    -> the plan signing key to trust
#                                       (default: ../../backend/data/, which
#                                       the server writes on first start)
set -eu
cd "$(dirname "$0")"
PATH="$HOME/.local/bin:$PATH"
export PATH
command -v makensis >/dev/null || { echo "makensis not found (expected ~/.local/bin/makensis)" >&2; exit 1; }
mkdir -p out

# The plan signing key (docs/format.md "Plan signature"): one line, base64 of 32 bytes.
keyfile=${IB_PLAN_PUBKEY_FILE:-../../backend/data/plan-signing-key.pub}
[ -f "$keyfile" ] || { echo "no plan signing key at $keyfile: start the server once (it makes one), or set IB_PLAN_PUBKEY_FILE" >&2; exit 1; }
key=$(tr -d ' \r\n' < "$keyfile")
case $key in *[!A-Za-z0-9+/=]*) echo "$keyfile: not base64" >&2; exit 1 ;; esac
[ ${#key} -eq 44 ] && [ "$(printf '%s' "$key" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ||
	{ echo "$keyfile: not a 32-byte Ed25519 public key" >&2; exit 1; }
keyid=$(printf '%s' "$key" | base64 -d | sha256sum | cut -c1-16)
echo "plan signing key $keyid ($keyfile)"

defs="-DIB_PLAN_PUBKEY=$key -DIB_PLAN_KEYID=$keyid"
[ -n "${IB_BACKEND:-}" ] && defs="$defs -DIB_BACKEND=$IB_BACKEND"
[ -n "${IB_OUTFILE:-}" ] && defs="$defs -DIB_OUTFILE=$IB_OUTFILE"

makensis -V2 -WX launcher.nsi
# shellcheck disable=SC2086
makensis -V2 -WX $defs base.nsi
ls -l out/launcher.exe "${IB_OUTFILE:-out/base.exe}"
sha256sum out/launcher.exe "${IB_OUTFILE:-out/base.exe}"
