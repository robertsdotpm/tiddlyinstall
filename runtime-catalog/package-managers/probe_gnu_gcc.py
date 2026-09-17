#!/usr/bin/env python3
"""Targeted follow-up: every host that appeared on the GNU ftp mirror list
(catalog/package-managers/mirror_hosts.json, source=='gnu') almost
certainly rsyncs the full GNU tree, gcc included -- so check gnu/gcc/ (and
the bogus control) on all 77 of them directly, instead of the generic
23-directory sweep. Reuses probe_mirror_networks.head() and its cache.
"""
import json
from pathlib import Path
import probe_mirror_networks as pmn

HERE = Path(__file__).parent

hosts = json.loads((HERE / "mirror_hosts.json").read_text())
gnu_hosts = [h["host"] for h in hosts if "gnu" in h["sources"]]
cache = pmn.load_cache()

hits = []
for host in gnu_hosts:
    for scheme in ("https", "http"):
        root = f"{scheme}://{host}/"
        bogus = pmn.head(root + pmn.BOGUS_PATH, cache)
        if bogus["status"] == 200:
            continue  # soft-200, skip
        r = pmn.head(root + "gnu/gcc/", cache)
        if r["status"] == 200:
            hits.append({"host": host, "scheme": scheme})
            print(f"  HIT {scheme}://{host}/gnu/gcc/")
            break

pmn.save_cache(cache)
(HERE / "candidate_gnu_gcc.json").write_text(json.dumps(hits, indent=1))
print(f"{len(hits)}/{len(gnu_hosts)} GNU-list hosts serve gnu/gcc/")
