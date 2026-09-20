"""Windows cells for run.py: copy the installer and a batch script to the VM,
run it, and read the markers it prints.

The batch script works the same under cmd, PowerShell and Bitvise shells,
and on XP (no timeout.exe, no %LOCALAPPDATA%). The base's options are in
installer/windows/README.md: /S, /log=, exit 0/2/3; launch.exe /out=;
uninstall.exe /S (which returns at once and finishes from %TEMP%).

A WINDOWS entry with a third element "profile" (the German Windows 11 VM,
whose user is "Jörg Müller") runs from %USERPROFILE%\\titest instead of
C:\\titest, with the paths it passes quoted: the installer then starts
from a folder whose path has a space and non-ASCII letters, as it would
from that user's Downloads folder.
"""
import base64
import hashlib
import subprocess
import tempfile
from pathlib import Path

BAT = r'''@echo off
setlocal
set T=C:\titest
set ID=%APPID%
"%T%\%FILE%" /S /log=%T%\install.log
echo @install %ERRORLEVEL%
set A=
if exist "C:\ti\%ID%\launch.exe" set A=C:\ti\%ID%
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ti\%ID%\launch.exe" set A=%LOCALAPPDATA%\ti\%ID%
if not defined A goto left
echo @launch
"%A%\launch.exe" /out=%T%\out.txt
type "%T%\out.txt"
echo @menu
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\%NAME%\%NAME%.lnk" echo startmenu-ok
if exist "%USERPROFILE%\Start Menu\Programs\%NAME%\%NAME%.lnk" echo startmenu-ok
"%A%\uninstall.exe" /S
echo @uninstall %ERRORLEVEL%
set /a n=0
:wait
if not exist "%A%" goto left
set /a n+=1
if %n% GEQ 90 goto left
ping -n 2 127.0.0.1 >nul
goto wait
:left
ping -n 3 127.0.0.1 >nul
echo @left
if exist "C:\ti" dir /b "C:\ti"
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ti" dir /b "%LOCALAPPDATA%\ti"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\%NAME%" echo startmenu-folder-left
if exist "%USERPROFILE%\Start Menu\Programs\%NAME%" echo startmenu-folder-left
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ti-%ID%" >nul 2>&1 && echo regkey-left
echo @osdesc
if exist "%T%\install.log" findstr /b /c:"Windows " "%T%\install.log"
echo @planarch
findstr /b /c:"  Runtime:" "%T%\install.log" 2>nul
echo @log
if exist "%T%\install.log" type "%T%\install.log" | find /v "" | more +0 > "%T%\log8.txt"
if exist "%T%\log8.txt" type "%T%\log8.txt"
for /d %%d in ("%TEMP%\~nsu*.tmp") do rd /s /q "%%d" 2>nul
'''


HOLDERS = "C:\\ti;%LOCALAPPDATA%\\ti"


def clear_holders(host, roots=HOLDERS):
    """Stop whatever is holding files in the app roots, and say what it was.

    A folder that will not delete is nearly always something still
    running -- most often a shell sitting in it, which holds it open even
    when it is empty (design.md 11, item 19). holders.ps1 finds those and
    kills them; without it every later cell on the VM inherits the
    leftover. Returns (lines, ran): the script's own output, and whether
    it ran at all (XP and Vista may have no usable PowerShell).
    """
    from run import sh
    here = Path(__file__).resolve().parent
    code, _, err = sh(["scp", "-q", str(here / "holders.ps1"), f"{host}:C:/tiholders.ps1"], timeout=60)
    if code:
        return [f"(could not copy holders.ps1: {err.strip()[:120]})"], False
    code, out, err = sh(["ssh", host, "powershell -NoProfile -ExecutionPolicy Bypass "
                         f'-File C:\\tiholders.ps1 -Path "{roots}" -Kill'], timeout=300)
    sh(["ssh", host, "cmd /c del C:\\tiholders.ps1"], timeout=60)
    lines = [l.rstrip("\r") for l in out.splitlines() if l.strip()]
    if code or "END" not in lines:
        return lines + [f"(holders.ps1 exit {code}: {err.strip()[:120]})"], False
    return [l for l in lines if not l.startswith("folder ") and l != "END"], True


def appid(record):
    h = hashlib.sha256((record + "/app").encode()).digest()
    return base64.b32encode(h).decode().lower().rstrip("=")[:12]


def in_profile(bat):
    """BAT, run from %USERPROFILE%\\titest, with the paths it passes quoted."""
    return (bat.replace("set T=C:\\titest", "set T=%USERPROFILE%\\titest")
            .replace("/log=%T%\\install.log", '/log="%T%\\install.log"')
            .replace("/out=%T%\\out.txt", '/out="%T%\\out.txt"'))


def test_dir(vm):
    """(folder for cmd, folder for scp) for a WINDOWS entry."""
    if "profile" in vm[2:]:
        return '"%USERPROFILE%\\titest"', "titest"   # scp paths are relative to the user's home
    return "C:\\titest", "C:/titest"


def run_windows(vm, rt, mode, f, record, target):
    from run import sh, tail, plan_fails, verdict, arch_judge
    host = vm[0]
    name = f"Hello {rt}"
    bat = BAT.replace("%APPID%", appid(record)).replace("%FILE%", Path(f).name).replace("%NAME%", name)
    if "profile" in vm[2:]:
        bat = in_profile(bat)
    win, scp = test_dir(vm)
    with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, newline="\r\n") as t:
        t.write(bat)
    sh(["ssh", host, f'cmd /c "rd /s /q {win} & mkdir {win}"'], timeout=60)
    for src, dst in ((f, Path(f).name), (t.name, "t.bat")):
        code, _, err = sh(["scp", "-q", src, f"{host}:{scp}/{dst}"], timeout=600)
        if code:
            return "fail", "scp: " + err.strip(), {}
    run_bat = f"cmd /c call {win}\\t.bat" if "profile" in vm[2:] else "cmd /c C:\\titest\\t.bat"
    code, out, err = sh(["ssh", host, run_bat])
    sh(["ssh", host, f'cmd /c "rd /s /q {win}"'], timeout=60)
    Path(t.name).unlink()
    parts, cur = {}, None
    for line in out.splitlines():
        line = line.rstrip("\r")
        if line.startswith("@"):
            k, _, v = line[1:].partition(" ")
            parts[k], cur = v, k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    log = parts.get("log_out", "")
    judge = lambda r, d: arch_judge(target, parts, r, d)   # noqa: E731
    ic = parts.get("install")
    if ic != "0":
        reason = plan_fails(log)
        if ic == "2" and reason:
            return judge(*verdict(reason))
        return judge("fail", f"install exit {ic}: " + tail(log, 6))
    if f"hello from {rt}" not in parts.get("launch_out", ""):
        return judge("fail", "launch: " + tail(parts.get("launch_out", "") + log, 6))
    left = parts.get("left_out", "").strip()
    if left:
        # Something is left behind. Before calling that the uninstaller's
        # fault, find out what is holding it: a stray shell sitting in the
        # folder keeps it undeletable for every later cell, and is not the
        # installer's doing. Kill the holders, then look again.
        held, ran = clear_holders(host)
        code, again, _ = sh(["ssh", host, 'cmd /c "if exist C:\\ti dir /b C:\\ti & '
                             'if defined LOCALAPPDATA if exist %LOCALAPPDATA%\\ti dir /b %LOCALAPPDATA%\\ti"'],
                            timeout=120)
        still = again.strip()
        who = "; ".join(l for l in held if l.startswith(("holder ", "killed ", "kept ", "kill-failed ")))
        # An app running out of its own folder after uninstalling is the
        # uninstaller's problem; anything else holding it is not.
        ours = any(" exe " in l or " dll " in l for l in held if l.startswith("holder "))
        if not still and not ours:
            # Gone on the second look. Either something was holding it and
            # has been stopped, or the uninstaller was simply still at work:
            # Un_A.exe finishes from %TEMP% after the app folder goes, and
            # the runtime folders it shares with the next test go last.
            if who:
                return judge("pass", "hello + clean uninstall, once what held the folder was stopped: " + who[:300])
            return judge("pass", "hello + clean uninstall (the uninstaller was still finishing at the first look)")
        # Clean up so one bad uninstall doesn't fail every later cell.
        here = Path(__file__).resolve().parent
        sh(["scp", "-q", str(here / "clean_windows.bat"), f"{host}:C:/ticlean.bat"], timeout=60)
        sh(["ssh", host, "cmd /c C:\\ticlean.bat"], timeout=120)
        return judge("fail", (f"uninstall exit {parts.get('uninstall')}, left: {left[:200]}"
                        + (f"; held by: {who[:300]}" if who else "; nothing found holding it")
                        + ("" if ran else " (holders.ps1 did not run)")
                        + (f"; still there: {still[:120]}" if still else "; gone once they were killed")))
    menu = "startmenu-ok" in parts.get("menu_out", "")
    return judge("pass", "hello + clean uninstall" + ("" if menu else " (no Start menu shortcut seen)"))
