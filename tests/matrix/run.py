#!/usr/bin/env python3
"""Run the OS x runtime x mode test matrix (docs/plan.md section 3).

usage: run.py TARGET [--runtimes a,b] [--modes A,B,C] [--out DIR]

TARGET is `linux` (this machine, in a throwaway home), `mac` (the Mac test
server), a Linux VM from LINUX_VMS, a 32-bit Linux container from
tests/arch/sandbox.py, or a Windows VM name from WINDOWS below. Installers
come from build.py's output (<out>/builds.json; the Mac uses <out>-mac/).
Each cell: install unattended, run the app through its launcher and look
for "hello from <runtime>", uninstall, and check nothing is left. Results
are appended to results.jsonl as one JSON object per cell.

Every cell also records the architecture it ran on: what
tests/arch/machines.py says the machine is, what the installer's own engine
detected (`arch_seen`), and the ELF class of what it installed
(`arch_elf`). A disagreement fails the cell -- on a 32-bit userland over a
64-bit kernel an amd64 runtime would run perfectly well and the cell would
otherwise be green.
"""
import argparse
import atexit
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
WINDOWS = {
    # name: (ssh target, default shell[, "profile"])
    "xp": ("matthew@10.0.1.132", "cmd"),
    "vista": ("x@10.0.1.167", "cmd"),
    "7": ("x@10.0.1.231", "cmd"),
    "8.1": ("x@10.0.1.165", "cmd"),
    "10": ("matth@10.0.1.199", "cmd"),
    "11": ("matth@10.0.1.123", "powershell"),
    "2022": ("administrator@10.0.1.248", "cmd"),
    # ESXi installer-test VMs from tools/esxi_provision_windows.py (docs/test-vms.md).
    "10x86": ("x@10.0.1.47", "cmd"),
    "ltsc2021": ("x@10.0.1.86", "cmd"),
    "ltsc2024": ("x@10.0.1.209", "cmd"),
    "2025core": ("x@10.0.1.124", "cmd"),
    # German Windows 11: runs as the awkward-name user, from a folder in
    # that user's profile ("profile": see run_windows.py).
    "11de": ("Jörg Müller@10.0.1.83", "cmd", "profile"),
}
# Linux test VMs on the ESXi host (docs/test-vms.md): name -> ssh target.
LINUX_VMS = {
    "centos6": "x@10.0.1.183", "centos7": "x@10.0.1.221", "ubuntu1404": "x@10.0.1.117",
    "ubuntu1604": "x@10.0.1.112", "ubuntu1804": "x@10.0.1.144", "rocky8": "x@10.0.1.131",
    "ubuntu2004": "x@10.0.1.118", "ubuntu2204": "x@10.0.1.203", "debian12": "x@10.0.1.235",
    "alpine": "x@10.0.1.200",
    # The 32-bit VM (docs/test-vms.md): a real 32-bit kernel, a desktop
    # and sudo, which the containers below cannot show. Made by
    # tools/esxi_provision_debian_i386.py; address from DHCP 2026-09-21.
    "debian12x86": "x@10.0.1.160",
}
# 32-bit Linux, in a container on this machine (tests/arch/mkroot.py makes
# the roots; sandbox.py says what a container can and cannot show).
SANDBOXES = ("debian12-i386", "debian12-i386-libs", "alpine324-i386")
INSTALL_TIMEOUT = 1800


def sh(cmd, timeout=INSTALL_TIMEOUT, **kw):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace", **kw)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"


def tail(s, n=15):
    return "\n".join(s.strip().splitlines()[-n:])


RESULTS_FILE = HERE / "results.jsonl"


def record(res):
    res["time"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    res.setdefault("arch", machines.arch_of(res["target"]))
    with open(RESULTS_FILE, "a") as f:
        f.write(json.dumps(res) + "\n")
    mark = {"pass": "PASS", "fail": "FAIL", "n/a": "n/a ", "no-plan": "NOPL",
            "known": "KNWN"}[res["result"]]
    print(f"{mark} {res['target']:14} {res['arch']:5} {res['runtime']:7} {res['mode']}  "
          f"{res.get('detail', '')[:150]}", flush=True)


# The engine's own words when the plan has no block for this machine at
# all. That is not the catalogue saying "no release runs here" (which is a
# `fail` block, with the runtime and the OS named): it means the resolver
# made no block for this OS and architecture, so the cell is untested
# rather than not applicable. docs/test-results.md keeps them apart.
NO_BLOCK = "nothing for this machine"


def plan_fails(log):
    """The engine's message when it refused this combination up front, when no
    plan block matches or a block says `fail`, or when a prerequisite needs
    root that an unattended install can't get."""
    for line in log.splitlines():
        # A refusal: the plan, or a prerequisite nothing here can add, said
        # this combination cannot work, and the installer stopped before
        # touching anything (docs/format.md, "Combinations that cannot
        # work"). That is a result of its own, not a broken install.
        if "Refused before installing:" in line:
            return "refused: " + line.split("Refused before installing:", 1)[1].strip()
        if "needs system packages" in line or "needs administrator rights" in line:
            return "needs root: " + line.strip()
        if NO_BLOCK in line or "no install plan for this version of Windows" in line:
            return line.strip()
        if "No " in line and "release in the catalogue runs" in line:
            return line.strip()
    return None


def verdict(reason):
    """"n/a" (the catalogue has no release) or "no-plan" (the plan has no
    block for this machine), for a reason plan_fails found."""
    return ("no-plan" if (NO_BLOCK in reason or "no install plan for" in reason) else "n/a"), reason


arch_judge = machines.judge


# Linux: this machine, a throwaway home, no desktop session -------------

def run_linux(rt, mode, f, target="linux"):
    # The script makes its own throwaway home under $TMPROOT and removes it.
    env = {"HOME": os.path.expanduser("~"), "PATH": "/usr/local/bin:/usr/bin:/bin",
           "LANG": "C.UTF-8", "SRC": str(Path(f).resolve()), "F": Path(f).name}
    if os.environ.get("TMPDIR"):
        env["TMPDIR"] = os.environ["TMPDIR"]
    code, out, err = sh(["sh", "-c", LOCAL_SCRIPT], env=env)
    return parse_unix(rt, out, err, target)


# Linux VMs, this machine and the 32-bit containers all run these steps in
# a throwaway home. ti_elf_probe (tests/arch/machines.py) says what
# architecture the runtime that was installed really is.
LINUX_BODY = machines.ELF_PROBE_SH + r'''
set -u
H=$(mktemp -d "$TMPROOT/ibm-XXXXXX")
cp "$SRC" "$H/$F"
env -i HOME="$H" PATH=/usr/local/bin:/usr/bin:/bin LANG=C sh "$H/$F" --yes --log="$H/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
echo "@osdesc"; sed -n 's/^Running as .* on //p' "$H/i.log" 2>/dev/null | head -1
echo "@planarch"; sed -n '/^ *Runtime:/{p;q;}' "$H/i.log" 2>/dev/null
echo "@x"
d=$(ls -d "$H"/.local/share/ti/*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  echo "@launch"; env -i HOME="$H" PATH=/usr/local/bin:/usr/bin:/bin sh "$d/launch.sh" </dev/null 2>&1 | tail -5
  echo "@elf"; ti_elf_probe "$H/.local/share/ti"
  env -i HOME="$H" PATH=/usr/local/bin:/usr/bin:/bin sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; (cd "$H" && find . -mindepth 1 ! -name i.log ! -name "$F" ! -path './.cache*' | head -5)
echo "@log"; tail -8 "$H/i.log" 2>/dev/null
rm -rf "$H"
'''
LINUX_SCRIPT = LINUX_BODY.replace('cp "$SRC"', 'SRC="$HOME/titest/$F"; cp "$SRC"') + '\nrm -rf "$HOME/titest"\n'
LOCAL_SCRIPT = 'TMPROOT=${TMPDIR:-/tmp}\n' + LINUX_BODY
SANDBOX_SCRIPT = 'TMPROOT=/tmp\nSRC=/tisrc/$F\n' + LINUX_BODY


def run_linux_vm(host, rt, mode, f, target):
    # Keep the file's own name: mode A reads the record hash from it.
    name = Path(f).name
    sh(["ssh", host, "rm -rf titest; mkdir -p titest"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{host}:titest/{name}"], timeout=300)
    if code:
        return "fail", "scp: " + err.strip(), {}
    code, out, err = sh(["ssh", host, f"TMPROOT=/tmp F={shlex.quote(name)} sh -s"], input=LINUX_SCRIPT)
    return parse_unix(rt, out, err, target)


# 32-bit Linux: the same steps, in a container on this machine ------------

def run_sandbox(target, rt, mode, f):
    import sandbox
    src = Path(f).resolve().parent
    rc, out, err = sandbox.run_script(
        target, SANDBOX_SCRIPT, env={"HOME": "/home/ti", "F": Path(f).name,
                                     "PATH": "/usr/local/bin:/usr/bin:/bin"},
        ro={src: "/tisrc"}, timeout=INSTALL_TIMEOUT)
    if rc == 124:
        return "fail", err, {}
    return parse_unix(rt, out, err, target)


def parse_unix(rt, out, err, target):
    parts, cur = {}, None
    for line in out.splitlines():
        if line.startswith("@"):
            k, _, v = line[1:].partition(" ")
            parts[k], cur = v, k
        elif cur:
            parts[cur + "_out"] = parts.get(cur + "_out", "") + line + "\n"
    r, d = _judge_unix(rt, parts, err)
    return arch_judge(target, parts, r, d)


def _judge_unix(rt, parts, err):
    if parts.get("install") != "0":
        reason = plan_fails(parts.get("log_out", ""))
        return verdict(reason) if reason else ("fail", "install: " + tail(parts.get("log_out", "") + err, 6))
    if f"hello from {rt}" not in parts.get("launch_out", ""):
        return "fail", "launch: " + tail(parts.get("launch_out", ""), 6)
    left = parts.get("left_out", "").strip()
    if parts.get("uninstall") != "0" or left:
        return "fail", f"uninstall exit {parts.get('uninstall')}, left: {left[:200]}"
    return "pass", "hello + clean uninstall"


# macOS: the Mac test server through the reverse tunnel -----------------

MAC_SCRIPT = r'''
set -u
cd "$HOME/titest" || exit 90
# A browser sets com.apple.quarantine on what it downloads; `scp` does not,
# which is how the matrix missed for months that Gatekeeper kills our macOS
# installers outright (docs/macos-packaging.md section 5: unsigned and
# ad-hoc signed alike, exit 137, because only a notarization ticket
# satisfies it). So the cell now runs the installer the way a downloader
# would get it, and only then -- to keep the engine itself under test --
# clears the flag and runs it again.
Q=${QUARANTINE:-1}
qval="0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)"
[ "$Q" = 1 ] && xattr -w com.apple.quarantine "$qval" in.zip 2>/dev/null
rm -rf x && mkdir x && cd x && ditto -x -k ../in.zip . || exit 91
app=$(ls -d *.app)
if [ "$MODE" = B ]; then codesign -f -s - "$app" >/dev/null 2>&1 || exit 92; fi
if [ "$Q" = 1 ]; then
  # ditto carries the flag across; put it on by hand if it did not.
  xattr -p com.apple.quarantine "$app" > /dev/null 2>&1 ||
    xattr -w com.apple.quarantine "$qval" "$app" 2>/dev/null
  echo "@quarantine $(xattr -p com.apple.quarantine "$app" 2>/dev/null || echo none)"
  TI_NO_TERMINAL=1 "$app/Contents/MacOS/install" --yes --backend=http://127.0.0.1:8080 --log="$HOME/titest/q.log" </dev/null > /dev/null 2>&1
  echo "@qexit $?"
  echo "@spctl"; spctl -a -vv "$app" 2>&1 | head -2
  xattr -dr com.apple.quarantine "$app" 2>/dev/null
fi
TI_NO_TERMINAL=1 "$app/Contents/MacOS/install" --yes --backend=http://127.0.0.1:8080 --log="$HOME/titest/i.log" </dev/null >/dev/null 2>&1
echo "@install $?"
echo "@osdesc"; sed -n 's/^Running as .* on //p' "$HOME/titest/i.log" 2>/dev/null | head -1
echo "@planarch"; sed -n '/^ *Runtime:/{p;q;}' "$HOME/titest/i.log" 2>/dev/null
echo "@x"
d=$(ls -d "$HOME/Library/ti/"*/launch.txt "$HOME/Library/Application Support/ti/"*/launch.txt 2>/dev/null | head -1)
if [ -n "$d" ]; then
  d=$(dirname "$d")
  echo "@launch"; TI_NO_TERMINAL=1 sh "$d/launch.sh" </dev/null 2>&1 | tail -5
  sh "$d/uninstall.sh" --yes </dev/null >/dev/null 2>&1; echo "@uninstall $?"
fi
echo "@left"; ls "$HOME/Library/ti" "$HOME/Library/Application Support/ti" "$HOME/Applications" 2>/dev/null
echo "@log"; tail -8 "$HOME/titest/i.log"
'''


def run_mac(rt, mode, f, quarantine=True):
    sh(["ssh", MAC, "rm -rf ~/titest; mkdir -p ~/titest"], timeout=60)
    code, _, err = sh(["scp", "-q", f, f"{MAC}:titest/in.zip"], timeout=300)
    if code:
        return "fail", "scp: " + err, {}
    code, out, err = sh(["ssh", MAC, f"MODE={mode} QUARANTINE={1 if quarantine else 0} sh -s"],
                        input=MAC_SCRIPT)
    sh(["ssh", MAC, "rm -rf ~/titest"], timeout=60)
    r, d, extra = parse_unix(rt, out, err, "mac")
    return mac_gatekeeper(out, r, d, extra)


# Failures we already know about, with why and what would clear them.
# A platform that is permanently red teaches everyone to ignore red, and
# then a real regression arrives and nobody looks; these report as KNWN
# so that anything *else* failing on that platform still stands out.
KNOWN = {
    "mac-gatekeeper":
        "expected until there is a Developer ID: Gatekeeper kills any installer that "
        "arrives with com.apple.quarantine, ad-hoc signed or not, because only a "
        "notarization ticket satisfies it (docs/macos-packaging.md section 5)",
}


def mac_gatekeeper(out, r, d, extra):
    """What the quarantined run means for the cell's result.

    The quarantined run is the one a real user gets and the unquarantined
    one only says whether the engine still works. Today the first always
    fails, so a plain `fail` would make every macOS cell red for ever and
    hide the next real regression. The two are therefore read together:

      quarantined killed, engine fine   -> known   (the failure we expect)
      quarantined killed, engine broken -> fail    (something else as well)
      quarantined ran                   -> whatever the cell itself said,
                                           and worth noticing, because it
                                           means we got notarized

    A cell that is `n/a` or `no-plan` keeps its own verdict: the catalogue
    has no release for this machine, or the plan has no block for it, and
    the installer said so and stopped. Nothing was installed either way,
    so there is no engine to call broken, and calling it `fail` (which is
    what this did until 2026-09-20) turned python2's three honest
    n/a cells red.

    Signed by a Developer ID, the two runs agree and this goes quiet.
    """
    parts = {}
    for line in out.splitlines():
        if line.startswith("@"):
            k, _, v = line[1:].partition(" ")
            parts[k] = v
    q = parts.get("qexit")
    if q is None or q == "0":
        return r, d, extra                      # --no-quarantine, or it ran
    why = "killed by Gatekeeper" if q in ("137", "-9") else f"exit {q}"
    head = f"quarantined (as a browser download): {why}"
    if r == "pass":
        return "known", f"{head} -- {KNOWN['mac-gatekeeper']}; with the flag cleared: {d}", extra
    if r != "fail":
        return r, f"{d} ({head})", extra
    # The engine is broken too, which is not the failure we expect.
    return "fail", f"{head}, AND with the flag cleared it still fails: {d}", extra


def main():
    global RESULTS_FILE
    ap = argparse.ArgumentParser()
    ap.add_argument("target")
    ap.add_argument("--runtimes", default="")
    ap.add_argument("--modes", default="A,B,C")
    ap.add_argument("--out", default=str(HERE / "out"))
    ap.add_argument("--results", default=str(RESULTS_FILE))
    ap.add_argument("--no-quarantine", action="store_true",
                    help="macOS: skip the com.apple.quarantine run, to test the engine alone")
    a = ap.parse_args()
    RESULTS_FILE = Path(a.results)
    if a.target not in machines.MACHINES:
        raise SystemExit(f"{a.target}: no such machine in tests/arch/machines.py "
                         f"(add it, with its architecture, before running it)")
    # One harness at a time per machine (tests/arch/vmlock.py): four of
    # them install into the same folders on the same VMs, and one cleans
    # up by deleting everything under them.
    lh, lw = vmlock.target_host(a.target, WINDOWS, LINUX_VMS, MAC)
    lock = vmlock.VMLock(lh, lw, f"matrix {a.target}").acquire()
    atexit.register(lock.release)
    out = Path(a.out + ("-mac" if a.target == "mac" else ""))
    builds = json.loads((out / "builds.json").read_text())
    projects = json.loads((HERE / "projects.json").read_text())["projects"]
    runtimes = a.runtimes.split(",") if a.runtimes else list(projects)
    known = set(LINUX_VMS) | set(SANDBOXES) | set(WINDOWS) | {"linux", "mac"}
    if a.target not in known:
        raise SystemExit(f"{a.target} is in tests/arch/machines.py but this harness has no address "
                         f"for it: add it to LINUX_VMS or WINDOWS once the machine exists")
    plat = "linux" if a.target in LINUX_VMS or a.target in SANDBOXES \
        else {"linux": "linux", "mac": "macos"}.get(a.target, "windows")
    for rt in runtimes:
        for mode in a.modes.split(","):
            b = builds.get(f"{rt}/{mode}")
            res = {"target": a.target, "arch": machines.arch_of(a.target), "runtime": rt, "mode": mode}
            if not b or b.get("status") != "done":
                res.update(result="fail", detail="build: " + str((b or {}).get("error", "not built")))
                record(res)
                continue
            f = b["files"].get(plat)
            if not f:
                res.update(result="fail", detail=f"build: no {plat} installer in {out}")
                record(res)
                continue
            if a.target == "linux":
                r, d, extra = run_linux(rt, mode, f)
            elif a.target == "mac":
                r, d, extra = run_mac(rt, mode, f, quarantine=not a.no_quarantine)
            elif a.target in SANDBOXES:
                r, d, extra = run_sandbox(a.target, rt, mode, f)
            elif a.target in LINUX_VMS:
                r, d, extra = run_linux_vm(LINUX_VMS[a.target], rt, mode, f, a.target)
            else:
                from run_windows import run_windows
                r, d, extra = run_windows(WINDOWS[a.target], rt, mode, f, b["record"], a.target)
            res.update(result=r, detail=d, record=b["record"], **extra)
            record(res)


if __name__ == "__main__":
    main()
