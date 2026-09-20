# Sourced by make_run.sh and make_app.sh: copy the engine ($1) to $2 with
# the plan signing key (docs/format.md "Plan signature") filled in.
#
# The key comes from TI_PLAN_PUBKEY_FILE, default ../../server/data/
# plan-signing-key.pub, which the server writes on first start: one line,
# base64 of the raw 32-byte Ed25519 public key.
bake_engine() {
	keyfile=${TI_PLAN_PUBKEY_FILE:-$here/../../server/data/plan-signing-key.pub}
	[ -f "$keyfile" ] || { echo "no plan signing key at $keyfile: start the server once (it makes one), or set TI_PLAN_PUBKEY_FILE" >&2; exit 1; }
	key=$(tr -d ' \r\n' < "$keyfile")
	case $key in *[!A-Za-z0-9+/=]*) echo "$keyfile: not base64" >&2; exit 1 ;; esac
	[ ${#key} -eq 44 ] && [ "$(printf '%s' "$key" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')" = 32 ] ||
		{ echo "$keyfile: not a 32-byte Ed25519 public key" >&2; exit 1; }
	keyid=$(printf '%s' "$key" | openssl base64 -d -A | openssl dgst -sha256 | awk '{ print substr($NF, 1, 16) }')
	[ "$(grep -c '^TI_PLAN_PUBKEY=$' "$1")" = 1 ] && [ "$(grep -c '^TI_PLAN_KEYID=$' "$1")" = 1 ] ||
		{ echo "$1: no empty TI_PLAN_PUBKEY= / TI_PLAN_KEYID= lines to fill" >&2; exit 1; }
	# When this base was built. The engine uses it as the floor below which
	# a machine's clock cannot be believed (design.md 7.1, "Clocks"): the
	# real time is certainly not earlier than the build. SOURCE_DATE_EPOCH
	# is honoured, so a reproducible build stays reproducible.
	build_epoch=${SOURCE_DATE_EPOCH:-$(date -u +%s)}
	case $build_epoch in '' | *[!0-9]*) echo "bad SOURCE_DATE_EPOCH" >&2; exit 1 ;; esac
	build_time=$(date -u -d "@$build_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null ||
		date -u -r "$build_epoch" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ)
	[ "$(grep -c '^TI_BUILD_TIME=$' "$1")" = 1 ] && [ "$(grep -c '^TI_BUILD_EPOCH=$' "$1")" = 1 ] ||
		{ echo "$1: no empty TI_BUILD_TIME= / TI_BUILD_EPOCH= lines to fill" >&2; exit 1; }
	sed -e "s|^TI_PLAN_PUBKEY=\$|TI_PLAN_PUBKEY=$key|" -e "s|^TI_PLAN_KEYID=\$|TI_PLAN_KEYID=$keyid|" \
		-e "s|^TI_BUILD_TIME=\$|TI_BUILD_TIME=$build_time|" -e "s|^TI_BUILD_EPOCH=\$|TI_BUILD_EPOCH=$build_epoch|" "$1" > "$2"
	echo "plan signing key $keyid ($keyfile); built $build_time"
}
