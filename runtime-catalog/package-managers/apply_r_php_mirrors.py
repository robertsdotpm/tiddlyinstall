#!/usr/bin/env python3
"""Consolidate the R (CRAN) and PHP mirror discoveries from candidate_files.json
into per-entry-verified update lines, excluding hosts each runtime's
mirrors.json already lists. Mirrors r/ is in catalog/.busy, so this script
does NOT write anywhere under catalog/r/ -- only produces updates_r.jsonl
for tools/add_mirrors.py (which itself queues busy-folder writes safely)
and a summary for the operator to fold into r/mirrors.json once unlocked.
"""
import json
import re
from pathlib import Path
import probe_mirror_networks as pmn

HERE = Path(__file__).parent
CATALOG = HERE.parent

def existing_hosts(runtime):
    p = CATALOG / runtime / "mirrors.json"
    data = json.loads(p.read_text())
    confirmed = data.get("confirmed", []) if isinstance(data, dict) else data
    hosts = set()
    for c in confirmed:
        tmpl = c.get("url_template") or c.get("template") or ""
        if tmpl.startswith("http"):
            m = re.match(r"https?://([^/]+)/", tmpl)
            if m:
                hosts.add(m.group(1))
        elif c.get("host"):
            hosts.add(c["host"])
    return hosts


def run(runtime, vendor_prefix, dirname_filter=None):
    combos = json.loads((HERE / "candidate_files.json").read_text())
    combos = [c for c in combos if c["runtime"] == runtime]
    existing = existing_hosts(runtime)
    releases = json.loads((CATALOG / runtime / "releases.json").read_text())
    matching_all = [e for e in releases if e["url"].startswith(vendor_prefix)]
    cache = pmn.load_cache()
    updates = []
    summary = []
    for combo in combos:
        host = combo["host"]
        dirname = combo["dirname"]
        if host in existing:
            print(f"  skip {host} (already in {runtime}/mirrors.json)")
            continue
        per_entry = []
        for e in matching_all:
            suffix = e["url"][len(vendor_prefix):]
            chosen = None
            for scheme in ("https", "http"):
                url = f"{scheme}://{host}/{dirname}{suffix}"
                r = pmn.head(url, cache)
                if r["status"] == 200 and r["length"] and e.get("size") and int(r["length"]) == e["size"]:
                    chosen = (scheme, url)
                    break
            per_entry.append((e, chosen))
        matched = [x for x in per_entry if x[1]]
        if len(matched) < 6:
            print(f"  SKIP {host}/{dirname}: only {len(matched)}/{len(matching_all)} matched")
            continue
        full = len(matched) == len(matching_all)
        schemes_used = {c[1][0] for c in matched}
        for e, chosen in matched:
            scheme, url = chosen
            updates.append({
                "folder": runtime, "url": e["url"], "mirror": url,
                "evidence": f"host {host}, dirname {dirname}, HEAD size match {len(matched)}/{len(matching_all)} sample, date 2026-09-17",
            })
        summary.append({
            "host": host, "dirname": dirname, "full_or_partial": "full" if full else "partial",
            "matched": len(matched), "total": len(matching_all),
            "protocols": {"https": "https" in schemes_used, "http": "http" in schemes_used},
        })
        print(f"  APPLY {host}/{dirname}: {len(matched)}/{len(matching_all)} ({'full' if full else 'partial'})")
        pmn.save_cache(cache)
    return updates, summary


if __name__ == "__main__":
    all_updates = []
    r_updates, r_summary = run("r", "https://cran.r-project.org/")
    php_updates, php_summary = run("php", "https://www.php.net/distributions/")
    all_updates += r_updates + php_updates
    with open(HERE / "updates_r_php.jsonl", "w") as f:
        for u in all_updates:
            f.write(json.dumps(u) + "\n")
    (HERE / "r_new_hosts_summary.json").write_text(json.dumps(r_summary, indent=1))
    (HERE / "php_new_hosts_summary.json").write_text(json.dumps(php_summary, indent=1))
    print(f"\n{len(all_updates)} total update lines -> updates_r_php.jsonl")
    print(f"r: {len(r_summary)} new hosts, php: {len(php_summary)} new hosts")
