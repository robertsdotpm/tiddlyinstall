#!/usr/bin/env python3
"""Apply mirrors confirmed by the 2026-09-17 mirror hunt to python's release
metadata. Python 3 standard library only; re-runnable and idempotent.

What this adds (see mirrors.json for how each was confirmed, and
NOTES.md's "Mirror hunt (2026-09-17)" section for the full story):

1. `http://` variants of the already-confirmed huaweicloud, huaweicloud-repo
   and aliyun templates -- same host, same layout, just plain http. Added
   only to entries that already carry the matching `https://` mirror for
   that host (that presence is the evidence the URL layout is valid for
   this entry).
2. A brand-new mirror for python-build-standalone (PBS) releases -- these
   are GitHub-hosted and previously had `mirrors: []` always. npmmirror
   mirrors astral-sh/python-build-standalone releases at both
   `registry.npmmirror.com/-/binary/...` and `cdn.npmmirror.com/binaries/...`.
   Since npmmirror is a rolling mirror (not guaranteed to carry every
   release), each PBS entry's candidate mirror is checked against
   npmmirror's own live directory listing (which reports file size) before
   being added, and the result is cached in extra_mirrors_cache.json beside
   this script so re-runs don't re-hit the network for entries already
   confirmed (or already found absent).

This script only ever appends to `mirrors`; it never touches `url`,
`runtime`, `os`, `arch`, `version`, `variant` or `checksum`.
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_FILE = HERE / "extra_mirrors_cache.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

HUAWEICLOUD_HTTPS = "https://mirrors.huaweicloud.com/python/"
HUAWEICLOUD_HTTP = "http://mirrors.huaweicloud.com/python/"
HUAWEICLOUD_REPO_HTTPS = "https://repo.huaweicloud.com/python/"
HUAWEICLOUD_REPO_HTTP = "http://repo.huaweicloud.com/python/"
ALIYUN_HTTPS = "https://mirrors.aliyun.com/python-release/windows/"
ALIYUN_HTTP = "http://mirrors.aliyun.com/python-release/windows/"

PBS_MARKER = "/astral-sh/python-build-standalone/releases/download/"
NPMMIRROR_PBS_REGISTRY = "https://registry.npmmirror.com/-/binary/python-build-standalone/{tag}/{file}"
NPMMIRROR_PBS_CDN = "https://cdn.npmmirror.com/binaries/python-build-standalone/{tag}/{file}"
NPMMIRROR_PBS_LISTING = "https://registry.npmmirror.com/-/binary/python-build-standalone/{tag}/"


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {"pbs_tag_listings": {}}


def save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def get_pbs_tag_listing(tag, cache):
    """Return {filename: size} for a python-build-standalone release tag,
    as reported by npmmirror's own directory listing. Cached indefinitely
    per tag (release tags are immutable once published)."""
    cached = cache["pbs_tag_listings"].get(tag)
    if cached is not None:
        return cached
    url = NPMMIRROR_PBS_LISTING.format(tag=tag)
    try:
        data = fetch_json(url)
        listing = {entry["name"]: entry.get("size") for entry in data if entry.get("type") == "file"}
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError, ValueError) as e:
        print(f"  ! npmmirror PBS listing for tag {tag} failed: {e}", file=sys.stderr)
        listing = {}
    cache["pbs_tag_listings"][tag] = listing
    save_cache(cache)
    time.sleep(0.2)  # be polite between tag listings
    return listing


def add_mirror(entry, mirror_url):
    if mirror_url not in entry["mirrors"]:
        entry["mirrors"].append(mirror_url)
        return True
    return False


def apply_http_variants(entry):
    added = 0
    if any(m.startswith(HUAWEICLOUD_HTTPS) for m in entry["mirrors"]):
        for m in list(entry["mirrors"]):
            if m.startswith(HUAWEICLOUD_HTTPS):
                http_url = HUAWEICLOUD_HTTP + m[len(HUAWEICLOUD_HTTPS):]
                added += add_mirror(entry, http_url)
    if any(m.startswith(HUAWEICLOUD_REPO_HTTPS) for m in entry["mirrors"]):
        for m in list(entry["mirrors"]):
            if m.startswith(HUAWEICLOUD_REPO_HTTPS):
                http_url = HUAWEICLOUD_REPO_HTTP + m[len(HUAWEICLOUD_REPO_HTTPS):]
                added += add_mirror(entry, http_url)
    if entry.get("os") == "windows" and any(m.startswith(ALIYUN_HTTPS) for m in entry["mirrors"]):
        for m in list(entry["mirrors"]):
            if m.startswith(ALIYUN_HTTPS):
                http_url = ALIYUN_HTTP + m[len(ALIYUN_HTTPS):]
                added += add_mirror(entry, http_url)
    return added


def apply_pbs_npmmirror(entry, cache):
    url = entry.get("url", "")
    if PBS_MARKER not in url:
        return 0
    tag_and_file = url.split(PBS_MARKER, 1)[1]
    tag, _, encoded_file = tag_and_file.partition("/")
    filename = urllib.parse.unquote(encoded_file)

    listing = get_pbs_tag_listing(tag, cache)
    got_size = listing.get(filename)
    if got_size is None:
        return 0  # npmmirror doesn't have this file for this tag -- don't guess
    if entry.get("size") is not None and got_size != entry["size"]:
        print(f"  ! size mismatch for {filename} (tag {tag}): "
              f"vendor {entry['size']} vs npmmirror {got_size} -- not adding", file=sys.stderr)
        return 0

    encoded = urllib.parse.quote(filename)
    added = 0
    added += add_mirror(entry, NPMMIRROR_PBS_REGISTRY.format(tag=tag, file=encoded))
    added += add_mirror(entry, NPMMIRROR_PBS_CDN.format(tag=tag, file=encoded))
    return added


def process_file(path, cache):
    entries = json.loads(path.read_text())
    total_added = 0
    for entry in entries:
        total_added += apply_http_variants(entry)
        total_added += apply_pbs_npmmirror(entry, cache)
    path.write_text(json.dumps(entries, indent=1) + "\n")
    print(f"{path.name}: {len(entries)} entries, {total_added} mirror URLs added")


def main():
    cache = load_cache()
    process_file(HERE / "releases.json", cache)
    for plan_path in sorted(HERE.glob("download_plan*.json")):
        process_file(plan_path, cache)
    save_cache(cache)


if __name__ == "__main__":
    main()
