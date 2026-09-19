#!/usr/bin/env python3
"""The templates' results grid (runtime x template x machine), from
results.jsonl (run.py): the latest result for each cell.

usage: report.py [--results FILE ...] [--write]

--write replaces the part of docs/test-results.md between the
<!-- templates:start --> and <!-- templates:end --> markers (or adds it at
the end); without it, the grid is printed.
"""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOC = HERE.parents[1] / "docs" / "test-results.md"
START, END = "<!-- templates:start -->", "<!-- templates:end -->"
# Two grids, Linux and the rest, each newest first.
GROUPS = [
    [("linux", "Ubuntu 24.04 (here)"), ("ubuntu2204", "Ubuntu 22.04"), ("debian12", "Debian 12"),
     ("ubuntu2004", "Ubuntu 20.04"), ("rocky8", "Rocky 8"), ("ubuntu1804", "Ubuntu 18.04"),
     ("ubuntu1604", "Ubuntu 16.04"), ("ubuntu1404", "Ubuntu 14.04"), ("centos7", "CentOS 7"),
     ("centos6", "CentOS 6"), ("alpine", "Alpine 3.24")],
    [("11", "Win 11"), ("11de", "Win 11 (de)"), ("2025core", "Server 2025 Core"), ("2022", "Server 2022"),
     ("10", "Win 10"), ("ltsc2021", "Win 10 LTSC 2021"), ("10x86", "Win 10 x86"), ("8.1", "Win 8.1"),
     ("7", "Win 7"), ("vista", "Vista"), ("xp", "XP"), ("mac", "macOS 26")],
]
COLUMNS = [c for g in GROUPS for c in g]
MARK = {"pass": "✓", "fail": "✗", "n/a": "–"}


def cell(r):
    if r is None:
        return " "
    if r["result"] == "n/a" and "no display" in r.get("detail", ""):
        return "GUI"
    if r["result"] == "n/a" and "nobody logged on" in r.get("detail", ""):
        return "ssh"
    if r["result"] == "n/a" and "isn't for" in r.get("detail", ""):
        return "·"
    return MARK[r["result"]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", nargs="*", default=[str(HERE / "results.jsonl")])
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args()
    latest, order = {}, []
    for f in a.results:
        for line in Path(f).read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            latest[(r["template"], r["target"])] = r
            if r["template"] not in order:
                order.append(r["template"])
    out = []
    for group in GROUPS:
        cols = [c for c in group if any(t == c[0] for _, t in latest)]
        if not cols:
            continue
        if out:
            out.append("")
        out += ["| Template | " + " | ".join(label for _, label in cols) + " |",
                "| --- |" + " --- |" * len(cols)]
        for t in order:
            out.append(f"| {t} | " + " | ".join(cell(latest.get((t, c))) for c, _ in cols) + " |")
    counts = {}
    for r in latest.values():
        counts[r["result"]] = counts.get(r["result"], 0) + 1
    out.append("")
    out.append(f"**{len(latest)} cells: {counts.get('pass', 0)} pass, {counts.get('fail', 0)} fail, {counts.get('n/a', 0)} n/a.**")
    fails = [r for r in latest.values() if r["result"] == "fail"]
    if fails:
        out += ["", "| Machine | Template | Detail |", "| --- | --- | --- |"]
        for r in sorted(fails, key=lambda r: (r["template"], r["target"])):
            detail = r.get("detail", "").replace("|", "\\|").replace("\n", " ")[:300]
            out.append(f"| {dict(COLUMNS).get(r['target'], r['target'])} | {r['template']} | {detail} |")
    grid = "\n".join(out)
    if not a.write:
        print(grid)
        return
    doc = DOC.read_text()
    if START in doc and END in doc:
        head, rest = doc.split(START, 1)
        tail = rest.split(END, 1)[1]
        doc = head + START + "\n" + grid + "\n" + END + tail
    else:
        doc = doc.rstrip("\n") + "\n\n" + START + "\n" + grid + "\n" + END + "\n"
    DOC.write_text(doc)
    print(f"wrote {DOC}")


if __name__ == "__main__":
    main()
