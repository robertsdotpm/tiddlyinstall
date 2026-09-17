#!/usr/bin/env python3
"""Build download_plan_majors.json for each runtime: one version per true major.

A "true major" is the part of the catalog's `major` before the first dot:
python 3.14 -> 3, node 0.12 -> 0, go/rust 1.27 -> 1, php 8.5 -> 8, r 4.6 -> 4,
dotnet 3.1 -> 3, llvm 3.9 -> 3 (llvm 18 -> 18), java 21 -> 21.

For each (runtime, true major, os, arch) the highest version present in the
runtime's full download plan is chosen, with every variant published for that
exact version (e.g. Python's installer and embeddable zip). So if the newest
minor dropped a platform, that platform keeps the newest minor that had it.

The full catalog (releases.json, limitations.json) is unaffected.
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
FULL_PLAN = {"python": "download_plan.json", "node": "download_plan.json", "java": "download_plan.json",
             "dotnet": "download_plan.json", "go": "download_plan.json", "rust": "download_plan.json",
             "php": "download_plan.json", "r": "download_plan.json", "ruby": "download_plan.json",
             "nim": "download_plan.json", "zig": "download_plan.json",
             "cc": "download_plan.json"}


def vkey(v):
    return [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in re.split(r"[.\-+_]", str(v))]


# Pre-1.0 languages break compatibility on every 0.x minor release, so each
# 0.x line counts as its own major for them.
PRE1_MINOR_IS_MAJOR = {"zig"}


def true_major(e):
    major = str(e["major"])
    if e["runtime"] in PRE1_MINOR_IS_MAJOR and major.startswith("0."):
        return major
    return major.split(".")[0]


def main():
    total = 0
    only = set(sys.argv[1:])  # optional: limit to these runtime folders
    for folder, name in FULL_PLAN.items():
        if only and folder not in only:
            continue
        if not (CATALOG / folder / name).exists():
            print(f"{folder:7} skipped: no {name} yet")
            continue
        plan = json.loads((CATALOG / folder / name).read_text())
        groups = defaultdict(list)
        for e in plan:
            groups[(e["runtime"], true_major(e), e["os"], e["arch"])].append(e)
        # Source tarballs are only worth keeping where no prebuilt binary exists
        # for that runtime, true major and OS.
        has_binary = {(r, m, o) for (r, m, o, a), es in groups.items() if any(e["kind"] != "source" for e in es)}
        groups = {k: v for k, v in groups.items()
                  if not (all(e["kind"] == "source" for e in v) and (k[0], k[1], k[2]) in has_binary)}
        chosen = []
        for key, es in groups.items():
            best = max((e["version"] for e in es), key=vkey)
            chosen += [e for e in es if e["version"] == best]
        chosen.sort(key=lambda e: (e["runtime"], vkey(e["version"]), e["os"], e["arch"], e.get("variant") or ""))
        (CATALOG / folder / "download_plan_majors.json").write_text(json.dumps(chosen, indent=1))
        gb = sum(e.get("size") or 0 for e in chosen) / 1e9
        total += gb
        versions = sorted({f"{e['runtime']} {e['version']}" for e in chosen}, key=lambda s: (s.split()[0], vkey(s.split()[1])))
        print(f"{folder:7} {len(plan):5} -> {len(chosen):4} files  {gb:6.1f} GB   versions: {', '.join(versions)[:230]}")
    print(f"total {total:.1f} GB")


if __name__ == "__main__":
    main()
