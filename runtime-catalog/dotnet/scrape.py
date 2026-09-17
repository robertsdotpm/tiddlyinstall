#!/usr/bin/env python3
"""Build the .NET (dotnet) + .NET Framework (dotnet-framework) runtime catalog.

Python 3 standard library only. Re-runnable: re-fetches the official indexes
each time and rewrites releases.json / gaps.json / download_plan.json /
mirrors.json.

Sources (all official, machine-readable except the small .NET Framework
download-center pages, which are HTML-scraped for direct links only):
  - https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json
  - each channel's releases.json (linked from the index)
  - https://dotnet.microsoft.com/en-us/download/dotnet-framework/<slug> pages,
    followed to their "thank-you" redirect pages, to recover the real
    download.microsoft.com / download.visualstudio.microsoft.com URL.

Network use is bounded: index + ~14 channel releases.json GETs, a handful of
.NET Framework page fetches, and HEAD-only requests (<=10 concurrent) used
only to size the entries actually chosen for download_plan.json and to
confirm the one mirror pattern on a small sample.
"""
import concurrent.futures
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
UA = "installer-builder-runtimes-catalog/1.0 (+scrape.py; contact: matthew@roberts.pm)"
INDEX_URL = "https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json"
LANGUAGES = ["csharp", "fsharp", "visualbasic"]

# Files inside a release's variant sections that aren't the runtime/sdk/
# aspnetcore/windowsdesktop deliverable itself (workload packs, distro repo
# packages, symbols, hosting bundles, alternate installer flavours, etc).
EXCLUDE_SUBSTRINGS = (
    "apphost-pack", "targeting-pack", "runtime-deps", "symbols", "hosting",
    "store", "-gs", "-nj", "composite", "wixlib",
)
EXCLUDE_EXTENSIONS = (".deb", ".rpm")

VARIANT_KEYS = {
    "runtime": "runtime",
    "sdk": "sdk",
    "aspnetcore-runtime": "aspnetcore",
    "windowsdesktop": "windowsdesktop",
}

PLAN_OSES = {"windows", "linux", "macos"}


def log(*a):
    print(*a, file=sys.stderr)


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def fetch_text(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def head(url, timeout=20):
    """Return (final_url, size_bytes) or (None, None) on failure."""
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cl = r.headers.get("Content-Length")
            return r.geturl(), (int(cl) if cl is not None else None)
    except Exception as e:
        return None, None


def is_prerelease(version):
    return "-" in version


def get_format(name):
    low = name.lower()
    if low.endswith(".tar.gz"):
        return "tar.gz"
    if low.endswith(".zip"):
        return "zip"
    if low.endswith(".exe"):
        return "exe"
    if low.endswith(".msi"):
        return "msi"
    if low.endswith(".pkg"):
        return "pkg"
    return None


def kind_for_format(fmt):
    return "archive" if fmt in ("zip", "tar.gz") else "installer"


def should_skip(rid, name):
    low = name.lower()
    if any(s in low for s in EXCLUDE_SUBSTRINGS):
        return True
    if any(low.endswith(e) for e in EXCLUDE_EXTENSIONS):
        return True
    if rid in ("", "win-x86_x64", None):
        return True
    if get_format(name) is None:
        return True
    return False


def classify(rid, name):
    """-> (os, arch, libc) using both rid and filename (some old/odd
    releases carry a rid that disagrees with, or omits arch info the
    filename has -- e.g. rid 'linux-musl' on a file that is plainly -arm)."""
    s = f"{rid or ''} {name}".lower()
    if "bionic" in s:
        os_ = "android"
    elif "osx" in s or "macos" in s:
        os_ = "macos"
    elif "win" in s:
        os_ = "windows"
    else:
        # everything else here is a linux build, generic or distro-named
        # (centos/rhel/ubuntu/debian/fedora/opensuse/linux-*)
        os_ = "linux"
    libc = "musl" if "musl" in s else None
    if "arm64" in s:
        arch = "arm64"
    elif "arm" in s:
        arch = "armv7"
    elif "x64" in s or "amd64" in s:
        arch = "amd64"
    elif "x86" in s:
        arch = "x86"
    else:
        arch = None
    return os_, arch, libc


def build_core_releases():
    releases = []
    gaps = []
    index = fetch_json(INDEX_URL)
    for ch in index["releases-index"]:
        major = ch["channel-version"]
        rel_url = ch.get("releases.json")
        if not rel_url:
            continue
        try:
            data = fetch_json(rel_url)
        except Exception as e:
            gaps.append({
                "runtime": "dotnet", "major": major, "os": "windows", "arch": "amd64",
                "reason": f"could not fetch channel releases.json: {e}",
                "looked_at": [rel_url],
            })
            continue

        stable_found = False
        for rel in data.get("releases", []):
            version = rel.get("release-version", "")
            if is_prerelease(version):
                continue
            stable_found = True
            released = rel.get("release-date")
            for key, variant in VARIANT_KEYS.items():
                sec = rel.get(key)
                if not sec:
                    continue
                for f in sec.get("files", []):
                    rid = f.get("rid")
                    name = f.get("name", "")
                    url = f.get("url", "")
                    if should_skip(rid, name):
                        continue
                    os_, arch, libc = classify(rid, name)
                    if not os_ or not arch:
                        continue
                    fmt = get_format(name)
                    h = f.get("hash")
                    checksum = None
                    if h and re.fullmatch(r"[0-9a-fA-F]{128}", h):
                        checksum = {"algo": "sha512", "value": h, "source": rel_url}
                    releases.append({
                        "runtime": "dotnet",
                        "languages": LANGUAGES,
                        "major": major,
                        "version": version,
                        "os": os_,
                        "arch": arch,
                        "kind": kind_for_format(fmt),
                        "format": fmt,
                        "variant": variant,
                        "libc": libc,
                        "url": url,
                        "mirrors": [],
                        "checksum": checksum,
                        "size": None,
                        "released": released,
                        "min_os": None,
                        "metadata_source": rel_url,
                        "notes": None,
                    })
        if not stable_found:
            latest = ch.get("latest-release")
            for os_ in ("windows", "linux", "macos"):
                gaps.append({
                    "runtime": "dotnet", "major": major, "os": os_, "arch": "amd64",
                    "reason": (f"channel {major} has no stable release yet as of this "
                               f"scrape; latest is prerelease {latest!r} ({ch.get('support-phase')})"),
                    "looked_at": [rel_url],
                })
    return releases, gaps


# ---- .NET Framework (Windows-only offline redistributables) ----

# (major, page-slug-or-None). None means: no current dotnet.microsoft.com
# page links an offline installer for this version (recorded as a gap).
FRAMEWORK_VERSIONS = [
    ("1.0", None), ("1.1", None), ("2.0", None), ("3.0", None),
    ("3.5", "net35-sp1"),
    ("4.0", "net40"),
    ("4.5", "net45"),
    ("4.5.1", "net451"), ("4.5.2", "net452"),
    ("4.6", "net46"), ("4.6.1", "net461"), ("4.6.2", "net462"),
    ("4.7", "net47"), ("4.7.1", "net471"), ("4.7.2", "net472"),
    ("4.8", "net48"), ("4.8.1", "net481"),
]

FWLINK_RE = re.compile(r"go\.microsoft\.com/fwlink/\?linkid=(\d+)", re.I)
# fwlink ids that show up on every download-center page (nav/footer/telemetry),
# not the version-specific installer.
NAV_FWLINKS = {"206977", "2196228", "2259814", "521839", "2128109"}


def build_framework():
    releases = []
    gaps = []
    base = "https://dotnet.microsoft.com/en-us/download/dotnet-framework"
    for major, slug in FRAMEWORK_VERSIONS:
        if slug is None:
            gaps.append({
                "runtime": "dotnet-framework", "major": major, "os": "windows", "arch": "amd64",
                "reason": ("no offline-installer link found cheaply on the current "
                           "dotnet.microsoft.com/download/dotnet-framework pages for this "
                           "version (EOL / folded into a later in-place-update version); "
                           "not pursued further per scope"),
                "looked_at": [base],
            })
            continue
        page_url = f"{base}/{slug}"
        try:
            html = fetch_text(page_url)
        except Exception as e:
            gaps.append({
                "runtime": "dotnet-framework", "major": major, "os": "windows", "arch": "amd64",
                "reason": f"could not fetch {page_url}: {e}", "looked_at": [page_url],
            })
            continue
        # The page also links a "<slug>-developer-pack-offline-installer"
        # (reference assemblies for building, not the runtime redistributable)
        # -- exclude it explicitly rather than taking the first match, since
        # it is listed before the plain runtime offline-installer link in
        # the page's HTML for several versions.
        ids = (re.findall(r'data-bi-dlid="([a-z0-9.\-]*offline-installer)"', html)
               + re.findall(r'thank-you/([a-z0-9.\-]*offline-installer)"', html))
        ids = [i for i in ids if "developer-pack" not in i]
        expected = f"{slug}-offline-installer"
        if expected in ids:
            offline_id = expected
        elif ids:
            offline_id = ids[0]
        else:
            gaps.append({
                "runtime": "dotnet-framework", "major": major, "os": "windows", "arch": "amd64",
                "reason": "page has no offline-installer link (only web-installer)",
                "looked_at": [page_url],
            })
            continue
        ty_url = f"{base}/thank-you/{offline_id}"
        try:
            ty_html = fetch_text(ty_url)
        except Exception as e:
            gaps.append({
                "runtime": "dotnet-framework", "major": major, "os": "windows", "arch": "amd64",
                "reason": f"could not fetch {ty_url}: {e}", "looked_at": [page_url, ty_url],
            })
            continue
        # Collect every download.microsoft(.com|.visualstudio.com) candidate
        # this thank-you page points at -- both directly embedded links and
        # ones behind a go.microsoft.com fwlink redirect -- then reject
        # developer/targeting packs (a different product from the runtime
        # redistributable) rather than trusting link order or first-match.
        candidates = re.findall(
            r'https://download\.(?:microsoft\.com|visualstudio\.microsoft\.com)/\S*?\.exe', ty_html)
        for fw in set(FWLINK_RE.findall(ty_html)) - NAV_FWLINKS:
            fu, _ = head(f"https://go.microsoft.com/fwlink/?linkid={fw}")
            if fu and urlparse(fu).netloc in ("download.microsoft.com", "download.visualstudio.microsoft.com"):
                candidates.append(fu)
        candidates = [c for c in candidates if not re.search(r"devpack|targetingpack", c, re.I)]
        final_url = size = None
        if candidates:
            final_url, size = head(candidates[0])
        if not final_url:
            gaps.append({
                "runtime": "dotnet-framework", "major": major, "os": "windows", "arch": "amd64",
                "reason": "offline-installer thank-you page had no resolvable download.microsoft.com link",
                "looked_at": [page_url, ty_url],
            })
            continue
        releases.append({
            "runtime": "dotnet-framework",
            "languages": LANGUAGES,
            "major": major,
            "version": major,
            "os": "windows",
            "arch": "amd64",
            "kind": "installer",
            "format": "exe",
            "variant": None,
            "libc": None,
            "url": final_url,
            "mirrors": [],
            "checksum": None,
            "size": size,
            "released": None,
            "min_os": None,
            "metadata_source": ty_url,
            "notes": ("combined x86+x64 (\"AllOS\") offline installer" if major != "3.5"
                      else "combined offline installer for .NET Framework 3.5 SP1, "
                           "which also carries 2.0 SP2 and 3.0 SP2"),
        })
    return releases, gaps


def confirm_and_apply_mirror(releases):
    """Sample builds.dotnet.microsoft.com URLs old and new; if a
    dotnetcli.blob.core.windows.net rewrite HEADs to the same size, apply
    the rewrite to every matching release's mirrors list."""
    host_old = "builds.dotnet.microsoft.com/dotnet/"
    host_new = "dotnetcli.blob.core.windows.net/dotnet/"
    candidates = [r for r in releases if host_old in r["url"]]
    if not candidates:
        return {"confirmed": False, "sample": []}
    candidates_sorted = sorted(candidates, key=lambda r: r["version"])
    sample = candidates_sorted[:3] + candidates_sorted[-3:]
    checks = []
    ok = True
    for r in sample:
        mirrored = r["url"].replace(host_old, host_new)
        orig_final, orig_size = head(r["url"])
        mir_final, mir_size = head(mirrored)
        match = bool(orig_size and mir_size and orig_size == mir_size)
        checks.append({"url": r["url"], "mirror": mirrored, "orig_size": orig_size,
                        "mirror_size": mir_size, "match": match})
        ok = ok and match
    if ok:
        for r in candidates:
            r["mirrors"] = [r["url"].replace(host_old, host_new)]
    return {"confirmed": ok, "sample": checks}


def build_download_plan(releases):
    # newest stable patch per (runtime, major, os, arch, variant)
    # - dotnet: only variant "runtime", os in windows/linux/macos, prefer
    #   glibc over musl, then archive over installer format.
    # - dotnet-framework: the single entry per major (variant None).
    def version_key(v):
        parts = re.split(r"[.\-]", v)
        return tuple(int(p) if p.isdigit() else -1 for p in parts)

    buckets = {}
    for r in releases:
        if r["os"] not in PLAN_OSES:
            continue
        if r["runtime"] == "dotnet" and r["variant"] != "runtime":
            continue
        key = (r["runtime"], r["major"], r["os"], r["arch"], r["variant"])
        buckets.setdefault(key, []).append(r)

    def pick(cands):
        newest = max(version_key(c["version"]) for c in cands)
        newest_cands = [c for c in cands if version_key(c["version"]) == newest]
        # prefer glibc over musl
        non_musl = [c for c in newest_cands if c["libc"] != "musl"]
        pool = non_musl or newest_cands
        # prefer archive over installer
        archives = [c for c in pool if c["kind"] == "archive"]
        pool = archives or pool
        # smallest-format tie-break: zip/tar.gz already selected; if still
        # multiple (e.g. duplicate distro-named old linux builds), prefer a
        # generic rid over a distro-specific one by shortest url.
        pool.sort(key=lambda c: len(c["url"]))
        return pool[0]

    plan = [pick(v) for v in buckets.values()]

    # size the plan entries via bounded-concurrency HEAD requests
    def size_one(entry):
        _, size = head(entry["url"])
        return entry, size

    with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
        for entry, size in ex.map(size_one, plan):
            if size:
                entry["size"] = size
                # keep the matching releases.json entry in sync
    # propagate sizes back into the master release objects (same dict refs)
    plan.sort(key=lambda r: (r["runtime"], r["major"], r["os"], r["arch"]))
    return plan


def main():
    log("fetching releases-index.json and channel releases.json ...")
    core_releases, core_gaps = build_core_releases()
    log(f"  {len(core_releases)} dotnet release files, {len(core_gaps)} gaps")

    log("scraping .NET Framework download-center pages ...")
    fx_releases, fx_gaps = build_framework()
    log(f"  {len(fx_releases)} dotnet-framework releases, {len(fx_gaps)} gaps")

    releases = core_releases + fx_releases
    gaps = core_gaps + fx_gaps

    log("confirming mirror pattern on a sample and applying it ...")
    mirror_check = confirm_and_apply_mirror(releases)

    log("building download_plan.json (HEAD requests for size, <=10 concurrent) ...")
    plan = build_download_plan(releases)

    mirrors = {
        "dotnet": [
            {
                "template": "https://dotnetcli.blob.core.windows.net/dotnet/<same path as builds.dotnet.microsoft.com>",
                "applies_to": "any release whose url starts with https://builds.dotnet.microsoft.com/dotnet/ "
                              "(covers effectively all dotnet runtime/sdk/aspnetcore/windowsdesktop files, majors 1.0-11.0)",
                "confirmed": mirror_check["confirmed"],
                "confirmation_method": "HEAD both URLs for a sample spanning the oldest and newest majors; "
                                        "same Content-Length counted as confirmed",
                "sample": mirror_check["sample"],
            }
        ],
        "dotnet-framework": [],
        "not_confirmed": [
            {"template": "https://ci.dot.net/public/<path>", "note": "404s for the same path shape; not used"},
        ],
    }

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps(mirrors, indent=2) + "\n")

    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    log(f"done: {len(releases)} releases, {len(gaps)} gaps, {len(plan)} planned downloads, {total_gb:.2f} GB")


if __name__ == "__main__":
    main()
