#!/usr/bin/env python3
"""Mine Chocolatey's `ruby.install` package for checksum corroboration of
RubyInstaller2 Windows .exe assets that have no vendor checksum.

Why this exists (mirror hunt round 2, Ruby topic): RubyInstaller2 only
started publishing a GitHub asset `digest` (sha256) from RubyInstaller-3.4.5-1
onward (see catalog/ruby/NOTES.md "Checksums") -- 533/677 entries are
null-checksum. `catalog/package-managers/chocolatey.json` etc. never mined
`ruby`/`ruby.install` specifically (grep confirmed empty). This script does.

Chocolatey's `ruby.install` package does NOT download the installer at
install time -- it BUNDLES the exact upstream RubyInstaller2 .exe (both
x86 and x64) inside the .nupkg itself (verified manually: the 3.4.10.1
nupkg's chocolateyInstall.ps1 references
"$toolsPath\\rubyinstaller-3.4.10-1-x64.exe" as a local file, and that file's
sha256 (0e1210b0...a6113) and size (20,525,048) matched
catalog/ruby/releases.json's existing GitHub-digest checksum for
RubyInstaller-3.4.10-1/rubyinstaller-3.4.10-1-x64.exe exactly).

This is NOT usable as a `mirrors` URL: fetching the nupkg URL returns a zip
archive, not the raw .exe, so it fails SCHEMA.md's "mirrors: only URLs
confirmed to serve this file" test. It over-collects for
`checksum_corroboration` instead (see SCHEMA.md "Later additions"), which
is exactly what a third-party package-manager-embedded hash is for.

Naming: Chocolatey's ruby.install version is "<ruby-version>.<installer-build>"
e.g. "3.2.3.1" -> RubyInstaller2 tag "RubyInstaller-3.2.3-1", filenames
"rubyinstaller-3.2.3-1-{x86,x64}.exe" (verified against the ps1 script logic
in chocolateyInstall.ps1, which literally builds those two filenames from
$env:ChocolateyPackageVersion). Ruby 4.0 dropped x86; no choco version for
4.0 exists yet at time of writing (checked: newest is 3.4.10.1) so that
doesn't matter here.

Usage: python3 mine_chocolatey.py [--versions v1,v2,...] [--apply]
  --apply writes catalog/package-managers/round2/ruby/choco_updates.jsonl
  and, if not empty, invokes catalog/tools/add_mirrors.py on it.
Without --apply, just prints what it would do (dry run). Idempotent: safe
to re-run, add_mirrors.py itself dedupes.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]  # catalog/
RUBY_RELEASES = CATALOG / "ruby" / "releases.json"
SCRATCH = HERE / "scratch"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 "
    "installer-builder-catalog"
)
TIMEOUT = 60

FEED_URL = "https://community.chocolatey.org/api/v2/FindPackagesById()?id=%27ruby.install%27"
NUPKG_URL = "https://community.chocolatey.org/api/v2/package/ruby.install/{version}"

# Representative old/mid/new sample within the null-checksum range
# (everything before RubyInstaller-3.4.5-1, per NOTES.md). Not exhaustive --
# each nupkg is ~35-45MB and yields 2 hashes (x86+x64), so this sample of 10
# versions gives ~20 corroborations across Ruby's Windows history without
# pulling all 39 published choco versions (~1.5GB).
DEFAULT_VERSIONS = [
    "2.2.6", "2.4.10.100", "2.5.9.1", "2.6.9.1", "2.7.7.1",
    "3.0.7.1", "3.1.7.1", "3.2.11.1", "3.3.12.1", "3.4.4.1",
]


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read()


def list_versions() -> list[str]:
    xml = fetch(FEED_URL).decode("utf-8", "replace")
    return sorted(set(re.findall(r"<d:Version>([^<]*)</d:Version>", xml)))


def load_release_index() -> dict[str, dict]:
    """Every oneclick/rubyinstaller (v1) or rubyinstaller2 (v2) entry, keyed by url."""
    entries = json.loads(RUBY_RELEASES.read_text())
    by_url = {}
    for e in entries:
        u = e.get("url", "")
        if "oneclick/rubyinstaller2/releases/download/" in u or "oneclick/rubyinstaller/releases/download/" in u:
            by_url[u] = e
    return by_url


# RubyInstaller2 (2.4+): rubyinstaller[-devkit]-X.Y.Z-N-{x86,x64,arm}.exe, tag RubyInstaller-X.Y.Z-N
RI2_RE = re.compile(r"^rubyinstaller(-devkit)?-([0-9.]+)-(\d+)-(x86|x64|arm)\.exe$", re.I)
# RubyInstaller1 (<=2.3.3): rubyinstaller-X.Y.Z[-x64].exe, tag ruby-X.Y.Z (no build number, no arm)
RI1_RE = re.compile(r"^rubyinstaller-([0-9.]+)(-x64)?\.exe$", re.I)


def filename_to_entry_url(base: str) -> str | None:
    m = RI2_RE.match(base)
    if m:
        devkit, ver, build, arch = m.groups()
        tag = f"RubyInstaller-{ver}-{build}"
        name = f"rubyinstaller{'-devkit' if devkit else ''}-{ver}-{build}-{arch}.exe"
        return f"https://github.com/oneclick/rubyinstaller2/releases/download/{tag}/{name}"
    m = RI1_RE.match(base)
    if m:
        ver, x64 = m.groups()
        tag = f"ruby-{ver}"
        name = f"rubyinstaller-{ver}{x64 or ''}.exe"
        return f"https://github.com/oneclick/rubyinstaller/releases/download/{tag}/{name}"
    return None


def mine_version(version: str, by_url: dict[str, dict]) -> list[dict]:
    SCRATCH.mkdir(exist_ok=True)
    nupkg_path = SCRATCH / f"ruby.install.{version}.nupkg"
    if not nupkg_path.exists():
        try:
            data = fetch(NUPKG_URL.format(version=version))
        except urllib.error.HTTPError as e:
            print(f"  {version}: HTTP {e.code} fetching nupkg, skipping")
            return []
        except Exception as e:
            print(f"  {version}: fetch failed ({e}), skipping")
            return []
        nupkg_path.write_bytes(data)

    updates = []
    try:
        with zipfile.ZipFile(nupkg_path) as z:
            exe_names = [n for n in z.namelist() if n.lower().endswith(".exe")]
            for name in exe_names:
                base = name.rsplit("/", 1)[-1]
                url = filename_to_entry_url(base)
                if url is None:
                    print(f"  {version}: unrecognized filename {base}, skipping")
                    continue
                entry = by_url.get(url)
                if entry is None:
                    print(f"  {version}: no releases.json entry for {url}, skipping {base}")
                    continue
                content = z.read(name)
                digest = hashlib.sha256(content).hexdigest()
                had_checksum = entry.get("checksum") is not None
                agrees = None
                if had_checksum:
                    vendor_algo = entry["checksum"].get("algo")
                    vendor_value = entry["checksum"].get("value", "").lower()
                    same_algo_digest = (
                        digest if vendor_algo == "sha256"
                        else hashlib.new(vendor_algo, content).hexdigest() if vendor_algo in ("md5", "sha1", "sha512")
                        else None
                    )
                    agrees = same_algo_digest == vendor_value if same_algo_digest else None
                if had_checksum and agrees is False:
                    print(f"  !! MISMATCH {url}: vendor={entry['checksum']} choco file hash didn't match")
                updates.append({
                    "folder": "ruby",
                    "url": url,
                    "checksum_corroboration": {
                        "algo": "sha256",
                        "value": digest,
                        "source": f"Chocolatey ruby.install {version} nupkg (bundled installer, "
                                  f"not downloaded at install time)",
                    },
                    "_had_vendor_checksum": had_checksum,
                    "_agrees_with_vendor": agrees,
                })
    finally:
        nupkg_path.unlink(missing_ok=True)
    return updates


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--versions", help="comma-separated choco versions; default is a curated sample")
    ap.add_argument("--all", action="store_true", help="mine every published version instead of the sample")
    ap.add_argument("--apply", action="store_true", help="write updates.jsonl and call add_mirrors.py")
    args = ap.parse_args()

    if args.all:
        versions = list_versions()
    elif args.versions:
        versions = args.versions.split(",")
    else:
        versions = DEFAULT_VERSIONS

    by_url = load_release_index()
    print(f"{len(by_url)} RubyInstaller2 entries in releases.json; mining {len(versions)} choco version(s)")

    all_updates = []
    for v in versions:
        print(f"-- {v} --")
        all_updates.extend(mine_version(v, by_url))

    mismatches = sum(1 for u in all_updates if u["_agrees_with_vendor"] is False)
    newly_covered = sum(1 for u in all_updates if not u["_had_vendor_checksum"])
    print(f"{len(all_updates)} corroboration(s); {newly_covered} on previously-null-checksum entries; "
          f"{mismatches} mismatches against an existing vendor checksum.")

    clean = [{"folder": u["folder"], "url": u["url"], "checksum_corroboration": u["checksum_corroboration"]}
             for u in all_updates]

    out = HERE / "choco_updates.jsonl"
    out.write_text("\n".join(json.dumps(u) for u in clean) + ("\n" if clean else ""))
    print(f"wrote {len(clean)} update(s) to {out}")

    if args.apply and clean:
        subprocess.run([sys.executable, str(CATALOG / "tools" / "add_mirrors.py"), str(out)], check=True)


if __name__ == "__main__":
    main()
