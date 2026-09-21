#!/usr/bin/env python3
"""Extend Ruby's confirmed mirrors beyond scrape.py's baseline (none --
scrape.py itself confirms zero mirrors, see mirrors.json's "note").

Mirror hunt (2026-09-17) -- see the "Mirror hunt (2026-09-17)" section of
NOTES.md for the full narrative of what was tried and rejected. Re-runnable
and idempotent: HEAD-confirms each candidate against SAMPLE_SOURCE_FILES
(caching results in extra_mirrors_cache.json beside this script), then
appends confirmed mirror URLs to the `mirrors` array of every matching
entry in releases.json and every download_plan*.json in this folder --
without duplicating an already-present URL and without touching `url`,
`runtime`, `os`, `arch`, `version`, `variant` or `checksum` on any entry.

Run this *after* scrape.py (scrape.py rebuilds releases.json/mirrors.json
from scratch with zero mirrors and would otherwise wipe this addition).

    python3 extra_mirrors.py            # apply cached/fresh confirmations
    python3 extra_mirrors.py --recheck  # force re-check every candidate
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_FILE = HERE / "extra_mirrors_cache.json"

SOURCE_CANONICAL = "https://cache.ruby-lang.org/pub/ruby/"
RI2_CANONICAL_PREFIX = "https://github.com/oneclick/rubyinstaller2/releases/download/"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
TIMEOUT = 15
MAX_WORKERS = 10

# Old/mid/new spread across format (.tar.gz/.tar.bz2/.tar.xz), matching
# the brief's "at least 6 files, old/mid/new" sampling rule. Sizes are
# the vendor (cache.ruby-lang.org) Content-Length, used as the match
# target so this script doesn't need network access to the canonical
# host just to bootstrap a comparison.
SAMPLE_SOURCE_FILES = {
    "1.8/ruby-1.8.7-p374.tar.gz": 4903749,
    "1.9/ruby-1.9.3-p551.tar.bz2": 10049332,
    "2.0/ruby-2.0.0-p648.tar.gz": 13622628,
    "2.7/ruby-2.7.8.tar.gz": 16950365,
    "3.3/ruby-3.3.5.tar.xz": 16403660,
    "4.0/ruby-4.0.7.tar.gz": 23937964,
}

# Full mirrors of cache.ruby-lang.org's pub/ruby/<major>/<file> tree --
# confirmed by exact Content-Length match on every SAMPLE_SOURCE_FILES
# entry, over both https and (per the brief's priority-2 rule) http where
# it works, plus one full hash-verified download each (see NOTES.md).
# Template uses {path} = "<major>/<file>" exactly as cache.ruby-lang.org
# lays it out.
FULL_SOURCE_MIRRORS = [
    {
        "host": "mirror.cyberbits.eu",
        "url_template": "https://mirror.cyberbits.eu/ruby/{path}",
        "region": "France / Europe (Scaleway-hosted, per reverse DNS + IP range)",
        "protocols": ["https", "http"],
    },
    {
        "host": "ftp.iij.ad.jp",
        "url_template": "https://ftp.iij.ad.jp/pub/lang/ruby/{path}",
        "region": "Japan (Internet Initiative Japan)",
        "protocols": ["https", "http"],
    },
    {
        "host": "www.ring.gr.jp",
        "url_template": "http://www.ring.gr.jp/pub/lang/ruby/{path}",
        "region": "Japan (RING Server Project)",
        "protocols": ["http"],  # https to this host timed out, see NOTES.md
    },
]

# Partial mirror: ftp.fu-berlin.de stopped syncing new Ruby releases
# somewhere around the 2.6 era (its directory listing has 1.0/ through
# 2.6/ and nothing newer) -- every entry it's applied to is individually
# HEAD-checked, per MIRROR-HUNT.md's rule for partial/rolling mirrors.
PARTIAL_SOURCE_MIRROR = {
    "host": "ftp.fu-berlin.de",
    "url_template": "https://ftp.fu-berlin.de/unix/languages/ruby/{path}",
    "region": "Germany / Europe (Freie Universitat Berlin)",
    "protocols": ["https", "http"],
}

# Partial mirror of ONE GitHub repo's LATEST release only (NJU's
# github-release proxy keeps a "LatestRelease" + one dated folder per
# project, not history) -- applies to exactly the 8 non-.asc Windows
# assets of the current newest RubyInstaller2 stable release. Path is
# literal (includes a space and the release date, matching NJU's own
# folder naming) rather than a template, since it only ever covers one
# version at a time and would need re-discovery on every new release
# regardless of templating.
NJU_RI2_LATEST = {
    "host": "mirrors.nju.edu.cn",
    "region": "China (Nanjing University)",
    "protocols": ["https"],  # requires a bot-check cookie round-trip first, see NOTES.md
    "note": "partial: only the single newest RubyInstaller2 release, refreshed manually here each hunt",
    "files": {
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.7-1/rubyinstaller-4.0.7-1-x64.7z":
            "https://mirrors.nju.edu.cn/github-release/oneclick/rubyinstaller2/RubyInstaller-4.0.7-1%20-%202026-09-15/rubyinstaller-4.0.7-1-x64.7z",
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.7-1/rubyinstaller-4.0.7-1-x64.exe":
            "https://mirrors.nju.edu.cn/github-release/oneclick/rubyinstaller2/RubyInstaller-4.0.7-1%20-%202026-09-15/rubyinstaller-4.0.7-1-x64.exe",
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.7-1/rubyinstaller-devkit-4.0.7-1-x64.exe":
            "https://mirrors.nju.edu.cn/github-release/oneclick/rubyinstaller2/RubyInstaller-4.0.7-1%20-%202026-09-15/rubyinstaller-devkit-4.0.7-1-x64.exe",
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.7-1/rubyinstaller-4.0.7-1-arm.7z":
            "https://mirrors.nju.edu.cn/github-release/oneclick/rubyinstaller2/RubyInstaller-4.0.7-1%20-%202026-09-15/rubyinstaller-4.0.7-1-arm.7z",
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.7-1/rubyinstaller-4.0.7-1-arm.exe":
            "https://mirrors.nju.edu.cn/github-release/oneclick/rubyinstaller2/RubyInstaller-4.0.7-1%20-%202026-09-15/rubyinstaller-4.0.7-1-arm.exe",
        "https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-4.0.7-1/rubyinstaller-devkit-4.0.7-1-arm.exe":
            "https://mirrors.nju.edu.cn/github-release/oneclick/rubyinstaller2/RubyInstaller-4.0.7-1%20-%202026-09-15/rubyinstaller-devkit-4.0.7-1-arm.exe",
    },
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def head(url, follow_redirects=True, cookie_roundtrip=False):
    """Return (status, size). NJU's proxy sets a bot-check cookie on the
    first response and 302s back to the same URL; a second request with
    that cookie returns the real answer -- cookie_roundtrip replays that.
    """
    opener = urllib.request.build_opener() if follow_redirects else _NO_REDIRECT_OPENER
    if cookie_roundtrip:
        jar_headers = {"User-Agent": USER_AGENT}
        req1 = urllib.request.Request(url, method="HEAD", headers=jar_headers)
        try:
            with urllib.request.build_opener().open(req1, timeout=TIMEOUT) as r:
                cookie = r.headers.get("Set-Cookie", "")
        except Exception:
            cookie = ""
        cookie_val = cookie.split(";")[0] if cookie else ""
        headers = {"User-Agent": USER_AGENT}
        if cookie_val:
            headers["Cookie"] = cookie_val
        req2 = urllib.request.Request(url, method="HEAD", headers=headers)
        try:
            with urllib.request.build_opener().open(req2, timeout=TIMEOUT) as r:
                cl = r.headers.get("Content-Length")
                return r.status, (int(cl) if cl else None)
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            return None, None

    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with opener.open(req, timeout=TIMEOUT) as r:
            cl = r.headers.get("Content-Length")
            return r.status, (int(cl) if cl else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def head_many(urls, **kw):
    results = {}
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = ex.map(lambda u: head(u, **kw), urls)
        for url, res in zip(urls, futs):
            results[url] = res
    return results


def load_cache():
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, indent=2) + "\n")


def verify_full_mirrors(recheck=False):
    cache = load_cache()
    full_cache = cache.setdefault("full_source_mirrors", {})
    ok = {}
    for m in FULL_SOURCE_MIRRORS:
        host = m["host"]
        if not recheck and host in full_cache:
            ok[host] = full_cache[host]["confirmed"]
            continue
        per_file = {}
        all_ok = True
        for path, expect_size in SAMPLE_SOURCE_FILES.items():
            url = m["url_template"].format(path=path)
            status, size = head(url, follow_redirects=False)
            match = bool(status == 200 and size == expect_size)
            per_file[path] = {"status": status, "size": size, "match": match}
            if not match:
                all_ok = False
        full_cache[host] = {"confirmed": all_ok, "sample_results": per_file}
        ok[host] = all_ok
    save_cache(cache)
    return ok


def verify_partial_source_mirror(source_entries, recheck=False):
    """HEAD-check ftp.fu-berlin.de against every source-kind release
    entry (not just the 6-file sample), since it's a partial/rolling
    mirror -- MIRROR-HUNT.md requires per-entry confirmation for those.
    Returns the set of source-entry urls it's confirmed to mirror.
    """
    cache = load_cache()
    key = "fu_berlin_per_entry"
    if not recheck and key in cache:
        return set(cache[key])

    tmpl = PARTIAL_SOURCE_MIRROR["url_template"]
    pairs = []
    for e in source_entries:
        path = e["url"][len(SOURCE_CANONICAL):]
        pairs.append((e["url"], tmpl.format(path=path), e["size"]))

    urls = [mirror_url for _, mirror_url, _ in pairs]
    results = head_many(urls, follow_redirects=False)
    confirmed = set()
    for canonical_url, mirror_url, expect_size in pairs:
        status, size = results[mirror_url]
        if status == 200 and expect_size and size == expect_size:
            confirmed.add(canonical_url)
    cache[key] = sorted(confirmed)
    save_cache(cache)
    return confirmed


def apply_full_mirror(entries, template, predicate):
    added = 0
    for e in entries:
        if not predicate(e):
            continue
        path = e["url"][len(SOURCE_CANONICAL):]
        new_url = template.format(path=path)
        if new_url not in e["mirrors"]:
            e["mirrors"].append(new_url)
            added += 1
    return added


def apply_partial_source_mirror(entries, template, confirmed_urls):
    added = 0
    for e in entries:
        if e["url"] not in confirmed_urls:
            continue
        path = e["url"][len(SOURCE_CANONICAL):]
        new_url = template.format(path=path)
        if new_url not in e["mirrors"]:
            e["mirrors"].append(new_url)
            added += 1
    return added


def apply_nju_ri2(entries):
    added = 0
    for e in entries:
        mirror_url = NJU_RI2_LATEST["files"].get(e.get("url"))
        if mirror_url and mirror_url not in e["mirrors"]:
            e["mirrors"].append(mirror_url)
            added += 1
    return added


def main():
    recheck = "--recheck" in sys.argv

    releases_path = HERE / "releases.json"
    releases = json.loads(releases_path.read_text())
    source_entries = [e for e in releases if e["kind"] == "source" and e["url"].startswith(SOURCE_CANONICAL)]

    print("Confirming full source mirrors against the 6-file sample ...")
    full_ok = verify_full_mirrors(recheck=recheck)
    for m in FULL_SOURCE_MIRRORS:
        print(f"  {m['host']}: {'confirmed' if full_ok.get(m['host']) else 'NOT confirmed'}")

    print(f"HEAD-checking ftp.fu-berlin.de (partial) against all {len(source_entries)} source entries ...")
    fub_confirmed = verify_partial_source_mirror(source_entries, recheck=recheck)
    print(f"  fu-berlin matches {len(fub_confirmed)}/{len(source_entries)} source entries")

    targets = ["releases.json"] + sorted(p.name for p in HERE.glob("download_plan*.json"))
    for name in targets:
        path = HERE / name
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        added = 0
        for m in FULL_SOURCE_MIRRORS:
            if full_ok.get(m["host"]):
                added += apply_full_mirror(
                    data, m["url_template"],
                    lambda e: e["kind"] == "source" and e["url"].startswith(SOURCE_CANONICAL),
                )
        added += apply_partial_source_mirror(data, PARTIAL_SOURCE_MIRROR["url_template"], fub_confirmed)
        added += apply_nju_ri2(data)
        path.write_text(json.dumps(data, indent=2) + "\n")
        print(f"{name}: {len(data)} entries, {added} mirror URLs added")


if __name__ == "__main__":
    main()
