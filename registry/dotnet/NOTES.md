# .NET catalog notes

## Sources

- `dotnet` (.NET / .NET Core, majors 1.0-11.0): the official
  `releases-index.json` plus each channel's `releases.json`, both under
  `https://builds.dotnet.microsoft.com/dotnet/release-metadata/`. 14 channels
  fetched; 11.0 is preview/rc-only right now (latest `11.0.0-rc.1`) so it
  contributes no stable releases and instead three gap entries.
- `dotnet-framework` (.NET Framework, Windows-only): scraped from the
  official `https://dotnet.microsoft.com/en-us/download/dotnet-framework/<slug>`
  pages, following each version's "offline installer" link to its
  `thank-you/...` redirect page to recover the real `download.microsoft.com`
  / `download.visualstudio.microsoft.com` URL (some are behind a
  `go.microsoft.com/fwlink` redirect, resolved with a HEAD request).
  A "developer pack" offline-installer link also exists on most pages and
  is deliberately excluded (reference assemblies for compiling, not the
  runtime redistributable) -- it is listed *before* the runtime link in the
  page HTML on several versions, so picking the first `*-offline-installer`
  match found a devpack .exe on the first pass; fixed to require the exact
  expected slug when present.

## What's in releases.json

Every stable (no `-preview`/`-rc`/etc. in the version) file found in the
`runtime`, `sdk`, `aspnetcore-runtime` and `windowsdesktop` sections of each
channel's `releases.json`, across all 13 stable majors (1.0 through 10.0).
Excluded on purpose: apphost/targeting packs, `runtime-deps`/`.deb`/`.rpm`
distro repo packages, symbols, the ASP.NET Core "hosting bundle" (arch is
ambiguous -- it installs both x86 and x64 side by side), `-gs`/`-nj` SDK
installer variants, and `*-composite` files (a newer combined
runtime+aspnetcore bundle, not a distinct variant in this schema). The
`sdks` (plural, per-feature-band) list is not used, only the single primary
`sdk` section, to avoid near-duplicate entries.

`os`/`arch`/`libc` are inferred from both the RID and the filename, because
a few old/odd entries disagree or are ambiguous from the RID alone -- e.g.
one 5.0.x `runtime` file is tagged `rid: "linux-musl"` (no arch) but its
filename is `dotnet-runtime-linux-musl-arm.tar.gz`; the classifier trusts
whichever of RID+name mentions an arch/os token. `linux-bionic-*` files
(Android's runtime pack, present from .NET 8+ previews onward) are recorded
as `os: "android"` since that's a real value in SCHEMA.md's enum, even
though it wasn't explicitly asked for.

.NET 1.0/1.1 (and part of 2.0) predate the generic `linux-x64` RID and only
ship distro-named builds (`centos-x64`, `rhel-x64`, `ubuntu-x64`,
`ubuntu.16.04-x64`, `fedora.27`, `opensuse.42.3`, ...); all of these are
recorded as `os: "linux", arch: "amd64"` since they are the same portable
glibc tarball under different names for that era.

**Size is only populated (via HEAD) for the ~100 entries actually chosen
into `download_plan.json`.** Backfilling every one of the 10,600+ historical
release files in `releases.json` would mean thousands of HEAD requests
against every patch of every major back to 2016, which the "≤10 concurrent,
size/mirror checks only" instruction reads as out of scope; those entries
carry `"size": null`. `min_os` is left `null` throughout `dotnet` -- each
channel does publish a `supported-os.json` with detailed per-family
OS/version support, but it doesn't map cleanly onto a single "minimum OS"
string per file and wasn't pursued given scope.

Checksums: 10,390/10,622 entries have a vendor SHA-512 (`hash` field in the
index). The exceptions are all of 1.0/1.1 and part of 2.0 (that era's index
just doesn't carry a hash for every file) and all 12 `dotnet-framework`
entries (Microsoft's download-center pages publish no checksum for these).

## Mirrors

`https://builds.dotnet.microsoft.com/dotnet/` and
`https://dotnetcli.blob.core.windows.net/dotnet/` are the same underlying
Azure blob storage behind two hostnames -- confirmed via HEAD on 6 files
spanning the oldest (1.0.0) and newest (9.0.9) content, all matching
`Content-Length` exactly. Applied to every `dotnet` release whose URL starts
with the `builds.dotnet.microsoft.com` host (10,493 of 10,622 entries;
the rest are the 12 `dotnet-framework` entries and 117 `dotnet` files served
from `download.microsoft.com`/`download.visualstudio.microsoft.com`, mostly
older SDK "global tool" installers and the .NET Framework hosting bundle
we otherwise exclude).

`https://ci.dot.net/public/` (the third candidate mirror from the task) was
tried on the same 5 sample URLs and 404s in that path shape -- not recorded
as a mirror. No `dotnetcli.azureedge.net` URLs were found anywhere in the
live index (checked across all 14 channels), so the "retired CDN, rewrite
where confirmed" step in the task didn't apply -- Microsoft's index already
points at `builds.dotnet.microsoft.com` even for the 1.0 channel.

No mirror was found or looked for `dotnet-framework` entries; they're
one-off downloads from Microsoft's download center with no known
alternate host.

## download_plan.json

101 entries: 89 `dotnet` (variant `runtime` only, per the task, since SDKs
are far larger) across majors 1.0-10.0, and all 12 `dotnet-framework`
entries. `libc: musl` builds and duplicate old distro-named Linux builds
are deliberately excluded from the plan (they'd collide on
`(major, os, arch, variant)` with the glibc/generic build, which is
preferred). Windows/macOS both have an installer and an archive for most
majors; archive (`.zip`/`.tar.gz`) is always preferred. Where multiple
plausible archives remained tied (only happens for majors 1.0/1.1 with
several equivalent distro-tagged Linux tarballs), the shortest URL was
picked as an arbitrary but deterministic tie-break -- functionally
equivalent files.

3.47-4.3 GB total across runs depending on which patch is currently newest
per channel (recorded 3.7 GB on the run whose output ships here).

## .NET Framework gaps

1.0, 1.1, 2.0 and 3.0 have no offline-installer link on the current
download-framework pages (Microsoft's modern download center starts at
3.5 SP1); not pursued further, per the "don't spend more than a few
requests" scope -- these are all long-EOL and would need an
archive.org/old-KB-article search to track down reliably. 4.5 (the base
release, as opposed to 4.5.1/4.5.2) also has no current offline-installer
link -- its page only offers a web installer now, since 4.5.1/4.5.2 are
in-place updates over it. All are recorded as gaps rather than guesses.

The 3.5 entry is `dotnetfx35.exe`, which per Microsoft also carries
.NET Framework 2.0 SP2 and 3.0 SP2 (there's no longer a standalone modern
official download for 2.0/3.0 alone) -- noted on that release's `notes`
field rather than invented as separate 2.0/3.0 downloads.

All 4.x entries are the combined "AllOS" installer (x86+x64 in one .exe);
recorded with `arch: "amd64"` and a note that it also covers x86, since the
schema wants one arch per entry and there's no separate x86-only official
download for these versions.

## Validator

`python3 tools/validate.py catalog/dotnet` passes: 10,622 releases, 8 gaps,
101 planned downloads, ~3.7 GB, OK, no duplicate-plan errors.

## Mirror hunt (2026-09-17)

Goal: find mirrors beyond `dotnetcli.blob.core.windows.net`, which was the
only one on file (Microsoft's own second host for the same "dotnetcli"
Azure Storage account). Two more confirmed, `catalog/dotnet/extra_mirrors.py`
applies both and must be re-run after `scrape.py` picks up new releases;
it's idempotent and caches Wayback results in `wayback_cache.json` beside it.

**1. `dotnetcli.azureedge.net`** -- still Microsoft, but a genuinely
different edge network from the other two. Public sources (the .NET blog,
several GitHub issues) say azureedge.net domains including this one were
being retired as part of the Edgio/Verizon CDN shutdown, expected offline
"in the first few months of 2025." That turned out to describe an intent,
not the current state: `dig` shows it now CNAMEs through Azure Traffic
Manager to an `azurefd.net` (Azure Front Door) endpoint, not the old Edgio
CDN, and it serves byte-identical content today. Confirmed via HEAD across
7 files spanning 1.0.0 to 10.0.100 -- Runtime/Sdk/WindowsDesktop/aspnetcore
sections, win/linux/macos, amd64/arm64 -- all matching Content-Length, plus
a full download + sha512 match for `dotnet-runtime-2.1.8-win-arm64.zip`
against its vendor checksum (sample deleted after). Plain http 307-redirects
to https on the same host, so it doesn't help TLS-less old clients. Applied
to the same population as the existing confirmed mirror (same "dotnetcli"
storage, same layout) -- no per-entry check needed, this is a full mirror,
not a partial one.

**2. The Internet Archive (Wayback Machine)**, for the 129 release entries
(117 `dotnet`, all 12 `dotnet-framework`) that had ZERO mirrors: these are
served from `download.visualstudio.microsoft.com` or `download.microsoft.com`
-- a separate, non-"dotnetcli" Azure Storage account -- almost all
`windowsdesktop-runtime` 3.0.x/3.1.x .exe installers plus a handful of
5.0.x macOS `.pkg` files, and every `dotnet-framework` entry. Checked
whether these ever landed on `builds.dotnet.microsoft.com` under the guessed
`WindowsDesktop/<ver>/<file>` path first -- 404, they never migrated.
Template: `https://web.archive.org/web/2id_/<original url>` (redirects to
the nearest raw, un-rewritten capture). Wayback coverage is partial by
nature, so every candidate was HEAD-checked individually via
`extra_mirrors.py`, comparing the replay's `x-archive-orig-content-length`
against the entry's recorded size (`dotnet-framework` entries carry no
size, accepted on a bare 200 instead). Result: **128/128 distinct
candidate URLs confirmed** (129 release entries map to 128 URLs -- one SDK
tarball is reused identically between the 1.0.8 and 1.1.5 releases).
`releases.json` is now at 100% mirror coverage (10,622/10,622), same for
`download_plan.json` (101/101) and `download_plan_majors.json` (68/68).
One full download + sha512 match against the vendor checksum for
`windowsdesktop-runtime-3.1.32-win-x64.exe`; `dotnet-framework` has no
vendor checksum for any entry (per the Checksums note above), so those are
confirmed by Content-Length + one spot download compared byte-for-byte
against the live download.microsoft.com copy, not a hash.

This sandbox's network egress is shared with several sibling jobs (other
runtime catalogs' own mirror hunts running concurrently) and is congested
enough that concurrent HEAD requests to archive.org intermittently come
back as connection-refused/timeout even when a lone sequential request to
the same URL succeeds immediately. `extra_mirrors.py` treats these as
transient (3 retries with backoff) and, importantly, never caches a
transient failure as a negative -- so it took 5 re-runs to fully drain the
queue, and every one of the 128 candidates ended up genuinely reachable on
Wayback; there were zero real (non-transient) rejections in this batch.

**Rejected candidates** (kept in `mirrors.json`'s `not_confirmed` list so
they aren't re-investigated next time):
- `https://ci.dot.net/public/<path>` -- still 404s, as already noted above.
- `mirrors.huaweicloud.com/dotnet/` and `mirrors.ustc.edu.cn/dotnet/` --
  both return HTTP 200 with an HTML body for literally any path, confirmed
  with a deliberately bogus control path (`/totally-bogus-path-xyz123/...`)
  getting the identical response. These are portal/SPA catch-alls, not real
  mirrors; neither service actually proxies raw vendor archives, only
  language package managers (pypi/npm/maven/etc).
- `mirrors.cloud.tencent.com/dotnet/`, `mirrors.tuna.tsinghua.edu.cn/dotnet/`,
  `mirrors.aliyun.com/dotnet/` -- genuine 404s (not soft catch-alls). No
  Chinese mirror network was found actually carrying .NET SDK/runtime
  binaries -- unlike Node/Python/Java, .NET isn't part of their standard
  mirror sets.
- SourceForge's `dotnet-sdk.mirror`/`net.mirror` projects -- these mirror
  the `dotnet/sdk` GitHub *source* repo, not built binaries; not applicable.
- UK Mirror Service (mirrorservice.org) -- no .NET entry in its index.

**Investigated, not actionable:** the task hint about 7.0.20 macOS runtime
files serving bytes that don't match the recorded checksum is real and
independently reproduced here (full download of both
`dotnet-runtime-7.0.20-osx-{x64,arm64}.tar.gz`, sha512 mismatch against
`releases.json`) -- it matches a public MacPorts ticket (#68580) about
Microsoft re-releasing 7.0.x macOS binaries without republishing the
checksum. However, Wayback's *earliest* capture of either file is
2025-07-09 (over a year after the 2024-05-28 release) and carries the same
(mismatched) digest as what's served live today, straight through every
capture to 2026-09; `dotnetcli.blob.core.windows.net`, the other historical
host, has zero Wayback captures for these paths at all. There is no
archived copy of the originally-published, checksum-matching bytes to add
as a mirror for these two entries -- the hint didn't pan out here. Not
added to `mirrors.json`; recorded so a future pass doesn't re-run the same
searches.


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
