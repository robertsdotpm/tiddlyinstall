#!/usr/bin/env python3
"""Install the package-manager matrix on a test machine and read its checks.

usage: run.py TARGET [--only python,node] [--majors 3.9,3.14] [--out DIR]
              [--results FILE] [--label TEXT] [--timeout 3600]

Installers come from build.mjs's output (DIR/builds.json, default
tests/tooling/out; the Mac's from DIR-mac). TARGET is `linux` (this
machine, in a throwaway home), a Linux VM from LINUX_VMS, a Windows VM
from WINDOWS, or `mac`. Each cell: install unattended, run the app through
its launcher, read its "TOOL ok|fail|skip <check>" lines, uninstall, and
check nothing is left. One JSON object per cell is appended to --results
(default results/<date>.jsonl); the install log and the app's output go to
DIR/logs/<target>/<cell>.txt.

This is tests/fidelity/run.py's harness with the Windows VM list and the
"another harness is using this VM" wait from tests/templates/run.py, and
one cell per (runtime, major) instead of per runtime.
"""
import argparse
import atexit
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent.parent / "arch"))
import vmlock                                              # noqa: E402
import base64
import hashlib
import json
import os
import shlex
import subprocess
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MAC = "Matthew@the-mac-test-host"
WINDOWS = {
    "xp": "matthew@10.0.1.132",
    "vista": "x@10.0.1.167",
    "7": "x@10.0.1.231",
    "8.1": "x@10.0.1.165",
    "10": "matth@10.0.1.199",
    "11": "matth@10.0.1.123",
    "2022": "administrator@10.0.1.248",
    "10x86": "x@10.0.1.47",
    "ltsc2021": "x@10.0.1.86",
    "2025core": "x@10.0.1.124",
    "11de": "Jörg Müller@10.0.1.83",
}
# Run from a folder in the user's profile, not C:\ibtool: the German VM's
# profile is "C:\Users\jörg müller" (a space and non-ASCII letters).
PROFILE = {"11de"}
LINUX_VMS = {
    "centos6": "x@10.0.1.183", "centos7": "x@10.0.1.221", "ubuntu1404": "x@10.0.1.117",
    "ubuntu1604": "x@10.0.1.112", "ubuntu1804": "x@10.0.1.144", "rocky8": "x@10.0.1.131",
    "ubuntu2004": "x@10.0.1.118", "ubuntu2204": "x@10.0.1.203", "debian12": "x@10.0.1.235",
    "alpine": "x@10.0.1.200",
}
TIMEOUT = 3600


def sh(cmd, timeout=None, **kw):
    timeout = timeout or TIMEOUT
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
        if line.startswith("@") and line[1:2].isalpha():
            k, _, v = line[1:].partition(" ")
            parts[k], cur = v, k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    return parts


def plan_fails(log):
    """The engine's words when it refused this combination up front, when the
    plan has nothing for this machine, or when a prerequisite needs root that
    an unattended install can't get."""
    for line in log.splitlines():
        # A refusal: the plan, or a prerequisite nothing here can add, said
        # this combination cannot work, and the installer stopped before
        # touching anything (docs/format.md, "Combinations that cannot
        # work"). That is a result of its own, not a broken install.
        if "Refused before installing:" in line:
            return "refused: " + line.split("Refused before installing:", 1)[1].strip()
        if "needs system packages" in line or "needs administrator rights" in line:
            return "needs root: " + line.strip()
        if "nothing for this machine" in line or ("No " in line and "release in the catalogue runs" in line):
            return line.strip()
    return None


def judge(b, parts, err=""):
    """(result, detail, checks) from a run's markers."""
    log = parts.get("log_out", "")
    checks, runtime = {}, ""
    for line in parts.get("out_out", "").splitlines():
        w = line.strip().split(" ", 2)
        if len(w) >= 3 and w[0] == "TOOL" and w[1] == "runtime":
            runtime = w[2]
        elif len(w) >= 3 and w[0] == "TOOL" and w[1] in ("ok", "fail", "skip"):
            name, _, detail = w[2].partition(": ")
            checks[name] = [w[1], detail]
    if parts.get("install") != "0":
        reason = plan_fails(log)
        if reason:
            return "n/a", reason, checks, runtime
        return "fail", f"install exit {parts.get('install')}: " + tail(log + err, 8), checks, runtime
    ended = "TOOL end" in parts.get("out_out", "")
    missing = [c for c in b.get("checks", []) if c not in checks]
    bad = [c for c, (s, _) in checks.items() if s == "fail"]
    before = set(parts.get("before_out", "").split())
    left = " ".join(x for x in parts.get("left_out", "").split() if x not in before)
    notes = []
    if parts.get("uninstall", "0") != "0" or left:
        notes.append(f"uninstall exit {parts.get('uninstall')}, left: {left[:150]}")
    if not ended:
        notes.append("no TOOL end: " + tail(parts.get("out_out", ""), 6))
    if missing:
        notes.append("not reported: " + ", ".join(missing))
    if bad or not ended or missing:
        return "fail", "; ".join((["failed: " + ", ".join(bad)] if bad else []) + notes), checks, runtime
    skipped = [c for c, (s, _) in checks.items() if s == "skip"]
    ok = "all checks ok" + (" (" + str(len(skipped)) + " skipped)" if skipped else "")
    return ("fail" if notes else "pass"), "; ".join(notes) or ok, checks, runtime


# The name the engines give an app's folder, from the record hash
# (docs/format.md section 5).
def appid(record):
    h = hashlib.sha256((record + "/app").encode()).digest()
    return base64.b32encode(h).decode().lower().rstrip("=")[:12]


# ---------------------------------------------------------------- Linux and macOS

UNIX_SCRIPT = r'''
set -u
H=$(mktemp -d /tmp/ibtool-XXXXXX)
cp "$SRC" "$H/$F"
BASEENV="HOME=$H PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8"
env -i $BASEENV sh "$H/$F" --yes --log="$H/i.log" </dev/null >"$H/i.out" 2>&1
echo "@install $?"
d=$(ls -d "$H"/.local/share/ib/*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  echo "@out"; env -i $BASEENV timeout 1800 sh "$d/launch.sh" </dev/null 2>&1 | tail -80
  env -i $BASEENV sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; (cd "$H" && find . -mindepth 1 ! -name i.log ! -name i.out ! -name "$F" ! -path './.cache*' ! -path './.pki*' | head -5)
echo "@log"; cat "$H/i.log" 2>/dev/null
rm -rf "$H"
'''


def run_local(b, f):
    env = dict(os.environ, SRC=f, F=Path(f).name)
    code, out, err = sh(["sh", "-c", UNIX_SCRIPT], env=env)
    return out, err


def run_linux_vm(host, b, f):
    name = Path(f).name
    sh(["ssh", host, "rm -rf ibtool; mkdir -p ibtool"], timeout=120)
    code, _, err = sh(["scp", "-q", f, f"{host}:ibtool/{name}"], timeout=900)
    if code:
        return "", "scp: " + err.strip()
    code, out, err = sh(["ssh", host, f"SRC=$HOME/ibtool/{shlex.quote(name)} F={shlex.quote(name)} sh -s"],
                        input=UNIX_SCRIPT)
    sh(["ssh", host, "rm -rf ibtool"], timeout=120)
    return out, err


# The Mac is a real machine, not a throwaway home: another cell's app may
# still be there, so this cell's own folder is named by its appid, never
# "the first one under the install root", and what was there before the
# install is listed so only what this cell left counts.
MAC_SCRIPT = r'''
set -u
R="$HOME/Library/ib"
[ -d "$R" ] || R="$HOME/Library/Application Support/ib"
echo "@before"; ls "$HOME/Library/ib" "$HOME/Library/Application Support/ib" 2>/dev/null
cd "$HOME/ibtool" || exit 90
rm -rf x && mkdir x && cd x && ditto -x -k ../in.zip . || exit 91
app=$(ls -d *.app)
IB_NO_TERMINAL=1 "$app/Contents/MacOS/install" --yes --log="$HOME/ibtool/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
d=
for r in "$HOME/Library/ib" "$HOME/Library/Application Support/ib"; do
  [ -f "$r/$ID/launch.txt" ] && d="$r/$ID"
done
if [ -n "$d" ]; then
  echo "@out"; IB_NO_TERMINAL=1 perl -e 'alarm shift; exec @ARGV' 1800 sh "$d/launch.sh" </dev/null 2>&1 | tail -80
  sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; ls "$HOME/Library/ib" "$HOME/Library/Application Support/ib" 2>/dev/null
echo "@log"; cat "$HOME/ibtool/i.log"
'''


def run_mac(b, f):
    sh(["ssh", MAC, "rm -rf ~/ibtool; mkdir -p ~/ibtool"], timeout=120)
    code, _, err = sh(["scp", "-q", f, f"{MAC}:ibtool/in.zip"], timeout=900)
    if code:
        return "", "scp: " + err
    code, out, err = sh(["ssh", MAC, f"ID={shlex.quote(appid(b['record']))} sh -s"], input=MAC_SCRIPT)
    sh(["ssh", MAC, "rm -rf ~/ibtool"], timeout=120)
    return out, err


# ---------------------------------------------------------------- Windows

BAT = r'''@echo off
setlocal
set T=%DIR%
echo @before
if exist "C:\ib" dir /b "C:\ib"
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib" dir /b "%LOCALAPPDATA%\ib"
"%T%\%FILE%" /S /log={LOG}
echo @install %ERRORLEVEL%
set A=
if exist "C:\ib\%ID%\launch.exe" set A=C:\ib\%ID%
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib\%ID%\launch.exe" set A=%LOCALAPPDATA%\ib\%ID%
if not defined A goto left
"%A%\launch.exe" /out={OUT}
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
echo @log
if exist "%T%\install.log" type "%T%\install.log"
for /d %%d in ("%TEMP%\~nsu*.tmp") do rd /s /q "%%d" 2>nul
'''


def win_busy(host):
    """Another harness's folder on this VM (tests/templates/run.py)."""
    checks = ["if exist C:\\ibtest echo BUSY", "if exist C:\\ibbtest echo BUSY",
              "if exist C:\\ibtpl echo BUSY", "if exist C:\\ibfid echo BUSY",
              'if exist "%USERPROFILE%\\ibtest" echo BUSY', 'if exist "%USERPROFILE%\\ibtpl" echo BUSY']
    _, out, _ = sh(["ssh", host, 'cmd /c "' + "& ".join(checks) + '"'], timeout=120)
    return "BUSY" in out


def wait_idle(host):
    for i in range(360):
        if not win_busy(host):
            return True
        if i == 0:
            print(f"  {host}: another test run is using it; waiting", flush=True)
        time.sleep(10)
    return False


def run_windows(target, b, f):
    """As tests/templates/run.py does it: on a machine whose profile has a
    space and non-ASCII letters (the German VM) the folder is in the
    profile, every %T% path is quoted, and the batch file is reached with
    `cmd /c call "..."\t.bat`."""
    host = WINDOWS[target]
    profile = target in PROFILE
    cmd_dir = '"%USERPROFILE%\\ibtool"' if profile else "C:\\ibtool"
    scp_dir = "ibtool" if profile else "C:/ibtool"
    if not wait_idle(host):
        return "", "the VM stayed busy with another test run for an hour"
    q = '"' if profile else ""
    bat = (BAT.replace("%ID%", appid(b["record"])).replace("%FILE%", Path(f).name)
           .replace("%DIR%", "%USERPROFILE%\\ibtool" if profile else "C:\\ibtool")
           .replace("{LOG}", q + "%T%\\install.log" + q)
           .replace("{OUT}", q + "%T%\\out.txt" + q))
    with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, newline="\r\n") as t:
        t.write(bat)
    try:
        sh(["ssh", host, f'cmd /c "rd /s /q {cmd_dir} & mkdir {cmd_dir}"'], timeout=120)
        for src, dst in ((f, Path(f).name), (t.name, "t.bat")):
            code, _, err = sh(["scp", "-q", src, f"{host}:{scp_dir}/{dst}"], timeout=900)
            if code:
                return "", "scp: " + err.strip()
        call = "call " if profile else ""
        code, out, err = sh(["ssh", host, f'cmd /c {call}{cmd_dir}\\t.bat'])
        sh(["ssh", host, f'cmd /c "rd /s /q {cmd_dir}"'], timeout=120)
        return out, err
    finally:
        Path(t.name).unlink()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--only", default="", help="project ids, comma separated")
    ap.add_argument("--majors", default="", help="only these majors, comma separated")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--results", default=str(HERE / "results" / (time.strftime("%Y-%m-%d") + ".jsonl")))
    ap.add_argument("--label", default="")
    ap.add_argument("--timeout", type=int, default=0, help="seconds for one cell (default 3600)")
    a = ap.parse_args()
    # One harness at a time per machine (tests/arch/vmlock.py).
    _lh, _lw = vmlock.target_host(a.target, WINDOWS, LINUX_VMS, MAC)
    _lock = vmlock.VMLock(_lh, _lw, f"tooling {a.target}").acquire()
    atexit.register(_lock.release)
    if a.timeout:
        globals()["TIMEOUT"] = a.timeout
    out_dir = Path(a.out + ("-mac" if a.target == "mac" else ""))
    builds = json.loads((out_dir / "builds.json").read_text())
    only = [x for x in a.only.split(",") if x]
    majors = [x for x in a.majors.split(",") if x]
    plat = "linux" if a.target == "linux" or a.target in LINUX_VMS else "macos" if a.target == "mac" else "windows"
    logs = out_dir / "logs" / a.target
    logs.mkdir(parents=True, exist_ok=True)
    Path(a.results).parent.mkdir(parents=True, exist_ok=True)
    for cell, b in builds.items():
        if only and b.get("project") not in only:
            continue
        if majors and str(b.get("major")) not in majors:
            continue
        res = {"target": a.target, "cell": cell, "project": b.get("project"), "runtime": b.get("runtime"),
               "major": b.get("major"), "label": a.label, "time": time.strftime("%Y-%m-%dT%H:%M:%S")}
        f = (b.get("files") or {}).get(plat)
        if b.get("status") != "done" or not f:
            res.update(result="fail" if b.get("status") != "done" else "n/a",
                       detail="build: " + str(b.get("error", "no installer for " + plat)), checks={})
        else:
            start = time.time()
            if a.target == "linux":
                out, err = run_local(b, f)
            elif a.target == "mac":
                out, err = run_mac(b, f)
            elif a.target in LINUX_VMS:
                out, err = run_linux_vm(LINUX_VMS[a.target], b, f)
            else:
                out, err = run_windows(a.target, b, f)
            (logs / f"{cell.replace('@', '-')}.txt").write_text(out + "\n--- stderr\n" + err)
            r, d, checks, runtime = judge(b, markers(out), err)
            res.update(result=r, detail=d, checks=checks, version=runtime, record=b["record"],
                       seconds=round(time.time() - start))
        with open(a.results, "a") as fh:
            fh.write(json.dumps(res) + "\n")
        mark = {"pass": "PASS", "fail": "FAIL", "n/a": "n/a "}[res["result"]]
        print(f"{mark} {a.target:10} {cell:16} {res['detail'][:150]}", flush=True)
        for c, (s, d) in res.get("checks", {}).items():
            if s != "ok":
                print(f"       {s:4} {c}: {d[:140]}", flush=True)


if __name__ == "__main__":
    main()
