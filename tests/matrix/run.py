#!/usr/bin/env python3
"""Run the OS x runtime x mode test matrix (docs/plan.md section 3).

usage: run.py TARGET [--runtimes a,b] [--modes A,B,C] [--out DIR]

TARGET is `linux` (this machine, in a throwaway home), `mac` (the Mac test
server), or a Windows VM name from WINDOWS below. Installers come from
build.py's output (<out>/builds.json; the Mac uses <out>-mac/). Each cell:
install unattended, run the app through its launcher and look for
"hello from <runtime>", uninstall, and check nothing is left. Results are
appended to results.jsonl as one JSON object per cell.
"""
import argparse
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
    # name: (ssh target, default shell)
    "xp": ("matthew@10.0.1.132", "cmd"),
    "vista": ("x@10.0.1.167", "cmd"),
    "7": ("x@10.0.1.231", "cmd"),
    "8.1": ("x@10.0.1.165", "cmd"),
    "10": ("matth@10.0.1.199", "cmd"),
    "11": ("matth@10.0.1.123", "powershell"),
    "2022": ("administrator@10.0.1.248", "cmd"),
}
INSTALL_TIMEOUT = 1800


def sh(cmd, timeout=INSTALL_TIMEOUT, **kw):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace", **kw)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"


def tail(s, n=15):
    return "\n".join(s.strip().splitlines()[-n:])


def record(res):
    res["time"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    with open(HERE / "results.jsonl", "a") as f:
        f.write(json.dumps(res) + "\n")
    mark = {"pass": "PASS", "fail": "FAIL", "n/a": "n/a "}[res["result"]]
    print(f"{mark} {res['target']:6} {res['runtime']:7} {res['mode']}  {res.get('detail', '')[:150]}", flush=True)


def plan_fails(log):
    """The engine's message when no plan block matches, or a block says `fail`."""
    for line in log.splitlines():
        if "nothing for this machine" in line or "No " in line and "release in the catalogue runs" in line:
            return line.strip()
    return None


# Linux: this machine, a throwaway home, no desktop session -------------

def run_linux(rt, mode, f):
    home = tempfile.mkdtemp(prefix="ibm-", dir=os.environ.get("TMPDIR"))
    env = {"HOME": home, "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
    log = Path(home) / "install.log"
    try:
        code, out, err = sh(["sh", f, "--yes", f"--log={log}"], env=env)
        text = log.read_text(errors="replace") if log.exists() else out + err
        if code != 0:
            reason = plan_fails(text)
            return ("n/a", reason) if reason else ("fail", "install: " + tail(text, 6))
        root = Path(home, ".local/share/ib")
        apps = [p.parent for p in root.glob("*/launch.txt")]
        if not apps:
            return "fail", "no app folder after install"
        code, out, err = sh(["sh", str(apps[0] / "launch.sh")], timeout=120, env=env)
        ok = f"hello from {rt}" in out + err
        ucode, uout, uerr = sh(["sh", str(apps[0] / "uninstall.sh"), "--yes"], timeout=300, env=env)
        left = [str(p.relative_to(home)) for p in Path(home).rglob("*") if p != log and ".cache" not in p.parts]
        if not ok:
            return "fail", "launch: " + tail(out + err, 6)
        if ucode != 0 or left:
            return "fail", f"uninstall exit {ucode}, left: {left[:5]}"
        return "pass", "hello + clean uninstall"
    finally:
        subprocess.run(["rm", "-rf", home])


# macOS: the Mac test server through the reverse tunnel -----------------

MAC_SCRIPT = r'''
set -u
cd "$HOME/ibtest" || exit 90
rm -rf x && mkdir x && cd x && ditto -x -k ../in.zip . || exit 91
app=$(ls -d *.app)
if [ "$MODE" = B ]; then codesign -f -s - "$app" >/dev/null 2>&1 || exit 92; fi
IB_NO_TERMINAL=1 "$app/Contents/MacOS/install" --yes --backend=http://127.0.0.1:8080 --log="$HOME/ibtest/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
d=$(ls -d "$HOME/Library/Application Support/ib/"*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  echo "@launch"; IB_NO_TERMINAL=1 sh "$d/launch.sh" </dev/null 2>&1 | tail -5
  sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; ls "$HOME/Library/Application Support/ib" "$HOME/Applications" 2>/dev/null
echo "@log"; tail -8 "$HOME/ibtest/i.log"
'''


def run_mac(rt, mode, f):
    sh(["ssh", MAC, "rm -rf ~/ibtest; mkdir -p ~/ibtest"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{MAC}:ibtest/in.zip"], timeout=300)
    if code:
        return "fail", "scp: " + err
    code, out, err = sh(["ssh", MAC, f"MODE={mode} sh -s"], input=MAC_SCRIPT)
    sh(["ssh", MAC, "rm -rf ~/ibtest"], timeout=60)
    parts = {}
    cur = None
    for line in out.splitlines():
        if line.startswith("@"):
            k, _, v = line[1:].partition(" ")
            parts[k] = v
            cur = k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    if parts.get("install") != "0":
        reason = plan_fails(parts.get("log_out", ""))
        return ("n/a", reason) if reason else ("fail", "install: " + tail(parts.get("log_out", "") + err, 6))
    ok = f"hello from {rt}" in parts.get("launch_out", "")
    left = parts.get("left_out", "").strip()
    if not ok:
        return "fail", "launch: " + tail(parts.get("launch_out", ""), 6)
    if parts.get("uninstall") != "0" or left:
        return "fail", f"uninstall exit {parts.get('uninstall')}, left: {left[:200]}"
    return "pass", "hello + clean uninstall"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--runtimes", default="")
    ap.add_argument("--modes", default="A,B,C")
    ap.add_argument("--out", default=str(HERE / "out"))
    a = ap.parse_args()
    out = Path(a.out + ("-mac" if a.target == "mac" else ""))
    builds = json.loads((out / "builds.json").read_text())
    projects = json.loads((HERE / "projects.json").read_text())["projects"]
    runtimes = a.runtimes.split(",") if a.runtimes else list(projects)
    plat = {"linux": "linux", "mac": "macos"}.get(a.target, "windows")
    for rt in runtimes:
        for mode in a.modes.split(","):
            b = builds.get(f"{rt}/{mode}")
            res = {"target": a.target, "runtime": rt, "mode": mode}
            if not b or b.get("status") != "done":
                res.update(result="fail", detail="build: " + str((b or {}).get("error", "not built")))
                record(res)
                continue
            f = b["files"].get(plat)
            if a.target == "linux":
                r, d = run_linux(rt, mode, f)
            elif a.target == "mac":
                r, d = run_mac(rt, mode, f)
            else:
                from run_windows import run_windows
                r, d = run_windows(WINDOWS[a.target], rt, mode, f, b["record"])
            res.update(result=r, detail=d, record=b["record"])
            record(res)


if __name__ == "__main__":
    main()
