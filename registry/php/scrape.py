#!/usr/bin/env python3
"""Build the PHP runtime catalog (releases.json, gaps.json, download_plan.json,
mirrors.json, NOTES.md) from official PHP indexes and one community source.

Python 3 standard library only. Re-runnable: HEAD-request sizes are cached
in head_cache.json next to this script so re-runs are fast and polite.

Sources used (all fetched live, nothing hand-pasted):
  - https://windows.php.net/downloads/releases/            (current Windows builds + sha256sum.txt)
  - https://windows.php.net/downloads/releases/archives/    (historical Windows builds, flat listing)
  - https://museum.php.net/php4/ and /php5/                 (pre-5.2 Windows builds; size is in the listing)
  - https://museum.php.net/php{4,5,7,8}/                    (source-tarball mirror, sampled)
  - https://www.php.net/releases/index.php?json&max=1000&version=<4|5|7|8>  (source tarballs + dates + checksums)
  - https://www.php.net/distributions/<file>                (canonical source download host)
  - https://dl.static-php.dev/static-php-cli/common/?format=json  (community static Linux/macOS builds, PHP 8.0+ only)

Everything fetched is untrusted vendor data: it is parsed for filenames,
sizes and hashes only, never executed or treated as instructions.
"""
import concurrent.futures
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).parent
CACHE_FILE = HERE / "head_cache.json"
UA = "installer-builder-runtimes-catalog/1.0 (+https://github.com/; PHP runtime scraper)"

RUNTIME = "php"
LANGUAGES = ["php"]

# Majors this catalog covers, per the project spec.
MAJORS = ["4.4"] + [f"5.{i}" for i in range(0, 7)] + [f"7.{i}" for i in range(0, 5)]
# 8.x majors are open-ended ("8.0"..latest) -- extended dynamically once we see
# what versions actually exist in the source index.
KNOWN_8X = [f"8.{i}" for i in range(0, 6)]
MAJORS_8X_SEEN = set()

UNSTABLE_RE = re.compile(r"(alpha|beta|rc\d*|dev)", re.I)
UNSTABLE_TAIL_RE = re.compile(r"[ab]\d+$", re.I)  # e.g. 5.0.0b1


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

def _opener_get(url, method="GET", timeout=20, retries=3):
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, r.headers, (r.read() if method == "GET" else b"")
        except urllib.error.HTTPError as e:
            if e.code in (404,):
                return e.code, e.headers, b""
            last_err = e
        except Exception as e:  # noqa: BLE001
            last_err = e
        time.sleep(0.5 * (attempt + 1))
    raise last_err


def get_text(url):
    status, _, body = _opener_get(url, "GET")
    return body.decode("utf-8", "replace")


def get_json(url):
    return json.loads(get_text(url))


CONFIRMED_ABSENT = -1  # sentinel: a real 404, not a transient failure -- don't retry forever


def head_content_length(url):
    """Returns byte size, CONFIRMED_ABSENT for a real 404, or None for a
    transient/unknown failure (network error, 5xx, etc -- worth retrying)."""
    try:
        status, headers, _ = _opener_get(url, "HEAD")
        if status == 404:
            return CONFIRMED_ABSENT
        if status != 200:
            return None
        cl = headers.get("Content-Length")
        return int(cl) if cl is not None else None
    except Exception:  # noqa: BLE001
        return None


class HeadCache:
    def __init__(self, path):
        self.path = path
        self.data = {}
        if path.exists():
            try:
                self.data = json.loads(path.read_text())
            except Exception:  # noqa: BLE001
                self.data = {}

    def bulk_resolve(self, urls, probe_url_fn=None, max_workers=10):
        """Resolve Content-Length for a list of canonical urls, using cache,
        and hitting a possibly-faster backend url (probe_url_fn) instead of
        the canonical one when given (same file, just a shorter redirect path).
        Confirmed-absent (404) results are cached permanently; anything else
        that failed (None) is retried on the next call/run."""
        todo = [u for u in urls if self.data.get(u) is None]
        if todo:
            def work(u):
                probe = probe_url_fn(u) if probe_url_fn else u
                return u, head_content_length(probe)

            with concurrent.futures.ThreadPoolExecutor(max_workers=max_workers) as ex:
                for u, size in ex.map(work, todo):
                    if size is not None:
                        self.data[u] = size
            self.save()
        return {u: (None if self.data.get(u) == CONFIRMED_ABSENT else self.data.get(u)) for u in urls}

    def save(self):
        self.path.write_text(json.dumps(self.data))


# --------------------------------------------------------------------------
# Small utilities
# --------------------------------------------------------------------------

def major_of(version):
    parts = version.split(".")
    return ".".join(parts[:2])


def version_key(version):
    return tuple(int(x) for x in re.findall(r"\d+", version))


def in_scope_major(major):
    return major in MAJORS or major in KNOWN_8X


def parse_date_flex(s):
    """PHP's source index uses '27 Aug 2026' or '03 January 2008'."""
    if not s:
        return None
    s = s.strip()
    for fmt in ("%d %b %Y", "%d %B %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            continue
    return None


# --------------------------------------------------------------------------
# 1. Source tarballs (php.net release index) -- also gives us release dates
#    we reuse for the Windows binaries below.
# --------------------------------------------------------------------------

FORMAT_PREF = ["tar.xz", "tar.bz2", "tar.gz"]


def fmt_of(filename):
    for f in FORMAT_PREF:
        if filename.endswith("." + f):
            return f
    return None


def fetch_source_index():
    """Returns (release_dates: {version: iso_date}, source_entries: [release dict])."""
    release_dates = {}
    source_entries = []
    for v in (4, 5, 7, 8):
        url = f"https://www.php.net/releases/index.php?json&max=1000&version={v}"
        try:
            data = get_json(url)
        except Exception as e:  # noqa: BLE001
            print(f"  ! could not fetch source index v{v}: {e}", file=sys.stderr)
            continue
        if not isinstance(data, dict) or "error" in data:
            continue  # e.g. version=6, which never had a public release
        for version, info in data.items():
            if not re.match(r"^\d+\.\d+\.\d+$", version):
                continue  # defensive: skip anything that isn't a plain stable version
            major = major_of(version)
            if major.startswith("8."):
                MAJORS_8X_SEEN.add(major)
            if not in_scope_major(major):
                continue
            iso_date = parse_date_flex(info.get("date"))
            if iso_date:
                release_dates[version] = iso_date
            files = info.get("source") or []
            # pick the smallest-preferred compression as "the" cataloged entry
            by_fmt = {}
            for f in files:
                fmt = fmt_of(f.get("filename", ""))
                if fmt:
                    by_fmt[fmt] = f
            chosen = None
            for fmt in FORMAT_PREF:
                if fmt in by_fmt:
                    chosen = (fmt, by_fmt[fmt])
                    break
            if not chosen:
                continue
            fmt, f = chosen
            filename = f["filename"]
            checksum = None
            if f.get("sha256"):
                checksum = {"algo": "sha256", "value": f["sha256"], "source": url}
            elif f.get("md5"):
                checksum = {"algo": "md5", "value": f["md5"], "source": url}
            source_entries.append({
                "runtime": RUNTIME,
                "languages": LANGUAGES,
                "major": major,
                "version": version,
                "os": "linux",
                "arch": "any",
                "kind": "source",
                "format": fmt,
                "variant": None,
                "libc": None,
                "url": f"https://www.php.net/distributions/{filename}",
                "mirrors": [],
                "checksum": checksum,
                "size": None,  # filled in by HEAD pass
                "released": iso_date,
                "min_os": None,
                "metadata_source": url,
                "notes": "source tarball; compile for linux or macos (php.net ships no official binaries for either)",
            })
    return release_dates, source_entries


# --------------------------------------------------------------------------
# 2. Windows binaries: releases/, archives/ (flat historical listing) and
#    museum.php.net/php4|php5 for pre-5.2 builds.
# --------------------------------------------------------------------------

HREF_RE = re.compile(r'href="([^"]+)"')
# museum listing rows carry an exact byte size in the "size" column
MUSEUM_ROW_RE = re.compile(
    r'<a href="([^"]+)"[^>]*>[^<]*</a></td><td class="size">\s*(\d+)</td><td class="date">([^<]+)</td>'
)

WIN_FNAME_RE = re.compile(
    r"^php-(?P<version>\d+\.\d+\.\d+[a-z0-9]*)"
    r"(?:-(?P<nts>nts))?"
    r"(?:-win32)?"
    r"(?:-(?P<compiler>vc\d+|vs\d+))?"
    r"(?:-(?P<arch>x64|x86))?"
    r"(?:-(?P<installer_word>installer))?"
    r"\.(?P<ext>zip|msi|exe)$",
    re.I,
)


def is_stable(version):
    if UNSTABLE_RE.search(version):
        return False
    if UNSTABLE_TAIL_RE.search(version):
        return False
    return True


def parse_win_filename(filename):
    m = WIN_FNAME_RE.match(filename)
    if not m:
        return None
    version = m.group("version")
    if not is_stable(version):
        return None
    nts = bool(m.group("nts"))
    compiler = m.group("compiler").lower() if m.group("compiler") else None
    arch = "amd64" if (m.group("arch") or "").lower() == "x64" else "x86"
    ext = m.group("ext").lower()
    kind = "archive" if ext == "zip" else "installer"
    if compiler:
        variant = f"{'nts' if nts else 'ts'}-{compiler}"
    elif nts:
        variant = "nts"
    else:
        variant = None
    return {
        "version": version,
        "arch": arch,
        "kind": kind,
        "format": ext,
        "variant": variant,
    }


def list_win_dir(url):
    html = get_text(url)
    hrefs = [h for h in HREF_RE.findall(html) if not h.startswith("?") and not h.startswith("/")]
    keep = []
    for h in hrefs:
        hl = h.lower()
        if not hl.startswith("php-"):
            continue
        if any(x in hl for x in ("-src.", "debug-pack", "devel-pack", "test-pack",
                                  ".asc", ".sig", "sha1sum", "sha256sum",
                                  ".cdx.json", ".openvex.json", ".spdx.json")):
            continue
        if not hl.endswith((".zip", ".msi")):
            continue
        keep.append(h)
    return keep


def parse_sumfile(text, algo):
    out = {}
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2:
            continue
        h, fname = parts
        fname = fname.lstrip("*").strip()
        if re.fullmatch(r"[0-9a-fA-F]+", h):
            out[fname] = h.lower()
    return {"algo": algo, "hashes": out}


def fetch_windows_entries(release_dates):
    entries = []
    metadata_source = {}

    releases_dir = "https://windows.php.net/downloads/releases/"
    archives_dir = "https://windows.php.net/downloads/releases/archives/"

    releases_files = list_win_dir(releases_dir)
    archives_files = list_win_dir(archives_dir)

    # checksums: releases/ has sha256sum.txt (current builds only)
    try:
        sha256_txt = get_text(releases_dir + "sha256sum.txt")
        sha256_map = parse_sumfile(sha256_txt, "sha256")["hashes"]
    except Exception:  # noqa: BLE001
        sha256_map = {}
    # archives/ only has a sparse, decade-old sha1sum.txt -- use it if it matches
    try:
        sha1_txt = get_text(archives_dir + "sha1sum.txt")
        sha1_map = parse_sumfile(sha1_txt, "sha1")["hashes"]
    except Exception:  # noqa: BLE001
        sha1_map = {}

    # filename -> (source_url_dir, listing_url) preferring releases/ over archives/
    by_filename = {}
    for f in archives_files:
        by_filename[f] = (archives_dir, archives_dir)
    for f in releases_files:
        by_filename[f] = (releases_dir, releases_dir)  # overrides archives/ entry

    for filename, (base, listing_url) in by_filename.items():
        parsed = parse_win_filename(filename)
        if not parsed:
            continue
        major = major_of(parsed["version"])
        if not in_scope_major(major):
            continue
        checksum = None
        if filename in sha256_map:
            checksum = {"algo": "sha256", "value": sha256_map[filename], "source": releases_dir + "sha256sum.txt"}
        elif filename in sha1_map:
            checksum = {"algo": "sha1", "value": sha1_map[filename], "source": archives_dir + "sha1sum.txt"}
        url = base + filename
        entries.append({
            "runtime": RUNTIME,
            "languages": LANGUAGES,
            "major": major,
            "version": parsed["version"],
            "os": "windows",
            "arch": parsed["arch"],
            "kind": parsed["kind"],
            "format": parsed["format"],
            "variant": parsed["variant"],
            "libc": None,
            "url": url,
            "mirrors": [],
            "checksum": checksum,
            "size": None,  # filled in by HEAD pass
            "released": release_dates.get(parsed["version"]),
            "min_os": None,
            "metadata_source": listing_url,
            "notes": None,
        })

    # --- museum.php.net: pre-5.2 Windows builds (php4/ and php5/) ---
    for series, prefix in ((4, "4.4."), (5, "5.0."), (5, "5.1.")):
        museum_url = f"https://museum.php.net/php{series}/"
        html = get_text(museum_url)
        for m in MUSEUM_ROW_RE.finditer(html):
            filename, size_str, _date = m.groups()
            if not filename.startswith(f"php-{prefix}"):
                continue
            if any(x in filename.lower() for x in ("pecl-", "-src.", ".asc", "dev-zend2")):
                continue
            parsed = parse_win_filename(filename)
            if not parsed:
                continue
            major = major_of(parsed["version"])
            if not in_scope_major(major):
                continue
            url = museum_url + filename
            entries.append({
                "runtime": RUNTIME,
                "languages": LANGUAGES,
                "major": major,
                "version": parsed["version"],
                "os": "windows",
                "arch": parsed["arch"],
                "kind": parsed["kind"],
                "format": parsed["format"],
                "variant": parsed["variant"],
                "libc": None,
                "url": url,
                "mirrors": [],
                "checksum": None,  # museum publishes no checksums for these
                "size": int(size_str),  # exact size is in the directory listing itself
                "released": release_dates.get(parsed["version"]),
                "min_os": None,
                "metadata_source": museum_url,
                "notes": None,
            })

    return entries


# --------------------------------------------------------------------------
# 3. static-php-cli community builds (PHP 8.0+ only, Linux + macOS)
# --------------------------------------------------------------------------

SPC_RE = re.compile(r"^php-(\d+\.\d+\.\d+)-cli-([a-z]+)-([a-z0-9_]+)\.tar\.gz$")
SPC_ARCH = {"x86_64": "amd64", "aarch64": "arm64"}
SPC_OS = {"linux": "linux", "macos": "macos"}


def fetch_static_php_cli_entries():
    listing_url = "https://dl.static-php.dev/static-php-cli/common/?format=json"
    try:
        data = get_json(listing_url)
    except Exception as e:  # noqa: BLE001
        print(f"  ! could not fetch static-php-cli listing: {e}", file=sys.stderr)
        return []
    entries = []
    for item in data:
        if item.get("is_dir"):
            continue
        name = item["name"]
        m = SPC_RE.match(name)
        if not m:
            continue
        version, osn, archn = m.groups()
        if osn not in SPC_OS or archn not in SPC_ARCH:
            continue
        major = major_of(version)
        MAJORS_8X_SEEN.add(major) if major.startswith("8.") else None
        released = None
        lm = item.get("last_modified")
        if lm:
            released = lm.split(" ")[0]
        entries.append({
            "runtime": RUNTIME,
            "languages": LANGUAGES,
            "major": major,
            "version": version,
            "os": SPC_OS[osn],
            "arch": SPC_ARCH[archn],
            "kind": "archive",
            "format": "tar.gz",
            "variant": "static-php-cli",
            "libc": None,
            "url": f"https://dl.static-php.dev/static-php-cli/common/{name}",
            "mirrors": [],
            "checksum": None,  # static-php-cli publishes no checksums for these builds
            "size": None,  # filled in by HEAD pass
            "released": released,
            "min_os": None,
            "metadata_source": listing_url,
            "notes": "community build (static-php-cli), not an official php.net binary",
        })
    return entries


# --------------------------------------------------------------------------
# Mirror confirmation: php.net/distributions is mirrored file-for-file by
# museum.php.net/php{N}/ -- confirm on a sample spanning old and new majors.
# --------------------------------------------------------------------------

def apply_source_mirror(source_entries, cache):
    """museum.php.net turned out NOT to mirror every source tarball: a quick
    sample showed it 404s for still-actively-maintained majors (e.g. 8.1+ as
    of this run -- it only carries fully-EOL branches). So instead of
    sampling a handful of files and blanket-applying the mirror, this checks
    every source entry's museum.php.net equivalent (cheap: ~500 HEAD
    requests, cached) and only records the mirror where it actually matches.
    Returns a summary dict for mirrors.json plus per-major coverage stats."""
    candidates = [e for e in source_entries if "museum.php.net" not in e["url"]]

    def mirror_url_for(e):
        filename = e["url"].rsplit("/", 1)[-1]
        series = e["version"].split(".")[0]
        return f"https://museum.php.net/php{series}/{filename}"

    urls = [mirror_url_for(e) for e in candidates]
    sizes = cache.bulk_resolve(urls)

    matched = 0
    by_major_total = defaultdict(int)
    by_major_matched = defaultdict(int)
    sample_checks = []
    for e in candidates:
        mu = mirror_url_for(e)
        by_major_total[e["major"]] += 1
        ok = e["size"] is not None and sizes.get(mu) is not None and sizes.get(mu) == e["size"]
        if ok:
            e["mirrors"] = [mu]
            matched += 1
            by_major_matched[e["major"]] += 1
        if len(sample_checks) < 8 and e["version"].endswith((".0", "0")):
            sample_checks.append({"url": e["url"], "mirror_url": mu,
                                   "primary_size": e["size"], "mirror_size": sizes.get(mu), "match": ok})

    majors_fully_mirrored = sorted(
        (m for m in by_major_total if by_major_total[m] == by_major_matched.get(m, 0)),
        key=version_key)
    majors_not_mirrored = sorted(
        (m for m in by_major_total if by_major_matched.get(m, 0) == 0),
        key=version_key)

    summary = {
        "template": "https://museum.php.net/php{major_digit}/{filename}",
        "applies_to": "source tarballs whose major is fully end-of-life (major_digit = version.split('.')[0])",
        "confirmed_by": f"HEAD request against every candidate source entry ({len(candidates)} files, "
                        f"cached, <=10 concurrent) -- not just a sample, because coverage turned out to be "
                        f"uneven across majors",
        "files_matched": matched,
        "files_checked": len(candidates),
        "majors_fully_mirrored": majors_fully_mirrored,
        "majors_not_mirrored_at_all": majors_not_mirrored,
        "caveat": "museum.php.net only mirrors majors that are fully end-of-life; it does not yet carry "
                  "the still-maintained 8.x majors' latest patches, so mirrors[] is empty for those entries",
        "samples": sample_checks,
    }
    return summary


# --------------------------------------------------------------------------
# Gap computation
# --------------------------------------------------------------------------

def compute_gaps(releases):
    by_major = defaultdict(set)
    for r in releases:
        if r["kind"] == "source":
            continue
        by_major[r["major"]].add((r["os"], r["arch"]))

    all_majors = sorted(set(MAJORS) | MAJORS_8X_SEEN, key=lambda m: version_key(m))
    gaps = []
    for major in all_majors:
        found = by_major.get(major, set())
        # Windows: x86 expected for every major; amd64 only from 5.5 onward
        # (PHP's Windows builds were 32-bit-only until the 5.5 line in 2013).
        expect_win_amd64 = version_key(major) >= version_key("5.5")
        if ("windows", "x86") not in found:
            gaps.append({
                "runtime": RUNTIME, "major": major, "os": "windows", "arch": "x86",
                "reason": "no Windows x86 build found in windows.php.net releases/archives/museum listings",
                "looked_at": [
                    "https://windows.php.net/downloads/releases/",
                    "https://windows.php.net/downloads/releases/archives/",
                    "https://museum.php.net/php4/", "https://museum.php.net/php5/",
                ],
            })
        if expect_win_amd64 and ("windows", "amd64") not in found:
            gaps.append({
                "runtime": RUNTIME, "major": major, "os": "windows", "arch": "amd64",
                "reason": "no Windows x64 build found",
                "looked_at": [
                    "https://windows.php.net/downloads/releases/",
                    "https://windows.php.net/downloads/releases/archives/",
                ],
            })
        elif not expect_win_amd64:
            gaps.append({
                "runtime": RUNTIME, "major": major, "os": "windows", "arch": "amd64",
                "reason": "windows.php.net never shipped an x64 build for this branch "
                          "(64-bit Windows PHP builds only began with the PHP 5.5 line)",
                "looked_at": ["https://windows.php.net/downloads/releases/archives/"],
            })
        # Linux/macOS: php.net ships no official binaries ever; static-php-cli
        # (community) covers 8.0+ only.
        for osn in ("linux", "macos"):
            for arch in ("amd64", "arm64"):
                if (osn, arch) not in found:
                    gaps.append({
                        "runtime": RUNTIME, "major": major, "os": osn, "arch": arch,
                        "reason": "php.net publishes no official Linux/macOS binaries (source only); "
                                  "no static-php-cli community build exists for this major either"
                                  if version_key(major) >= version_key("8.0")
                                  else "php.net publishes no official Linux/macOS binaries; source only",
                        "looked_at": [
                            "https://www.php.net/downloads.php",
                            "https://dl.static-php.dev/static-php-cli/common/?format=json",
                        ],
                    })
    return gaps


# --------------------------------------------------------------------------
# download_plan.json
# --------------------------------------------------------------------------

def build_download_plan(releases):
    by_key = defaultdict(list)
    for r in releases:
        if r["kind"] == "source":
            continue  # PHP specifics: don't plan source downloads
        by_key[(r["major"], r["os"], r["arch"])].append(r)

    plan = []
    for key, group in by_key.items():
        newest_version = max((r["version"] for r in group), key=version_key)
        same_version = [r for r in group if r["version"] == newest_version]
        archives = [r for r in same_version if r["kind"] == "archive"]
        pool = archives if archives else same_version
        if key[1] == "windows":
            nts_pool = [r for r in pool if r["variant"] and r["variant"].startswith("nts")]
            pool = nts_pool if nts_pool else pool
        pool.sort(key=lambda r: (r["size"] if r["size"] is not None else float("inf")))
        plan.append(pool[0])
    plan.sort(key=lambda r: (r["major"], r["os"], r["arch"]))
    return plan


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    cache = HeadCache(CACHE_FILE)

    print("Fetching php.net source index (versions 4, 5, 7, 8)...")
    release_dates, source_entries = fetch_source_index()
    print(f"  {len(source_entries)} in-scope source tarball entries")

    print("Fetching Windows binary listings (releases/, archives/, museum)...")
    win_entries = fetch_windows_entries(release_dates)
    print(f"  {len(win_entries)} in-scope Windows binary entries")

    print("Fetching static-php-cli community listing...")
    spc_entries = fetch_static_php_cli_entries()
    print(f"  {len(spc_entries)} in-scope static-php-cli entries")

    releases = source_entries + win_entries + spc_entries

    # ---- resolve exact sizes via HEAD (cached, <=10 concurrent) ----
    print("Resolving exact sizes via HEAD requests (cached across runs)...")

    def win_probe(u):
        # windows.php.net 302s to downloads.php.net; hitting that host
        # directly is ~10x faster under load and returns the identical file.
        return u.replace("https://windows.php.net/downloads/",
                          "https://downloads.php.net/~windows/")

    win_urls = [r["url"] for r in win_entries if r["size"] is None]
    win_sizes = cache.bulk_resolve(win_urls, probe_url_fn=win_probe)

    src_urls = [r["url"] for r in source_entries]
    src_sizes = cache.bulk_resolve(src_urls)

    spc_urls = [r["url"] for r in spc_entries]
    spc_sizes = cache.bulk_resolve(spc_urls)

    for r in win_entries:
        if r["size"] is None:
            r["size"] = win_sizes.get(r["url"])
    for r in source_entries:
        r["size"] = src_sizes.get(r["url"])
    for r in spc_entries:
        r["size"] = spc_sizes.get(r["url"])

    missing_size = sum(1 for r in releases if r["size"] is None)
    if missing_size:
        print(f"  {missing_size} entries had no resolved size on the first pass "
              f"(transient errors, or genuinely missing files) -- retrying...")

    # ---- retry pass: shakes loose transient 5xx failures (e.g. a couple of
    # static-php-cli requests came back 500 on the first attempt) ----
    retry_urls = [r["url"] for r in releases if r["size"] is None]
    if retry_urls:

        def retry_probe(u):
            if u.startswith("https://windows.php.net/downloads/"):
                return win_probe(u)
            return u

        retried = cache.bulk_resolve(retry_urls, probe_url_fn=retry_probe)
        for r in releases:
            if r["size"] is None:
                r["size"] = retried.get(r["url"])

    # ---- old source tarballs that no longer exist on www.php.net/distributions/
    # (php.net has quietly dropped a handful of pre-5.0 files there, confirmed
    # by a real, repeatable 404, not a fluke) fall back to the confirmed
    # museum.php.net mirror as their primary url instead of leaving size null ----
    still_missing_src = [r for r in source_entries if r["size"] is None]
    if still_missing_src:
        def museum_url_for(r):
            filename = r["url"].rsplit("/", 1)[-1]
            series = r["version"].split(".")[0]
            return f"https://museum.php.net/php{series}/{filename}"

        fallback_urls = [museum_url_for(r) for r in still_missing_src]
        fallback_sizes = cache.bulk_resolve(fallback_urls)
        recovered = 0
        for r in still_missing_src:
            mu = museum_url_for(r)
            size = fallback_sizes.get(mu)
            if size is not None:
                r["url"] = mu
                r["size"] = size
                r["metadata_source"] = "https://museum.php.net/"
                r["notes"] = ("www.php.net/distributions/ no longer serves this file (404); "
                              "using museum.php.net, the confirmed mirror, as the primary url instead")
                recovered += 1
        print(f"  recovered {recovered}/{len(still_missing_src)} old source files via museum.php.net")

    missing_size = sum(1 for r in releases if r["size"] is None)
    if missing_size:
        print(f"  ! {missing_size} entries still have no resolved size after retries/fallback", file=sys.stderr)

    # ---- check museum.php.net as a source-tarball mirror, and apply it
    # per-entry (coverage turned out to be uneven -- see apply_source_mirror) ----
    print("Checking museum.php.net as a source-tarball mirror...")
    mirror_summary = apply_source_mirror(source_entries, cache)
    print(f"  museum.php.net mirrors {mirror_summary['files_matched']}/{mirror_summary['files_checked']} "
          f"source files; not mirrored yet: {mirror_summary['majors_not_mirrored_at_all']}")

    # ---- assemble outputs ----
    gaps = compute_gaps(releases)
    plan = build_download_plan(releases)

    mirrors_doc = [mirror_summary] if mirror_summary["files_matched"] else []

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2, sort_keys=False))
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2))
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2))
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2))

    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    by_os = defaultdict(int)
    for r in releases:
        by_os[r["os"]] += 1
    majors_covered = defaultdict(set)
    for r in releases:
        majors_covered[r["os"]].add(r["major"])

    notes = f"""# PHP catalog notes

Generated by `scrape.py` on {datetime.now(timezone.utc).date().isoformat()}. Re-run it any
time; HEAD-resolved sizes are cached in `head_cache.json` (delete it to force
a full re-check).

## Sources

- Windows binaries: `windows.php.net/downloads/releases/` (current) and
  `.../archives/` (flat historical listing covering 5.2 through the current
  8.x line) plus `museum.php.net/php4/` and `/php5/` for pre-5.2 builds.
  `releases/sha256sum.txt` gives checksums for the currently-active majors
  only; `archives/sha1sum.txt` is a decade-old, 26-line leftover covering
  only 5.2.6-5.2.9, so almost all archived Windows builds have
  `checksum: null` -- the vendor simply doesn't publish one for them anymore.
  Museum listings never published checksums either.
- Source tarballs: `www.php.net/releases/index.php?json&max=1000&version={{4,5,7,8}}`
  for the version list, dates and checksums (sha256 for modern releases,
  md5 for old ones, `null` for the oldest 4.4.0-4.4.5). Download URL is
  `www.php.net/distributions/<file>`. One entry is recorded per version
  (preferring `.tar.xz`, then `.tar.bz2`, then `.tar.gz` if that's all that
  exists) rather than one per compression format, to avoid tripling the
  catalog for files that are otherwise identical. Per the project brief,
  source is recorded once with `os: "linux"` and covers macOS too (compile
  from source); no macOS-labelled duplicate is created, and source is never
  put in `download_plan.json`.
- Linux/macOS binaries: PHP.net ships none, for any version -- confirmed by
  the absence of any Linux/macOS entry point on php.net/downloads.php. The
  one community option that was cheaply scrapable is `static-php-cli`
  (`dl.static-php.dev/static-php-cli/common/?format=json`), which only goes
  back to PHP 8.0. Its builds are recorded with `variant: "static-php-cli"`
  and a note that they're unofficial; it publishes no checksums. Its `bulk/`
  listing has the same versions with more bundled extensions -- not
  separately cataloged. Its GitHub releases
  (`crazywhalecc/static-php-cli`) are the *build tool*, not prebuilt PHP
  runtimes, so they were not a usable mirror.

## Mirror

`museum.php.net/php{{4,5,7,8}}/<file>` mirrors `www.php.net/distributions/`
byte-for-byte, but **only for fully end-of-life majors** -- it does not yet
carry the latest patches of still-maintained 8.x lines. That was not
obvious from a small sample (an early 8-file sample looked fine until the
8.5.10 check came back 404), so every source entry's museum equivalent was
HEAD-checked rather than sampling-and-blanket-applying; see `mirrors.json`
for the exact match count and which majors are/aren't covered. For a
handful of pre-5.0 files (`php-4.4.0.tar.bz2` .. `php-4.4.8.tar.bz2` and
similar), `www.php.net/distributions/` itself now 404s -- for those,
`museum.php.net` was promoted from mirror to primary `url` instead of
leaving `size` null.

No working mirror was found for Windows binaries; `mirrors.aliyun.com/php/`
404s and `mirrors.huaweicloud.com/php/` is a JS app with no scrapable
static listing, so neither was pursued further.

## Gaps

- Windows x64 never existed for PHP before the 5.5 line (5.2/5.3/5.4 and
  everything before them are x86-only on Windows) -- recorded as a gap with
  that explanation rather than "not found".
- Every major before 8.0 has no Linux/macOS binary at all, official or
  community.
- `windows.php.net/downloads/museum/` (mentioned as a candidate in the
  brief) 404s; `museum.php.net` is the real, working host and was used
  instead.

## download_plan.json

{len(plan)} entries, {total_gb:.2f} GB total. Newest patch per (major, os,
arch); NTS preferred over TS on Windows; archive preferred over installer;
smallest size wins remaining ties. Source is excluded per the brief.

## Coverage by os

Releases by os: { {k: v for k, v in by_os.items()} }
Majors covered per os: { {k: sorted(v, key=version_key) for k, v in majors_covered.items()} }
"""
    (HERE / "NOTES.md").write_text(notes)

    print(f"\nWrote {len(releases)} releases, {len(gaps)} gaps, {len(plan)} planned downloads "
          f"({total_gb:.2f} GB) to {HERE}")


if __name__ == "__main__":
    main()
