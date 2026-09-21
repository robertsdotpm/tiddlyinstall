#!/usr/bin/env python3
"""One line per run: the largest pack that worked, and how the next one failed.

    python3 tests/packmem/summary.py [runs...]

A step that reported `done` worked. A step that reported `failed` threw, and
the error is what it threw. A step whose events stop in the middle is the
other failure: the tab died and the page never got to say so -- which is the
one to worry about, because nothing in the browser reports it either.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
files = sys.argv[1:] or sorted(glob.glob(os.path.join(HERE, "runs", "*.jsonl")))
print(f"{'run':<22} {'largest ok':>10} {'failed at':>9}  how it failed / last step reached")
for f in files:
    evs = []
    for line in open(f):
        line = line.strip()
        if line:
            try:
                evs.append(json.loads(line))
            except Exception:
                pass
    if not evs:
        continue
    ok, fail, how, last = 0, 0, "", ""
    peak = 0
    for e in evs:
        m = (e.get("mem") or {}).get("used", 0)
        peak = max(peak, m)
        if e.get("what") == "done" and e.get("ok"):
            ok = max(ok, float(e.get("step") or 0))
        if e.get("what") == "failed":
            fail = float(e.get("step") or 0)
            how = f"threw {e.get('name','')}: {e.get('error','')}"
        if e.get("step"):
            last = f"{e['step']} / {e.get('what')}"
    if not fail and evs[-1].get("what") != "end":
        how = f"stopped reporting at {last} (tab gone, no error)"
        try:
            fail = float(last.split(" /")[0])
        except ValueError:
            pass
    name = os.path.basename(f)[:-6]
    print(f"{name:<22} {ok:>8.0f}MB {fail:>7.0f}MB  {how}"
          + (f"   [peak JS heap {peak/1048576:.0f} MB]" if peak else ""))
