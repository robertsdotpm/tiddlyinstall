#!/usr/bin/env python3
"""Probe package-ecosystem mirror hosts for runtime file trees.

Two-stage, re-runnable, Python 3 stdlib only.

Stage A ("dirs"): for every host in mirror_hosts.json (built by
parse_sources.py from the official mirror lists named in the mirror-hunt
brief), HEAD a small set of well-known top-level directory names on both
http:// and https://. A strict per-request timeout and a global concurrency
cap keep this polite; a host is abandoned early after 3 connection-level
failures (DNS/connect/timeout -- NOT 404s, which are informative). A bogus
control path is HEADed on every host too, so a soft-200 catch-all (serves
200 for any path) is caught and the whole host is rejected rather than
misread as "has everything".

Stage B ("files"): for hosts with a promising directory, map a handful of
real catalog release entries (old/mid/new version, different os/arch) onto
that host's layout using known vendor-root -> mirror-dirname templates, and
HEAD them for a Content-Length match against the vendor's recorded size.

All HEAD results are cached in probe_cache.json (URL -> {status, length,
error}) so re-runs only do new work. Nothing here downloads a full runtime
file except the caller's separate hash-verification step (kept out of this
script; see confirm_and_apply.py).

Usage:
  python3 probe_mirror_networks.py dirs   [--min-sources N] [--limit N]
  python3 probe_mirror_networks.py files  [--min-hits N]
  python3 probe_mirror_networks.py report
"""
import concurrent.futures
import json
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).parent
CATALOG = HERE.parent
HOSTS_FILE = HERE / "mirror_hosts.json"
CACHE_FILE = HERE / "probe_cache.json"
DIRHITS_FILE = HERE / "candidate_dirs.json"
FILEHITS_FILE = HERE / "candidate_files.json"

UA = "installer-builder-catalog/1.0 (mirror hunt; polite; contact matthew@roberts.pm)"
TIMEOUT = 3.0
MAX_WORKERS = 10
MAX_CONN_FAILURES = 3
BOGUS_PATH = "__installer_builder_bogus_check_9f3a__/"

CANDIDATE_DIRS = [
    "python/", "pub/python/", "ruby/", "pub/ruby/", "gnu/gcc/", "CRAN/",
    "nodejs/", "node/", "nodejs-release/", "golang/", "go/",
    "rust-static/", "rustup/", "php/", "adoptium/", "Adoptium/", "zulu/",
    "llvm/", "llvm-releases/", "github-release/", "rubyinstaller/",
    "winlibs/", "dotnet/",
]

# runtime -> [(vendor url prefix, [candidate mirror dirnames to try])]
VENDOR_MAPPINGS = {
    "python": [("https://www.python.org/ftp/python/", ["python/", "pub/python/"])],
    "node": [("https://nodejs.org/dist/", ["nodejs/", "node/", "nodejs-release/"])],
    "ruby": [("https://cache.ruby-lang.org/pub/ruby/", ["ruby/", "pub/ruby/"])],
    "go": [("https://dl.google.com/go/", ["golang/", "go/"])],
    "rust": [("https://static.rust-lang.org/dist/", ["rust-static/dist/", "rustup/dist/"])],
    "php": [
        ("https://www.php.net/distributions/", ["php/", "php/distributions/"]),
    ],
    "dotnet": [("https://builds.dotnet.microsoft.com/dotnet/", ["dotnet/"])],
    "r": [("https://cran.r-project.org/", ["CRAN/"])],
    "java": [("https://cdn.azul.com/zulu/bin/", ["zulu/", "zulu/bin/"])],
    "cc": [
        ("https://ftp.gnu.org/gnu/gcc/", ["gnu/gcc/"]),
        ("https://releases.llvm.org/", ["llvm/", "llvm-releases/"]),
    ],
}
# github.com release assets: shared across java(adoptium)/ruby(rubyinstaller,
# ruby-builder)/cc(winlibs) via a curated "github-release/" style mirror.
GITHUB_DIRNAMES = {
    "ruby": ["rubyinstaller/", "github-release/"],
    "cc": ["winlibs/", "github-release/"],
    "java": ["github-release/"],
}


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {}


def save_cache(cache):
    tmp = CACHE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cache))
    tmp.replace(CACHE_FILE)


def head(url, cache):
    if url in cache:
        return cache[url]
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    result = {"status": None, "length": None, "error": None, "location": None}
    try:
        # Disable auto-redirect-follow so we can see the real Location and
        # reject mirrors that just bounce back to the vendor's own host.
        opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        with opener.open(req, timeout=TIMEOUT) as resp:
            result["status"] = resp.status
            result["length"] = resp.headers.get("Content-Length")
    except urllib.error.HTTPError as e:
        result["status"] = e.code
        result["location"] = e.headers.get("Location") if e.headers else None
    except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as e:
        result["error"] = str(e)[:200]
    except Exception as e:
        result["error"] = f"other:{e}"[:200]
    cache[url] = result
    return result


def is_conn_failure(result):
    return result["error"] is not None


def stage_dirs(min_sources, limit):
    hosts = json.loads(HOSTS_FILE.read_text())
    hosts = [h for h in hosts if len(h["sources"]) >= min_sources]
    hosts = [h for h in hosts if not h["host"].endswith(".onion")]
    if limit:
        hosts = hosts[:limit]
    print(f"probing {len(hosts)} hosts (min_sources={min_sources}) x {len(CANDIDATE_DIRS)} dirs x 2 schemes")

    cache = load_cache()
    lock_counter = {"done": 0}

    def probe_one_host(h):
        host = h["host"]
        out = {"host": host, "hits": {}, "soft200": [], "unreachable": []}
        for scheme in ("https", "http"):
            root = f"{scheme}://{host}/"
            failures = 0
            # control path first
            bogus = head(root + BOGUS_PATH, cache)
            soft200 = bogus["status"] == 200
            if soft200:
                out["soft200"].append(scheme)
            for d in CANDIDATE_DIRS:
                if failures >= MAX_CONN_FAILURES:
                    out["unreachable"].append(scheme)
                    break
                r = head(root + d, cache)
                if is_conn_failure(r):
                    failures += 1
                    continue
                if r["status"] == 200 and not soft200:
                    out["hits"][f"{scheme}:{d}"] = r
        return out

    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(probe_one_host, h): h for h in hosts}
        for fut in concurrent.futures.as_completed(futs):
            res = fut.result()
            lock_counter["done"] += 1
            if res["hits"]:
                results.append(res)
                print(f"  HIT {res['host']}: {sorted(res['hits'].keys())}")
            if lock_counter["done"] % 50 == 0:
                print(f"...{lock_counter['done']}/{len(hosts)} hosts done, cache={len(cache)}")
                save_cache(cache)

    save_cache(cache)
    DIRHITS_FILE.write_text(json.dumps(results, indent=1))
    print(f"done. {len(results)} hosts with a promising directory -> {DIRHITS_FILE}")


def sample_entries(releases, vendor_prefix, n=8):
    """Pick old/mid/new, varied os/arch entries whose url starts with vendor_prefix."""
    matching = [e for e in releases if e["url"].startswith(vendor_prefix)]
    if not matching:
        return []
    matching.sort(key=lambda e: (e.get("released") or "", e.get("version") or ""))
    seen_osarch = set()
    picks = []
    # spread across the sorted list
    step = max(1, len(matching) // (n * 3))
    for e in matching[::step]:
        key = (e.get("os"), e.get("arch"))
        if len(picks) >= n:
            break
        picks.append(e)
    # ensure oldest and newest included
    if matching[0] not in picks:
        picks.insert(0, matching[0])
    if matching[-1] not in picks:
        picks.append(matching[-1])
    return picks[:n + 2]


def stage_files(min_hits):
    if not DIRHITS_FILE.exists():
        print("run 'dirs' stage first"); return
    dir_results = json.loads(DIRHITS_FILE.read_text())
    cache = load_cache()

    releases_by_runtime = {}
    for rt in ["python", "node", "ruby", "go", "rust", "php", "dotnet", "r", "java", "cc"]:
        p = CATALOG / rt / "releases.json"
        if p.exists():
            releases_by_runtime[rt] = json.loads(p.read_text())

    file_results = []
    for hr in dir_results:
        host = hr["host"]
        hit_dirs = {k.split(":", 1)[1] for k in hr["hits"]}
        hit_schemes = {k.split(":", 1)[0] for k in hr["hits"]}
        for rt, mappings in VENDOR_MAPPINGS.items():
            releases = releases_by_runtime.get(rt, [])
            for vendor_prefix, dirnames in mappings:
                applicable_dirs = [d for d in dirnames if d in hit_dirs]
                if not applicable_dirs:
                    continue
                samples = sample_entries(releases, vendor_prefix)
                if not samples:
                    continue
                for dirname in applicable_dirs:
                    checks = []
                    for e in samples:
                        suffix = e["url"][len(vendor_prefix):]
                        for scheme in hit_schemes:
                            curl_url = f"{scheme}://{host}/{dirname}{suffix}"
                            r = head(curl_url, cache)
                            match = (r["status"] == 200 and e.get("size") and
                                     r["length"] and int(r["length"]) == e["size"])
                            checks.append({
                                "entry_url": e["url"], "mirror_url": curl_url,
                                "vendor_size": e.get("size"), "mirror_length": r["length"],
                                "status": r["status"], "match": match,
                            })
                    ok = sum(1 for c in checks if c["match"])
                    if ok >= min_hits:
                        file_results.append({
                            "host": host, "runtime": rt, "dirname": dirname,
                            "vendor_prefix": vendor_prefix, "checked": len(checks),
                            "matched": ok, "checks": checks,
                        })
                        print(f"  CONFIRMED-CANDIDATE {host} {rt} {dirname}: {ok}/{len(checks)} size matches")
        save_cache(cache)

    FILEHITS_FILE.write_text(json.dumps(file_results, indent=1))
    print(f"done. {len(file_results)} host/runtime/dirname combos with >= {min_hits} size-matched samples -> {FILEHITS_FILE}")


def stage_report():
    if not FILEHITS_FILE.exists():
        print("run 'files' stage first"); return
    data = json.loads(FILEHITS_FILE.read_text())
    for d in data:
        print(f"{d['host']:40s} {d['runtime']:8s} {d['dirname']:20s} {d['matched']}/{d['checked']}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    cmd = sys.argv[1]
    args = sys.argv[2:]

    def getarg(name, default, cast=int):
        if name in args:
            return cast(args[args.index(name) + 1])
        return default

    if cmd == "dirs":
        stage_dirs(getarg("--min-sources", 2), getarg("--limit", 0))
    elif cmd == "files":
        stage_files(getarg("--min-hits", 6))
    elif cmd == "report":
        stage_report()
    else:
        print(__doc__); sys.exit(1)
