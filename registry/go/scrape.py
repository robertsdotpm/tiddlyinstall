#!/usr/bin/env python3
"""Build the Go runtime catalog from official Go sources.

Re-runnable, Python 3 standard library only. Writes releases.json,
gaps.json, download_plan.json, mirrors.json alongside this script.

Sources (all fetched fresh on every run):

- https://go.dev/dl/?mode=json&include=all
  The Go team's own machine-readable release index: every file Go has
  ever shipped for every version still listed, with filename, os, arch,
  version, sha256, size and kind (archive/installer/source). This is
  the primary source for everything in releases.json. It only goes back
  to go1.2.2 -- go1, go1.0.x, go1.1.x and the initial go1.2 are no
  longer listed here (see "pre-1.2.2" below and gaps.json).

- https://raw.githubusercontent.com/golang/website/master/internal/history/release.go
  The Go project's own release-history source file (part of the
  golang/website repo that builds go.dev). It contains a Go slice
  literal of `{Date: Date{Y,M,D}, Version: Version{maj,min,patch}}`
  entries. Parsed with a regex (not compiled/executed) purely to
  recover a `released` date per version, since the JSON index above
  carries no date field at all. The file states in a comment that
  point releases before roughly 1.19 usually don't have a dated entry
  of their own; where that's true we leave `released` null rather than
  guess (the schema does not require `released`).

- HEAD requests to https://dl.google.com/go/<filename>
  Used only for two narrow, bounded things:
    1. Backfilling `size` for the handful of very old files (go1.2.2
       through go1.4.2) where the JSON index reports size 0.
    2. Confirming candidate mirror hosts on a small sample of files
       spanning old and new releases (see mirrors.json / MIRROR_SAMPLE).
  No runtime files are ever downloaded in full -- HEAD only, capped at
  MAX_WORKERS concurrent requests.

Everything fetched is untrusted network data; nothing in it is treated
as instructions, only as filenames/sizes/hashes/dates to record.
"""
from __future__ import annotations

import json
import re
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent

INDEX_URL = "https://go.dev/dl/?mode=json&include=all"
HISTORY_URL = "https://raw.githubusercontent.com/golang/website/master/internal/history/release.go"
DL_BASE = "https://dl.google.com/go/"
USER_AGENT = "installer-builder-catalog/1.0 (+scrape.py; HEAD requests only)"
MAX_WORKERS = 10
TIMEOUT = 25

OS_MAP = {"darwin": "macos"}

# Go's JSON arch strings -> catalog ARCH enum.
# "arm", "arm6" and "armv6l" are all the same 32-bit soft/GOARM=6 ARM
# build; Go only ships one 32-bit ARM binary per platform, called "arm"
# in the JSON for freebsd/netbsd/openbsd/plan9/windows and "armv6l" for
# linux (and once "arm6" for an old linux beta). All three map to the
# catalog's "armv6".
ARCH_MAP = {
    "386": "x86",
    "amd64": "amd64",
    "arm": "armv6",
    "arm6": "armv6",
    "armv6l": "armv6",
    "arm64": "arm64",
    "ppc64": "ppc64",
    "ppc64le": "ppc64le",
    "s390x": "s390x",
    "riscv64": "riscv64",
    "loong64": "loong64",
    "mips64le": "mips64le",
}
# JSON arches Go ships that have no slot in the catalog's fixed ARCH
# enum (SCHEMA.md / validate.py): big-endian mips64, and the 32-bit
# mips/mipsle big/little variants. Recorded and counted, not silently
# dropped -- see NOTES.md.
UNMAPPABLE_ARCH = {"mips", "mipsle", "mips64"}

# Candidate mirrors from the brief, HEAD-confirmed below on a sample
# spanning old and new releases before being trusted for every file.
CANDIDATE_MIRRORS = {
    "golang.google.cn": "https://golang.google.cn/dl/{filename}",
    "mirrors.aliyun.com": "https://mirrors.aliyun.com/golang/{filename}",
    "mirrors.ustc.edu.cn": "https://mirrors.ustc.edu.cn/golang/{filename}",
    "mirrors.huaweicloud.com": "https://mirrors.huaweicloud.com/go/{filename}",
    "mirrors.nju.edu.cn": "https://mirrors.nju.edu.cn/golang/{filename}",
}
# Old-to-new spread, matching the "sample >=5 files, old and new" rule.
MIRROR_SAMPLE = [
    "go1.2.2.linux-amd64.tar.gz",
    "go1.5.4.linux-amd64.tar.gz",
    "go1.10.8.linux-amd64.tar.gz",
    "go1.16.15.linux-amd64.tar.gz",
    "go1.21.0.windows-amd64.zip",
    "go1.27.1.linux-amd64.tar.gz",
]

PLAN_OSES = {"windows", "linux", "macos"}


def fetch_url(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def fetch_json(url: str):
    return json.loads(fetch_url(url))


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Blocks automatic redirect-following so a HEAD's *first* response is
    what we see. A mirror that 302s straight back to dl.google.com isn't
    an independent copy -- it's a redirector -- and following the
    redirect would make it look "confirmed" by matching the canonical
    size, which it trivially would, since it's the same bytes.
    """

    def redirect_request(self, *args, **kwargs):
        return None


_NO_REDIRECT_OPENER = urllib.request.build_opener(_NoRedirect)


def head(url: str, follow_redirects: bool = True):
    """Return (status, content_length_or_None). Never raises.

    status is the *first-hop* HTTP status when follow_redirects=False,
    so a 302 is reported as 302 (with location available via a second
    call) rather than silently resolved to whatever it points at.
    """
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


def head_location(url: str):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with _NO_REDIRECT_OPENER.open(req, timeout=TIMEOUT) as r:
            return r.headers.get("Location")
    except urllib.error.HTTPError as e:
        return e.headers.get("Location") if e.headers else None
    except Exception:
        return None


def head_many(urls, workers=MAX_WORKERS, follow_redirects=True):
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = ex.map(lambda u: head(u, follow_redirects=follow_redirects), urls)
        for url, res in zip(urls, futs):
            results[url] = res
    return results


def build_release_dates():
    """Parse golang/website's release.go for {version: 'YYYY-MM-DD'}.

    Best effort: the file itself says older point releases often aren't
    listed individually, so many older patch versions won't be found
    here and are left with released=None rather than guessed.
    """
    try:
        text = fetch_url(HISTORY_URL).decode("utf-8", "replace")
    except Exception as e:
        print(f"warning: could not fetch release history ({e}); released dates will be null", file=sys.stderr)
        return {}
    pat = re.compile(
        r"Date:\s*Date\{(\d+),\s*(\d+),\s*(\d+)\},\s*Version:\s*Version\{(\d+)(?:,\s*(\d+))?(?:,\s*(\d+))?\}"
    )
    dates = {}
    for y, mo, d, maj, minor, patch in pat.findall(text):
        key = (int(maj), int(minor or 0), int(patch or 0))
        dates[key] = f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return dates


def parse_version_tuple(version: str):
    """'1.2.2' -> (1,2,2); '1.4' -> (1,4,0); '1' -> (1,0,0)."""
    parts = [int(p) for p in version.split(".")]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts[:3])


def major_of(version: str) -> str:
    m = re.match(r"^(\d+\.\d+)", version)
    return m.group(1) if m else version


def darwin_variant(filename: str):
    m = re.search(r"-osx(10\.\d+)\.", filename)
    if not m:
        return None, None
    return f"osx{m.group(1)}", f"OS X {m.group(1)}+"


def format_of(filename: str):
    for ext in (".tar.gz", ".zip", ".pkg", ".msi"):
        if filename.endswith(ext):
            return ext[1:]
    return None


def build_releases(index, dates):
    releases = []
    skipped_unmapped_arch = defaultdict(int)
    skipped_bootstrap = 0
    zero_size_urls = []  # (release_dict) needing a HEAD backfill

    for ver_entry in index:
        if not ver_entry.get("stable"):
            continue
        for f in ver_entry.get("files", []):
            filename = f["filename"]
            if "bootstrap" in filename:
                skipped_bootstrap += 1
                continue

            kind = f["kind"]
            version = f["version"][2:] if f["version"].startswith("go") else f["version"]
            vtuple = parse_version_tuple(version)
            major = major_of(version)

            if kind == "source":
                os_val, arch_val = "linux", "any"
            else:
                os_val = OS_MAP.get(f["os"], f["os"])
                arch_raw = f["arch"]
                if arch_raw in UNMAPPABLE_ARCH:
                    skipped_unmapped_arch[arch_raw] += 1
                    continue
                arch_val = ARCH_MAP.get(arch_raw)
                if arch_val is None:
                    skipped_unmapped_arch[arch_raw or "(empty)"] += 1
                    continue

            fmt = format_of(filename)
            variant, min_os = (None, None)
            if os_val == "macos":
                variant, min_os = darwin_variant(filename)

            sha256 = f.get("sha256") or ""
            checksum = (
                {"algo": "sha256", "value": sha256, "source": INDEX_URL}
                if sha256
                else None
            )

            size = f.get("size") or None
            url = DL_BASE + filename

            entry = {
                "runtime": "go",
                "languages": ["go"],
                "major": major,
                "version": version,
                "os": os_val,
                "arch": arch_val,
                "kind": kind,
                "format": fmt,
                "variant": variant,
                "libc": None,
                "url": url,
                "mirrors": [],
                "checksum": checksum,
                "size": size,
                "released": dates.get(vtuple),
                "min_os": min_os,
                "metadata_source": INDEX_URL,
                "notes": None,
            }
            if size is None:
                zero_size_urls.append(entry)
            releases.append(entry)

    return releases, zero_size_urls, skipped_unmapped_arch, skipped_bootstrap


def backfill_sizes(zero_size_entries):
    if not zero_size_entries:
        return 0
    urls = [e["url"] for e in zero_size_entries]
    results = head_many(urls)
    filled = 0
    for e in zero_size_entries:
        status, length = results.get(e["url"], (None, None))
        if status == 200 and length:
            e["size"] = length
            filled += 1
        else:
            e["notes"] = f"size unknown: HEAD {e['url']} returned status={status}"
    return filled


def confirm_mirrors():
    """HEAD each candidate mirror (without following redirects) against
    MIRROR_SAMPLE. A host only counts as a real mirror if it directly
    returns 200 with a Content-Length matching dl.google.com for every
    sample file -- a 302 back to dl.google.com is a redirector, not an
    independent copy, and is rejected even though "following" it would
    trivially "match" (it's the same bytes).
    """
    canonical = head_many([DL_BASE + fn for fn in MIRROR_SAMPLE])
    canonical_size = {fn: canonical[DL_BASE + fn][1] for fn in MIRROR_SAMPLE}

    confirmed = {}
    details = {}
    for host, template in CANDIDATE_MIRRORS.items():
        urls = [template.format(filename=fn) for fn in MIRROR_SAMPLE]
        results = head_many(urls, follow_redirects=False)
        ok = True
        per_file = {}
        for fn, url in zip(MIRROR_SAMPLE, urls):
            status, length = results[url]
            match = status == 200 and canonical_size.get(fn) and length == canonical_size[fn]
            info = {"status": status, "size": length, "matches_canonical": bool(match)}
            if status in (301, 302, 303, 307, 308):
                info["redirects_to"] = head_location(url)
            per_file[fn] = info
            if not match:
                ok = False
        details[host] = {"template": template, "sample_results": per_file, "confirmed": ok}
        if ok:
            confirmed[host] = template
    return confirmed, details


def apply_confirmed_mirrors(releases, confirmed_templates):
    for e in releases:
        filename = e["url"].rsplit("/", 1)[-1]
        e["mirrors"] = [tmpl.format(filename=filename) for tmpl in confirmed_templates.values()]


def build_gaps():
    return [
        {
            "runtime": "go",
            "major": major,
            "os": "all",
            "arch": "all",
            "reason": (
                "go.dev's JSON index (?mode=json&include=all) and its HTML "
                "'all releases' page both start at go1.2.2; the initial "
                f"{label} release predates the project's move of downloads "
                "onto the golang GCS bucket / dl.google.com and is no "
                "longer listed by either. Guessed dl.google.com/go/ "
                "filenames for it all 404, and anonymous listing of the "
                "'golang' GCS bucket (both the XML and JSON list APIs) now "
                "returns 403 Access Denied, so it can't be enumerated "
                "programmatically either."
            ),
            "looked_at": [
                "https://go.dev/dl/?mode=json&include=all",
                "https://go.dev/dl/",
                "https://storage.googleapis.com/golang/?marker=",
                "https://storage.googleapis.com/storage/v1/b/golang/o",
                "https://dl.google.com/go/ (guessed pre-1.2.2 filenames, 404)",
            ],
        }
        for major, label in (("1.0", "go1/go1.0.x"), ("1.1", "go1.1.x"), ("1.2", "go1.2 (pre-.2.2)"))
    ]


def build_download_plan(releases):
    groups = defaultdict(list)
    for e in releases:
        if e["os"] not in PLAN_OSES:
            continue
        if e["arch"] == "any":  # source, not a per-platform download
            continue
        groups[(e["major"], e["os"], e["arch"])].append(e)

    plan = []
    for key, candidates in groups.items():
        newest = max(parse_version_tuple(c["version"]) for c in candidates)
        newest_candidates = [c for c in candidates if parse_version_tuple(c["version"]) == newest]

        archives = [c for c in newest_candidates if c["kind"] == "archive"]
        pool = archives if archives else newest_candidates

        def sort_key(c):
            return (c["size"] if c["size"] is not None else float("inf"), c.get("variant") or "")

        pool_sorted = sorted(pool, key=sort_key)
        plan.append(dict(pool_sorted[0]))
    plan.sort(key=lambda e: (parse_version_tuple(e["version"]), e["os"], e["arch"]), reverse=True)
    return plan


def main():
    print(f"fetching {INDEX_URL} ...")
    index = fetch_json(INDEX_URL)
    print(f"  {len(index)} version entries")

    print(f"fetching {HISTORY_URL} ...")
    dates = build_release_dates()
    print(f"  {len(dates)} dated versions parsed")

    releases, zero_size, skipped_arch, skipped_bootstrap = build_releases(index, dates)
    print(f"built {len(releases)} release entries")
    print(f"  skipped {skipped_bootstrap} bootstrap tarball(s)")
    for arch, n in skipped_arch.items():
        print(f"  skipped {n} files with unmappable arch {arch!r}")

    print(f"backfilling size via HEAD for {len(zero_size)} zero-size entries ...")
    filled = backfill_sizes(zero_size)
    print(f"  filled {filled}/{len(zero_size)}")

    print("confirming candidate mirrors on sample files ...")
    confirmed, mirror_details = confirm_mirrors()
    print(f"  confirmed: {sorted(confirmed)}")
    apply_confirmed_mirrors(releases, confirmed)

    gaps = build_gaps()
    plan = build_download_plan(releases)

    mirrors_doc = {
        "runtime": "go",
        "canonical": DL_BASE + "<filename>",
        "confirmed": [
            {
                "host": host,
                "url_template": tmpl,
                "confirmed_by": "HEAD request, Content-Length matched dl.google.com for every sample file",
                "sample_files": MIRROR_SAMPLE,
                "applied_to": "every release entry with a matching filename (not re-checked per file)",
            }
            for host, tmpl in confirmed.items()
        ],
        "rejected": [
            {"host": host, "url_template": d["template"], "reason": "sample did not confirm", "sample_results": d["sample_results"]}
            for host, d in mirror_details.items()
            if not d["confirmed"]
        ],
    }

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2, sort_keys=False) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2) + "\n")

    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    print(f"wrote releases.json ({len(releases)}), gaps.json ({len(gaps)}), "
          f"download_plan.json ({len(plan)}, {total_gb:.2f} GB), mirrors.json")


if __name__ == "__main__":
    main()
