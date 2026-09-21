#!/usr/bin/env python3
"""Extend Go's confirmed mirrors beyond scrape.py's baseline (aliyun, nju).

Mirror hunt (2026-09-17) -- see the "Mirror hunt (2026-09-17)" section of
NOTES.md for what was tried and rejected. Re-runnable and idempotent:
HEAD-confirms each candidate in CONFIRMED_MIRRORS against SAMPLE_FILES
(caching results in extra_mirrors_cache.json beside this script), then
appends any host that's a *full* mirror of dl.google.com/go's flat
"<file>" layout to the `mirrors` array of every entry in releases.json and
every download_plan*.json in this folder -- without duplicating an
already-present URL and without touching `url`, `runtime`, `os`, `arch`,
`version`, `variant` or `checksum` on any entry.

Run this *after* scrape.py (scrape.py regenerates releases.json /
mirrors.json from scratch on its own hardcoded candidate list and would
otherwise wipe these additions).

    python3 extra_mirrors.py            # apply cached/fresh confirmations
    python3 extra_mirrors.py --recheck  # force re-HEAD every candidate
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE_FILE = HERE / "extra_mirrors_cache.json"

DL_BASE = "https://dl.google.com/go/"
# A normal browser UA -- per MIRROR-HUNT.md, some mirrors 403 curl/urllib's
# default UA string even though a browser gets served fine.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)
TIMEOUT = 20

# Old/mid/new spread across OS, arch and kind, matching (and extending)
# scrape.py's MIRROR_SAMPLE used to confirm aliyun/nju:
#   - go1.2.2 / go1.5.4 / go1.10.8 / go1.16.15 / go1.27.1 linux-amd64: old
#     through current, the bulk of downloads.
#   - go1.21.0 windows-amd64: a second OS/format (zip vs tar.gz).
#   - go1.27.1 aix-ppc64, go1.27.1 darwin-arm64, go1.21.0 freebsd-riscv64:
#     less common OS/arch combinations, to catch a partial mirror that only
#     carries the popular platforms.
#   - go1.4.2 darwin-amd64-osx10.6: the old dual-target-macOS naming scheme.
# go1.5.3.src.tar.gz (source kind) was additionally downloaded in full and
# sha256-verified against a mirror by hand before adding it here -- not
# re-downloaded on every run, see NOTES.md.
SAMPLE_FILES = [
    "go1.2.2.linux-amd64.tar.gz",
    "go1.5.4.linux-amd64.tar.gz",
    "go1.10.8.linux-amd64.tar.gz",
    "go1.16.15.linux-amd64.tar.gz",
    "go1.21.0.windows-amd64.zip",
    "go1.27.1.linux-amd64.tar.gz",
    "go1.27.1.aix-ppc64.tar.gz",
    "go1.27.1.darwin-arm64.tar.gz",
    "go1.21.0.freebsd-riscv64.tar.gz",
    "go1.4.2.darwin-amd64-osx10.6.tar.gz",
]

# New mirrors confirmed this hunt. `full_mirror: True` means it was
# HEAD-confirmed (no-redirect) on the whole SAMPLE_FILES set with an exact
# Content-Length match against dl.google.com for every one, and -- because
# it mirrors the entire dl.google.com/go tree by filename, the same flat
# layout as aliyun/nju -- is applied to every release entry rather than
# re-checked per file, per MIRROR-HUNT.md's sampling rule.
CONFIRMED_MIRRORS = [
    {
        "host": "mirrors.hust.edu.cn",
        "url_template": "https://mirrors.hust.edu.cn/golang/{filename}",
        "full_mirror": True,
        "region": "China (Wuhan) -- Huazhong University of Science and Technology",
        "protocols": ["https", "http"],
    },
]


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Blocks redirect-following so a 302-back-to-canonical isn't mistaken
    for an independent copy just because it "matches" (it's the same URL).
    """

    def redirect_request(self, *args, **kwargs):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def head(url: str, follow_redirects: bool = True):
    """Return (status, content_length_or_None). Never raises."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    opener = urllib.request.urlopen if follow_redirects else _NO_REDIRECT_OPENER.open
    try:
        with opener(req, timeout=TIMEOUT) as r:
            cl = r.headers.get("Content-Length")
            return r.status, (int(cl) if cl is not None else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def verify_and_cache(recheck: bool = False):
    """HEAD-confirm every CONFIRMED_MIRRORS host against SAMPLE_FILES,
    caching per-host results in CACHE_FILE. Returns {host: confirmed_bool}.
    """
    cache = {}
    if CACHE_FILE.exists() and not recheck:
        try:
            cache = json.loads(CACHE_FILE.read_text())
        except Exception:
            cache = {}

    hosts_to_check = [m for m in CONFIRMED_MIRRORS if recheck or m["host"] not in cache]

    canonical_sizes = {}
    if hosts_to_check:
        for fn in SAMPLE_FILES:
            status, size = head(DL_BASE + fn)
            canonical_sizes[fn] = size if status == 200 else None

    ok_hosts = {}
    for m in CONFIRMED_MIRRORS:
        host = m["host"]
        if host not in [h["host"] for h in hosts_to_check]:
            ok_hosts[host] = cache[host]["confirmed"]
            continue
        per_file = {}
        all_ok = True
        for fn in SAMPLE_FILES:
            url = m["url_template"].format(filename=fn)
            status, size = head(url, follow_redirects=False)
            match = bool(status == 200 and canonical_sizes.get(fn) and size == canonical_sizes[fn])
            per_file[fn] = {"status": status, "size": size, "matches_canonical": match}
            if not match:
                all_ok = False
        cache[host] = {"confirmed": all_ok, "sample_results": per_file}
        ok_hosts[host] = all_ok

    CACHE_FILE.write_text(json.dumps(cache, indent=2) + "\n")
    return ok_hosts


def apply_to_entries(entries, templates):
    """Append each confirmed template's URL to entry['mirrors'] if not
    already present, keeping the existing entries (and their order) first.
    Touches nothing but the `mirrors` list.
    """
    added = 0
    for e in entries:
        if "url" not in e or "mirrors" not in e or not isinstance(e["mirrors"], list):
            continue
        filename = e["url"].rsplit("/", 1)[-1]
        for tmpl in templates:
            new_url = tmpl.format(filename=filename)
            if new_url not in e["mirrors"]:
                e["mirrors"].append(new_url)
                added += 1
    return added


def main():
    recheck = "--recheck" in sys.argv
    ok_hosts = verify_and_cache(recheck=recheck)

    for m in CONFIRMED_MIRRORS:
        status = "confirmed" if ok_hosts.get(m["host"]) else "NOT confirmed (sample mismatch)"
        print(f"{m['host']}: {status}")

    templates = [
        m["url_template"]
        for m in CONFIRMED_MIRRORS
        if m.get("full_mirror") and ok_hosts.get(m["host"])
    ]
    if not templates:
        print("no confirmed full-mirror templates to apply; nothing changed")
        return

    targets = ["releases.json"] + sorted(p.name for p in HERE.glob("download_plan*.json"))
    for name in targets:
        path = HERE / name
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        added = apply_to_entries(data, templates)
        path.write_text(json.dumps(data, indent=2) + "\n")
        print(f"{name}: {len(data)} entries, {added} mirror URLs added")


if __name__ == "__main__":
    main()
