#!/usr/bin/env python3
"""Finalize the gcc/GNU-mirror discoveries: per-entry HEAD-verify every new
host against all 13 real gcc source tarballs (cheap -- only 13 files), skip
hosts cc/mirrors.json already lists, and write catalog/package-managers/
updates_gcc.jsonl for tools/add_mirrors.py plus a summary for mirrors.json.
"""
import json
import re
from pathlib import Path
import probe_mirror_networks as pmn

HERE = Path(__file__).parent
CATALOG = HERE.parent
VENDOR_PREFIX = "https://ftp.gnu.org/gnu/gcc/"
DIRNAME = "gnu/gcc/"

existing = json.loads((CATALOG / "cc" / "mirrors.json").read_text())
existing_hosts = set()
for c in existing.get("confirmed", []):
    if c.get("runtime") == "gcc":
        m = re.match(r"https?://([^/]+)/", c.get("url_template", ""))
        if m:
            existing_hosts.add(m.group(1))

candidates = set()
for f in ["candidate_files.json"]:
    p = HERE / f
    if p.exists():
        for c in json.loads(p.read_text()):
            if c["runtime"] == "cc" and c["dirname"] == "gnu/gcc/":
                candidates.add(c["host"])
gnu_pass = json.loads((HERE / "candidate_gnu_gcc_files.json").read_text())
for r in gnu_pass:
    if r["matched"] >= 6:
        candidates.add(r["host"])

candidates -= existing_hosts
candidates.discard("ftp.gnu.org")
print(f"{len(candidates)} new gcc hosts to verify (excluding {len(existing_hosts)} already known)")

releases = json.loads((CATALOG / "cc" / "releases.json").read_text())
gcc_entries = [e for e in releases if e["url"].startswith(VENDOR_PREFIX)]

cache = pmn.load_cache()
updates = []
summary = []
for host in sorted(candidates):
    per_entry = []
    for e in gcc_entries:
        suffix = e["url"][len(VENDOR_PREFIX):]
        chosen = None
        for scheme in ("https", "http"):
            url = f"{scheme}://{host}/{DIRNAME}{suffix}"
            r = pmn.head(url, cache)
            if r["status"] == 200 and r["length"] and int(r["length"]) == e["size"]:
                chosen = (scheme, url)
                break
        per_entry.append((e, chosen))
    matched = [x for x in per_entry if x[1]]
    if len(matched) < 6:
        print(f"  SKIP {host}: only {len(matched)}/{len(gcc_entries)} matched")
        continue
    full = len(matched) == len(gcc_entries)
    schemes_used = {c[1][0] for c in matched}
    protocols = {"https": "https" in schemes_used, "http": "http" in schemes_used}
    for e, chosen in matched:
        scheme, url = chosen
        updates.append({
            "folder": "cc", "url": e["url"], "mirror": url,
            "evidence": f"host {host}, dirname gnu/gcc/, HEAD size match {len(matched)}/{len(gcc_entries)} sample "
                        f"(GNU ftp mirror-list host probed for the gcc tree), date {pmn.__dict__.get('TODAY', '2026-09-17')}",
        })
    summary.append({
        "host": host, "full_or_partial": "full" if full else "partial",
        "matched": len(matched), "total": len(gcc_entries), "protocols": protocols,
    })
    print(f"  APPLY {host}: {len(matched)}/{len(gcc_entries)} ({'full' if full else 'partial'}) protocols={protocols}")

pmn.save_cache(cache)
with open(HERE / "updates_gcc.jsonl", "w") as f:
    for u in updates:
        f.write(json.dumps(u) + "\n")
(HERE / "gcc_new_hosts_summary.json").write_text(json.dumps(summary, indent=1))
print(f"\n{len(updates)} update lines for {len(summary)} new hosts -> updates_gcc.jsonl")
