#!/usr/bin/env python3
"""Install and run the fidelity projects on a test machine (docs/test-results.md, "Real-app fidelity").

usage: run.py TARGET [--only python,ruby] [--out DIR] [--results FILE] [--label TEXT]

Installers come from build.mjs's output (DIR/builds.json, default
tests/fidelity/out; the Mac's from DIR-mac). TARGET is `linux` (this
machine, in a throwaway home), a Linux VM from LINUX_VMS, a 32-bit Linux
container from tests/arch/sandbox.py, a Windows VM from WINDOWS, or `mac`. Each cell: install unattended, run the app through its
launcher, read its "FID ok|fail|skip <check>" lines, uninstall, and check
nothing is left. One JSON object per cell is appended to --results
(default results/<date>.jsonl); the install log and the app's output go to
DIR/logs/<target>/<id>.txt.
"""
import argparse
import atexit
import base64
import hashlib
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "arch"))
import machines                                            # noqa: E402
import vmlock                                              # noqa: E402
MAC = "Matthew@the-mac-test-host"
WINDOWS = {"7": "x@10.0.1.231", "10": "matth@10.0.1.199", "8.1": "x@10.0.1.165", "11": "matth@10.0.1.123",
           "2022": "administrator@10.0.1.248"}
LINUX_VMS = {
    "centos7": "x@10.0.1.221", "ubuntu1804": "x@10.0.1.144", "rocky8": "x@10.0.1.131",
    "ubuntu2004": "x@10.0.1.118", "ubuntu2204": "x@10.0.1.203", "debian12": "x@10.0.1.235",
    "alpine": "x@10.0.1.200",
    # The 32-bit VM (docs/test-vms.md). Fill in its address once
    # tools/esxi_provision_debian_i386.py has made it and DHCP has given
    # it one; tests/arch/machines.py already knows what it is.
    # "debian12x86": "x@10.0.1.??",
}
# 32-bit Linux, in a container on this machine (tests/arch/sandbox.py).
SANDBOXES = ("debian12-i386", "debian12-i386-libs", "alpine324-i386")
TIMEOUT = 3600


def sh(cmd, timeout=TIMEOUT, **kw):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace", **kw)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, out, f"timed out after {timeout}s"


def tail(s, n=8):
    return " / ".join(s.strip().splitlines()[-n:])


def markers(out):
    """@key value lines, and the lines after each as key_out."""
    parts, cur = {}, None
    for line in out.splitlines():
        line = line.rstrip("\r")
        if line.startswith("@") and " " not in line[1:].split(" ")[0] and line[1:2].isalpha():
            k, _, v = line[1:].partition(" ")
            parts[k], cur = v, k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    return parts


def plan_fails(log):
    for line in log.splitlines():
        if "needs system packages" in line or "needs administrator rights" in line:
            return "needs root: " + line.strip()
        if "nothing for this machine" in line or ("No " in line and "release in the catalogue runs" in line):
            return line.strip()
        if "no install plan for this version of Windows" in line:
            return line.strip()
    return None


def judge(b, parts, err=""):
    """(result, detail, checks) from a run's markers."""
    log = parts.get("log_out", "")
    checks = {}
    for line in parts.get("out_out", "").splitlines():
        w = line.strip().split(" ", 2)
        if len(w) >= 3 and w[0] == "FID" and w[1] in ("ok", "fail", "skip"):
            name, _, detail = w[2].partition(": ")
            checks[name] = [w[1], detail]
    if parts.get("install") != "0":
        reason = plan_fails(log)
        if reason:
            # The plan having no block for this machine at all is untested,
            # not n/a: the catalogue's own verdict is a `fail` block.
            no_block = "nothing for this machine" in reason or "no install plan for" in reason
            return ("no-plan" if no_block else "n/a"), reason, checks
        return "fail", f"install exit {parts.get('install')}: " + tail(log + err, 8), checks
    ended = "FID end" in parts.get("out_out", "")
    missing = [c for c in b.get("checks", []) if c not in checks]
    bad = [c for c, (s, _) in checks.items() if s == "fail"]
    # Only what this install added counts (another test may have left something).
    before = set(parts.get("before_out", "").split())
    left = " ".join(x for x in parts.get("left_out", "").split() if x not in before)
    notes = []
    if parts.get("uninstall", "0") != "0" or left:
        notes.append(f"uninstall exit {parts.get('uninstall')}, left: {left[:150]}")
    if not ended:
        notes.append("no FID end: " + tail(parts.get("out_out", ""), 6))
    if missing:
        notes.append("not reported: " + ", ".join(missing))
    if bad or not ended or missing:
        return "fail", "; ".join((["failed: " + ", ".join(bad)] if bad else []) + notes), checks
    return ("fail" if notes else "pass"), "; ".join(notes) or "all checks ok", checks


# ---------------------------------------------------------------- Linux and macOS

UNIX_SCRIPT = machines.ELF_PROBE_SH + r'''
set -u
H=$(mktemp -d /tmp/ibfid-XXXXXX)
cp "$SRC" "$H/$F"
BASEENV="HOME=$H PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8"
env -i $BASEENV sh "$H/$F" --yes --log="$H/i.log" </dev/null >"$H/i.out" 2>&1
echo "@install $?"
d=$(ls -d "$H"/.local/share/ib/*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  echo "@out"; env -i $BASEENV timeout 1200 sh "$d/launch.sh" </dev/null 2>&1 | tail -60
  echo "@elf"; ib_elf_probe "$H/.local/share/ib"
  env -i $BASEENV sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; (cd "$H" && find . -mindepth 1 ! -name i.log ! -name i.out ! -name "$F" ! -path './.cache*' ! -path './.pki*' | head -5)
echo "@osdesc"; sed -n 's/^Running as .* on //p' "$H/i.log" 2>/dev/null | head -1
echo "@planarch"; sed -n '/^ *Runtime:/{p;q;}' "$H/i.log" 2>/dev/null
echo "@x"
echo "@log"; cat "$H/i.log" 2>/dev/null
rm -rf "$H"
'''


def run_local(b, f):
    env = dict(os.environ, SRC=f, F=Path(f).name)
    code, out, err = sh(["sh", "-c", UNIX_SCRIPT], env=env)
    return out, err


def run_linux_vm(host, b, f):
    name = Path(f).name
    sh(["ssh", host, "rm -rf ibfid; mkdir -p ibfid"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{host}:ibfid/{name}"], timeout=900)
    if code:
        return "", "scp: " + err.strip()
    code, out, err = sh(["ssh", host, f"SRC=$HOME/ibfid/{shlex.quote(name)} F={shlex.quote(name)} sh -s"], input=UNIX_SCRIPT)
    sh(["ssh", host, "rm -rf ibfid"], timeout=60)
    return out, err


def run_sandbox(target, b, f):
    """A cell in a 32-bit Linux container on this machine."""
    import sandbox
    src = Path(f).resolve().parent
    rc, out, err = sandbox.run_script(
        target, UNIX_SCRIPT, timeout=TIMEOUT, ro={src: "/ibsrc"},
        env={"HOME": "/home/ti", "PATH": "/usr/local/bin:/usr/bin:/bin",
             "SRC": "/ibsrc/" + Path(f).name, "F": Path(f).name})
    return out, err


MAC_SCRIPT = r'''
set -u
cd "$HOME/ibfid" || exit 90
rm -rf x && mkdir x && cd x && ditto -x -k ../in.zip . || exit 91
app=$(ls -d *.app)
IB_NO_TERMINAL=1 "$app/Contents/MacOS/install" --yes --log="$HOME/ibfid/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
d=$(ls -d "$HOME/Library/ib/"*/launch.txt "$HOME/Library/Application Support/ib/"*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  echo "@out"; IB_NO_TERMINAL=1 FID_NO_DISPLAY="no window server over SSH" perl -e 'alarm shift; exec @ARGV' 1200 sh "$d/launch.sh" </dev/null 2>&1 | tail -60
  sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; ls "$HOME/Library/ib" "$HOME/Library/Application Support/ib" 2>/dev/null
echo "@osdesc"; sed -n 's/^Running as .* on //p' "$HOME/ibfid/i.log" 2>/dev/null | head -1
echo "@planarch"; sed -n '/^ *Runtime:/{p;q;}' "$HOME/ibfid/i.log" 2>/dev/null
echo "@x"
echo "@log"; cat "$HOME/ibfid/i.log"
'''


def run_mac(b, f):
    sh(["ssh", MAC, "rm -rf ~/ibfid; mkdir -p ~/ibfid"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{MAC}:ibfid/in.zip"], timeout=900)
    if code:
        return "", "scp: " + err
    code, out, err = sh(["ssh", MAC, "sh -s"], input=MAC_SCRIPT)
    sh(["ssh", MAC, "rm -rf ~/ibfid"], timeout=60)
    return out, err


# ---------------------------------------------------------------- Windows

BAT = r'''@echo off
setlocal
set T=C:\ibfid
echo @before
if exist "C:\ib" dir /b "C:\ib"
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib" dir /b "%LOCALAPPDATA%\ib"
"%T%\%FILE%" /S /log=%T%\install.log
echo @install %ERRORLEVEL%
set A=
if exist "C:\ib\%ID%\launch.exe" set A=C:\ib\%ID%
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib\%ID%\launch.exe" set A=%LOCALAPPDATA%\ib\%ID%
if not defined A goto left
"%A%\launch.exe" /out=%T%\out.txt
echo @out
type "%T%\out.txt"
"%A%\uninstall.exe" /S
echo @uninstall %ERRORLEVEL%
set /a n=0
:wait
if not exist "%A%" goto left
set /a n+=1
if %n% GEQ 120 goto left
ping -n 2 127.0.0.1 >nul
goto wait
:left
ping -n 3 127.0.0.1 >nul
echo @left
if exist "C:\ib" dir /b "C:\ib"
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib" dir /b "%LOCALAPPDATA%\ib"
echo @osdesc
findstr /b /c:"Windows " "%T%\install.log" 2>nul
echo @planarch
findstr /b /c:"  Runtime:" "%T%\install.log" 2>nul
echo @log
if exist "%T%\install.log" type "%T%\install.log"
for /d %%d in ("%TEMP%\~nsu*.tmp") do rd /s /q "%%d" 2>nul
'''


def appid(record):
    h = hashlib.sha256((record + "/app").encode()).digest()
    return base64.b32encode(h).decode().lower().rstrip("=")[:12]


def run_windows(host, b, f):
    bat = BAT.replace("%ID%", appid(b["record"])).replace("%FILE%", Path(f).name)
    with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, newline="\r\n") as t:
        t.write(bat)
    try:
        sh(["ssh", host, 'cmd /c "rd /s /q C:\\ibfid & mkdir C:\\ibfid"'], timeout=60)
        for src, dst in ((f, Path(f).name), (t.name, "t.bat")):
            code, _, err = sh(["scp", "-q", src, f"{host}:C:/ibfid/{dst}"], timeout=900)
            if code:
                return "", "scp: " + err.strip()
        code, out, err = sh(["ssh", host, "cmd /c C:\\ibfid\\t.bat"])
        sh(["ssh", host, 'cmd /c "rd /s /q C:\\ibfid"'], timeout=60)
        return out, err
    finally:
        Path(t.name).unlink()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--results", default=str(HERE / "results" / (time.strftime("%Y-%m-%d") + ".jsonl")))
    ap.add_argument("--label", default="", help="e.g. before or after, stored with each cell")
    ap.add_argument("--rejudge", default="", metavar="NAMES",
                    help="don't run: judge the saved logs of the last run again, not counting these "
                         "comma-separated folder names as left behind (folders another test left)")
    a = ap.parse_args()
    # One harness at a time per machine (tests/arch/vmlock.py).
    _lh, _lw = vmlock.target_host(a.target, WINDOWS, LINUX_VMS, MAC)
    _lock = vmlock.VMLock(_lh, _lw, f"fidelity {a.target}").acquire()
    atexit.register(_lock.release)
    out_dir = Path(a.out + ("-mac" if a.target == "mac" else ""))
    builds = json.loads((out_dir / "builds.json").read_text())
    only = [x for x in a.only.split(",") if x]
    if a.target not in machines.MACHINES:
        raise SystemExit(f"{a.target}: no such machine in tests/arch/machines.py "
                         f"(add it, with its architecture, before running it)")
    plat = ("linux" if a.target == "linux" or a.target in LINUX_VMS or a.target in SANDBOXES
            else "macos" if a.target == "mac" else "windows")
    logs = out_dir / "logs" / a.target
    logs.mkdir(parents=True, exist_ok=True)
    Path(a.results).parent.mkdir(parents=True, exist_ok=True)
    for pid, b in builds.items():
        if only and pid not in only:
            continue
        res = {"target": a.target, "arch": machines.arch_of(a.target), "project": pid, "label": a.label, "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
        f = (b.get("files") or {}).get(plat)
        if b.get("status") != "done" or not f:
            res.update(result="fail" if b.get("status") != "done" else "n/a",
                       detail="build: " + str(b.get("error", "no installer for " + plat)), checks={})
        elif a.rejudge:
            text = (logs / f"{pid}.txt").read_text()
            out, _, err = text.partition("\n--- stderr\n")
            parts = markers(out)
            ignore = set(a.rejudge.split(","))
            parts["left_out"] = "\n".join(x for x in parts.get("left_out", "").split() if x not in ignore)
            r, d, checks = judge(b, parts, err)
            res.update(result=r, detail=d + " (judged again from the saved log, not counting " + a.rejudge + ")",
                       checks=checks, record=b["record"])
        else:
            start = time.time()
            if a.target == "linux":
                out, err = run_local(b, f)
            elif a.target == "mac":
                out, err = run_mac(b, f)
            elif a.target in SANDBOXES:
                out, err = run_sandbox(a.target, b, f)
            elif a.target in LINUX_VMS:
                out, err = run_linux_vm(LINUX_VMS[a.target], b, f)
            else:
                out, err = run_windows(WINDOWS[a.target], b, f)
            (logs / f"{pid}.txt").write_text(out + "\n--- stderr\n" + err)
            parts = markers(out)
            r, d, checks = judge(b, parts, err)
            r, d, arch = machines.judge(a.target, parts, r, d)
            res.update(result=r, detail=d, checks=checks, record=b["record"],
                       seconds=round(time.time() - start), **arch)
        with open(a.results, "a") as fh:
            fh.write(json.dumps(res) + "\n")
        mark = {"pass": "PASS", "fail": "FAIL", "n/a": "n/a ", "no-plan": "NOPL"}[res["result"]]
        print(f"{mark} {a.target:14} {res['arch']:5} {pid:13} {res['detail'][:150]}", flush=True)
        for c, (s, d) in res.get("checks", {}).items():
            if s != "ok":
                print(f"       {s:4} {c}: {d[:150]}", flush=True)


if __name__ == "__main__":
    main()
