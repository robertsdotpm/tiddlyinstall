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
COLUMNS = [("linux", "Ubuntu 24.04 (here)"), ("ubuntu2204", "Ubuntu 22.04"), ("debian12", "Debian 12"),
           ("rocky8", "Rocky 8"), ("centos7", "CentOS 7"), ("10", "Win 10"), ("7", "Win 7"),
           ("11de", "Win 11 (de)"), ("mac", "macOS 26")]
MARK = {"pass": "✓", "fail": "✗", "n/a": "–"}


def cell(r):
    if r is None:
        return " "
    if r["result"] == "n/a" and "no display" in r.get("detail", ""):
        return "GUI"
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
    cols = [c for c in COLUMNS if any(t == c[0] for _, t in latest)]
    out = ["| Template | " + " | ".join(label for _, label in cols) + " |",
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
