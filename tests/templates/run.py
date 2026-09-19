#!/usr/bin/env python3
"""Install and run every "I'll write it here" template on a test machine.

usage: run.py TARGET [--only python/window,go] [--out DIR] [--keep]

Installers come from build.py's output (DIR/builds.json, default
tests/templates/out; build.mjs writes it). TARGET is `linux` (this machine,
in a throwaway home), a Linux VM from LINUX_VMS, a Windows VM from WINDOWS,
or `mac`. Each cell: install unattended; run the app through its launcher
with IB_TEMPLATE_SELFTEST=1, and IB_TEMPLATE_SELFTEST_OUT naming a file;
check the app printed "template ok: <runtime>/<template>" (console apps: in
its output; every app: in that file); for window templates, check a window
with the template's title was on screen while it ran; uninstall, and check
nothing is left. Results go to results.jsonl, one JSON object per cell.

Window, tray and web apps need a desktop session:
  - Linux (here and the VMs): an Xvfb display, started for the run
    (--xvfb names an Xvfb binary; on the VMs it's installed with sudo if
    missing, with xwininfo, which finds the window).
  - Windows: a scheduled task running as the logged-in user in their
    session (schtasks /it); a PowerShell probe in the same task lists the
    visible windows' titles.
  - The Mac has no display: only console and web templates run there.
"""
import argparse
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
# Windows VMs: name -> ssh target (tests/matrix/run.py has the full list).
WINDOWS = {
    "7": "x@10.0.1.231",
    "10": "matth@10.0.1.199",
    "11": "matth@10.0.1.123",
    "11de": None,   # the German Windows 11 VM, "Jörg Müller": set --host when it's ready
}
LINUX_VMS = {
    "centos7": "x@10.0.1.221", "ubuntu1804": "x@10.0.1.144", "rocky8": "x@10.0.1.131",
    "ubuntu2004": "x@10.0.1.118", "ubuntu2204": "x@10.0.1.203", "debian12": "x@10.0.1.235",
    "alpine": "x@10.0.1.200",
}
INSTALL_TIMEOUT = 2400
RUN_TIMEOUT = 180


def sh(cmd, timeout=INSTALL_TIMEOUT, **kw):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace", **kw)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        out = e.stdout.decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        return 124, out, f"timed out after {timeout}s"


def tail(s, n=8):
    return " / ".join(s.strip().splitlines()[-n:])


def plan_fails(log):
    """The engine's words when the plan has nothing for this machine, or a
    prerequisite needs root that an unattended install can't get."""
    for line in log.splitlines():
        if "needs system packages" in line or "needs administrator rights" in line:
            return "needs root: " + line.strip()
        if "nothing for this machine" in line or ("No " in line and "release in the catalogue runs" in line):
            return line.strip()
    return None


def parse_markers(out):
    """@key value lines, and the lines after each as key_out."""
    parts, cur = {}, None
    for line in out.splitlines():
        line = line.rstrip("\r")
        if line.startswith("@"):
            k, _, v = line[1:].partition(" ")
            parts[k], cur = v, k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    return parts


def judge(key, b, parts, err=""):
    """The cell's result from a run's markers: install, out (the app's
    output), file (the self-test file), window, uninstall, left, log."""
    rt_tpl = key
    want = f"template ok: {rt_tpl}"
    if parts.get("install") != "0":
        log = parts.get("log_out", "")
        reason = plan_fails(log)
        if reason:
            return "n/a", reason
        return "fail", f"install exit {parts.get('install')}: " + tail(log + err, 6)
    notes = []
    in_file = want in parts.get("file_out", "")
    in_out = want in parts.get("out_out", "")
    if not in_file:
        return "fail", "no self-test line in the file; output: " + tail(parts.get("out_out", "") + parts.get("applog_out", ""), 8)
    if b.get("console") and not in_out:
        return "fail", "self-test line in the file but not in the console output: " + tail(parts.get("out_out", ""), 6)
    if b.get("title"):
        if f"window: {b['title']}" not in parts.get("window_out", ""):
            return "fail", "self-test ok, but no window titled " + repr(b["title"]) + ": " + tail(parts.get("window_out", ""), 4)
        notes.append("window seen")
    left = parts.get("left_out", "").strip()
    if parts.get("uninstall", "0") != "0" or left:
        return "fail", f"self-test ok; uninstall exit {parts.get('uninstall')}, left: {left[:200]}"
    return "pass", "self-test ok" + (", " + ", ".join(notes) if notes else "") + ", clean uninstall"


# ---------------------------------------------------------------- Linux and macOS

UNIX_SCRIPT = r'''
set -u
H=$(mktemp -d /tmp/ibtpl-XXXXXX)
cp "$SRC" "$H/$F"
BASEENV="HOME=$H PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8"
env -i $BASEENV sh "$H/$F" --yes --log="$H/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
d=$(ls -d "$H"/.local/share/ib/*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  XPID=
  if [ "$GUI" = 1 ]; then
    for n in 90 91 92 93 94 95 96 97 98 99; do [ -e /tmp/.X11-unix/X$n ] || [ -e /tmp/.X$n-lock ] || break; done
    $XVFB :$n -screen 0 1280x800x24 -nolisten tcp >/dev/null 2>&1 &
    XPID=$!
    sleep 2
    DISP="DISPLAY=:$n"
  else
    DISP=
  fi
  env -i $BASEENV $DISP IB_TEMPLATE_SELFTEST=1 IB_TEMPLATE_SELFTEST_OUT="$H/selftest.txt" \
    timeout $RUNT sh "$d/launch.sh" </dev/null >"$H/out.txt" 2>"$H/err.txt" &
  P=$!
  seen=
  i=0
  while [ $i -lt $((RUNT * 4)) ]; do
    if [ -n "$TITLE" ] && [ -z "$seen" ] && [ -n "$DISP" ]; then
      env $DISP xwininfo -root -tree 2>/dev/null | grep -F "\"$TITLE\"" >/dev/null && seen=1
    fi
    kill -0 $P 2>/dev/null || break
    [ -s "$H/selftest.txt" ] && { [ -z "$TITLE" ] || [ -n "$seen" ]; } && break
    sleep 0.25; i=$((i + 1))
  done
  i=0; while kill -0 $P 2>/dev/null && [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
  kill $P 2>/dev/null
  pkill -f "$d/" 2>/dev/null
  echo "@window"; [ -n "$seen" ] && echo "window: $TITLE"
  [ -n "$XPID" ] && kill $XPID 2>/dev/null
  echo "@out"; cat "$H/out.txt" "$H/err.txt" 2>/dev/null | tail -15
  echo "@applog"; tail -15 "$d/data/launch.log" 2>/dev/null
  echo "@file"; cat "$H/selftest.txt" 2>/dev/null
  env -i $BASEENV sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
# .dbus: GTK's D-Bus autolaunch, which a desktop session's own bus makes unneeded.
echo "@left"; (cd "$H" && find . -mindepth 1 ! -name i.log ! -name "$F" ! -name selftest.txt ! -name out.txt ! -name err.txt ! -path './.cache*' ! -path './.dbus*' | head -5)
echo "@log"; tail -12 "$H/i.log" 2>/dev/null
[ "${KEEP:-}" = 1 ] || rm -rf "$H"
'''


def run_unix_local(key, b, f, a):
    env = dict(os.environ)
    gui = "0" if b.get("console") else "1"
    script_env = {"SRC": f, "F": Path(f).name, "GUI": gui, "TITLE": b.get("title", ""), "RUNT": str(RUN_TIMEOUT),
                  "XVFB": a.xvfb, "KEEP": "1" if a.keep else ""}
    env.update(script_env)
    if a.xvfb_lib:
        env["LD_LIBRARY_PATH"] = a.xvfb_lib
    code, out, err = sh(["sh", "-c", UNIX_SCRIPT], env=env)
    return judge(key, b, parse_markers(out), err)


def run_linux_vm(host, key, b, f, a):
    name = Path(f).name
    sh(["ssh", host, "rm -rf ibtpl; mkdir -p ibtpl"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{host}:ibtpl/{name}"], timeout=600)
    if code:
        return "fail", "scp: " + err.strip()
    gui = "0" if b.get("console") else "1"
    head = (f"SRC=$HOME/ibtpl/{shlex.quote(name)} F={shlex.quote(name)} GUI={gui} TITLE={shlex.quote(b.get('title', ''))} "
            f"RUNT={RUN_TIMEOUT} XVFB=Xvfb KEEP={'1' if a.keep else ''}")
    code, out, err = sh(["ssh", host, f"{head} sh -s"], input=UNIX_SCRIPT)
    sh(["ssh", host, "rm -rf ibtpl"], timeout=60)
    return judge(key, b, parse_markers(out), err)


MAC_SCRIPT = r'''
set -u
cd "$HOME/ibtpl" || exit 90
rm -rf x && mkdir x && cd x && ditto -x -k ../in.zip . || exit 91
# What was there before: only what this install adds counts as left behind.
before=$(ls "$HOME/Applications" 2>/dev/null; [ -d "$HOME/Applications" ] && echo "(Applications)")
app=$(ls -d *.app)
IB_NO_TERMINAL=1 "$app/Contents/MacOS/install" --yes --log="$HOME/ibtpl/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
d=$(ls -d "$HOME/Library/Application Support/ib/"*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  IB_NO_TERMINAL=1 IB_TEMPLATE_SELFTEST=1 IB_TEMPLATE_SELFTEST_OUT="$HOME/ibtpl/selftest.txt" \
    perl -e 'alarm shift; exec @ARGV' 180 sh "$d/launch.sh" </dev/null >"$HOME/ibtpl/out.txt" 2>&1
  echo "@out"; tail -15 "$HOME/ibtpl/out.txt"
  echo "@file"; cat "$HOME/ibtpl/selftest.txt" 2>/dev/null
  sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
after=$(ls "$HOME/Applications" 2>/dev/null; [ -d "$HOME/Applications" ] && echo "(Applications)")
echo "@left"; ls "$HOME/Library/Application Support/ib" 2>/dev/null
[ "$before" = "$after" ] || echo "Applications: $after"
echo "@log"; tail -12 "$HOME/ibtpl/i.log"
'''


def run_mac(key, b, f, a):
    if not b.get("console"):
        return "n/a", "the Mac has no display: GUI templates can't run there"
    sh(["ssh", MAC, "rm -rf ~/ibtpl; mkdir -p ~/ibtpl"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{MAC}:ibtpl/in.zip"], timeout=600)
    if code:
        return "fail", "scp: " + err
    code, out, err = sh(["ssh", MAC, "sh -s"], input=MAC_SCRIPT)
    sh(["ssh", MAC, "rm -rf ~/ibtpl"], timeout=60)
    return judge(key, b, parse_markers(out), err)


# ---------------------------------------------------------------- Windows

WIN_DIR = "C:\\ibtpl"

# The app's folder, found as the installer makes it (a path with the user's
# name in it is never written into these files: cmd reads them in the OEM
# code page).
FIND_APP = r'''set A=
if exist "C:\ib\%ID%\launch.exe" set A=C:\ib\%ID%
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib\%ID%\launch.exe" set A=%LOCALAPPDATA%\ib\%ID%
'''

INSTALL_BAT = r'''@echo off
setlocal
set T=C:\ibtpl
"%T%\%FILE%" /S /log=%T%\install.log
echo @install %ERRORLEVEL%
''' + FIND_APP + r'''echo @appdir
if defined A echo found
echo @log
if exist "%T%\install.log" type "%T%\install.log"
'''

# Console and web apps: through launch.exe /out= over SSH.
CONSOLE_BAT = r'''@echo off
''' + FIND_APP + r'''set IB_TEMPLATE_SELFTEST=1
set IB_TEMPLATE_SELFTEST_OUT=C:\ibtpl\selftest.txt
"%A%\launch.exe" /out=C:\ibtpl\out.txt
echo @out
type C:\ibtpl\out.txt
echo @file
if exist C:\ibtpl\selftest.txt type C:\ibtpl\selftest.txt
'''

# GUI apps: installed and run in the logged-in user's session, from a
# scheduled task, as someone double-clicking the installer would (not
# elevated: an install over SSH runs with the administrator's full token).
GUI_BAT = r'''@echo off
"C:\ibtpl\%FILE%" /S /log=C:\ibtpl\install.log
>C:\ibtpl\install-rc.txt echo %ERRORLEVEL%
''' + FIND_APP + r'''if not defined A goto done
set IB_TEMPLATE_SELFTEST=1
set IB_TEMPLATE_SELFTEST_OUT=C:\ibtpl\selftest.txt
start "" "%A%\launch.exe"
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ibtpl\probe.ps1 -Title "%TITLE%" -Ok C:\ibtpl\selftest.txt > C:\ibtpl\probe.txt 2>&1
:done
>C:\ibtpl\task-done.txt echo done
'''

PROBE_PS1 = r'''param([string]$Title = "", [string]$Ok, [int]$Seconds = 150)
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class IbWindows {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public static List<string> Titles() {
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h)) {
        StringBuilder s = new StringBuilder(512);
        GetWindowText(h, s, 512);
        if (s.Length > 0) found.Add(s.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
$seen = $false
$start = Get-Date
while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
  if ($Title -and -not $seen -and ([IbWindows]::Titles() -contains $Title)) { $seen = $true; "window: $Title" }
  if ((Test-Path $Ok) -and ($seen -or -not $Title)) { break }
  Start-Sleep -Milliseconds 250
}
if ($Title -and -not $seen) { "no window titled $Title; visible: " + ([IbWindows]::Titles() -join " | ") }
'''

AFTER_BAT = r'''@echo off
''' + FIND_APP + r'''if not defined A goto left
powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*\ib\%ID%*' } | ForEach-Object { $_.Terminate() | Out-Null }"
if exist "%A%\data\launch.log" (echo @applog& type "%A%\data\launch.log")
"%A%\uninstall.exe" /S
echo @uninstall %ERRORLEVEL%
set /a n=0
:wait
if not exist "%A%" goto gone
set /a n+=1
if %n% GEQ 90 goto left
ping -n 2 127.0.0.1 >nul
goto wait
:gone
rem The uninstaller finishes from %TEMP% (Un_A.exe) after the app's folder
rem is gone: the runtime folders it shares with the next test go last.
set /a n=0
:unwait
tasklist /fi "imagename eq Un_A.exe" 2>nul | find /i "Un_A.exe" >nul || goto left
set /a n+=1
if %n% GEQ 120 goto left
ping -n 2 127.0.0.1 >nul
goto unwait
:left
ping -n 3 127.0.0.1 >nul
echo @left
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib\%ID%" echo app-folder-left
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-%ID%" >nul 2>&1 && echo regkey-left
'''


def appid(record):
    h = hashlib.sha256((record + "/app").encode()).digest()
    return base64.b32encode(h).decode().lower().rstrip("=")[:12]


def win_put(host, name, text):
    with tempfile.NamedTemporaryFile("w", suffix=Path(name).suffix, delete=False, newline="\r\n") as t:
        t.write(text)
    code, _, err = sh(["scp", "-q", t.name, f"{host}:C:/ibtpl/{name}"], timeout=120)
    Path(t.name).unlink()
    return code, err


# Other harnesses' folders: tests/matrix (C:\ibtest, and its cleanup removes
# every app under %LOCALAPPDATA%\ib), behaviour.py (C:\ibbtest).
BUSY = "cmd /c if exist C:\\ibtest (echo BUSY) else if exist C:\\ibbtest (echo BUSY)"


def wait_idle(host):
    """Wait while another test harness is using the VM (up to an hour)."""
    for i in range(360):
        code, out, _ = sh(["ssh", host, BUSY], timeout=60)
        if "BUSY" not in out:
            return True
        if i == 0:
            print(f"  {host}: another test run is using it; waiting", flush=True)
        time.sleep(10)
    return False


def run_windows(host, key, b, f, a):
    ident = appid(b["record"])
    if not wait_idle(host):
        return "fail", "the VM stayed busy with another test run for an hour"
    sh(["ssh", host, f'cmd /c "rd /s /q {WIN_DIR} & mkdir {WIN_DIR}"'], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{host}:C:/ibtpl/{Path(f).name}"], timeout=900)
    if code:
        return "fail", "scp: " + err.strip()
    parts = {}
    if b.get("console"):
        win_put(host, "install.bat", INSTALL_BAT.replace("%FILE%", Path(f).name).replace("%ID%", ident))
        code, out, err = sh(["ssh", host, "cmd /c C:\\ibtpl\\install.bat"])
        parts = parse_markers(out)
        if parts.get("install") != "0" or "found" not in parts.get("appdir_out", ""):
            parts.setdefault("install", "?")
            return judge(key, b, parts, err)
        win_put(host, "run.bat", CONSOLE_BAT.replace("%ID%", ident))
        code, out, err = sh(["ssh", host, "cmd /c C:\\ibtpl\\run.bat"], timeout=RUN_TIMEOUT + 60)
        parts.update(parse_markers(out))
    else:
        win_put(host, "gui.bat", GUI_BAT.replace("%FILE%", Path(f).name).replace("%ID%", ident).replace("%TITLE%", b.get("title", "")))
        win_put(host, "probe.ps1", PROBE_PS1)
        sh(["ssh", host, 'schtasks /create /tn ibtpl /tr "C:\\ibtpl\\gui.bat" /sc once /st 23:59 /it /f'], timeout=60)
        c2, o2, e2 = sh(["ssh", host, "schtasks /run /tn ibtpl"], timeout=60)
        t0 = time.time()
        while time.time() - t0 < INSTALL_TIMEOUT:
            c3, o3, _ = sh(["ssh", host, "cmd /c if exist C:\\ibtpl\\task-done.txt echo DONE"], timeout=30)
            if "DONE" in o3:
                break
            time.sleep(5)
        sh(["ssh", host, "schtasks /delete /tn ibtpl /f"], timeout=60)
        c4, o4, _ = sh(["ssh", host, "cmd /c echo @install& type C:\\ibtpl\\install-rc.txt& echo @log& type C:\\ibtpl\\install.log"
                        "& echo @window& type C:\\ibtpl\\probe.txt& echo @file& type C:\\ibtpl\\selftest.txt"], timeout=60)
        parts = parse_markers(o4)
        parts["install"] = parts.get("install_out", "").strip() or "?"
        if c2:
            parts["window_out"] = parts.get("window_out", "") + " (schtasks /run: " + (o2 + e2).strip() + ")"
    win_put(host, "after.bat", AFTER_BAT.replace("%ID%", ident))
    code, out, err = sh(["ssh", host, "cmd /c C:\\ibtpl\\after.bat"], timeout=300)
    parts.update(parse_markers(out))
    if not a.keep:
        sh(["ssh", host, f'cmd /c "rd /s /q {WIN_DIR}"'], timeout=60)
    return judge(key, b, parts, err)


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--host", default="", help="ssh target, overriding the table")
    ap.add_argument("--xvfb", default="Xvfb")
    ap.add_argument("--xvfb-lib", default="", help="LD_LIBRARY_PATH for an unpacked Xvfb")
    ap.add_argument("--keep", action="store_true", help="keep the throwaway folders")
    ap.add_argument("--results", default=str(HERE / "results.jsonl"))
    a = ap.parse_args()
    builds = json.loads((Path(a.out) / "builds.json").read_text())
    only = [x for x in a.only.split(",") if x]
    plat = "linux" if a.target == "linux" or a.target in LINUX_VMS else "macos" if a.target == "mac" else "windows"
    for key, b in builds.items():
        rt = key.split("/")[0]
        if only and key not in only and rt not in only:
            continue
        res = {"target": a.target, "template": key}
        if b.get("platforms") and plat not in b["platforms"]:
            res.update(result="n/a", detail=f"the template isn't for {plat}")
        elif b.get("status") != "done":
            res.update(result="fail", detail="build: " + str(b.get("error")))
        elif plat not in b["files"]:
            res.update(result="fail", detail=f"no {plat} installer in the build")
        else:
            f = b["files"][plat]
            if a.target == "linux":
                r, d = run_unix_local(key, b, f, a)
            elif a.target in LINUX_VMS:
                r, d = run_linux_vm(a.host or LINUX_VMS[a.target], key, b, f, a)
            elif a.target == "mac":
                r, d = run_mac(key, b, f, a)
            else:
                host = a.host or WINDOWS.get(a.target)
                if not host:
                    raise SystemExit(f"no ssh target for {a.target}: give --host")
                r, d = run_windows(host, key, b, f, a)
            res.update(result=r, detail=d, record=b["record"])
        res["time"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(a.results, "a") as fh:
            fh.write(json.dumps(res) + "\n")
        print(f"{res['result']:4} {a.target:10} {key:15} {res.get('detail', '')[:220]}", flush=True)


if __name__ == "__main__":
    main()
