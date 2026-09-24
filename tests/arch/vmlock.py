#!/usr/bin/env python3
"""One test harness at a time per machine.

Four harnesses (tests/matrix, tests/templates, tests/tooling,
tests/fidelity) install and uninstall apps into the same folders on the
same VMs -- `C:\\ti`, `%LOCALAPPDATA%\\ti`, `~/.local/share/ti`,
`~/Library/ti` -- and one of them cleans up by deleting *everything*
under those roots. Two at once do not produce two sets of results; they
produce two sets of wrong results, and on 2026-09-20 they cost four real
cells (a Windows 7 scp refused mid-run, a session that died during an
install, two macOS runs deleting each other's install root, and two
behaviour.py runs racing on C:\\tibtest).

The interlock until now was `if exist C:\\titest echo BUSY`, which only
notices a harness that happens to be between cells with its folder
present, says nothing about who holds it, and cannot tell a live run from
one that was killed an hour ago.

This is a real lock:

- **Atomic.** `mkdir` of the lock directory fails if it already exists,
  on both cmd and sh, so two harnesses cannot both think they took it.
- **It says who.** The directory holds a `holder` line naming the user,
  this machine, the harness, its target, its pid and when it started, so
  a blocked run can print something more useful than "busy".
- **It goes stale.** The holder refreshes a heartbeat while it works; a
  lock whose heartbeat has not moved for `STALE` seconds is taken over,
  and the takeover is printed, because a killed harness must not wedge a
  VM until someone notices.

usage:

    from vmlock import VMLock
    with VMLock(host="user@host", windows=True, who="matrix 7") as lock:
        ...                       # the machine is ours for the duration

`VMLock(..., wait=0)` raises `Busy` at once instead of waiting.
`TI_NO_VMLOCK=1` in the environment skips locking entirely, for running
two harnesses against one machine on purpose.
"""
import os
import re
import socket
import subprocess
import sys
import threading
import time

LOCK_WIN = r"C:\tilock"
LOCK_UNIX = "$HOME/.tilock"
STALE = 900          # 15 minutes without a heartbeat: the holder is gone
BEAT = 120           # the holder refreshes this often
WAIT = 3 * 3600      # how long a blocked harness waits by default


class Busy(Exception):
    """Another harness holds the machine."""


def _sh(cmd, timeout=60):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace")
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timed out"


class VMLock:
    def __init__(self, host, windows, who, wait=WAIT, quiet=False):
        self.host, self.windows, self.who = host, windows, who
        self.wait, self.quiet = wait, quiet
        self.dir = LOCK_WIN if windows else LOCK_UNIX
        self.held = False
        self._stop = threading.Event()
        self._beat = None
        self.skip = os.environ.get("TI_NO_VMLOCK") == "1" or not host

    # ---- the three shell one-liners, in cmd and in sh ----------------

    def _line(self):
        return (f"holder\t{os.environ.get('USER', '?')}@{socket.gethostname()}\t{self.who}"
                f"\tpid {os.getpid()}\tsince {time.strftime('%Y-%m-%dT%H:%M:%S')}")

    def _take(self):
        """Try to create the lock. Returns (True, '') or (False, holder)."""
        line = self._line()
        if self.windows:
            cmd = (f'cmd /c "mkdir {self.dir} 2>nul && ('
                   f'echo {line}> {self.dir}\\holder & echo @TOOK'
                   f') || (type {self.dir}\\holder 2>nul & echo @HELD)"')
        else:
            cmd = (f"sh -c 'if mkdir {self.dir} 2>/dev/null; then "
                   f"printf \"%s\\n\" \"{line}\" > {self.dir}/holder; echo @TOOK; "
                   f"else cat {self.dir}/holder 2>/dev/null; echo @HELD; fi'")
        code, out, err = _sh(["ssh", "-o", "BatchMode=yes", self.host, cmd], timeout=90)
        if code:
            # A machine we cannot reach is not a machine we can lock; let
            # the harness get on and fail its cells with a real reason.
            return True, f"(could not reach {self.host} to lock it: {err.strip()[:80]})"
        if "@TOOK" in out:
            return True, ""
        return False, "\n".join(l for l in out.splitlines() if l.startswith("holder")) or "(no holder line)"

    def _age(self):
        """Seconds since the holder's heartbeat, or None if it is gone."""
        if self.windows:
            cmd = (f'cmd /c "powershell -NoProfile -Command '
                   f'\\"if (Test-Path {self.dir}\\holder) {{ '
                   f'[int]((Get-Date) - (Get-Item {self.dir}\\holder).LastWriteTime).TotalSeconds }}\\""')
        else:
            # GNU first, then BSD -- and check that what came back is a
            # number, both times.
            #
            # It used to be `stat -f %m || stat -c %Y`, which reads as
            # "try BSD, fall back to GNU" and is not what happens. On GNU
            # coreutils `-f` is not a format flag, it is "show the
            # filesystem this file is on", and it *succeeds*: `stat -f %m
            # holder` prints a block of filesystem statistics and exits 0,
            # so the `||` never fires, $m is six lines of prose, and
            # $((now - m)) is "Illegal number". _age() returned None for
            # every Linux VM, which is every Linux VM in the lab, so the
            # stale-lock takeover this file exists for has never once run
            # on one. Found when a lock left by a killed run at 21:39
            # stopped the matrix dead at 21:58 -- 15-minute staleness,
            # measured never.
            cmd = (f"sh -c 'f={self.dir}/holder; [ -f \"$f\" ] || exit 0; "
                   f"now=$(date +%s); m=$(stat -c %Y \"$f\" 2>/dev/null); "
                   f"case \"$m\" in \"\"|*[!0-9]*) m=$(stat -f %m \"$f\" 2>/dev/null) ;; esac; "
                   f"case \"$m\" in \"\"|*[!0-9]*) exit 0 ;; esac; "
                   f"echo $((now - m))'")
        code, out, _ = _sh(["ssh", "-o", "BatchMode=yes", self.host, cmd], timeout=90)
        if code != 0:
            return None
        # The last all-digits line, not the first number anywhere in the
        # output: a shell that printed a warning first must not be read as
        # an age.
        for line in reversed((out or "").splitlines()):
            line = line.strip()
            if re.fullmatch(r"\d+", line):
                return int(line)
        return None

    def _touch(self):
        if self.windows:
            cmd = f'cmd /c "echo {self._line()}> {self.dir}\\holder"'
        else:
            cmd = f"sh -c 'printf \"%s\\n\" \"{self._line()}\" > {self.dir}/holder'"
        _sh(["ssh", "-o", "BatchMode=yes", self.host, cmd], timeout=90)

    def _break(self):
        rm = f'cmd /c "rd /s /q {self.dir}"' if self.windows else f"sh -c 'rm -rf {self.dir}'"
        _sh(["ssh", "-o", "BatchMode=yes", self.host, rm], timeout=90)

    # ---- the loop ----------------------------------------------------

    def acquire(self):
        if self.skip:
            return self
        t0 = time.time()
        said = False
        while True:
            ok, holder = self._take()
            if ok:
                self.held = not holder            # a warning means we never really locked
                if holder and not self.quiet:
                    print(holder, flush=True)
                break
            age = self._age()
            if age is not None and age > STALE:
                print(f"vmlock: {self.host} was left locked {age}s ago and the holder has not "
                      f"moved since; taking it over.\n  was: {holder}", flush=True)
                self._break()
                continue
            if not said and not self.quiet:
                print(f"vmlock: waiting for {self.host}\n  {holder}", flush=True)
                said = True
            if time.time() - t0 > self.wait:
                raise Busy(f"{self.host} is still held after {int(time.time() - t0)}s: {holder}")
            time.sleep(30)
        if self.held:
            self._beat = threading.Thread(target=self._heartbeat, daemon=True)
            self._beat.start()
        return self

    def _heartbeat(self):
        while not self._stop.wait(BEAT):
            self._touch()

    def release(self):
        self._stop.set()
        if self.held:
            self._break()
            self.held = False

    def __enter__(self):
        return self.acquire()

    def __exit__(self, *exc):
        self.release()
        return False


# Where a harness's target lives, from the tables it already has. Returns
# ("", False) for anything that runs on this machine in a throwaway HOME
# (local linux, the container sandboxes): those do not collide.
def target_host(target, windows=None, linux_vms=None, mac=""):
    if windows and target in windows:
        e = windows[target]
        return (e[0] if isinstance(e, (list, tuple)) else e), True
    if linux_vms and target in linux_vms:
        return linux_vms[target], False
    if target == "mac" and mac:
        return mac, False
    return "", False


def main():
    """vmlock.py <ssh-target> windows|unix [status|break]"""
    if len(sys.argv) < 3:
        raise SystemExit(main.__doc__)
    lock = VMLock(sys.argv[1], sys.argv[2] == "windows", "vmlock.py", wait=0)
    what = sys.argv[3] if len(sys.argv) > 3 else "status"
    if what == "break":
        lock._break()
        print("broken")
        return
    ok, holder = lock._take()
    if ok:
        lock._break()
        print("free")
    else:
        print(f"held ({lock._age()}s since the last heartbeat)\n  {holder}")


if __name__ == "__main__":
    main()
