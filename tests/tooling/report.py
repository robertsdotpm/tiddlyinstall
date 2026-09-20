#!/usr/bin/env python3
"""The package-manager grid for docs/test-results.md, from tests/tooling/results/*.jsonl.

usage: report.py [--results DIR] [--targets linux,alpine,...] [--full]

One row per (runtime, major) and one column per machine, showing
"✓ ok/checks" when every check passed and the uninstall was clean,
"✗ ok/checks" when one didn't, "–" when the catalogue has nothing for
that machine, "root" when an unattended install would need a system
package, "refused" when the catalogue knows the combination cannot work
and the installer stops up front with the reason, and "✗ install" when
the install itself failed. Then the
failures, with the check's own message, and a per-check summary so a tool
that is broken on every old version shows up as one line.
"""
import argparse
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
LABELS = {
    "linux": "here", "centos6": "CentOS 6", "centos7": "CentOS 7", "ubuntu1404": "Ub 14.04",
    "ubuntu1604": "Ub 16.04", "ubuntu1804": "Ub 18.04", "rocky8": "Rocky 8", "ubuntu2004": "Ub 20.04",
    "ubuntu2204": "Ub 22.04", "debian12": "Debian 12", "alpine": "Alpine",
    "xp": "XP", "vista": "Vista", "7": "Win 7", "8.1": "Win 8.1", "10": "Win 10", "11": "Win 11",
    "10x86": "Win 10 x86", "ltsc2021": "LTSC 2021", "2022": "Srv 2022", "2025core": "Srv 2025",
    "11de": "Win 11 de", "mac": "macOS",
}


def cell(r):
    if r is None:
        return ""
    checks = r.get("checks", {})
    ok = sum(1 for s, _ in checks.values() if s == "ok")
    n = len([c for c in checks.values() if c[0] != "skip"])
    if r["result"] == "n/a":
        # "refused" is the installer stopping up front and saying why: a
        # combination the catalogue knows cannot work (docs/format.md,
        # "Combinations that cannot work"). It is not "the catalogue has
        # nothing here", and it is not a broken install.
        if r["detail"].startswith("refused"):
            return "refused"
        return "root" if r["detail"].startswith("needs root") else "–"
    if r["result"] == "pass":
        return f"✓ {ok}/{n}"
    if not checks:
        return "✗ install" if r["detail"].startswith(("install", "build")) else "✗"
    return f"✗ {ok}/{n}"


def vkey(m):
    out = []
    for part in str(m).replace("-", ".").split("."):
        out.append(int(part) if part.isdigit() else 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", default=str(HERE / "results"))
    ap.add_argument("--targets", default="")
    ap.add_argument("--full", action="store_true", help="also print every skipped check")
    a = ap.parse_args()
    latest, targets, cells = {}, [], []
    # The newest run of each cell wins, by the run's own `time` and not by
    # the file's name: "2026-09-20-refusals.jsonl" sorts *before*
    # "2026-09-20.jsonl", so a later run in a suffixed file was being
    # thrown away by the file order alone.
    for f in sorted(Path(a.results).glob("*.jsonl")):
        for line in f.read_text().splitlines():
            r = json.loads(line)
            was = latest.get((r["cell"], r["target"]))
            if was is not None and str(was.get("time", "")) > str(r.get("time", "")):
                continue
            latest[(r["cell"], r["target"])] = r
            if r["target"] not in targets:
                targets.append(r["target"])
            if r["cell"] not in cells:
                cells.append(r["cell"])
    if a.targets:
        targets = [t for t in a.targets.split(",") if t]
    order = list(json.loads((HERE / "projects.json").read_text())["projects"])
    cells.sort(key=lambda c: (order.index(c.split("@")[0]) if c.split("@")[0] in order else 99,
                              vkey(c.split("@")[1])))

    print("| Runtime and version | " + " | ".join(LABELS.get(t, t) for t in targets) + " |")
    print("| --- |" + " --- |" * len(targets))
    for c in cells:
        p, _, m = c.partition("@")
        row = [cell(latest.get((c, t))) for t in targets]
        print(f"| {p} {m} | " + " | ".join(row) + " |")

    print()
    print("Checks that did not pass:")
    print()
    any_bad = False
    for c in cells:
        for t in targets:
            r = latest.get((c, t))
            if not r or r["result"] != "fail":
                continue
            any_bad = True
            bad = [f"{k}: {d}" for k, (s, d) in r.get("checks", {}).items() if s == "fail"]
            print(f"- {LABELS.get(t, t)}, {c}: " + ("; ".join(bad) if bad else r["detail"])[:260])
    if not any_bad:
        print("- none")

    print()
    print("Per check, where it did not pass (every machine):")
    print()
    per = {}
    for (c, t), r in latest.items():
        for k, (s, _) in r.get("checks", {}).items():
            per.setdefault(k, {"ok": 0, "fail": [], "skip": []})
            if s == "ok":
                per[k]["ok"] += 1
            else:
                per[k][s].append(f"{c} on {LABELS.get(t, t)}")
    for k in sorted(per):
        d = per[k]
        line = f"- `{k}`: {d['ok']} passed"
        if d["fail"]:
            line += f", {len(d['fail'])} failed ({', '.join(d['fail'][:6])}{', …' if len(d['fail']) > 6 else ''})"
        if d["skip"] and a.full:
            line += f", {len(d['skip'])} not applicable ({', '.join(d['skip'][:6])}{', …' if len(d['skip']) > 6 else ''})"
        elif d["skip"]:
            line += f", {len(d['skip'])} not applicable"
        print(line)


if __name__ == "__main__":
    main()
