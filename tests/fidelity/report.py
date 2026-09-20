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
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "arch"))
import machines                                            # noqa: E402

TARGETS = [("linux", "Ubuntu 24.04"), ("ubuntu2204", "Ubuntu 22.04"),
           ("debian12x86", "Debian 12 i386 VM"), ("debian12-i386", "Debian 12 i386"), ("debian12-i386-libs", "Debian 12 i386 +libs"),
           ("alpine324-i386", "Alpine 3.24 x86"),
           ("10", "Win 10"), ("7", "Win 7"), ("mac", "macOS 26")]


def col_head(t, label):
    """The column heading, with the machine's architecture."""
    m = machines.MACHINES.get(t)
    return f"{label} · {machines.SHORT.get(m['arch'], m['arch'])}" if m else label + " · ?"


def cell(r):
    if r is None:
        return ""
    checks = r.get("checks", {})
    ok = sum(1 for s, _ in checks.values() if s == "ok")
    n = len([c for c in checks.values() if c[0] != "skip"])
    if r["result"] == "no-plan":
        return "∅"
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
    shown = [(t, l) for t, l in TARGETS if any(k[1] == t for k in latest)] or TARGETS
    print("| Project | " + " | ".join(col_head(t, l) for t, l in shown) + " |")
    print("| --- |" + " --- |" * len(shown))
    for p in projects:
        row = []
        for t, _ in shown:
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
    print("✓ every check passed · ✗ a check or the install failed · – no release for that machine's "
          "OS and architecture · ∅ the plan has no block for that machine at all (untested) · "
          "root: a system package an unattended install can't add. Each column says the "
          "architecture: 64 amd64, 32 x86, a64 arm64.")
    print()
    print("Not passing after the changes:")
    print()
    for p in projects:
        for t, label in shown:
            r = latest.get((p, t, "after"))
            if not r or r["result"] != "fail":
                continue
            bad = [f"{c}: {d}" for c, (s, d) in r.get("checks", {}).items() if s == "fail"]
            print(f"- {label}, {p}: " + ("; ".join(bad) if bad else r["detail"])[:240])


if __name__ == "__main__":
    main()
