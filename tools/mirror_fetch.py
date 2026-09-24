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

**Fetch into both the mirror host and the local runtime store, or the
pull achieves nothing.** A mirror URL only reaches a plan through
`LocalIndex` (src/build_server/lib/catalog.js), which walks *this machine's*
copies under ~/projects/installer-builder-runtimes and fills in the
release's `local` path; the resolver then turns that path into the
mirror URL. A file that exists on ovh1 but that this machine has never
seen has no `local`, so its plans still name the vendor alone and the
copy is never used. Topping up the mirror is two halves: this script on
the mirror host, and the same files in the local store.

`tools/mirror_check.py` compares the three (manifest, local store,
mirror host) and names any file that is in one and not the others; run
it after a top-up rather than assuming.
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


# Hash the same file from another host. None when no other host could be
# read at all (so the caller falls back to what it has), the agreeing URL
# when they match, False when one answered and disagreed.
def corroborate(want, size, urls):
    reached = False
    for u in urls:
        try:
            h = hashlib.sha256()
            n = 0
            req = urllib.request.Request(u, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                for b in iter(lambda: r.read(1 << 20), b""):
                    h.update(b)
                    n += len(b)
        except Exception:
            continue
        reached = True
        if n == size and h.hexdigest() == want:
            return u
    return False if reached else None


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
            elif not e.get("sha256"):
                # No hash in the manifest, so the length is the only thing
                # that was compared -- and a third-party host that wanted
                # to put something else on our mirror would match it. Ask a
                # second host for the same file and require the two to
                # agree. It is not the vendor's own hash, but two unrelated
                # hosts serving the same bytes is a great deal more than
                # "it was the right number of bytes".
                other = [v for v in e["urls"] if v != u]
                second = corroborate(h.hexdigest(), size, other) if other else None
                if second is None:
                    os.replace(part, p)
                    return e["path"], "ok-size-only", u
                if second is False:
                    errs.append(f"{u}: no second source agreed on the bytes")
                else:
                    os.replace(part, p)
                    return e["path"], "ok-corroborated", f"{u} + {second}"
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
    # A list, or an object with the files under "files" and notes of its
    # own -- the shape tools/mirror_check.py already accepts and the one
    # tools/mirror_scope.mjs writes. Taking only one of the two meant a
    # manifest that checks cleanly could not be fetched with.
    doc = json.load(open(manifest))
    entries = doc["files"] if isinstance(doc, dict) else doc
    # Smallest first, so most files land early and one huge file can't
    # hold everything up.
    entries.sort(key=lambda e: e["size"])
    failed = []
    sizeonly = []
    corrob = []
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
            elif status == "ok-size-only":
                sizeonly.append(path)
            elif status == "ok-corroborated":
                corrob.append(path)
    json.dump(failed, open(os.path.join(dest, ".fetch-failed.json"), "w"), indent=1)
    print(f"done: {done} files, {len(failed)} failed, {round(time.time() - t0)} s")
    # Not a fault and not a clean pass either. A run that says nothing here
    # used to read as "every file verified", and for the entries with no
    # sha256 in the manifest it never was.
    if corrob:
        print(f"  {len(corrob)} had no sha256 in the manifest and were confirmed "
              f"against a second host")
    if sizeonly:
        print(f"  {len(sizeonly)} had no sha256 in the manifest and no second host "
              f"to ask: accepted on length alone")
        for x in sizeonly[:10]:
            print("    " + x)
        if len(sizeonly) > 10:
            print(f"    ... and {len(sizeonly) - 10} more")


if __name__ == "__main__":
    main()
