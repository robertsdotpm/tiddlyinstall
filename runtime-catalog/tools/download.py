#!/usr/bin/env python3
"""Download planned runtime files into the runtimes store and verify them.

usage: download.py [--plan-name download_plan.json] [--jobs 4] [--min-free-gb 25] <runtime> [<runtime> ...]

For each entry in catalog/<runtime>/<plan-name>:
  - target path: <root>/<runtime>/<os>/<arch>/<version>[-<variant>]/<file>
  - skipped if the file exists and matches the vendor checksum (or size, if no checksum)
  - tries the primary URL, then each mirror, until one downloads and verifies
  - stops starting new downloads when free disk space would drop below --min-free-gb

Results are appended to catalog/download-log.jsonl; failures are collected in
catalog/download-gaps.json (rewritten on every run, per runtime).
"""
import argparse
import concurrent.futures as cf
import gzip
import hashlib
import json
import os
import shutil
import sys
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "catalog"
LOG = CATALOG / "download-log.jsonl"
GAPS = CATALOG / "download-gaps.json"
lock = threading.Lock()
reserved = {"bytes": 0}


def target_path(e):
    name = os.path.basename(urllib.parse.urlparse(e["url"]).path) or "download"
    version_dir = e["version"] + (f"-{e['variant']}" if e.get("variant") else "")
    return ROOT / e["runtime"] / e["os"] / e["arch"] / version_dir / name


def verify(path, e):
    c = e.get("checksum")
    if c:
        h = hashlib.new(c["algo"])
        # Some vendors (e.g. python.org's API for old .tgz files) published the
        # checksum of the decompressed archive rather than the file served.
        opener = gzip.open if c.get("applies_to") == "decompressed" else open
        with opener(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        how = f"{c['algo']} vendor" + (" (of decompressed contents)" if c.get("applies_to") == "decompressed" else "")
        return h.hexdigest().lower() == c["value"].lower(), how
    if e.get("size"):
        return path.stat().st_size == e["size"], "size only (no vendor checksum)"
    return path.stat().st_size > 0, "unverified (no checksum or size)"


def fetch(url, dest):
    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "installer-builder-runtime-fetch/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as out:
        shutil.copyfileobj(r, out, 1 << 20)
    tmp.replace(dest)


def free_bytes():
    return shutil.disk_usage(ROOT).free


def handle(e, min_free):
    dest = target_path(e)
    dest.parent.mkdir(parents=True, exist_ok=True)
    rec = {"runtime": e["runtime"], "major": e["major"], "version": e["version"], "os": e["os"],
           "arch": e["arch"], "variant": e.get("variant"), "path": str(dest.relative_to(ROOT)),
           "size": e.get("size")}
    if dest.exists():
        ok, how = verify(dest, e)
        if ok:
            return {**rec, "status": "present", "verified": how}
        dest.unlink()
    need = e.get("size") or 0
    with lock:
        if free_bytes() - reserved["bytes"] - need < min_free:
            return {**rec, "status": "skipped", "reason": "disk space guard"}
        reserved["bytes"] += need
    errors = []
    try:
        for url in [e["url"]] + list(e.get("mirrors") or []):
            for attempt in range(2):
                try:
                    fetch(url, dest)
                    ok, how = verify(dest, e)
                    if ok:
                        return {**rec, "status": "downloaded", "from": url, "verified": how}
                    errors.append(f"{url}: verification failed ({how})")
                    dest.unlink(missing_ok=True)
                    break
                except Exception as ex:  # network errors, HTTP errors, timeouts
                    errors.append(f"{url}: {type(ex).__name__}: {ex}")
                    time.sleep(2)
        return {**rec, "status": "failed", "errors": errors[-6:], "urls_tried": [e["url"]] + list(e.get("mirrors") or [])}
    finally:
        with lock:
            reserved["bytes"] -= need
        for p in dest.parent.glob("*.part"):
            p.unlink(missing_ok=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runtimes", nargs="+")
    ap.add_argument("--plan-name", default="download_plan.json")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--min-free-gb", type=float, default=25)
    a = ap.parse_args()
    min_free = int(a.min_free_gb * 1e9)

    gaps = json.loads(GAPS.read_text()) if GAPS.exists() else {}
    for runtime in a.runtimes:
        plan = json.loads((CATALOG / runtime / a.plan_name).read_text())
        print(f"{runtime}: {len(plan)} planned, {sum((p.get('size') or 0) for p in plan) / 1e9:.1f} GB", flush=True)
        results = []
        with cf.ThreadPoolExecutor(a.jobs) as ex:
            for r in ex.map(lambda e: handle(e, min_free), plan):
                results.append(r)
                with open(LOG, "a") as f:
                    f.write(json.dumps({**r, "at": time.strftime("%Y-%m-%dT%H:%M:%S")}) + "\n")
        counts = {}
        for r in results:
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        print(f"  {counts}", flush=True)
        gaps[runtime] = [r for r in results if r["status"] in ("failed", "skipped")]
        GAPS.write_text(json.dumps(gaps, indent=1))
    print(f"free: {free_bytes() / 1e9:.1f} GB")


if __name__ == "__main__":
    sys.exit(main())
