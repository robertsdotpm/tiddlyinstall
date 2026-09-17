#!/usr/bin/env python3
"""Build the Python entries of the runtime catalog (catalog/python/).

Sources (all official, all machine-readable):
  - https://www.python.org/api/v2/downloads/release/        (release list, dates, pre-release flag)
  - https://www.python.org/api/v2/downloads/release_file/   (checksums; INCOMPLETE, see NOTES.md)
  - https://www.python.org/ftp/python/<version>/            (directory listings; ground truth for
    which files actually exist for windows/macos/source, with exact byte sizes)
  - https://github.com/astral-sh/python-build-standalone    (prebuilt relocatable linux/macos builds,
    via `gh api`)

Stdlib only. Network calls: urllib for python.org, `gh api` subprocess for GitHub (per instructions,
to use an authenticated client and avoid rate limits). Re-run any time to refresh.

Everything fetched here is untrusted data (filenames, directory listings, JSON fields coming off the
open internet): we only ever parse it for URLs/sizes/hashes, never execute or interpret it as
instructions.
"""
import concurrent.futures as cf
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNTIMES_ROOT = HERE.parent.parent  # installer-builder-runtimes/
UA = "installer-builder-runtimes-catalog/1.0 (+https://github.com/robertsdotpm/installer-builder; contact via repo)"

PY_API = "https://www.python.org/api/v2/downloads"
FTP_BASE = "https://www.python.org/ftp/python"

WINDOWS_ARCHES = {"amd64": "amd64", "arm64": "arm64", "ia64": "ia64", "win32": "x86"}


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def http_get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def http_get_json(url, timeout=60):
    return json.loads(http_get(url, timeout=timeout))


def http_head(url, timeout=20):
    """Returns (status, content_length_or_None). Follows redirects."""
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cl = r.headers.get("Content-Length")
            return r.status, (int(cl) if cl is not None else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def gh_api(path, timeout=90):
    out = subprocess.run(["gh", "api", path], capture_output=True, text=True, timeout=timeout)
    if out.returncode != 0:
        print(f"  ! gh api {path} failed: {out.stderr.strip()[:300]}", file=sys.stderr)
        return None
    return json.loads(out.stdout)


# ---------------------------------------------------------------------------
# python.org: release list + release_file checksums
# ---------------------------------------------------------------------------

VERSION_RE = re.compile(r"^Python (\d+)\.(\d+)\.(\d+)$")


def fetch_stable_releases():
    """Returns list of {"version": "3.9.13", "major": "3.9", "released": "2022-05-17"}."""
    releases = http_get_json(f"{PY_API}/release/")
    out = []
    for r in releases:
        if r.get("pre_release") or not r.get("is_published"):
            continue
        m = VERSION_RE.match(r.get("name", ""))
        if not m:
            continue  # e.g. "Python install manager 25.0" -- a launcher tool, not a runtime
        maj, minr, patch = m.groups()
        out.append({
            "version": f"{maj}.{minr}.{patch}",
            "major": f"{maj}.{minr}",
            "released": r["release_date"][:10],
        })
    out.sort(key=lambda e: tuple(map(int, e["version"].split("."))))
    return out


def fetch_checksum_index():
    """url -> {"algo": ..., "value": ...} for every file the API knows about."""
    files = http_get_json(f"{PY_API}/release_file/")
    idx = {}
    for f in files:
        url = f.get("url")
        if not url:
            continue
        sha256 = (f.get("sha256_sum") or "").strip()
        md5 = (f.get("md5_sum") or "").strip()
        if sha256:
            idx[url] = {"algo": "sha256", "value": sha256.lower()}
        elif md5:
            idx[url] = {"algo": "md5", "value": md5.lower()}
    return idx


# ---------------------------------------------------------------------------
# ftp directory listings
# ---------------------------------------------------------------------------

LISTING_RE = re.compile(
    r'<a href="([^"?/][^"]*)">[^<]*</a>\s+[\d-]+-\w+-\d{4}\s+[\d:]+\s+(\d+)'
)

# filenames to always ignore, regardless of os
SKIP_SUBSTR = (
    ".asc", ".sig", ".sigstore", ".crt", ".spdx.json", ".json",
    "-pdb.zip", "-pdb-", "pdb.zip", "debug", "-webinstall", ".chm",
    "-test-", "linux-android", "unwise.exe",
)
# duplicate/experimental naming introduced alongside the classic one: skip these explicitly.
SKIP_EXTRA_SUBSTR = ("embeddable-", "t-amd64.zip", "t-arm64.zip", "t-win32.zip")
PRERELEASE_RE = re.compile(r"\d(?:a|b|c|rc)\d")  # "c1" was used for candidates before "rc1"
DATED_REBUILD_RE = re.compile(r"macosx?\d{4}-\d{2}-\d{2}")  # e.g. macosx2008-10-01 (superseded rebuild)


def parse_ftp_listing(html):
    return [(name, int(size)) for name, size in LISTING_RE.findall(html)]


def relevant_file(fn):
    fnl = fn.lower()
    if fn.endswith("/") or fn == "..":
        return False
    if any(s in fnl for s in SKIP_SUBSTR):
        return False
    if any(s in fnl for s in SKIP_EXTRA_SUBSTR):
        return False
    if DATED_REBUILD_RE.search(fnl):
        return False
    if PRERELEASE_RE.search(fnl):
        return False
    return True


def classify_source(fn):
    fnl = fn.lower()
    if fnl.endswith((".tar.xz", ".tgz", ".tar.bz2")) and fnl.startswith("python-"):
        return {"kind": "source", "format": fnl.rsplit(".", 1)[-1] if not fnl.endswith("tar.xz")
                 else "tar.xz", "arch": "any", "variant": None}
    return None


SOURCE_PREF = {"tar.xz": 0, "tgz": 1, "tar.bz2": 2}


def classify_windows(fn):
    fnl = fn.lower()
    m = re.match(r"^python-[\d.]+-embed-(amd64|win32|arm64)\.zip$", fnl)
    if m:
        return {"arch": WINDOWS_ARCHES[m.group(1)], "kind": "archive", "format": "zip", "variant": "embed"}
    m = re.match(r"^python-[\d.]+-(amd64|arm64)\.exe$", fnl)
    if m:
        return {"arch": m.group(1), "kind": "installer", "format": "exe", "variant": None}
    m = re.match(r"^python-[\d.]+\.exe$", fnl)
    if m:
        return {"arch": "x86", "kind": "installer", "format": "exe", "variant": None}
    m = re.match(r"^python-[\d.]+\.(amd64|ia64)\.msi$", fnl)
    if m:
        return {"arch": m.group(1), "kind": "installer", "format": "msi", "variant": None}
    m = re.match(r"^python-[\d.]+\.msi$", fnl)
    if m:
        return {"arch": "x86", "kind": "installer", "format": "msi", "variant": None}
    return None


def classify_macos(fn):
    fnl = fn.lower()
    m = re.match(r"^python-[\d.]+[-_]macos(x)?(\d+(?:\.\d+)?)?\.(dmg|pkg)$", fnl)
    if m:
        xflag, ver, fmt = m.groups()
        label = ("macosx" if xflag else "macos") + (ver or "")
        if label.startswith("macos1") and not label.startswith("macosx"):
            # macos11, macos12, ... -> universal2 (arm64 + x86_64)
            return {"arch": "universal", "kind": "installer", "format": fmt, "variant": label,
                    "min_os": f"macOS {ver}", "notes": "universal2 (arm64 + x86_64)"}
        if label == "macosx10.9":
            return {"arch": "amd64", "kind": "installer", "format": fmt, "variant": label,
                    "min_os": "Mac OS X 10.9", "notes": "Intel 64-bit only (no 32-bit, no PPC)"}
        return {"arch": "universal", "kind": "installer", "format": fmt, "variant": label,
                "min_os": (f"Mac OS X {ver}" if ver else None),
                "notes": "universal installer (32/64-bit Intel and/or PPC fat binary)"}
    m = re.match(r"^universal-macpython-([\d.]+)\.dmg$", fnl)
    if m:
        return {"arch": "universal", "kind": "installer", "format": "dmg", "variant": "macpython",
                "min_os": None, "notes": "early \"Universal MacPython\" installer (PPC + Intel)"}
    m = re.match(r"^python-[\d.]+\.dmg$", fnl)
    if m:
        return {"arch": "universal", "kind": "installer", "format": "dmg", "variant": "macosx",
                "min_os": None, "notes": "early Mac OS X installer, no arch/min-OS marked in the filename"}
    return None


def crawl_version(version):
    """Fetch the ftp directory listing for this version. Ancient X.Y.0 releases (up to some point
    in the 3.2 era) were published under the bare `X.Y/` directory instead of `X.Y.0/` -- fall back
    to that on a 404."""
    major = ".".join(version.split(".")[:2])
    urls_to_try = [f"{FTP_BASE}/{version}/"]
    if version.endswith(".0"):
        urls_to_try.append(f"{FTP_BASE}/{major}/")
    html = None
    for url in urls_to_try:
        try:
            html = http_get(url).decode("utf-8", "replace")
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            print(f"  ! ftp listing failed for {version} ({url}): {e}", file=sys.stderr)
            break
        except Exception as e:
            print(f"  ! ftp listing failed for {version} ({url}): {e}", file=sys.stderr)
            break
    if html is None:
        print(f"  ! no ftp listing found for {version}", file=sys.stderr)
        return version, ([], [], []), []
    entries = parse_ftp_listing(html)
    unclassified = []
    win, mac, src = [], [], []
    for fn, size in entries:
        if not relevant_file(fn):
            continue
        c = classify_windows(fn)
        if c:
            win.append((fn, size, c))
            continue
        c = classify_macos(fn)
        if c:
            mac.append((fn, size, c))
            continue
        c = classify_source(fn)
        if c:
            src.append((fn, size, c))
            continue
        unclassified.append(fn)
    return version, (win, mac, src), unclassified


# ---------------------------------------------------------------------------
# python-build-standalone (astral-sh, formerly indygreg)
# ---------------------------------------------------------------------------

PBS_REPO = "astral-sh/python-build-standalone"
# Historical anchor tags that still carry EOL minors astral-sh has since stopped building.
# (Found by walking the repo's tag list back to just before each minor's own EOL date.)
PBS_FALLBACK_TAGS = ["20250918", "20241002"]  # covers 3.9.x, 3.8.x respectively, as of 2026-09

PBS_ASSET_RE = re.compile(
    r"^cpython-(?P<ver>\d+\.\d+\.\d+)\+(?P<tag>\d+)-(?P<triple>.+)-"
    r"(?P<flavor>install_only|install_only_stripped)\.tar\.gz$"
)

PBS_LINUX_TRIPLES = {
    "x86_64-unknown-linux-gnu": ("amd64", "glibc"),
    "x86_64-unknown-linux-musl": ("amd64", "musl"),
    "aarch64-unknown-linux-gnu": ("arm64", "glibc"),
    "aarch64-unknown-linux-musl": ("arm64", "musl"),
    "armv7-unknown-linux-gnueabihf": ("armv7", "glibc"),
    "ppc64le-unknown-linux-gnu": ("ppc64le", "glibc"),
    "s390x-unknown-linux-gnu": ("s390x", "glibc"),
    "riscv64-unknown-linux-gnu": ("riscv64", "glibc"),
}
PBS_MACOS_TRIPLES = {
    "x86_64-apple-darwin": ("amd64", None),
    "aarch64-apple-darwin": ("arm64", None),
}


def fetch_pbs_release(tag):
    path = f"repos/{PBS_REPO}/releases/latest" if tag == "latest" else f"repos/{PBS_REPO}/releases/tags/{tag}"
    data = gh_api(path)
    if not data:
        return None
    return data


def pbs_entries():
    """Walk astral-sh/python-build-standalone releases (newest first) and, for every CPython
    minor we can find a stable-numbered build for, keep the newest such build. Older release
    tags are only consulted to fill in minors the newest release no longer builds (EOL'd)."""
    seen_minor_triple = set()  # (major, triple, flavor) already satisfied by a newer release
    by_key = {}  # (major, triple, flavor) -> entry dict
    tags = ["latest"] + PBS_FALLBACK_TAGS
    for tag in tags:
        rel = fetch_pbs_release(tag)
        if not rel:
            continue
        real_tag = rel.get("tag_name", tag)
        for asset in rel.get("assets", []):
            m = PBS_ASSET_RE.match(asset["name"])
            if not m:
                continue
            ver = m.group("ver")
            major = ".".join(ver.split(".")[:2])
            # exclude pre-releases (shouldn't match version-only regex anyway, but be safe)
            if not re.match(r"^\d+\.\d+\.\d+$", ver):
                continue
            triple = m.group("triple")
            flavor = m.group("flavor")
            if triple in PBS_LINUX_TRIPLES:
                os_name = "linux"
                arch, libc = PBS_LINUX_TRIPLES[triple]
            elif triple in PBS_MACOS_TRIPLES:
                os_name = "macos"
                arch, libc = PBS_MACOS_TRIPLES[triple]
            else:
                continue
            key = (major, os_name, arch, libc, flavor)
            if key in seen_minor_triple:
                continue  # a newer release tag already gave us this slot
            digest = asset.get("digest") or ""
            checksum = None
            if digest.startswith("sha256:"):
                checksum = {"algo": "sha256", "value": digest.split(":", 1)[1]}
            entry = {
                "runtime": "python", "languages": ["python"],
                "major": major, "version": ver,
                "os": os_name, "arch": arch,
                "kind": "archive", "format": "tar.gz",
                "variant": "pbs" if flavor == "install_only" else "pbs_stripped",
                "libc": libc,
                "url": asset["browser_download_url"],
                "mirrors": [],
                "checksum": checksum,
                "size": asset["size"],
                "released": rel.get("published_at", "")[:10] or None,
                "min_os": None,
                "metadata_source": f"https://api.github.com/{path_for(tag)}",
                "notes": f"python-build-standalone {flavor}, build tag {real_tag}"
                         + ("" if tag == "latest" else " (historical anchor: newer releases dropped this EOL minor)"),
            }
            by_key[key] = entry
        for k in list(by_key):
            seen_minor_triple.add(k)
    return list(by_key.values())


def path_for(tag):
    return f"repos/{PBS_REPO}/releases/latest" if tag == "latest" else f"repos/{PBS_REPO}/releases/tags/{tag}"


# ---------------------------------------------------------------------------
# mirrors
# ---------------------------------------------------------------------------

def load_root_mirror_templates():
    return json.loads((RUNTIMES_ROOT / "mirrors.json").read_text())


def sample_mirrors(releases):
    """HEAD-probe each root mirror template against >=5 python.org-hosted files spanning old
    and new versions / windows+macos+source, and confirm same size as the primary URL."""
    templates = load_root_mirror_templates()
    candidates = [r for r in releases if r["url"].startswith(FTP_BASE)]
    # spread the sample: oldest windows, newest windows, oldest source, newest source, a macos one
    def pick(pred):
        matches = [r for r in candidates if pred(r)]
        return matches

    win = sorted(pick(lambda r: r["os"] == "windows"), key=lambda r: r["version"])
    mac = sorted(pick(lambda r: r["os"] == "macos"), key=lambda r: r["version"])
    src = sorted(pick(lambda r: r["os"] == "linux" and r["kind"] == "source"), key=lambda r: r["version"])
    sample = []
    for group in (win, mac, src):
        if group:
            sample.append(group[0])   # oldest
            sample.append(group[-1])  # newest
    # de-dup and cap
    seen = set()
    uniq_sample = []
    for r in sample:
        if r["url"] not in seen:
            uniq_sample.append(r)
            seen.add(r["url"])
    print(f"  mirror sample: {len(uniq_sample)} files "
          f"({sum(1 for r in uniq_sample if r['os']=='windows')} windows, "
          f"{sum(1 for r in uniq_sample if r['os']=='macos')} macos, "
          f"{sum(1 for r in uniq_sample if r['os']=='linux')} source)")

    results = {}  # template id -> {"confirmed": bool, "checked": int, "ok": int, "scope": str}
    for tmpl in templates:
        tid = tmpl["id"]
        scope = "windows-only" if "{file}" in tmpl["template"] and "windows" in tmpl["template"] else "general"
        checked = ok = 0
        for r in uniq_sample:
            if scope == "windows-only" and r["os"] != "windows":
                continue
            filename = r["url"].rsplit("/", 1)[-1]
            murl = tmpl["template"].format(version=r["version"], file=filename)
            status, size = http_head(murl)
            checked += 1
            if status and status < 400 and size == r["size"]:
                ok += 1
            else:
                print(f"    {tid}: MISS for {filename} (status={status} size={size} expected={r['size']})")
        results[tid] = {
            "scope": scope, "checked": checked, "ok": ok,
            "confirmed": checked > 0 and ok == checked,
        }
    return results, templates, uniq_sample


def apply_mirrors(releases, results, templates):
    confirmed = [t for t in templates if results.get(t["id"], {}).get("confirmed")]
    n_applied = 0
    for r in releases:
        if not r["url"].startswith(FTP_BASE):
            continue  # PBS files: no mirrors
        filename = r["url"].rsplit("/", 1)[-1]
        for tmpl in confirmed:
            scope = results[tmpl["id"]]["scope"]
            if scope == "windows-only" and r["os"] != "windows":
                continue
            r["mirrors"].append(tmpl["template"].format(version=r["version"], file=filename))
            n_applied += 1
    return n_applied


# ---------------------------------------------------------------------------
# assembly
# ---------------------------------------------------------------------------

def make_entry(version, major, released, os_name, fn, size, c, checksum_idx):
    url = f"{FTP_BASE}/{version}/{fn}"
    checksum = checksum_idx.get(url)
    notes = c.get("notes")
    metadata_source = f"{FTP_BASE}/{version}/"
    if checksum is None:
        notes = (notes + "; " if notes else "") + "found only via ftp directory listing, not in python.org's downloads API"
    else:
        metadata_source = f"{PY_API}/release_file/"
    return {
        "runtime": "python", "languages": ["python"],
        "major": major, "version": version,
        "os": os_name, "arch": c["arch"], "kind": c["kind"], "format": c["format"],
        "variant": c.get("variant"), "libc": None,
        "url": url, "mirrors": [],
        "checksum": checksum, "size": size,
        "released": released,
        "min_os": c.get("min_os"),
        "metadata_source": metadata_source,
        "notes": notes,
    }


def build_releases():
    print("Fetching python.org release list and checksum index...")
    stable = fetch_stable_releases()
    checksum_idx = fetch_checksum_index()
    print(f"  {len(stable)} stable releases (2.0.1 .. {stable[-1]['version']})")

    print(f"Crawling {len(stable)} ftp directory listings (concurrency=6)...")
    releases = []
    unclassified_total = []
    source_pref_seen = {}  # version -> chosen source file (prefer tar.xz > tgz > bz2)
    with cf.ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(crawl_version, e["version"]): e for e in stable}
        done = 0
        for fut in cf.as_completed(futs):
            e = futs[fut]
            version, (win, mac, src), unclassified = fut.result()
            done += 1
            if done % 50 == 0:
                print(f"  ...{done}/{len(stable)}")
            unclassified_total.extend((version, u) for u in unclassified)
            for fn, size, c in win:
                releases.append(make_entry(version, e["major"], e["released"], "windows", fn, size, c, checksum_idx))
            for fn, size, c in mac:
                releases.append(make_entry(version, e["major"], e["released"], "macos", fn, size, c, checksum_idx))
            if src:
                best = min(src, key=lambda t: SOURCE_PREF.get(t[2]["format"], 9))
                fn, size, c = best
                releases.append(make_entry(version, e["major"], e["released"], "linux", fn, size, c, checksum_idx))

    if unclassified_total:
        print(f"  {len(unclassified_total)} unclassified files skipped (sample):", file=sys.stderr)
        for version, fn in unclassified_total[:15]:
            print(f"    {version}: {fn}", file=sys.stderr)

    print("Fetching python-build-standalone releases via gh api...")
    pbs = pbs_entries()
    print(f"  {len(pbs)} prebuilt linux/macos entries")
    releases.extend(pbs)

    releases.sort(key=lambda r: (tuple(map(int, r["major"].split("."))),
                                  tuple(map(int, r["version"].split("."))), r["os"], r["arch"] or "",
                                  r.get("variant") or ""))
    return releases


def version_tuple(v):
    return tuple(map(int, v.split(".")))


def build_gaps(releases):
    majors_present = sorted({r["major"] for r in releases}, key=version_tuple)
    has_linux_binary = {r["major"] for r in releases if r["os"] == "linux" and r["kind"] == "archive"}
    gaps = []
    for major in majors_present:
        if major in has_linux_binary:
            continue
        gaps.append({
            "runtime": "python", "major": major, "os": "linux", "arch": "any",
            "reason": "no prebuilt/portable Linux binary: python.org ships no Linux binaries for "
                      "any Python version, and python-build-standalone only builds CPython 3.8 and "
                      "later; only the source tarball (kind=source) is available for this major",
            "looked_at": [
                "https://www.python.org/downloads/source/",
                f"{FTP_BASE}/",
                "https://github.com/astral-sh/python-build-standalone/releases",
            ],
        })
    return gaps


def best_of(grp):
    """Newest version wins; ties broken by preferring glibc over musl (mainstream default --
    musl is still in releases.json, just not the plan default), then by smallest size."""
    newest_v = max(version_tuple(r["version"]) for r in grp)
    at_newest = [r for r in grp if version_tuple(r["version"]) == newest_v]
    glibc_only = [r for r in at_newest if r.get("libc") != "musl"]
    pool = glibc_only if glibc_only else at_newest
    return min(pool, key=lambda r: r["size"] or 0)


def build_plan(releases):
    plan = []
    majors = sorted({r["major"] for r in releases}, key=version_tuple)
    for major in majors:
        mine = [r for r in releases if r["major"] == major]

        # windows: group by (arch, variant); embed (archive) and installer are both kept, since
        # they're genuinely different products (embeddable subset vs full installer).
        win = [r for r in mine if r["os"] == "windows"]
        groups = {}
        for r in win:
            groups.setdefault((r["arch"], r["variant"]), []).append(r)
        for grp in groups.values():
            plan.append(best_of(grp))

        # macos: prefer the python-build-standalone archive over the official installer, per arch,
        # only when PBS covers this major at all (otherwise fall back to the pkg/dmg installer).
        mac = [r for r in mine if r["os"] == "macos"]
        mac_archive = [r for r in mac if r["kind"] == "archive"]
        pool = mac_archive if mac_archive else mac
        by_arch = {}
        for r in pool:
            by_arch.setdefault(r["arch"], []).append(r)
        for grp in by_arch.values():
            plan.append(best_of(grp))

        # linux: prefer python-build-standalone archive; else the source tarball.
        lin = [r for r in mine if r["os"] == "linux"]
        lin_archive = [r for r in lin if r["kind"] == "archive"]
        pool = lin_archive if lin_archive else [r for r in lin if r["kind"] == "source"]
        by_arch = {}
        for r in pool:
            by_arch.setdefault(r["arch"], []).append(r)
        for grp in by_arch.values():
            plan.append(best_of(grp))

    return plan


NOTES = """\
# Python catalog notes

## Sources
- python.org downloads API (`/api/v2/downloads/release/`, `/release_file/`) for the list of
  every published, non-prerelease Python release and whatever checksums it publishes.
- python.org ftp directory listings (`https://www.python.org/ftp/python/<version>/`), crawled for
  every one of the {n_releases} stable releases, as the ground truth for which windows/macos/source
  files actually exist -- the API is missing some (e.g. the 3.3.5 Windows MSIs are absent from
  `release_file`, and several ancient security-only patch releases such as 2.5.6 shipped source
  only, with no installer at all, which the API doesn't make obvious). Files found only via the
  ftp listing have `"checksum": null` and a note saying so.
- `astral-sh/python-build-standalone` (formerly `indygreg/python-build-standalone`) GitHub releases,
  via `gh api`, for prebuilt relocatable Linux/macOS builds (`install_only` and `install_only_stripped`
  tar.gz assets). Checksums come from each asset's `digest` field (sha256), which this repo provides
  directly on the release-asset JSON -- there is no separate `SHA256SUMS` asset in this repo (unlike
  some other astral-sh repos); a per-asset `.sha256` sidecar file also exists but the API digest is
  equivalent and avoids an extra request per file.
- Latest python-build-standalone release only covers currently-maintained minors (3.10-3.14 as of this
  run, plus a 3.15 prerelease that is excluded as non-stable). Two historical release tags
  (20250918, 20241002) were used as anchors to pick up the final builds for 3.9 (3.9.23) and 3.8
  (3.8.20) before astral-sh stopped building them post-EOL.

## Scope decisions
- "Python install manager" releases (25.x, 26.x on python.org) are a separate launcher/installer
  tool, not a Python runtime -- excluded entirely.
- Windows: the newer `-embeddable-*.zip` asset name (appearing alongside the classic `-embed-*.zip`
  from Python 3.11 on) is skipped as a near-duplicate of `-embed-*.zip` (slightly different byte size,
  undocumented on the downloads page) to avoid double-counting the same conceptual artifact. Likewise
  skipped: the bare `-amd64.zip`/`-win32.zip`/`-arm64.zip` (no "embed"), the free-threaded `t-*.zip`
  variants, and `-test-*.zip` bundles -- all present on the ftp server but not linked from the official
  downloads page, and out of scope for this pass.
- Android/iOS builds present under recent version directories (`*-linux-android.tar.gz`) are skipped;
  not one of the target OSes here.
- macOS variant strings (`macosx10.5`, `macosx10.9`, `macos11`, `macpython`, ...) encode the vendor's
  own minimum-OS naming for that installer generation; `arch` is `amd64` only for the Intel-only
  `macosx10.9` generation, `universal` for every fat/universal2 build (including old PPC/Intel dmgs and
  the modern arm64+x86_64 `macos11.pkg`).
- Linux: python.org ships no Linux binaries at all, at any version. Every stable release gets exactly
  one `os: "linux", arch: "any", kind: "source"` entry (the source tarball, applies to any Unix); this
  is recorded once per version rather than duplicated per (linux/freebsd/etc) since the same tarball is
  what every Unix builds from.
- python-build-standalone microarchitecture variants (`x86_64_v2/v3/v4`) and the plain
  `armv7-unknown-linux-gnueabi` (non-hf) triple are skipped in favour of the baseline `x86_64` and
  `armv7...gnueabihf` builds, to keep `arch` values within the schema's enum.

## download_plan.json selection
- Windows: both the full installer (`variant: null`) and the embeddable zip (`variant: "embed"`) are
  planned per arch/major, since they're different products, not competing formats of the same one.
- macOS and Linux: when python-build-standalone covers a major at all (3.8+), its `install_only` or
  `install_only_stripped` (whichever is smaller) is the plan entry, in preference to the official
  installer / source tarball, per arch. Older majors (2.x, 3.0-3.7) fall back to the newest available
  official pkg/dmg installer (macOS) or the source tarball (Linux) -- recorded as a gap for the missing
  prebuilt Linux binary.

## Old-Windows testing
Separately-tested known-good builds for XP/Vista/7/8/10/11 (asyncio confirmed working, not just
"installs") are documented in `/home/x/projects/installer-builder-runtimes/TESTED-WINDOWS.md` and are
not duplicated here; this catalog covers every published patch, that file covers what was actually
verified on real old Windows installs.

## Mirrors
See mirrors.json for which of the root `mirrors.json` templates were confirmed (by HEAD, sampled
across old/new and windows/macos/source files) and applied to every matching release.
"""


def main():
    releases = build_releases()
    print(f"Built {len(releases)} release entries")

    print("Sampling mirrors...")
    results, templates, sample = sample_mirrors(releases)
    n_applied = apply_mirrors(releases, results, templates)
    print(f"  applied {n_applied} mirror URLs across releases")

    gaps = build_gaps(releases)
    plan = build_plan(releases)

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")

    mirrors_doc = {
        "runtime": "python",
        "templates_source": "../../mirrors.json (root, shared across runtimes)",
        "method": "HEAD request against a sample of files spanning old/new versions and "
                  "windows/macos/source, comparing Content-Length to the python.org size; a "
                  "template is applied to every release of this runtime only if its whole sample matched.",
        "sample_files": [r["url"] for r in sample],
        "results": {
            tid: {**res, "template": next(t["template"] for t in templates if t["id"] == tid)}
            for tid, res in results.items()
        },
        "note": "python-build-standalone (GitHub-hosted) releases are not mirrored by any of these "
                "templates and always have mirrors: [].",
    }
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2) + "\n")

    stable_count = len({r["version"] for r in releases if r["os"] != "linux" or r["kind"] == "source"})
    (HERE / "NOTES.md").write_text(NOTES.format(n_releases=stable_count))

    print(f"Wrote releases.json ({len(releases)}), gaps.json ({len(gaps)}), "
          f"download_plan.json ({len(plan)}), mirrors.json, NOTES.md")


if __name__ == "__main__":
    main()
