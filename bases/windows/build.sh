#!/bin/sh
# Build the Windows base: launcher.exe first (base.exe embeds it), then
# base.exe. Output goes to out/.
#
#   ./build.sh                       -> out/launcher.exe, out/base.exe
#   IB_BACKEND=http://host:port ./build.sh
#                                    -> a base with a different default backend
#   IB_OUTFILE=out/other.exe ./build.sh
set -eu
cd "$(dirname "$0")"
PATH="$HOME/.local/bin:$PATH"
export PATH
command -v makensis >/dev/null || { echo "makensis not found (expected ~/.local/bin/makensis)" >&2; exit 1; }
mkdir -p out

defs=""
[ -n "${IB_BACKEND:-}" ] && defs="$defs -DIB_BACKEND=$IB_BACKEND"
[ -n "${IB_OUTFILE:-}" ] && defs="$defs -DIB_OUTFILE=$IB_OUTFILE"

makensis -V2 -WX launcher.nsi
# shellcheck disable=SC2086
makensis -V2 -WX $defs base.nsi
ls -l out/launcher.exe "${IB_OUTFILE:-out/base.exe}"
sha256sum out/launcher.exe "${IB_OUTFILE:-out/base.exe}"
