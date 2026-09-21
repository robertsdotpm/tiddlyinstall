#!/usr/bin/env python3
"""Slowly find Internet Archive (Wayback Machine) copies of catalog files.

usage: wayback_retry.py [--delay 4] [--max-lookups N] [--folders java,php,...]

Order of work:
  1. download_plan_majors.json entries with no mirror
  2. download_plan_majors.json entries that already have mirrors
  3. releases.json entries with no mirror

For each file: query the CDX index for 200/30x captures of the exact URL, then
HEAD the newest capture's raw copy (https://web.archive.org/web/<timestamp>id_/<url>),
following redirects within web.archive.org. A capture counts only if its
Content-Length equals the entry's recorded size (entries without a size are
skipped). Confirmed captures are appended as mirrors via tools/add_mirrors.py.

Every answer (found, not archived, size mismatch) is cached in
catalog/wayback_cache.json, so the job can be stopped and restarted. HTTP 429 or
errors back off exponentially (up to 10 minutes) and are retried later rather
than cached as "not archived".
"""
import argparse
import json
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
CACHE = CATALOG / "wayback_cache.json"
FOLDERS = ["python", "node", "java", "dotnet", "go", "rust", "php", "r", "ruby", "nim", "zig", "cc", "cmake", "meson", "ninja"]
UA = "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog/1.0 (archive lookup; slow)"


def get(url, method="GET", timeout=60):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    return urllib.request.urlopen(req, timeout=timeout)


def load_cache():
    return json.loads(CACHE.read_text()) if CACHE.exists() else {}


def save_cache(cache):
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache))
    tmp.replace(CACHE)


def work_list(folders):
    seen, first, second, third = set(), [], [], []
    for f in folders:
        plan = CATALOG / f / "download_plan_majors.json"
        rel = CATALOG / f / "releases.json"
        if plan.exists():
            for e in json.loads(plan.read_text()):
                (second if e.get("mirrors") else first).append((f, e))
        if rel.exists():
            for e in json.loads(rel.read_text()):
                if not e.get("mirrors"):
                    third.append((f, e))
    out = []
    for f, e in first + second + third:
        if e["url"] in seen or not e.get("size"):
            continue
        seen.add(e["url"])
        out.append((f, e))
    return out


class Backoff(Exception):
    pass


def lookup(url, size):
    q = urllib.parse.urlencode({"url": url, "output": "json", "fl": "timestamp,statuscode",
                                "filter": "statuscode:(200|301|302)", "limit": "-5"})
    try:
        with get(f"https://web.archive.org/cdx/search/cdx?{q}") as r:
            rows = json.loads(r.read() or b"[]")
    except urllib.error.HTTPError as ex:
        if ex.code in (429, 502, 503, 504):
            raise Backoff(str(ex.code))
        return {"status": f"cdx http {ex.code}"}
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as ex:
        raise Backoff(type(ex).__name__)
    caps = [row for row in rows[1:]] if rows else []
    if not caps:
        return {"status": "not archived"}
    for ts, code in sorted(caps, reverse=True):
        raw = f"https://web.archive.org/web/{ts}id_/{url}"
        time.sleep(1)
        try:
            with get(raw, method="HEAD") as r:
                length = r.headers.get("Content-Length")
                final = r.geturl()
        except urllib.error.HTTPError as ex:
            if ex.code == 429:
                raise Backoff("429")
            continue
        except (urllib.error.URLError, TimeoutError):
            raise Backoff("head timeout")
        if length and int(length) == size and "web.archive.org" in final:
            return {"status": "found", "mirror": raw, "timestamp": ts}
    return {"status": "size mismatch or unusable captures"}


def flush(updates):
    if not updates:
        return
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, dir=CATALOG) as f:
        for u in updates:
            f.write(json.dumps(u) + "\n")
        name = f.name
    subprocess.run([sys.executable, str(CATALOG / "tools" / "add_mirrors.py"), name], check=False)
    Path(name).unlink()
    updates.clear()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--delay", type=float, default=4)
    ap.add_argument("--max-lookups", type=int, default=0)
    ap.add_argument("--folders", default=",".join(FOLDERS))
    a = ap.parse_args()

    cache = load_cache()
    todo = [(f, e) for f, e in work_list(a.folders.split(",")) if e["url"] not in cache]
    print(f"{len(todo)} files to look up ({len(cache)} cached)", flush=True)
    updates, done, found, pause = [], 0, 0, a.delay
    for f, e in todo:
        while True:
            try:
                res = lookup(e["url"], e["size"])
                pause = a.delay
                break
            except Backoff as why:
                pause = min(pause * 2, 600)
                print(f"backing off {pause:.0f}s ({why})", flush=True)
                time.sleep(pause)
        cache[e["url"]] = {**res, "folder": f, "checked": time.strftime("%Y-%m-%d")}
        if res["status"] == "found":
            found += 1
            updates.append({"folder": f, "url": e["url"], "mirror": res["mirror"],
                            "evidence": f"Wayback capture {res['timestamp']}, Content-Length matches size {e['size']}"})
        done += 1
        if done % 25 == 0:
            save_cache(cache)
            flush(updates)
            print(f"{done}/{len(todo)} looked up, {found} found", flush=True)
        if a.max_lookups and done >= a.max_lookups:
            break
        time.sleep(a.delay)
    save_cache(cache)
    flush(updates)
    print(f"finished: {done} looked up, {found} found", flush=True)


if __name__ == "__main__":
    main()
