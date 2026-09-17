#!/usr/bin/env python3
"""Mirror hunt round 2 for Nim: OS/ports distro caches (per MIRROR-HUNT-2.md).

Re-runnable, Python 3 stdlib. Does NOT edit releases.json/download_plan.json
directly -- it only ever prints/writes a jsonl of updates for
`catalog/tools/add_mirrors.py` to apply under its lock (per MIRROR-HUNT-2.md:
"Write only via add_mirrors.py"). Caches HEAD results in
extra_mirrors_cache.json so re-runs are cheap.

Result summary (2026-09-17), see NOTES.md for the full write-up:

- **Gentoo distfiles** (distfiles.gentoo.org) -- hash-addressed
  (`distfiles/<blake2b(filename)[:2]>/<filename>`), confirmed via
  gentoo/gentoo's dev-lang/nim Manifest. Only the two versions currently
  in the Gentoo tree are live (portage prunes distfiles for removed
  ebuilds): nim-2.2.10.tar.xz, nim-2.2.12.tar.xz.
- **FreeBSD ports distfiles** (distcache.freebsd.org/ports-distfiles/) --
  flat layout (no DIST_SUBDIR set in lang/nim's Makefile). https fails
  from this environment (as with every other runtime hunted so far --
  Fastly SNI/cert issue); http works. Only the current port version is
  kept: nim-2.2.12.tar.xz.
- **MacPorts distfiles** (distfiles.macports.org/nim/) -- confirmed via
  lang/nim's Portfile (macports-ports repo). Only the current Portfile
  version, which lags upstream: nim-2.2.6.tar.xz.
- **Nix tarballs.nixos.org fallback cache** -- hash-addressed
  (`sha256/<hex>`, redirecting to a canonical `sha512/<hex>` URL), keyed
  by exactly the file's sha256 (matches our vendor checksum by
  construction, since that's the lookup key). Swept all 57 source
  entries that have a vendor sha256; 15 hit. This is by far the best
  historical-version coverage of the four, since Hydra has built Nim
  source derivations across many nixpkgs channel generations, unlike the
  three "current version only" distro caches above.
- **China general-purpose mirrors** (TUNA, USTC, NJU, ISCAS, Aliyun,
  Huawei Cloud) -- none carry Nim specifically:
  - USTC, ISCAS, Aliyun: clean 404 for `/nim/` (real difference from a
    known-good path on the same host -- rejected on evidence).
  - Huawei Cloud: `/nim/` returns 200, but so does a bogus
    `/totally-bogus-pkg-xyz123/` path -- it's a client-side-routed portal
    that 200s every path (soft-200 catch-all, same pattern as the
    SourceForge case flagged in round 1). Rejected.
  - NJU: `/nim/` 302s to itself, but so does the bogus-path control AND
    `/golang/` (a real, already-confirmed mirror from the go/ catalog) --
    every subpath 302s identically, so HEAD/redirect behavior can't
    distinguish real from fake here. Rejected for lack of a usable
    signal, not asserted absent.
  - TUNA: hard 403 "denied access" page for every path tried, matching
    go/NOTES.md's prior observation of an anti-abuse block on this
    environment's egress IP. Inconclusive, not rejected on evidence --
    worth retrying from a different network.
- **GitHub nim-lang/Nim release assets**: dead end from Part 1 already --
  `gh api repos/nim-lang/Nim/releases` returns `[]`; there are no assets
  to mirror.
- **Scoop** (ScoopInstaller/Main bucket/nim.json): sha256 for the current
  Windows zips matches our vendor checksum exactly, but it's a
  corroboration of the *same* nim-lang.org URL, not an independent host,
  and only tracks the latest version (2.2.12, already vendor-checksummed)
  -- not added as a mirror or corroboration since it adds no information.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parent
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/124.0.0.0 Safari/537.36 installer-builder-catalog/1.0")
TIMEOUT = 20
CACHE_PATH = HERE / "extra_mirrors_cache.json"


def load_cache():
    if CACHE_PATH.exists():
        return json.loads(CACHE_PATH.read_text())
    return {}


def save_cache(cache):
    CACHE_PATH.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


def head(url, cache):
    if url in cache:
        return tuple(cache[url])
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            cl = r.headers.get("Content-Length")
            result = (r.status, int(cl) if cl else None)
    except urllib.error.HTTPError as e:
        result = (e.code, None)
    except Exception:
        result = (None, None)
    cache[url] = list(result)
    return result


def get_raw(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/vnd.github.raw"})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", "replace")


def gh_raw(path_url):
    """gh api ... -H Accept:raw, used for private/rate-limited-safe GitHub reads."""
    out = subprocess.run(
        ["gh", "api", path_url, "-H", "Accept: application/vnd.github.raw"],
        capture_output=True, text=True, check=True, timeout=TIMEOUT,
    )
    return out.stdout


def load_releases():
    return json.loads((CATALOG / "nim" / "releases.json").read_text())


def source_entries(releases):
    return [e for e in releases if e["kind"] == "source" and e["format"] == "tar.xz"]


# --------------------------------------------------------------- Gentoo ---

def gentoo_manifest():
    text = gh_raw("repos/gentoo/gentoo/contents/dev-lang/nim/Manifest")
    out = {}
    for line in text.splitlines():
        parts = line.split()
        if not parts or parts[0] != "DIST":
            continue
        fn, size = parts[1], int(parts[2])
        hashes = {}
        i = 3
        while i < len(parts) - 1:
            hashes[parts[i].lower()] = parts[i + 1]
            i += 2
        out[fn] = {"size": size, "hashes": hashes}
    return out


def check_gentoo(releases, cache):
    manifest = gentoo_manifest()
    updates = []
    for e in source_entries(releases):
        fn = e["url"].rsplit("/", 1)[-1]
        info = manifest.get(fn)
        if not info or info["size"] != e.get("size"):
            continue
        h = hashlib.blake2b(fn.encode()).hexdigest()[:2]
        mirror = f"https://distfiles.gentoo.org/distfiles/{h}/{fn}"
        status, size = head(mirror, cache)
        if status == 200 and size == e["size"]:
            sha512 = info["hashes"].get("sha512")
            evidence = f"Gentoo distfiles (dev-lang/nim Manifest), hash-addressed path distfiles/<blake2b(filename)[:2]>/<filename>; HEAD size match ({size} bytes) 2026-09-17"
            if sha512 and sha512 == info["hashes"].get("sha512"):
                evidence += f"; Manifest SHA512 {sha512[:16]}... available as corroboration"
            updates.append({"folder": "nim", "url": e["url"], "mirror": mirror, "evidence": evidence})
    return updates


# -------------------------------------------------------------- FreeBSD ---

def freebsd_distinfo():
    text = gh_raw("repos/freebsd/freebsd-ports/contents/lang/nim/distinfo")
    sizes, hashes = {}, {}
    for line in text.splitlines():
        m = re.match(r"SHA256 \((.+)\) = ([0-9a-f]{64})", line)
        if m:
            hashes[m.group(1)] = m.group(2)
        m = re.match(r"SIZE \((.+)\) = (\d+)", line)
        if m:
            sizes[m.group(1)] = int(m.group(2))
    return sizes, hashes


def check_freebsd(releases, cache):
    sizes, hashes = freebsd_distinfo()
    updates = []
    for e in source_entries(releases):
        fn = e["url"].rsplit("/", 1)[-1]
        if fn not in sizes:
            continue
        mirror = f"http://distcache.freebsd.org/ports-distfiles/{fn}"
        status, size = head(mirror, cache)
        if status == 200 and size == sizes[fn]:
            ck = e.get("checksum") or {}
            match_note = ""
            if ck.get("algo") == "sha256" and hashes.get(fn) == ck.get("value"):
                match_note = "; distinfo SHA256 matches our vendor checksum exactly"
            updates.append({
                "folder": "nim", "url": e["url"], "mirror": mirror,
                "evidence": f"FreeBSD ports distcache (distcache.freebsd.org/ports-distfiles/), "
                            f"confirmed via lang/nim distinfo; HEAD size match over http "
                            f"(https fails from this environment, SNI/cert issue) 2026-09-17{match_note}",
            })
    return updates


# ------------------------------------------------------------- MacPorts ---

def macports_portfile():
    text = gh_raw("repos/macports/macports-ports/contents/lang/nim/Portfile")
    m_ver = re.search(r"^version\s+(\S+)", text, re.MULTILINE)
    m_sha = re.search(r"sha256\s+([0-9a-f]{64})", text)
    return m_ver.group(1) if m_ver else None, m_sha.group(1) if m_sha else None


def check_macports(releases, cache):
    version, sha256 = macports_portfile()
    if not version:
        return []
    updates = []
    for e in source_entries(releases):
        if e["version"] != version:
            continue
        fn = e["url"].rsplit("/", 1)[-1]
        mirror = f"https://distfiles.macports.org/nim/{fn}"
        status, size = head(mirror, cache)
        if status == 200 and size == e.get("size"):
            ck = e.get("checksum") or {}
            match_note = ""
            if sha256 and ck.get("value") == sha256:
                match_note = "; Portfile sha256 matches our vendor checksum exactly"
            updates.append({
                "folder": "nim", "url": e["url"], "mirror": mirror,
                "evidence": f"MacPorts distfiles (distfiles.macports.org/nim/), confirmed via "
                            f"lang/nim Portfile (macports-ports); HEAD size match 2026-09-17{match_note}",
            })
    return updates


# -------------------------------------------------------------------Nix ---

def check_nix(releases, cache):
    updates = []
    entries = [e for e in source_entries(releases) if e.get("checksum", {}) and e["checksum"].get("algo") == "sha256"]

    def probe(e):
        h = e["checksum"]["value"]
        url = f"https://tarballs.nixos.org/sha256/{h}"
        status, _ = head(url, cache)
        return e, url, status

    with ThreadPoolExecutor(max_workers=10) as ex:
        for e, url, status in ex.map(probe, entries):
            if status in (200, 301, 302):
                updates.append({
                    "folder": "nim", "url": e["url"], "mirror": url,
                    "evidence": f"Nix tarballs.nixos.org fallback cache, hash-addressed "
                                f"(sha256/<hex>, redirects to canonical sha512/<hex>); key IS "
                                f"the file's sha256 so this is confirmed-by-construction once "
                                f"live; HEAD/redirect confirmed 2026-09-17. Hash-verified in "
                                f"full for nim-0.17.2.tar.xz and nim-1.6.20.tar.xz (both exact "
                                f"sha256 matches, deleted after).",
                })
    return updates


# ------------------------------------------------------------------ main --

def main():
    cache = load_cache()
    releases = load_releases()

    updates = []
    print("Gentoo distfiles ...")
    g = check_gentoo(releases, cache)
    print(f"  {len(g)} matches")
    updates += g

    print("FreeBSD ports distcache ...")
    f = check_freebsd(releases, cache)
    print(f"  {len(f)} matches")
    updates += f

    print("MacPorts distfiles ...")
    m = check_macports(releases, cache)
    print(f"  {len(m)} matches")
    updates += m

    print("Nix tarballs.nixos.org ...")
    n = check_nix(releases, cache)
    print(f"  {len(n)} matches")
    updates += n

    save_cache(cache)

    out_path = HERE / "mirror_updates.jsonl"
    with open(out_path, "w") as fh:
        for u in updates:
            fh.write(json.dumps(u) + "\n")
    print(f"wrote {len(updates)} updates to {out_path}")
    print("apply with: python3 ../tools/add_mirrors.py mirror_updates.jsonl")


if __name__ == "__main__":
    main()
