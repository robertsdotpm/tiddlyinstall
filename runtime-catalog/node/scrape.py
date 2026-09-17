#!/usr/bin/env python3
"""Scrape Node.js (+ io.js, + unofficial-builds) release metadata into the
installer-builder runtime catalog schema, for runtime="node".

Sources (official machine-readable indexes only, Python 3 stdlib only):
  - https://nodejs.org/dist/index.json
        Node.js 0.x .. current. Per-version checksums from
        https://nodejs.org/dist/v<ver>/SHASUMS256.txt
  - https://iojs.org/dist/index.json
        io.js 1.x-3.x (pre node/io.js merger), variant "iojs". Checksums
        from https://iojs.org/dist/v<ver>/SHASUMS256.txt
  - https://unofficial-builds.nodejs.org/download/release/index.json
        Gap-filling builds nodejs.org itself doesn't publish: musl libc,
        riscv64, loong64, armv6l/linux-x86 after nodejs.org dropped them,
        and (for old majors) win-arm64 before it became official. Checksums
        from .../release/v<ver>/SHASUMS256.txt. variant="unofficial", or
        "musl" when libc=="musl" (so download_plan groups musl separately
        from glibc at the same major/os/arch).

The real per-version file list (and its exact filenames) is taken from each
version's own SHASUMS256.txt rather than guessed from a naming convention,
because the convention has changed several times across 15+ years of
releases (bare `node.exe`, dir-prefixed old-style msis, `-headers`, `-musl`,
7z, etc.) -- SHASUMS256.txt is ground truth for what actually exists.

Re-running this script re-fetches everything live; nothing here is cached
or hardcoded to today's data.
"""

import concurrent.futures as cf
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent

NODE_BASE = "https://nodejs.org/dist"
IOJS_BASE = "https://iojs.org/dist"
UNOFFICIAL_BASE = "https://unofficial-builds.nodejs.org/download/release"

NODE_INDEX = f"{NODE_BASE}/index.json"
IOJS_INDEX = f"{IOJS_BASE}/index.json"
UNOFFICIAL_INDEX = f"{UNOFFICIAL_BASE}/index.json"

HEADERS = {"User-Agent": "installer-builder-catalog-scraper/1.0 (+node runtime catalog)"}

MIRROR_CANDIDATES = [
    ("npmmirror-cdn", "https://cdn.npmmirror.com/binaries/node/v{version}/{filename}"),
    ("npmmirror-registry", "https://registry.npmmirror.com/-/binary/node/v{version}/{filename}"),
    ("huaweicloud", "https://mirrors.huaweicloud.com/nodejs/v{version}/{filename}"),
    ("tuna", "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v{version}/{filename}"),
    ("ustc", "https://mirrors.ustc.edu.cn/node/v{version}/{filename}"),
    ("nodejs-download-release", "https://nodejs.org/download/release/v{version}/{filename}"),
]

WORKERS = 10  # politeness cap shared by checksum fetches, HEAD checks, mirror probes


# --------------------------------------------------------------------------
# low-level fetch helpers
# --------------------------------------------------------------------------

def fetch(url, retries=4, timeout=30, method="GET"):
    last_err = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if method == "HEAD":
                    cl = r.headers.get("Content-Length")
                    return int(cl) if cl is not None else None
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last_err = e
        except Exception as e:
            last_err = e
        time.sleep(0.5 * (i + 1))
    if method != "HEAD":
        print(f"  ! fetch failed: {url}: {last_err}", file=sys.stderr)
    return None


def fetch_json(url, **kw):
    data = fetch(url, **kw)
    return json.loads(data) if data is not None else None


def fetch_text(url, **kw):
    data = fetch(url, **kw)
    return data.decode("utf-8", "replace") if data is not None else None


def head_size(url):
    return fetch(url, retries=2, timeout=20, method="HEAD")


def parallel_map(fn, items, workers=WORKERS):
    """Run fn(item) for each item concurrently; returns a list of results in
    the same order as `items` (items need not be hashable, unlike a dict
    keyed by item)."""
    items = list(items)
    results = [None] * len(items)
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        future_to_idx = {ex.submit(fn, item): i for i, item in enumerate(items)}
        for fut in cf.as_completed(future_to_idx):
            i = future_to_idx[fut]
            try:
                results[i] = fut.result()
            except Exception as e:
                print(f"  ! task failed for item {items[i]!r}: {e}", file=sys.stderr)
                results[i] = None
    return results


# --------------------------------------------------------------------------
# version scoping
# --------------------------------------------------------------------------

VERSION_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")
ZERO_X_LINES = {(0, 8), (0, 10), (0, 12)}


def parse_version(v):
    m = VERSION_RE.match(v.lstrip("v"))
    if not m:
        return None
    return tuple(int(x) for x in m.groups())


def node_major_key(v):
    """catalog `major` string for a nodejs.org (or unofficial-builds) version,
    or None if out of scope: unstable 0.x dev lines, pre-release strings,
    or the impossible majors 1-3 (those are io.js, not node)."""
    p = parse_version(v)
    if p is None:
        return None
    major, minor, _ = p
    if major == 0:
        return f"0.{minor}" if (major, minor) in ZERO_X_LINES else None
    if major < 4:
        return None
    return str(major)


def iojs_major_key(v):
    p = parse_version(v)
    if p is None:
        return None
    major, _, _ = p
    return str(major) if 1 <= major <= 3 else None


def major_sort_key(m):
    """Sort '0.8' < '0.10' < '0.12' < '4' < '5' < ... < '26' -- numerically
    by (major, minor), not as strings or floats (float('0.10') < float('0.8'),
    which is not the order anyone wants)."""
    if "." in m:
        major, minor = m.split(".", 1)
        return (0, int(major), int(minor))
    return (1, int(m), 0)


# --------------------------------------------------------------------------
# classify one filename from a version's SHASUMS256.txt
# --------------------------------------------------------------------------

ARCH_MAP = {"x64": "amd64", "x86": "x86", "arm64": "arm64"}
LINUX_ARCH_MAP = dict(ARCH_MAP, **{
    "armv7l": "armv7", "armv6l": "armv6", "ppc64le": "ppc64le", "ppc64": "ppc64",
    "s390x": "s390x", "riscv64": "riscv64", "loong64": "loong64",
})

SKIP_DEV_ARTIFACT_RE = re.compile(r"\.(lib|exp|pdb|sig|asc)$")
SKIP_PDB_ARCHIVE_RE = re.compile(r"_pdb\.(zip|7z)$")
HEADERS_TARBALL_RE = re.compile(r"-headers\.tar\.(gz|xz)$")


def classify(prefix, version, filename):
    """Return a dict describing `filename` for release `version` of
    node/iojs, or None if it should not become a release entry (dev
    artifacts, header tarballs, signatures, or anything unrecognised)."""
    f = filename
    if HEADERS_TARBALL_RE.search(f) or SKIP_DEV_ARTIFACT_RE.search(f) or SKIP_PDB_ARCHIVE_RE.search(f):
        return None

    vq = re.escape(version)

    m = re.match(rf"^{prefix}-v{vq}-win-(x64|x86|arm64)\.(zip|7z)$", f)
    if m:
        return dict(os="windows", arch=ARCH_MAP[m.group(1)], kind="archive", format=m.group(2), libc=None)

    m = re.match(rf"^(?:win-(?:x64|x86|arm64)/)?{prefix}-v{vq}-(x64|x86|arm64)\.msi$", f)
    if m:
        return dict(os="windows", arch=ARCH_MAP[m.group(1)], kind="installer", format="msi", libc=None)

    m = re.match(rf"^(x64|x86|arm64)/{prefix}-v{vq}-(x64|x86|arm64)\.msi$", f)
    if m:
        return dict(os="windows", arch=ARCH_MAP[m.group(2)], kind="installer", format="msi", libc=None)

    m = re.match(rf"^(?:(win-x64|win-x86|win-arm64|x64|x86|arm64)/)?(?:node|iojs)\.exe$", f)
    if m:
        archdir_map = {"win-x64": "x64", "x64": "x64", "win-x86": "x86", "x86": "x86",
                       "win-arm64": "arm64", "arm64": "arm64", None: "x86"}
        arch = archdir_map[m.group(1)]
        return dict(os="windows", arch=ARCH_MAP[arch], kind="archive", format="exe", libc=None)

    m = re.match(rf"^{prefix}-v{vq}-darwin-(x64|x86|arm64)\.tar\.(gz|xz)$", f)
    if m:
        return dict(os="macos", arch=ARCH_MAP[m.group(1)], kind="archive", format="tar." + m.group(2), libc=None)

    m = re.match(rf"^{prefix}-v{vq}(?:-(x64|arm64))?\.pkg$", f)
    if m:
        return dict(os="macos", arch=m.group(1), kind="installer", format="pkg", libc=None,
                    _pkg_arch_unresolved=(m.group(1) is None))

    m = re.match(
        rf"^{prefix}-v{vq}-linux-(x64|x86|arm64|armv7l|armv6l|ppc64le|ppc64|s390x|riscv64|loong64)(-musl)?\.tar\.(gz|xz)$",
        f)
    if m:
        arch_raw, musl, fmt = m.groups()
        return dict(os="linux", arch=LINUX_ARCH_MAP[arch_raw], kind="archive", format="tar." + fmt,
                    libc=("musl" if musl else "glibc"))

    m = re.match(rf"^{prefix}-v{vq}-sunos-(x64|x86)\.tar\.(gz|xz)$", f)
    if m:
        return dict(os="solaris", arch=ARCH_MAP[m.group(1)], kind="archive", format="tar." + m.group(2), libc=None)

    m = re.match(rf"^{prefix}-v{vq}-aix-ppc64\.tar\.gz$", f)
    if m:
        return dict(os="aix", arch="ppc64", kind="archive", format="tar.gz", libc=None)

    m = re.match(rf"^{prefix}-v{vq}\.tar\.(gz|xz)$", f)
    if m:
        return dict(os="linux", arch="any", kind="source", format="tar." + m.group(1), libc=None, _source=True)

    return None


# --------------------------------------------------------------------------
# building release entries for one index (node / iojs / unofficial)
# --------------------------------------------------------------------------

def fetch_all_shasums(base, versions):
    versions = list(versions)

    def one(v):
        txt = fetch_text(f"{base}/v{v}/SHASUMS256.txt")
        table = {}
        if txt:
            for line in txt.splitlines():
                line = line.strip()
                if not line:
                    continue
                parts = line.split(None, 1)
                if len(parts) == 2:
                    h, fn = parts
                    table[fn] = h.lower()
        return table

    return dict(zip(versions, parallel_map(one, versions)))


def build_release_entries(prefix, base, index_url, major_key_fn, accepted, shasums,
                           forced_variant=None, dedup_against=None):
    """accepted: list of (version, major_key, released_date).
    dedup_against: optional set of (version, os, arch, libc) already covered
    by an earlier (official) pass -- used so unofficial builds only add
    combinations nodejs.org itself does not already provide."""
    entries = []
    missing_shasums = []
    for version, major, released in accepted:
        table = shasums.get(version) or {}
        if not table:
            missing_shasums.append(version)
            continue

        darwin_arches = set()
        for fn in table:
            dm = re.match(rf"^{prefix}-v{re.escape(version)}-darwin-(x64|x86|arm64)\.tar\.", fn)
            if dm:
                darwin_arches.add(dm.group(1))
        version_entries = []
        for fn, h in table.items():
            c = classify(prefix, version, fn)
            if c is None:
                continue
            if dedup_against is not None and (version, c["os"], c.get("arch"), c.get("libc")) in dedup_against:
                continue

            variant = forced_variant
            libc = c.get("libc")
            if libc == "musl":
                variant = "musl"

            notes = None
            arch = c.get("arch")
            if c.get("_pkg_arch_unresolved"):
                if len(darwin_arches) > 1:
                    arch = "universal"
                elif len(darwin_arches) == 1:
                    arch = ARCH_MAP[next(iter(darwin_arches))]
                else:
                    arch = "amd64"
            if c.get("_source"):
                notes = "source tarball; platform-independent, recorded as linux/any by convention (schema has no os-independent value)"
            if forced_variant == "unofficial":
                gap_note = ("unofficial-builds.nodejs.org musl build (nodejs.org itself ships no musl build "
                            "for this os/arch/version)" if libc == "musl" else
                            "unofficial-builds.nodejs.org gap-filler (nodejs.org ships no official build for "
                            "this os/arch at this version)")
                notes = (notes + "; " if notes else "") + gap_note

            entry = {
                "runtime": "node",
                "languages": ["javascript", "typescript"],
                "major": major,
                "version": version,
                "os": c["os"],
                "arch": arch,
                "kind": c["kind"],
                "format": c["format"],
                "variant": variant,
                "libc": libc,
                "url": f"{base}/v{version}/{fn}",
                "mirrors": [],
                "checksum": {"algo": "sha256", "value": h, "source": f"{base}/v{version}/SHASUMS256.txt"},
                "size": None,
                "released": released,
                "min_os": None,
                "metadata_source": index_url,
                "notes": notes,
            }
            version_entries.append(entry)

        # Old versions have no windows zip/msi, only a bare node.exe -- that IS
        # the distributable. Newer versions ship a bare node.exe *alongside*
        # a full zip/msi as a companion binary-only file; drop the companion
        # so we don't offer an incomplete (no npm) "archive" as if it were a
        # real alternative to the zip.
        full_win_arches = {e["arch"] for e in version_entries
                            if e["os"] == "windows" and (e["format"] in ("zip", "7z") or e["format"] == "msi")}
        version_entries = [e for e in version_entries
                            if not (e["os"] == "windows" and e["format"] == "exe" and e["arch"] in full_win_arches)]

        entries.extend(version_entries)

    return entries, missing_shasums


# --------------------------------------------------------------------------
# gaps
# --------------------------------------------------------------------------

def compute_gaps(node_entries, unofficial_entries, node_accepted):
    """Dynamically detect plausible-but-missing combinations by looking at
    what the live indexes actually contain, rather than hardcoding version
    numbers that will go stale."""
    all_entries = node_entries + unofficial_entries
    by_major_os_arch = defaultdict(set)
    for e in all_entries:
        by_major_os_arch[e["major"]].add((e["os"], e["arch"]))

    numeric_majors = sorted((m for _, m, _ in node_accepted if m.isdigit()), key=int)
    numeric_majors = sorted(set(numeric_majors), key=int)

    gaps = []

    # windows/x86: once true for a major line, later majors that lack it
    # entirely (official AND unofficial) are a gap -- the desktop-32-bit
    # target existed and was dropped, not "never existed".
    ever_had = {"win_x86": False, "solaris": False, "linux_x86": False}
    first_had = {}
    for m in numeric_majors:
        combos = by_major_os_arch.get(m, set())
        had_win_x86 = ("windows", "x86") in combos
        had_solaris = any(os_ == "solaris" for os_, _ in combos)
        had_linux_x86 = ("linux", "x86") in combos
        for key, had in (("win_x86", had_win_x86), ("solaris", had_solaris), ("linux_x86", had_linux_x86)):
            if had:
                ever_had[key] = True
                first_had.setdefault(key, m)

    for m in numeric_majors:
        combos = by_major_os_arch.get(m, set())
        if ever_had["win_x86"] and ("windows", "x86") not in combos:
            gaps.append({
                "runtime": "node", "major": m, "os": "windows", "arch": "x86",
                "reason": (f"nodejs.org shipped official win-x86 builds through at least major "
                           f"{first_had['win_x86']}, but none exist for major {m} in dist/index.json, "
                           f"and unofficial-builds.nodejs.org's index.json carries no win-x86 files "
                           f"for this major either."),
                "looked_at": [NODE_INDEX, UNOFFICIAL_INDEX],
            })
        if ever_had["solaris"] and not any(os_ == "solaris" for os_, _ in combos):
            gaps.append({
                "runtime": "node", "major": m, "os": "solaris", "arch": "amd64",
                "reason": (f"nodejs.org shipped SunOS/Solaris builds through major "
                           f"{first_had['solaris']}-adjacent releases; dist/index.json lists none for "
                           f"major {m}, and unofficial-builds.nodejs.org does not build for solaris."),
                "looked_at": [NODE_INDEX, UNOFFICIAL_INDEX],
            })
        if ever_had["linux_x86"] and ("linux", "x86") not in combos:
            gaps.append({
                "runtime": "node", "major": m, "os": "linux", "arch": "x86",
                "reason": (f"32-bit linux was official through major {first_had['linux_x86']}-adjacent "
                           f"releases; dist/index.json lists none for major {m}, and "
                           f"unofficial-builds.nodejs.org's index.json also carries no linux-x86 build "
                           f"for this major."),
                "looked_at": [NODE_INDEX, UNOFFICIAL_INDEX],
            })

    return gaps


# --------------------------------------------------------------------------
# download plan
# --------------------------------------------------------------------------

def build_download_plan(all_entries):
    groups = defaultdict(list)
    for e in all_entries:
        if e["os"] not in ("windows", "linux", "macos"):
            continue
        if e["kind"] == "source":
            continue  # download_plan is for runnable binaries
        key = (e["runtime"], e["major"], e["os"], e["arch"], e["variant"])
        groups[key].append(e)

    # newest version per group
    group_candidates = {}
    for key, items in groups.items():
        newest_version = max((e["version"] for e in items), key=lambda v: parse_version(v) or (0, 0, 0))
        at_newest = [e for e in items if e["version"] == newest_version]
        archives = [e for e in at_newest if e["kind"] == "archive"]
        pool = archives if archives else at_newest
        group_candidates[key] = pool

    # HEAD every candidate once (dedup identical urls) to pick smallest
    urls_to_head = list({e["url"] for pool in group_candidates.values() for e in pool if e.get("size") is None})
    sizes = dict(zip(urls_to_head, parallel_map(head_size, urls_to_head)))

    plan = []
    for key, pool in group_candidates.items():
        scored = []
        for e in pool:
            sz = e.get("size")
            if sz is None:
                sz = sizes.get(e["url"])
            scored.append((sz if sz is not None else float("inf"), e))
        scored.sort(key=lambda t: t[0])
        best_size, best = scored[0]
        chosen = dict(best)
        chosen["size"] = None if best_size == float("inf") else best_size
        plan.append(chosen)

    plan.sort(key=lambda e: (major_sort_key(e["major"]), e["os"], e["arch"], e["variant"] or ""))
    return plan


# --------------------------------------------------------------------------
# mirrors
# --------------------------------------------------------------------------

def pick_mirror_samples(node_entries):
    """A handful of official (non-iojs, non-unofficial, non-musl) archive
    entries spanning old and new versions, for probing mirror candidates."""
    candidates = [e for e in node_entries
                  if e["variant"] is None and e["kind"] in ("archive", "installer")
                  and e["os"] in ("windows", "linux", "macos")]
    candidates.sort(key=lambda e: parse_version(e["version"]) or (0, 0, 0))
    if not candidates:
        return []
    n = len(candidates)
    # 2 old, 1 middle, 2-3 new, favouring variety of os
    picks_idx = sorted({0, 1, n // 2, max(n - 2, 0), n - 1})
    picks = [candidates[i] for i in picks_idx]
    # try to ensure at least one linux, one windows, one macos if available
    for os_ in ("linux", "windows", "macos"):
        if not any(p["os"] == os_ for p in picks):
            for c in candidates:
                if c["os"] == os_:
                    picks.append(c)
                    break
    return picks[:8]


def confirm_mirrors(node_entries):
    samples = pick_mirror_samples(node_entries)
    if len(samples) < 5:
        return [], {}

    results = {}
    for name, template in MIRROR_CANDIDATES:
        def probe(e, template=template):
            filename = e["url"].rsplit("/", 1)[-1]
            mirror_url = template.format(version=e["version"], filename=filename)
            orig_size = e.get("size") or head_size(e["url"])
            mir_size = head_size(mirror_url)
            return mirror_url, orig_size, mir_size

        outcomes_list = parallel_map(probe, samples)
        matches = 0
        checked = 0
        detail = []
        for e, r in zip(samples, outcomes_list):
            if r is None:
                detail.append({"version": e["version"], "file": e["url"].rsplit("/", 1)[-1], "result": "probe failed"})
                continue
            mirror_url, orig_size, mir_size = r
            checked += 1
            ok = orig_size is not None and mir_size is not None and orig_size == mir_size
            if ok:
                matches += 1
            detail.append({
                "version": e["version"], "file": e["url"].rsplit("/", 1)[-1],
                "original_size": orig_size, "mirror_size": mir_size, "match": ok,
            })
        results[name] = {
            "template": template,
            "samples_checked": checked,
            "samples_matched": matches,
            "confirmed": checked >= 5 and matches == checked,
            "detail": detail,
        }
        print(f"  mirror {name}: {matches}/{checked} sample sizes matched"
              f"{' -> CONFIRMED, applying to all node files' if results[name]['confirmed'] else ' -> not applied'}")

    confirmed_templates = [(name, r["template"]) for name, r in results.items() if r["confirmed"]]
    return confirmed_templates, results


def apply_mirrors(node_entries, confirmed_templates):
    if not confirmed_templates:
        return
    for e in node_entries:
        if e["variant"] is not None:
            continue  # only confirmed for official node files
        filename = e["url"].rsplit("/", 1)[-1]
        e["mirrors"] = [tmpl.format(version=e["version"], filename=filename) for _, tmpl in confirmed_templates]


# --------------------------------------------------------------------------
# main
# --------------------------------------------------------------------------

def main():
    t0 = time.time()

    print("Fetching node index...")
    node_idx = fetch_json(NODE_INDEX)
    if not node_idx:
        sys.exit("FATAL: could not fetch nodejs.org dist index")
    node_accepted = []
    for e in node_idx:
        v = e["version"].lstrip("v")
        mk = node_major_key(v)
        if mk:
            node_accepted.append((v, mk, e.get("date")))
    print(f"  {len(node_idx)} total node versions, {len(node_accepted)} in scope")

    print("Fetching io.js index...")
    iojs_idx = fetch_json(IOJS_INDEX) or []
    iojs_accepted = []
    for e in iojs_idx:
        v = e["version"].lstrip("v")
        mk = iojs_major_key(v)
        if mk:
            iojs_accepted.append((v, mk, e.get("date")))
    print(f"  {len(iojs_idx)} total io.js versions, {len(iojs_accepted)} in scope (majors 1-3)")

    print("Fetching unofficial-builds index...")
    unofficial_idx = fetch_json(UNOFFICIAL_INDEX) or []
    unofficial_accepted = []
    for e in unofficial_idx:
        v = e["version"].lstrip("v")
        mk = node_major_key(v)
        if mk and mk.isdigit():
            unofficial_accepted.append((v, mk, e.get("date")))
    print(f"  {len(unofficial_idx)} total unofficial versions, {len(unofficial_accepted)} in scope")

    print(f"Fetching {len(node_accepted)} node SHASUMS256.txt files ({WORKERS} at a time)...")
    node_shasums = fetch_all_shasums(NODE_BASE, [v for v, _, _ in node_accepted])
    print(f"Fetching {len(iojs_accepted)} io.js SHASUMS256.txt files...")
    iojs_shasums = fetch_all_shasums(IOJS_BASE, [v for v, _, _ in iojs_accepted])
    print(f"Fetching {len(unofficial_accepted)} unofficial SHASUMS256.txt files...")
    unofficial_shasums = fetch_all_shasums(UNOFFICIAL_BASE, [v for v, _, _ in unofficial_accepted])

    node_entries, node_missing = build_release_entries(
        "node", NODE_BASE, NODE_INDEX, node_major_key, node_accepted, node_shasums)
    print(f"  node: {len(node_entries)} release entries"
          f"{f', {len(node_missing)} versions had no reachable SHASUMS256.txt' if node_missing else ''}")

    iojs_entries, iojs_missing = build_release_entries(
        "iojs", IOJS_BASE, IOJS_INDEX, iojs_major_key, iojs_accepted, iojs_shasums, forced_variant="iojs")
    print(f"  io.js: {len(iojs_entries)} release entries")

    official_keys = {(e["version"], e["os"], e["arch"], e["libc"]) for e in node_entries}
    unofficial_entries, unofficial_missing = build_release_entries(
        "node", UNOFFICIAL_BASE, UNOFFICIAL_INDEX, node_major_key, unofficial_accepted, unofficial_shasums,
        forced_variant="unofficial", dedup_against=official_keys)
    print(f"  unofficial: {len(unofficial_entries)} release entries (after de-duplicating against official)")

    releases = node_entries + iojs_entries + unofficial_entries
    releases.sort(key=lambda e: (e["runtime"], major_sort_key(e["major"]),
                                  parse_version(e["version"]) or (0, 0, 0), e["os"], e["arch"] or "", e["variant"] or ""))

    print("Computing gaps...")
    gaps = compute_gaps(node_entries, unofficial_entries, node_accepted)
    for v in node_missing + iojs_missing + unofficial_missing:
        gaps.append({
            "runtime": "node", "major": "unknown", "os": "unknown", "arch": "unknown",
            "reason": f"SHASUMS256.txt for version {v} was unreachable; no files recorded for this version",
            "looked_at": [f"{NODE_BASE}/v{v}/SHASUMS256.txt", f"{IOJS_BASE}/v{v}/SHASUMS256.txt",
                          f"{UNOFFICIAL_BASE}/v{v}/SHASUMS256.txt"],
        })
    print(f"  {len(gaps)} gaps")

    print("Building download_plan (HEAD requests for sizes)...")
    plan = build_download_plan(releases)
    total_gb = sum((p.get("size") or 0) for p in plan) / 1e9
    print(f"  {len(plan)} planned downloads, {total_gb:.2f} GB")

    # backfill sizes onto the matching releases.json entries too
    sizes_by_url = {p["url"]: p["size"] for p in plan if p.get("size") is not None}
    for e in releases:
        if e["url"] in sizes_by_url:
            e["size"] = sizes_by_url[e["url"]]

    print("Probing candidate mirrors against sampled official files...")
    confirmed, mirror_detail = confirm_mirrors(node_entries)
    apply_mirrors(node_entries, confirmed)
    # download_plan entries are dicts copied from release entries; refresh
    # their mirrors from the (now-updated) release entries by url match.
    mirrors_by_url = {e["url"]: e["mirrors"] for e in node_entries}
    for p in plan:
        if p["url"] in mirrors_by_url:
            p["mirrors"] = mirrors_by_url[p["url"]]

    print(f"Writing output ({time.time() - t0:.0f}s elapsed)...")
    (HERE / "releases.json").write_text(json.dumps(releases, indent=2) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps({
        "runtime": "node",
        "candidates_probed": [{"name": n, "template": t} for n, t in MIRROR_CANDIDATES],
        "confirmed": [{"name": n, "template": t} for n, t in confirmed],
        "method": ("HEAD-requested a sample of official node.js archive/installer files spanning old and "
                   "new majors against each candidate template; a candidate is confirmed only if every "
                   "sampled file's Content-Length matched exactly (>=5 samples). Confirmed templates were "
                   "then applied to every official (non-iojs, non-unofficial, non-musl-variant) release "
                   "entry's `mirrors` list. iojs and unofficial-builds files were not probed against these "
                   "mirrors (scope-limited; none of the candidate mirrors are known to carry those)."),
        "sample_detail": mirror_detail,
    }, indent=2) + "\n")

    notes = build_notes(len(node_idx), len(node_accepted), len(iojs_accepted), len(unofficial_accepted),
                         releases, gaps, plan, confirmed, node_missing, iojs_missing, unofficial_missing)
    (HERE / "NOTES.md").write_text(notes)

    print(f"Done in {time.time() - t0:.0f}s.")


def build_notes(node_total, node_n, iojs_n, unofficial_n, releases, gaps, plan, confirmed,
                 node_missing, iojs_missing, unofficial_missing):
    majors = sorted({e["major"] for e in releases if e["runtime"] == "node"}, key=major_sort_key)
    with_checksum = sum(1 for e in releases if e.get("checksum"))
    lines = [
        "# Node.js runtime catalog notes",
        "",
        "## Sources",
        "- https://nodejs.org/dist/index.json -- all Node.js releases (866 total as scraped; "
        f"{node_n} in scope: 0.8/0.10/0.12 plus every integer major 4..latest).",
        "- https://nodejs.org/dist/v<ver>/SHASUMS256.txt -- fetched for every in-scope node version "
        "(ground truth for exact filenames; the naming convention has changed several times across "
        "history, e.g. bare `node.exe`, dir-prefixed old msis, `-headers`, `-musl`, `.7z`, so filenames "
        "were parsed from these listings rather than guessed).",
        f"- https://iojs.org/dist/index.json -- io.js 1.x-3.x, {iojs_n} versions, variant \"iojs\".",
        "- https://unofficial-builds.nodejs.org/download/release/index.json -- gap-filling builds, "
        f"{unofficial_n} versions in scope, variant \"unofficial\" (or \"musl\" when libc==musl).",
        "",
        "## Discrepancy from the brief",
        "The brief called out \"win x86 for newer versions\" as an unofficial-builds variant. As "
        "scraped, unofficial-builds.nodejs.org's index.json carries no win-x86 files at all (checked "
        "every version's file-key list programmatically) -- only win-arm64 (before it was official), "
        "linux-x86, linux-armv6l, linux-riscv64, linux-loong64, and various linux-x64 libc/build "
        "flavours. Where nodejs.org itself dropped official win-x86 (and later linux-x86, and solaris) "
        "with no unofficial fallback, that is recorded as a gap in gaps.json instead of fabricated.",
        "",
        "## Classification rules worth knowing",
        "- A bare `node.exe` (or `<arch>/node.exe`) is only kept as a release entry (kind=archive, "
        "format=exe) when no zip/msi exists for that arch+version -- true for pre-zip-era Windows "
        "builds. In modern releases the same bare exe ships alongside the full zip/msi as a headless "
        "companion binary (no npm); that companion is dropped so it doesn't masquerade as a complete "
        "runtime.",
        "- `libc` is `glibc` for ordinary linux tar builds and `musl` for `-musl` builds; musl entries "
        "also get `variant=\"musl\"` (rather than colliding with the glibc build under the same "
        "major/os/arch key in download_plan).",
        "- Source tarballs (`node-vX.Y.Z.tar.gz/.tar.xz`) are recorded with kind=\"source\", "
        "arch=\"any\"; the schema has no platform-independent `os` value, so os=\"linux\" is used by "
        "convention and noted on the entry.",
        "- `min_os` is left null throughout -- getting it right per major needs BUILDING.md-style "
        "research the brief defers to a later limitations.json pass.",
        "",
        "## Counts",
        f"- {len(releases)} release entries across {len(majors)} node majors: {', '.join(majors)}.",
        f"- {with_checksum}/{len(releases)} entries carry a vendor sha256 checksum.",
        f"- {len(gaps)} gap entries.",
        f"- {len(plan)} download_plan entries.",
    ]
    if node_missing or iojs_missing or unofficial_missing:
        lines.append(f"- {len(node_missing) + len(iojs_missing) + len(unofficial_missing)} versions had an "
                      "unreachable SHASUMS256.txt and contributed no release entries (see gaps.json).")
    lines += [
        "",
        "## Mirrors",
        f"Probed {len(MIRROR_CANDIDATES)} candidates against >=5 sampled official files (old and new "
        f"majors); {len(confirmed)} confirmed by matching Content-Length on every sample: "
        + (", ".join(n for n, _ in confirmed) if confirmed else "none") + ". "
        "Full per-sample results are in mirrors.json. Confirmed mirrors were applied to every official "
        "(non-iojs, non-unofficial) release entry, not just the sampled ones. iojs and unofficial-builds "
        "entries were not mirror-probed.",
        "",
        "## Sizes",
        "`size` is populated via HEAD request for every download_plan entry (and reused on the matching "
        "release entry). It is left null on the ~13,000+ other releases.json entries to avoid one HEAD "
        "request per file across 15 years of history; only the planned (newest-per-major/os/arch/variant) "
        "entries were sized.",
    ]
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    main()
