#!/usr/bin/env python3
"""Lines a run's events up with the sampler's readings.

    python3 tests/packmem/report.py tests/packmem/runs/NAME [--raw]

Reads NAME.jsonl (what the page said, with its own clock) and NAME.rss (what
the machine said, same clock, same machine) and prints, per sub-step, the
resident and virtual size at that moment, plus the peak and the baseline. The
interesting column is `+base`: how far above the browser's own idle footprint
the step went, which is the memory the pack actually cost.
"""
import argparse
import json
import os
import sys


def read_rss(p):
    out = []
    if not os.path.exists(p):
        return out
    for line in open(p):
        f = line.split()
        if len(f) >= 4:
            try:
                v = [int(x) for x in f[:9]]
            except ValueError:
                continue
            while len(v) < 9:
                v.append(0)
            out.append(tuple(v))
    return out


def at(samples, t, window=400):
    """The largest reading within `window` ms of t (the sampler may miss a
    spike, so the maximum near the mark is the honest one to quote)."""
    near = [s for s in samples if abs(s[0] - t) <= window]
    if not near:
        near = sorted(samples, key=lambda s: abs(s[0] - t))[:1]
    if not near:
        return None
    return max(near, key=lambda s: s[1])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("stem")
    ap.add_argument("--raw", action="store_true")
    ap.add_argument("--pss", action="store_true",
                    help="read NAME.pss (sample-linux.py: Pss and Private_*) instead of NAME.rss")
    a = ap.parse_args()
    evs = []
    jp = a.stem + ".jsonl"
    if os.path.exists(jp):
        for line in open(jp):
            line = line.strip()
            if line:
                try:
                    evs.append(json.loads(line))
                except Exception:
                    pass
    rss = read_rss(a.stem + (".pss" if a.pss else ".rss"))
    if a.pss:
        # <t> <pss> <priv> <rss> <n> <cpss> <cpriv> <cn> <cvsz> ->
        # the same shape as the shell sampler's, reading Pss where it read
        # RSS and the content processes' private memory where it read theirs.
        rss = [(s[0], s[1], s[3], s[4], s[2], s[3], s[6], s[8], s[7]) for s in rss]
    if not evs:
        sys.exit("no events in " + jp)

    # The browser's idle footprint: the lowest reading in the whole trace,
    # not the first few, which may already be the page loading.
    base_rss = min((s[1] for s in rss), default=0)
    base_max = min((s[4] for s in rss), default=0)
    base_kid = min((s[6] for s in rss), default=0)
    print(f"# {os.path.basename(a.stem)}  events={len(evs)} samples={len(rss)} baseline_rss={base_rss/1024:.0f} MB")
    begin = next((e for e in evs if e.get("what") == "begin"), None)
    if begin:
        print("# ua: " + str(begin.get("ua", ""))[:160])
        print(f"# mode={begin.get('mode')} members={begin.get('members')} base={begin.get('base')} MB"
              f" deviceMemory={begin.get('dm')} cores={begin.get('cores')}")
    print(f"{'step':>6} {'what':<22} {'all MB':>7} {'content MB':>11} {'+idle':>7} {'c.vsz MB':>9} {'jsheap':>7}")
    for e in evs:
        what = e.get("what", "")
        if what in ("begin",):
            continue
        s = at(rss, e.get("t", 0))
        r = f"{s[1]/1024:7.0f}" if s else "      -"
        d = f"{s[6]/1024:11.0f}" if s else "          -"
        v = (f"{(s[6]-base_kid)/1024:7.0f} {s[7]/1024:9.0f}") if s else "      -         -"
        heap = e.get("mem") or {}
        h = f"{heap.get('used',0)/1048576:7.0f}" if heap else "      -"
        extra = ""
        for k in ("bytes", "ok", "error", "ms", "onDisk", "written", "failedAt", "lastOk"):
            if k in e:
                extra += f" {k}={e[k]}"
        print(f"{str(e.get('step','')):>6} {what:<22} {r} {d} {v} {h}{extra}")
    if rss:
        peak = max(rss, key=lambda s: s[1])
        pk = max(rss, key=lambda s: s[6])
        pv = max(rss, key=lambda s: s[7])
        print(f"# peak all-processes rss {peak[1]/1024:.0f} MB (+{(peak[1]-base_rss)/1024:.0f} over idle);"
              f" peak content-process rss {pk[6]/1024:.0f} MB (+{(pk[6]-base_kid)/1024:.0f});"
              f" peak content vsz {pv[7]/1024:.0f} MB; procs {max(s[3] for s in rss)}")


if __name__ == "__main__":
    main()
