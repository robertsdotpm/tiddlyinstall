#!/usr/bin/env python3
"""Build the Meson runtime catalog from Meson's own release channels.

Re-runnable, Python 3 standard library only. Writes releases.json,
gaps.json and download_plan.json alongside this script, and applies the
confirmed PyPI mirrors recorded in mirrors.json (hand-maintained).

Sources (fetched fresh on every run; set GITHUB_TOKEN to avoid the
unauthenticated API rate limit):

- https://pypi.org/pypi/meson/json -- every sdist and wheel with the
  vendor-published sha256, size, upload date and requires_python.
- https://api.github.com/repos/mesonbuild/meson/releases -- the source
  tarball (same file as the PyPI sdist where both exist), the Windows MSI
  (-64 / -32), the macOS .pkg (0.58.1-1.8.2, some releases) and meson.pyz
  (zipapp, a few releases). The MSI/pkg have no vendor checksum (tarballs carry a GPG .asc
  signature, not a hash); GitHub's upload `digest` is used where present.

Meson is pure Python, so the sdist/wheel/pyz are the same file on every
OS: they are recorded once per OS (windows/linux/macos) with arch "any",
so a per-OS query finds them. The MSI and .pkg are PyInstaller builds that
bundle a private Python (and, for the MSI, ninja.exe); their Python
version is in limitations.json.

Everything fetched is untrusted network data; nothing in it is treated as
instructions, only as file names, sizes, hashes and dates to record.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
PYPI = "https://pypi.org/pypi/meson/json"
GH = "https://api.github.com/repos/mesonbuild/meson/releases?per_page=100&page={page}"
GH_DIGEST_SOURCE = "GitHub release asset digest (api.github.com)"
USER_AGENT = "installer-builder-catalog/1.0 (+scrape.py)"
TIMEOUT = 30
OSES = ("windows", "linux", "macos")


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v))


def fetch_json(url, gh=False):
    h = {"User-Agent": USER_AGENT}
    if gh:
        h["Accept"] = "application/vnd.github+json"
        if os.environ.get("GITHUB_TOKEN"):
            h["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=TIMEOUT) as r:
        return json.loads(r.read())


FINAL = re.compile(r"^\d+\.\d+\.\d+$")


def entry(version, os_, arch, kind, fmt, url, checksum, size, released, source, variant=None, min_os=None, notes=None):
    return {
        "runtime": "meson", "languages": ["c", "cpp"],
        "major": ".".join(version.split(".")[:2]), "version": version,
        "os": os_, "arch": arch, "kind": kind, "format": fmt, "variant": variant, "libc": None,
        "url": url, "mirrors": [], "checksum": checksum, "size": size, "released": released,
        "min_os": min_os, "metadata_source": source, "notes": notes,
    }


def main():
    pypi = fetch_json(PYPI)["releases"]
    gh_rel = []
    page = 1
    while True:
        b = fetch_json(GH.format(page=page), gh=True)
        if not b:
            break
        gh_rel += b
        page += 1

    releases = []
    pypi_by_name = {}
    for v, files in pypi.items():
        if not FINAL.match(v):
            continue
        for f in files:
            pypi_by_name[f["filename"]] = f
            fmt = "whl" if f["packagetype"] == "bdist_wheel" else "tar.gz"
            rp = f.get("requires_python")
            for os_ in OSES:
                releases.append(entry(
                    v, os_, "any", "archive", fmt, f["url"],
                    {"algo": "sha256", "value": f["digests"]["sha256"], "source": PYPI},
                    f["size"], f["upload_time"][:10], PYPI,
                    variant="pure-python",
                    min_os=f"needs Python {rp}" if rp else None,
                    notes=("Pure Python; runs with any Python meeting requires_python. "
                           + ("Install with pip, or unpack and run `python -m mesonbuild.mesonmain`."
                              if fmt == "whl" else "Unpack and run `python meson.py`, or pip install."))))

    for rel in gh_rel:
        tag = rel["tag_name"]
        if rel.get("draft") or rel.get("prerelease") or not FINAL.match(tag):
            continue
        for a in rel["assets"]:
            n, url, size = a["name"], a["browser_download_url"], a["size"]
            d = a.get("digest")
            ghsum = {"algo": "sha256", "value": d.split(":", 1)[1], "source": GH_DIGEST_SOURCE} if d and d.startswith("sha256:") else None
            date = rel["published_at"][:10]
            src = f"https://github.com/mesonbuild/meson/releases/tag/{tag}"
            m = re.fullmatch(r"meson-(\d+\.\d+\.\d+)(?:\.(\d+))?-(64|32)\.msi", n)
            if m:
                ver = m.group(1) + (f".{m.group(2)}" if m.group(2) else "")
                releases.append(entry(ver, "windows", "amd64" if m.group(3) == "64" else "x86", "installer", "msi",
                                      url, ghsum, size, date, src,
                                      notes=("PyInstaller build: bundles its own Python and ninja.exe; no Python needed. "
                                             + (f"Re-spun installer {ver} for Meson {m.group(1)}. " if m.group(2) else "")
                                             + "Vendor publishes no checksum for the MSI.")))
                continue
            m = re.fullmatch(r"meson-(\d+\.\d+\.\d+)\.pkg", n)
            if m:
                # Arch measured from the Mach-O files inside each payload (NOTES.md):
                # 0.58.1-1.2.2 x86_64 only (meson minos 10.7 -> 10.13), 1.6.1+ arm64 only (11.0).
                arm = vtuple(m.group(1)) >= (1, 6, 0)
                releases.append(entry(m.group(1), "macos", "arm64" if arm else "amd64", "installer", "pkg", url, ghsum,
                                      size, date, src,
                                      min_os="macOS 11.0 (Mach-O minos, measured)" if arm else None,
                                      notes=("PyInstaller build, " + ("arm64 only (no Intel build)" if arm else
                                             "x86_64 only (arm64 Macs need Rosetta)")
                                             + "; bundles Python and ninja; installs to /usr/local/bin and "
                                               "/usr/local/share/meson-<ver>. Vendor publishes no checksum.")))
                continue
            if n == "meson.pyz":
                for os_ in OSES:
                    releases.append(entry(tag, os_, "any", "archive", "pyz", url, ghsum, size, date, src,
                                          variant="pure-python",
                                          notes="Python zipapp: `python meson.pyz <args>`. Attached to only a few releases (1.7.2, 1.8.5, 1.9.1, 1.11.1)."))
                continue
            m = re.fullmatch(r"meson[-_](\d+\.\d+\.\d+)\.tar\.gz", n)
            if m:
                ver = m.group(1)
                p = pypi_by_name.get(f"meson-{ver}.tar.gz")
                if p:
                    # Same file on PyPI? Then GitHub is a confirmed mirror of it.
                    same = (ghsum and ghsum["value"] == p["digests"]["sha256"]) or (not ghsum and size == p["size"])
                    if same:
                        for e in releases:
                            if e["url"] == p["url"]:
                                e["mirrors"].append(url)
                    continue
                for os_ in OSES:  # GitHub-only tarball (0.17-0.28, and any not on PyPI)
                    releases.append(entry(ver, os_, "any", "archive", "tar.gz", url, ghsum, size, date, src,
                                          variant="pure-python",
                                          notes="Only on GitHub (not on PyPI). Unpack and run `python meson.py`. "
                                                "Signed (.asc) but no vendor checksum."))

    # Confirmed PyPI mirrors (see mirrors.json / NOTES.md): same path layout.
    mdoc = json.loads((HERE / "mirrors.json").read_text()) if (HERE / "mirrors.json").exists() else {"confirmed": []}
    prefixes = [m["prefix"] for m in mdoc.get("confirmed", []) if m.get("applies_to") == "files.pythonhosted.org"]
    for e in releases:
        if e["url"].startswith("https://files.pythonhosted.org/"):
            path = e["url"].split("files.pythonhosted.org/", 1)[1]
            e["mirrors"] += [p + path for p in prefixes]

    releases.sort(key=lambda e: (vtuple(e["version"]), e["os"], e["arch"], e["format"]))

    # Gaps: a Windows MSI line that stops (0.42.1 first MSI; 32-bit ends 0.53.1).
    have = defaultdict(set)
    for e in releases:
        have[e["major"]].add((e["os"], e["arch"]))
    gaps = []
    for major in sorted(have, key=vtuple):
        if vtuple(major) >= (0, 43) and ("windows", "amd64") not in have[major]:
            gaps.append({"runtime": "meson", "major": major, "os": "windows", "arch": "amd64",
                         "reason": "no MSI attached to any GitHub release of this minor line (the pure-Python "
                                   "wheel/sdist still works with a separate Python)",
                         "looked_at": ["https://github.com/mesonbuild/meson/releases"]})

    groups = defaultdict(list)
    for e in releases:
        groups[(e["major"], e["os"], e["arch"])].append(e)
    plan = []
    for c in groups.values():
        newest = max(vtuple(x["version"]) for x in c)
        pool = [x for x in c if vtuple(x["version"]) == newest]
        pool.sort(key=lambda x: ({"tar.gz": 0, "whl": 1, "pyz": 2}.get(x["format"], 0) if x["arch"] == "any" else 0,
                                 x["size"] or 0))
        plan.append(pool[0])
    plan.sort(key=lambda e: (vtuple(e["version"]), e["os"], e["arch"]), reverse=True)

    (HERE / "releases.json").write_text(json.dumps(releases, indent=1) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=1) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=1) + "\n")
    print(f"releases {len(releases)} ({len({e['version'] for e in releases})} versions), gaps {len(gaps)}, plan {len(plan)}; "
          f"with checksum {sum(1 for e in releases if e['checksum'])}, with mirrors {sum(1 for e in releases if e['mirrors'])}")


if __name__ == "__main__":
    main()
