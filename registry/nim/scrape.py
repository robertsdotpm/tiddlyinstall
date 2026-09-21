#!/usr/bin/env python3
"""Build the Nim runtime catalog from official Nim sources.

Re-runnable, Python 3 standard library only (uses `gh` as a subprocess for
GitHub data -- no GitHub token handling of its own). Writes releases.json,
gaps.json, download_plan.json, mirrors.json alongside this script.

Why this is a brute-force HEAD scan rather than an index fetch
----------------------------------------------------------------
Every other catalog scraper in this repo (see ../go/scrape.py) reads one
machine-readable index. Nim has none:

- `https://nim-lang.org/download/` -- the actual file host -- returns a
  plain nginx 403 for the bare directory (autoindex is off; this is NOT a
  bot block, individual files under it 200 fine with any client) and there
  is no JSON/XML listing endpoint.
- `https://nim-lang.org/download.html` 302-redirects to
  `https://nim-lang.org/install.html`, which IS real HTML with a
  "Install previous versions" table -- but Cloudflare/nginx serves it
  fine to a normal browser UA while a bare Python `urllib` UA (and curl's
  default UA on the *directory* path, though not on individual files) can
  get 403'd, so every request below sends a browser-like User-Agent.
- Nim ships no GitHub Releases with attached binaries on `nim-lang/Nim`
  itself (checked: `gh api repos/nim-lang/Nim/releases` is empty; only
  git tags exist). Binaries for many secondary targets (macOS, Linux
  arm64/armv7) live instead on `nim-lang/nightlies`, under dated release
  tags for the stable branch, and are only discoverable via the
  install.html table (there's no tag-name convention to guess from).

So the approach is:

1. Enumerate every stable version from `gh api repos/nim-lang/Nim/tags`
   (all 72 tags are plain X.Y.Z with no rc/beta suffix -- verified by hand
   before writing this script). Get each tag's commit date the same way,
   for `released`.
2. For every version, HEAD a fixed superset of candidate filenames
   directly against `nim-lang.org/download/` (see CANDIDATES below). This
   is what choosenim itself does -- its `download.nim` builds URLs as
   `nim-lang.org/download/nim-$version$osSuffix_x$arch.<zip|tar.xz>` -- so
   the naming below is taken from choosenim's source
   (nim-lang/choosenim, src/choosenimpkg/download.nim and cliparams.nim's
   `getBinArchiveFormat`/`getCpuArch`), not guessed blind. A companion
   `<file>.sha256` is fetched (tiny GET) for every hit.
3. Parse the "Install previous versions" table on install.html for
   versions 1.0.8 through the latest -- it hands us, per stable version,
   direct GitHub asset URLs (nim-lang/nightlies release, tagged e.g.
   "2026-09-08-version-2-2-<sha>") for windows/linux/macOS/source. This
   table is confirmation-by-construction that these are builds of that
   *tagged stable version*, not of devel: the table's own version column
   is `2.2.12` etc, matching a real `v2.2.12` git tag, under a heading
   that literally says "Install previous versions" (i.e. this is
   nim-lang.org's own record of what to install for that release, not a
   nightly-of-devel). Only added to releases.json where step 2 found
   NOTHING for that exact (version, os, arch) -- so it fills in macOS and
   Linux arm64/armv7 history without duplicating or second-guessing the
   canonical nim-lang.org binaries where those already exist.

No runtime file is ever downloaded in full; every check is HEAD (or a GET
of a several-byte-to-few-hundred-byte `.sha256` file, or the install.html
page itself, ~350KB of HTML).
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

DOWNLOAD_BASE = "https://nim-lang.org/download/"
INSTALL_PAGE = "https://nim-lang.org/install.html"
TAGS_REPO = "nim-lang/Nim"
# Browser-like UA: nim-lang.org's WAF/nginx 403s a bare `python-urllib/x.y`
# UA (and 403s curl's default UA specifically on the un-listable directory
# path -- individual files are fine with any UA). Confirmed empirically.
USER_AGENT = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 "
              "installer-builder-catalog/1.0")
TIMEOUT = 20
MAX_WORKERS = 12

PLAN_OSES = {"windows", "linux", "macos"}


# ---------------------------------------------------------------- HTTP ----

def _req(url, method="GET"):
    return urllib.request.Request(url, headers={"User-Agent": USER_AGENT}, method=method)


def head(url):
    """Return (status, content_length_or_None). Never raises."""
    try:
        with urllib.request.urlopen(_req(url, "HEAD"), timeout=TIMEOUT) as r:
            cl = r.headers.get("Content-Length")
            return r.status, (int(cl) if cl is not None else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def get_text(url):
    """GET url as text, or None on any failure/non-200."""
    try:
        with urllib.request.urlopen(_req(url, "GET"), timeout=TIMEOUT) as r:
            if r.status == 200:
                return r.read().decode("utf-8", "replace")
    except Exception:
        pass
    return None


def head_many(urls, workers=MAX_WORKERS):
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = ex.map(head, urls)
        for url, res in zip(urls, futs):
            results[url] = res
    return results


def get_many_text(urls, workers=MAX_WORKERS):
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = ex.map(get_text, urls)
        for url, res in zip(urls, futs):
            results[url] = res
    return results


# ------------------------------------------------------------- GitHub -----

def gh_tags():
    """[(version, commit_sha), ...] for every plain vX.Y.Z tag."""
    out = subprocess.run(
        ["gh", "api", f"repos/{TAGS_REPO}/tags", "--paginate",
         "--jq", ".[] | [.name, .commit.sha] | @tsv"],
        capture_output=True, text=True, check=True,
    )
    tags = []
    for line in out.stdout.splitlines():
        name, sha = line.split("\t")
        if re.fullmatch(r"v\d+\.\d+\.\d+", name):
            tags.append((name[1:], sha))
    return tags


def gh_commit_date(sha):
    try:
        out = subprocess.run(
            ["gh", "api", f"repos/{TAGS_REPO}/commits/{sha}",
             "--jq", ".commit.committer.date"],
            capture_output=True, text=True, check=True, timeout=TIMEOUT,
        )
        d = out.stdout.strip()
        return d[:10] if d else None
    except Exception:
        return None


def gh_commit_dates(shas):
    dates = {}
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = ex.map(gh_commit_date, shas)
        for sha, d in zip(shas, futs):
            dates[sha] = d
    return dates


# --------------------------------------------------------- naming rules ---

def parse_version_tuple(v):
    parts = [int(p) for p in v.split(".")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def major_of(v):
    m = re.match(r"^(\d+\.\d+)", v)
    return m.group(1) if m else v


def candidates(version):
    """Fixed superset of filenames choosenim/history are known to use.

    Each item: (os, arch, kind, format, filename). Every one is HEAD'd;
    absence just means that combination was never published, not an error.
    """
    v = version
    return [
        # Windows -- choosenim: nim-$version_x$arch.zip (64/32), plus the
        # older NSIS-style installer and, for exactly one very old release
        # (0.12.0), a bare self-contained zip with no _x32 suffix that
        # bundles MinGW (33MB vs. the 3MB source tar.xz of the same
        # version -- too large to be source-only; see NOTES.md).
        ("windows", "amd64", "archive", "zip", f"nim-{v}_x64.zip"),
        ("windows", "x86", "archive", "zip", f"nim-{v}_x32.zip"),
        ("windows", "x86", "installer", "exe", f"nim-{v}_x32.exe"),
        ("windows", "x86", "archive", "zip", f"nim-{v}.zip"),
        # Linux -- choosenim: nim-$version-linux_x$arch.tar.xz. arm64 and
        # armv7l only started appearing on nim-lang.org itself from 2.2.8
        # onward (see NOTES.md); checked for every version regardless.
        ("linux", "amd64", "archive", "tar.xz", f"nim-{v}-linux_x64.tar.xz"),
        ("linux", "x86", "archive", "tar.xz", f"nim-{v}-linux_x32.tar.xz"),
        ("linux", "arm64", "archive", "tar.xz", f"nim-{v}-linux_arm64.tar.xz"),
        ("linux", "armv7", "archive", "tar.xz", f"nim-{v}-linux_armv7l.tar.xz"),
        # macOS -- not part of choosenim's binaryUrl at all (it only builds
        # that URL `when defined(Windows) or defined(linux)`); only found
        # on nim-lang.org itself from 2.2.8 onward. Checked for every
        # version to confirm the negative rather than assume it.
        ("macos", "amd64", "archive", "tar.xz", f"nim-{v}-macosx_x64.tar.xz"),
        ("macos", "arm64", "archive", "tar.xz", f"nim-{v}-macosx_arm64.tar.xz"),
        # Source -- choosenim falls back to .tar.xz (or .tar.gz if `unxz`
        # is missing) when no binary build exists / on non-Windows/Linux.
        ("linux", "any", "source", "tar.xz", f"nim-{v}.tar.xz"),
        ("linux", "any", "source", "tar.gz", f"nim-{v}.tar.gz"),
    ]


# ------------------------------------------------------------- scraping ---

def scrape_direct(versions):
    """HEAD every candidate for every version against nim-lang.org/download/.

    Returns (releases, found_keys) where found_keys is a set of
    (version, os, arch) actually found directly -- used to decide which
    nightlies-table entries are genuinely new information vs. a duplicate
    of what nim-lang.org already serves itself.
    """
    all_candidates = []  # (version, os, arch, kind, fmt, filename, url)
    for v in versions:
        for os_, arch, kind, fmt, filename in candidates(v):
            all_candidates.append((v, os_, arch, kind, fmt, filename, DOWNLOAD_BASE + filename))

    print(f"HEAD-checking {len(all_candidates)} candidate URLs against {DOWNLOAD_BASE} ...")
    results = head_many([c[6] for c in all_candidates])

    hits = [c for c in all_candidates if results[c[6]][0] == 200]
    print(f"  {len(hits)} files found")

    print(f"  fetching {len(hits)} .sha256 sidecars ...")
    sha_texts = get_many_text([h[6] + ".sha256" for h in hits])

    releases = []
    found_keys = set()
    for (v, os_, arch, kind, fmt, filename, url) in hits:
        status, size = results[url]
        sha_text = sha_texts.get(url + ".sha256")
        checksum = None
        if sha_text:
            token = sha_text.strip().split()[0] if sha_text.strip() else ""
            if re.fullmatch(r"[0-9a-fA-F]{64}", token):
                checksum = {"algo": "sha256", "value": token.lower(),
                            "source": url + ".sha256"}
        releases.append({
            "runtime": "nim",
            "languages": ["nim"],
            "major": major_of(v),
            "version": v,
            "os": os_,
            "arch": arch,
            "kind": kind,
            "format": fmt,
            "variant": None,
            "libc": None,
            "url": url,
            "mirrors": [],
            "checksum": checksum,
            "size": size,
            "released": None,  # filled in by caller
            "min_os": None,
            "metadata_source": DOWNLOAD_BASE,
            "notes": None,
        })
        # Don't let the "any"-arch source entry block a real nightlies
        # binary for this exact (version, os, arch) -- only binaries count
        # as "already found" for dedup purposes.
        if kind != "source":
            found_keys.add((v, os_, arch))
    return releases, found_keys


NIGHTLIES_ROW_RE = re.compile(
    r"<tr>\s*<td><strong>([\d.]+)</strong></td>(.*?)</tr>", re.DOTALL
)
NIGHTLIES_LINK_RE = re.compile(r'href="(https://github\.com/nim-lang/nightlies/releases/download/[^"]+)"')

NIGHTLIES_ARCH_RE = [
    (re.compile(r"_x64\."), "amd64"),
    (re.compile(r"_x32\."), "x86"),
    (re.compile(r"arm64"), "arm64"),
    (re.compile(r"armv7l"), "armv7"),
]


def classify_nightlies_url(url):
    """(os, arch) for a nim-lang/nightlies asset URL, or (None, None)."""
    fn = url.rsplit("/", 1)[-1]
    if fn.endswith(".sha256"):
        return None, None
    if "windows" in fn:
        os_ = "windows"
    elif "linux" in fn:
        os_ = "linux"
    elif "macosx" in fn:
        os_ = "macos"
    else:
        os_ = None  # bare source tarball, e.g. nim-2.2.12.tar.xz
    arch = "any"
    for pat, a in NIGHTLIES_ARCH_RE:
        if pat.search(fn):
            arch = a
            break
    return os_, arch


def scrape_nightlies_table(found_keys):
    """Parse install.html's 'Install previous versions' table.

    Only yields entries for (version, os, arch) NOT already found directly
    on nim-lang.org (see scrape_direct) -- i.e. this only ever contributes
    macOS builds and Linux arm64/armv7 builds for the version range
    (1.0.8 upward) where nim-lang.org itself doesn't carry them.
    """
    html = get_text(INSTALL_PAGE)
    if not html:
        print("  warning: could not fetch install.html; skipping nightlies-table pass", file=sys.stderr)
        return [], None

    rows = NIGHTLIES_ROW_RE.findall(html)
    print(f"  install.html: {len(rows)} version rows in the releases table "
          f"(covers {rows[-1][0] if rows else '?'} .. {rows[0][0] if rows else '?'})")

    asset_urls = []  # (version, os, arch, kind, fmt, url)
    for version, body in rows:
        for url in NIGHTLIES_LINK_RE.findall(body):
            if url.endswith(".sha256"):
                continue
            os_, arch = classify_nightlies_url(url)
            if os_ is None:
                continue  # bare source tarball -- nim-lang.org always has this directly
            if (version, os_, arch) in found_keys:
                continue  # nim-lang.org already serves this directly -- skip duplicate
            fmt = "zip" if url.endswith(".zip") else ("tar.xz" if url.endswith(".tar.xz") else None)
            asset_urls.append((version, os_, arch, "archive", fmt, url))

    print(f"  {len(asset_urls)} nightlies-table assets are NOT already covered directly "
          f"(macOS / linux arm64+armv7 backfill)")

    print(f"  HEAD + sha256 for {len(asset_urls)} nightlies assets ...")
    sizes = head_many([a[5] for a in asset_urls])
    shas = get_many_text([a[5] + ".sha256" for a in asset_urls])

    releases = []
    for (version, os_, arch, kind, fmt, url) in asset_urls:
        status, size = sizes[url]
        if status != 200:
            continue
        sha_text = shas.get(url + ".sha256")
        checksum = None
        if sha_text:
            token = sha_text.strip().split()[0] if sha_text.strip() else ""
            if re.fullmatch(r"[0-9a-fA-F]{64}", token):
                checksum = {"algo": "sha256", "value": token.lower(), "source": url + ".sha256"}
        releases.append({
            "runtime": "nim",
            "languages": ["nim"],
            "major": major_of(version),
            "version": version,
            "os": os_,
            "arch": arch,
            "kind": kind,
            "format": fmt,
            "variant": "nightlies",
            "libc": None,
            "url": url,
            "mirrors": [],
            "checksum": checksum,
            "size": size,
            "released": None,
            "min_os": None,
            "metadata_source": INSTALL_PAGE,
            "notes": ("Built by nim-lang/nightlies' backport-to-stable CI for this tagged "
                      "release and linked from nim-lang.org's own install.html 'Install "
                      "previous versions' table (not a devel-branch nightly); nim-lang.org "
                      "itself hosts no direct copy of this file for this version."),
        })
    return releases, rows


# --------------------------------------------------------------- gaps -----

def build_gaps(releases, all_versions):
    by_major_os_binary = defaultdict(set)  # major -> {os with >=1 binary}
    versions_by_major = defaultdict(set)
    for v in all_versions:
        versions_by_major[major_of(v)].add(v)
    for e in releases:
        if e["kind"] != "source":
            by_major_os_binary[e["major"]].add(e["os"])

    majors_sorted = sorted(versions_by_major, key=lambda m: parse_version_tuple(m + ".0"))

    gaps = []

    # Nimrod era: nothing at all found for 0.8.x / 0.9.x.
    for major in ("0.8", "0.9"):
        if major in versions_by_major and major not in by_major_os_binary and not any(
            e["major"] == major for e in releases
        ):
            gaps.append({
                "runtime": "nim", "major": major, "os": "all", "arch": "all",
                "reason": (
                    "Predates the project's rename from 'Nimrod' to 'Nim' at v0.10.2 "
                    "(2014); nim-lang.org has never hosted these (it postdates the "
                    "rename) and the former nimrod-lang.org domain no longer resolves. "
                    "No binaries or source could be located for this major."
                ),
                "looked_at": [
                    DOWNLOAD_BASE + f"nim-{v}.tar.xz" for v in sorted(versions_by_major[major])
                ] + ["http://nimrod-lang.org/ (domain does not resolve)"],
            })

    for major in majors_sorted:
        if major in ("0.8", "0.9"):
            continue
        oses_with_binary = by_major_os_binary.get(major, set())
        for os_ in ("windows", "linux", "macos"):
            if os_ in oses_with_binary:
                continue
            newest = max(versions_by_major[major], key=parse_version_tuple)
            gaps.append({
                "runtime": "nim", "major": major, "os": os_, "arch": "all",
                "reason": {
                    "windows": "No Windows build (.zip/.exe) found on nim-lang.org for any "
                               f"{major}.x release.",
                    "linux": "No Linux build found on nim-lang.org for any "
                             f"{major}.x release (Linux binaries only began at 0.20.0); "
                             "source build is the only option.",
                    "macos": "nim-lang.org ships no official macOS binary for this major "
                             "(confirmed by choosenim's own download.nim, which only builds "
                             "a binary URL `when defined(Windows) or defined(linux)`), and "
                             "no nim-lang/nightlies backport build for this version is linked "
                             "from install.html either.",
                }[os_],
                "looked_at": [
                    DOWNLOAD_BASE + f"nim-{newest}-{'linux_' if os_=='linux' else ('macosx_' if os_=='macos' else '')}x64.tar.xz"
                    if os_ != "windows" else DOWNLOAD_BASE + f"nim-{newest}_x64.zip",
                    INSTALL_PAGE,
                ],
            })
    return gaps


# --------------------------------------------------------- download plan --

def build_download_plan(releases):
    by_major_os_binary_versions = defaultdict(lambda: defaultdict(list))
    source_by_major = defaultdict(list)
    for e in releases:
        if e["kind"] == "source":
            source_by_major[e["major"]].append(e)
        elif e["os"] in PLAN_OSES:
            by_major_os_binary_versions[e["major"]][e["os"]].append(e)

    def sort_key(c):
        return (c["size"] if c["size"] is not None else float("inf"), c.get("variant") or "")

    plan = []

    # Real binaries: newest patch per (major, os, arch), archive preferred.
    groups = defaultdict(list)
    for e in releases:
        if e["os"] not in PLAN_OSES or e["arch"] == "any":
            continue
        groups[(e["major"], e["os"], e["arch"])].append(e)

    for (major, os_, arch), cands in groups.items():
        newest = max(parse_version_tuple(c["version"]) for c in cands)
        newest_cands = [c for c in cands if parse_version_tuple(c["version"]) == newest]
        archives = [c for c in newest_cands if c["kind"] == "archive"]
        pool = archives if archives else newest_cands
        plan.append(dict(sorted(pool, key=sort_key)[0]))

    # Source fallback: for every (major, os) with zero binaries, add the
    # newest source tarball, relabelled with that os so the plan always
    # has *something* for every major/os the schema asks about.
    for major, oses in by_major_os_binary_versions.items():
        pass  # handled by presence check below
    majors = {e["major"] for e in releases}
    for major in majors:
        srcs = sorted(source_by_major.get(major, []),
                       key=lambda c: parse_version_tuple(c["version"]), reverse=True)
        if not srcs:
            continue
        best_src = min(srcs, key=lambda c: (c["version"] != srcs[0]["version"], sort_key(c)))
        # newest-version source entries only, smallest format among those
        newest_v = srcs[0]["version"]
        newest_srcs = [c for c in srcs if c["version"] == newest_v]
        best_src = sorted(newest_srcs, key=sort_key)[0]
        for os_ in PLAN_OSES:
            has_binary = any(
                e["major"] == major and e["os"] == os_ and e["kind"] != "source"
                for e in releases
            )
            if has_binary:
                continue
            entry = dict(best_src)
            entry["os"] = os_
            entry["notes"] = ((entry["notes"] + " ") if entry.get("notes") else "") + \
                f"No {os_} binary exists for major {major}; source is the only option."
            plan.append(entry)

    plan.sort(key=lambda e: (parse_version_tuple(e["version"]), e["os"], e["arch"]), reverse=True)
    return plan


# ------------------------------------------------------------------ main --

def main():
    print("fetching tags ...")
    tags = gh_tags()
    versions = [v for v, _ in tags]
    print(f"  {len(versions)} stable version tags "
          f"({min(versions, key=parse_version_tuple)} .. {max(versions, key=parse_version_tuple)})")

    print("fetching commit dates ...")
    shas = [sha for _, sha in tags]
    dates_by_sha = gh_commit_dates(shas)
    dates_by_version = {v: dates_by_sha.get(sha) for v, sha in tags}
    print(f"  {sum(1 for d in dates_by_version.values() if d)}/{len(versions)} dated")

    direct_releases, found_keys = scrape_direct(versions)

    print(f"fetching {INSTALL_PAGE} for the nightlies-backport table ...")
    nightlies_releases, rows = scrape_nightlies_table(found_keys)

    releases = direct_releases + nightlies_releases
    for e in releases:
        e["released"] = dates_by_version.get(e["version"])
    releases.sort(key=lambda e: (parse_version_tuple(e["version"]), e["os"], e["arch"], e["kind"]))

    print(f"built {len(releases)} release entries "
          f"({len(direct_releases)} direct + {len(nightlies_releases)} nightlies-backfill)")

    gaps = build_gaps(releases, versions)
    plan = build_download_plan(releases)

    mirrors_doc = {
        "runtime": "nim",
        "canonical": DOWNLOAD_BASE + "<filename>",
        "confirmed": [],
        "rejected": [],
        "note": "Populated by extra_mirrors.py (mirror hunt, round 2); scrape.py does not touch mirrors.",
    }
    mirrors_path = HERE / "mirrors.json"
    if not mirrors_path.exists():
        mirrors_path.write_text(json.dumps(mirrors_doc, indent=2) + "\n")

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")

    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    print(f"wrote releases.json ({len(releases)}), gaps.json ({len(gaps)}), "
          f"download_plan.json ({len(plan)}, {total_gb:.3f} GB)")


if __name__ == "__main__":
    main()
