#!/usr/bin/env python3
"""Real-file size verification for the targeted gnu/gcc/ hits found by
probe_gnu_gcc.py (candidate_gnu_gcc.json). Same sampling/verification logic
as probe_mirror_networks.py's 'files' stage, just scoped to this one
(vendor_prefix, dirname) pair so we don't re-walk the whole catalog.
"""
import json
from pathlib import Path
import probe_mirror_networks as pmn

HERE = Path(__file__).parent
CATALOG = HERE.parent

hits = json.loads((HERE / "candidate_gnu_gcc.json").read_text())
releases = json.loads((CATALOG / "cc" / "releases.json").read_text())
vendor_prefix = "https://ftp.gnu.org/gnu/gcc/"
dirname = "gnu/gcc/"
samples = pmn.sample_entries(releases, vendor_prefix)
print(f"{len(samples)} sample gcc entries")

cache = pmn.load_cache()
results = []
for h in hits:
    host = h["host"]
    if host == "ftp.gnu.org":
        continue  # that's the vendor itself
    checks = []
    for scheme in ("https", "http"):
        for e in samples:
            suffix = e["url"][len(vendor_prefix):]
            url = f"{scheme}://{host}/{dirname}{suffix}"
            r = pmn.head(url, cache)
            match = (r["status"] == 200 and e.get("size") and r["length"] and int(r["length"]) == e["size"])
            checks.append({"scheme": scheme, "match": match, "entry": e["url"], "status": r["status"]})
        # only need one working scheme to prove the host; try https first, fall back to http
        ok = sum(1 for c in checks if c["scheme"] == scheme and c["match"])
        if ok >= 6:
            break
    matched_https = sum(1 for c in checks if c["scheme"] == "https" and c["match"])
    matched_http = sum(1 for c in checks if c["scheme"] == "http" and c["match"])
    best = max(matched_https, matched_http)
    scheme_used = "https" if matched_https >= matched_http else "http"
    results.append({
        "host": host, "runtime": "cc", "dirname": dirname, "vendor_prefix": vendor_prefix,
        "scheme": scheme_used, "checked": len(samples), "matched": best,
    })
    print(f"  {host}: https={matched_https}/{len(samples)} http={matched_http}/{len(samples)}")
    pmn.save_cache(cache)

(HERE / "candidate_gnu_gcc_files.json").write_text(json.dumps(results, indent=1))
confirmed = [r for r in results if r["matched"] >= 6]
print(f"{len(confirmed)}/{len(results)} hosts confirmed (>=6/{len(samples)} size match)")
