#!/usr/bin/env python3
"""Fill a runtime mirror from vendor URLs, so the files don't have to be
uploaded from the machine that first downloaded them.

usage: mirror_fetch.py MANIFEST DEST [--jobs 4]

MANIFEST is a JSON list of {"path", "size", "sha256" (or null), "urls"}.
Each file goes to DEST/<path>. Files already there with the right size
(and SHA-256, when known) are skipped. URLs are tried in order; a download
counts only if its SHA-256 matches, or, when none is known, its size.
Progress goes to DEST/.fetch-log.jsonl; files that couldn't be fetched are
listed in DEST/.fetch-failed.json, for copying by rsync instead.
"""
import concurrent.futures as cf
import hashlib
import json
import os
import sys
import threading
import time
import urllib.request

UA = "installer-builder-mirror/1 (+https://github.com/robertsdotpm/installer-builder)"
lock = threading.Lock()


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def good(p, e):
    if not os.path.exists(p) or os.path.getsize(p) != e["size"]:
        return False
    return not e.get("sha256") or sha256_file(p) == e["sha256"]


def fetch(e, dest, log):
    p = os.path.join(dest, e["path"])
    if good(p, e):
        return e["path"], "have", None
    os.makedirs(os.path.dirname(p), exist_ok=True)
    errs = []
    for u in e["urls"]:
        part = p + ".part"
        try:
            h = hashlib.sha256()
            req = urllib.request.Request(u, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r, open(part, "wb") as o:
                for b in iter(lambda: r.read(1 << 20), b""):
                    h.update(b)
                    o.write(b)
            size = os.path.getsize(part)
            if e.get("sha256") and h.hexdigest() != e["sha256"]:
                errs.append(f"{u}: sha256 mismatch")
            elif not e.get("sha256") and size != e["size"]:
                errs.append(f"{u}: size {size} != {e['size']}")
            else:
                os.replace(part, p)
                return e["path"], "ok", u
        except Exception as x:  # network errors are data here
            errs.append(f"{u}: {type(x).__name__}: {x}")
        if os.path.exists(part):
            os.remove(part)
    return e["path"], "failed", errs


def main():
    manifest, dest = sys.argv[1], sys.argv[2]
    jobs = int(sys.argv[sys.argv.index("--jobs") + 1]) if "--jobs" in sys.argv else 4
    entries = json.load(open(manifest))
    # Smallest first, so most files land early and one huge file can't
    # hold everything up.
    entries.sort(key=lambda e: e["size"])
    failed = []
    done = 0
    t0 = time.time()
    with open(os.path.join(dest, ".fetch-log.jsonl"), "a") as log, cf.ThreadPoolExecutor(jobs) as ex:
        futs = {ex.submit(fetch, e, dest, log): e for e in entries}
        for f in cf.as_completed(futs):
            e = futs[f]
            path, status, info = f.result()
            done += 1
            with lock:
                log.write(json.dumps({"path": path, "status": status, "info": info, "t": round(time.time() - t0)}) + "\n")
                log.flush()
            if status == "failed":
                failed.append({"path": path, "size": e["size"], "errors": info})
    json.dump(failed, open(os.path.join(dest, ".fetch-failed.json"), "w"), indent=1)
    print(f"done: {done} files, {len(failed)} failed, {round(time.time() - t0)} s")


if __name__ == "__main__":
    main()
