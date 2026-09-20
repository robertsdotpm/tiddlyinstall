#!/bin/sh
# selftest.sh IBVERIFY: RFC 8032 section 7.1 vectors 2 and 3 must verify,
# and each with one changed message byte must not.
set -u
v=$1
b() { printf '%s' "$1" | xxd -r -p | base64 -w0 2>/dev/null || printf '%s' "$1" | xxd -r -p | base64; }
fails=0
t() { # name pk-hex msg-hex sig-hex want-exit
	pk=$(b "$2") sig=$(b "$4")
	printf '%s' "$3" | xxd -r -p | "$v" "$pk" "$sig"
	got=$?
	if [ "$got" = "$5" ]; then echo "ok   $1"; else echo "FAIL $1 (exit $got, want $5)"; fails=$((fails + 1)); fi
}
t "vector 2" 3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c 72 \
	92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00 0
t "vector 2 tampered" 3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c 73 \
	92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00 1
t "vector 3" fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025 af82 \
	6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a 0
t "vector 3 tampered" fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025 af83 \
	6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a 1
"$v" x y < /dev/null; [ $? = 2 ] && echo "ok   usage" || { echo "FAIL usage"; fails=$((fails + 1)); }
[ $fails = 0 ]
