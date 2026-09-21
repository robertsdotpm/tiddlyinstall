#!/usr/bin/env python3
"""Mirror hunt follow-up for runtime="node" (2026-09-17).

Extends the mirrors scrape.py already confirmed (npmmirror-cdn,
npmmirror-registry, nodejs-download-release) with mirrors found in a
follow-up hunt. Python 3 stdlib only. Re-runnable and idempotent:

  - "full" mirrors were confirmed by an >=8-file HEAD sample spanning old,
    middle and newest node versions and windows/linux/macos/arm/amd64 --
    every sampled file matched the vendor's Content-Length exactly -- and
    are applied to every entry in scope without a further per-entry check
    (same policy scrape.py already used for its own confirmed mirrors).
  - "partial" mirrors (rolling/lagging syncs, or mirrors that were already
    rejected once as partial) are only ever applied to an entry after a
    per-entry HEAD check against that entry's own vendor size, because the
    sample showed real gaps (an old isolated hole, or the newest release(s)
    not yet synced). Results are cached in extra_mirrors_cache.json beside
    this file, keyed by URL, so re-running only re-checks what has not been
    checked yet (delete the cache to force a full recheck, e.g. once a
    lagging mirror has had time to catch up).
  - archive.org (Wayback Machine) is handled separately: it is the only
    lead for io.js (no live mirror exists anywhere for iojs.org) and is
    also checked, per the brief, for node's oldest lines (0.8/0.10/0.12).
    Coverage is partial by nature, so every candidate is HEAD/size-checked
    individually and cached the same way.

This script does not touch url/runtime/os/arch/version/variant/checksum on
any entry -- it only appends to `mirrors` (no duplicates, existing entries
kept first).

Usage:
    python3 extra_mirrors.py [--max-checks N] [--only full|partial|wayback]

--max-checks bounds how many *new* (uncached) network checks a single run
performs for the partial/wayback phases, so a long hunt can be resumed
across several invocations without re-doing finished work.
"""
import argparse
import concurrent.futures as cf
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_PATH = HERE / "extra_mirrors_cache.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
HEADERS = {"User-Agent": UA}

RELEASE_FILES = ["releases.json"]
PLAN_GLOB = "download_plan*.json"

# --------------------------------------------------------------------------
# mirror definitions
# --------------------------------------------------------------------------

# scope name -> predicate over a release entry
def scope_official(e):
    return e.get("variant") is None


def scope_unofficial(e):
    return e.get("variant") in ("unofficial", "musl")


def scope_wayback(e):
    # io.js: no live mirror exists anywhere for it, archive.org is the only
    # lead. node's oldest lines: explicitly called out in the brief, even
    # though they're already fully covered by the full mirrors below --
    # archive.org adds a mirror reachable from networks that can't reach
    # China/Russia/Denmark at all.
    return e.get("variant") == "iojs" or (
        e.get("variant") is None and e.get("major") in ("0.8", "0.10", "0.12")
    )


SCOPES = {"official": scope_official, "unofficial": scope_unofficial, "wayback": scope_wayback}

# Confirmed by an >=8-file sample (0.8.0 .. 26.9.0, pkg/msi/tar.gz/zip,
# linux/windows/macos, amd64/arm64) all matching the vendor's Content-Length
# exactly. Non-China, checked 2026-09-17.
FULL_MIRRORS = [
    {"name": "yandex", "scope": "official",
     "template": "https://mirror.yandex.ru/mirrors/nodejs.org/dist/v{version}/{filename}"},
    # China, but the sample matched 8/8 including the newest release
    # (unlike huaweicloud/tuna/ustc/tencent below) -- genuinely full.
    {"name": "aliyun", "scope": "official",
     "template": "https://mirrors.aliyun.com/nodejs-release/v{version}/{filename}"},
    # npmmirror already mirrors official node/; it turns out it *also*
    # mirrors unofficial-builds.nodejs.org byte-for-byte (15/15 sample:
    # linux-x86, armv6l, riscv64, loong64, win-arm64, musl, old and new).
    {"name": "npmmirror-cdn-unofficial", "scope": "unofficial",
     "template": "https://cdn.npmmirror.com/binaries/node-unofficial-builds/v{version}/{filename}"},
    {"name": "npmmirror-registry-unofficial", "scope": "unofficial",
     "template": "https://registry.npmmirror.com/-/binary/node-unofficial-builds/v{version}/{filename}"},
]

# Previously rejected as "partial", or newly found and partial: real gaps
# were found in the sample (an isolated hole, or the newest release(s) not
# yet synced), so every entry gets its own HEAD check before the mirror is
# applied to it.
PARTIAL_MIRRORS = [
    {"name": "huaweicloud", "scope": "official",
     "template": "https://mirrors.huaweicloud.com/nodejs/v{version}/{filename}"},
    {"name": "tuna", "scope": "official",
     "template": "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v{version}/{filename}"},
    {"name": "ustc", "scope": "official",
     "template": "https://mirrors.ustc.edu.cn/node/v{version}/{filename}"},
    {"name": "tencent", "scope": "official",
     "template": "https://mirrors.cloud.tencent.com/nodejs-release/v{version}/{filename}"},
    # Non-China (Denmark/EU), but its node mirror stops syncing somewhere
    # around v24.0-24.9 (25.x/26.x entirely absent as of 2026-09-17) --
    # confirmed stale by version, not just the newest patch.
    {"name": "dotsrc", "scope": "official",
     "template": "https://mirrors.dotsrc.org/nodejs/release/v{version}/{filename}"},
]

# Rejected outright, kept here so a future run doesn't re-try them blind:
#   - mirror.sjtu.edu.cn/nodejs-release/ : sits behind a "Cerberus" bot
#     challenge that intermittently 403s plain HEAD/GET (both http and
#     https) even for files it does carry -- unusable for unattended/old
#     clients. See NOTES.md.
#   - iojs.org itself, nodejs.org/dist, npmmirror, aliyun: none carry a
#     mirror copy of iojs.org/dist -- checked directly, nothing found.
#   - JAIST: no evidence found of a nodejs/iojs mirror there.

WORKERS_PARTIAL = 6   # politeness cap per partial mirror host
WORKERS_WAYBACK = 3   # archive.org is slower and flakier; stay gentle


# --------------------------------------------------------------------------
# low-level fetch helpers
# --------------------------------------------------------------------------

def fetch_head(url, retries=3, timeout=20):
    """Return (status, content_length) for a HEAD request, following
    redirects. content_length is None if absent/unknown. status is None on
    total failure (never a 404 -- that's a normal, cacheable result)."""
    last_exc = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS, method="HEAD")
            with urllib.request.urlopen(req, timeout=timeout) as r:
                cl = r.headers.get("Content-Length")
                ct = r.headers.get("Content-Type", "")
                # a soft-404 interstitial (ustc) is HTML, never the real file
                if ct.startswith("text/html"):
                    return r.status, None
                return r.status, (int(cl) if cl is not None else None)
        except urllib.error.HTTPError as e:
            if e.code in (403, 429):
                last_exc = e
                time.sleep(1.5 * (i + 1))
                continue
            return e.code, None
        except Exception as e:
            last_exc = e
            time.sleep(1.0 * (i + 1))
    print(f"  ! HEAD failed after retries: {url}: {last_exc}", file=sys.stderr)
    return None, None


class _NoRedirect(urllib.request.HTTPErrorProcessor):
    def http_response(self, request, response):
        return response
    https_response = http_response


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def fetch_get_headers_only(url, retries=3, timeout=30, max_redirects=5):
    """GET a URL but only read headers (used for archive.org, whose HEAD
    responses report Content-Length: 0 on the raw id_ endpoint).

    Follows redirects manually rather than via urllib's default handler,
    because archive.org's Location headers come back as https:// even when
    asked over http://, and https to web.archive.org was observed to be
    very unreliable from this network (connection resets, multi-minute
    hangs) while http is fast and stable. Every hop is forced back to
    http:// before following it."""
    last_exc = None
    current = url
    for hop in range(max_redirects):
        ok = False
        for i in range(retries):
            try:
                req = urllib.request.Request(current, headers=HEADERS, method="GET")
                with _NO_REDIRECT_OPENER.open(req, timeout=timeout) as r:
                    status = r.status
                    if status in (301, 302, 303, 307, 308):
                        loc = r.headers.get("Location")
                        if not loc:
                            return None, None
                        if loc.startswith("https://"):
                            loc = "http://" + loc[len("https://"):]
                        current = loc
                        ok = True
                        break
                    if status == 404:
                        return None, None
                    if status != 200:
                        last_exc = f"HTTP {status}"
                        time.sleep(2.0 * (i + 1))
                        continue
                    cl = r.headers.get("Content-Length")
                    return current, (int(cl) if cl is not None else None)
            except Exception as e:
                last_exc = e
                time.sleep(2.0 * (i + 1))
        if not ok:
            print(f"  ! archive.org lookup failed after retries: {url}: {last_exc}", file=sys.stderr)
            return None, None
    print(f"  ! archive.org lookup: too many redirects: {url}", file=sys.stderr)
    return None, None


def parallel_map(fn, items, workers):
    items = list(items)
    results = [None] * len(items)
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        fut_to_idx = {ex.submit(fn, item): i for i, item in enumerate(items)}
        for fut in cf.as_completed(fut_to_idx):
            i = fut_to_idx[fut]
            try:
                results[i] = fut.result()
            except Exception as e:
                print(f"  ! task failed for {items[i]!r}: {e}", file=sys.stderr)
                results[i] = None
    return results


# --------------------------------------------------------------------------
# cache
# --------------------------------------------------------------------------

def load_cache():
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {"vendor_size": {}, "checks": {}, "wayback": {}}


def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


# --------------------------------------------------------------------------
# entry helpers
# --------------------------------------------------------------------------

def entry_key(e):
    return (e["runtime"], e["version"], e["os"], e["arch"], e.get("variant"), e.get("format"))


def mirror_url_for(e, template):
    filename = e["url"].rsplit("/", 1)[-1]
    return template.format(version=e["version"], filename=filename)


def append_mirror(e, url):
    if url not in e.get("mirrors", []):
        e.setdefault("mirrors", []).append(url)
        return True
    return False


# --------------------------------------------------------------------------
# phase 1: full mirrors (no per-entry network check needed)
# --------------------------------------------------------------------------

def apply_full_mirrors(entries):
    added = 0
    for m in FULL_MIRRORS:
        pred = SCOPES[m["scope"]]
        for e in entries:
            if not pred(e):
                continue
            if append_mirror(e, mirror_url_for(e, m["template"])):
                added += 1
    return added


# --------------------------------------------------------------------------
# phase 2: partial mirrors (per-entry HEAD, cached)
# --------------------------------------------------------------------------

def get_vendor_size(e, cache, budget):
    if e.get("size") is not None:
        return e["size"]
    url = e["url"]
    if url in cache["vendor_size"]:
        return cache["vendor_size"][url]
    if budget.spent >= budget.max_checks:
        return None
    budget.spent += 1
    _, size = fetch_head(url)
    cache["vendor_size"][url] = size
    return size


class Budget:
    def __init__(self, max_checks):
        self.max_checks = max_checks if max_checks is not None else float("inf")
        self.spent = 0


def apply_partial_mirrors(entries, cache, budget):
    added = 0
    checked = 0
    for m in PARTIAL_MIRRORS:
        name = m["name"]
        pred = SCOPES[m["scope"]]
        bucket = cache["checks"].setdefault(name, {})
        todo = [e for e in entries if pred(e)]

        def work(e, template=m["template"], bucket=bucket):
            mirror_url = mirror_url_for(e, template)
            if mirror_url in bucket:
                return mirror_url, bucket[mirror_url]
            if budget.spent >= budget.max_checks:
                return mirror_url, None  # not checked this run
            vendor_size = get_vendor_size(e, cache, budget)
            if vendor_size is None:
                bucket[mirror_url] = {"match": False, "reason": "no vendor size"}
                return mirror_url, bucket[mirror_url]
            budget.spent += 1
            status, size = fetch_head(mirror_url)
            match = size is not None and size == vendor_size
            bucket[mirror_url] = {"match": match, "size": size, "vendor_size": vendor_size}
            return mirror_url, bucket[mirror_url]

        results = parallel_map(work, todo, WORKERS_PARTIAL)
        newly_checked = 0
        for e, r in zip(todo, results):
            if r is None:
                continue
            mirror_url, outcome = r
            if outcome is None:
                continue
            newly_checked += 1
            if outcome.get("match"):
                if append_mirror(e, mirror_url):
                    added += 1
        checked += newly_checked
        print(f"  {name}: {sum(1 for e in todo if mirror_url_for(e, m['template']) in bucket and bucket[mirror_url_for(e, m['template'])].get('match'))}"
              f"/{len(todo)} in scope matched so far ({newly_checked} newly checked this run)")
        save_cache(cache)
        if budget.spent >= budget.max_checks:
            print(f"  -- check budget ({budget.max_checks}) reached, stopping partial-mirror phase --")
            break
    return added, checked


# --------------------------------------------------------------------------
# phase 3: archive.org (Wayback Machine)
# --------------------------------------------------------------------------

# https, oddly, is very unreliable to web.archive.org from this network
# (connection resets / long hangs); plain http to the same host works.
WAYBACK_LOOKUP = "http://web.archive.org/web/2id_/{url}"


def apply_wayback(entries, cache, budget):
    bucket = cache["wayback"]
    todo = [e for e in entries if scope_wayback(e)]

    def work(e):
        vendor_url = e["url"]
        if vendor_url in bucket:
            return vendor_url, bucket[vendor_url]
        if budget.spent >= budget.max_checks:
            return vendor_url, None
        vendor_size = get_vendor_size(e, cache, budget)
        if vendor_size is None:
            bucket[vendor_url] = {"match": False, "reason": "no vendor size"}
            return vendor_url, bucket[vendor_url]
        budget.spent += 1
        lookup = WAYBACK_LOOKUP.format(url=vendor_url)
        final_url, size = fetch_get_headers_only(lookup)
        match = final_url is not None and size is not None and size == vendor_size
        bucket[vendor_url] = {
            "match": match,
            "snapshot_url": final_url if match else None,
            "size": size,
            "vendor_size": vendor_size,
        }
        return vendor_url, bucket[vendor_url]

    results = parallel_map(work, todo, WORKERS_WAYBACK)
    added = 0
    newly_checked = 0
    for e, r in zip(todo, results):
        if r is None:
            continue
        vendor_url, outcome = r
        if outcome is None:
            continue
        newly_checked += 1
        if outcome.get("match") and outcome.get("snapshot_url"):
            if append_mirror(e, outcome["snapshot_url"]):
                added += 1
    matched = sum(1 for v in bucket.values() if v.get("match"))
    print(f"  wayback: {matched}/{len(bucket)} candidates checked so far matched "
          f"({newly_checked} newly checked this run, {len(todo)} in scope)")
    save_cache(cache)
    return added, newly_checked


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def load_json(path):
    return json.loads(path.read_text())


def dump_json(path, data):
    text = json.dumps(data, indent=2) + "\n"
    path.write_text(text)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-checks", type=int, default=None,
                     help="cap on new (uncached) network checks this run, for the partial/wayback phases")
    ap.add_argument("--only", choices=["full", "partial", "wayback"], default=None,
                     help="run only one phase (default: all three)")
    args = ap.parse_args()

    cache = load_cache()
    budget = Budget(args.max_checks)

    releases_path = HERE / "releases.json"
    releases = load_json(releases_path)
    plan_paths = sorted(HERE.glob(PLAN_GLOB))
    plans = {p: load_json(p) for p in plan_paths}

    all_files = [(releases_path, releases)] + list(plans.items())

    total_full_added = 0
    total_partial_added = 0
    total_wayback_added = 0

    if args.only in (None, "full"):
        print("== full mirrors (no per-entry check needed) ==")
        for path, data in all_files:
            n = apply_full_mirrors(data)
            total_full_added += n
            print(f"  {path.name}: +{n} mirror URLs")

    if args.only in (None, "partial"):
        print("== partial mirrors (per-entry HEAD, cached) ==")
        # process the small plan files first (cheap, always finishes),
        # then releases.json (the expensive one) -- cache is shared by URL
        # so nothing already checked via a plan file is re-checked here.
        for path, data in list(plans.items()) + [(releases_path, releases)]:
            print(f" -- {path.name} --")
            n, c = apply_partial_mirrors(data, cache, budget)
            total_partial_added += n
            if budget.spent >= budget.max_checks:
                break

    if args.only in (None, "wayback"):
        print("== archive.org / Wayback Machine (per-entry, cached) ==")
        for path, data in [(releases_path, releases)] + list(plans.items()):
            n, c = apply_wayback(data, cache, budget)
            total_wayback_added += n
            if budget.spent >= budget.max_checks:
                break

    dump_json(releases_path, releases)
    for path, data in plans.items():
        dump_json(path, data)
    save_cache(cache)

    print(f"\nmirror URLs added this run: full={total_full_added} partial={total_partial_added} wayback={total_wayback_added}")
    print(f"network checks spent this run: {budget.spent}"
          + ("" if args.max_checks is None else f" / {args.max_checks} budget"))


if __name__ == "__main__":
    main()
