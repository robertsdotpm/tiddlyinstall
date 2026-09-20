#!/usr/bin/env python3
"""Mirror hunt (2026-09-17): add confirmed extra mirrors to the dotnet catalog.

Re-runnable and idempotent. Post-processes releases.json and every
download_plan*.json in this folder, appending confirmed mirror URLs to each
entry's "mirrors" list (existing entries kept first, no duplicates). Never
touches url/runtime/os/arch/version/variant/checksum.

Two mirrors confirmed this pass, see NOTES.md "Mirror hunt (2026-09-17)" for
the full writeup and rejected candidates:

1. dotnetcli.azureedge.net -- Microsoft's OWN older CDN hostname for the same
   "dotnetcli" Azure Storage account that builds.dotnet.microsoft.com and
   dotnetcli.blob.core.windows.net front. Publicly announced as being
   retired (the azureedge.net / Edgio shutdown), but empirically still
   live: it now resolves through Azure Traffic Manager to an Azure Front
   Door endpoint instead of the old Edgio CDN, and serves byte-identical
   content -- confirmed by HEAD across 7 files spanning 1.0.0 to 10.0.100,
   Runtime/Sdk/WindowsDesktop/aspnetcore, win/linux/macos, amd64/arm64, and
   by a full download + sha512 match for dotnet-runtime-2.1.8-win-arm64.zip.
   https only (plain http 307-redirects to https on the same host).
   Since HEAD-sampling showed a full 1:1 mirror of the same layout, this is
   applied to every entry whose url starts with the builds.dotnet host,
   same population as the existing confirmed mirror -- no per-entry network
   check needed (this matches the "whole sample matches" rule for a full
   mirror, not the "partial" rule).

2. The Internet Archive Wayback Machine, for entries that otherwise have
   ZERO mirrors: 117 `dotnet` releases served from
   download.visualstudio.microsoft.com (almost all windowsdesktop-runtime
   3.1.x .exe installers, plus a handful of 5.0.x macOS .pkg files) and all
   12 `dotnet-framework` entries served from download.microsoft.com. These
   live on separate, non-"dotnetcli" Azure storage; there is no equivalent
   path on builds.dotnet.microsoft.com (confirmed 404 on the guessed
   WindowsDesktop/<ver>/<file> path), so mirror #1 doesn't reach them.
   Template: https://web.archive.org/web/2id_/<original url> (redirects to
   the nearest raw capture, un-rewritten). Wayback coverage is partial by
   nature of the brief, so every candidate entry is HEAD-checked
   individually (results cached in wayback_cache.json beside this script),
   comparing the replay's x-archive-orig-content-length against the
   entry's recorded size (entries with size: null are accepted on a 200
   alone -- a full download+hash still confirmed one such case,
   windowsdesktop-runtime-3.1.32-win-x64.exe, sha512 match).
"""
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
CACHE_FILE = HERE / "wayback_cache.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

BUILDS_HOST = "builds.dotnet.microsoft.com"
BUILDS_PREFIX = f"https://{BUILDS_HOST}/dotnet/"
AZUREEDGE_PREFIX = "https://dotnetcli.azureedge.net/dotnet/"

WAYBACK_HOSTS = {"download.visualstudio.microsoft.com", "download.microsoft.com"}
WAYBACK_TEMPLATE = "https://web.archive.org/web/2id_/{url}"

MAX_WORKERS = 3  # this sandbox's egress is shared with sibling jobs; higher
                 # concurrency was observed to produce spurious connection
                 # resets/timeouts against archive.org, not real rejections
HEAD_TIMEOUT = 30
RETRIES = 3


def azureedge_mirror(url):
    if url.startswith(BUILDS_PREFIX):
        return AZUREEDGE_PREFIX + url[len(BUILDS_PREFIX):]
    return None


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {}


def save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


def head_wayback_once(url, expected_size):
    """HEAD the Wayback replay for `url`. Returns (ok, note, transient)."""
    replay = WAYBACK_TEMPLATE.format(url=url)
    req = urllib.request.Request(replay, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=HEAD_TIMEOUT) as resp:
            final_url = resp.geturl()
            if "web.archive.org/web/" not in final_url:
                return False, f"redirected off wayback to {final_url}", False
            orig_len = resp.headers.get("x-archive-orig-content-length")
            length = orig_len or resp.headers.get("Content-Length")
            if expected_size is not None and length is not None:
                if int(length) != expected_size:
                    return False, f"size mismatch: wayback {length} vendor {expected_size}", False
            return True, f"capture ok, replay={final_url}", False
    except urllib.error.HTTPError as e:
        # A real answer from archive.org (e.g. no capture at all -> 404) is
        # a definitive negative, not a transient failure.
        return False, f"HTTP {e.code}", False
    except Exception as e:
        # Connection refused/reset/timeout: this sandbox's shared egress
        # produces these under load even for URLs that work when retried
        # alone. Treat as transient -- don't poison the cache with it.
        return False, f"error: {e}", True


def head_wayback(url, expected_size):
    """Returns (ok, note, still_transient). still_transient=True means every
    attempt failed with a transient network error -- caller must NOT cache
    this as a definitive negative, or a congested run would permanently
    mark a real mirror as absent."""
    note = "no attempt"
    for attempt in range(RETRIES):
        ok, note, transient = head_wayback_once(url, expected_size)
        if ok or not transient:
            return ok, note, False
        time.sleep(1.5 * (attempt + 1))
    return False, note, True


def check_wayback_urls(urls_with_sizes, cache):
    """urls_with_sizes: dict url -> expected size (or None). Mutates cache."""
    todo = [u for u in urls_with_sizes if u not in cache]
    if not todo:
        return
    print(f"  HEAD-checking {len(todo)} candidate(s) against Wayback ({MAX_WORKERS} concurrent, up to {RETRIES}x retry)...", flush=True)
    skipped = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(head_wayback, u, urls_with_sizes[u]): u for u in todo}
        for fut in concurrent.futures.as_completed(futs):
            u = futs[fut]
            ok, note, still_transient = fut.result()
            if still_transient:
                # Leave uncached so a re-run retries it instead of recording
                # a permanent false negative caused by network congestion.
                skipped += 1
                continue
            cache[u] = {
                "confirmed": ok,
                "note": note,
                "checked": date.today().isoformat(),
                "mirror": WAYBACK_TEMPLATE.format(url=u) if ok else None,
            }
            print(f"    {'OK' if ok else 'no'}: {u.rsplit('/', 1)[-1]} ({note})", flush=True)
    if skipped:
        print(f"  {skipped} candidate(s) left unresolved after retries (network congestion) -- re-run to retry", flush=True)


def add_mirror(entry, mirror_url):
    mirrors = entry.setdefault("mirrors", [])
    if mirror_url not in mirrors:
        mirrors.append(mirror_url)


def process_file(path, cache):
    data = json.loads(path.read_text())
    if not isinstance(data, list):
        return 0
    changed = 0

    # Pass 1: full-mirror substitution (no network needed, sample already
    # confirmed the whole builds.dotnet.microsoft.com layout is mirrored).
    for entry in data:
        url = entry.get("url", "")
        m = azureedge_mirror(url)
        if m and m not in entry.get("mirrors", []):
            add_mirror(entry, m)
            changed += 1

    # Pass 2: Wayback, only for the hosts with zero existing mirror coverage.
    candidates = {}
    for entry in data:
        url = entry.get("url", "")
        host = urlsplit(url).netloc
        if host in WAYBACK_HOSTS:
            candidates[url] = entry.get("size")
    check_wayback_urls(candidates, cache)
    for entry in data:
        url = entry.get("url", "")
        c = cache.get(url)
        if c and c.get("confirmed") and c["mirror"] not in entry.get("mirrors", []):
            add_mirror(entry, c["mirror"])
            changed += 1

    path.write_text(json.dumps(data, indent=2) + "\n")
    return changed


def main():
    cache = load_cache()
    targets = [HERE / "releases.json"] + sorted(HERE.glob("download_plan*.json"))
    total = 0
    for path in targets:
        if not path.exists():
            continue
        print(f"Processing {path.name}...")
        n = process_file(path, cache)
        print(f"  {n} mirror(s) added")
        total += n
        save_cache(cache)  # persist after every file in case a later one errors
    print(f"Total mirrors added across {len(targets)} file(s): {total}")


if __name__ == "__main__":
    sys.exit(main())
