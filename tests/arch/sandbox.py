#!/usr/bin/env python3
"""Run a shell script inside a 32-bit (i386) Linux root on this machine.

The `.run` engine is a POSIX shell script, so most of what it does on a
32-bit machine can be checked here for nothing: a 32-bit root filesystem
(tests/arch/mkroot.py) entered with bubblewrap, under a 32-bit personality
(`linux32`) so `uname -m` says i686 and the engine's own arch detection
takes its x86 branch.

What this is honest about (see docs/test-results.md, "32-bit Linux"):

  * it IS a 32-bit userland -- i386 ELF, `/lib/ld-linux.so.2`, a 32-bit
    `ldconfig` cache, musl or glibc as the root says, and `uname -m` = i686;
  * it is NOT a 32-bit machine: the kernel is the host's x86_64 one, so
    `uname -r`'s kernel is 64-bit, there is no 4 GB address-space ceiling
    and no PAE behaviour;
  * there is no display, no D-Bus, no XDG menu daemon and no system-wide
    install, so desktop entries, menu entries and root installs are
    untested here and say so;
  * nothing outside the root is visible except the build output (read-only
    at /ibsrc) and the network, which is shared with the host so the build
    server and the LAN mirror are reachable at the same addresses.

usage (as a module):
    from sandbox import SANDBOXES, run_script
    rc, out, err = run_script("debian12-i386", script, env={...}, ro={src: "/ibsrc"})

usage (from the shell, for poking around):
    python3 sandbox.py debian12-i386 -- uname -m
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOTS = Path(os.environ.get("TI_ROOTS", Path.home() / ".local/share/ti-testroots"))

# name -> what the report should call it, and what it really is.
SANDBOXES = {
    "debian12-i386": {
        "label": "Debian 12 i386", "arch": "x86", "libc": "glibc", "family": "linux",
        "kind": "container", "note": "32-bit userland on this machine's 64-bit kernel",
    },
    "debian12-i386-libs": {
        "label": "Debian 12 i386 +libs", "arch": "x86", "libc": "glibc", "family": "linux",
        "kind": "container", "note": "the same root with libatomic1, for the satisfied half of a `need` check",
    },
    "alpine324-i386": {
        "label": "Alpine 3.24 x86", "arch": "x86", "libc": "musl", "family": "linux",
        "kind": "container", "note": "32-bit userland on this machine's 64-bit kernel",
    },
}


def available(name):
    return (ROOTS / name / ".ti-root").exists()


def _bwrap(root, ro, env, chdir="/home/ti", uid=1000):
    cmd = [
        "linux32",                      # the 32-bit personality: uname -m = i686
        "bwrap",
        "--bind", str(root), "/",
        "--proc", "/proc", "--dev", "/dev",
        "--tmpfs", "/tmp", "--tmpfs", "/run", "--tmpfs", "/var/tmp",
        "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
        "--uid", str(uid), "--gid", str(uid),
        "--hostname", "ti32",
        "--die-with-parent", "--new-session",
        "--chdir", chdir,
    ]
    for src, dest in (ro or {}).items():
        cmd += ["--ro-bind", str(src), dest]
    for k, v in (env or {}).items():
        cmd += ["--setenv", k, str(v)]
    return cmd


def run_script(name, script, env=None, ro=None, timeout=1800, uid=1000, keep=False, copy=True):
    """Run `script` with /bin/sh inside the named 32-bit root.

    With `copy` (the default) the root is copied first, so a cell can
    install system-wide, write to /etc and leave the root dirty without the
    next cell seeing it; `copy=False` changes the root itself, which is
    what tests/arch/mkroot.py's provisioning step wants. Returns
    (rc, out, err); rc 124 means it ran out of time.
    """
    src = ROOTS / name
    if not (src / ".ti-root").exists():
        raise FileNotFoundError(f"no 32-bit root {name} in {ROOTS}: run tests/arch/mkroot.py")
    work = None
    if copy:
        work = Path(tempfile.mkdtemp(prefix=f"ti32-{name}-", dir=os.environ.get("TMPDIR", "/tmp")))
        root = work / "root"
    else:
        root = src
    try:
        if copy:
            subprocess.run(["cp", "-a", "--reflink=auto", str(src), str(root)], check=True)
        (root / "home/ti").mkdir(parents=True, exist_ok=True)
        cmd = _bwrap(root, ro, env, uid=uid) + ["--", "/bin/sh", "-s"]
        try:
            p = subprocess.run(cmd, input=script, capture_output=True, text=True,
                               errors="replace", timeout=timeout)
            return p.returncode, p.stdout, p.stderr
        except subprocess.TimeoutExpired as e:
            out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            return 124, out, f"timed out after {timeout}s"
    finally:
        if work and keep:
            print(f"(kept {root})", file=sys.stderr)
        elif work:
            subprocess.run(["chmod", "-R", "u+w", str(work)], capture_output=True)
            shutil.rmtree(work, ignore_errors=True)


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    name = sys.argv[1]
    rest = sys.argv[2:]
    if rest and rest[0] == "--":
        rest = rest[1:]
    script = " ".join(rest) if rest else sys.stdin.read()
    rc, out, err = run_script(name, script, env={"HOME": "/home/ti", "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"})
    sys.stdout.write(out)
    sys.stderr.write(err)
    return rc


if __name__ == "__main__":
    sys.exit(main())
