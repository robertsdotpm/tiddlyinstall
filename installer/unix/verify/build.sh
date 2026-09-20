#!/bin/sh
# Build the static tiverify binaries the Linux and macOS bases embed:
# bin/tiverify-<linux-x86_64|linux-aarch64|linux-i386|macos-x86_64|macos-arm64>.
#
# Needs Zig 0.11 or later (a tarball from the runtime store; unpack it
# anywhere) as ZIG, e.g.
#   ZIG=~/opt/zig-x86_64-linux-0.15.2/zig ./build.sh
# Linux builds link musl statically, so they run on any kernel of that
# CPU (CentOS 6 onwards). macOS builds need only libSystem; Zig ad-hoc
# signs the arm64 one (Apple Silicon refuses unsigned code).
#
# Then checks the host (x86_64 Linux) binary against the RFC 8032 vectors.
set -eu
cd "$(dirname "$0")"
: "${ZIG:=zig}"
src="tiverify.c ../../windows/plugin-src/plancheck.c ../../windows/plugin-src/ed25519_verify.c"
mkdir -p bin
for t in x86_64-linux-musl:linux-x86_64 aarch64-linux-musl:linux-aarch64 x86-linux-musl:linux-i386 \
	x86_64-macos:macos-x86_64 aarch64-macos:macos-arm64; do
	target=${t%%:*} name=${t#*:}
	flags="-static"
	case $target in *macos*) flags="" ;; esac
	# shellcheck disable=SC2086
	"$ZIG" cc -target "$target" -Os -s $flags -fno-sanitize=all -fno-stack-protector \
		-Wall -Wno-sign-compare -o "bin/tiverify-$name" $src
done
rm -f bin/*.o
sh ./selftest.sh bin/tiverify-linux-x86_64
ls -l bin
(cd bin && sha256sum tiverify-*)
