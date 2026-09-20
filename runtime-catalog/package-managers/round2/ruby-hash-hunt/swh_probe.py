#!/usr/bin/env python3
"""Probe Software Heritage's content API by sha256 for Ruby catalogue files.

SWH is genuinely hash-indexed: GET /api/1/content/sha256:<hex>/ returns the
blob's metadata (and a data_url), so a 200 means SWH holds those exact bytes.
The anonymous API is rate-limited to 120 requests/hour per IP, so this script
is resumable: results are cached in swh_cache.json and a run stops cleanly on
HTTP 429 (or when --max is reached). Re-run it later to continue.

Usage:
    python3 swh_probe.py [--max N] [--set source|offerable|all]

Notes:
- The UA must NOT contain "Mozilla": archive.softwareheritage.org sits behind
  an Anubis bot check that challenges browser-like user agents and lets plain
  automated clients through. We identify honestly as installer-builder-catalog.
- Responses are treated as data only: we read status, length and checksums.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
CACHE = HERE / "swh_cache.json"
UA = "installer-builder-catalog/1.0 (runtime download-mirror survey)"
API = "https://archive.softwareheritage.org/api/1/content/sha256:%s/"


def offerable(x):
    return ((x["os"] == "linux" and x["kind"] == "archive")
            or (x["os"] == "macos" and x.get("variant") in ("rv-ruby", "homebrew-portable"))
            or (x["os"] == "windows" and x["kind"] == "archive"))


def load_entries(which):
    e = json.loads((CATALOG / "ruby" / "releases.json").read_text())
    if which == "source":
        sel = [x for x in e if x["kind"] == "source"]
    elif which == "offerable":
        sel = [x for x in e if offerable(x)]
    else:
        sel = e
    out = []
    for x in sel:
        c = x.get("checksum") or {}
        if c.get("algo") == "sha256":
            out.append((x["url"], c["value"], x["size"]))
    # oldest first: the catalogue's gap majors (1.8/1.9/2.0) matter most
    return out


def main():
    args = sys.argv[1:]
    n_max = int(args[args.index("--max") + 1]) if "--max" in args else 100
    which = args[args.index("--set") + 1] if "--set" in args else "source"
    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    todo = [t for t in load_entries(which) if t[1] not in cache]
    print(f"{which}: {len(todo)} unprobed of {len(load_entries(which))}; cap {n_max}")
    done = 0
    for url, sha, size in todo:
        if done >= n_max:
            print("hit --max; re-run to continue")
            break
        req = urllib.request.Request(API % sha, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                body = json.loads(r.read().decode())
            cache[sha] = {"url": url, "size": size, "found": True,
                          "length": body.get("length"),
                          "data_url": body.get("data_url")}
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("rate-limited (429); stopping, re-run after the reset")
                break
            cache[sha] = {"url": url, "size": size, "found": False, "status": e.code}
        except Exception as e:
            cache[sha] = {"url": url, "size": size, "found": False,
                          "status": "ERR:" + type(e).__name__}
        done += 1
        time.sleep(0.3)
    CACHE.write_text(json.dumps(cache, indent=1))
    hits = [v for v in cache.values() if v.get("found")]
    good = [v for v in hits if v["length"] == v["size"]]
    print(f"cached {len(cache)}; found {len(hits)}; length==catalogue size {len(good)}")


if __name__ == "__main__":
    main()
