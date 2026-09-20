#!/usr/bin/env python3
"""The five things only a real 32-bit machine can show.

usage: prove32.py [--target debian12x86] [--backend URL] [--out DIR]
                  [--only 1,2,3] [--keep]

The containers in tests/arch/sandbox.py cover most of what a 32-bit Linux
install does, and docs/test-results.md says plainly what they cannot:

  1. a genuinely 32-bit kernel -- the 4 GB ceiling, and a 64-bit binary
     really being refused (in a container it runs, which is why the ELF
     check in machines.py exists at all);
  2. XDG menu entries and a desktop entry, on a desktop that exists;
  3. the dialog tools the engine asks through (zenity, kdialog);
  4. a real system-wide `ldconfig` cache;
  5. sudo, so Rust's `libatomic1` prerequisite can be installed the way a
     person would and the install retried.

Running the matrix here and reporting green would not show any of them,
so each is a numbered proof with its own evidence, and each prints what
it actually saw. A proof that cannot run says so rather than passing.

The VM is taken with tests/arch/vmlock.py for the whole run.
"""
import argparse
import json
import shlex
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import machines                                            # noqa: E402
from vmlock import VMLock                                  # noqa: E402

REPO = HERE.parents[1]
# A statically linked amd64 ELF we already ship, for proof 1: the engine's
# own Ed25519 verifier for 64-bit Linux. On a 32-bit kernel it cannot run.
AMD64_ELF = REPO / "installer/unix/verify/bin/tiverify-linux-x86_64"
X86_ELF = REPO / "installer/unix/verify/bin/tiverify-linux-i386"

results = []


def say(n, name, ok, detail):
    results.append((n, name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'} {n}. {name}\n     {detail}", flush=True)


def sh(cmd, timeout=300, **kw):
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, errors="replace", **kw)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", f"timed out after {timeout}s"


class VM:
    def __init__(self, host):
        self.host = host

    def run(self, script, timeout=600, env=""):
        return sh(["ssh", "-o", "BatchMode=yes", self.host, f"{env} sh -s"],
                  input=script, timeout=timeout)

    def put(self, local, remote):
        return sh(["scp", "-q", str(local), f"{self.host}:{remote}"], timeout=600)[0]


# ---------------------------------------------------------------- 1. the kernel

KERNEL = r'''
echo "uname-m       $(uname -m)"
echo "uname-r       $(uname -r)"
echo "long-bit      $(getconf LONG_BIT)"
echo "kernel-elf    $(head -c5 /boot/vmlinuz-$(uname -r) >/dev/null 2>&1 && echo readable || echo -)"
echo "cpu-lm        $(grep -qw lm /proc/cpuinfo && echo "the CPU is 64-bit capable" || echo "no lm flag")"
echo "kernel-ver    $(head -c 110 /proc/version 2>/dev/null)"
echo "loader        $(ls /lib/ld-linux.so.2 2>/dev/null || echo none)"
echo "loader64      $(ls /lib64/ld-linux-x86-64.so.2 2>/dev/null || echo none)"
# The 4 GB ceiling. Be clear what this shows: it is a property of a
# 32-bit *process*, so a 32-bit userland over a 64-bit kernel refuses it
# too. It is recorded because it is what a person on this machine hits,
# not because it tells a real 32-bit machine from a container.
if command -v python3 > /dev/null 2>&1; then
	python3 -c 'import mmap
try:
    m = mmap.mmap(-1, 3 * 1024**3); m.close()
    print("mapped 3 GB in one block -- this address space is not 32-bit")
except Exception as e:
    print("refused: %s: %s" % (type(e).__name__, e))' 2>&1 | sed 's/^/mmap3g        /'
else
	echo "mmap3g        no python3 here to try it with"
fi
echo "--- a 64-bit binary, on this machine ---"
chmod +x /tmp/ti-amd64-probe /tmp/ti-x86-probe 2>/dev/null
echo "amd64-run     $(/tmp/ti-amd64-probe 2>&1 | head -1 || true) (exit $?)"
echo "x86-run       $(/tmp/ti-x86-probe 2>&1 | head -1 || true) (exit $?)"
file /tmp/ti-amd64-probe /tmp/ti-x86-probe 2>/dev/null | sed 's/^/file         /'
'''


def proof_kernel(vm):
    for src, dest in ((AMD64_ELF, "/tmp/ti-amd64-probe"), (X86_ELF, "/tmp/ti-x86-probe")):
        if not src.exists():
            say(1, "a genuinely 32-bit kernel", False, f"{src} is missing; build the bases first")
            return
        vm.put(src, dest)
    code, out, err = vm.run(KERNEL)
    d = dict(l.split(None, 1) for l in out.splitlines()
             if l and " " in l and not l.startswith(("-", "file", "mmap3g")))
    notes = [l for l in out.splitlines() if l.startswith(("file", "amd64-run", "x86-run", "mmap3g"))]
    rel = d.get("uname-r", "").strip()
    # The decisive one, and the only part a container cannot fake: on a
    # 32-bit kernel an amd64 ELF will not exec. Under `linux32` in a
    # container the same binary runs happily while `uname -m` still says
    # i686 and LONG_BIT still says 32 -- measured, 2026-09-20 -- which is
    # why this proof exists and why machines.py checks the ELF class of
    # everything an install puts on disk.
    refused = "Exec format error" in out
    ok = (d.get("uname-m", "").strip().startswith("i")
          and d.get("long-bit", "").strip() == "32"
          and ("686" in rel or "586" in rel)          # a 32-bit Debian kernel flavour
          and d.get("loader64", "").strip() == "none"
          and refused)
    say(1, "a genuinely 32-bit kernel", ok,
        f"uname -m {d.get('uname-m','?').strip()}, uname -r {rel}, "
        f"LONG_BIT {d.get('long-bit','?').strip()}, {d.get('cpu-lm','?').strip()}; "
        f"/lib64 loader {d.get('loader64','?').strip()}; "
        + ("a 64-bit binary is refused" if refused
           else "A 64-BIT BINARY RAN -- this is not a 32-bit kernel") + ". "
        + " | ".join(n.strip() for n in notes))


# ---------------------------------------------------------------- 2/3. the desktop

DESKTOP = r'''
set -u
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
echo "session       $(ls /tmp/.X11-unix/ 2>/dev/null | tr '\n' ' ')"
echo "wm            $(wmctrl -m 2>/dev/null | sed -n 1p)"
echo "--- menu and desktop entries this install left ---"
for d in "$HOME/.local/share/applications" "$HOME/Desktop" "$HOME/.config/autostart"; do
  [ -d "$d" ] && find "$d" -name '*.desktop' -newer /tmp/ti-mark 2>/dev/null | while read -r f; do
    echo "entry         $f"
    echo "validate      $(desktop-file-validate "$f" 2>&1 | head -2 | tr '\n' ' ' || echo ok)"
    sed -n 's/^\(Name\|Exec\|Type\|Categories\)=/  \1=/p' "$f"
  done
done
echo "menu-cache    $(grep -l "$APPNAME" "$HOME/.local/share/applications/mimeinfo.cache" 2>/dev/null || echo "(no mimeinfo entry)")"
echo "xdg-menu      $(xdg-desktop-menu --help >/dev/null 2>&1 && echo present || echo missing)"
'''

DIALOGS = r'''
set -u
export DISPLAY=${DISPLAY:-:0}
export XAUTHORITY=${XAUTHORITY:-$HOME/.Xauthority}
for tool in zenity kdialog; do
  command -v $tool >/dev/null 2>&1 || { echo "$tool         not installed"; continue; }
  case $tool in
  zenity)   $tool --info --title=tiprobe --text="TiddlyInstall dialog probe" & ;;
  kdialog)  $tool --title tiprobe --msgbox "TiddlyInstall dialog probe" & ;;
  esac
  p=$!
  seen=
  i=0
  while [ $i -lt 40 ]; do
    if xdotool search --name tiprobe >/dev/null 2>&1; then seen=1; break; fi
    if wmctrl -l 2>/dev/null | grep -q tiprobe; then seen=1; break; fi
    sleep 0.5; i=$((i + 1))
  done
  echo "$tool         $([ -n "$seen" ] && echo "opened a window on $DISPLAY" || echo "no window appeared")"
  xdotool search --name tiprobe windowkill 2>/dev/null || kill $p 2>/dev/null
  wait $p 2>/dev/null || true
done
# Which one the engine would choose, by its own rule (ti_ask): a tty
# first, then macOS osascript, then zenity, then kdialog.
echo "engine-would-use $([ -n "${DISPLAY:-}" ] && (command -v zenity >/dev/null && echo zenity || (command -v kdialog >/dev/null && echo kdialog || echo none)) || echo tty)"
'''


def proof_desktop(vm, installer, appname):
    vm.run("touch /tmp/ti-mark")
    name = Path(installer).name
    vm.run("rm -rf ~/tiprove && mkdir -p ~/tiprove")
    if vm.put(installer, f"tiprove/{name}"):
        say(2, "XDG menu and desktop entries", False, "could not copy the installer")
        return
    code, out, err = vm.run(
        f'set -u\ncd ~/tiprove\nsh ./{shlex.quote(name)} --yes --log=$HOME/tiprove/i.log '
        f'>/dev/null 2>&1; echo "install $?"\ntail -3 $HOME/tiprove/i.log\n', timeout=1800)
    if "install 0" not in out:
        say(2, "XDG menu and desktop entries", False, "the install did not finish: " + out.strip()[-300:])
        return
    code, out, err = vm.run(DESKTOP, env=f"APPNAME={shlex.quote(appname)}")
    entries = [l for l in out.splitlines() if l.startswith("entry")]
    bad = [l for l in out.splitlines() if l.startswith("validate") and l.split(None, 1)[1].strip()
           not in ("", "ok")]
    say(2, "XDG menu and desktop entries", bool(entries) and not bad,
        (f"{len(entries)} entry file(s) written, all valid: " if not bad else "invalid entries: ")
        + " | ".join(l.strip() for l in out.splitlines()
                     if l.startswith(("entry", "validate", "session", "wm")) or l.startswith("  ")))


def proof_dialogs(vm):
    code, out, err = vm.run(DIALOGS, timeout=300)
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    ok = any("opened a window" in l for l in lines)
    say(3, "the dialog tools the engine asks through", ok, " | ".join(lines))


# ---------------------------------------------------------------- 4. ldconfig

LDCACHE = r'''
echo "cache-file    $(ls -l /etc/ld.so.cache 2>/dev/null | awk '{print $5" bytes"}' || echo missing)"
echo "cache-entries $(ldconfig -p 2>/dev/null | sed -n 1p)"
echo "libatomic     $(ldconfig -p 2>/dev/null | grep -c libatomic.so.1) in the cache"
ldconfig -p 2>/dev/null | grep libatomic | sed 's/^/  /'
echo "libc-line     $(ldconfig -p 2>/dev/null | grep -m1 'libc\.so\.6')"
'''


def proof_ldconfig(vm, before=True):
    code, out, err = vm.run(LDCACHE)
    lines = [l.rstrip() for l in out.splitlines() if l.strip()]
    # A real cache: /etc/ld.so.cache exists, has entries, and the libc line
    # is not marked x86-64 (which is how the engine's `lib` check filters).
    libc = next((l for l in lines if l.startswith("libc-line")), "")
    ok = ("missing" not in lines[0] and "libs found" in out and "x86-64" not in libc)
    say(4, "a real system-wide ldconfig cache", ok, " | ".join(lines))
    return out


# ---------------------------------------------------------------- 5. sudo + rust

def proof_sudo_rust(vm, installer):
    name = Path(installer).name
    vm.run("rm -rf ~/tiprove2 && mkdir -p ~/tiprove2")
    if vm.put(installer, f"tiprove2/{name}"):
        say(5, "sudo, and the libatomic1 prerequisite installed and retried", False,
            "could not copy the Rust installer")
        return
    step = (f'set -u\nH=$(mktemp -d /tmp/tip-XXXXXX)\ncp ~/tiprove2/{shlex.quote(name)} $H/\n'
            f'env -i HOME=$H PATH=/usr/local/bin:/usr/bin:/bin sh $H/{shlex.quote(name)} --yes '
            f'--log=$H/i.log </dev/null >/dev/null 2>&1; echo "exit $?"\n'
            f'grep -E "needs system packages|Run this" $H/i.log | head -2\n'
            f'ls -d $H/.local/share/ti/*/launch.txt 2>/dev/null | head -1\n'
            f'rm -rf $H\n')
    code, first, _ = vm.run(step, timeout=3600)
    asked = "needs system packages" in first
    if not asked:
        say(5, "sudo, and the libatomic1 prerequisite installed and retried", False,
            "the first run did not ask for libatomic1: " + " ".join(first.split())[:300])
        return
    code, inst, err = vm.run(
        "sudo -n apt-get -qq update >/dev/null 2>&1; "
        "sudo -n DEBIAN_FRONTEND=noninteractive apt-get -qq install -y libatomic1 2>&1 | tail -2; "
        "echo \"apt $?\"; sudo -n ldconfig; ldconfig -p | grep libatomic | head -2", timeout=900)
    if "apt 0" not in inst:
        say(5, "sudo, and the libatomic1 prerequisite installed and retried", False,
            "installing libatomic1 with sudo failed: " + " ".join((inst + err).split())[:300])
        return
    code, second, _ = vm.run(step, timeout=7200)
    ok = "exit 0" in second and "launch.txt" in second
    say(5, "sudo, and the libatomic1 prerequisite installed and retried", ok,
        "first run: stopped with " + " ".join(first.split())[:160]
        + " || sudo apt-get install libatomic1: " + " ".join(inst.split())[:120]
        + " || second run: " + " ".join(second.split())[:160])


# ---------------------------------------------------------------- building

def build(backend, runtime, out, desktop):
    """One installer through the live API, as the matrix builds them."""
    projects = json.loads((REPO / "tests/matrix/projects.json").read_text())["projects"]
    proj = projects[runtime]
    body = {"name": f"Hello {runtime}", "project": proj["project"], "source": {"kind": "inline"},
            "files": proj["files"], "runtime": runtime, "mode": "C", "platforms": ["linux"],
            "launch": proj["launch"], "console": True, "menu": True, "desktop": desktop}
    if proj.get("install"):
        body["install"] = proj["install"]
    req = urllib.request.Request(backend + "/api/jobs", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        j = json.load(r)
    while j["status"] in ("queued", "running"):
        time.sleep(1)
        with urllib.request.urlopen(backend + "/api/jobs/" + j["id"], timeout=60) as r:
            j = json.load(r)
    if j["status"] != "done":
        sys.exit(f"build of {runtime} failed: {j.get('error')}")
    f = next(x for x in j["result"]["files"] if x["platform"] == "linux")
    out.mkdir(parents=True, exist_ok=True)
    p = out / f["name"]
    urllib.request.urlretrieve(backend + f["url"], p)
    print(f"built {runtime} mode C (desktop={int(desktop)}): {p.name}", flush=True)
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="debian12x86")
    ap.add_argument("--host", default="", help="ssh target, overriding machines.py's table")
    ap.add_argument("--backend", default="http://127.0.0.1:8080")
    ap.add_argument("--out", default="")
    ap.add_argument("--only", default="", help="e.g. 1,4,5")
    a = ap.parse_args()
    if a.target not in machines.MACHINES:
        sys.exit(f"{a.target}: not in tests/arch/machines.py")
    if machines.arch_of(a.target) != "x86":
        sys.exit(f"{a.target} is {machines.arch_of(a.target)}; these proofs are about a 32-bit machine")
    sys.path.insert(0, str(REPO / "tests/matrix"))
    import run as matrix                                   # noqa: E402
    host = a.host or matrix.LINUX_VMS.get(a.target, "")
    if not host:
        sys.exit(f"no ssh target for {a.target}: add it to tests/matrix/run.py's LINUX_VMS, or give --host")
    only = {int(x) for x in a.only.split(",") if x.strip()}
    out = Path(a.out) if a.out else Path("/tmp/tiprove32")

    node = rust = None
    if not only or only & {2}:
        node = build(a.backend, "node", out, desktop=True)
    if not only or only & {5}:
        rust = build(a.backend, "rust", out, desktop=False)

    vm = VM(host)
    with VMLock(host=host, windows=False, who=f"prove32 {a.target}"):
        if not only or 1 in only:
            proof_kernel(vm)
        if not only or 2 in only:
            proof_desktop(vm, node, "Hello node")
        if not only or 3 in only:
            proof_dialogs(vm)
        if not only or 4 in only:
            proof_ldconfig(vm)
        if not only or 5 in only:
            proof_sudo_rust(vm, rust)
        vm.run("rm -rf ~/tiprove ~/tiprove2 /tmp/ti-amd64-probe /tmp/ti-x86-probe /tmp/ti-mark")
    bad = [r for r in results if not r[2]]
    print(f"\n{len(results)} proofs: {len(results) - len(bad)} pass, {len(bad)} fail.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
