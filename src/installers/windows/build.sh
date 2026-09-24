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
#                                       (default: ../../build_server/data/, which
#                                       the server writes on first start)
set -eu
cd "$(dirname "$0")"
PATH="$HOME/.local/bin:$PATH"
export PATH
command -v makensis >/dev/null || { echo "makensis not found (expected ~/.local/bin/makensis)" >&2; exit 1; }
mkdir -p out

# Refuse a plugin this repository does not expect (SHA256SUMS).
#
# tisig.dll performs every plan-signature check and every Merkle proof
# walk on Windows. makensis links whatever bytes sit at that path, and
# until 2026-09-24 the DLL's hash was recorded nowhere in the tree at
# all -- so the build validated the signing key exhaustively and then
# took the thing that uses it on faith.
ti_check_blobs() { # root file-relative-to-root...
	root=$1; shift
	sums=$root/SHA256SUMS
	[ -f "$sums" ] || { echo "no $sums to check binaries against" >&2; exit 1; }
	for f in "$@"; do
		[ -f "$root/$f" ] || { echo "$f is missing" >&2; exit 1; }
		want=$(awk -v p="$f" '$2 == p || $2 == "./" p { print $1; exit }' "$sums")
		[ -n "$want" ] || { echo "$f is not recorded in $sums" >&2; exit 1; }
		got=$(sha256sum "$root/$f" 2>/dev/null | cut -d" " -f1)
		[ "$got" = "$want" ] || { echo "$f does not match $sums ($got, expected $want)" >&2; exit 1; }
	done
}

ti_check_blobs "../../.." "src/installers/windows/plugins/x86-unicode/tisig.dll"

# The plan signing key (docs/format.md "Plan signature"): one line, base64 of 32 bytes.
keyfile=${TI_PLAN_PUBKEY_FILE:-../../build_server/data/plan-signing-key.pub}
[ -f "$keyfile" ] || { echo "no plan signing key at $keyfile: start the server once (it makes one), or set TI_PLAN_PUBKEY_FILE" >&2; exit 1; }
key=$(tr -d ' \r\n' < "$keyfile")
case $key in *[!A-Za-z0-9+/=]*) echo "$keyfile: not base64" >&2; exit 1 ;; esac
[ ${#key} -eq 44 ] && [ "$(printf '%s' "$key" | base64 -d 2>/dev/null | wc -c)" -eq 32 ] ||
	{ echo "$keyfile: not a 32-byte Ed25519 public key" >&2; exit 1; }
keyid=$(printf '%s' "$key" | base64 -d | sha256sum | cut -c1-16)

# Refuse a key this repository does not expect (plan-key.id). A base is
# where a wrong key does the most damage: it is baked in, shipped, and
# every installer built from it then checks plans against it and is
# satisfied. The pin is a second artifact, written at a different time,
# which is the only kind of check that catches this.
# TI_PIN_FILE= (empty) turns it off, for a test building a base with a
# throwaway key. Empty rather than absent, so it has to be meant.
pinfile=${TI_PIN_FILE-../../../plan-key.id}
if [ -f "$pinfile" ]; then
	# first line that is not blank and not a comment
	want=$(sed -e 's/[[:space:]]*$//' -e '/^[[:space:]]*#/d' -e '/^$/d' "$pinfile" | head -1)
	if [ -n "$want" ] && [ "$want" != "$keyid" ]; then
		echo "this is key $keyid, and $pinfile says builds from this repository use $want." >&2
		echo "  Refusing to bake it into a base. If the key really has been rotated," >&2
		echo "  change plan-key.id in the same commit." >&2
		exit 1
	fi
fi
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

# out/base-signed.exe is the mode A base: the server hands it out for
# every mode A job (src/build_server/lib/jobs.js, basePath), and mode A is the
# only mode whose base carries a signature. Nothing used to produce it,
# so after an engine change it kept whatever bytes it had, and every
# mode A installer shipped the previous engine. That happened on
# 2026-09-21 and was caught by hand; a build artifact that has to be
# remade on every engine change and that no script makes will be
# forgotten. So the build makes it, and `npm test` fails if it is ever
# older than base.exe (src/build_server/test/build.test.js).
#
# With the throwaway test certificate here, because that is what this
# tree has. A real signing certificate is not kept on disk, so a
# production build signs elsewhere: set TI_SIGN_CERT/TI_SIGN_KEY, or
# leave them empty and sign out/base.exe yourself into base-signed.exe.
if [ -z "${TI_OUTFILE:-}" ]; then
	cert=${TI_SIGN_CERT-out/test-publisher.crt}
	key=${TI_SIGN_KEY-out/test-publisher.key}
	if [ -n "$cert" ] && [ -f "$cert" ] && [ -f "$key" ]; then
		command -v osslsigncode > /dev/null ||
			{ echo "osslsigncode not found (expected ~/.local/bin/osslsigncode); cannot make out/base-signed.exe" >&2; exit 1; }
		osslsigncode sign -certs "$cert" -key "$key" -h sha256 \
			-n "TiddlyInstall TEST" -i https://tiddlyinstall.example \
			-in out/base.exe -out out/base-signed.exe.new > /dev/null ||
			{ echo "signing out/base-signed.exe failed" >&2; exit 1; }
		mv out/base-signed.exe.new out/base-signed.exe
		# A signature nobody checked is not a signature.
		osslsigncode verify -CAfile "$cert" out/base-signed.exe 2>&1 |
			grep -q '^Signature verification: ok$' ||
			{ echo "out/base-signed.exe does not verify against $cert" >&2; exit 1; }
		echo "signed out/base-signed.exe with $cert ($(openssl x509 -in "$cert" -noout -subject))"
	else
		echo "no signing certificate ($cert): out/base-signed.exe NOT remade, so mode A still ships the base it was last signed from" >&2
	fi
fi

ls -l out/launcher.exe "${TI_OUTFILE:-out/base.exe}"
sha256sum out/launcher.exe "${TI_OUTFILE:-out/base.exe}"
[ -f out/base-signed.exe ] && sha256sum out/base-signed.exe || true
