#!/usr/bin/env python3
"""Checks for what an installer does around the install itself: no menu
entries when the app asks for none (`menu 0`), and running the installer
again on a finished install (docs/format.md section 5, `.ti-installed`).

usage: behaviour.py TARGET [--modes A,C] [--variants nomenu,desktop] [--no-build]

TARGET is `linux` (this machine, in a throwaway home), a Linux VM from
run.LINUX_VMS, a Windows VM from run.WINDOWS, or `mac`. The app is a Python
hello world that also appends a line to `launched.txt` in its working
folder (the app's folder), so a launch shows without a window or a
terminal. Variants: `nomenu` (menu 0, desktop 0), `desktop` (menu 0,
desktop 1), `icon` (menu 0, desktop 0, with an uploaded PNG icon; on
Windows the uninstaller it wrote is fetched back and checked against the
installer, see uninstaller_icon.py). Each cell:

  1. unattended install (--yes, /S): exit 0, nothing in the Start menu or
     the XDG menu folders (or ~/Applications, unless `desktop`), the
     uninstaller and (Windows) its Add/Remove Programs entry are there,
     the app did not run;
  2. unattended again: exit 0, the app did not run, the marker unchanged;
  3. again, not unattended: the app runs (launched.txt, its hello), the
     marker unchanged (nothing reinstalled);
  4. --reinstall / /reinstall, unattended: exit 0, installed again (a new
     marker time, launched.txt gone with the old folder), the app did not
     run;
  5. uninstall: exit 0, nothing left.

Installers are built through the API into <out>/behaviour/ (the Mac's
from the Mac backend, as run.py's are). Results are appended to
results.jsonl with runtime "behaviour-<variant>".
"""
import argparse
import base64
import json
import re
import shlex
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

from run import LINUX_VMS, MAC, WINDOWS, record, sh, tail
from run_windows import appid
import uninstaller_icon

HERE = Path(__file__).resolve().parent
HELLO = ("import os\n"
         "open(os.path.join(os.getcwd(), 'launched.txt'), 'a').write('launched\\n')\n"
         "print('hello from python')\n")
VARIANTS = {"nomenu": {"menu": False, "desktop": False}, "desktop": {"menu": False, "desktop": True},
            # A custom icon. On Windows this is the uninstaller-icon
            # regression (tests/uninstaller_icon.py, docs/design.md 5): NSIS
            # patches the uninstaller's icon over the installer's at fixed
            # file offsets, and an icon written the wrong way put that patch
            # through RT_MANIFEST, so uninstall.exe would not start and the
            # app could not be removed.
            "icon": {"menu": False, "desktop": False}}


def api(backend, path, body=None):
    req = urllib.request.Request(backend + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def build(backend, variant, mode, platforms, out):
    name = "Hello " + variant
    body = {"name": name, "project": "hello", "source": {"kind": "inline"},
            "files": {"hello/__init__.py": "", "hello/__main__.py": HELLO},
            "runtime": "python", "mode": mode, "platforms": platforms,
            "launch": "{runtime} -m hello", "console": False, **VARIANTS[variant]}
    if variant == "icon":
        body["icon"] = {"choice": "upload",
                        "data": base64.b64encode(uninstaller_icon.icon_png()).decode()}
    while True:
        try:
            j = api(backend, "/api/jobs", body)
            break
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            time.sleep(20)
    while j["status"] in ("queued", "running"):
        time.sleep(1)
        j = api(backend, "/api/jobs/" + j["id"])
    if j["status"] != "done":
        raise SystemExit(f"build {variant} {mode}: {j.get('error')}")
    res = j["result"]
    d = out / variant / mode
    d.mkdir(parents=True, exist_ok=True)
    files = {}
    for f in res["files"]:
        p = d / f["name"]
        urllib.request.urlretrieve(backend + f["url"], p)
        files[f["platform"]] = str(p)
    return {"name": name, "record": res["record"], "files": files}


def parse(out):
    parts, cur = {}, None
    for line in out.splitlines():
        line = line.rstrip("\r")
        if line.startswith("@"):
            k, _, v = line[1:].partition(" ")
            parts[k], cur = v, k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    return parts


def judge(p, variant, desktop_seen):
    """The five steps' markers -> (result, detail)."""
    o = lambda k: p.get(k + "_out", "").strip()
    bad = []
    if p.get("install") != "0":
        return "fail", "install exit %s: %s" % (p.get("install"), tail(o("log"), 6))
    if o("menu"):
        bad.append("menu entries: " + o("menu").replace("\n", " ")[:150])
    if "uninstaller-ok" not in o("installed"):
        bad.append("no uninstaller after install: " + o("installed")[:100])
    if "launched" in o("installed").replace("uninstaller-ok", ""):
        bad.append("the install ran the app")
    if variant == "desktop" and not desktop_seen(o("installed")):
        bad.append("no desktop shortcut")
    m1 = o("marker1")
    if "ti-installed\t1" not in m1:
        bad.append("no .ti-installed after install: " + m1[:80])
    if p.get("silent2") != "0":
        bad.append("unattended rerun exit %s" % p.get("silent2"))
    if "launched" in o("silent2"):
        bad.append("the unattended rerun ran the app")
    if o("marker2") != m1:
        bad.append("the unattended rerun changed the install")
    if "launched" not in o("launched"):
        bad.append("the interactive rerun did not start the app: " + tail(o("interactive") + o("log3"), 4))
    if o("marker3") != m1:
        bad.append("the interactive rerun reinstalled")
    # Offline (docs/format.md section 5): the appid comes from the record
    # hash, so a rerun finds the install without fetching anything.
    last = lambda k: (o(k).splitlines() or [""])[-1].strip()
    if p.get("offline_y") != "0" or last("offline_y") != "1":
        bad.append("offline rerun -y: exit %s, launched %s times" % (p.get("offline_y"), last("offline_y")))
    if last("offline_run") != "2":
        bad.append("offline rerun did not start the app (launched %s times)" % last("offline_run"))
    ol = o("offline_log")
    if ol.count("nothing fetched") != 2 or "GET " in ol or "Fetching" in ol:
        bad.append("offline reruns fetched something: " + ol.replace("\n", " ")[:200])
    if p.get("reinstall") != "0":
        bad.append("reinstall exit %s: %s" % (p.get("reinstall"), tail(o("log4"), 4)))
    if "launched" in o("reinstall"):
        bad.append("the reinstall ran the app, or kept the old folder")
    m4 = o("marker4")
    if "ti-installed\t1" not in m4 or m4 == m1:
        bad.append("the reinstall did not install again (marker %r)" % m4[-40:])
    if p.get("uninstall") != "0":
        bad.append("uninstall exit %s" % p.get("uninstall"))
    if o("left"):
        bad.append("left after uninstall: " + o("left").replace("\n", " ")[:200])
    if bad:
        return "fail", "; ".join(bad)
    return "pass", "no menu entries%s; rerun -y: exit 0, not started; rerun: started, not reinstalled; offline: both, nothing fetched; reinstall; clean uninstall" % (
        ", desktop shortcut" if variant == "desktop" else "")


# Linux: this machine or a VM, a throwaway home ---------------------------

UNIX_SCRIPT = r'''
set -u
H=$(mktemp -d /tmp/tib-XXXXXX)
cp "$SRC" "$H/$F"
[ "$VARIANT" = desktop ] && mkdir "$H/Desktop"
run() { env -i HOME="$H" PATH=/usr/local/bin:/usr/bin:/bin LANG=C sh "$@" </dev/null; }
root=$H/.local/share/ti
run "$H/$F" --yes --log="$H/i1.log" >/dev/null 2>&1; echo "@install $?"
A=$(ls -d "$root"/*/.ti-installed 2>/dev/null | head -1); A=${A%/.ti-installed}
[ -n "$A" ] || A=$root/none
echo "@menu"; for d in "$H/.local/share/applications" "$H/.local/share/desktop-directories" "$H/.config/menus"; do [ -e "$d" ] && find "$d"; done
echo "@installed"; [ -f "$A/uninstall.sh" ] && echo uninstaller-ok; [ -e "$A/launched.txt" ] && echo launched; ls "$H/Desktop" 2>/dev/null
echo "@marker1"; cat "$A/.ti-installed" 2>/dev/null
run "$H/$F" --yes >"$H/o2" 2>&1; echo "@silent2 $?"; cat "$H/o2"; [ -e "$A/launched.txt" ] && echo launched
echo "@marker2"; cat "$A/.ti-installed" 2>/dev/null
run "$H/$F" --log="$H/i3.log" >"$H/o3" 2>&1; echo "@interactive $?"; tail -3 "$H/o3"
echo "@launched"; cat "$A/launched.txt" 2>/dev/null
echo "@marker3"; cat "$A/.ti-installed" 2>/dev/null
echo "@log3"; tail -3 "$H/i3.log" 2>/dev/null
run "$H/$F" --yes --backend=http://127.0.0.1:9 --log="$H/i5.log" >/dev/null 2>&1; echo "@offline_y $?"; wc -l < "$A/launched.txt" 2>/dev/null
run "$H/$F" --backend=http://127.0.0.1:9 --log="$H/i6.log" >/dev/null 2>&1; echo "@offline_run $?"; wc -l < "$A/launched.txt" 2>/dev/null
echo "@offline_log"; grep -h 'nothing fetched\|GET \|Fetching' "$H/i5.log" "$H/i6.log" 2>/dev/null
sleep 2
run "$H/$F" --yes --reinstall --log="$H/i4.log" >/dev/null 2>&1; echo "@reinstall $?"; [ -e "$A/launched.txt" ] && echo launched
echo "@marker4"; cat "$A/.ti-installed" 2>/dev/null
echo "@log4"; tail -3 "$H/i4.log" 2>/dev/null
run "$A/uninstall.sh" --yes >/dev/null 2>&1; echo "@uninstall $?"
echo "@left"; (cd "$H" && find . -mindepth 1 ! -name 'i?.log' ! -name 'o?' ! -name "$F" ! -name Desktop ! -path './.cache*' | head -5)
echo "@log"; tail -6 "$H/i1.log" 2>/dev/null
rm -rf "$H"
'''


def run_linux(host, variant, f):
    name = Path(f).name
    env = f"F={shlex.quote(name)} VARIANT={variant} "
    if host is None:
        code, out, err = sh(["sh", "-c", env + f"SRC={shlex.quote(f)} sh -s"], input=UNIX_SCRIPT)
    else:
        sh(["ssh", host, "rm -rf tibtest; mkdir -p tibtest"], timeout=60)
        code, _, err = sh(["scp", "-q", f, f"{host}:tibtest/{name}"], timeout=300)
        if code:
            return "fail", "scp: " + err.strip()
        code, out, err = sh(["ssh", host, env + f'SRC="$HOME/tibtest/{name}" sh -s; rm -rf "$HOME/tibtest"'], input=UNIX_SCRIPT)
    return judge(parse(out), variant, lambda s: ".desktop" in s)


# macOS: the Mac test server, its real home -------------------------------

MAC_SCRIPT = r'''
set -u
cd "$HOME/tibtest" || exit 90
rm -rf x && mkdir x && cd x && ditto -x -k ../in.zip . || exit 91
app=$PWD/$(ls -d *.app)
# New installs go to ~/Library/ti; anything installed before
# 2026-09-20 is still under Application Support (design.md 11,
# item 16), so look in whichever one has this app.
root="$HOME/Library/ti"
[ -d "$root" ] || root="$HOME/Library/Application Support/ti"
run() { "$app/Contents/MacOS/install" --backend=http://127.0.0.1:8080 "$@" </dev/null; }
run --yes --log="$HOME/tibtest/i1.log" >/dev/null 2>&1; echo "@install $?"
A=$(ls -d "$root"/*/.ti-installed 2>/dev/null | head -1); A=${A%/.ti-installed}
[ -n "$A" ] || A=$root/none
echo "@menu"; [ -e "$HOME/Applications/$NAME" ] && echo "folder $HOME/Applications/$NAME"
[ "$VARIANT" != desktop ] && [ -e "$HOME/Applications" ] && ls "$HOME/Applications"
[ -e "$HOME/Applications/Uninstall $NAME.app" ] && echo "uninstaller app"
echo "@installed"; [ -f "$A/uninstall.sh" ] && echo uninstaller-ok; [ -e "$A/launched.txt" ] && echo launched
[ -h "$HOME/Desktop/$NAME" ] && [ -d "$HOME/Applications/$NAME.app" ] && echo "desktop-link-ok"
echo "@marker1"; cat "$A/.ti-installed" 2>/dev/null
run --yes >"$HOME/tibtest/o2" 2>&1; echo "@silent2 $?"; cat "$HOME/tibtest/o2"; [ -e "$A/launched.txt" ] && echo launched
echo "@marker2"; cat "$A/.ti-installed" 2>/dev/null
TI_NO_TERMINAL=1 run --log="$HOME/tibtest/i3.log" >"$HOME/tibtest/o3" 2>&1; echo "@interactive $?"; tail -3 "$HOME/tibtest/o3"
echo "@launched"; cat "$A/launched.txt" 2>/dev/null
echo "@marker3"; cat "$A/.ti-installed" 2>/dev/null
echo "@log3"; tail -3 "$HOME/tibtest/i3.log" 2>/dev/null
run --yes --backend=http://127.0.0.1:9 --log="$HOME/tibtest/i5.log" >/dev/null 2>&1; echo "@offline_y $?"; wc -l < "$A/launched.txt" 2>/dev/null
TI_NO_TERMINAL=1 run --backend=http://127.0.0.1:9 --log="$HOME/tibtest/i6.log" >/dev/null 2>&1; echo "@offline_run $?"; wc -l < "$A/launched.txt" 2>/dev/null
echo "@offline_log"; grep -h 'nothing fetched\|GET \|Fetching' "$HOME/tibtest/i5.log" "$HOME/tibtest/i6.log" 2>/dev/null
sleep 2
run --yes --reinstall --log="$HOME/tibtest/i4.log" >/dev/null 2>&1; echo "@reinstall $?"; [ -e "$A/launched.txt" ] && echo launched
echo "@marker4"; cat "$A/.ti-installed" 2>/dev/null
echo "@log4"; tail -3 "$HOME/tibtest/i4.log" 2>/dev/null
sh "$A/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
echo "@left"; ls "$root" "$HOME/Applications" 2>/dev/null; [ -e "$HOME/Desktop/$NAME" ] || [ -h "$HOME/Desktop/$NAME" ] && echo "desktop link left"
echo "@log"; tail -6 "$HOME/tibtest/i1.log" 2>/dev/null
'''


def run_mac(variant, name, f):
    sh(["ssh", MAC, "rm -rf ~/tibtest; mkdir -p ~/tibtest"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{MAC}:tibtest/in.zip"], timeout=300)
    if code:
        return "fail", "scp: " + err
    code, out, err = sh(["ssh", MAC, f"VARIANT={variant} NAME={shlex.quote(name)} sh -s"], input=MAC_SCRIPT)
    sh(["ssh", MAC, "rm -rf ~/tibtest"], timeout=60)
    return judge(parse(out), variant, lambda s: "desktop-link-ok" in s)


# Windows ------------------------------------------------------------------

BAT = r'''@echo off
setlocal
set T=C:\tibtest
set A=%LOCALAPPDATA%\ti\%ID%
if not defined LOCALAPPDATA set A=C:\ti\%ID%
set DESK=%USERPROFILE%\Desktop
for /f "tokens=2,*" %%a in ('reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders" /v Desktop 2^>nul ^| find "REG_"') do set DESK=%%b
if exist "C:\ti\%ID%" set A=C:\ti\%ID%
"%T%\%FILE%" /S /log=%T%\i1.log
echo @install %ERRORLEVEL%
if exist "C:\ti\%ID%" set A=C:\ti\%ID%
echo @menu
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\%NAME%" echo Start menu folder %NAME%
if exist "%USERPROFILE%\Start Menu\Programs\%NAME%" echo Start menu folder %NAME%
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\%NAME%.lnk" echo Start menu shortcut
echo @installed
if exist "%A%\uninstall.exe" reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ti-%ID%" >nul 2>&1 && echo uninstaller-ok
if exist "%A%\launched.txt" echo launched
if exist "%DESK%\%NAME%.lnk" echo desktop-lnk-ok
echo @marker1
type "%A%\.ti-installed"
"%T%\%FILE%" /S /log=%T%\i2.log
echo @silent2 %ERRORLEVEL%
ping -n 6 127.0.0.1 >nul
if exist "%A%\launched.txt" echo launched
echo @marker2
type "%A%\.ti-installed"
"%T%\%FILE%" /log=%T%\i3.log
echo @interactive %ERRORLEVEL%
set /a n=0
:waitl
if exist "%A%\launched.txt" goto launched
set /a n+=1
if %n% GEQ 60 goto launched
ping -n 2 127.0.0.1 >nul
goto waitl
:launched
ping -n 2 127.0.0.1 >nul
echo @launched
if exist "%A%\launched.txt" type "%A%\launched.txt"
echo @marker3
type "%A%\.ti-installed"
echo @log3
if exist "%T%\i3.log" type "%T%\i3.log"
rem Offline: a backend nobody listens on (a signed mode A base refuses
rem /backend=, so there the logs show that nothing was fetched).
set OFF=/backend=http://127.0.0.1:9
if "%MODE%"=="A" set OFF=
"%T%\%FILE%" /S %OFF% /log=%T%\i5.log
echo @offline_y %ERRORLEVEL%
ping -n 5 127.0.0.1 >nul
set C=0
for /f %%c in ('find /c /v "" ^< "%A%\launched.txt"') do set C=%%c
echo %C%
"%T%\%FILE%" %OFF% /log=%T%\i6.log
echo @offline_run %ERRORLEVEL%
set /a n=0
:waito
set C=0
for /f %%c in ('find /c /v "" ^< "%A%\launched.txt"') do set C=%%c
if "%C%"=="2" goto offdone
set /a n+=1
if %n% GEQ 60 goto offdone
ping -n 2 127.0.0.1 >nul
goto waito
:offdone
echo %C%
echo @offline_log
findstr /c:"nothing fetched" /c:"Fetching" "%T%\i5.log" "%T%\i6.log"
ping -n 3 127.0.0.1 >nul
"%T%\%FILE%" /S /reinstall /log=%T%\i4.log
echo @reinstall %ERRORLEVEL%
if exist "%A%\launched.txt" echo launched
echo @marker4
type "%A%\.ti-installed"
copy /y "%A%\uninstall.exe" "%T%\uninstall.exe" >nul
"%A%\uninstall.exe" /S
echo @uninstall %ERRORLEVEL%
set /a n=0
:waitu
if not exist "%A%" goto left
set /a n+=1
if %n% GEQ 90 goto left
ping -n 2 127.0.0.1 >nul
goto waitu
:left
ping -n 3 127.0.0.1 >nul
echo @left
if exist "%A%" echo %A%
if exist "%APPDATA%\Microsoft\Windows\Start Menu\Programs\%NAME%" echo Start menu folder
if exist "%DESK%\%NAME%.lnk" echo desktop shortcut
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\ti-%ID%" >nul 2>&1 && echo regkey
echo @log
if exist "%T%\i1.log" type "%T%\i1.log"
for /d %%d in ("%TEMP%\~nsu*.tmp") do rd /s /q "%%d" 2>nul
'''


def run_windows(vm, variant, mode, name, f, rec):
    host = vm[0]
    head = "@echo off\r\nset ID=%s\r\nset FILE=%s\r\nset NAME=%s\r\nset MODE=%s\r\n" % (appid(rec), Path(f).name, name, mode)
    bat = BAT.replace("@echo off\nsetlocal\n", "setlocal\n")
    win, scp, run_bat = "C:\\tibtest", "C:/tibtest", "cmd /c C:\\tibtest\\t.bat"
    if "profile" in vm[2:]:
        # As run_windows.py: from the user's own folder, paths quoted.
        bat = re.sub(r"/log=(%T%\\i\d\.log)", r'/log="\1"', bat.replace("set T=C:\\tibtest", "set T=%USERPROFILE%\\tibtest"))
        win, scp = '"%USERPROFILE%\\tibtest"', "tibtest"
        run_bat = f"cmd /c call {win}\\t.bat"
    with tempfile.NamedTemporaryFile("w", suffix=".bat", delete=False, newline="\r\n") as t:
        t.write(head.replace("\r\n", "\n") + bat)
    sh(["ssh", host, f'cmd /c "rd /s /q {win} & mkdir {win}"'], timeout=60)
    for src, dst in ((f, Path(f).name), (t.name, "t.bat")):
        code, _, err = sh(["scp", "-q", src, f"{host}:{scp}/{dst}"], timeout=600)
        if code:
            return "fail", "scp: " + err.strip()
    code, out, err = sh(["ssh", host, run_bat])
    # The uninstaller the install actually wrote, before the folder goes.
    unexe = None
    if variant == "icon":
        with tempfile.NamedTemporaryFile(suffix=".exe", delete=False) as u:
            unexe = u.name
        if sh(["scp", "-q", f"{host}:{scp}/uninstall.exe", unexe], timeout=300)[0]:
            unexe = None
    sh(["ssh", host, f'cmd /c "rd /s /q {win}"'], timeout=60)
    Path(t.name).unlink()
    p = parse(out)
    # Windows writes the marker with the same bytes on every line; `type`
    # adds CRs only to what it prints, so compare stripped text.
    for k in ("marker1", "marker2", "marker3", "marker4"):
        if k + "_out" in p:
            p[k + "_out"] = "\n".join(l.rstrip() for l in p[k + "_out"].splitlines())
    r, d = judge(p, variant, lambda s: "desktop-lnk-ok" in s)
    if variant == "icon":
        # Every resource in uninstall.exe must still be the installer's:
        # NSIS's icon patch has to land on the old, unreferenced images.
        if unexe is None:
            r, d = "fail", "could not fetch uninstall.exe; " + d
        else:
            bad = uninstaller_icon.check(Path(unexe).read_bytes(), Path(f).read_bytes())
            Path(unexe).unlink()
            if bad:
                r, d = "fail", "; ".join(bad) + ("; " + d if r == "fail" else "")
            elif r == "pass":
                d += "; uninstall.exe keeps the custom icon and an intact manifest"
    if r == "fail" and p.get("left_out", "").strip():
        sh(["scp", "-q", str(HERE / "clean_windows.bat"), f"{host}:C:/ticlean.bat"], timeout=60)
        sh(["ssh", host, "cmd /c C:\\ticlean.bat & del C:\\ticlean.bat"], timeout=120)
    return r, d


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--modes", default="A,C")
    ap.add_argument("--variants", default="nomenu,desktop")
    ap.add_argument("--out", default=str(HERE / "out-behaviour"))
    ap.add_argument("--no-build", action="store_true", help="reuse <out>/builds.json")
    a = ap.parse_args()
    mac = a.target == "mac"
    out = Path(a.out + ("-mac" if mac else ""))
    backend = "http://127.0.0.1:8081" if mac else "http://127.0.0.1:8080"
    plat = "macos" if mac else "linux" if a.target == "linux" or a.target in LINUX_VMS else "windows"
    bj = out / "builds.json"
    builds = json.loads(bj.read_text()) if bj.exists() else {}
    for variant in a.variants.split(","):
        for mode in a.modes.split(","):
            key = f"{variant}/{mode}/{plat}"
            if key not in builds or not a.no_build:
                builds[key] = build(backend, variant, mode, [plat], out)
                out.mkdir(parents=True, exist_ok=True)
                bj.write_text(json.dumps(builds, indent=1))
            b = builds[key]
            f = b["files"][plat]
            if a.target == "linux":
                r, d = run_linux(None, variant, f)
            elif a.target in LINUX_VMS:
                r, d = run_linux(LINUX_VMS[a.target], variant, f)
            elif mac:
                r, d = run_mac(variant, b["name"], f)
            else:
                r, d = run_windows(WINDOWS[a.target], variant, mode, b["name"], f, b["record"])
            record({"target": a.target, "runtime": "behaviour-" + variant, "mode": mode,
                    "result": r, "detail": d, "record": b["record"]})


if __name__ == "__main__":
    main()
