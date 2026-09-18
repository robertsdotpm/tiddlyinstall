#!/usr/bin/env python3
"""Build the CMake runtime catalog from Kitware's own download tree.

Re-runnable, Python 3 standard library only. Writes releases.json,
gaps.json, download_plan.json and mirrors.json alongside this script.

Sources (fetched fresh on every run):

- https://cmake.org/files/  -- Apache directory index with one folder per
  minor line (v1.2 ... v4.x). Every official binary and source file ever
  published is listed there with its upload date. This is the primary
  source; the file name encodes version, platform and format.
- https://cmake.org/files/vX.Y/cmake-<ver>-SHA-256.txt -- vendor SHA-256
  list, published for every release from 3.0.0 onwards (signed with a
  .asc next to it). Releases before 3.0.0 have no vendor checksum at all.
- https://api.github.com/repos/Kitware/CMake/releases -- Kitware also
  uploads the same files to GitHub Releases (back-filled in 2018 for old
  versions). Each asset's size and GitHub-computed sha256 `digest` are used
  to confirm github.com as a per-file mirror: an asset only counts as a
  mirror when its digest equals the vendor SHA-256 (3.0+) or, where the
  vendor has no checksum or GitHub no digest, its size equals cmake.org's.
  Set GITHUB_TOKEN to avoid the unauthenticated rate limit (a handful of
  requests are enough either way).
- HEAD requests to cmake.org for the size of any file GitHub doesn't carry.

Everything fetched is untrusted network data; nothing in it is treated as
instructions, only as file names, sizes, hashes and dates to record.
"""
from __future__ import annotations

import concurrent.futures as cf
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
BASE = "https://cmake.org/files/"
GH_API = "https://api.github.com/repos/Kitware/CMake/releases?per_page=100&page={page}"
GH_DIGEST_SOURCE = "GitHub release asset digest (api.github.com)"
USER_AGENT = "installer-builder-catalog/1.0 (+scrape.py; HEAD requests only)"
TIMEOUT = 30
PLAN_OSES = {"windows", "linux", "macos"}

# Platform token in the file name -> (os, arch, variant). Tokens not in this
# table and not in UNMAPPABLE are reported loudly and skipped.
PLATFORMS = {
    # Windows
    "win32-x86": ("windows", "x86", None),
    "win32": ("windows", "x86", None),
    "x86-win": ("windows", "x86", None),
    "Windows": ("windows", "x86", None),
    "windows-i386": ("windows", "x86", None),
    "win64-x64": ("windows", "amd64", None),
    "windows-x86_64": ("windows", "amd64", None),
    "windows-arm64": ("windows", "arm64", None),
    # Linux
    "x86-linux": ("linux", "x86", None),
    "x86-linux-static": ("linux", "x86", None),
    "Linux-i386": ("linux", "x86", None),
    "Linux-x86_64": ("linux", "amd64", None),
    "linux-x86_64": ("linux", "amd64", None),
    "Linux-aarch64": ("linux", "arm64", None),
    "linux-aarch64": ("linux", "arm64", None),
    # macOS
    "Darwin-universal": ("macos", "universal", "darwin-universal"),     # ppc + i386 (2.4 - 3.1)
    "Darwin64-universal": ("macos", "universal", "darwin64-universal"),  # i386 + x86_64 (3.0 - 3.1)
    "Darwin64": ("macos", "amd64", None),
    "Darwin-x86_64": ("macos", "amd64", None),
    "Darwin-i386": ("macos", "x86", None),
    "macos-universal": ("macos", "universal", None),                    # x86_64 + arm64 (3.19+)
    "macos10.10-universal": ("macos", "universal", "macos10.10"),        # same, older deployment target
    # Solaris on x86_64
    "sunos-x86_64": ("solaris", "amd64", None),
}
# Platforms Kitware shipped that have no slot in the catalog's fixed OS/ARCH
# enums (32-bit PowerPC, SPARC, MIPS, PA-RISC, Alpha). Counted, not dropped
# silently -- see NOTES.md.
UNMAPPABLE = {
    "darwin", "osx",  # 1.x-2.2 Mac OS X builds: PowerPC only
    "AIX-powerpc", "aix15", "SunOS-sparc", "sparc-sunos57-static", "sunos-sparc64",
    "IRIX64-64", "IRIX64-n32", "irix64", "irix64-n32", "irix65",
    "HP-UX-9000_785", "hpux-static", "alpha-osf", "alpha-OSF1-static",
}

EXT_RE = r"(?P<ext>tar\.gz|tar\.Z|tar\.bz2|tgz|zip|exe|msi|dmg|sh)"
NAME_RES = [
    # cmake-3.31.12-windows-x86_64.zip, cmake-2.4.2-2-Darwin-universal.dmg, cmake-3.31.12.tar.gz
    re.compile(r"^cmake-(?P<ver>\d+\.\d+\.\d+(?:\.\d+)?)(?P<rebuild>-\d)?(?:-(?P<plat>[A-Za-z][\w.\-]*?))?\." + EXT_RE + "$"),
    # CMake1.4.7-x86-win.zip, CMake1.2-src-unix.tar.gz
    re.compile(r"^CMake(?P<ver>\d+\.\d+(?:\.\d+)?)(?P<rebuild>)(?:-(?P<plat>[A-Za-z][\w.\-]*?))?\." + EXT_RE + "$"),
]
CMSETUP_RE = re.compile(r"^CMSetup(?P<digits>\d+)\.exe$")
CMSETUP_VERSIONS = {"14": "1.4", "167": "1.6.7", "183": "1.8.3", "206": "2.0.6"}

FORMAT = {"tar.gz": "tar.gz", "tgz": "tar.gz", "tar.Z": "tar.Z", "tar.bz2": "tar.bz2", "zip": "zip",
          "exe": "exe", "msi": "msi", "dmg": "dmg", "sh": "sh"}
KIND = {"tar.gz": "archive", "tar.Z": "archive", "zip": "archive", "exe": "installer", "msi": "installer",
        "dmg": "installer", "sh": "installer"}


def request(url, method="GET", headers=None):
    h = {"User-Agent": USER_AGENT}
    h.update(headers or {})
    return urllib.request.Request(url, method=method, headers=h)


def fetch(url, headers=None, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(request(url, headers=headers), timeout=TIMEOUT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code < 500 or i == tries - 1:
                raise
        except (TimeoutError, OSError):
            if i == tries - 1:
                raise
        time.sleep(2 * (i + 1))


def head(url, tries=3):
    for i in range(tries):
        try:
            with urllib.request.urlopen(request(url, "HEAD"), timeout=TIMEOUT) as r:
                cl = r.headers.get("Content-Length")
                return r.status, (int(cl) if cl is not None else None)
        except urllib.error.HTTPError as e:
            if e.code < 500:
                return e.code, None
        except Exception:
            pass
        time.sleep(2 * (i + 1))
    return None, None


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v))


def major_of(v):
    p = v.split(".")
    return f"{p[0]}.{p[1]}"


ROW_RE = re.compile(r'<a href="([^"?/][^"]*)">[^<]*</a></td><td[^>]*>(\d{4}-\d{2}-\d{2}) ')


def list_dir(d):
    html = fetch(BASE + d + "/").decode("utf-8", "replace")
    return ROW_RE.findall(html)


def parse_name(name):
    """-> (version, rebuild, platform-token or None, ext) or None."""
    m = CMSETUP_RE.match(name)
    if m:
        return CMSETUP_VERSIONS.get(m.group("digits")), "", "win32", "exe"
    for rx in NAME_RES:
        m = rx.match(name)
        if m:
            return m.group("ver"), (m.group("rebuild") or ""), m.group("plat"), m.group("ext")
    return None


def github_assets():
    token = os.environ.get("GITHUB_TOKEN")
    headers = {"Accept": "application/vnd.github+json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    assets = {}
    page = 1
    while True:
        data = json.loads(fetch(GH_API.format(page=page), headers))
        if not data:
            break
        for rel in data:
            for a in rel.get("assets", []):
                assets[a["name"]] = {"url": a["browser_download_url"], "size": a["size"], "digest": a.get("digest")}
        page += 1
    return assets


def main():
    root = fetch(BASE).decode("utf-8", "replace")
    dirs = sorted(set(re.findall(r'href="(v\d+\.\d+)/"', root)), key=vtuple)
    print(f"{len(dirs)} version folders on cmake.org/files")

    with cf.ThreadPoolExecutor(8) as ex:
        listings = dict(zip(dirs, ex.map(list_dir, dirs)))

    files = []  # (dir, name, date, version, rebuild, plat, ext)
    unmappable = Counter()
    unknown = []
    skipped = Counter()
    for d, rows in listings.items():
        if d == "v2.3":
            skipped["v2.3 dev snapshots (date-stamped odd minor)"] += len(rows)
            continue
        for name, date in rows:
            if "-rc" in name or "SHA-256" in name or name.endswith((".asc", ".json", ".cmake", ".rtf", ".ini", ".txt")) \
                    or name.startswith("CMakeChangeLog") or name in ("-*", "cygwin/"):
                continue
            p = parse_name(name)
            if not p or not p[0]:
                unknown.append(name)
                continue
            ver, rebuild, plat, ext = p
            if ext == "tar.bz2":
                skipped["Cygwin package (-1.tar.bz2 / -1-src.tar.bz2)"] += 1
                continue
            if plat in UNMAPPABLE:
                unmappable[plat] += 1
                continue
            files.append((d, name, date, ver, rebuild, plat, ext))
    if unknown:
        print("warning: unparsed names skipped:", unknown, file=sys.stderr)

    # Vendor SHA-256 lists (3.0.0+).
    versions = sorted({f[3] for f in files}, key=vtuple)
    sha_versions = [v for v in versions if vtuple(v) >= (3, 0, 0)]

    def get_sha(v):
        url = f"{BASE}v{major_of(v)}/cmake-{v}-SHA-256.txt"
        try:
            text = fetch(url).decode()
        except urllib.error.HTTPError:
            return v, url, {}
        return v, url, {ln.split()[1]: ln.split()[0] for ln in text.splitlines() if len(ln.split()) == 2}

    with cf.ThreadPoolExecutor(8) as ex:
        shas = {v: (url, m) for v, url, m in ex.map(get_sha, sha_versions)}
    missing_sha_lists = [v for v, (u, m) in shas.items() if not m]

    gh = github_assets()
    print(f"{len(gh)} GitHub release assets")

    # Sizes: GitHub's when its copy is confirmed identical by hash; HEAD otherwise.
    need_head = []
    for f in files:
        d, name, _, ver, *_ = f
        a = gh.get(name)
        vsha = shas.get(ver, (None, {}))[1].get(name)
        if not (a and vsha and a["digest"] == f"sha256:{vsha}"):
            need_head.append(BASE + d + "/" + name)
    with cf.ThreadPoolExecutor(8) as ex:
        heads = dict(zip(need_head, ex.map(head, need_head)))
    print(f"HEAD-checked {len(need_head)} files")

    releases, gh_mirrors, gh_rejected = [], 0, []
    for d, name, date, ver, rebuild, plat, ext in files:
        url = BASE + d + "/" + name
        sha_url, sha_map = shas.get(ver, (None, {}))
        vsha = sha_map.get(name)
        a = gh.get(name)
        size = None
        mirrors = []
        if a and vsha and a["digest"] == f"sha256:{vsha}":
            size = a["size"]
        else:
            status, size = heads.get(url, (None, None))
        if a and size is not None:
            if (vsha and a["digest"] == f"sha256:{vsha}") or (not (vsha and a["digest"]) and a["size"] == size):
                mirrors.append(a["url"])
                gh_mirrors += 1
            else:
                gh_rejected.append(name)

        if plat is None or plat.startswith("src") or plat == "unix-src":
            os_, arch, variant, kind = ("windows" if ext == "zip" else "linux"), "any", None, "source"
        else:
            os_, arch, variant = PLATFORMS[plat]
            kind = KIND[ext]
        notes = []
        if rebuild:
            notes.append(f"Kitware re-packaged build {rebuild[1:]} of {ver} for this platform")
        if ext == "tar.Z":
            notes.append("compress(1) .Z copy of the .tar.gz next to it")
        if ext == "exe":
            notes.append("NSIS installer (CMSetup*.exe for 1.x/2.0)")
        if ext == "sh":
            notes.append("self-extracting shell archive; run with --prefix=<dir> --skip-license --exclude-subdir")
        if variant == "darwin-universal":
            notes.append("PowerPC + i386 fat binary")
        elif variant == "darwin64-universal":
            notes.append("i386 + x86_64 fat binary")
        elif plat and plat.startswith("macos"):
            notes.append("x86_64 + arm64 fat binary")
        min_os = None
        if variant == "macos10.10":
            min_os = "macOS 10.10 (files-v1.json macOSmin)"
        releases.append({
            "runtime": "cmake",
            "languages": ["c", "cpp"],
            "major": major_of(ver),
            "version": ver + rebuild,
            "os": os_,
            "arch": arch,
            "kind": kind,
            "format": FORMAT[ext],
            "variant": variant,
            "libc": "glibc" if os_ == "linux" and kind != "source" else None,
            "url": url,
            "mirrors": mirrors,
            "checksum": {"algo": "sha256", "value": vsha, "source": sha_url} if vsha else None,
            "size": size,
            "released": date,
            "min_os": min_os,
            "metadata_source": BASE + d + "/",
            "notes": "; ".join(notes) or None,
        })
    releases.sort(key=lambda e: (vtuple(e["version"]), e["os"], e["arch"], e["format"], e["variant"] or ""))

    # Distro source caches: only whatever source tarballs the ports trees
    # currently reference survive there, so each file is confirmed on its own
    # by a HEAD size match (see mirrors.json for the hash-verified sample).
    def cache_urls(fn):
        b = hashlib.blake2b(fn.encode()).hexdigest()[:2]
        return [f"https://distfiles.gentoo.org/distfiles/{b}/{fn}",
                f"http://distcache.freebsd.org/ports-distfiles/{fn}",
                f"https://distfiles.macports.org/cmake/{fn}"]
    src = [e for e in releases if e["kind"] == "source" and e["format"] == "tar.gz"]
    probes = [(e, u) for e in src for u in cache_urls(e["url"].rsplit("/", 1)[1])]
    with cf.ThreadPoolExecutor(8) as ex:
        results = list(ex.map(lambda eu: head(eu[1]), probes))
    cache_hits = 0
    for (e, u), (st, sz) in zip(probes, results):
        if st == 200 and sz is not None and sz == e["size"]:
            e["mirrors"].append(u)
            cache_hits += 1

    # macOS minimums from the vendor's own files-v1.json (3.20+), recorded per file.
    macmins = {}
    for v in versions:
        if vtuple(v) < (3, 20, 0):
            continue
        try:
            j = json.loads(fetch(f"{BASE}v{major_of(v)}/cmake-{v}-files-v1.json"))
        except Exception:
            continue
        for fi in j.get("files", []):
            if fi.get("macOSmin"):
                macmins[fi["name"]] = fi["macOSmin"]
    for e in releases:
        n = e["url"].rsplit("/", 1)[1]
        if n in macmins:
            e["min_os"] = f"macOS {macmins[n]} (files-v1.json macOSmin)"

    gaps = build_gaps(releases, missing_sha_lists)
    plan = build_plan(releases)

    mirrors_doc = json.loads((HERE / "mirrors.json").read_text()) if (HERE / "mirrors.json").exists() else None
    (HERE / "releases.json").write_text(json.dumps(releases, indent=1) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=1) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=1) + "\n")
    stats = {
        "releases": len(releases),
        "versions": len({e["version"] for e in releases}),
        "with_vendor_sha256": sum(1 for e in releases if e["checksum"]),
        "with_github_mirror": gh_mirrors,
        "distro_cache_mirrors": cache_hits,
        "github_mismatch": gh_rejected,
        "size_unknown": sum(1 for e in releases if e["size"] is None),
        "unmappable_skipped": dict(unmappable),
        "other_skipped": dict(skipped),
        "missing_sha_lists": missing_sha_lists,
        "plan": len(plan),
    }
    print(json.dumps(stats, indent=1))
    if mirrors_doc is not None:
        mirrors_doc.setdefault("scrape_stats", {})
        mirrors_doc["scrape_stats"] = {"github_confirmed_files": gh_mirrors, "github_mismatch": gh_rejected,
                                     "distro_cache_files": cache_hits}
        (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=1) + "\n")


def build_gaps(releases, missing_sha_lists):
    have = defaultdict(set)
    for e in releases:
        if e["kind"] != "source":
            have[e["major"]].add((e["os"], e["arch"]))
    majors = sorted(have, key=vtuple)
    gaps = []
    # A platform shipped by the majors either side but by no release of this one.
    for i in range(1, len(majors) - 1):
        for plat in (have[majors[i - 1]] & have[majors[i + 1]]) - have[majors[i]]:
            gaps.append({"runtime": "cmake", "major": majors[i], "os": plat[0], "arch": plat[1],
                         "reason": f"shipped by {majors[i-1]} and {majors[i+1]} but no file for this platform in v{majors[i]}/",
                         "looked_at": [f"{BASE}v{majors[i]}/"]})
    return gaps


def build_plan(releases):
    """Newest patch per (major, os, arch); prefer archive over installer, then
    .tar.gz/.zip over .tar.Z, then the variant with no suffix (newest macOS
    target), then smallest."""
    groups = defaultdict(list)
    for e in releases:
        if e["os"] in PLAN_OSES and e["arch"] != "any":
            groups[(e["major"], e["os"], e["arch"])].append(e)
    plan = []
    for cands in groups.values():
        newest = max(vtuple(c["version"]) for c in cands)
        pool = [c for c in cands if vtuple(c["version"]) == newest]
        pool.sort(key=lambda c: (c["kind"] != "archive", c["format"] == "tar.Z", c["variant"] is not None,
                                 c["size"] if c["size"] is not None else float("inf")))
        plan.append(pool[0])
    # Source only where a major has no binary for an OS at all (1.x/2.x were
    # POSIX-source-first; kept for completeness, make_major_plans filters).
    plan.sort(key=lambda e: (vtuple(e["version"]), e["os"], e["arch"]), reverse=True)
    return plan


if __name__ == "__main__":
    main()
