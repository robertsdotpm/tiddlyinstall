#!/usr/bin/env python3
"""Download planned runtime files into the runtimes store and verify them.

usage: download.py [--plan-name download_plan.json] [--jobs 4] [--min-free-gb 25] <runtime> [<runtime> ...]
       download.py --plan PLAN.json [--root DIR] [--jobs 4] [--min-free-gb 25]

With --plan, the plan is read from that path instead of from
catalog/<runtime>/<plan-name>, and it may hold entries for several
runtimes at once (each entry names its own). That is what
tools/mirror_scope.mjs writes: "every version we offer" is not one
runtime's newest patch but a set computed across the catalogue, and
copying it into each folder first only makes it easier to fetch a
half of it. --root says where the store is, for running this script
from the git backup rather than from the working copy beside it.

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


def set_root(p):
    """--root: the store to download into, and the catalog beside it."""
    global ROOT, CATALOG, LOG, GAPS
    ROOT = Path(p).expanduser().resolve()
    CATALOG = ROOT / "catalog"
    LOG = CATALOG / "download-log.jsonl"
    GAPS = CATALOG / "download-gaps.json"


def target_path(e):
    # An entry may name the path itself. tools/mirror_scope.mjs does that
    # for a file we already have, because the store's layout is not always
    # this one -- ruby's newest Windows builds live under
    # ruby/windows/fetched/ -- and writing a second copy at the path below
    # does more than waste the bytes: LocalIndex walks lexically, so the
    # new copy shadows the old one and every plan's mirror URL moves.
    if e.get("path"):
        return ROOT / e["path"]
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
    # No vendor checksum. Before falling back to a length, use a hash
    # somebody else published for the same file.
    #
    # add_mirrors.py has been collecting these for a long time -- 2,649
    # entries carry one, from winget manifests, distribution packaging and
    # other third parties -- under `checksum_corroboration`, and nothing
    # in the project has ever read one. They were the answer to exactly
    # this case and were filed instead of used. An independently sourced
    # hash is weaker evidence than the vendor's own, and it is far
    # stronger than "the file is the right length", which is what these
    # entries were getting.
    cc = e.get("checksum_corroboration") or []
    for c2 in cc:
        try:
            algo, want = c2["algo"], c2["value"].lower()
            h = hashlib.new(algo)
        except (KeyError, TypeError, ValueError):
            continue
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        src = str(c2.get("source") or "an unnamed third party")
        return h.hexdigest().lower() == want, f"{algo} corroborated by {src}"
    if e.get("size"):
        return path.stat().st_size == e["size"], "size only (no vendor checksum, none corroborated)"
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
    ap.add_argument("runtimes", nargs="*")
    ap.add_argument("--plan-name", default="download_plan.json")
    ap.add_argument("--plan", help="a plan file anywhere, possibly covering several runtimes")
    ap.add_argument("--root", help="the runtimes store to download into (default: beside this script)")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--min-free-gb", type=float, default=25)
    a = ap.parse_args()
    if a.root:
        set_root(a.root)
    if not a.plan and not a.runtimes:
        ap.error("name at least one runtime, or give --plan")
    min_free = int(a.min_free_gb * 1e9)

    # --plan: one file, grouped by the runtime each entry names, so the log
    # and the gaps file stay per-runtime as they always were.
    if a.plan:
        entries = json.loads(Path(a.plan).expanduser().read_text())
        if a.runtimes:
            want = set(a.runtimes)
            entries = [e for e in entries if e["runtime"] in want]
        groups, order = {}, []
        for e in entries:
            if e["runtime"] not in groups:
                groups[e["runtime"]] = []
                order.append(e["runtime"])
            groups[e["runtime"]].append(e)
        plans = [(r, groups[r]) for r in order]
    else:
        plans = [(r, json.loads((CATALOG / r / a.plan_name).read_text())) for r in a.runtimes]

    gaps = json.loads(GAPS.read_text()) if GAPS.exists() else {}
    for runtime, plan in plans:
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
