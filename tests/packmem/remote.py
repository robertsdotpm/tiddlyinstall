#!/usr/bin/env python3
"""One packing measurement on one test machine, in one of its browsers.

    python3 tests/packmem/remote.py --machine xp --browser supermium \
        --query 'steps=32,64,128&members=4&pause=900'

Takes the machine's lock (tests/arch/vmlock.py), starts the machine's own
sampler, opens the measurement page in the named browser pointed at this
machine's collector, waits for the page to report an end (or to stop
reporting), then stops everything and copies the sampler's file back.

The page is opened *directly*, not through WebDriver: several of the
browsers that matter here have no driver that runs (Supermium on XP,
Firefox 52), and this needs nothing from a driver but a URL. The page
reports over HTTP to the collector, so there is nothing to read back out of
the browser.

Nothing is installed on any machine: the sampler is a file copied into the
harness's own folder and deleted afterwards, and each browser runs on a
profile made under that folder and removed with it.
"""
import argparse
import json
import os
import re
import signal
import socket
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tests", "arch"))
sys.path.insert(0, os.path.join(ROOT, "tests", "matrix"))
from vmlock import VMLock, Busy  # noqa: E402

SSH = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
       "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"]
WORK_WIN = r"C:\tipackmem"
WORK_UNIX = "tipackmem"


def machines():
    import run as matrix  # tests/matrix/run.py
    out = {}
    for name, v in matrix.WINDOWS.items():
        out[name] = dict(ssh=v[0], os="windows", shell=v[1])
    for name, ssh in matrix.LINUX_VMS.items():
        out[name] = dict(ssh=ssh, os="linux")
    out["mac"] = dict(ssh=matrix.MAC, os="mac")
    return out


def sh(target, cmd, timeout=180, check=False):
    p = subprocess.run(["ssh", *SSH, target, cmd], capture_output=True, text=True,
                       timeout=timeout, errors="replace")
    if check and p.returncode:
        raise RuntimeError(f"{cmd[:80]}: {p.stderr.strip()[:300]}")
    return p.returncode, (p.stdout or "").replace("\r", ""), (p.stderr or "").replace("\r", "")


def bg(target, cmd, log=None):
    """`cmd` on the machine, in a session that stays open until we close it.

    Not `start` or `nohup`: the Bitvise servers on the Windows VMs end the
    session when the command returns, and take the browser with them, so the
    browser has to be what the session is running.
    """
    out = open(log, "w") if log else subprocess.DEVNULL
    return subprocess.Popen(["ssh", *SSH, target, cmd], stdin=subprocess.DEVNULL,
                            stdout=out, stderr=subprocess.STDOUT)


def put(target, local, remote):
    p = subprocess.run(["scp", *SSH, "-q", local, f"{target}:{remote}"],
                       capture_output=True, text=True, timeout=600)
    if p.returncode:
        raise RuntimeError(f"scp {os.path.basename(local)}: {(p.stderr or '').strip()[:300]}")


def my_address(target):
    """The address this machine has on the route to `target`."""
    host = target.split("@")[-1]
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect((host, 22))
        return s.getsockname()[0]
    finally:
        s.close()


def browser_cmd(m, b, url, profile):
    """How to start browser `b` on machine `m` at `url`, and the pattern that
    finds its processes. Everything Chromium takes --user-data-dir, which
    both isolates the run and tags every one of its processes."""
    bid = b["id"]
    binary = b["binary"]
    if m["os"] == "windows":
        if bid.startswith(("chrome", "edge", "supermium", "opera", "chromium", "brave", "vivaldi")):
            args = (f'--user-data-dir="{profile}" --no-first-run --no-default-browser-check '
                    f'--disable-background-networking --disable-sync "{url}"')
            return f'"{binary}" {args}', os.path.basename(binary)
        if bid.startswith("firefox"):
            return f'"{binary}" -profile "{profile}" -no-remote "{url}"', os.path.basename(binary)
    else:
        if bid.startswith(("chrome", "chromium", "opera", "brave", "vivaldi", "edge")):
            return (f'"{binary}" --user-data-dir="{profile}" --no-first-run '
                    f'--no-default-browser-check --disable-dev-shm-usage "{url}"'), profile
        if bid.startswith("firefox"):
            return f'"{binary}" --profile "{profile}" --no-remote "{url}"', profile
    raise SystemExit(f"no start line for {bid} on {m['os']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--machine", required=True)
    ap.add_argument("--browser", required=True)
    ap.add_argument("--query", default="steps=32,64,128&members=4&pause=900")
    ap.add_argument("--run", default="")
    ap.add_argument("--page", default="packmem.html")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--timeout", type=int, default=1200)
    ap.add_argument("--headless", action="store_true",
                    help="add --headless=new (Chromium only, and not on the old ones)")
    ap.add_argument("--no-lock", action="store_true")
    ap.add_argument("--binary", default="",
                    help="the browser's path on the machine, when it has no browsers.json")
    ap.add_argument("--tunnel", action="store_true",
                    help="reach the collector through `ssh -R` as http://localhost:PORT instead of "
                         "over the LAN. Needed for the Mac, which is not on the LAN at all, and it "
                         "makes the page a secure context, so crypto.subtle is there.")
    ap.add_argument("--display", default="",
                    help="Unix: run under Xvfb on this display (never :0 -- that is a screen "
                         "someone may be looking at). A high number, e.g. :91.")
    a = ap.parse_args()

    ms = machines()
    if a.machine not in ms:
        sys.exit(f"unknown machine {a.machine}; have {', '.join(sorted(ms))}")
    m = ms[a.machine]
    run = a.run or f"{a.machine}-{a.browser}-{int(time.time())}"
    win = m["os"] == "windows"
    target = m["ssh"]

    # The machine's own browsers.json says where each browser is; --binary
    # covers the machines that have none (the 32-bit Debian VM was made for
    # installer tests, not page tests, and has the distro's Firefox only).
    if a.binary:
        b = {"id": a.browser, "binary": a.binary}
    else:
        code, out, err = sh(target, "type C:\\tibrowsers\\browsers.json" if win else "cat ~/tibrowsers/browsers.json")
        if code and not out.strip():
            sys.exit(f"{a.machine}: no browsers.json ({err.strip()[:200]}); pass --binary")
        # Some manifests still say C:\ibbrowsers: they were written before
        # the ib -> ti rename (design.md 11.0) and the folder moved under
        # them. Noted, not fixed here -- fixing browsers.json is the browser
        # harness's business, not a measurement's.
        man = json.loads(out.replace("\ufeff", "").replace("ibbrowsers", "tibrowsers"))
        b = next((x for x in man["browsers"] if x["id"] == a.browser), None)
        if not b or not b.get("binary"):
            sys.exit(f"{a.machine}: no browser {a.browser}; have "
                     + ", ".join(x["id"] for x in man["browsers"]))

    addr = "localhost" if a.tunnel else my_address(target)
    url = (f"http://{addr}:{a.port}/{a.page}?run={run}"
           f"&report=http://{addr}:{a.port}/r&{a.query}")
    print(f"{a.machine}/{a.browser}: {url}", flush=True)

    lock = None
    if not a.no_lock:
        lock = VMLock(host=target, windows=win, who=f"packmem {a.machine}", wait=1800)
        try:
            lock.__enter__()
        except Busy as e:
            sys.exit(str(e))
    try:
        work = WORK_WIN if win else WORK_UNIX
        profile = (work + r"\profile") if win else (work + "/profile")
        samp = (work + r"\sample.txt") if win else (work + "/sample.txt")
        if win:
            sh(target, f'cmd /c if exist {work} rd /s /q {work}')
            sh(target, f'cmd /c mkdir {work}', check=True)
        else:
            # Firefox wants the profile folder to exist already ("Could not
            # find profile folder"); Chromium makes its own.
            sh(target, f"rm -rf ~/{work} && mkdir -p ~/{work}/profile", check=True)

        # The sampler, and how to start it.
        pname = os.path.basename(b["binary"]) if win else profile
        if win:
            ps = sh(target, 'powershell -Command "$PSVersionTable.PSVersion.Major"')[1].strip()
            has_ps = ps.isdigit() and int(ps) >= 2
            if has_ps:
                put(target, os.path.join(HERE, "sample.ps1"), work.replace("\\", "/") + "/sample.ps1")
                start_sampler = (f'powershell -ExecutionPolicy Bypass -File {work}\\sample.ps1 '
                                 f'-Name {os.path.splitext(pname)[0]} -Out {samp} -Ms 250')
            else:
                put(target, os.path.join(HERE, "sample-wmic.cmd"), work.replace("\\", "/") + "/sample-wmic.cmd")
                start_sampler = f'{work}\\sample-wmic.cmd {pname} {samp}'
        else:
            put(target, os.path.join(HERE, "sample.sh"), f"{work}/sample.sh")
            start_sampler = f"sh ~/{work}/sample.sh '{profile}' ~/{samp} 250"
        tunnel = None
        if a.tunnel:
            tunnel = subprocess.Popen(
                ["ssh", *SSH, "-o", "ExitOnForwardFailure=yes",
                 "-R", f"{a.port}:127.0.0.1:{a.port}", "-N", target],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(3)
        sampler = bg(target, start_sampler)
        time.sleep(2)

        cmd, pat = browser_cmd(m, b, url, profile if win else f"$HOME/{profile}")
        if a.headless:
            if "--user-data-dir" in cmd:
                cmd = cmd.replace("--user-data-dir", "--headless=new --user-data-dir")
            elif "-profile" in cmd or "--profile" in cmd:
                cmd = cmd.replace(' -profile', ' --headless -profile').replace(' --profile', ' --headless --profile')
        if a.display and not win:
            if a.display in (":0", "0"):
                sys.exit("not :0 -- that display may have somebody looking at it")
            sh(target, f"nohup Xvfb {a.display} -screen 0 1280x1024x24 > /dev/null 2>&1 &")
            time.sleep(2)
            cmd = f"DISPLAY={a.display} " + cmd
        print("start:", cmd[:220], flush=True)
        # On Windows the command goes in a file rather than on the command
        # line: cmd.exe treats the `&` between the URL's query parameters as
        # a command separator, quotes or no quotes, and runs the rest of the
        # URL as commands.
        if win:
            local_cmd = os.path.join(HERE, "runs", re.sub(r"[^\w.-]", "_", run) + ".cmd")
            with open(local_cmd, "w", newline="\r\n") as f:
                f.write("@echo off\r\n" + cmd + "\r\n")
            put(target, local_cmd, work.replace("\\", "/") + "/run.cmd")
            cmd = f"{work}\\run.cmd"
        browser = bg(target, cmd, log=os.path.join(HERE, "runs", re.sub(r"[^\w.-]", "_", run) + ".browser.log"))

        # Wait for the page to say it has finished.
        import urllib.request
        deadline = time.time() + a.timeout
        last = 0
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{a.port}/done?run={run}", timeout=5) as r:
                    if r.read() == b"yes":
                        print("page reported end", flush=True)
                        break
            except Exception:
                pass
            jp = os.path.join(HERE, "runs", re.sub(r"[^\w.-]", "_", run) + ".jsonl")
            n = os.path.getsize(jp) if os.path.exists(jp) else 0
            if n != last:
                last = n
                deadline = time.time() + a.timeout   # still talking: keep waiting
            if browser.poll() is not None:
                # The browser's own session ended: it exited, or the tab took
                # the process down. Which of those is the answer, so it is
                # recorded rather than retried.
                print(f"browser session ended (exit {browser.returncode})", flush=True)
                break
            time.sleep(2)
        else:
            print("timed out waiting for the page", flush=True)
        time.sleep(2)
    finally:
        # Stop everything and take the sampler's file, whatever happened.
        try:
            for pr in (locals().get("browser"), locals().get("sampler"), locals().get("tunnel")):
                if pr is not None and pr.poll() is None:
                    pr.terminate()
            if win:
                sh(target, 'taskkill /f /im powershell.exe', timeout=60)
                sh(target, 'taskkill /f /im wmic.exe', timeout=60)
                sh(target, f'taskkill /f /im {os.path.basename(b["binary"])}', timeout=120)
            else:
                sh(target, f"pkill -f '{profile}'; pkill -f '{work}/sample.sh'", timeout=60)
                if a.display:
                    sh(target, f"pkill -f 'Xvfb {a.display}'", timeout=60)
            time.sleep(1)
            local = os.path.join(HERE, "runs", re.sub(r"[^\w.-]", "_", run) + ".rss")
            src = samp.replace("\\", "/") if win else f"~/{samp}"
            subprocess.run(["scp", *SSH, "-q", f"{target}:{src}", local],
                           capture_output=True, text=True, timeout=300)
            if win:
                sh(target, f'cmd /c if exist {work} rd /s /q {work}', timeout=120)
            else:
                sh(target, f"rm -rf ~/{work}", timeout=60)
        except Exception as e:
            print("cleanup:", e, flush=True)
        if lock:
            lock.__exit__(None, None, None)

    stem = os.path.join(HERE, "runs", re.sub(r"[^\w.-]", "_", run))
    subprocess.run([sys.executable, os.path.join(HERE, "report.py"), stem])


if __name__ == "__main__":
    main()
