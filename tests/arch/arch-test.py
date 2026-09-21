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

# What the plan chose, off the transparency screen (both engines print it
# since 2026-09-20; the `runtime` line's third value).
check("plan arch, 32-bit", machines.plan_arch("  Runtime:  node 9.11.2, 32-bit (x86)"), "x86")
check("plan arch, 64-bit", machines.plan_arch("  Runtime:  node 26.9.0, 64-bit (amd64)"), "amd64")
check("plan arch, arm64", machines.plan_arch("  Runtime:  java 21, 64-bit ARM (arm64)"), "arm64")
check("plan arch, universal",
      machines.plan_arch("  Runtime:  python 3.13, universal (several architectures in one build)"), "universal")
check("plan arch, with the engine's note",
      machines.plan_arch("  Runtime:  ruby 3.4, 32-bit (x86) -- this machine is 64-bit, but the plan "
                         "has no 64-bit build of ruby for this system"), "x86")
check("plan arch, an older plan with none", machines.plan_arch("  Runtime:  node"), "")
# The Unix engine wraps this line (ti_wrap 74 16), so the note after the
# architecture runs on, indented by 16 spaces.
check("plan arch, wrapped over three lines", machines.plan_arch_from_log(
      "IN SHORT\n"
      "  Runtime:      ruby 3.4.5, 32-bit (x86) -- this machine is 64-bit, but\n"
      "                the plan has no 64-bit build of ruby for this system\n"
      "  Download:     17.7 MB\n"), "x86")
check("plan arch, a wrap that splits before the architecture", machines.plan_arch_from_log(
      "  Runtime:      averyverylongruntimename 10.0.100-preview.7.25380.108,\n"
      "                64-bit (amd64)\n"), "amd64")
check("plan arch, from a whole log", machines.plan_arch_from_log(
      "WHAT\n  Project:  hello\n  Runtime:  go 1.27.1, 32-bit (x86)\n  Machine:  Linux, 2.36 (236), x86\n"), "x86")

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
check("a 32-bit plan on a 64-bit machine is allowed: the catalogue may have nothing else",
      machines.check("linux", "amd64", ["x86"], "x86"), [])
check("but an x86 runtime with no plan saying so is still caught",
      len(machines.check("linux", "amd64", ["x86"])), 1)
check("a 64-bit plan on a 32-bit machine fails before anything is installed",
      machines.check("debian12-i386", "x86", [], "amd64"),
      ["arch mismatch: debian12-i386 is x86 and cannot run the amd64 build the plan chose"])
check("a universal build is not a mismatch",
      machines.check("mac", "arm64", [], "universal"), [])
check("plan and engine disagreeing on a third architecture fails",
      len(machines.check("debian12-i386", "x86", [], "arm64")), 1)

# Every machine a harness can be pointed at must say what it is.
for t, m in machines.MACHINES.items():
    check(f"{t} has an architecture", m["arch"] in ("x86", "amd64", "arm64"), True)
    check(f"{t} says how we know", m["why"] in ("measured", "docs"), True)

print(f"\n{ok + bad} checks: {ok} pass, {bad} fail.")
sys.exit(1 if bad else 0)
