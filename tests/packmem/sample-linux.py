#!/usr/bin/env python3
"""A finer sampler for this machine and the Linux VMs.

    python3 sample-linux.py PATTERN OUT_FILE [INTERVAL_MS]

sample.sh sums `ps` RSS across a browser's processes, which counts pages
shared between them once per process and so reads high. Where /proc has
`smaps_rollup` (Linux 4.14+), this reads Pss and Private_Dirty instead:
Pss shares each page out between the processes mapping it, and
Private_Dirty is the anonymous memory a process alone is holding -- which
is exactly what a pack costs.

Columns: <epoch_ms> <pss_kb> <private_kb> <rss_kb> <procs> <content_pss_kb>
<content_private_kb> <content_procs> <content_vsz_kb>
"""
import os
import sys
import time

PAT = sys.argv[1]
OUT = sys.argv[2]
MS = int(sys.argv[3]) if len(sys.argv) > 3 else 150
CHILD = ("--type=renderer", "-contentproc", "Web Content")


def procs():
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().decode("utf-8", "replace").replace("\0", " ")
        except OSError:
            continue
        if PAT in cmd:
            yield pid, cmd


def rollup(pid):
    pss = priv = rss = 0
    try:
        with open(f"/proc/{pid}/smaps_rollup") as f:
            for line in f:
                k, _, v = line.partition(":")
                v = v.strip().split(" ")[0]
                if k == "Pss":
                    pss = int(v)
                elif k in ("Private_Dirty", "Private_Clean"):
                    priv += int(v)
                elif k == "Rss":
                    rss = int(v)
    except (OSError, ValueError):
        return None
    return pss, priv, rss


def vsz(pid):
    try:
        with open(f"/proc/{pid}/statm") as f:
            return int(f.read().split()[0]) * (os.sysconf("SC_PAGE_SIZE") // 1024)
    except (OSError, ValueError, IndexError):
        return 0


def main():
    with open(OUT, "w") as out:
        while True:
            t = int(time.time() * 1000)
            tot = [0, 0, 0, 0]
            kid = [0, 0, 0, 0]
            for pid, cmd in procs():
                r = rollup(pid)
                if not r:
                    continue
                tot[0] += r[0]; tot[1] += r[1]; tot[2] += r[2]; tot[3] += 1
                if any(c in cmd for c in CHILD):
                    kid[0] += r[0]; kid[1] += r[1]; kid[3] += 1
                    kid[2] += vsz(pid)
            out.write(f"{t} {tot[0]} {tot[1]} {tot[2]} {tot[3]} {kid[0]} {kid[1]} {kid[3]} {kid[2]}\n")
            out.flush()
            time.sleep(MS / 1000.0)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
