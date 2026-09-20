#!/usr/bin/env python3
"""Java mirror coverage, per file and per OS, including plain-http reach."""
import json, collections
from pathlib import Path
CATALOG = Path(__file__).resolve().parents[3]
for f in ["releases.json", "download_plan.json", "download_plan_majors.json"]:
    r = json.loads((CATALOG / "java" / f).read_text())
    n = len(r)
    m = sum(1 for e in r if e.get("mirrors"))
    h = sum(1 for e in r if any(u.startswith("http://") for u in [e["url"]] + e.get("mirrors", [])))
    print(f"{f}: {n} entries | >=1 mirror {m} ({100*m/n:.1f}%) | any plain-http URL {h} ({100*h/n:.1f}%)")
    if f == "releases.json":
        c = collections.Counter(e["os"] for e in r)
        mm = collections.Counter(e["os"] for e in r if e.get("mirrors"))
        hh = collections.Counter(e["os"] for e in r if any(u.startswith("http://") for u in [e["url"]] + e.get("mirrors", [])))
        for k in sorted(c):
            print(f"   {k:8} {c[k]:5} | mirrored {mm[k]:5} ({100*mm[k]/c[k]:.1f}%) | http {hh[k]:5} ({100*hh[k]/c[k]:.1f}%)")
        hosts = collections.Counter()
        for e in r:
            for u in e.get("mirrors", []):
                hosts[f"{u.split(':')[0]}://{u.split('/')[2]}"] += 1
        for k, v in hosts.most_common():
            print(f"   {v:6}  {k}")
        print("   unmirrored:", sum(1 for e in r if not e.get("mirrors")))
