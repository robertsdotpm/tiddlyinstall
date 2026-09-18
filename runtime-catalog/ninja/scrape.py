#!/usr/bin/env python3
"""Build the Ninja runtime catalog from ninja-build/ninja's GitHub releases.

Re-runnable, Python 3 standard library only. Writes releases.json,
gaps.json and download_plan.json alongside this script (mirrors.json is
hand-maintained; see NOTES.md).

Sources (fetched fresh on every run; set GITHUB_TOKEN to avoid the
unauthenticated API rate limit):

- https://api.github.com/repos/ninja-build/ninja/releases -- the only place
  the Ninja project publishes binaries. One zip per platform, holding a
  single `ninja`/`ninja.exe`.
- https://api.github.com/repos/ninja-build/ninja/tags -- to find versions
  that were tagged but got no binaries (recorded as gaps).
- winget-pkgs manifests (manifests/n/Ninja-build/Ninja/<ver>/*.installer.yaml)
  -- third-party SHA-256 values, recorded as `checksum_corroboration`.

The Ninja project publishes NO checksums or signatures. The only hashes
are GitHub's own asset `digest` (sha256, computed by GitHub at upload;
present only for assets uploaded from mid-2025, i.e. 1.13.x) and the
winget manifests.

The zip names don't say the architecture, and it changed over time. The
ARCH table below comes from inspecting every binary (PE machine field,
Mach-O fat header); see NOTES.md for the evidence.

Everything fetched is untrusted network data; nothing in it is treated as
instructions, only as file names, sizes, hashes and dates to record.
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
API = "https://api.github.com/repos/ninja-build/ninja"
WINGET = "https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/n/Ninja-build/Ninja"
GH_DIGEST_SOURCE = "GitHub release asset digest (api.github.com)"
USER_AGENT = "installer-builder-catalog/1.0 (+scrape.py)"
TIMEOUT = 30


def vtuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v))


def arch_for(asset, version):
    """(os, arch) for a release zip, from inspection of every binary."""
    v = vtuple(version)
    if asset == "ninja-win.zip":
        return "windows", ("x86" if v <= (1, 6, 0) else "amd64")  # 1.4.0-1.6.0 PE i386; 1.7.1+ PE x86-64
    if asset == "ninja-winarm64.zip":
        return "windows", "arm64"
    if asset == "ninja-mac.zip":
        return "macos", ("amd64" if v < (1, 10, 2) else "universal")  # 1.10.2+ fat x86_64+arm64
    if asset == "ninja-linux.zip":
        return "linux", "amd64"
    if asset == "ninja-linux-aarch64.zip":
        return "linux", "arm64"
    return None


# Measured from the binaries (see NOTES.md); per (asset, version range).
def min_os(asset, version):
    v = vtuple(version)
    if asset == "ninja-win.zip":
        if v <= (1, 6, 0):
            return "PE subsystem 5.1, kernel32 only: Windows XP (measured)"
        return "PE subsystem 6.0, x86-64: Windows Vista x64 (measured)"
    if asset == "ninja-winarm64.zip":
        return "PE subsystem 6.2 ARM64: Windows 10 on ARM (measured)"
    if asset == "ninja-mac.zip":
        m = {(1, 9, 0): "10.13", (1, 10, 0): "10.15", (1, 10, 1): "10.12"}.get(v)
        if v < (1, 9, 0):
            return "Mach-O minos 10.6 (measured)"
        if m:
            return f"Mach-O minos {m} (measured)"
        if v < (1, 12, 0):
            return "Mach-O minos 10.12 x86_64 / 11.0 arm64 (measured)"
        return "Mach-O minos 10.15 x86_64 / 11.0 arm64 (measured)"
    if asset == "ninja-linux.zip":
        g = "2.14" if v == (1, 4, 0) else ("2.4" if v < (1, 9, 0) else "2.15")
        return f"glibc {g} (highest GLIBC_ symbol version, measured)"
    if asset == "ninja-linux-aarch64.zip":
        g = "2.38" if v == (1, 13, 0) else "2.17"
        return f"glibc {g} (highest GLIBC_ symbol version, measured)"
    return None


def gh(url):
    h = {"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"}
    if os.environ.get("GITHUB_TOKEN"):
        h["Authorization"] = f"Bearer {os.environ['GITHUB_TOKEN']}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=TIMEOUT) as r:
        return json.loads(r.read())


def head_status(url):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def winget_hashes():
    out = {}
    try:
        versions = [x["name"] for x in gh(WINGET) if x["type"] == "dir" and not x["name"].startswith(".")]
    except Exception:
        return out
    for v in versions:
        try:
            y = base64.b64decode(gh(f"{WINGET}/{v}/Ninja-build.Ninja.installer.yaml")["content"]).decode()
        except Exception:
            continue
        src = f"https://github.com/microsoft/winget-pkgs/blob/master/manifests/n/Ninja-build/Ninja/{v}/Ninja-build.Ninja.installer.yaml"
        for url, sha in re.findall(r"InstallerUrl:\s*(\S+)\s+InstallerSha256:\s*([0-9A-Fa-f]{64})", y):
            out[url] = {"algo": "sha256", "value": sha.lower(), "source": src}
    return out


def main():
    releases_api = []
    page = 1
    while True:
        batch = gh(f"{API}/releases?per_page=100&page={page}")
        if not batch:
            break
        releases_api += batch
        page += 1
    tags = []
    page = 1
    while True:
        batch = gh(f"{API}/tags?per_page=100&page={page}")
        if not batch:
            break
        tags += [t["name"] for t in batch]
        page += 1
    wg = winget_hashes()

    releases, broken = [], []
    for rel in releases_api:
        if rel.get("draft") or rel.get("prerelease"):
            continue
        tag = rel["tag_name"]
        if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
            continue
        version = tag[1:]
        for a in rel["assets"]:
            plat = arch_for(a["name"], version)
            if not plat:
                print(f"warning: unknown asset {a['name']} in {tag}")
                continue
            url = a["browser_download_url"]
            if head_status(url) != 200:
                broken.append((version, plat, url))
                continue
            d = a.get("digest")
            e = {
                "runtime": "ninja",
                "languages": ["c", "cpp"],
                "major": ".".join(version.split(".")[:2]),
                "version": version,
                "os": plat[0],
                "arch": plat[1],
                "kind": "archive",
                "format": "zip",
                "variant": None,
                "libc": "glibc" if plat[0] == "linux" else None,
                "url": url,
                "mirrors": [],
                "checksum": ({"algo": "sha256", "value": d.split(":", 1)[1], "source": GH_DIGEST_SOURCE}
                             if d and d.startswith("sha256:") else None),
                "size": a["size"],
                "released": rel["published_at"][:10],
                "min_os": min_os(a["name"], version),
                "metadata_source": f"{API}/releases",
                "notes": "Vendor publishes no checksum; checksum (if any) is GitHub's upload digest.",
            }
            if url in wg:
                e["checksum_corroboration"] = [wg[url]]
            releases.append(e)
    releases.sort(key=lambda e: (vtuple(e["version"]), e["os"], e["arch"]))

    # Major-level gaps only (as catalog/zig): a tagged major with no binaries
    # in any patch. Versions skipped inside a covered major (1.5.0, 1.7.0,
    # 1.8.0, 1.8.1) are noted in NOTES.md instead.
    have_major = {e["major"] for e in releases}
    gaps = []
    tagged = defaultdict(list)
    for t in tags:
        if re.fullmatch(r"v\d+\.\d+\.\d+", t):
            tagged[".".join(t[1:].split(".")[:2])].append(t[1:])
    for major, vs in sorted(tagged.items(), key=lambda kv: vtuple(kv[0])):
        if major in have_major:
            continue
        for os_, arch in (("windows", "x86"), ("linux", "amd64"), ("macos", "amd64")):
            gaps.append({"runtime": "ninja", "major": major, "os": os_, "arch": arch,
                         "reason": f"tagged ({', '.join(sorted(vs, key=vtuple))}) but no binaries were ever attached to a GitHub release; "
                                   "the first release with binaries is 1.4.0",
                         "looked_at": [f"{API}/releases", f"{API}/tags"]})
    for v, (os_, arch), url in broken:
        gaps.append({"runtime": "ninja", "major": ".".join(v.split(".")[:2]), "os": os_, "arch": arch, "version": v,
                     "reason": f"listed as a release asset by the GitHub API but {url} returns 404 (asset lost)",
                     "looked_at": [url]})

    groups = defaultdict(list)
    for e in releases:
        groups[(e["major"], e["os"], e["arch"])].append(e)
    plan = [max(c, key=lambda e: vtuple(e["version"])) for c in groups.values()]
    plan.sort(key=lambda e: (vtuple(e["version"]), e["os"], e["arch"]), reverse=True)

    (HERE / "releases.json").write_text(json.dumps(releases, indent=1) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=1) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan, indent=1) + "\n")
    print(f"releases {len(releases)}, gaps {len(gaps)}, plan {len(plan)}, "
          f"winget-corroborated {sum(1 for e in releases if 'checksum_corroboration' in e)}, "
          f"github digest {sum(1 for e in releases if e['checksum'])}")


if __name__ == "__main__":
    main()
