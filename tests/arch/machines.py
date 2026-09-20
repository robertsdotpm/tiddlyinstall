#!/usr/bin/env python3
"""One place that says which architecture each test machine is.

Every harness (tests/matrix, tests/templates, tests/fidelity) records the
architecture of the machine a cell ran on, and every grid in
docs/test-results.md shows it, so "python on Linux passes" can never again
mean "on amd64 only" (docs/design.md 11.0, added 2026-09-20).

`arch` here is what we *claim* a machine is. It is not trusted: each run
also records what the installer's own engine detected (`arch_seen`,
parsed from the install log) and, on Unix, the ELF class of the runtime
that was actually installed (`arch_binary`). `check()` turns a
disagreement into a failed cell rather than a green one -- the false
green is real, because a 32-bit userland on a 64-bit kernel runs 64-bit
binaries perfectly well, so a plan that picked the wrong build would
otherwise pass.

usage: machines.py            list the machines, their arch and where the
                              arch came from
"""

# id -> label, family, arch, libc, kind, how we know the arch.
#
# "measured" means `uname -m` or %PROCESSOR_ARCHITECTURE% was read off the
# machine on 2026-09-20; "docs" means docs/test-vms.md says so.
MACHINES = {
    # Windows (docs/test-vms.md)
    "xp":        dict(label="XP",              family="windows", arch="x86",   kind="vm",   why="measured"),
    "vista":     dict(label="Vista",           family="windows", arch="x86",   kind="vm",   why="measured"),
    "7":         dict(label="Win 7",           family="windows", arch="amd64", kind="vm",   why="docs"),
    "8.1":       dict(label="Win 8.1",         family="windows", arch="amd64", kind="vm",   why="measured"),
    "10":        dict(label="Win 10",          family="windows", arch="amd64", kind="vm",   why="docs"),
    "11":        dict(label="Win 11",          family="windows", arch="amd64", kind="vm",   why="measured"),
    "2022":      dict(label="Srv 2022",        family="windows", arch="amd64", kind="vm",   why="measured"),
    "10x86":     dict(label="Win 10 x86",      family="windows", arch="x86",   kind="vm",   why="docs"),
    "ltsc2021":  dict(label="LTSC 2021",       family="windows", arch="amd64", kind="vm",   why="docs"),
    "ltsc2024":  dict(label="LTSC 2024",       family="windows", arch="amd64", kind="vm",   why="docs"),
    "11de":      dict(label="Win 11 DE (Jörg)", family="windows", arch="amd64", kind="vm",  why="docs"),
    "2025core":  dict(label="Srv 2025 Core",   family="windows", arch="amd64", kind="vm",   why="measured"),
    # Linux VMs on the ESXi host, all 64-bit (docs/test-vms.md)
    "centos6":   dict(label="CentOS 6",        family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "centos7":   dict(label="CentOS 7",        family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "ubuntu1404": dict(label="Ubuntu 14.04",   family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "ubuntu1604": dict(label="Ubuntu 16.04",   family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "ubuntu1804": dict(label="Ubuntu 18.04",   family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "rocky8":    dict(label="Rocky 8",         family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "ubuntu2004": dict(label="Ubuntu 20.04",   family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "ubuntu2204": dict(label="Ubuntu 22.04",   family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "debian12":  dict(label="Debian 12",       family="linux", arch="amd64", libc="glibc", kind="vm", why="measured"),
    "alpine":    dict(label="Alpine 3.24",     family="linux", arch="amd64", libc="musl",  kind="vm", why="measured"),
    # This machine
    "linux":     dict(label="Ubuntu 24.04 (here)", family="linux", arch="amd64", libc="glibc", kind="host", why="measured"),
    # 32-bit Linux, in a container on this machine (tests/arch/sandbox.py)
    "debian12-i386": dict(label="Debian 12 i386", family="linux", arch="x86", libc="glibc", kind="container",
                          why="measured", note="32-bit userland on this machine's 64-bit kernel"),
    "debian12-i386-libs": dict(label="Debian 12 i386 +libs", family="linux", arch="x86", libc="glibc",
                               kind="container", why="measured",
                               note="the same root with libatomic1: the satisfied half of a `need` check"),
    "alpine324-i386": dict(label="Alpine 3.24 x86", family="linux", arch="x86", libc="musl", kind="container",
                           why="measured", note="32-bit userland on this machine's 64-bit kernel"),
    # macOS
    "mac":       dict(label="macOS 26",        family="macos", arch="arm64", kind="mac", why="docs"),
}

# How an arch is written in the three places it turns up.
UNAME = {"x86_64": "amd64", "amd64": "amd64", "i386": "x86", "i486": "x86", "i586": "x86",
         "i686": "x86", "x86": "x86", "aarch64": "arm64", "arm64": "arm64"}
WINENV = {"AMD64": "amd64", "x86": "x86", "ARM64": "arm64", "IA64": "ia64"}
# ELF: e_machine (bytes 18-19, little endian) -> our name, and the class byte.
ELF_MACHINE = {0x03: "x86", 0x3E: "amd64", 0xB7: "arm64", 0x28: "arm"}
ELF_BITS = {"x86": 32, "amd64": 64, "arm64": 64}

SHORT = {"amd64": "64", "x86": "32", "arm64": "a64"}


def arch_of(target):
    return (MACHINES.get(target) or {}).get("arch", "?")


def label_of(target, with_arch=True):
    m = MACHINES.get(target)
    if not m:
        return target
    return f"{m['label']} ({m['arch']})" if with_arch else m["label"]


def from_osdesc(desc):
    """The arch the engine detected, out of its own IB_OSDESC line.

    The engine writes "Linux, 2.36 (236), x86", "Linux, musl libc (i386)
    (0), x86" or "macOS 26.2 arm64" (bases/unix/ib-engine.sh,
    ib_detect_os), so the arch is the last comma-or-space separated word.
    """
    if not desc:
        return ""
    last = desc.replace(",", " ").split()
    return last[-1] if last else ""


def from_log(log):
    """The engine's detected arch from an install log ("Running as X on Y")."""
    for line in (log or "").splitlines():
        i = line.find(" on ")
        if line.lstrip().startswith("Running as ") and i > 0:
            return from_osdesc(line[i + 4:].strip())
    return ""


def elf_arch(head):
    """(arch, bits) of an ELF file from its first 20 bytes, or ("", 0)."""
    if len(head) < 20 or head[:4] != b"\x7fELF":
        return "", 0
    bits = {1: 32, 2: 64}.get(head[4], 0)
    machine = head[18] | (head[19] << 8) if head[5] == 1 else (head[18] << 8) | head[19]
    return ELF_MACHINE.get(machine, f"elf:{machine:#x}"), bits


# Dropped into the Unix harness scripts: the arch of what was actually
# installed. A 32-bit userland on a 64-bit kernel runs amd64 binaries
# happily, so without this a plan that picked the wrong build passes.
ELF_PROBE_SH = r'''
ib_elf_probe() { # $1: the install root
  find "$1" -maxdepth 3 -type f -perm -u+x 2>/dev/null | head -60 | while read -r f; do
    h=$(od -An -N20 -v -t x1 "$f" 2>/dev/null | tr -d ' \n')
    case $h in 7f454c46*) echo "$h ${f##*/}" ;; esac
  done | head -8
}
'''


def elf_seen(text):
    """(arches, lines) from what ib_elf_probe printed."""
    arches, lines = [], []
    for line in (text or "").splitlines():
        parts = line.split()
        if not parts or len(parts[0]) < 40:
            continue
        a, bits = elf_arch(bytes.fromhex(parts[0][:40]))
        if not a:
            continue
        lines.append(f"{parts[1] if len(parts) > 1 else '?'}={a}/{bits}")
        if a not in arches:
            arches.append(a)
    return arches, lines


def check(target, arch_seen="", elf_arches=()):
    """Every way this cell's architecture could be a lie, as a list of
    messages. Empty means the cell really ran where it says it did."""
    want = arch_of(target)
    bad = []
    if want == "?":
        return [f"no architecture recorded for {target}: add it to tests/arch/machines.py"]
    if arch_seen and arch_seen != want:
        bad.append(f"arch mismatch: {target} is {want}, but the installer's engine detected {arch_seen}")
    elf_arches = list(elf_arches)
    if elf_arches:
        if want not in elf_arches:
            bad.append(f"arch mismatch: {target} is {want}, but it installed {'/'.join(elf_arches)} binaries")
        # On a 32-bit machine a 64-bit binary is always wrong, even beside
        # right ones: a real i386 machine could not have run it.
        wrong = [a for a in elf_arches if ELF_BITS.get(a, 64) > ELF_BITS.get(want, 64)]
        if wrong:
            bad.append(f"arch mismatch: {target} is {want}, but it installed {'/'.join(wrong)} binaries too")
    return bad


def judge(target, parts, result, detail):
    """Fold the architecture checks into a cell's result, for a harness that
    has parsed its run's @markers into `parts`.

    Returns (result, detail, extras). A cell that passed every other check
    but ran on, or installed, the wrong architecture fails here; the extras
    go into the result row, so a grid can say what each cell really ran on.
    """
    first = (parts.get("osdesc_out", "") or "").strip().splitlines()
    seen = from_osdesc(first[0]) if first else from_log(parts.get("log_out", ""))
    elf, elf_lines = elf_seen(parts.get("elf_out", ""))
    extras = {"arch": arch_of(target), "arch_seen": seen, "arch_elf": elf}
    if elf_lines:
        extras["arch_elf_files"] = elf_lines
    bad = check(target, seen, elf if result == "pass" else ())
    if bad:
        return "fail", "; ".join(bad) + (f" ({detail})" if detail else ""), extras
    return result, detail, extras


def main():
    w = max(len(k) for k in MACHINES)
    print(f"{'id'.ljust(w)}  arch   libc   kind       how        label")
    for k, m in MACHINES.items():
        print(f"{k.ljust(w)}  {m['arch']:<6} {m.get('libc', '-'):<6} {m['kind']:<10} "
              f"{m['why']:<10} {m['label']}" + (f"  -- {m['note']}" if m.get("note") else ""))
    n32 = sum(1 for m in MACHINES.values() if m["arch"] == "x86")
    print(f"\n{len(MACHINES)} machines: {n32} are 32-bit, "
          f"{sum(1 for m in MACHINES.values() if m['arch'] == 'amd64')} amd64, "
          f"{sum(1 for m in MACHINES.values() if m['arch'] == 'arm64')} arm64.")


if __name__ == "__main__":
    main()
