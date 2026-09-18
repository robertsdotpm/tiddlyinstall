"""Windows cells for run.py: copy the installer and a batch script to the VM,
run it, and read the markers it prints.

The batch script works the same under cmd, PowerShell and Bitvise shells,
and on XP (no timeout.exe, no %LOCALAPPDATA%). The base's options are in
bases/windows/README.md: /S, /log=, exit 0/2/3; launch.exe /out=;
uninstall.exe /S (which returns at once and finishes from %TEMP%).
"""
import base64
import hashlib
import subprocess
import tempfile
from pathlib import Path

BAT = r'''@echo off
setlocal
set T=C:\ibtest
set ID=%APPID%
"%T%\%FILE%" /S /log=%T%\install.log
echo @install %ERRORLEVEL%
set A=
if exist "C:\ib\%ID%\launch.exe" set A=C:\ib\%ID%
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib\%ID%\launch.exe" set A=%LOCALAPPDATA%\ib\%ID%
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
if exist "C:\ib" dir /b "C:\ib"
if defined LOCALAPPDATA if exist "%LOCALAPPDATA%\ib" dir /b "%LOCALAPPDATA%\ib"
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\%NAME%" echo startmenu-folder-left
if exist "%USERPROFILE%\Start Menu\Programs\%NAME%" echo startmenu-folder-left
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-%ID%" >nul 2>&1 && echo regkey-left
echo @log
if exist "%T%\install.log" type "%T%\install.log" | find /v "" | more +0 > "%T%\log8.txt"
if exist "%T%\log8.txt" type "%T%\log8.txt"
for /d %%d in ("%TEMP%\~nsu*.tmp") do rd /s /q "%%d" 2>nul
'''


def appid(record):
    h = hashlib.sha256((record + "/app").encode()).digest()
    return base64.b32encode(h).decode().lower().rstrip("=")[:12]


def run_windows(vm, rt, mode, f, record):
    from run import sh, tail, plan_fails
    host, _shell = vm
    name = f"Hello {rt}"
    bat = BAT.replace("%APPID%", appid(record)).replace("%FILE%", Path(f).name).replace("%NAME%", name)
    with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, newline="\r\n") as t:
        t.write(bat)
    sh(["ssh", host, 'cmd /c "rd /s /q C:\\ibtest & mkdir C:\\ibtest"'], timeout=60)
    for src, dst in ((f, Path(f).name), (t.name, "t.bat")):
        code, _, err = sh(["scp", "-q", src, f"{host}:C:/ibtest/{dst}"], timeout=600)
        if code:
            return "fail", "scp: " + err.strip()
    code, out, err = sh(["ssh", host, "cmd /c C:\\ibtest\\t.bat"])
    sh(["ssh", host, 'cmd /c "rd /s /q C:\\ibtest"'], timeout=60)
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
    ic = parts.get("install")
    if ic != "0":
        reason = plan_fails(log)
        if ic == "2" and reason:
            return "n/a", reason
        return "fail", f"install exit {ic}: " + tail(log, 6)
    if f"hello from {rt}" not in parts.get("launch_out", ""):
        return "fail", "launch: " + tail(parts.get("launch_out", "") + log, 6)
    left = parts.get("left_out", "").strip()
    if left:
        # Clean up so one bad uninstall doesn't fail every later cell.
        here = Path(__file__).resolve().parent
        sh(["scp", "-q", str(here / "clean_windows.bat"), f"{host}:C:/ibclean.bat"], timeout=60)
        sh(["ssh", host, "cmd /c C:\\ibclean.bat"], timeout=120)
        return "fail", f"uninstall exit {parts.get('uninstall')}, left: {left[:200]}"
    menu = "startmenu-ok" in parts.get("menu_out", "")
    return "pass", "hello + clean uninstall" + ("" if menu else " (no Start menu shortcut seen)")
