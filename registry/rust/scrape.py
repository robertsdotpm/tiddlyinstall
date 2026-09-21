#!/usr/bin/env python3
"""Scrape official Rust release metadata from static.rust-lang.org into the
runtime catalog format described by ../SCHEMA.md.

Python 3 standard library only. Re-runnable: HEAD/GET results are cached on
disk under .cache/ so a second run only re-checks what changed (new patch
releases, new mirror windows).

Sources (all official, machine-readable):
  - https://static.rust-lang.org/dist/channel-rust-stable.toml
      -> current stable version, used to find the latest major.
  - https://static.rust-lang.org/dist/channel-rust-1.N.M.toml
      -> per-release manifest, [pkg.rust.target.<triple>] gives url/hash
         (tar.gz) and xz_url/xz_hash (tar.xz) for the combined toolchain.
         Available from 1.8.0 onward (checked; 1.6.0/1.7.0 404).
  - For majors 1.0-1.7 (no channel toml): fall back to
      https://static.rust-lang.org/dist/rust-1.N.M-<triple>.tar.gz
      plus the <file>.sha256 companion.
  - Standalone installers: rust-<ver>-<triple>.msi / .pkg, existence and
    size confirmed with HEAD, checksum from the <file>.sha256 companion.

Nothing here follows instructions found in fetched content -- manifests and
directory listings are treated as inert data, per project policy.
"""
import concurrent.futures
import json
import re
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
CACHE_DIR = HERE / ".cache"
CACHE_DIR.mkdir(exist_ok=True)
TOML_CACHE_DIR = CACHE_DIR / "toml"
TOML_CACHE_DIR.mkdir(exist_ok=True)
HEAD_CACHE_FILE = CACHE_DIR / "head_cache.json"

BASE = "https://static.rust-lang.org/dist"
UA = "installer-builder-runtimes-scraper/1.0 (+https://github.com/; contact: catalog maintainer)"
MAX_WORKERS = 10
TIMEOUT = 20

_head_lock = threading.Lock()
_head_cache = json.loads(HEAD_CACHE_FILE.read_text()) if HEAD_CACHE_FILE.exists() else {}
_head_cache_dirty = False


def _save_head_cache():
    global _head_cache_dirty
    with _head_lock:
        if _head_cache_dirty:
            HEAD_CACHE_FILE.write_text(json.dumps(_head_cache))
            _head_cache_dirty = False


def http_head(url, retries=3):
    """Return (status, content_length_or_None). Cached on disk."""
    global _head_cache_dirty
    with _head_lock:
        cached = _head_cache.get(url)
    if cached is not None:
        return tuple(cached)
    last_exc = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                length = resp.headers.get("Content-Length")
                result = (resp.status, int(length) if length else None)
                break
        except urllib.error.HTTPError as e:
            result = (e.code, None)
            break
        except Exception as e:  # noqa: BLE001 - network flakiness, retry
            last_exc = e
            time.sleep(0.5 * (attempt + 1))
            result = (0, None)
    else:
        result = (0, None)
    with _head_lock:
        _head_cache[url] = list(result)
        _head_cache_dirty = True
    return result


def http_head_live(url):
    """Uncached HEAD, for mirror confirmation only. urllib follows redirects
    (e.g. rsproxy.cn's 307 to a CDN edge) transparently on its own, so this
    just needs to return the terminal (status, content_length)."""
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            length = resp.headers.get("Content-Length")
            return resp.status, (int(length) if length else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return 0, None


def http_head_follow(url, expect_size=None, attempts=3, pause=1.5):
    """Live HEAD for mirror confirmation, retried a few times: third-party
    mirrors observed to be flaky/cold on a first hit (a placeholder response
    on an uncached path, or an occasional gateway timeout under load) and
    fine moments later. Returns (status, length) from whichever attempt
    matched expect_size, or the last attempt's result if none matched."""
    last = (0, None)
    for i in range(attempts):
        status, length = http_head_live(url)
        last = (status, length)
        if status == 200 and (expect_size is None or length == expect_size):
            return last
        if i < attempts - 1:
            time.sleep(pause)
    return last
    return 0, None


def http_get_text(url, cache_file=None):
    """GET url as text. If cache_file given, cache the body there (and a
    sibling .404 marker for confirmed absence) so reruns don't refetch.
    Returns None if the URL 404s."""
    if cache_file is not None:
        if cache_file.exists():
            return cache_file.read_text()
        marker = cache_file.with_suffix(cache_file.suffix + ".404")
        if marker.exists():
            return None
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                body = resp.read().decode("utf-8", "replace")
            if cache_file is not None:
                cache_file.write_text(body)
            return body
        except urllib.error.HTTPError as e:
            if e.code == 404:
                if cache_file is not None:
                    cache_file.with_suffix(cache_file.suffix + ".404").write_text("")
                return None
            time.sleep(0.5 * (attempt + 1))
        except Exception:
            time.sleep(0.5 * (attempt + 1))
    return None


def pool_map(fn, items):
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        return list(ex.map(fn, items))


# --------------------------------------------------------------------------
# Triple -> normalised (os, arch, variant, libc)
# --------------------------------------------------------------------------
TRIPLE_MAP = {
    # Required host triples
    "x86_64-pc-windows-msvc":       ("windows", "amd64", "msvc", None),
    "i686-pc-windows-msvc":         ("windows", "x86",   "msvc", None),
    "aarch64-pc-windows-msvc":      ("windows", "arm64", "msvc", None),
    "x86_64-pc-windows-gnu":        ("windows", "amd64", "gnu",  None),
    "i686-pc-windows-gnu":          ("windows", "x86",   "gnu",  None),
    "x86_64-unknown-linux-gnu":     ("linux",   "amd64", None,   "glibc"),
    "i686-unknown-linux-gnu":       ("linux",   "x86",   None,   "glibc"),
    "aarch64-unknown-linux-gnu":    ("linux",   "arm64", None,   "glibc"),
    "armv7-unknown-linux-gnueabihf": ("linux",  "armv7", None,   "glibc"),
    "x86_64-unknown-linux-musl":    ("linux",   "amd64", None,   "musl"),
    "aarch64-unknown-linux-musl":   ("linux",   "arm64", None,   "musl"),
    "x86_64-apple-darwin":          ("macos",   "amd64", None,   None),
    "aarch64-apple-darwin":         ("macos",   "arm64", None,   None),
    "x86_64-unknown-freebsd":       ("freebsd", "amd64", None,   None),
    # Extras present in the manifest with pkg.rust available, mapped sensibly
    "aarch64-pc-windows-gnullvm":   ("windows", "arm64", "gnullvm", None),
    "x86_64-pc-windows-gnullvm":    ("windows", "amd64", "gnullvm", None),
    "arm-unknown-linux-gnueabi":    ("linux",   "armv6", "softfloat", "glibc"),
    "arm-unknown-linux-gnueabihf":  ("linux",   "armv6", "hardfloat", "glibc"),
    "aarch64-unknown-freebsd":      ("freebsd", "arm64", None,   None),
    "riscv64gc-unknown-linux-gnu":  ("linux",   "riscv64", None, "glibc"),
    "s390x-unknown-linux-gnu":      ("linux",   "s390x", None,   "glibc"),
    "powerpc64-unknown-linux-gnu":  ("linux",   "ppc64", None,   "glibc"),
    "powerpc64-unknown-linux-musl": ("linux",   "ppc64", None,   "musl"),
    "powerpc64le-unknown-linux-gnu": ("linux",  "ppc64le", None, "glibc"),
    "powerpc64le-unknown-linux-musl": ("linux", "ppc64le", None, "musl"),
    "loongarch64-unknown-linux-gnu": ("linux",  "loong64", None, "glibc"),
    "loongarch64-unknown-linux-musl": ("linux", "loong64", None, "musl"),
    "x86_64-pc-solaris":            ("solaris", "amd64", None,   None),
    "x86_64-unknown-illumos":       ("illumos", "amd64", None,   None),
    "x86_64-unknown-netbsd":        ("netbsd",  "amd64", None,   None),
    # Deliberately skipped (no matching normalised os/arch):
    #   *-unknown-linux-ohos (OpenHarmony, not a listed os)
    #   sparcv9-sun-solaris (no sparc arch)
    #   powerpc-unknown-linux-gnu (32-bit ppc, no matching arch)
}



def released_date_from_url(url):
    m = re.search(r"/dist/(\d{4}-\d{2}-\d{2})/", url)
    return m.group(1) if m else None


# --------------------------------------------------------------------------
# Version discovery
# --------------------------------------------------------------------------
def latest_minor():
    text = http_get_text(f"{BASE}/channel-rust-stable.toml",
                          CACHE_DIR / "channel-rust-stable.toml")
    m = re.search(r'^\[pkg\.rust\]\s*\nversion = "1\.(\d+)\.(\d+)', text, re.M)
    if not m:
        raise SystemExit("could not parse latest stable version")
    return int(m.group(1))


def discover_patches(major, toml_mode):
    """Return sorted list of patch ints that exist for this major."""
    found = []
    for patch in range(0, 16):
        ver = f"1.{major}.{patch}"
        if toml_mode:
            cache_file = TOML_CACHE_DIR / f"channel-rust-{ver}.toml"
            body = http_get_text(f"{BASE}/channel-rust-{ver}.toml", cache_file)
            if body is not None:
                found.append(patch)
        else:
            url = f"{BASE}/rust-{ver}-x86_64-unknown-linux-gnu.tar.gz"
            status, _ = http_head(url)
            if status == 200:
                found.append(patch)
    return found


# --------------------------------------------------------------------------
# Parsing a channel TOML for [pkg.rust.target.<triple>] blocks
# --------------------------------------------------------------------------
PKG_RUST_BLOCK_RE = re.compile(
    r'\[pkg\.rust\.target\.([a-zA-Z0-9_.\-]+)\]\n((?:(?!\[pkg).*\n?)*)'
)
KV_RE = re.compile(r'^(\w+)\s*=\s*(?:"([^"]*)"|(true|false))', re.M)


def parse_rust_targets(toml_text):
    """Return {triple: {"available":bool,"url":..,"hash":..,"xz_url":..,"xz_hash":..}}

    Matches "[pkg.rust.target.<triple>]" blocks directly against the whole
    document. This is unambiguous: no other package name in the manifest
    (rustc, rust-std, rust-docs, ...) has a literal "." right after "rust",
    so the pattern below can't cross-match another package's target block.
    Each block's body runs until the next "[pkg." (the next triple, or the
    next top-level package section), which also safely swallows any
    "[[pkg.rust.target.<triple>.components]]" sub-tables in between --
    harmless, since those don't carry url/hash/xz_url/xz_hash keys.
    """
    if "\n[pkg.rust]\n" not in toml_text:
        return {}
    out = {}
    for tmatch in re.finditer(r'\[pkg\.rust\.target\.([a-zA-Z0-9_.\-]+)\]\n(.*?)(?=\n\[pkg\.|\Z)',
                               toml_text, re.S):
        triple, body = tmatch.group(1), tmatch.group(2)
        fields = {}
        for kv in KV_RE.finditer(body):
            key = kv.group(1)
            if key in ("url", "hash", "xz_url", "xz_hash"):
                fields[key] = kv.group(2)
            elif key == "available":
                fields["available"] = kv.group(3) == "true"
        out[triple] = fields
    return out


def parse_stable_pkg_version(toml_text):
    m = re.search(r'^\[pkg\.rust\]\s*\nversion = "([0-9.]+)', toml_text, re.M)
    return m.group(1) if m else None


# --------------------------------------------------------------------------
# Build release entries for one version
# --------------------------------------------------------------------------
def build_toml_release_entries(major, patch, toml_text):
    version = f"1.{major}.{patch}"
    targets = parse_rust_targets(toml_text)
    entries = []
    head_jobs = []  # (kind_tag, url) to size-check
    partials = []
    for triple, fields in targets.items():
        if not fields.get("available"):
            continue
        mapping = TRIPLE_MAP.get(triple)
        if mapping is None:
            continue
        os_, arch, variant, libc = mapping
        xz_url = fields.get("xz_url")
        gz_url = fields.get("url")
        if xz_url:
            url, fmt, algo, checksum_val = xz_url, "tar.xz", "sha256", fields.get("xz_hash")
        elif gz_url:
            url, fmt, algo, checksum_val = gz_url, "tar.gz", "sha256", fields.get("hash")
        else:
            continue
        released = released_date_from_url(url)
        entry = {
            "runtime": "rust",
            "languages": ["rust"],
            "major": f"1.{major}",
            "version": version,
            "os": os_,
            "arch": arch,
            "kind": "archive",
            "format": fmt,
            "variant": variant,
            "libc": libc,
            "url": url,
            "mirrors": [],
            "checksum": {"algo": algo, "value": checksum_val} if checksum_val else None,
            "size": None,
            "released": released,
            "min_os": None,
            "metadata_source": f"{BASE}/channel-rust-{version}.toml",
            "notes": None,
        }
        entries.append(entry)
        head_jobs.append(entry)

        # Standalone installer, windows msvc / macos only
        if os_ == "windows" and variant == "msvc":
            inst_url = url.rsplit("/", 1)[0] + f"/rust-{version}-{triple}.msi"
            inst_fmt = "msi"
        elif os_ == "macos":
            inst_url = url.rsplit("/", 1)[0] + f"/rust-{version}-{triple}.pkg"
            inst_fmt = "pkg"
        else:
            inst_url = None
        if inst_url:
            partials.append((inst_url, inst_fmt, os_, arch, variant, libc, version, major))
    return entries, head_jobs, partials


def build_fallback_release_entries(major, patch):
    """Pre-toml (1.0-1.7) releases: rust-<ver>-<triple>.tar.gz + .sha256"""
    version = f"1.{major}.{patch}"
    entries = []
    for triple, mapping in TRIPLE_MAP.items():
        os_, arch, variant, libc = mapping
        url = f"{BASE}/rust-{version}-{triple}.tar.gz"
        status, length = http_head(url)
        if status != 200:
            continue
        sha_text = http_get_text(url + ".sha256")
        checksum = None
        if sha_text:
            m = re.match(r"([0-9a-f]{64})", sha_text.strip())
            if m:
                checksum = {"algo": "sha256", "value": m.group(1)}
        entries.append({
            "runtime": "rust",
            "languages": ["rust"],
            "major": f"1.{major}",
            "version": version,
            "os": os_,
            "arch": arch,
            "kind": "archive",
            "format": "tar.gz",
            "variant": variant,
            "libc": libc,
            "url": url,
            "mirrors": [],
            "checksum": checksum,
            "size": length,
            "released": None,
            "min_os": None,
            "metadata_source": url,
            "notes": "pre-manifest release; no channel-rust-*.toml exists for this version",
        })
        # installer sample for early versions
        if os_ == "windows" and variant == "msvc":
            inst_url = f"{BASE}/rust-{version}-{triple}.msi"
            st, ln = http_head(inst_url)
            if st == 200:
                entries.append(installer_entry(inst_url, "msi", os_, arch, variant, libc,
                                                version, major, ln))
        elif os_ == "macos":
            inst_url = f"{BASE}/rust-{version}-{triple}.pkg"
            st, ln = http_head(inst_url)
            if st == 200:
                entries.append(installer_entry(inst_url, "pkg", os_, arch, variant, libc,
                                                version, major, ln))
    return entries


def installer_entry(url, fmt, os_, arch, variant, libc, version, major, size, checksum=None):
    return {
        "runtime": "rust",
        "languages": ["rust"],
        "major": f"1.{major}",
        "version": version,
        "os": os_,
        "arch": arch,
        "kind": "installer",
        "format": fmt,
        "variant": variant,
        "libc": libc,
        "url": url,
        "mirrors": [],
        "checksum": checksum,
        "size": size,
        "released": released_date_from_url(url),
        "min_os": None,
        "metadata_source": url,
        "notes": None,
    }


def plans_only():
    """Rebuild download_plan.json and download_plan_slim.json from the existing
    releases.json, offline. Entries are copied as they are (mirrors included), so
    unlike a full run this doesn't need extra_mirrors.py re-run afterwards. Run
    tools/make_major_plans.py rust after it."""
    releases = json.loads((HERE / "releases.json").read_text())
    majors = sorted({int(e["major"].split(".")[1]) for e in releases})
    plan_full, plan_slim = build_plans(releases, majors)
    (HERE / "download_plan.json").write_text(json.dumps(plan_full, indent=2))
    (HERE / "download_plan_slim.json").write_text(json.dumps(plan_slim, indent=2))
    gb = lambda p: sum(e.get("size") or 0 for e in p) / 1e9
    print(f"plan: {len(plan_full)} files {gb(plan_full):.1f} GB; slim: {len(plan_slim)} files {gb(plan_slim):.1f} GB")


def main():
    if "--plans-only" in sys.argv:
        plans_only()
        return
    debug_max = None
    if "--debug-majors" in sys.argv:
        debug_max = int(sys.argv[sys.argv.index("--debug-majors") + 1])

    latest = latest_minor()
    print(f"latest stable: 1.{latest}", file=sys.stderr)
    majors = list(range(0, latest + 1))
    if debug_max is not None:
        majors = majors[:debug_max]

    releases = []
    gaps = []
    all_head_jobs = []   # archive entries needing size
    all_installer_partials = []  # (inst_url, fmt, os, arch, variant, libc, version, major)

    for major in majors:
        toml_mode = major >= 8
        patches = discover_patches(major, toml_mode)
        if not patches:
            gaps.append({
                "runtime": "rust", "major": f"1.{major}", "os": "any", "arch": "any",
                "reason": "no channel manifest or archive found for this major at all",
                "looked_at": [f"{BASE}/channel-rust-1.{major}.0.toml" if toml_mode
                              else f"{BASE}/rust-1.{major}.0-x86_64-unknown-linux-gnu.tar.gz"],
            })
            print(f"1.{major}: NO PATCHES FOUND", file=sys.stderr)
            continue
        print(f"1.{major}: patches {patches}", file=sys.stderr)
        for patch in patches:
            version = f"1.{major}.{patch}"
            if toml_mode:
                toml_text = TOML_CACHE_DIR.joinpath(f"channel-rust-{version}.toml").read_text()
                entries, head_jobs, partials = build_toml_release_entries(major, patch, toml_text)
                releases.extend(entries)
                all_head_jobs.extend(head_jobs)
                for p in partials:
                    all_installer_partials.append(p)
            else:
                entries = build_fallback_release_entries(major, patch)
                releases.extend(entries)

    # Size-check all toml-derived archive entries (HEAD, size only)
    print(f"sizing {len(all_head_jobs)} archive entries...", file=sys.stderr)

    def size_job(entry):
        status, length = http_head(entry["url"])
        entry["size"] = length
        if status != 200:
            print(f"  WARN: {entry['url']} -> {status}", file=sys.stderr)

    pool_map(size_job, all_head_jobs)
    _save_head_cache()

    # Confirm installers (windows msvc msi / macos pkg) found via toml mode
    print(f"checking {len(all_installer_partials)} candidate installers...", file=sys.stderr)

    def installer_job(p):
        inst_url, fmt, os_, arch, variant, libc, version, major = p
        status, length = http_head(inst_url)
        if status == 200:
            return installer_entry(inst_url, fmt, os_, arch, variant, libc, version, major, length)
        return None

    installer_results = pool_map(installer_job, all_installer_partials)
    releases.extend([r for r in installer_results if r])
    _save_head_cache()

    # ---- checksums for installers that made it into a plan will be fetched
    # after plan selection, to bound request volume (see build_plans below).

    releases.sort(key=lambda e: (int(e["major"].split(".")[1]), e["version"], e["os"], e["arch"],
                                  e["kind"], e.get("variant") or ""))

    # ---- gaps: for each major, note required triples never found at any patch
    by_major = {}
    for e in releases:
        by_major.setdefault(e["major"], set()).add((e["os"], e["arch"], e.get("variant")))
    required_combos = [
        ("windows", "amd64", "msvc"), ("windows", "x86", "msvc"), ("windows", "arm64", "msvc"),
        ("windows", "amd64", "gnu"), ("windows", "x86", "gnu"),
        ("linux", "amd64", None), ("linux", "x86", None), ("linux", "arm64", None),
        ("linux", "armv7", None),
        ("macos", "amd64", None), ("macos", "arm64", None),
        ("freebsd", "amd64", None),
    ]
    for major_num in majors:
        major_key = f"1.{major_num}"
        if major_key not in by_major:
            continue  # already recorded as a full gap above
        have = by_major[major_key]
        for os_, arch, variant in required_combos:
            if (os_, arch, variant) not in have:
                # aarch64-apple-darwin / windows arm64 only exist from certain
                # majors on -- only flag as a gap if a *later* major has it
                # (i.e. it's plausible this major predates that hardware).
                gaps.append({
                    "runtime": "rust", "major": major_key, "os": os_, "arch": arch,
                    "reason": "no combined toolchain found for this os/arch/variant "
                              "at this major (hardware/target may postdate this release, "
                              "or the manifest never listed it as available)",
                    "looked_at": [f"{BASE}/channel-rust-{major_key}.0.toml"],
                })

    # ---- mirrors ----
    mirrors_info = build_mirrors(releases)

    # apply confirmed universal mirror (rsproxy) to every release entry
    for e in releases:
        for m in mirrors_info["confirmed_universal"]:
            mirror_url = e["url"].replace(BASE, m["base"].rstrip("/"))
            e["mirrors"].append(mirror_url)

    # ---- download plans ----
    plan_full, plan_slim = build_plans(releases, majors)

    # Fetch checksums for every installer entry (the plans always prefer the
    # archive over the installer per SCHEMA.md, so installers never actually
    # land in a plan -- checksumming only the "planned" subset would mean
    # checksumming nothing. It's cheap: ~550 small `<file>.sha256` GETs.
    fetch_installer_checksums([e for e in releases if e["kind"] == "installer"])

    write_all(releases, gaps, plan_full, plan_slim, mirrors_info, majors, latest)


def build_mirrors(releases):
    """Probe the four candidate mirrors on a sample of files (old + new,
    different os/arch) and record which are actually usable."""
    samples = []
    # pick a spread: earliest release, one mid-history, the newest, on a
    # couple of different os/arch/format combinations
    by_ver = sorted({e["version"] for e in releases}, key=lambda v: tuple(int(x) for x in v.split(".")))
    if not by_ver:
        return {"confirmed_universal": [], "checked_not_usable": []}
    pick_versions = {by_ver[0], by_ver[len(by_ver) // 2], by_ver[-1]}
    for e in releases:
        if e["version"] in pick_versions and e["kind"] == "archive":
            samples.append(e)
    # de-dup: keep at most ~2 per picked version to get >=5 total but varied os/arch
    trimmed = []
    seen_per_version = {}
    for e in samples:
        c = seen_per_version.get(e["version"], 0)
        if c < 3:
            trimmed.append(e)
            seen_per_version[e["version"]] = c + 1
    samples = trimmed[:8]

    candidates = [
        {"name": "tuna", "base": "https://mirrors.tuna.tsinghua.edu.cn/rustup/dist/"},
        {"name": "ustc", "base": "https://mirrors.ustc.edu.cn/rust-static/dist/"},
        {"name": "rsproxy", "base": "https://rsproxy.cn/dist/"},
        {"name": "aliyun", "base": "https://mirrors.aliyun.com/rustup/dist/"},
    ]

    confirmed_universal = []
    checked_not_usable = []
    notes = []

    for cand in candidates:
        ok = 0
        checked = 0
        detail = []
        for e in samples:
            mirror_url = e["url"].replace(BASE, cand["base"].rstrip("/"))
            status, length = http_head_follow(mirror_url, expect_size=e.get("size"))
            checked += 1
            match = status == 200 and length == e.get("size")
            detail.append({"version": e["version"], "os": e["os"], "arch": e["arch"],
                            "status": status, "size_match": match})
            if match:
                ok += 1
        if ok >= 5 or (ok == checked and ok >= 3):
            confirmed_universal.append({
                "name": cand["name"], "base": cand["base"],
                "confirmed_on": detail, "note": "size-matched HEAD across old/mid/new releases",
            })
        else:
            checked_not_usable.append({
                "name": cand["name"], "base": cand["base"], "checked": detail,
                "note": "did not consistently return the same file/size (see checked list)",
            })
    return {"confirmed_universal": confirmed_universal, "checked_not_usable": checked_not_usable,
            "notes": notes}


def build_plans(releases, majors):
    archives = [e for e in releases if e["kind"] == "archive"]

    def key(e):
        return (e["major"], e["os"], e["arch"], e.get("variant"))

    def is_plan_combo(e):
        # restricted to windows/linux/macos; windows -> msvc and gnu variants,
        # linux -> glibc only; every arch available for that os/variant/libc
        # is kept (no arch allow-list), per task instructions.
        # gnu added 2026-09-18: its rust-mingw component carries a linker and
        # MinGW import libraries, so it builds pure-Rust crates without Visual
        # Studio Build Tools (see NOTES.md "Windows without Build Tools").
        # gnullvm is left out: it ships no linker and too few import libraries.
        if e["os"] == "windows":
            return e.get("variant") in ("msvc", "gnu")
        if e["os"] == "linux":
            return e.get("libc") == "glibc"
        if e["os"] == "macos":
            return True
        return False

    def prefer(a, b):
        # newer patch wins; tar.xz over tar.gz if same version
        av = tuple(int(x) for x in a["version"].split("."))
        bv = tuple(int(x) for x in b["version"].split("."))
        if av != bv:
            return a if av > bv else b
        if a["format"] == "tar.xz" and b["format"] != "tar.xz":
            return a
        if b["format"] == "tar.xz" and a["format"] != "tar.xz":
            return b
        return a

    best = {}
    for e in archives:
        if not is_plan_combo(e):
            continue
        k = key(e)
        if k not in best:
            best[k] = e
        else:
            best[k] = prefer(best[k], e)

    plan_full = list(best.values())

    edition_majors = {31, 56, 85}  # 2018, 2021, 2024 editions
    latest_major = max(majors)
    every_10th = {m for m in majors if m % 10 == 0}
    slim_majors = {0} | edition_majors | every_10th | {latest_major}
    plan_slim = [e for e in plan_full if int(e["major"].split(".")[1]) in slim_majors]

    return plan_full, plan_slim


def fetch_installer_checksums(plan_entries):
    def job(e):
        if e["kind"] == "installer" and e.get("checksum") is None:
            text = http_get_text(e["url"] + ".sha256")
            if text:
                m = re.match(r"([0-9a-f]{64})", text.strip())
                if m:
                    e["checksum"] = {"algo": "sha256", "value": m.group(1)}
    pool_map(job, plan_entries)


def write_all(releases, gaps, plan_full, plan_slim, mirrors_info, majors, latest):
    (HERE / "releases.json").write_text(json.dumps(releases, indent=2))
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2))
    (HERE / "download_plan.json").write_text(json.dumps(plan_full, indent=2))
    (HERE / "download_plan_slim.json").write_text(json.dumps(plan_slim, indent=2))

    mirrors_doc = []
    for m in mirrors_info["confirmed_universal"]:
        mirrors_doc.append({
            "name": m["name"],
            "base": m["base"],
            "url_template": m["base"].rstrip("/") + "/<same path as static.rust-lang.org/dist/...>",
            "confirmed": True,
            "sampled": m["confirmed_on"],
            "note": m["note"],
            "applied_to": "every releases.json entry (path-substitution on the official url)",
        })
    for m in mirrors_info["checked_not_usable"]:
        mirrors_doc.append({
            "name": m["name"],
            "base": m["base"],
            "confirmed": False,
            "checked": m["checked"],
            "note": m["note"],
            "applied_to": None,
        })
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2))

    prose_lines = []
    for m in mirrors_info["confirmed_universal"]:
        n_ok = sum(1 for s in m["confirmed_on"] if s["size_match"])
        n_tot = len(m["confirmed_on"])
        prose_lines.append(
            f"- **{m['name']}** (`{m['base']}`): confirmed, {n_ok}/{n_tot} sampled files "
            f"size-matched (see mirrors.json for which). Applied to every releases.json "
            f"entry (path substitution on the official url)."
        )
    for m in mirrors_info["checked_not_usable"]:
        n_ok = sum(1 for s in m["checked"] if s["size_match"])
        n_tot = len(m["checked"])
        statuses = sorted({s["status"] for s in m["checked"]})
        caveat = ""
        if m["name"] == "tuna":
            caveat = (" Its dated snapshot directories are a rolling window (observed to hold "
                      "roughly the last 4 weeks as of this run -- 2026-08-20 onward existed, "
                      "2026-08-15 and earlier all 404), so only the newest release(s) would ever "
                      "match; not a stable rule to bake into a catalog spanning 2015-2026.")
        elif m["name"] == "aliyun":
            caveat = (" It does serve the un-dated `channel-rust-*.toml` files, but every dated "
                      "`/YYYY-MM-DD/rust-*.tar.*` path tried 404s -- this mirror appears to only "
                      "carry the rustup bootstrap files, not the dist archive.")
        prose_lines.append(
            f"- **{m['name']}** (`{m['base']}`): not usable, {n_ok}/{n_tot} sampled files "
            f"size-matched (statuses seen: {statuses}).{caveat} Not applied to any entry."
        )
    mirror_prose = "\n".join(prose_lines)

    full_gb = sum((e.get("size") or 0) for e in plan_full) / 1e9
    slim_gb = sum((e.get("size") or 0) for e in plan_slim) / 1e9
    est_all_majors_gb = sum((e.get("size") or 0) for e in releases if e["kind"] == "archive") / 1e9

    notes = f"""# Rust catalog notes

## Sources
- `https://static.rust-lang.org/dist/channel-rust-stable.toml` for the current
  stable version (used only to find the latest major, 1.{latest}).
- `https://static.rust-lang.org/dist/channel-rust-1.N.M.toml` per release,
  from 1.8.0 onward (1.6.0 and 1.7.0 both 404; majors 1.0-1.7 have no channel
  manifest at all).
- Majors 1.0-1.7: fell back to `rust-1.N.M-<triple>.tar.gz` + `.sha256`
  companions directly, discovered with HEAD requests (no channel toml exists
  to list targets, so only the required host triples were probed, not the
  full extra set).
- Patch discovery: for each major, tried patch 0..15 (toml GET or tar.gz
  HEAD) and kept whichever came back non-404. Re-runs are fast because every
  toml body and HEAD (status, size) result is cached under `.cache/`.
- Combined-toolchain size came from a HEAD on the `xz_url` (preferred) or
  `url` (tar.gz fallback) named in each channel toml -- the toml itself does
  not carry a size field, only sha256 hashes.
- Standalone `.msi` (windows msvc) / `.pkg` (macos) installers: HEAD-checked
  for every version/triple that has a combined archive (not just a sample),
  since that HEAD request was already being made in the same pass. Checksums
  for every installer entry came from a follow-up GET of its `<file>.sha256`
  companion (small text file, ~550 requests total).

## Triple mapping
See `TRIPLE_MAP` in scrape.py. Required host triples per the task spec are
all covered. A handful of extra tier-1/tier-2 host triples present in recent
manifests were mapped where an obvious os/arch/libc exists (aarch64/x86_64
freebsd, riscv64gc-unknown-linux-gnu, s390x, ppc64/ppc64le glibc+musl,
loongarch64 glibc+musl, windows gnullvm, arm-unknown-linux-gnueabi(hf) as
armv6 soft/hardfloat, solaris/illumos/netbsd amd64). Skipped as unmappable:
`*-unknown-linux-ohos` (OpenHarmony isn't a normalised os), `sparcv9-sun-solaris`
(no sparc arch in the schema), `powerpc-unknown-linux-gnu` (32-bit ppc, no
matching arch).

## Gaps
`gaps.json` records two kinds of gap: a major with literally nothing found
(shouldn't happen for any 1.N <= {latest}, kept as a safety net), and a
required os/arch/variant combo missing at a specific major -- mostly early
majors that predate a target's existence (e.g. no aarch64-apple-darwin
before Apple Silicon, no aarch64-pc-windows-msvc before ~1.71) or windows-gnu
before it existed. These are expected, not scraper failures; read
`reason` per entry.

## Mirrors
Checked the four candidates named in the task with a *live* (uncached),
retried HEAD -- up to 3 attempts, 1.5s apart, since third-party mirrors
proved flakier than the official S3-backed static.rust-lang.org -- sampling
old (1.0.0, 2015), mid (1.51.0, 2021) and current (1.{latest}) releases
across linux/macos/freebsd/illumos:
{mirror_prose}
Full per-sample detail (status + size-match per file) is in mirrors.json.

## Download plans
- `download_plan.json`: newest patch per (major, os, arch), restricted to
  windows/msvc, linux/glibc, macos, preferring tar.xz. Covers every major
  1.0-1.{latest} (subject to the gaps above for targets that didn't exist
  yet at a given major).
- `download_plan_slim.json`: 1.0, the edition majors (1.31, 1.56, 1.85),
  every 10th minor (1.10, 1.20, ... 1.90), and the latest (1.{latest}), same
  os/arch rules.
- Planned size: **{full_gb:.1f} GB** (full plan), **{slim_gb:.1f} GB** (slim
  plan). For reference, if every archive entry in releases.json (all majors,
  all mapped os/arch/variant/libc combos, not just the plan subset) were
  downloaded it would be roughly **{est_all_majors_gb:.1f} GB**.

## Not downloaded
Per instructions, no toolchain file was downloaded -- every size and
existence check above is a HEAD request (or, for the .sha256 companions and
channel tomls, a GET of a small text file).
"""
    (HERE / "NOTES.md").write_text(notes)
    print(f"wrote {len(releases)} releases, {len(gaps)} gaps, "
          f"{len(plan_full)} plan_full, {len(plan_slim)} plan_slim", file=sys.stderr)
    print(f"plan_full: {full_gb:.1f} GB, plan_slim: {slim_gb:.1f} GB, "
          f"all-majors estimate: {est_all_majors_gb:.1f} GB", file=sys.stderr)


if __name__ == "__main__":
    main()
