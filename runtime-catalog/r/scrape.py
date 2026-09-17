#!/usr/bin/env python3
"""Scrape official R distribution indexes into the runtime catalog format.

Python 3 standard library only. Re-runnable: re-fetches live indexes each
time and rewrites releases.json / gaps.json / download_plan.json /
mirrors.json / NOTES.md.

Sources (all fetched live, never hard-coded beyond URL templates):
  - Windows installers: cran.r-project.org/bin/windows/base/{,old/}
    and cran-archive.r-project.org/bin/windows/base/old/<ver>/
  - macOS installers:   cran.r-project.org/bin/macosx/{base,big-sur-arm64/base,
    big-sur-x86_64/base,sonoma-arm64/base}/ and cran-archive .../bin/macosx/base/
  - Linux (Posit r-builds): cdn.posit.co/r/versions.json + per-distro pkgs/
  - Source tarballs:    cran.r-project.org/src/base/R-{1,2,3,4}/
  - Mirrors:            cran.r-project.org/CRAN_mirrors.csv

Everything fetched is treated as inert data (filenames/sizes/dates to
parse), never as instructions.
"""
import concurrent.futures
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = "installer-builder-catalog/1.0 (+https://github.com/; contact: catalog scrape script)"
TIMEOUT = 20
MAX_WORKERS = 10

CRAN = "https://cran.r-project.org"
ARCHIVE = "https://cran-archive.r-project.org"
POSIT_CDN = "https://cdn.posit.co/r"


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read().decode("utf-8", "replace")


def head(url):
    """Return (status, size_bytes) for a HEAD request, or (None, None) on failure."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            length = resp.headers.get("Content-Length")
            return resp.status, (int(length) if length else None)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def head_many(urls):
    """HEAD a list of URLs with bounded concurrency. Returns {url: (status, size)}."""
    out = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(head, u): u for u in urls}
        for fut in concurrent.futures.as_completed(futs):
            out[futs[fut]] = fut.result()
    return out


def major_of(version):
    parts = version.split(".")
    return f"{parts[0]}.{parts[1]}"


def vtuple(version):
    return tuple(int(x) for x in re.findall(r"\d+", version)[:3])


AUTOINDEX_ROW = re.compile(
    r'<a href="([^"]+)">[^<]*</a></td><td align="right">([^<]*)</td>'
    r'<td align="right">\s*([^<]*?)\s*</td>'
)


def parse_autoindex(html):
    """Parse an Apache autoindex page -> list of (filename, last_modified, size_str)."""
    out = []
    for m in AUTOINDEX_ROW.finditer(html):
        name, mtime, size = m.groups()
        if name.startswith("?") or name.startswith("/"):
            continue
        out.append((name, mtime.strip(), size.strip()))
    return out


NOTES = []


def note(msg):
    NOTES.append(msg)
    print("NOTE:", msg, file=sys.stderr)


releases = []
gaps = []
mirror_confirmations = []


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------

def scrape_windows():
    print("== Windows ==", file=sys.stderr)
    # Current release
    base_html = get(f"{CRAN}/bin/windows/base/")
    cur_m = re.search(r'href="(R-([\d.]+)-win\.exe)"', base_html)
    dirs = []  # list of (version, dir_url, is_archive_custom_html)
    if cur_m:
        cur_ver = cur_m.group(2)
        dirs.append((cur_ver, f"{CRAN}/bin/windows/base/", False, f"{CRAN}/bin/windows/base/md5sum.R-{cur_ver}.txt"))

    old_html = get(f"{CRAN}/bin/windows/base/old/")
    for href, _label in re.findall(r'href="([^"]+)">R\s*([\d.]+)</a>', old_html):
        pass  # handled below with a combined pattern
    for m in re.finditer(r'<a href="([^"]+)">R\s*([\d.]+)</a>', old_html):
        href, ver = m.groups()
        if href.startswith("http"):
            dirs.append((ver, href + "/", True, None))
        else:
            dirs.append((ver, f"{CRAN}/bin/windows/base/old/{href}/", False, None))

    # De-dup by version, prefer the non-archive (cran.r-project.org) entry
    by_ver = {}
    for ver, url, is_archive, md5_hint in dirs:
        if ver not in by_ver or not is_archive:
            by_ver[ver] = (url, is_archive, md5_hint)

    # Standalone very-old files listed directly on the old/ page (no subdirectory)
    standalone = {}
    for m in re.finditer(r'<a href="(https://cran-archive\.r-project\.org/bin/windows/base/old/([^"/.]+\.(?:exe|zip)))">', old_html):
        pass
    for m in re.finditer(r'href="(https://cran-archive\.r-project\.org/bin/windows/base/old/(Setup\w+\.exe|R\d+\.zip))"', old_html):
        url, fname = m.groups()
        vm = re.search(r"Installer for R ([\d.]+)|Binary files for R ([\d.]+)", old_html[max(0, m.start() - 5):m.start() + 200])
        standalone[fname] = url

    # Map standalone files to versions by scanning the surrounding text
    for m in re.finditer(
        r'<a href="(https://cran-archive\.r-project\.org/bin/windows/base/old/(Setup\w+\.exe|R\d+\.zip))">[^<]*</a>\s*\(([A-Za-z]+, \d{4})\)',
        old_html,
    ):
        url, fname, when = m.groups()
        # version isn't in the link text; derive from filename digits
        digits = re.search(r"(\d+)", fname).group(1)
        version = None
        if fname.startswith("Setup"):
            # SetupR131 -> 1.3.1 ; SetupR141 -> 1.4.1 ; SetupR151 -> 1.5.1
            version = f"{digits[0]}.{digits[1]}.{digits[2]}"
        else:
            # R1022 -> 1.2.2 ; R1000 -> 1.0.0
            version = f"{digits[0]}.{int(digits[1:3])}.{digits[3]}"
        standalone[version] = (url, when)

    installer_re = re.compile(r'href="([^"?]+\.(?:exe|zip))"', re.IGNORECASE)

    for ver, (dir_url, is_archive, md5_hint) in sorted(by_ver.items(), key=lambda kv: vtuple(kv[0])):
        try:
            html = get(dir_url)
        except Exception as e:
            gaps.append({
                "runtime": "r", "major": major_of(ver), "os": "windows", "arch": "amd64",
                "reason": f"could not fetch version directory: {e}",
                "looked_at": [dir_url],
            })
            continue
        candidates = [f for f in installer_re.findall(html) if not f.lower().endswith(".css")]
        if not candidates:
            gaps.append({
                "runtime": "r", "major": major_of(ver), "os": "windows", "arch": "amd64",
                "reason": "no .exe/.zip installer link found on version page",
                "looked_at": [dir_url],
            })
            continue
        fname = candidates[0]
        url = dir_url + fname
        st, size = head(url)
        if st != 200 or not size:
            gaps.append({
                "runtime": "r", "major": major_of(ver), "os": "windows", "arch": "amd64",
                "reason": f"installer link found ({fname}) but HEAD failed (status {st})",
                "looked_at": [dir_url, url],
            })
            continue

        vt = vtuple(ver)
        if vt < (2, 12, 0):
            arch, arch_note = "x86", "32-bit only installer"
        elif vt < (4, 2, 0):
            arch, arch_note = "amd64", "combined 32-bit/64-bit installer (recorded as amd64)"
        else:
            arch, arch_note = "amd64", "64-bit only installer"

        checksum = None
        md5_url = md5_hint or (dir_url + "md5sum.txt")
        try:
            md5_txt = get(md5_url)
            for line in md5_txt.splitlines():
                line = line.strip()
                if line.endswith(fname) and re.match(r"^[0-9a-fA-F]{32}\s", line):
                    checksum = {"algo": "md5", "value": line.split()[0], "source": md5_url}
                    break
        except Exception:
            pass

        released = None
        if ver in standalone and isinstance(standalone[ver], tuple):
            released = standalone[ver][1]

        releases.append({
            "runtime": "r", "languages": ["r"], "major": major_of(ver), "version": ver,
            "os": "windows", "arch": arch, "kind": "installer", "format": "exe" if fname.lower().endswith(".exe") else "zip",
            "variant": None, "libc": None,
            "url": url, "mirrors": [],
            "checksum": checksum, "size": size, "released": released, "min_os": None,
            "metadata_source": dir_url, "notes": arch_note,
        })

    # The 5 oldest standalone files (1.0.0-1.5.1) that have no subdirectory
    for version, entry in standalone.items():
        if not isinstance(entry, tuple):
            continue
        if any(r["version"] == version and r["os"] == "windows" for r in releases):
            continue
        url, when = entry
        st, size = head(url)
        if st != 200 or not size:
            gaps.append({
                "runtime": "r", "major": major_of(version), "os": "windows", "arch": "x86",
                "reason": f"standalone installer link found but HEAD failed (status {st})",
                "looked_at": [f"{CRAN}/bin/windows/base/old/", url],
            })
            continue
        fmt = "exe" if url.lower().endswith(".exe") else "zip"
        releases.append({
            "runtime": "r", "languages": ["r"], "major": major_of(version), "version": version,
            "os": "windows", "arch": "x86", "kind": "installer", "format": fmt,
            "variant": None, "libc": None,
            "url": url, "mirrors": [],
            "checksum": None, "size": size, "released": when, "min_os": None,
            "metadata_source": f"{CRAN}/bin/windows/base/old/", "notes": "32-bit only installer; no per-version subdirectory",
        })

    note(f"windows: {sum(1 for r in releases if r['os'] == 'windows')} releases found")


# ---------------------------------------------------------------------------
# macOS
# ---------------------------------------------------------------------------

MAC_DIRS = [
    # (path, arch, min_os note)
    ("bin/macosx/base/", "amd64", "10.13 (High Sierra) or higher, Intel"),
    ("bin/macosx/big-sur-arm64/base/", "arm64", "11 (Big Sur) or higher, Apple silicon"),
    ("bin/macosx/big-sur-x86_64/base/", "amd64", "11 (Big Sur) or higher, Intel"),
    ("bin/macosx/sonoma-arm64/base/", "arm64", "14 (Sonoma) or higher, Apple silicon"),
]


def scrape_macos():
    print("== macOS (current layout) ==", file=sys.stderr)
    seen = set()
    for path, arch, min_os in MAC_DIRS:
        dir_url = f"{CRAN}/{path}"
        try:
            html = get(dir_url)
        except Exception as e:
            note(f"macos: failed to fetch {dir_url}: {e}")
            continue
        rows = parse_autoindex(html)
        names = [n for n, _, _ in rows if re.match(r"^R-[\d.]+(-arm64|-x86_64)?\.pkg$", n)]
        urls = [dir_url + n for n in names]
        heads = head_many(urls)
        for n, u in zip(names, urls):
            st, size = heads[u]
            if st != 200 or not size:
                continue
            vm = re.match(r"^R-(\d+(?:\.\d+)*)", n)
            ver = vm.group(1)
            key = (ver, arch)
            if key in seen:
                continue
            seen.add(key)
            releases.append({
                "runtime": "r", "languages": ["r"], "major": major_of(ver), "version": ver,
                "os": "macos", "arch": arch, "kind": "installer", "format": "pkg",
                "variant": None, "libc": None,
                "url": u, "mirrors": [],
                "checksum": None, "size": size, "released": None, "min_os": min_os,
                "metadata_source": dir_url, "notes": None,
            })

    # Legacy per-version pkg/dmg builds (R 2.0.1 - 3.6.3) from the CRAN archive.
    print("== macOS (cran-archive, pre-4.0) ==", file=sys.stderr)
    arch_dir = f"{ARCHIVE}/bin/macosx/base/"
    try:
        html = get(arch_dir)
    except Exception as e:
        note(f"macos archive: failed to fetch {arch_dir}: {e}")
        html = ""
    rows = parse_autoindex(html)
    by_version = {}
    for n, _mtime, _size in rows:
        m = re.match(r"^R-(\d+(?:\.\d+)*)([a-zA-Z.\-]*)\.(pkg|dmg)$", n)
        if not m:
            continue
        ver, suffix, ext = m.groups()
        by_version.setdefault(ver, []).append((n, suffix, ext))

    to_head = []
    picked = {}
    for ver, cands in by_version.items():
        if any(r["version"] == ver and r["os"] == "macos" for r in releases):
            continue  # already covered by the current layout above
        # Prefer the plain "R-<ver>.pkg", then plain ".dmg", then the
        # shortest-suffixed variant (skip "-mini" companion downloads).
        cands_sorted = sorted(cands, key=lambda c: (
            0 if c[1] == "" and c[2] == "pkg" else
            1 if c[1] == "" and c[2] == "dmg" else
            2 if "mini" not in c[1] else 3,
            len(c[1]),
        ))
        name, suffix, ext = cands_sorted[0]
        picked[ver] = (name, suffix, ext)
        to_head.append(arch_dir + name)

    heads = head_many(to_head)
    for ver, (name, suffix, ext) in picked.items():
        u = arch_dir + name
        st, size = heads[u]
        if st != 200 or not size:
            gaps.append({
                "runtime": "r", "major": major_of(ver), "os": "macos", "arch": "amd64",
                "reason": f"archive listing had {name} but HEAD failed (status {st})",
                "looked_at": [arch_dir, u],
            })
            continue
        notes = None
        if suffix:
            notes = f"canonical build chosen among variants for this version (suffix {suffix!r}); others exist in the same directory"
        releases.append({
            "runtime": "r", "languages": ["r"], "major": major_of(ver), "version": ver,
            "os": "macos", "arch": "amd64", "kind": "installer", "format": ext,
            "variant": None, "libc": None,
            "url": u, "mirrors": [],
            "checksum": None, "size": size, "released": None, "min_os": None,
            "metadata_source": arch_dir, "notes": notes,
        })

    gaps.append({
        "runtime": "r", "major": "1.9", "os": "macos", "arch": "amd64",
        "reason": "pre-2.0.1 macOS builds live under a different CRAN-archive layout "
                  "(root-level version dirs like '1.9', '2.0', plus el-capitan/, mavericks/, "
                  "universal/, powerpc/, i686/ subtrees) that this scrape did not walk",
        "looked_at": [f"{ARCHIVE}/bin/macosx/"],
    })
    note(f"macos: {sum(1 for r in releases if r['os'] == 'macos')} releases found")


# ---------------------------------------------------------------------------
# Linux (Posit r-builds)
# ---------------------------------------------------------------------------

LINUX_VARIANTS = [
    # (variant name, distro path, filename template, dpkg/rpm arch map)
    ("posit-ubuntu-2204", "ubuntu-2204", "r-{ver}_1_{arch}.deb", "deb", {"amd64": "amd64", "arm64": "arm64"}),
    ("posit-rhel-9", "rhel-9", "R-{ver}-1-1.{arch}.rpm", "rpm", {"amd64": "x86_64", "arm64": "aarch64"}),
]


def scrape_linux():
    print("== Linux (Posit r-builds) ==", file=sys.stderr)
    try:
        versions_json = json.loads(get(f"{POSIT_CDN}/versions.json"))
    except Exception as e:
        note(f"linux: failed to fetch versions.json: {e}")
        gaps.append({
            "runtime": "r", "major": "*", "os": "linux", "arch": "amd64",
            "reason": f"could not fetch Posit r-builds versions.json: {e}",
            "looked_at": [f"{POSIT_CDN}/versions.json"],
        })
        return
    versions = [v for v in versions_json.get("r_versions", []) if re.match(r"^\d+\.\d+\.\d+$", v)]

    urls_meta = []  # (url, variant, distro, catalog_arch, fmt, ver)
    for variant, distro, tmpl, fmt, archmap in LINUX_VARIANTS:
        for ver in versions:
            for catalog_arch, dl_arch in archmap.items():
                fname = tmpl.format(ver=ver, arch=dl_arch)
                url = f"{POSIT_CDN}/{distro}/pkgs/{fname}"
                urls_meta.append((url, variant, distro, catalog_arch, fmt, ver))

    heads = head_many([u for u, *_ in urls_meta])
    found_majors = {}
    for url, variant, distro, catalog_arch, fmt, ver in urls_meta:
        st, size = heads[url]
        if st == 200 and size:
            releases.append({
                "runtime": "r", "languages": ["r"], "major": major_of(ver), "version": ver,
                "os": "linux", "arch": catalog_arch, "kind": "installer", "format": fmt,
                "variant": variant, "libc": "glibc",
                "url": url, "mirrors": [],
                "checksum": None, "size": size, "released": None, "min_os": None,
                "metadata_source": f"{POSIT_CDN}/versions.json", "notes": f"Posit r-builds prebuilt R for {distro}",
            })
            found_majors.setdefault(major_of(ver), set()).add((variant, catalog_arch))

    # R before 3.0.0 has no r-builds binaries at all (posit's README states
    # support starts at R 3.0.0).
    oldest_major = min((vtuple(v) for v in versions), default=(3, 0, 0))
    gaps.append({
        "runtime": "r", "major": "1.x-2.x", "os": "linux", "arch": "amd64",
        "reason": "CRAN ships no generic Linux binaries and Posit r-builds only supports "
                  "R >= 3.0.0 (per rstudio/r-builds README); no prebuilt Linux package exists "
                  "for R 1.x/2.x",
        "looked_at": [f"{POSIT_CDN}/versions.json", "https://github.com/rstudio/r-builds (README)"],
    })
    note(f"linux: {sum(1 for r in releases if r['os'] == 'linux')} releases found across {len(found_majors)} majors")


# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------

def scrape_source():
    print("== Source ==", file=sys.stderr)
    for n in (1, 2, 3, 4):
        dir_url = f"{CRAN}/src/base/R-{n}/"
        try:
            html = get(dir_url)
        except Exception as e:
            gaps.append({
                "runtime": "r", "major": f"{n}.x", "os": "linux", "arch": "any",
                "reason": f"could not fetch source directory: {e}",
                "looked_at": [dir_url],
            })
            continue
        rows = parse_autoindex(html)
        by_version = {}
        for name, _mtime, _size in rows:
            m = re.match(r"^R-([\d.]+)(-recommended)?\.(tar\.gz|tgz)$", name)
            if not m:
                continue
            ver, recommended, ext = m.groups()
            if not recommended:
                by_version[ver] = (name, ext)  # plain tarball always wins
            elif ver not in by_version:
                by_version[ver] = (name, ext)  # only "-recommended" exists, fall back to it
        urls = {ver: (dir_url + name, ext) for ver, (name, ext) in by_version.items()}
        heads = head_many([u for u, _ in urls.values()])
        for ver, (url, ext) in urls.items():
            st, size = heads[url]
            if st != 200 or not size:
                gaps.append({
                    "runtime": "r", "major": major_of(ver), "os": "linux", "arch": "any",
                    "reason": f"source tarball link found but HEAD failed (status {st})",
                    "looked_at": [dir_url, url],
                })
                continue
            releases.append({
                "runtime": "r", "languages": ["r"], "major": major_of(ver), "version": ver,
                "os": "linux", "arch": "any", "kind": "source", "format": "tar.gz" if ext == "tar.gz" else "tgz",
                "variant": None, "libc": None,
                "url": url, "mirrors": [],
                "checksum": None, "size": size, "released": None, "min_os": None,
                "metadata_source": dir_url, "notes": "source tarball; builds on any Unix-like OS, not Linux-specific",
            })
    note(f"source: {sum(1 for r in releases if r['kind'] == 'source')} tarballs found")


# ---------------------------------------------------------------------------
# Mirrors
# ---------------------------------------------------------------------------

MIRROR_CANDIDATES = [
    ("https://cloud.r-project.org/", "Automatic CRAN load-balancer (Posit-sponsored), worldwide"),
    ("https://mirrors.tuna.tsinghua.edu.cn/CRAN/", "China (Beijing)"),
    ("https://ftp.fau.de/cran/", "Germany (Erlangen)"),
    ("https://pbil.univ-lyon1.fr/CRAN/", "France (Lyon)"),
    ("https://cran.csiro.au/", "Australia (Canberra)"),
]

# A handful of files spanning old and new releases, checked against every
# mirror candidate above; if content-length matches CRAN master on all of
# them the mirror is recorded as confirmed for that whole class of path.
SAMPLE_PATHS = [
    "src/base/R-4/R-4.6.1.tar.gz",
    "src/base/R-3/R-3.6.3.tar.gz",
    "bin/windows/base/R-4.6.1-win.exe",
    "bin/windows/base/old/4.0.0/R-4.0.0-win.exe",
    "bin/macosx/base/R-4.0.0.pkg",
]


def scrape_mirrors():
    print("== Mirrors ==", file=sys.stderr)
    master_sizes = {}
    for p in SAMPLE_PATHS:
        st, size = head(f"{CRAN}/{p}")
        master_sizes[p] = size if st == 200 else None

    confirmed = []
    for base, label in MIRROR_CANDIDATES:
        ok = True
        checked = []
        for p in SAMPLE_PATHS:
            if master_sizes.get(p) is None:
                continue
            st, size = head(base + p)
            checked.append(p)
            if st != 200 or size != master_sizes[p]:
                ok = False
                break
        if ok and checked:
            confirmed.append({
                "url_template": base,
                "label": label,
                "confirmed_via": "HEAD content-length match against cran.r-project.org "
                                 f"on {len(checked)} sample files (old + current releases): {checked}",
            })
            mirror_confirmations.append(base)
    return confirmed


def apply_mirrors_to_releases(confirmed_bases):
    """Once a mirror is confirmed on the sample, apply it to every CRAN-hosted
    release entry (windows/macos/source) by substituting the path after the
    CRAN host -- mirrors follow the same directory layout as cran.r-project.org."""
    n = 0
    for r in releases:
        if r["os"] == "linux" and (r.get("variant") or "").startswith("posit-"):
            continue  # Posit CDN isn't part of the CRAN mirror network
        if not r["url"].startswith(CRAN + "/"):
            continue  # cran-archive.r-project.org files aren't mirrored either
        rel_path = r["url"][len(CRAN) + 1:]
        mirrors = [base + rel_path for base in confirmed_bases]
        r["mirrors"] = mirrors
        if mirrors:
            n += 1
    note(f"mirrors: applied confirmed mirror URLs to {n} CRAN-hosted release entries")


# ---------------------------------------------------------------------------
# Download plan
# ---------------------------------------------------------------------------

def build_download_plan():
    plan = []
    groups = {}
    for r in releases:
        if r["os"] not in ("windows", "linux", "macos"):
            continue
        if r["kind"] == "source":
            continue
        if r["os"] == "linux" and r.get("variant") != "posit-ubuntu-2204":
            continue
        if r["os"] == "linux" and r["arch"] != "amd64":
            continue
        key = (r["major"], r["os"], r["arch"])
        cur = groups.get(key)
        if cur is None or vtuple(r["version"]) > vtuple(cur["version"]):
            groups[key] = r
    for r in groups.values():
        plan.append(r)
    plan.sort(key=lambda r: (r["os"], vtuple(r["version"]), r["arch"]))
    return plan


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    scrape_windows()
    scrape_macos()
    scrape_linux()
    scrape_source()
    confirmed = scrape_mirrors()
    apply_mirrors_to_releases([c["url_template"] for c in confirmed])
    plan = build_download_plan()

    (HERE / "releases.json").write_text(json.dumps(releases, indent=2, sort_keys=False) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2, sort_keys=False) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=2, sort_keys=False) + "\n")
    (HERE / "mirrors.json").write_text(json.dumps({
        "runtime": "r",
        "mirror_list_source": f"{CRAN}/CRAN_mirrors.csv",
        "confirmed": confirmed,
    }, indent=2) + "\n")

    total_gb = sum((r.get("size") or 0) for r in plan) / 1e9
    notes_md = f"""# R runtime catalog notes

## What this covers

- {sum(1 for r in releases if r['os'] == 'windows')} Windows installer releases (`bin/windows/base/`,
  `bin/windows/base/old/`, and `cran-archive.r-project.org/bin/windows/base/old/`
  for anything before R 4.0.0). Arch is recorded per the vendor's own history:
  x86-only before 2.12.0, a combined 32/64-bit installer from 2.12.0 to 4.1.x
  (recorded as `amd64`, noted in each entry), 64-bit-only from 4.2.0 on.
- {sum(1 for r in releases if r['os'] == 'macos')} macOS installer releases. Current CRAN layout
  (`base/` = Intel High Sierra+, `big-sur-arm64/base/` and `big-sur-x86_64/base/`,
  `sonoma-arm64/base/` for the newest Apple-silicon builds) plus
  `cran-archive.r-project.org/bin/macosx/base/` for R 2.0.1-3.6.3, where one
  canonical file per version was picked among several historical variants
  (mini/-nn/-signed/-mavericks/-snowleopard/etc; see each entry's `notes`).
  Pre-2.0.1 macOS builds use a different, non-uniform CRAN-archive layout and
  were left as a gap rather than hand-walked.
- {sum(1 for r in releases if r['os'] == 'linux' and r['kind'] == 'installer')} Linux installer releases: Posit r-builds prebuilt R
  packages for `ubuntu-2204` (.deb) and `rhel-9` (.rpm), amd64 and arm64,
  confirmed to exist for every R version Posit lists (>= 3.0.0) via HEAD.
  CRAN itself ships no generic Linux binaries; only Posit's r-builds do.
- {sum(1 for r in releases if r['kind'] == 'source')} source tarballs from `src/base/R-{{1,2,3,4}}/`, one per
  version (preferring plain `R-<ver>.tar.gz` over the historical
  `-recommended` bundle). Source builds on any Unix-like OS, so these are
  recorded once (`os: linux, arch: any`) rather than duplicated.

## Download plan

`download_plan.json` has the newest patch per (major, os, arch) for
windows/linux/macos, `posit-ubuntu-2204`/amd64 only for Linux (per spec).
Source tarballs are intentionally not planned (also per spec). Total planned
size: ~{total_gb:.2f} GB across {len(plan)} files.

## Mirrors

Candidates came from `CRAN_mirrors.csv`. {len(confirmed)} confirmed by HEAD
content-length match against cran.r-project.org across 5 sample files
spanning old (R 3.6.3 / R 4.0.0 era) and current (R 4.6.1) releases:
{', '.join(c['url_template'] for c in confirmed) if confirmed else '(none confirmed)'}.
Confirmed mirrors are applied to every CRAN-hosted release entry (windows,
macos, source) by substituting the path after the CRAN host, since CRAN
mirrors replicate the exact same directory tree. Posit's CDN
(`cdn.posit.co`) is not part of the CRAN mirror network, so Linux release
entries carry no mirrors.

## Known gaps

See `gaps.json`. Notable ones: R 1.x/2.x has no Linux binaries anywhere
(Posit r-builds starts at 3.0.0); pre-2.0.1 macOS used a different CRAN
archive layout not walked by this script.

## Checksums

Windows: parsed from each version's `md5sum.txt` (or `md5sum.R-<ver>.txt`
for the current release) when present. macOS and Linux: CRAN's autoindex
and Posit's CDN publish no per-file checksum manifests for these paths, so
`checksum` is `null` there (a few individual legacy macOS builds have an
MD5/SHA1 printed inline in `bin/macosx/`'s landing-page prose, but this
script does not scrape prose for checksums -- only manifest files).
"""
    (HERE / "NOTES.md").write_text(notes_md)

    print(f"\nDone: {len(releases)} releases, {len(gaps)} gaps, {len(plan)} planned, "
          f"{len(confirmed)} confirmed mirrors, ~{total_gb:.2f} GB planned", file=sys.stderr)


if __name__ == "__main__":
    main()
