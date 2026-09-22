#!/bin/sh
# Build the tisig NSIS plugin: ../plugins/x86-unicode/tisig.dll.
#
# Needs llvm-mingw (https://github.com/mstorsjo/llvm-mingw, any recent
# release, msvcrt or ucrt: the DLL links no C runtime, only kernel32).
# Unpack it anywhere, no install needed, and point LLVM_MINGW at it:
#
#   LLVM_MINGW=~/.local/opt/llvm-mingw-20260908-msvcrt-ubuntu-22.04-x86_64 ./build.sh
#
# Also builds and runs the host test (RFC 8032 vectors) with cc.
set -eu
cd "$(dirname "$0")"
: "${LLVM_MINGW:=$(ls -d "$HOME"/.local/opt/llvm-mingw-* 2>/dev/null | tail -n 1)}"
cc_win=$LLVM_MINGW/bin/i686-w64-mingw32-clang
[ -x "$cc_win" ] || { echo "i686-w64-mingw32-clang not found; set LLVM_MINGW" >&2; exit 1; }

t=$(mktemp)
${CC:-cc} -O2 -Wall -Wno-sign-compare -o "$t" test_host.c plancheck.c ed25519_verify.c linepaint.c
"$t" rfc8032
rm -f "$t"

# -march=pentium-mmx: no SSE2 (XP-era CPUs). Subsystem/OS version 5.1 so
# XP's loader takes it. No CRT, no startup code: DllMain is the entry.
"$cc_win" -O2 -Wall -Wno-sign-compare -march=pentium-mmx -ffreestanding -fno-builtin \
	-fno-stack-protector -fno-asynchronous-unwind-tables \
	-shared -nostdlib -o ../plugins/x86-unicode/tisig.dll \
	tisig.c plancheck.c ed25519_verify.c linepaint.c \
	-Wl,--entry,_DllMain@12 -Wl,--major-subsystem-version,5 -Wl,--minor-subsystem-version,1 \
	-Wl,--major-os-version,5 -Wl,--minor-os-version,1 -Wl,--no-insert-timestamp -Wl,-s \
	-lkernel32 -luser32 "$($cc_win -print-libgcc-file-name)"
ls -l ../plugins/x86-unicode/tisig.dll
sha256sum ../plugins/x86-unicode/tisig.dll
