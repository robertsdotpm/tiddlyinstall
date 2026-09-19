#!/usr/bin/env python3
"""The fidelity grid for docs/test-results.md, from tests/fidelity/results/*.jsonl.

usage: report.py [--results DIR]

For each project and machine: the latest cell labelled "before" and the
latest labelled "after" (run.py --label), as "checks passed / checks" with
✓ (all passed and a clean uninstall), ✗ (a check or the install failed), –
(no release for that machine) or root (a missing system package that an
unattended install can't add). Then every check that didn't pass after,
with its message.
"""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGETS = [("linux", "Ubuntu 24.04"), ("ubuntu2204", "Ubuntu 22.04"), ("10", "Win 10"), ("7", "Win 7"), ("mac", "macOS 26")]


def cell(r):
    if r is None:
        return ""
    checks = r.get("checks", {})
    ok = sum(1 for s, _ in checks.values() if s == "ok")
    n = len([c for c in checks.values() if c[0] != "skip"])
    if r["result"] == "n/a":
        return "root" if r["detail"].startswith("needs root") else "–"
    if r["result"] == "pass":
        return f"✓ {ok}/{n}"
    if not checks:
        return "✗ install" if r["detail"].startswith(("install", "build")) else "✗"
    return f"✗ {ok}/{n}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(HERE / "results"))
    a = ap.parse_args()
    latest = {}
    for f in sorted(Path(a.results).glob("*.jsonl")):
        for line in f.read_text().splitlines():
            r = json.loads(line)
            latest[(r["project"], r["target"], r.get("label") or "after")] = r
    projects = []
    for (p, _, _) in latest:
        if p not in projects:
            projects.append(p)
    order = json.loads((HERE / "projects.json").read_text())["projects"]
    projects.sort(key=lambda p: list(order).index(p) if p in order else 99)
    print("| Project | " + " | ".join(label for _, label in TARGETS) + " |")
    print("| --- |" + " --- |" * len(TARGETS))
    for p in projects:
        row = []
        for t, _ in TARGETS:
            b, af = latest.get((p, t, "before")), latest.get((p, t, "after"))
            if b is None and af is None:
                row.append("")
            elif b is None:
                row.append(cell(af))
            elif af is None:
                row.append(cell(b) + " → ?")
            else:
                cb, ca = cell(b), cell(af)
                row.append(ca if cb == ca else f"{cb} → {ca}")
        print(f"| {p} | " + " | ".join(row) + " |")
    print()
    print("Not passing after the changes:")
    print()
    for p in projects:
        for t, label in TARGETS:
            r = latest.get((p, t, "after"))
            if not r or r["result"] == "pass":
                continue
            bad = [f"{c}: {d}" for c, (s, d) in r.get("checks", {}).items() if s == "fail"]
            print(f"- {label}, {p}: " + ("; ".join(bad) if bad else r["detail"])[:400])


if __name__ == "__main__":
    main()
