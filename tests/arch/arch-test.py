#!/usr/bin/env python3
"""The architecture checks, on their own: does a wrong-architecture cell fail?

usage: arch-test.py

The point of tests/arch/machines.py is that a cell can no longer be green
while the architecture is a lie. The dangerous case is quiet: a 32-bit
userland on a 64-bit kernel runs amd64 binaries perfectly well, so a plan
that handed an amd64 build to an i386 machine would install, launch, print
its hello and uninstall cleanly. These cases pin that down without a
machine, so the guard itself is tested rather than assumed.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import machines                                            # noqa: E402

ok = bad = 0


def check(what, got, want):
    global ok, bad
    if got == want:
        ok += 1
    else:
        bad += 1
        print(f"FAIL {what}\n  got  {got!r}\n  want {want!r}")


# ELF headers: class byte at 4, e_machine little-endian at 18.
def elf(machine, bits=32):
    h = bytearray(20)
    h[0:4] = b"\x7fELF"
    h[4] = 1 if bits == 32 else 2
    h[5] = 1
    h[18] = machine & 0xFF
    h[19] = machine >> 8
    return bytes(h)


I386, AMD64, ARM64 = elf(0x03, 32), elf(0x3E, 64), elf(0xB7, 64)

check("i386 ELF", machines.elf_arch(I386), ("x86", 32))
check("amd64 ELF", machines.elf_arch(AMD64), ("amd64", 64))
check("arm64 ELF", machines.elf_arch(ARM64), ("arm64", 64))
check("a shell script is not ELF", machines.elf_arch(b"#!/bin/sh\n" + b" " * 10), ("", 0))

probe = f"{I386.hex()} node\n{AMD64.hex()} cargo\n"
check("the probe's output", machines.elf_seen(probe),
      (["x86", "amd64"], ["node=x86/32", "cargo=amd64/64"]))

# What the engine writes about the machine it is running on.
check("engine, glibc x86", machines.from_osdesc("Linux, 2.36 (236), x86"), "x86")
check("engine, musl x86", machines.from_osdesc("Linux, musl libc (i386) (0), x86"), "x86")
check("engine, glibc amd64", machines.from_osdesc("Linux, 2.39 (239), amd64"), "amd64")
check("engine, macOS", machines.from_osdesc("macOS 26.2 arm64"), "arm64")
check("engine, Windows", machines.from_osdesc("Windows 10.0 build 19045, amd64"), "amd64")
check("engine, from a whole log",
      machines.from_log("TiddlyInstall engine 1\nRunning as /tmp/x.run on Linux, 2.36 (236), x86\n"), "x86")

# The guard itself.
check("a 32-bit machine running 32-bit code is fine",
      machines.check("debian12-i386", "x86", ["x86"]), [])
check("an amd64 machine running amd64 code is fine",
      machines.check("linux", "amd64", ["amd64"]), [])
check("the engine detecting the wrong architecture fails the cell",
      [m.split(":")[0] for m in machines.check("debian12-i386", "amd64", ["x86"])], ["arch mismatch"])
check("an amd64 runtime installed on a 32-bit machine fails the cell",
      len(machines.check("debian12-i386", "x86", ["amd64"])), 2)
check("an amd64 runtime beside a right one still fails",
      len(machines.check("debian12-i386", "x86", ["x86", "amd64"])), 1)
check("an unknown machine is an error, not a pass",
      len(machines.check("no-such-machine", "x86", ["x86"])), 1)
check("no evidence at all is not a failure",
      machines.check("linux", "", []), [])

# Every machine a harness can be pointed at must say what it is.
for t, m in machines.MACHINES.items():
    check(f"{t} has an architecture", m["arch"] in ("x86", "amd64", "arm64"), True)
    check(f"{t} says how we know", m["why"] in ("measured", "docs"), True)

print(f"\n{ok + bad} checks: {ok} pass, {bad} fail.")
sys.exit(1 if bad else 0)
