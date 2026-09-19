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

A machine-wide TCL_LIBRARY and TK_LIBRARY pointing nowhere are put into the
environment of the install and of the run for Python, Python 2 and R (the
runtimes that carry their own Tcl/Tk), so a template that only works on a
machine without them fails here; --no-stray leaves them out. An app that
prints a startup warning (BAD_OUTPUT) fails even when its self-test passed.

tests/templates/plan-test.mjs checks the same failures on the plans alone,
without a machine.

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
# Run from a folder in the user's profile, not C:\ibtpl, with every path
# quoted: the German VM's profile is "C:\Users\jörg müller" (a space and
# non-ASCII letters), where a downloaded installer would start from.
PROFILE = {"11de"}
# No desktop: window and tray templates have no display there.
NO_DESKTOP = {"2025core": "Server Core has no desktop: no display for GUI templates"}
LINUX_VMS = {
    "centos6": "x@10.0.1.183", "centos7": "x@10.0.1.221", "ubuntu1404": "x@10.0.1.117",
    "ubuntu1604": "x@10.0.1.112", "ubuntu1804": "x@10.0.1.144", "rocky8": "x@10.0.1.131",
    "ubuntu2004": "x@10.0.1.118", "ubuntu2204": "x@10.0.1.203", "debian12": "x@10.0.1.235",
    "alpine": "x@10.0.1.200",
}
INSTALL_TIMEOUT = 2400
RUN_TIMEOUT = 180

# Machine-wide variables another program may have set, put into the
# environment of the install and of the run for the runtimes they would
# reach: an app must not depend on the machine not having them. TCL_LIBRARY
# is the real case (CSR BlueSuite sets it system-wide, and it sent Python 2's
# Tcl 8.5 to the wrong folder: docs/test-results.md, 2026-09-20).
STRAY_ENV = {"TCL_LIBRARY": "no-such-tcl", "TK_LIBRARY": "no-such-tk"}
STRAY_FOR = ("python", "python2", "r")


def sh(cmd, timeout=None, **kw):
    timeout = timeout or INSTALL_TIMEOUT
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


# Lines an app must not print even when its self-test passes: PHP's
# extensions failed to load on the German VM for weeks because the warnings
# went to the output and nothing looked at them.
BAD_OUTPUT = ("Unable to load dynamic library", "PHP Startup:", "PHP Warning:")


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
    said = parts.get("out_out", "") + parts.get("applog_out", "")
    for bad in BAD_OUTPUT:
        if bad in said:
            line = next(l for l in said.splitlines() if bad in l)
            return "fail", "self-test ok, but the app warned: " + line.strip()[:200]
    left = parts.get("left_out", "").strip()
    if parts.get("uninstall", "0") != "0" or left:
        return "fail", f"self-test ok; uninstall exit {parts.get('uninstall')}, left: {left[:200]}"
    return "pass", "self-test ok" + (", " + ", ".join(notes) if notes else "") + ", clean uninstall"


# ---------------------------------------------------------------- Linux and macOS

UNIX_SCRIPT = r'''
set -u
H=$(mktemp -d /tmp/ibtpl-XXXXXX)
cp "$SRC" "$H/$F"
BASEENV="HOME=$H PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 ${STRAY:-}"
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
    i=0; while [ $i -lt 40 ] && ! DISPLAY=:$n xwininfo -root >/dev/null 2>&1; do sleep 0.5; i=$((i + 1)); done
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
                  "XVFB": a.xvfb, "KEEP": "1" if a.keep else "", "STRAY": a.stray}
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
            f"RUNT={RUN_TIMEOUT} XVFB=Xvfb KEEP={'1' if a.keep else ''} STRAY={shlex.quote(a.stray)}")
    code, out, err = sh(["ssh", host, f"{head} sh -s"], input=UNIX_SCRIPT)
    if code == 124:
        # An install that ran out of time keeps going on the VM: stop it
        # (it removes what it installed), so the next test runs alone.
        # "[x]yz" matches the installer, not this command line.
        sh(["ssh", host, "pkill -f " + shlex.quote("[" + name[0] + "]" + name[1:])], timeout=60)
        time.sleep(30)
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

# The scripts run from %T%: C:\ibtpl, or %USERPROFILE%\ibtpl on a PROFILE
# machine, where the paths the installer and launcher are given are quoted
# ({LOG}, {OUT}). The app's folder is found as the installer makes it (a
# path with the user's name in it is never written into these files: cmd
# reads them in the OEM code page).
FIND_APP = r"""set A=
if exist "C:\ib\{ID}\launch.exe" set A=C:\ib\{ID}
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib\{ID}\launch.exe" set A=%LOCALAPPDATA%\ib\{ID}
"""

INSTALL_BAT = r"""setlocal
(dir /b "C:\ib" 2>nul& if defined LOCALAPPDATA dir /b "%LOCALAPPDATA%\ib" 2>nul) >"%T%\ib-before.txt"
(dir /b /ad "%APPDATA%" 2>nul& if defined LOCALAPPDATA dir /b /ad "%LOCALAPPDATA%" 2>nul) >"%T%\profile-before.txt"
"%T%\{FILE}" /S /log={LOG}
echo @install %ERRORLEVEL%
""" + FIND_APP + r"""echo @appdir
if defined A echo found
echo @log
if exist "%T%\install.log" type "%T%\install.log"
"""

# Console and web apps: through launch.exe /out= over SSH.
CONSOLE_BAT = FIND_APP + r"""set IB_TEMPLATE_SELFTEST=1
set IB_TEMPLATE_SELFTEST_OUT=%T%\selftest.txt
"%A%\launch.exe" /out={OUT}
echo @out
type "%T%\out.txt"
echo @file
if exist "%T%\selftest.txt" type "%T%\selftest.txt"
"""

# GUI apps: installed and run in the logged-in user's session, from a
# scheduled task, as someone double-clicking the installer would (not
# elevated: an install over SSH runs with the administrator's full token).
# When nobody is logged on at the console (a schtasks /it task wouldn't
# start), the same script runs over SSH instead, and the window is looked
# for on the SSH session's own desktop, hidden windows included (processes
# there start with SW_HIDE, so a window is made but never visible); the
# result says so.
GUI_BAT = r"""(dir /b "C:\ib" 2>nul& if defined LOCALAPPDATA dir /b "%LOCALAPPDATA%\ib" 2>nul) >"%T%\ib-before.txt"
(dir /b /ad "%APPDATA%" 2>nul& if defined LOCALAPPDATA dir /b /ad "%LOCALAPPDATA%" 2>nul) >"%T%\profile-before.txt"
"%T%\{FILE}" /S /log={LOG}
>"%T%\install-rc.txt" echo %ERRORLEVEL%
""" + FIND_APP + r"""if not defined A goto done
set IB_TEMPLATE_SELFTEST=1
set IB_TEMPLATE_SELFTEST_OUT=%T%\selftest.txt
powershell -NoProfile -ExecutionPolicy Bypass -File "%T%\probe.ps1" -Title "{TITLE}" -Ok "%T%\selftest.txt" -Launch "%A%\launch.exe"{PROBEARGS} <nul >"%T%\probe.txt" 2>&1
:done
>"%T%\task-done.txt" echo done
"""

TASK_BAT = r"""schtasks /create /tn ibtpl /tr {TR} /sc once /st 23:59 /it /f
schtasks /run /tn ibtpl
"""

GUI_RESULTS_BAT = r"""echo @install
type "%T%\install-rc.txt" 2>nul
echo @log
type "%T%\install.log" 2>nul
echo @window
type "%T%\probe.txt" 2>nul
echo @file
type "%T%\selftest.txt" 2>nul
"""

DONE_BAT = r"""if exist "%T%\task-done.txt" echo DONE
"""

PROBE_PS1 = r"""param([string]$Title = "", [string]$Ok, [string]$Launch, [int]$Seconds = 150, [switch]$Hidden)
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
  public static List<string> Titles(bool hidden) {
    List<string> found = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (hidden || IsWindowVisible(h)) {
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
# The app starts once the probe is ready (Add-Type compiling can take
# seconds on a slow VM, longer than a self-test's window is up).
Start-Process -FilePath $Launch
$seen = $false
$start = Get-Date
while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
  if ($Title -and -not $seen -and ([IbWindows]::Titles($Hidden) -contains $Title)) { $seen = $true; "window: $Title" }
  if ((Test-Path $Ok) -and ($seen -or -not $Title)) { break }
  Start-Sleep -Milliseconds 250
}
if ($Title -and -not $seen) { "no window titled $Title; visible: " + ([IbWindows]::Titles($Hidden) -join " | ") }
"""

AFTER_BAT = FIND_APP + r"""if not defined A goto left
powershell -NoProfile -Command "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*\ib\{ID}*' } | ForEach-Object { $_.Terminate() | Out-Null }" <nul
if exist "%A%\data\launch.log" (echo @applog& type "%A%\data\launch.log")
"%A%\uninstall.exe" /S
echo @uninstall %ERRORLEVEL%
set /a n=0
:wait
if not exist "%A%" goto gone
set /a n+=1
if %n% GEQ 1200 goto left
ping -n 2 127.0.0.1 >nul
goto wait
:gone
rem The uninstaller finishes from %TEMP% (Un_A.exe) after the app's folder
rem is gone: the runtime folders it shares with the next test go last.
rem Both waits allow 20 minutes: Rust's 1.8 GB take that long on a busy
rem datastore, and an Un_A.exe still deleting when this SSH session ends
rem is killed with it (Bitvise ends the session's processes).
set /a n=0
:unwait
tasklist /fi "imagename eq Un_A.exe" 2>nul | find /i "Un_A.exe" >nul || goto left
set /a n+=1
if %n% GEQ 1200 goto left
ping -n 2 127.0.0.1 >nul
goto unwait
:left
ping -n 3 127.0.0.1 >nul
echo @left
rem Every folder under ib that wasn't there before the install: the app's,
rem and the runtimes' (removed with their last app).
if exist "C:\ib" for /f "delims=" %%d in ('dir /b "C:\ib"') do findstr /x /c:"%%d" "%T%\ib-before.txt" >nul 2>&1 || echo left: C:\ib\%%d
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib" for /f "delims=" %%d in ('dir /b "%LOCALAPPDATA%\ib"') do findstr /x /c:"%%d" "%T%\ib-before.txt" >nul 2>&1 || echo left: %%d
rem And in the user's profile: a package's own cache (Electron's download
rem cache is %LOCALAPPDATA%\electron) outlives the app otherwise.
for /f "delims=" %%d in ('dir /b /ad "%APPDATA%"') do findstr /x /c:"%%d" "%T%\profile-before.txt" >nul 2>&1 || echo left: %%APPDATA%%\%%d
if defined LOCALAPPDATA for /f "delims=" %%d in ('dir /b /ad "%LOCALAPPDATA%"') do findstr /x /c:"%%d" "%T%\profile-before.txt" >nul 2>&1 || echo left: %%LOCALAPPDATA%%\%%d
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-{ID}" >nul 2>&1 && echo regkey-left
"""


def win_stray(runtime, a):
    """set lines for STRAY_ENV, for a runtime that carries its own Tcl/Tk."""
    if a.no_stray or runtime not in STRAY_FOR:
        return ""
    return "".join(f'set "{k}=%T%\\{v}"\n' for k, v in STRAY_ENV.items())


def unix_stray(runtime, a):
    """The same as space-separated NAME=VALUE, for `env -i`."""
    if a.no_stray or runtime not in STRAY_FOR:
        return ""
    return " ".join(f"{k}=/nonexistent/{v}" for k, v in STRAY_ENV.items())


def appid(record):
    h = hashlib.sha256((record + "/app").encode()).digest()
    return base64.b32encode(h).decode().lower().rstrip("=")[:12]


class WinVM:
    """A Windows test machine: where the scripts go, and how they're run."""

    def __init__(self, target, host, stray=""):
        self.target, self.host = target, host
        self.stray = stray      # "set VAR=..." lines, run before everything
        self.profile = target in PROFILE
        if self.profile:
            # scp paths are relative to the user's home; ssh command lines
            # quote the folder (cmd, the default shell there, expands it).
            self.t, self.cmd_dir, self.scp_dir = "%USERPROFILE%\\ibtpl", '"%USERPROFILE%\\ibtpl"', "ibtpl"
        else:
            self.t, self.cmd_dir, self.scp_dir = WIN_DIR, WIN_DIR, "C:/ibtpl"

    def script(self, body, **subst):
        q = '"' if self.profile else ""
        subst.setdefault("LOG", q + "%T%\\install.log" + q)
        subst.setdefault("OUT", q + "%T%\\out.txt" + q)
        subst.setdefault("TR", '"\\"%T%\\gui.bat\\""' if self.profile else '"%T%\\gui.bat"')
        for k, v in subst.items():
            body = body.replace("{" + k + "}", v)
        return "@echo off\nset T=" + self.t + "\n" + self.stray + body

    def put(self, name, text):
        with tempfile.NamedTemporaryFile("w", suffix=Path(name).suffix, delete=False, newline="\r\n") as t:
            t.write(text)
        code, _, err = sh(["scp", "-q", t.name, f"{self.host}:{self.scp_dir}/{name}"], timeout=120)
        Path(t.name).unlink()
        return code, err

    def call(self, name, timeout=None):
        if self.profile:
            return sh(["ssh", self.host, f"cmd /c call {self.cmd_dir}\\{name}"], timeout=timeout)
        return sh(["ssh", self.host, f"cmd /c {self.cmd_dir}\\{name}"], timeout=timeout)

    def run_script(self, name, body, timeout=None, **subst):
        self.put(name, self.script(body, **subst))
        return self.call(name, timeout)

    def stop(self, exe):
        """An install that ran out of time keeps going on the VM: stop it,
        so the next test runs alone (what it left is reported as left)."""
        sh(["ssh", self.host, f"taskkill /f /t /im {exe}"], timeout=60)
        time.sleep(10)

    def fresh(self):
        sh(["ssh", self.host, f'cmd /c "rd /s /q {self.cmd_dir} & mkdir {self.cmd_dir}"'], timeout=60)

    def remove(self):
        sh(["ssh", self.host, f'cmd /c "rd /s /q {self.cmd_dir}"'], timeout=60)

    def busy(self):
        """Another harness's folder: tests/matrix (C:\\ibtest, whose cleanup
        removes every app under %LOCALAPPDATA%\\ib), behaviour.py (C:\\ibbtest),
        or the same in the profile on a PROFILE machine."""
        checks = ["if exist C:\\ibtest echo BUSY", "if exist C:\\ibbtest echo BUSY"]
        if self.profile:
            checks += ['if exist "%USERPROFILE%\\ibtest" echo BUSY', 'if exist "%USERPROFILE%\\ibbtest" echo BUSY']
        code, out, _ = sh(["ssh", self.host, 'cmd /c "' + "& ".join(checks) + '"'], timeout=60)
        return "BUSY" in out

    def interactive(self):
        """Is the SSH user logged on with a desktop (explorer.exe), so a
        schtasks /it task starts in their session?"""
        _, who, _ = sh(["ssh", self.host, "whoami"], timeout=60)
        _, out, _ = sh(["ssh", self.host, 'tasklist /v /fo csv /nh /fi "imagename eq explorer.exe"'], timeout=60)
        who = who.strip().lower()
        rows = [r for r in out.splitlines() if r.lower().startswith('"explorer.exe"')]
        return any(who and who in r.lower() for r in rows) if who else bool(rows)


def wait_idle(vm):
    """Wait while another test harness is using the VM (up to an hour)."""
    for i in range(360):
        if not vm.busy():
            return True
        if i == 0:
            print(f"  {vm.host}: another test run is using it; waiting", flush=True)
        time.sleep(10)
    return False


def run_windows(vm, key, b, f, a):
    ident = appid(b["record"])
    if not b.get("console") and vm.target in NO_DESKTOP:
        return "n/a", NO_DESKTOP[vm.target]
    if not wait_idle(vm):
        return "fail", "the VM stayed busy with another test run for an hour"
    vm.fresh()
    code, _, err = sh(["scp", "-q", f, f"{vm.host}:{vm.scp_dir}/{Path(f).name}"], timeout=900)
    if code:
        return "fail", "scp: " + err.strip()
    parts, note = {}, ""
    if b.get("console"):
        code, out, err = vm.run_script("install.bat", INSTALL_BAT, FILE=Path(f).name, ID=ident)
        if code == 124:
            vm.stop(Path(f).name)
        parts = parse_markers(out)
        if parts.get("install") != "0" or "found" not in parts.get("appdir_out", ""):
            parts.setdefault("install", "?")
            if not a.keep:
                vm.remove()
            return judge(key, b, parts, err)
        code, out, err = vm.run_script("run.bat", CONSOLE_BAT, timeout=RUN_TIMEOUT + 60, ID=ident)
        parts.update(parse_markers(out))
    else:
        interactive = vm.interactive()
        vm.put("gui.bat", vm.script(GUI_BAT, FILE=Path(f).name, ID=ident, TITLE=b.get("title", ""),
                                    PROBEARGS="" if interactive else " -Hidden"))
        vm.put("probe.ps1", PROBE_PS1)
        c2 = 0
        o2 = e2 = ""
        if interactive:
            c2, o2, e2 = vm.run_script("task.bat", TASK_BAT, timeout=60)
            vm.put("done.bat", vm.script(DONE_BAT))
            t0 = time.time()
            while time.time() - t0 < INSTALL_TIMEOUT:
                c3, o3, _ = vm.call("done.bat", timeout=30)
                if "DONE" in o3:
                    break
                time.sleep(5)
            else:
                vm.stop(Path(f).name)
            sh(["ssh", vm.host, "schtasks /delete /tn ibtpl /f"], timeout=60)
        else:
            note = " (nobody logged on at the console: run over SSH; the window was looked for, hidden ones included, on the SSH session's desktop)"
            if vm.call("gui.bat")[0] == 124:
                vm.stop(Path(f).name)
        c4, o4, _ = vm.run_script("results.bat", GUI_RESULTS_BAT, timeout=60)
        parts = parse_markers(o4)
        parts["install"] = parts.get("install_out", "").strip() or "?"
        if c2 or "ERROR" in o2 or "FEHLER" in o2:
            parts["window_out"] = parts.get("window_out", "") + " (schtasks: " + (o2 + e2).strip() + ")"
    code, out, err = vm.run_script("after.bat", AFTER_BAT, timeout=3000, ID=ident)
    parts.update(parse_markers(out))
    if not a.keep:
        vm.remove()
    r, d = judge(key, b, parts, err)
    if r == "fail" and note and "does not have desktop access" in parts.get("applog_out", ""):
        # Java won't open a window on the SSH session's window station
        # (HeadlessException); only a logged-on user's session shows it.
        return "n/a", "nobody logged on at the console, and Java won't open a window in the SSH session (HeadlessException)"
    return r, d + (note if r != "n/a" else "")


# ---------------------------------------------------------------- main

def main():
    global INSTALL_TIMEOUT
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--only", default="")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--host", default="", help="ssh target, overriding the table")
    ap.add_argument("--xvfb", default="Xvfb")
    ap.add_argument("--xvfb-lib", default="", help="LD_LIBRARY_PATH for an unpacked Xvfb")
    ap.add_argument("--keep", action="store_true", help="keep the throwaway folders")
    ap.add_argument("--no-stray", action="store_true",
                    help="don't put STRAY_ENV (a machine-wide TCL_LIBRARY and TK_LIBRARY) in the environment")
    ap.add_argument("--results", default=str(HERE / "results.jsonl"))
    ap.add_argument("--install-timeout", type=int, default=2400,
                    help="seconds an install may take (Rust's can take 20 minutes on a busy datastore)")
    a = ap.parse_args()
    INSTALL_TIMEOUT = a.install_timeout
    builds = json.loads((Path(a.out) / "builds.json").read_text())
    only = [x for x in a.only.split(",") if x]
    plat = "linux" if a.target == "linux" or a.target in LINUX_VMS else "macos" if a.target == "mac" else "windows"
    for key, b in builds.items():
        rt = key.split("/")[0]
        if only and key not in only and rt not in only:
            continue
        a.stray = unix_stray(rt, a)
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
                r, d = run_windows(WinVM(a.target, host, stray=win_stray(rt, a)), key, b, f, a)
            res.update(result=r, detail=d, record=b["record"])
        res["time"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        with open(a.results, "a") as fh:
            fh.write(json.dumps(res) + "\n")
        print(f"{res['result']:4} {a.target:10} {key:15} {res.get('detail', '')[:220]}", flush=True)


if __name__ == "__main__":
    main()
