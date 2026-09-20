#!/usr/bin/env python3
"""Build the Ruby runtime catalog from official Ruby sources.

Re-runnable, Python 3 standard library only (uses the `gh` CLI via
subprocess for GitHub Releases -- no PyGithub/requests). Writes
releases.json, gaps.json, download_plan.json, mirrors.json and NOTES.md
alongside this script.

Sources (all fetched fresh on every run):

- https://cache.ruby-lang.org/pub/ruby/index.txt
  ruby-lang.org's own flat index of every file ever published under
  pub/ruby/: name, url, sha1, sha256, sha512 (tab-separated). This is
  the primary, task-mandated source for source-tarball release entries.
  It has no `date` or `size` column.

- https://raw.githubusercontent.com/ruby/www.ruby-lang.org/master/_data/releases.yml
  The data file that drives ruby-lang.org's own downloads page: one
  entry per version with `date`, `url` (per compression format),
  `size` and `sha1`/`sha256`/`sha512` (per format, for versions roughly
  2.1.0 and later -- older entries only have a bare `.tar.gz` url with
  no size/hash at all). Parsed with a small regex-driven line scanner
  (not a YAML library, to stay stdlib-only; the file's structure is a
  flat, uniformly-indented list making this reliable). Used only to
  backfill `released` (date) and `size` onto the index.txt entries by
  exact URL match -- index.txt remains the source of truth for which
  files exist and for url/checksum.

- `gh api repos/oneclick/rubyinstaller2/releases --paginate`
  Ruby 2.4+ Windows builds: 7z archives and exe/devkit-exe installers,
  x86/x64/arm (arm = Windows ARM64, see NOTES.md).

- `gh api repos/oneclick/rubyinstaller/releases --paginate`
  Ruby 1.8.7-2.3.3 Windows builds (RubyInstaller 1, predates
  RubyInstaller2): 7z archives, exe installers, and separate `.md5`
  sidecar files (fetched individually -- they're a few bytes of text
  each, not runtime files) since GitHub's asset `digest` field and
  release bodies carry no checksums this far back.

- HEAD requests, ≤10 concurrent, browser-like User-Agent:
    1. Sizes for the handful of source entries that appear in
       index.txt but not in releases.yml (very old/odd dated
       pre-releases).
    2. Confirming candidate mirror hosts on a small sample of files.
  No runtime files are ever downloaded in full by this script.

Everything fetched is untrusted network data; nothing in it is treated
as instructions, only as filenames/sizes/hashes/dates to record.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent

INDEX_URL = "https://cache.ruby-lang.org/pub/ruby/index.txt"
RELEASES_YML_URL = "https://raw.githubusercontent.com/ruby/www.ruby-lang.org/master/_data/releases.yml"
RI2_REPO = "oneclick/rubyinstaller2"
RI1_REPO = "oneclick/rubyinstaller"
RB_REPO = "ruby/ruby-builder"

USER_AGENT = "installer-builder-catalog/1.0 (+scrape.py; HEAD requests only)"
MAX_WORKERS = 10
TIMEOUT = 25

# Catalog major scope per SCHEMA.md / the task brief: "1.8, 1.9, 2.0 ...
# 3.4, and 4.0". Ruby versions before 1.8 (0.49 through 1.7.x) predate
# RubyInstaller and any binary distribution entirely and are out of
# this list -- excluded from releases.json, noted in NOTES.md, not
# treated as gaps (a gap is a plausible-but-missing combination; a
# pre-1.8 Windows/macOS/Linux binary was never plausible in the first
# place, nothing to look for).
MIN_MAJOR = (1, 8)

# Version-string patterns that mark a non-stable build in either
# cache.ruby-lang.org's index or releases.yml.
UNSTABLE_RE = re.compile(r"preview|-rc\d|rc\d+$|-dev\d|-dev$|snapshot|alpha|beta", re.I)

SOURCE_EXT_PREF = [".tar.gz", ".tar.xz", ".tar.bz2", ".zip"]  # tie-break only; smallest wins otherwise

PLAN_OSES = {"windows", "linux", "macos"}


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------


def fetch_url(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


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


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def head_many(urls, workers=MAX_WORKERS, follow_redirects=True):
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = ex.map(lambda u: head(u, follow_redirects=follow_redirects), urls)
        for url, res in zip(urls, futs):
            results[url] = res
    return results


def gh_api_paginate(path: str):
    """Run `gh api <path> --paginate` and parse the concatenated JSON
    array output. gh emits one JSON array per page; --paginate
    concatenates them back-to-back, so we split on '][' boundaries.
    """
    out = subprocess.run(
        ["gh", "api", path, "--paginate"],
        check=True,
        capture_output=True,
        text=True,
        timeout=180,
    ).stdout
    out = out.replace("][", "],[")
    data = json.loads(f"[{out}]")
    result = []
    for page in data:
        result.extend(page)
    return result


# --------------------------------------------------------------------------
# releases.yml parsing (regex line-scanner, not a YAML lib -- stdlib only)
# --------------------------------------------------------------------------


def parse_releases_yml(text: str):
    """Return ({url: {"date": str, "size": int}}, {version: date}) from
    ruby/www.ruby-lang.org's releases.yml. The url-keyed map matches
    cache.ruby-lang.org source-tarball urls exactly; the version-keyed
    map (e.g. "1.8.7-p330" -> "2010-12-25") gives the *real* Ruby
    release date, used to backfill `released` on RubyInstaller/
    ruby-builder entries too -- GitHub's `published_at` on those repos
    is often just when a maintainer bulk-imported an old release into
    GitHub (observed: several RubyInstaller1 2010-11 era tags all show
    published_at in 2021), not when Ruby itself shipped.
    """
    lines = text.split("\n")
    by_url = {}
    by_version_date = {}
    version = None
    date = None
    section = None  # 'url' | 'size' | 'sha1' | 'sha256' | 'sha512' | None
    urls_in_order = []
    sizes_in_order = {}

    def flush():
        for fmt, url in urls_in_order:
            size = sizes_in_order.get(fmt)
            by_url[url] = {"date": date, "size": int(size) if size else None}
        if version and date:
            by_version_date.setdefault(version, date)

    for line in lines:
        if line.startswith("- version:"):
            flush()
            version = line[len("- version:"):].strip()
            date = None
            section = None
            urls_in_order = []
            sizes_in_order = {}
            continue
        m = re.match(r"^  (\w+):\s*(.*)$", line)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if key == "date":
                date = val or None
                section = None
            elif key in ("url", "size", "sha1", "sha256", "sha512"):
                section = key
            else:
                section = None
            continue
        m2 = re.match(r"^    (\w+):\s*(\S*)$", line)
        if m2 and section:
            fmt, val = m2.group(1), m2.group(2).strip()
            if section == "url" and val:
                urls_in_order.append((fmt, val))
            elif section == "size" and val:
                sizes_in_order[fmt] = val
    flush()
    return by_url, by_version_date


# --------------------------------------------------------------------------
# Source tarball entries (cache.ruby-lang.org)
# --------------------------------------------------------------------------


def major_of(version: str):
    m = re.match(r"^(\d+)\.(\d+)", version)
    if not m:
        return None
    return f"{m.group(1)}.{m.group(2)}"


def format_of(url: str):
    for ext in (".tar.gz", ".tar.bz2", ".tar.xz", ".zip"):
        if url.endswith(ext):
            return ext.lstrip(".").replace("tar.", "tar.")
    return None


def build_source_releases(index_rows, yml_by_url):
    """One entry per stable version >= MIN_MAJOR: pick the smallest
    available format (tie-broken by SOURCE_EXT_PREF), attach date/size
    from releases.yml by exact URL match, and HEAD for size as a last
    resort when releases.yml doesn't know the file either.
    """
    by_name = defaultdict(list)
    for name, url, sha1, sha256, sha512 in index_rows:
        if "diff" in name or url.endswith(".diff.gz"):
            continue
        if UNSTABLE_RE.search(name):
            continue
        maj = major_of(name.replace("ruby-", "", 1))
        if maj is None:
            continue
        maj_tuple = tuple(int(p) for p in maj.split("."))
        if maj_tuple < MIN_MAJOR:
            continue
        ext = next((e for e in SOURCE_EXT_PREF if url.endswith(e)), None)
        if ext is None:
            continue
        by_name[name].append(
            {"url": url, "ext": ext, "sha1": sha1, "sha256": sha256, "sha512": sha512}
        )

    releases = []
    need_head = []
    for name, candidates in by_name.items():
        version = name[len("ruby-"):] if name.startswith("ruby-") else name
        maj = major_of(version)
        # Prefer the smallest known size (from releases.yml); fall back
        # to SOURCE_EXT_PREF order when no size is known for any of them.
        def size_of(c):
            info = yml_by_url.get(c["url"])
            return info["size"] if info and info["size"] else None

        sized = [(size_of(c), c) for c in candidates]
        known_sized = [(s, c) for s, c in sized if s is not None]
        if known_sized:
            chosen = min(known_sized, key=lambda sc: sc[0])[1]
        else:
            chosen = min(candidates, key=lambda c: SOURCE_EXT_PREF.index(c["ext"]))

        yml_info = yml_by_url.get(chosen["url"])
        size = yml_info["size"] if yml_info else None
        released = yml_info["date"] if yml_info else None

        sha256 = chosen["sha256"] or None
        checksum = {"algo": "sha256", "value": sha256, "source": INDEX_URL} if sha256 else None

        entry = {
            "runtime": "ruby",
            "languages": ["ruby"],
            "major": maj,
            "version": version,
            "os": "linux",
            "arch": "any",
            "kind": "source",
            "format": chosen["ext"].lstrip("."),
            "variant": None,
            "libc": None,
            "url": chosen["url"],
            "mirrors": [],
            "checksum": checksum,
            "size": size,
            "released": released,
            "min_os": None,
            "metadata_source": INDEX_URL,
            "notes": "source tarball; serves any Unix-like OS (compiled from source), not just Linux",
        }
        if size is None:
            need_head.append(entry)
        releases.append(entry)

    if need_head:
        results = head_many([e["url"] for e in need_head])
        for e in need_head:
            status, length = results.get(e["url"], (None, None))
            if status == 200 and length:
                e["size"] = length
            else:
                e["notes"] += f"; size unknown: HEAD returned status={status}"

    return releases


# --------------------------------------------------------------------------
# RubyInstaller2 (Ruby 2.4+, Windows)
# --------------------------------------------------------------------------

RI2_ASSET_RE = re.compile(r"^rubyinstaller(-devkit)?-(?P<ver>[\d.]+)-(?P<rel>\d+)-(?P<arch>x64|x86|arm)\.(?P<ext>7z|exe)$")
RI2_ARCH_MAP = {"x64": "amd64", "x86": "x86", "arm": "arm64"}


def build_rubyinstaller2_releases(version_dates):
    print(f"fetching gh api repos/{RI2_REPO}/releases --paginate ...")
    data = gh_api_paginate(f"repos/{RI2_REPO}/releases")
    print(f"  {len(data)} releases")

    releases = []
    for r in data:
        tag = r["tag_name"]
        if UNSTABLE_RE.search(tag) or "head" in tag.lower():
            continue
        gh_published = (r.get("published_at") or "")[:10] or None
        for a in r["assets"]:
            name = a["name"]
            m = RI2_ASSET_RE.match(name)
            if not m:
                continue
            version = m.group("ver")
            # Prefer the actual Ruby release date (releases.yml) over
            # RubyInstaller's own GitHub publish date, which for a
            # point release can lag the Ruby release by days to weeks.
            published = version_dates.get(version, gh_published)
            arch = RI2_ARCH_MAP[m.group("arch")]
            ext = m.group("ext")
            is_devkit = name.startswith("rubyinstaller-devkit-")
            kind = "archive" if ext == "7z" else "installer"
            digest = a.get("digest")
            checksum = None
            if digest and digest.startswith("sha256:"):
                checksum = {"algo": "sha256", "value": digest.split(":", 1)[1], "source": "GitHub API asset digest field"}
            note = None
            if arch == "arm64":
                note = "RubyInstaller names this asset '-arm-'; it targets 64-bit Windows on ARM, not 32-bit ARM"
            releases.append({
                "runtime": "ruby",
                "languages": ["ruby"],
                "major": major_of(version),
                "version": version,
                "os": "windows",
                "arch": arch,
                "kind": kind,
                "format": ext,
                "variant": "devkit" if is_devkit else None,
                "libc": None,
                "url": a["browser_download_url"],
                "mirrors": [],
                "checksum": checksum,
                "size": a.get("size") or None,
                "released": published,
                "min_os": None,
                "metadata_source": f"https://github.com/{RI2_REPO}/releases",
                "notes": note,
            })
    return releases


# --------------------------------------------------------------------------
# RubyInstaller 1 (Ruby 1.8.7-2.3.3, Windows)
# --------------------------------------------------------------------------

RI1_ARCHIVE_RE = re.compile(r"^ruby-(?P<ver>[\d.]+(?:-p\d+)?)-(?P<arch>i386|x64)-mingw32\.7z$")
RI1_INSTALLER_RE = re.compile(r"^rubyinstaller-(?P<ver>[\d.]+(?:-p\d+)?)(?:-(?P<arch>x64))?\.exe$")
RI1_ARCH_MAP = {"i386": "x86", "x64": "amd64", None: "x86"}


def fetch_md5_sidecar(url: str):
    """RubyInstaller1 assets ship a `<file>.md5` sidecar containing
    '<hex> *<filename>'. These are a few bytes of text, fetched
    individually -- not runtime files.
    """
    try:
        text = fetch_url(url).decode("ascii", "replace").strip()
        m = re.match(r"^([0-9a-fA-F]{32})\s+\*?", text)
        return m.group(1).lower() if m else None
    except Exception:
        return None


def build_rubyinstaller1_releases(version_dates):
    print(f"fetching gh api repos/{RI1_REPO}/releases --paginate ...")
    data = gh_api_paginate(f"repos/{RI1_REPO}/releases")
    print(f"  {len(data)} releases")

    releases = []
    md5_lookup = []  # (entry, md5_url) to resolve after
    for r in data:
        tag = r["tag_name"]
        if not re.match(r"^ruby-[\d.]", tag):
            continue  # skips DevKit-*, head
        gh_published = (r.get("published_at") or "")[:10] or None
        assets_by_name = {a["name"]: a for a in r["assets"]}
        for a in r["assets"]:
            name = a["name"]
            if name.endswith((".md5", ".asc", ".sig")):
                continue
            m = RI1_ARCHIVE_RE.match(name)
            kind = None
            if m:
                kind, ext, arch = "archive", "7z", RI1_ARCH_MAP[m.group("arch")]
                version = m.group("ver")
            else:
                m = RI1_INSTALLER_RE.match(name)
                if m:
                    kind, ext = "installer", "exe"
                    arch = RI1_ARCH_MAP[m.group("arch")]
                    version = m.group("ver")
            if kind is None:
                continue  # doc-chm bundle, DevKit sfx, etc: not a Ruby build

            # RubyInstaller1's GitHub releases were bulk-imported in
            # 2021 -- published_at there is import time, not when Ruby
            # (or the installer) actually shipped, e.g. every 1.8.7-p*
            # tag shows a 2021-04/05 published_at. Prefer the real Ruby
            # release date from releases.yml when we have it.
            published = version_dates.get(version, gh_published)

            entry = {
                "runtime": "ruby",
                "languages": ["ruby"],
                "major": major_of(version),
                "version": version,
                "os": "windows",
                "arch": arch,
                "kind": kind,
                "format": ext,
                "variant": None,
                "libc": None,
                "url": a["browser_download_url"],
                "mirrors": [],
                "checksum": None,
                "size": a.get("size") or None,
                "released": published,
                "min_os": None,
                "metadata_source": f"https://github.com/{RI1_REPO}/releases",
                "notes": None,
            }
            md5_asset = assets_by_name.get(name + ".md5")
            if md5_asset:
                md5_lookup.append((entry, md5_asset["browser_download_url"]))
            releases.append(entry)

    if md5_lookup:
        print(f"  fetching {len(md5_lookup)} .md5 sidecar files ...")
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
            hashes = list(ex.map(lambda t: fetch_md5_sidecar(t[1]), md5_lookup))
        for (entry, md5_url), h in zip(md5_lookup, hashes):
            if h:
                entry["checksum"] = {"algo": "md5", "value": h, "source": md5_url}

    return releases


# --------------------------------------------------------------------------
# ruby-builder (Linux/macOS portable "toolcache" builds used by setup-ruby)
# --------------------------------------------------------------------------

RB_ASSET_RE = re.compile(
    r"^ruby-(?P<ver>[\d.]+)-(?:(?P<darwin>darwin)-(?P<darch>x64|arm64)|ubuntu-(?P<ubver>[\d.]+)-(?P<uarch>x64|arm64))\.tar\.gz$"
)
RB_ARCH_MAP = {"x64": "amd64", "arm64": "arm64"}


def build_ruby_builder_releases():
    print(f"fetching gh api repos/{RB_REPO}/releases --paginate ...")
    data = gh_api_paginate(f"repos/{RB_REPO}/releases")
    print(f"  {len(data)} releases (all engines: ruby/jruby/truffleruby)")

    releases = []
    skipped_other_engine = 0
    for r in data:
        tag = r["tag_name"]
        if not re.match(r"^ruby-[\d.]+$", tag):
            skipped_other_engine += 1
            continue  # jruby-*, truffleruby-*, truffleruby+graalvm-*
        version = tag[len("ruby-"):]
        published = (r.get("published_at") or "")[:10] or None
        for a in r["assets"]:
            name = a["name"]
            m = RB_ASSET_RE.match(name)
            if not m:
                continue
            if m.group("darwin"):
                os_val, arch, variant = "macos", RB_ARCH_MAP[m.group("darch")], f"macos-{m.group('darch')}"
            else:
                os_val = "linux"
                arch = RB_ARCH_MAP[m.group("uarch")]
                variant = f"ubuntu-{m.group('ubver')}"
            digest = a.get("digest")
            checksum = None
            if digest and digest.startswith("sha256:"):
                checksum = {"algo": "sha256", "value": digest.split(":", 1)[1], "source": "GitHub API asset digest field"}
            releases.append({
                "runtime": "ruby",
                "languages": ["ruby"],
                "major": major_of(version),
                "version": version,
                "os": os_val,
                "arch": arch,
                "kind": "archive",
                "format": "tar.gz",
                "variant": variant,
                "libc": "glibc" if os_val == "linux" else None,
                "url": a["browser_download_url"],
                "mirrors": [],
                "checksum": checksum,
                "size": a.get("size") or None,
                "released": published,
                "min_os": None,
                "metadata_source": f"https://github.com/{RB_REPO}/releases",
                "notes": "prebuilt 'toolcache' archive from ruby/ruby-builder, as used by the ruby/setup-ruby GitHub Action; not published by ruby-lang.org itself",
            })
    return releases, skipped_other_engine


# --------------------------------------------------------------------------
# Gaps
# --------------------------------------------------------------------------


def build_gaps(releases):
    """A gap is a *binary* ruby-lang.org/RubyInstaller/ruby-builder build
    that doesn't exist for a major, matching SCHEMA.md's own PHP example
    ("php.net publishes no official Linux binaries; source only" is
    still recorded as a gap even though source exists) -- so a source
    tarball existing for a major does NOT suppress its linux/macos gap.
    """
    gaps = []
    has_binary = defaultdict(bool)  # (major, os) -> any non-source release
    for e in releases:
        if e["kind"] != "source":
            has_binary[(e["major"], e["os"])] = True

    all_majors = sorted({e["major"] for e in releases}, key=lambda m: tuple(int(p) for p in m.split(".")))

    for major in all_majors:
        if not has_binary[(major, "linux")]:
            gaps.append({
                "runtime": "ruby", "major": major, "os": "linux", "arch": "all",
                "reason": (
                    "ruby-lang.org has never published official prebuilt Linux "
                    "binaries (source tarball only); ruby/ruby-builder (used by "
                    "ruby/setup-ruby) has no build for this major either."
                ),
                "looked_at": [
                    "https://cache.ruby-lang.org/pub/ruby/",
                    f"https://github.com/{RB_REPO}/releases",
                ],
            })
        if not has_binary[(major, "macos")]:
            gaps.append({
                "runtime": "ruby", "major": major, "os": "macos", "arch": "all",
                "reason": (
                    "ruby-lang.org has never published official prebuilt macOS "
                    "binaries (source tarball only); ruby/ruby-builder has no "
                    "build for this major either."
                ),
                "looked_at": [
                    "https://cache.ruby-lang.org/pub/ruby/",
                    f"https://github.com/{RB_REPO}/releases",
                ],
            })
        if not has_binary[(major, "windows")]:
            gaps.append({
                "runtime": "ruby", "major": major, "os": "windows", "arch": "all",
                "reason": (
                    "neither RubyInstaller (1.8.7-2.3.3) nor RubyInstaller2 "
                    "(2.4+) published a build for this major."
                ),
                "looked_at": [
                    f"https://github.com/{RI1_REPO}/releases",
                    f"https://github.com/{RI2_REPO}/releases",
                    "https://rubyinstaller.org/downloads/archives/",
                ],
            })
    return gaps


# --------------------------------------------------------------------------
# download_plan.json
# --------------------------------------------------------------------------


def parse_version_tuple(version: str):
    """'2.4.10' -> (2,4,10,0); '1.8.7-p374' -> (1,8,7,374); '1.9.3-p551'
    -> (1,9,3,551). A 4th component is needed because old Ruby versions
    encode the real patch level as a trailing '-pNNN' *after* the
    third dotted component (1.8.7-p22 vs 1.8.7-p374 are both "1.8.7"
    in the first three numbers but very different releases).
    """
    nums = [int(n) for n in re.findall(r"\d+", version)]
    parts = nums[:4]
    while len(parts) < 4:
        parts.append(0)
    return tuple(parts)


def build_download_plan(releases):
    """Newest patch per (major, os, arch, variant-where-it-matters).
    Portable archive preferred over installer; windows devkit installer
    kept as a *separate* plan entry per major (arch amd64/arm64) since
    it's a meaningfully different artifact (bundles MSYS2 + a compiler
    toolchain), not just an alternate format of the same download.
    """
    # Majors that already have a real linux or macos binary (ruby-builder):
    # per the brief, "don't plan source unless no binary exists for that
    # major on linux/macos" -- so a source entry is only planned for the
    # older majors (1.8-2.0) where ruby-builder has nothing at all.
    majors_with_posix_binary = {
        e["major"] for e in releases
        if e["os"] in ("linux", "macos") and e["kind"] != "source"
    }

    groups = defaultdict(list)
    for e in releases:
        if e["os"] not in PLAN_OSES:
            continue
        if e["kind"] == "source" and e["major"] in majors_with_posix_binary:
            continue
        if e["os"] == "windows":
            key = (e["major"], e["os"], e["arch"], e.get("variant"))
        elif e["os"] == "linux":
            # newest-LTS ubuntu variant per arch: bucket by major/os/arch,
            # variant preference resolved by sort_key below.
            key = (e["major"], e["os"], e["arch"], None)
        else:  # macos
            key = (e["major"], e["os"], e["arch"], None)
        groups[key].append(e)

    # Preference order, newest-first, for picking a Linux "variant" when
    # several ubuntu bases exist for the same (major, arch): newest LTS.
    UBUNTU_PREF = ["ubuntu-26.04", "ubuntu-24.04", "ubuntu-22.04", "ubuntu-20.04", "ubuntu-18.04", "ubuntu-16.04"]

    plan = []
    for key, candidates in groups.items():
        major, os_val, arch, variant_key = key
        if os_val == "linux":
            # restrict to the newest-LTS variant present for this major/arch
            present = {c.get("variant") for c in candidates}
            chosen_variant = next((v for v in UBUNTU_PREF if v in present), None)
            candidates = [c for c in candidates if c.get("variant") == chosen_variant]

        newest = max(parse_version_tuple(c["version"]) for c in candidates)
        newest_candidates = [c for c in candidates if parse_version_tuple(c["version"]) == newest]

        archives = [c for c in newest_candidates if c["kind"] == "archive"]
        pool = archives if archives else newest_candidates

        def sort_key(c):
            return (c["size"] if c["size"] is not None else float("inf"))

        pool_sorted = sorted(pool, key=sort_key)
        plan.append(dict(pool_sorted[0]))

    plan.sort(key=lambda e: (parse_version_tuple(e["version"]), e["os"], e["arch"]), reverse=True)
    return plan


# --------------------------------------------------------------------------
# Mirrors (baseline: none confirmed here -- see extra_mirrors.py / Part 2)
# --------------------------------------------------------------------------


def build_mirrors_doc():
    return {
        "runtime": "ruby",
        "canonical": {
            "source": "https://cache.ruby-lang.org/pub/ruby/<major>/<file>",
            "windows_2.4+": f"https://github.com/{RI2_REPO}/releases/download/<tag>/<file>",
            "windows_1.8.7-2.3.3": f"https://github.com/{RI1_REPO}/releases/download/<tag>/<file>",
            "linux_macos_portable": f"https://github.com/{RB_REPO}/releases/download/<tag>/<file>",
        },
        "confirmed": [],
        "rejected": [],
        "note": "populated by extra_mirrors.py (Part 2 / MIRROR-HUNT.md); scrape.py itself confirms none.",
    }


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------


def main():
    print(f"fetching {INDEX_URL} ...")
    index_text = fetch_url(INDEX_URL).decode("utf-8", "replace")
    index_lines = index_text.strip("\n").split("\n")[1:]  # drop header
    index_rows = [tuple(line.split("\t")) for line in index_lines if line.strip()]
    print(f"  {len(index_rows)} rows")

    print(f"fetching {RELEASES_YML_URL} ...")
    yml_text = fetch_url(RELEASES_YML_URL).decode("utf-8", "replace")
    yml_by_url, yml_version_dates = parse_releases_yml(yml_text)
    print(f"  {len(yml_by_url)} urls with date/size, {len(yml_version_dates)} version dates")

    source_releases = build_source_releases(index_rows, yml_by_url)
    print(f"built {len(source_releases)} source release entries (major >= {MIN_MAJOR[0]}.{MIN_MAJOR[1]})")

    ri2_releases = build_rubyinstaller2_releases(yml_version_dates)
    print(f"built {len(ri2_releases)} RubyInstaller2 (Windows 2.4+) release entries")

    ri1_releases = build_rubyinstaller1_releases(yml_version_dates)
    print(f"built {len(ri1_releases)} RubyInstaller1 (Windows 1.8.7-2.3.3) release entries")

    rb_releases, skipped_engines = build_ruby_builder_releases()
    print(f"built {len(rb_releases)} ruby-builder (Linux/macOS) release entries "
          f"(skipped {skipped_engines} non-ruby-engine release tags)")

    releases = source_releases + ri2_releases + ri1_releases + rb_releases
    releases.sort(key=lambda e: (parse_version_tuple(e["version"]), e["os"], e["arch"], e.get("variant") or ""))

    gaps = build_gaps(releases)
    plan = build_download_plan(releases)
    mirrors_doc = build_mirrors_doc()

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2) + "\n")

    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    print(f"wrote releases.json ({len(releases)}), gaps.json ({len(gaps)}), "
          f"download_plan.json ({len(plan)}, {total_gb:.2f} GB), mirrors.json")


if __name__ == "__main__":
    main()
