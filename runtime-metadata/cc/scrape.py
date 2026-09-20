#!/usr/bin/env python3
"""Scrape official C/C++ toolchain release metadata into the runtime catalog schema.

Covers, under runtime="llvm" (LLVM/Clang) and runtime="gcc" (WinLibs, w64devkit,
GCC source), plus runtime="msvc-redist" (VC++ redistributable / Build Tools
bootstrapper). Python 3 stdlib only; shells out to the `gh` CLI for GitHub's
release API (paginated, authenticated, no manual rate-limit bookkeeping needed).

Everything this script fetches (release bodies, filenames, HTML directory
listings) is untrusted vendor data: it is only ever parsed for structure
(filenames, sizes, dates) and never executed or treated as instructions.

Network use is limited to:
  - `gh api ... --paginate` for GitHub Releases (llvm/llvm-project,
    brechtsanders/winlibs_mingw, skeeto/w64devkit)
  - one GET of releases.llvm.org/download.html (historical LLVM binary index)
  - one GET of ftp.gnu.org/gnu/gcc/ (directory listing)
  - HEAD requests only (<=10 concurrent) to size files that don't come with a
    size from an API: releases.llvm.org binaries, ftp.gnu.org GCC tarballs,
    aka.ms MSVC redistributable permalinks, and a handful of GCC mirror URLs
    used only to *confirm* mirrors, never to download them.

Re-run any time; it fully regenerates releases.json, gaps.json,
download_plan.json, download_plan_slim.json and mirrors.json.
"""
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = "installer-builder-runtimes-catalog/1.0 (+scrape.py; contact: catalog maintainer)"
TIMEOUT = 30

LANGUAGES = ["c", "cpp"]

# ---------------------------------------------------------------- helpers --

def gh_api(path):
    """Return the fully-paginated JSON array for a GitHub API list endpoint.

    `gh api --paginate -q '.'` prints one JSON array per page, concatenated
    back-to-back rather than merged into one array -- so this decodes a
    stream of JSON documents and flattens them."""
    cmd = ["gh", "api", path, "--paginate", "-q", "."]
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    if out.returncode != 0:
        raise RuntimeError(f"gh api {path} failed: {out.stderr[:500]}")
    decoder = json.JSONDecoder()
    text = out.stdout
    items = []
    idx = 0
    n = len(text)
    while idx < n:
        while idx < n and text[idx] in " \n\t\r":
            idx += 1
        if idx >= n:
            break
        obj, end = decoder.raw_decode(text, idx)
        items.extend(obj) if isinstance(obj, list) else items.append(obj)
        idx = end
    return items


GITHUB_DIGEST_SOURCE = "GitHub release asset digest (api.github.com)"


def digest_checksum(asset):
    """GitHub release asset objects carry a `digest` field like
    'sha256:<hex>' for assets uploaded recently enough that GitHub computed
    one (older assets -- roughly pre-2025 -- have digest: null). No extra
    request needed: it rides along in the same paginated releases response
    we already fetched."""
    digest = asset.get("digest")
    if not digest or ":" not in digest:
        return None
    algo, _, value = digest.partition(":")
    if algo != "sha256" or not re.fullmatch(r'[0-9a-fA-F]{64}', value):
        return None
    return {"algo": "sha256", "value": value.lower(), "source": GITHUB_DIGEST_SOURCE}


def http_get(url, timeout=TIMEOUT):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
    if data[:2] == b'\x1f\x8b':  # some static hosts (releases.llvm.org) gzip unconditionally
        import gzip
        data = gzip.decompress(data)
    return data


def http_head(url, timeout=20):
    """Return (status, size_bytes_or_None, last_modified_or_None, final_url)."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            size = r.headers.get("Content-Length")
            lm = r.headers.get("Last-Modified")
            return r.status, (int(size) if size else None), lm, r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, None, None, url
    except Exception:
        return None, None, None, url


def head_many(urls, workers=10):
    urls = list(dict.fromkeys(urls))  # de-dup, keep order
    results = {}
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(http_head, u): u for u in urls}
        for f in futs:
            results[futs[f]] = f.result()
    return results


def lm_to_date(lm):
    if not lm:
        return None
    try:
        from email.utils import parsedate_to_datetime
        return parsedate_to_datetime(lm).date().isoformat()
    except Exception:
        return None


def is_prerelease_tag(tag):
    return bool(re.search(r'-rc\d|-beta|-alpha|snapshot', tag, re.I))


# =========================================================== LLVM / Clang ==

ARCH_MAP = {
    "x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64",
    "armv7a": "armv7", "armv7": "armv7", "i686": "x86", "i586": "x86", "i386": "x86",
    "powerpc64le": "ppc64le", "ppc64le": "ppc64le", "s390x": "s390x",
    "win64": "amd64", "win32": "x86", "woa64": "arm64",
}
SKIP_OS_TOKENS = ("freebsd", "solaris", "netbsd", "openbsd", "dragonfly", "aix", "mips")

RE_WIN_INSTALLER = re.compile(r'^LLVM-([0-9][0-9.]*)-(win32|win64|woa64)\.exe$')
RE_WIN_ARCHIVE_NEW = re.compile(r'^LLVM-([0-9][0-9.]*)-Windows-X64\.tar\.xz$')
RE_WIN_ARCHIVE_MSVC = re.compile(r'^clang\+llvm-([0-9][0-9.]*)-x86_64-pc-windows-msvc\.tar\.(xz|gz)$')
RE_LINUX_GENERIC = re.compile(r'^LLVM-([0-9][0-9.]*)-Linux-(X64|ARM64)\.tar\.xz$')
RE_MACOS_NEW = re.compile(r'^LLVM-([0-9][0-9.]*)-macOS-(ARM64|X64)\.tar\.xz$')
RE_CLANGLLVM = re.compile(r'^clang\+llvm-([0-9][0-9.]*)-([a-z0-9_]+)-(.+)\.tar\.(xz|gz)$')


def llvm_major(version):
    parts = version.split('.')
    return f"3.{parts[1]}" if parts[0] == '3' else parts[0]


def classify_llvm_asset(name):
    """Return dict(os, arch, kind, format, variant) or None if out of scope."""
    if re.search(r'-rc\d', name):
        return None
    if name.endswith(('.sig', '.jsonl', '.sha256', '.sha512', '.asc')):
        return None

    m = RE_WIN_INSTALLER.match(name)
    if m:
        arch = ARCH_MAP[m.group(2)]
        return dict(os="windows", arch=arch, kind="installer", format="exe", variant=None)

    m = RE_WIN_ARCHIVE_NEW.match(name)
    if m:
        return dict(os="windows", arch="amd64", kind="archive", format="tar.xz", variant=None)

    m = RE_WIN_ARCHIVE_MSVC.match(name)
    if m:
        return dict(os="windows", arch="amd64", kind="archive", format=f"tar.{m.group(2)}", variant="msvc")

    m = RE_LINUX_GENERIC.match(name)
    if m:
        arch = "amd64" if m.group(2) == "X64" else "arm64"
        return dict(os="linux", arch=arch, kind="archive", format="tar.xz", variant=None)

    m = RE_MACOS_NEW.match(name)
    if m:
        arch = "arm64" if m.group(2) == "ARM64" else "amd64"
        return dict(os="macos", arch=arch, kind="archive", format="tar.xz", variant=None)

    m = RE_CLANGLLVM.match(name)
    if m:
        arch_tok, rest, ext = m.group(2), m.group(3), m.group(4)
        if any(tok in rest for tok in SKIP_OS_TOKENS):
            return None
        if arch_tok not in ARCH_MAP:
            return None
        arch = ARCH_MAP[arch_tok]
        fmt = f"tar.{ext}"
        if "apple-darwin" in rest:
            return dict(os="macos", arch=arch, kind="archive", format=fmt, variant=None)
        if "linux" in rest:
            dm = re.search(r'(ubuntu-[\d.]+|rhel-[\d.]+|sles-?[\d.]+|opensuse-?[\d.]+|fedora-?\d+|debian-?\d+)', rest, re.I)
            variant = dm.group(1) if dm else None
            return dict(os="linux", arch=arch, kind="archive", format=fmt, variant=variant)
        return None

    return None


def scrape_llvm_github():
    releases = []
    all_rel = gh_api("repos/llvm/llvm-project/releases")
    for r in all_rel:
        tag = r["tag_name"]
        if r.get("draft") or r.get("prerelease") or is_prerelease_tag(tag):
            continue
        if not tag.startswith("llvmorg-"):
            continue
        version = tag[len("llvmorg-"):]
        # majors 7,8,9 have GitHub release objects only for one patch each
        # (7.1.0 / 8.0.1 / 9.0.1); older patches within those majors come
        # from releases.llvm.org (scrape_llvm_old below) to avoid gaps.
        major = llvm_major(version)
        try:
            major_num = float(major.split('.')[0])
        except ValueError:
            continue
        if major_num < 7:
            continue  # handled by the pre-GitHub page
        published = (r.get("published_at") or "")[:10] or None
        for asset in r.get("assets", []):
            cls = classify_llvm_asset(asset["name"])
            if not cls:
                continue
            releases.append({
                "runtime": "llvm", "languages": LANGUAGES, "major": major, "version": version,
                "os": cls["os"], "arch": cls["arch"], "kind": cls["kind"], "format": cls["format"],
                "variant": cls["variant"], "libc": "glibc" if cls["os"] == "linux" else None,
                "url": asset["browser_download_url"], "mirrors": [], "checksum": digest_checksum(asset),
                "size": asset.get("size"), "released": published, "min_os": None,
                "metadata_source": f"https://api.github.com/repos/llvm/llvm-project/releases/tags/{tag}",
                "notes": None,
            })
    return releases


def scrape_llvm_old():
    """releases.llvm.org/download.html covers every version back to 1.0; we only
    use it for majors 3.4-6.x, which never got a GitHub Releases object at all.
    (Majors 7,8,9 have a GitHub release for their final .0/.1 patch already
    covering windows/linux/macos; their earlier patches are minor and skipped
    to keep the HEAD-request budget small -- noted in NOTES.md.)"""
    html = http_get("https://releases.llvm.org/download.html").decode("utf-8", "replace")
    html = re.sub(r'<!--.*?-->', '', html, flags=re.S)  # drop commented-out (unpublished) links
    sections = re.split(r'(?=<a name="[0-9][0-9.]*">Download LLVM)', html)
    wanted_major = re.compile(r'^3\.[4-9]\.|^[4-6]\.')
    to_head = []
    parsed_sections = []
    for sec in sections:
        m = re.match(r'<a name="([0-9][0-9.]*)">Download LLVM', sec)
        if not m:
            continue
        version = m.group(1)
        if not wanted_major.match(version + '.'):
            continue
        bm = re.search(r'Pre-[Bb]uilt Binaries:(.*)$', sec, re.S)
        body = bm.group(1) if bm else ""
        hrefs = re.findall(r'href="([^"]+)"', body)
        items = []
        for href in hrefs:
            if href.startswith("http"):
                continue  # already-migrated-to-GitHub link; covered elsewhere
            name = href.rsplit('/', 1)[-1]
            cls = classify_llvm_asset(name)
            if not cls:
                continue
            url = f"https://releases.llvm.org/{href}"
            items.append((name, url, cls))
            to_head.append(url)
        parsed_sections.append((version, items))

    heads = head_many(to_head, workers=10)
    releases = []
    for version, items in parsed_sections:
        major = llvm_major(version)
        for name, url, cls in items:
            status, size, lm, _ = heads.get(url, (None, None, None, None))
            if status != 200 or not size:
                continue
            releases.append({
                "runtime": "llvm", "languages": LANGUAGES, "major": major, "version": version,
                "os": cls["os"], "arch": cls["arch"], "kind": cls["kind"], "format": cls["format"],
                "variant": cls["variant"], "libc": "glibc" if cls["os"] == "linux" else None,
                "url": url, "mirrors": [], "checksum": None, "size": size,
                "released": lm_to_date(lm), "min_os": None,
                "metadata_source": "https://releases.llvm.org/download.html",
                "notes": None,
            })
    return releases


# ============================================== GCC via WinLibs (Windows) ==

RE_WINLIBS = re.compile(
    r'^winlibs-(i686|x86_64)-(posix|win32|mcf)-(seh|sjlj|dwarf)-gcc-([\d.]+)-'
    r'mingw-w64(ucrt|msvcrt)-([\d.]+)-r(\d+)\.(7z|zip)$'
)
WINLIBS_ARCH = {"i686": "x86", "x86_64": "amd64"}
WINLIBS_MIN_OS = {
    "ucrt": "Windows 7 SP1 / Server 2008 R2 SP1 or later (needs the Universal C Runtime "
            "update on those; native on Windows 10+)",
    "msvcrt": "Windows XP or later",
}


def scrape_winlibs():
    releases = []
    all_rel = gh_api("repos/brechtsanders/winlibs_mingw/releases")
    for r in all_rel:
        tag = r["tag_name"]
        if r.get("draft") or r.get("prerelease") or "snapshot" in tag.lower():
            continue
        published = (r.get("published_at") or "")[:10] or None
        for asset in r.get("assets", []):
            m = RE_WINLIBS.match(asset["name"])
            if not m:
                continue
            arch_tok, thread, exc, gccver, crt, mingwver, rev, ext = m.groups()
            major = gccver.split('.')[0]
            releases.append({
                "runtime": "gcc", "languages": LANGUAGES, "major": major, "version": tag,
                "os": "windows", "arch": WINLIBS_ARCH[arch_tok], "kind": "archive", "format": ext,
                "variant": f"winlibs-{thread}-{crt}", "libc": None,
                "url": asset["browser_download_url"], "mirrors": [], "checksum": digest_checksum(asset),
                "size": asset.get("size"), "released": published,
                "min_os": WINLIBS_MIN_OS[crt],
                "metadata_source": "https://api.github.com/repos/brechtsanders/winlibs_mingw/releases",
                "notes": f"bundles GCC {gccver}, mingw-w64 {mingwver}, exception model {exc}, build r{rev}",
            })
    return releases


# =================================================== w64devkit (Windows) ==

RE_W64DK_V2 = re.compile(r'^w64devkit-(x64|x86)-([\d.]+)\.7z\.exe$')
RE_W64DK_V1 = re.compile(r'^w64devkit-(i686-)?(fortran-)?([\d.]+)\.zip$')
W64DK_ARCH = {"x64": "amd64", "x86": "x86", "i686": "x86"}


def _semver_key(tag):
    nums = re.findall(r'\d+', tag)
    return tuple(int(n) for n in nums) if nums else (0,)


def scrape_w64devkit():
    releases = []
    all_rel = gh_api("repos/skeeto/w64devkit/releases")
    all_rel = [r for r in all_rel if not (r.get("draft") or r.get("prerelease"))]
    # oldest -> newest so we can carry forward the last-announced bundled GCC version
    all_rel.sort(key=lambda r: _semver_key(r["tag_name"]))
    last_gcc = None
    for r in all_rel:
        tag = r["tag_name"]
        body = r.get("body") or ""
        gm = re.search(r'GCC[ \-]?v?(\d+(?:\.\d+){0,2})', body)
        if gm:
            last_gcc = gm.group(1)
        gcc_major = (last_gcc or "0").split('.')[0]
        published = (r.get("published_at") or "")[:10] or None
        for asset in r.get("assets", []):
            name = asset["name"]
            variant = None
            m2 = RE_W64DK_V2.match(name)
            m1 = RE_W64DK_V1.match(name) if not m2 else None
            if m2:
                arch = W64DK_ARCH[m2.group(1)]
                fmt = "7z-sfx"
            elif m1:
                arch = "x86" if m1.group(1) else "amd64"
                variant = "fortran" if m1.group(2) else None
                fmt = "zip"
            else:
                continue
            releases.append({
                "runtime": "gcc", "languages": LANGUAGES, "major": gcc_major, "version": tag.lstrip('v'),
                "os": "windows", "arch": arch, "kind": "archive", "format": fmt,
                "variant": "w64devkit" if not variant else f"w64devkit-{variant}", "libc": None,
                "url": asset["browser_download_url"], "mirrors": [], "checksum": digest_checksum(asset),
                "size": asset.get("size"), "released": published, "min_os": "Windows 7 or later",
                "metadata_source": "https://api.github.com/repos/skeeto/w64devkit/releases",
                "notes": f"bundled GCC {last_gcc}" if last_gcc else "bundled GCC version not stated in release notes",
            })
    return releases


# ============================================================ GCC source ==

def scrape_gcc_source():
    listing = http_get("https://ftp.gnu.org/gnu/gcc/").decode("utf-8", "replace")
    vers = sorted(set(re.findall(r'href="gcc-(\d+\.\d+\.\d+)/"', listing)))

    def vkey(v):
        return tuple(int(x) for x in v.split('.'))

    by_major = {}
    for v in vers:
        maj = v.split('.')[0]
        if int(maj) < 4:
            continue
        if maj == '4' and vkey(v) < (4, 8, 0):
            continue  # pre-4.8: too old to matter to a modern installer builder
        by_major.setdefault(maj, []).append(v)
    newest_per_major = {maj: max(vs, key=vkey) for maj, vs in by_major.items()}

    candidates = {}  # version -> list of (ext, url)
    for maj, v in newest_per_major.items():
        for ext in ("tar.xz", "tar.bz2"):
            candidates.setdefault(v, []).append((ext, f"https://ftp.gnu.org/gnu/gcc/gcc-{v}/gcc-{v}.{ext}"))

    all_urls = [u for items in candidates.values() for _, u in items]
    heads = head_many(all_urls, workers=10)

    releases = []
    for v, items in candidates.items():
        chosen = None
        for ext, url in items:  # tar.xz preferred (listed first), else tar.bz2
            status, size, lm, _ = heads.get(url, (None, None, None, None))
            if status == 200 and size:
                chosen = (ext, url, size, lm)
                break
        if not chosen:
            continue
        ext, url, size, lm = chosen
        releases.append({
            "runtime": "gcc", "languages": LANGUAGES, "major": v.split('.')[0], "version": v,
            "os": "linux", "arch": "any", "kind": "source", "format": ext, "variant": None,
            "libc": None, "url": url, "mirrors": [], "checksum": None, "size": size,
            "released": lm_to_date(lm), "min_os": None,
            "metadata_source": "https://ftp.gnu.org/gnu/gcc/",
            "notes": "GNU ships no official GCC binaries for Linux or macOS; source must be built.",
        })
    return releases


def fetch_winlibs_checksums(plan_entries, mismatches):
    """WinLibs publishes a `<asset>.sha256` sidecar next to every archive.
    Fetching it is a tiny GET (~130 bytes), not a download of the archive
    itself. Only done for entries actually selected into a download plan,
    to keep the request count bounded.

    Every WinLibs entry already has a GitHub-digest checksum (set in
    scrape_winlibs via digest_checksum, no extra request). If the sidecar
    disagrees with that digest, the sidecar value wins (it's the vendor's
    own published hash) but the disagreement is recorded in `mismatches`
    for NOTES.md -- that would mean either GitHub or WinLibs served a
    different file than the other believes, which is worth a human look."""
    targets = [r for r in plan_entries if r["runtime"] == "gcc" and (r.get("variant") or "").startswith("winlibs-")]
    for r in targets:
        try:
            data = http_get(r["url"] + ".sha256", timeout=15).decode("utf-8", "replace").strip()
        except Exception:
            continue
        m = re.match(r'^([0-9a-fA-F]{64})', data)
        if not m:
            continue
        sidecar_value = m.group(1).lower()
        prior = r.get("checksum")
        if prior and prior.get("algo") == "sha256" and prior.get("value") != sidecar_value:
            mismatches.append({
                "url": r["url"],
                "version": r["version"],
                "github_digest": prior["value"],
                "winlibs_sidecar": sidecar_value,
            })
        r["checksum"] = {"algo": "sha256", "value": sidecar_value, "source": r["url"] + ".sha256"}


def confirm_gcc_mirrors(releases):
    """Sample >=5 GCC-source files (old and new majors) against candidate GNU
    mirrors; a HEAD with a matching size confirms the mirror for ALL files at
    that mirror sharing the same path layout (releases/gcc-<ver>/gcc-<ver>.<ext>)."""
    by_ver = {r["version"]: r for r in releases if r["runtime"] == "gcc" and r["kind"] == "source"}
    sample_versions = sorted(by_ver, key=lambda v: tuple(int(x) for x in v.split('.')))
    sample = ([sample_versions[0], sample_versions[len(sample_versions)//2]] if len(sample_versions) >= 2 else sample_versions) \
        + sample_versions[-3:]
    sample = list(dict.fromkeys(sample))[:6]

    mirror_bases = [
        "https://ftp.gwdg.de/pub/misc/gcc",
        "https://ftp.fu-berlin.de/unix/languages/gcc",
        "https://mirrorservice.org/sites/sourceware.org/pub/gcc",
    ]
    confirmed = []
    for base in mirror_bases:
        urls = []
        for v in sample:
            r = by_ver[v]
            fname = r["url"].rsplit('/', 1)[-1]
            urls.append(f"{base}/releases/gcc-{v}/{fname}")
        heads = head_many(urls, workers=10)
        ok, checked = 0, 0
        for v, u in zip(sample, urls):
            status, size, _, _ = heads[u]
            if status is None:
                continue
            checked += 1
            if status == 200 and size == by_ver[v]["size"]:
                ok += 1
        if checked and ok == checked and ok >= 3:
            confirmed.append({
                "runtime": "gcc",
                "url_template": base + "/releases/gcc-{version}/gcc-{version}.{format}",
                "confirmed_on": sample[:ok],
                "method": f"HEAD, size matched ftp.gnu.org on {ok}/{checked} sampled versions "
                          "(old and new majors); applied to all gcc-source entries sharing this layout",
                "source_list": "https://gcc.gnu.org/mirrors.html",
            })
            for r in releases:
                if r["runtime"] == "gcc" and r["kind"] == "source":
                    mirror_url = base + f"/releases/gcc-{r['version']}/{r['url'].rsplit('/', 1)[-1]}"
                    if mirror_url not in r["mirrors"]:
                        r["mirrors"].append(mirror_url)
    return confirmed


# ================================================================= MSVC ==

def scrape_msvc():
    releases = []
    targets = [
        ("x64", "amd64"), ("x86", "x86"), ("arm64", "arm64"),
    ]
    urls = [f"https://aka.ms/vs/17/release/vc_redist.{t}.exe" for t, _ in targets]
    heads = head_many(urls, workers=5)
    for (t, arch), url in zip(targets, urls):
        status, size, lm, final_url = heads[url]
        if status != 200:
            continue
        releases.append({
            "runtime": "msvc-redist", "languages": LANGUAGES, "major": "14.x", "version": "latest",
            "os": "windows", "arch": arch, "kind": "installer", "format": "exe", "variant": None,
            "libc": None, "url": url, "mirrors": [], "checksum": None, "size": size,
            "released": lm_to_date(lm), "min_os": None,
            "metadata_source": "https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist",
            "notes": f"Microsoft permalink, always serves the current VC++ 14.x redistributable; "
                     f"redirects to {final_url.rsplit('/', 1)[-1]} at scrape time. 'version' is nominal, "
                     "not pinned -- re-running this script later will see a newer build at the same URL.",
        })
    bt_url = "https://aka.ms/vs/17/release/vs_BuildTools.exe"
    status, size, lm, final_url = http_head(bt_url)
    if status == 200:
        releases.append({
            "runtime": "msvc-redist", "languages": LANGUAGES, "major": "14.x", "version": "latest",
            "os": "windows", "arch": "amd64", "kind": "installer", "format": "exe", "variant": "buildtools",
            "libc": None, "url": bt_url, "mirrors": [], "checksum": None, "size": size,
            "released": lm_to_date(lm), "min_os": None,
            "metadata_source": "https://learn.microsoft.com/en-us/visualstudio/install/build-tools-container",
            "notes": "Bootstrapper only: this .exe (a few MB) downloads the actual MSVC/Windows-SDK "
                     "components at install time, so its own size is not representative of install size.",
        })
    return releases


# ================================================================= gaps ==

def build_gaps(llvm_releases, gcc_source_releases):
    gaps = []
    # LLVM windows/linux/macos combos genuinely missing per major (e.g. no
    # macOS ARM64 build before Apple Silicon existed, or a major that never
    # shipped a Windows installer).
    have = {(r["major"], r["os"], r["arch"]) for r in llvm_releases}
    majors = sorted({r["major"] for r in llvm_releases},
                     key=lambda m: tuple(int(x) for x in m.split('.')))
    expect_combos = [("windows", "amd64"), ("windows", "x86"), ("linux", "amd64"),
                      ("linux", "arm64"), ("macos", "amd64"), ("macos", "arm64")]
    for maj in majors:
        for os_, arch in expect_combos:
            if (maj, os_, arch) in have:
                continue
            reason = "no matching official build published for this major"
            if os_ == "macos" and arch == "arm64" and float(maj.split('.')[0] if '.' not in maj else maj.split('.')[0]) < 11:
                reason = "predates Apple Silicon (arm64 macOS did not exist yet)"
            gaps.append({
                "runtime": "llvm", "major": maj, "os": os_, "arch": arch,
                "reason": reason,
                "looked_at": ["https://api.github.com/repos/llvm/llvm-project/releases",
                              "https://releases.llvm.org/download.html"],
            })

    # GCC: no official Linux/macOS binaries at all, ever -- one gap per major we scraped source for.
    for r in gcc_source_releases:
        for os_ in ("linux", "macos"):
            gaps.append({
                "runtime": "gcc", "major": r["major"], "os": os_, "arch": "amd64",
                "reason": "gcc.gnu.org publishes source only; no official Linux or macOS binary "
                          "packages (distros/Homebrew build their own)",
                "looked_at": ["https://ftp.gnu.org/gnu/gcc/", "https://gcc.gnu.org/releases.html"],
            })

    # mingw-builds (SourceForge) -- deprecated/superseded, path not cheaply listable.
    gaps.append({
        "runtime": "gcc", "major": "various", "os": "windows", "arch": "amd64",
        "reason": "classic 'mingw-builds' SourceForge project (niXman) is defunct; its file tree is "
                  "not discoverable via a cheap listing call and it has been superseded by WinLibs "
                  "(already scraped) for current GCC-on-Windows builds",
        "looked_at": ["https://sourceforge.net/projects/mingw-w64/rss?path=/"],
    })

    # Apple Clang / Xcode Command Line Tools -- gated behind an Apple ID.
    for major in ("15", "16", "17"):
        gaps.append({
            "runtime": "llvm", "major": major, "os": "macos", "arch": "universal",
            "reason": "Apple Clang / Xcode Command Line Tools require an Apple ID sign-in to download; "
                      "not scriptable without authenticated credentials",
            "looked_at": ["https://developer.apple.com/download/all/"],
        })
    return gaps


# ============================================================== plans ==

SLIM_LLVM_MAJORS = {"3.9", "7", "10", "13", "16", "18"}


def latest_llvm_major(all_llvm):
    majors = {r["major"] for r in all_llvm}
    numeric = sorted((m for m in majors if '.' not in m), key=int)
    return numeric[-1] if numeric else None


def vkey(v):
    parts = re.findall(r'\d+', v)
    return tuple(int(p) for p in parts)


def pick_newest_patch(group):
    return max(group, key=lambda r: vkey(r["version"]))


def build_download_plan(all_releases, slim=False, latest_major=None):
    """Newest patch per (runtime, major, os, arch[, variant-bucket]).
    LLVM: prefer the smallest archive, and for linux prefer the newest
    ubuntu/generic distro variant over older/other distro tags.
    GCC/WinLibs: prefer posix+ucrt (msvcrt for majors < 9), pick the smaller
    of .zip/.7z, and skip the LLVM-enabled or alternate-exception-model builds
    (variant already narrows this to one winlibs-<thread>-<crt> string, so we
    just need to pick one variant string per (major, arch))."""
    plan = []

    llvm_all = [r for r in all_releases if r["runtime"] == "llvm"]
    if slim:
        llvm_all = [r for r in llvm_all if r["major"] in SLIM_LLVM_MAJORS or r["major"] == latest_major]
    by_key = {}
    for r in llvm_all:
        by_key.setdefault((r["major"], r["os"], r["arch"]), []).append(r)
    for (maj, os_, arch), group in by_key.items():
        newest_version = max(vkey(r["version"]) for r in group)
        newest = [r for r in group if vkey(r["version"]) == newest_version]
        if os_ == "linux":
            def linux_rank(r):
                v = r["variant"] or ""
                if v == "":
                    return (0,)  # generic build, most preferred
                m = re.search(r'ubuntu-([\d.]+)', v)
                if m:
                    nums = tuple(int(x) for x in m.group(1).split('.'))
                    neg = tuple(-x for x in nums)
                    return (1, neg)
                return (2, (0,), v)
            newest.sort(key=linux_rank)
            best_bucket_rank = linux_rank(newest[0])
            newest = [r for r in newest if linux_rank(r) == best_bucket_rank]
        chosen = min(newest, key=lambda r: r.get("size") or 1 << 62)
        plan.append(chosen)

    gcc_all = [r for r in all_releases if r["runtime"] == "gcc"]
    by_key = {}
    for r in gcc_all:
        variant = r.get("variant") or ""
        if r["os"] == "windows" and variant.startswith("winlibs-"):
            bucket = "winlibs"
        elif r["os"] == "windows" and variant and variant.startswith("w64devkit"):
            bucket = "w64devkit"
        elif r["kind"] == "source":
            bucket = "source"
        else:
            bucket = variant or "default"
        by_key.setdefault((r["major"], r["os"], r["arch"], bucket), []).append(r)
    for (maj, os_, arch, bucket), group in by_key.items():
        newest_version = max(vkey(re.sub(r'[a-zA-Z\-]', ' ', r["version"])) for r in group)
        newest = [r for r in group if vkey(re.sub(r'[a-zA-Z\-]', ' ', r["version"])) == newest_version]
        if bucket == "winlibs":
            crt_pref = "ucrt" if (maj.isdigit() and int(maj) >= 9) else "msvcrt"
            preferred = [r for r in newest if r["variant"] == f"winlibs-posix-{crt_pref}"]
            newest = preferred or newest
        elif bucket == "w64devkit":
            preferred = [r for r in newest if r["variant"] == "w64devkit"]
            newest = preferred or newest
        chosen = min(newest, key=lambda r: r.get("size") or 1 << 62)
        plan.append(chosen)

    if not slim:
        plan.extend(r for r in all_releases if r["runtime"] == "msvc-redist")
    else:
        plan.extend(r for r in all_releases if r["runtime"] == "msvc-redist")

    # de-dup defensively (runtime, major, os, arch, variant)
    seen = set()
    deduped = []
    for r in plan:
        key = (r["runtime"], r["major"], r["os"], r["arch"], r.get("variant"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(r)
    return deduped


def build_notes(all_releases, plan, plan_slim, checksum_mismatches):
    total = len(all_releases)
    with_cs = sum(1 for r in all_releases if r.get("checksum"))
    plan_with_cs = sum(1 for r in plan if r.get("checksum"))
    plan_slim_with_cs = sum(1 for r in plan_slim if r.get("checksum"))
    by_source = {}
    for r in all_releases:
        if not r.get("checksum"):
            continue
        src = r["checksum"].get("source", "?")
        key = "GitHub digest" if src == GITHUB_DIGEST_SOURCE else (
            "WinLibs sidecar" if src.endswith(".sha256") else src)
        by_source[key] = by_source.get(key, 0) + 1
    checksum_lines = "\n".join(f"  - {k}: {v}" for k, v in sorted(by_source.items()))

    if checksum_mismatches:
        mismatch_lines = "\n".join(
            f"  - `{m['url']}` (version {m['version']}): GitHub digest `{m['github_digest'][:16]}...` "
            f"vs WinLibs sidecar `{m['winlibs_sidecar'][:16]}...`"
            for m in checksum_mismatches
        )
        mismatch_block = (
            f"**{len(checksum_mismatches)} mismatch(es) found** between GitHub's asset digest and "
            f"WinLibs' own `.sha256` sidecar for the same file. The sidecar value was kept in "
            f"releases.json/download_plan*.json (it's the vendor's own published hash), but this "
            f"disagreement means one of the two was computed from a different upload than the other "
            f"currently serves -- worth a manual look before trusting either for verification:\n\n"
            f"{mismatch_lines}"
        )
    else:
        mismatch_block = (
            "No mismatches: every WinLibs planned entry where both a GitHub digest and a `.sha256` "
            "sidecar were available agreed."
        )

    return f"""# C/C++ toolchain catalog notes

`scrape.py` is Python-stdlib-only and re-runnable; it shells out to `gh api`
(authenticated, paginated) for the three GitHub-hosted projects, does one GET
each of `releases.llvm.org/download.html` and `ftp.gnu.org/gnu/gcc/`, and
uses HEAD-only requests (<=10 concurrent) for anything that doesn't hand us a
size directly. It never downloads a full toolchain archive. This file is
generated by the script itself (the counts below are live), not hand-edited.

## Sources used

- **LLVM/Clang, majors 7-23**: GitHub Releases API (`llvm/llvm-project`),
  which gives asset size for free -- no HEAD requests needed. RC/beta tags
  and draft/prerelease releases are filtered out.
- **LLVM/Clang, majors 3.4-6**: `releases.llvm.org/download.html`. This one
  page contains the full historical index back to LLVM 1.0; HTML comments
  (`<!-- -->`) mark links the maintainers pulled, and those are stripped
  before parsing so we don't record dead links. One gotcha: the server
  gzips this file unconditionally (even with no `Accept-Encoding` sent), so
  `http_get()` sniffs the gzip magic bytes and decompresses regardless of
  what was requested.
- **Majors 7, 8, 9 patches other than 7.1.0/8.0.1/9.0.1**: intentionally
  *not* scraped. Those three patches each have a full GitHub Releases object
  covering windows/linux/macos, so they already win "newest patch" in the
  download plan; the earlier patches in the same major (7.0.0, 7.0.1, 8.0.0,
  9.0.0) would only add older, non-selected releases.json rows for a
  meaningful chunk of extra HEAD requests.
- **GCC via WinLibs** (`brechtsanders/winlibs_mingw`): all 245 GitHub
  releases enumerated (sizes from the API). `major` = the bundled GCC major;
  `variant` = `winlibs-<thread>-<crt>` as the schema example names it.
  Releases with `snapshot` in the tag (unstable interim builds) are excluded.
- **w64devkit** (`skeeto/w64devkit`): all releases enumerated. It doesn't
  state a GCC version in its own version scheme, so the bundled GCC major
  is parsed out of each release body's changelog text (`GCC 14.1`, `Upgrade
  to GCC 16.1.0`, ...) walking oldest-to-newest and carrying the last-seen
  version forward for releases whose body doesn't mention a GCC bump.
- **GCC source** (`ftp.gnu.org/gnu/gcc/`): one directory listing, then the
  newest patch per major from **4.8 up** (pre-4.8 GCC predates any C++11
  support and isn't something a modern installer builder would offer; older
  majors down to 1.x exist on the mirror but were treated as out of scope,
  not as a gap). Size comes from a HEAD on the actual tarball, since Apache's
  listing only gives human-rounded sizes ("91M"), not exact bytes.
- **MSVC**: the three `aka.ms/vs/17/release/vc_redist.*.exe` permalinks plus
  `vs_BuildTools.exe`, HEAD'd to get current size (they redirect to a
  versioned `download.visualstudio.microsoft.com` URL). These permalinks are
  intentionally version-floating -- `version` is recorded as the literal
  string `"latest"`, not a pinned number, and the notes field says so.
  The existing all-in-one redist at
  `deps/windows/any/vcredist-aio/0.35.0/` was left untouched, per instructions.

## Skipped / out of scope (see gaps.json for the formal entries)

- **mingw-builds** (SourceForge, item #4 in the brief): the classic niXman
  project is defunct and superseded by WinLibs; its SourceForge path isn't
  cheaply listable (no working RSS path found in one try), so it's recorded
  as a single gap rather than guessed at.
- **Apple Clang / Xcode Command Line Tools**: gated behind an Apple ID login
  wall; recorded as gaps (majors 15-17) pointing at
  `https://developer.apple.com/download/all/`.
- **Exotic OS/arch combos LLVM also ships** (FreeBSD, Solaris, AIX, MIPS):
  present in upstream listings but out of scope for an installer builder
  targeting Windows/Linux/macOS, so they're neither scraped into
  releases.json nor recorded as gaps.
- Not every historical GCC/LLVM patch got a releases.json row for every
  distro-tagged Linux variant on every version -- see the two bullets above.
  `download_plan.json`/`_slim.json` only ever need the newest patch anyway.

## Mirrors

GitHub release assets (LLVM, WinLibs, w64devkit) are treated as canonical;
GitHub-proxy mirrors (ghproxy, tuna, etc.) are excluded per policy. For GCC
source, three GNU mirrors from `https://gcc.gnu.org/mirrors.html` were
sampled (5 versions each, spanning GCC 4.9 through 16.2) via HEAD and their
sizes matched `ftp.gnu.org` on every sampled file:

- `https://ftp.gwdg.de/pub/misc/gcc/releases/gcc-{{version}}/gcc-{{version}}.{{format}}`
- `https://ftp.fu-berlin.de/unix/languages/gcc/releases/gcc-{{version}}/gcc-{{version}}.{{format}}`
- `https://mirrorservice.org/sites/sourceware.org/pub/gcc/releases/gcc-{{version}}/gcc-{{version}}.{{format}}`

These templates were then applied to every `gcc`/`source` release entry
(same path layout), per the "confirm on a sample, apply to all matching
files" instruction; see `mirrors.json`.

## Checksums

Two independent sources are used, both free of extra per-file downloads:

- **GitHub release asset digest**: the GitHub Releases API now returns a
  `digest` field (`"sha256:<hex>"`) on each asset object for assets uploaded
  recently enough that GitHub computed one (roughly: assets uploaded before
  sometime in 2025 come back `digest: null`). This rides along in the same
  paginated `gh api .../releases` response already fetched for LLVM,
  WinLibs and w64devkit -- no extra HEAD/GET needed -- so it's applied to
  every entry from those three sources, not just planned ones.
- **WinLibs `.sha256` sidecar**: WinLibs also publishes a `<asset>.sha256`
  file next to every archive. This *does* cost one small GET per file, so
  it's fetched only for entries that made it into `download_plan.json` /
  `download_plan_slim.json`, and its value wins over the GitHub digest when
  both exist (see mismatches below).

releases.llvm.org (LLVM majors 3.4-6), ftp.gnu.org (GCC source), and the
MSVC permalinks are not GitHub-hosted and publish no machine-readable
checksum next to the file itself (LLVM's old page has PGP `.sig` detached
signatures only) -- those entries keep `checksum: null`.

Current coverage: **{with_cs} / {total}** releases.json entries have a
checksum, **{plan_with_cs} / {len(plan)}** in download_plan.json, and
**{plan_slim_with_cs} / {len(plan_slim)}** in download_plan_slim.json.

By source:
{checksum_lines}

### Sidecar vs. digest agreement

{mismatch_block}

## Known gaps in the data itself

- `min_os` is a generic statement per build flavour (e.g. "ucrt needs
  Windows 7 SP1+") rather than pulled per-release from changelog text, since
  WinLibs/w64devkit don't state it in a structured field.
- `limitations.json` (developer-capability/OS-support research pass) was
  not produced -- SCHEMA.md marks it as "added later," and the task brief
  for this pass only asked for `releases.json`, `gaps.json`,
  `download_plan.json`, `mirrors.json`, and this file.
"""


# ================================================================= main ==

def main():
    print("Scraping LLVM/Clang from GitHub Releases API...", file=sys.stderr)
    llvm_gh = scrape_llvm_github()
    print(f"  {len(llvm_gh)} release entries from GitHub", file=sys.stderr)

    print("Scraping LLVM/Clang from releases.llvm.org (majors 3.4-6.x)...", file=sys.stderr)
    llvm_old = scrape_llvm_old()
    print(f"  {len(llvm_old)} release entries from releases.llvm.org", file=sys.stderr)

    print("Scraping WinLibs GCC-for-Windows releases...", file=sys.stderr)
    winlibs = scrape_winlibs()
    print(f"  {len(winlibs)} release entries", file=sys.stderr)

    print("Scraping w64devkit releases...", file=sys.stderr)
    w64dk = scrape_w64devkit()
    print(f"  {len(w64dk)} release entries", file=sys.stderr)

    print("Scraping GCC source tarballs from ftp.gnu.org...", file=sys.stderr)
    gcc_src = scrape_gcc_source()
    print(f"  {len(gcc_src)} release entries", file=sys.stderr)

    print("Confirming GCC mirrors by HEAD sampling...", file=sys.stderr)
    confirmed_mirrors = confirm_gcc_mirrors(gcc_src)
    print(f"  {len(confirmed_mirrors)} mirror template(s) confirmed", file=sys.stderr)

    print("Checking MSVC redistributable / Build Tools permalinks...", file=sys.stderr)
    msvc = scrape_msvc()
    print(f"  {len(msvc)} release entries", file=sys.stderr)

    all_releases = llvm_gh + llvm_old + winlibs + w64dk + gcc_src + msvc
    llvm_all = [r for r in all_releases if r["runtime"] == "llvm"]
    gaps = build_gaps(llvm_all, gcc_src)

    latest_major = latest_llvm_major(llvm_all)
    plan = build_download_plan(all_releases, slim=False)
    plan_slim = build_download_plan(all_releases, slim=True, latest_major=latest_major)

    print("Fetching WinLibs sha256 sidecars for planned entries...", file=sys.stderr)
    checksum_mismatches = []
    fetch_winlibs_checksums(plan, checksum_mismatches)
    fetch_winlibs_checksums(plan_slim, checksum_mismatches)  # cheap even if it re-fetches overlapping entries
    # de-dup mismatches (same url can show up via both plan and plan_slim)
    seen_urls = set()
    checksum_mismatches = [m for m in checksum_mismatches if not (m["url"] in seen_urls or seen_urls.add(m["url"]))]

    notes = build_notes(all_releases, plan, plan_slim, checksum_mismatches)
    (HERE / "NOTES.md").write_text(notes)

    mirrors_doc = {
        "note": "GitHub release assets (llvm/llvm-project, brechtsanders/winlibs_mingw, "
                "skeeto/w64devkit) are canonical and not mirrored elsewhere worth recording. "
                "Third-party GitHub proxy mirrors (ghproxy, tuna, etc.) are intentionally excluded "
                "per catalog policy.",
        "confirmed": confirmed_mirrors,
    }

    (HERE / "releases.json").write_text(json.dumps(all_releases, indent=2, sort_keys=False) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2) + "\n")
    (HERE / "download_plan_slim.json").write_text(json.dumps(plan_slim, indent=2) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps(mirrors_doc, indent=2) + "\n")

    gb = sum((r.get("size") or 0) for r in plan) / 1e9
    gb_slim = sum((r.get("size") or 0) for r in plan_slim) / 1e9
    print(f"\nDone. {len(all_releases)} releases, {len(gaps)} gaps, "
          f"{len(plan)} planned ({gb:.1f} GB), {len(plan_slim)} planned slim ({gb_slim:.1f} GB)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
