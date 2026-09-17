#!/usr/bin/env python3
"""Build the Zig runtime catalog from ziglang.org's own release index.

Re-runnable, Python 3 standard library only. Writes releases.json,
gaps.json, download_plan.json, mirrors.json alongside this script.

Source (fetched fresh on every run):

- https://ziglang.org/download/index.json
  The Zig project's own machine-readable release index. Unlike Go's
  equivalent, this one already goes all the way back to Zig's first
  ever tagged release (0.1.1, 2017-10-17) -- confirmed by diffing the
  version set found here against the version numbers linked from the
  HTML page at https://ziglang.org/download/ (identical, modulo the
  in-development "master" entry, which is dropped: this catalog is
  stable releases only) and against `gh release list --repo ziglang/zig`
  (same versions through 0.15.1; see NOTES.md for the one discrepancy
  found -- 0.15.2 and 0.16.0 exist in ziglang.org's index/page but not
  in GitHub's release list at the time of this run).

  Because of that, no GitHub-releases fallback or ziglang.org/download/<ver>/
  per-version listing scrape was needed for coverage -- both are noted in
  the module docstring as available fallbacks but were not required.

  Each version entry is a dict keyed by target triple (e.g. "x86_64-linux",
  "aarch64-macos", "x86_64-windows") plus a few fixed keys: "date",
  "docs", "notes", "stdDocs", optionally "version", and two non-per-target
  downloads: "src" (source tarball) and "bootstrap" (the zig-bootstrap
  meta-tarball: Zig's own source plus vendored LLVM/LLD/zlib/zstd source,
  for building a working Zig from nothing but a C++ compiler and CMake --
  documented as its own kind="source" variant="bootstrap" entry, not a
  per-platform binary). Every per-target value is
  {"tarball": <url>, "shasum": <sha256 hex>, "size": <string int>}.

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
from pathlib import Path

HERE = Path(__file__).resolve().parent

INDEX_URL = "https://ziglang.org/download/index.json"
USER_AGENT = "installer-builder-catalog/1.0 (+scrape.py; HEAD requests only)"
TIMEOUT = 25

# Zig's target-triple strings -> catalog (os, arch). Zig binaries are
# statically linked (musl internally on Linux) so `libc` is left null
# throughout -- there is no separate glibc/musl choice to make, unlike
# most other Linux toolchains in this catalog.
TARGET_MAP = {
    "x86_64-linux": ("linux", "amd64"),
    "aarch64-linux": ("linux", "arm64"),
    "armv7a-linux": ("linux", "armv7"),
    "arm-linux": ("linux", "armv7"),  # 0.15.1+ renamed armv7a-linux -> arm-linux
    "armv6kz-linux": ("linux", "armv6"),  # 0.6.0 only; ARM1176JZF-S (Raspberry Pi 1) baseline
    "riscv64-linux": ("linux", "riscv64"),
    "loongarch64-linux": ("linux", "loong64"),
    "s390x-linux": ("linux", "s390x"),
    "powerpc64le-linux": ("linux", "ppc64le"),
    "x86-linux": ("linux", "x86"),
    "i386-linux": ("linux", "x86"),  # pre-0.11.0 name for the same target
    "x86_64-macos": ("macos", "amd64"),
    "aarch64-macos": ("macos", "arm64"),
    "x86_64-windows": ("windows", "amd64"),
    "aarch64-windows": ("windows", "arm64"),
    "x86-windows": ("windows", "x86"),
    "i386-windows": ("windows", "x86"),  # pre-0.11.0 name
    "x86_64-freebsd": ("freebsd", "amd64"),
    "aarch64-freebsd": ("freebsd", "arm64"),
    "arm-freebsd": ("freebsd", "armv7"),
    "riscv64-freebsd": ("freebsd", "riscv64"),
    "powerpc64-freebsd": ("freebsd", "ppc64"),
    "powerpc64le-freebsd": ("freebsd", "ppc64le"),
    "aarch64-netbsd": ("netbsd", "arm64"),
    "x86-netbsd": ("netbsd", "x86"),
    "x86_64-netbsd": ("netbsd", "amd64"),
    "arm-netbsd": ("netbsd", "armv7"),
    "aarch64-openbsd": ("openbsd", "arm64"),
    "arm-openbsd": ("openbsd", "armv7"),
    "riscv64-openbsd": ("openbsd", "riscv64"),
    "x86_64-openbsd": ("openbsd", "amd64"),
}
# Targets ziglang.org has shipped that have no slot in the catalog's fixed
# ARCH enum (SCHEMA.md / validate.py): 32-bit PowerPC. Recorded and
# counted, not silently dropped -- see NOTES.md (same treatment as Go's
# mips/mipsle/mips64 in catalog/go).
UNMAPPABLE_TARGETS = {"powerpc-linux"}

NON_TARGET_KEYS = {"date", "docs", "notes", "stdDocs", "version"}
PLAN_OSES = {"windows", "linux", "macos"}


def fetch_url(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def fetch_json(url: str):
    return json.loads(fetch_url(url))


def head(url: str):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            cl = r.headers.get("Content-Length")
            return r.status, (int(cl) if cl is not None else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def major_of(version: str) -> str:
    """'0.14.1' -> '0.14'; '1.2.0' -> '1.2' (future-proofing for a 1.x line)."""
    m = re.match(r"^(\d+)\.(\d+)", version)
    return f"{m.group(1)}.{m.group(2)}" if m else version


def parse_version_tuple(version: str):
    parts = [int(p) for p in re.findall(r"\d+", version)][:3]
    while len(parts) < 3:
        parts.append(0)
    return tuple(parts)


def format_of(filename: str) -> str | None:
    if filename.endswith(".tar.xz"):
        return "tar.xz"
    if filename.endswith(".zip"):
        return "zip"
    return None


def build_releases(index):
    releases = []
    skipped_unmappable = defaultdict(int)

    versions = [v for v in index if v != "master"]
    versions.sort(key=parse_version_tuple)

    for version in versions:
        entry_data = index[version]
        major = major_of(version)
        released = entry_data.get("date")

        for key, val in entry_data.items():
            if key in NON_TARGET_KEYS:
                continue
            if not isinstance(val, dict) or "tarball" not in val:
                continue

            filename = val["tarball"].rsplit("/", 1)[-1]

            if key == "src":
                os_val, arch_val, kind, variant = "linux", "any", "source", None
                notes = ("Source tarball; ziglang.org serves this as the build for any "
                         "POSIX/Unix host (\"os\": \"linux\" here is this catalog's "
                         "convention for source-only entries, not a Zig-specific limit).")
            elif key == "bootstrap":
                os_val, arch_val, kind, variant = "linux", "any", "source", "bootstrap"
                notes = ("zig-bootstrap: a meta-tarball bundling Zig's own source plus "
                         "vendored LLVM/LLD/zlib/zstd source, for building a working Zig "
                         "from nothing but a C++ compiler and CMake -- not a per-platform "
                         "binary and not required for a normal install.")
            elif key in UNMAPPABLE_TARGETS:
                skipped_unmappable[key] += 1
                continue
            elif key in TARGET_MAP:
                os_val, arch_val = TARGET_MAP[key]
                kind, variant, notes = "archive", None, None
            else:
                # Unknown target string ziglang.org started shipping after this
                # script was written -- surfaced loudly rather than silently
                # dropped or guessed at.
                print(f"warning: unrecognised target key {key!r} in version {version}; skipping", file=sys.stderr)
                continue

            size_raw = val.get("size")
            size = int(size_raw) if size_raw is not None else None
            shasum = val.get("shasum")
            checksum = {"algo": "sha256", "value": shasum, "source": INDEX_URL} if shasum else None

            entry = {
                "runtime": "zig",
                "languages": ["zig", "c", "cpp"],
                "major": major,
                "version": version,
                "os": os_val,
                "arch": arch_val,
                "kind": kind,
                "format": format_of(filename),
                "variant": variant,
                "libc": None,
                "url": val["tarball"],
                "mirrors": [],
                "checksum": checksum,
                "size": size,
                "released": released,
                "min_os": None,
                "metadata_source": INDEX_URL,
                "notes": notes,
            }
            releases.append(entry)

    return releases, skipped_unmappable


def build_gaps(releases):
    """Major-level gaps: a plausible (major, os, arch) that ziglang.org's
    index shows for adjacent majors but not for ANY patch within this major.

    Found by diffing consecutive versions' target sets (see NOTES.md for
    the full diff); only entries where every patch release in the major is
    missing the target are recorded here -- a target missing from one
    patch but present in another patch of the *same* major isn't a gap
    (download_plan.json just falls back to the older patch that has it),
    matching how catalog/go treats its darwin dual-target case.
    """
    have = {(e["major"], e["os"], e["arch"]) for e in releases}
    candidates = [
        {
            "major": "0.10", "os": "windows", "arch": "x86",
            "reason": (
                "ziglang.org's index has no windows/x86 (i386-windows / x86-windows) "
                "build for either 0.10.0 or 0.10.1, the only two patches in this major. "
                "32-bit Windows was shipped continuously from 0.6.0 through 0.9.1 "
                "(as \"i386-windows\") and comes back at 0.11.0 (renamed \"x86-windows\"), "
                "so this looks like a real gap in the 0.10 line rather than a target "
                "that didn't exist yet."
            ),
            "looked_at": ["https://ziglang.org/download/index.json", "https://ziglang.org/download/"],
        },
        {
            "major": "0.14", "os": "freebsd", "arch": "amd64",
            "reason": (
                "ziglang.org's index has no freebsd/amd64 (x86_64-freebsd) build for "
                "either 0.14.0 or 0.14.1, the only two patches in this major. "
                "x86_64-freebsd is present continuously from 0.11.0 through 0.13.0 and "
                "comes back at 0.15.1, so this looks like a real gap in the 0.14 line."
            ),
            "looked_at": ["https://ziglang.org/download/index.json", "https://ziglang.org/download/"],
        },
        {
            "major": "0.16", "os": "freebsd", "arch": "ppc64",
            "reason": (
                "ziglang.org's index has no freebsd/ppc64 (powerpc64-freebsd) build for "
                "0.16.0, the only patch in this major so far. powerpc64-freebsd was newly "
                "added at 0.15.1 and is present in both 0.15.1 and 0.15.2, so its absence "
                "in 0.16.0 looks like a dropped target rather than one not yet built -- "
                "worth re-checking once a 0.16.x patch release exists."
            ),
            "looked_at": ["https://ziglang.org/download/index.json", "https://ziglang.org/download/"],
        },
    ]
    gaps = []
    for g in candidates:
        key = (g["major"], g["os"], g["arch"])
        if key in have:
            continue  # sanity check: don't record a gap that's actually covered
        gaps.append({"runtime": "zig", **g})
    return gaps


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
    print(f"  {len(index)} version entries (including 'master', dropped below)")

    releases, skipped = build_releases(index)
    print(f"built {len(releases)} release entries")
    for target, n in skipped.items():
        print(f"  skipped {n} file(s) with unmappable target {target!r}")

    gaps = build_gaps(releases)
    plan = build_download_plan(releases)

    mirrors_doc = {
        "runtime": "zig",
        "canonical": "https://ziglang.org/download/<version>/<filename>",
        "confirmed": [],
        "rejected": [],
        "note": (
            "scrape.py records no mirrors itself; see extra_mirrors.py "
            "(catalog/zig/extra_mirrors.py) for the community-mirror and "
            "distro-cache mirror hunt, run separately and re-applied after "
            "every scrape.py run."
        ),
    }

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2, sort_keys=False) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2) + "\n")
    print("note: this resets mirrors.json and every entry's mirrors:[] -- "
          "re-run extra_mirrors.py afterwards to reapply the confirmed mirror hunt")

    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    print(f"wrote releases.json ({len(releases)}), gaps.json ({len(gaps)}), "
          f"download_plan.json ({len(plan)}, {total_gb:.2f} GB)")


if __name__ == "__main__":
    main()
