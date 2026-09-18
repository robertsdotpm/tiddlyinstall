# Sourced by make_run.sh and make_app.sh: copy the engine ($1) to $2 with
# the plan signing key (docs/format.md "Plan signature") filled in.
#
# The key comes from IB_PLAN_PUBKEY_FILE, default ../../server/data/
# plan-signing-key.pub, which the server writes on first start: one line,
# base64 of the raw 32-byte Ed25519 public key.
bake_engine() {
	keyfile=${IB_PLAN_PUBKEY_FILE:-$here/../../server/data/plan-signing-key.pub}
	[ -f "$keyfile" ] || { echo "no plan signing key at $keyfile: start the server once (it makes one), or set IB_PLAN_PUBKEY_FILE" >&2; exit 1; }
	key=$(tr -d ' \r\n' < "$keyfile")
	case $key in *[!A-Za-z0-9+/=]*) echo "$keyfile: not base64" >&2; exit 1 ;; esac
	[ ${#key} -eq 44 ] && [ "$(printf '%s' "$key" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' ')" = 32 ] ||
		{ echo "$keyfile: not a 32-byte Ed25519 public key" >&2; exit 1; }
	keyid=$(printf '%s' "$key" | openssl base64 -d -A | openssl dgst -sha256 | awk '{ print substr($NF, 1, 16) }')
	[ "$(grep -c '^IB_PLAN_PUBKEY=$' "$1")" = 1 ] && [ "$(grep -c '^IB_PLAN_KEYID=$' "$1")" = 1 ] ||
		{ echo "$1: no empty IB_PLAN_PUBKEY= / IB_PLAN_KEYID= lines to fill" >&2; exit 1; }
	sed -e "s|^IB_PLAN_PUBKEY=\$|IB_PLAN_PUBKEY=$key|" -e "s|^IB_PLAN_KEYID=\$|IB_PLAN_KEYID=$keyid|" "$1" > "$2"
	echo "plan signing key $keyid ($keyfile)"
}
