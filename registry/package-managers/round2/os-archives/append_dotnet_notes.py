#!/usr/bin/env python3
"""Append a NOTES.md section under the catalog write lock (fcntl.flock), atomically."""
import fcntl
import os
import tempfile
from pathlib import Path

CATALOG = Path("/home/x/projects/installer-builder-runtimes/catalog")
LOCK = CATALOG / ".write.lock"
NOTES = CATALOG / "dotnet" / "NOTES.md"

ADDITION = """

## Mirror hunt, round 2 -- Windows Update / macOS archive sites (2026-09-17)

Scope: whether sites that archive *Windows updates* (not just this project's
own dotnet CDN mirrors) also carry `dotnet-framework` runtime installers, as
part of a cross-runtime "os-archives" survey (see
`catalog/package-managers/round2/os-archives/README.md` for the full
writeup, including cc/msvc-redist and macOS findings).

This runtime's own mirror coverage was already at 100% from the earlier
2026-09-17 pass above (dotnetcli CDN + Wayback). This pass looked
specifically for **additional, independent** hosts -- Internet Archive
*items* (user-uploaded files with their own identifier, distinct from a
Wayback capture of the original URL), the Microsoft Update Catalog, WSUS
Offline Update, and Legacy Update -- and found three:

- **`archive.org/download/<item>/<file>`** (Internet Archive "software"
  collection items, not Wayback): three `dotnet-framework` entries got a
  second, independent mirror on top of the existing Wayback one:
  - `dotNetFx40_Full_x86_x64.exe` (4.0) -- item
    `dotnetfx40_full_x86_x64_202602`. Full download of both the live
    `download.microsoft.com` copy and this item 2026-09-17: sha1
    `58da3d74db353aad03588cbb5cea8234166d8b99` and md5
    `251743dfd3fda414570524bac9e55381` match exactly (no vendor checksum
    exists for this entry to check against, so this is a hash match between
    the two copies, not against a published vendor hash).
  - `NDP46-KB3045557-x86-x64-AllOS-ENU.exe` (4.6) -- item
    `microsoft-.net-framework-4.6-last-stable-version-for-windows-vista8`.
    HEAD Content-Length 65444688 matches `releases.json` exactly.
  - `NDP461-KB3102436-x86-x64-AllOS-ENU.exe` (4.6.1) -- item
    `microsoft-.net-framework-4.6.1-last-unofficially-supported-stable-version-for-windows-vista`.
    HEAD Content-Length 67681000 matches `releases.json` exactly.
  All three keep the vendor filename unchanged (not renamed), and per the
  one-hash-sample-per-host rule only the first (4.0) got a full byte
  download; 4.6/4.6.1 were confirmed by exact Content-Length match on the
  same host. Applied via `add_mirrors.py`.
  Checked, but sizes did NOT match a catalog entry (rejected as mirrors,
  kept as "alternative source, different file" leads in the os-archives
  README instead): archive.org's 3.5 item (`dotnetfx35.exe`, 242743296
  bytes vs this catalog's 242885528 -- a different SP1 build), its 4.6
  companion 4.7 item (`ndp47-kb3186497...exe`, 61584232 vs 61601208), and
  its 4.7.1 item (`NDP471-KB4033342...exe`, 68742112 vs 68771912) -- all
  three are the same *named* update repackaged at a slightly different
  byte count (rebuild/resign), not this catalog's exact bytes.
- **Microsoft Update Catalog** (`catalog.update.microsoft.com`): confirmed
  it does carry Visual C++ redistributable *security updates* under KB
  numbers (see the cc/ section of the os-archives README) but a search for
  ".NET Framework" offline installers by name returns nothing usable --
  .NET Framework's offline/"AllOS" combined installers were never
  distributed as Windows Update payloads under a browsable title in the
  Catalog; only individual language-specific update rollups are. Not used
  as a source for this runtime.
- **WSUS Offline Update** (community docs/forum posts, `wsusoffline.net`
  itself was unreachable from this sandbox -- connection refused to
  49.12.5.18 on all subdomains, and `legacyupdate.net` Cloudflare-challenge-
  gated every request including a browser-like UA): its static link lists
  just point at Microsoft's own `download.microsoft.com` /
  `download.visualstudio.microsoft.com` URLs (confirmed via forum posts and
  the public `abbodi1406/vcredist` `source_links/README.md`, which documents
  the same pattern for VC++). It re-hosts nothing itself, so it is not a
  distinct mirror host for this runtime -- noted for completeness in the
  os-archives README.
- **Legacy Update** (`legacyupdate.net`): per its GitHub repo and its own
  indexed download-center pages (found via web search, since the live site
  403s every request here with a Cloudflare Turnstile challenge), it *does*
  host re-uploaded copies of files Microsoft removed from its Download
  Center, including old Visual C++ redistributables -- but nothing
  `dotnet-framework`-specific turned up in the pages found, and byte-identity
  couldn't be checked from this sandbox. Recorded as gated/unavailable in
  the os-archives README rather than added here.
"""


def main():
    with open(LOCK, "w") as lockf:
        fcntl.flock(lockf, fcntl.LOCK_EX)
        current = NOTES.read_text()
        if "Mirror hunt, round 2 -- Windows Update / macOS archive sites" in current:
            print("already appended, skipping")
            return
        updated = current + ADDITION
        fd, tmp = tempfile.mkstemp(dir=NOTES.parent, prefix=NOTES.name, suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            f.write(updated)
        os.replace(tmp, NOTES)
        print("appended", len(ADDITION), "bytes")


if __name__ == "__main__":
    main()
