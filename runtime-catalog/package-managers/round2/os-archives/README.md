# Windows Update archives & macOS software archives (round 2, 2026-09-17)

Topic: do sites that archive **Windows updates** also host Windows runtimes
(VC++ redistributables, .NET Framework)? Does the equivalent hold for
**macOS**? Covers `cc/` (`msvc-redist`), `dotnet/` (`dotnet-framework` +
`dotnet/gaps.json`), and the macOS installers already in `python/`, `r/`,
`node/`.

Per `MIRROR-HUNT-2.md`: writes went through `add_mirrors.py` only; 4 web
searches used (Legacy Update / VC++, WSUS Offline static links, Microsoft
Update Catalog, abbodi1406 `vcredist` source links); everything else below
came from direct URL fetches and the archive.org metadata API (a handful of
manual item lookups, not bulk Wayback).

## Answer, direct

**Windows: yes.** `download.windowsupdate.com` -- the static CDN that
Windows Update / the Microsoft Update Catalog actually serves files from --
hosts standalone VC++ redistributable installers as security-update
payloads, and they are still live today, over a decade later (confirmed
live, see below). The **Microsoft Update Catalog** itself
(`catalog.update.microsoft.com`) also lists VC++ 2005/2008/2010
redistributable security updates by KB number, each linking to that same
CDN. So the same infrastructure that archives Windows Update payloads
*is* one of the better long-term archives of old VC++ redistributables --
better, in fact, than Microsoft's own Download Center, which has had pages
for these removed. .NET Framework's offline "AllOS" combined installers,
by contrast, were **not** found there under a browsable title -- Update
Catalog search for both exact runtime names came up empty (see below);
only individual small language-specific rollups appear.

**macOS: partially.** Apple's own software-update infrastructure
(`swscan.apple.com` catalogs / `swcdn.apple.com` payloads) does host at
least one runtime-adjacent developer package family alongside OS updates:
Xcode Command Line Tools (`CLTools_*.pkg`, confirmed live, 355 MB sample).
It does **not** carry "Java for OS X" in the merged catalog checked (that
product was likely only ever listed in now-retired, OS-version-specific
catalogs that predate the merged one available today). Separately,
`xcodereleases.com` is a genuinely useful **index** (JSON, sha1 checksums,
453 entries) but its download links point at `download.developer.apple.com`,
which is login-gated (confirmed: unauthenticated request 302s to
`developer.apple.com/unauthorized/`) -- so it corroborates checksums but
isn't a fetchable mirror. The catalog's existing macOS runtime installers
(python.org, CRAN, Node) already sit at 252/252, 118/119 and 2723/2817
mirror coverage respectively from prior mirror hunts (official mirror
networks, Huawei/Tsinghua/etc. package mirrors, Wayback) -- this pass did
not find a Windows-Update-catalog-style analogue that adds meaningfully to
that.

## Applied: identical mirrors (via `add_mirrors.py`)

All three are Internet Archive **items** (`archive.org/download/<id>/<file>`,
user-uploaded to the "software" collection) -- a different kind of mirror
from the `web.archive.org/web/2id_/<url>` Wayback captures already on file
for every `dotnet-framework` entry, so these are genuine additional hosts,
not duplicates.

| dotnet-framework | vendor file | mirror | evidence |
|---|---|---|---|
| 4.0 | `dotNetFx40_Full_x86_x64.exe` | `archive.org/download/dotnetfx40_full_x86_x64_202602/...` | Full download of both copies 2026-09-17: sha1 `58da3d74db353aad03588cbb5cea8234166d8b99`, md5 `251743dfd3fda414570524bac9e55381` -- **exact match**. (No vendor checksum exists for this entry, so this is copy-vs-copy, not vendor-hash, verification.) |
| 4.6 | `NDP46-KB3045557-x86-x64-AllOS-ENU.exe` | `archive.org/download/microsoft-.net-framework-4.6-last-stable-version-for-windows-vista8/...` | HEAD Content-Length `65444688` == `releases.json` size, exact. |
| 4.6.1 | `NDP461-KB3102436-x86-x64-AllOS-ENU.exe` | `archive.org/download/microsoft-.net-framework-4.6.1-last-unofficially-supported-stable-version-for-windows-vista/...` | HEAD Content-Length `67681000` == `releases.json` size, exact. |

Per the one-hash-sample-per-host rule, only the 4.0 pair got a full byte
download+hash; 4.6/4.6.1 relied on the exact Content-Length match on the
same already-verified host. `updates_1.jsonl` / `updates_2.jsonl` in this
folder are the exact `add_mirrors.py` input files used;
`append_dotnet_notes.py` is the lock-safe script that appended the writeup
to `catalog/dotnet/NOTES.md` (already run; re-running is a no-op, it checks
for its own marker string first). Coverage: `dotnet-framework` was already
at 12/12 (100%) mirrored before this pass (Wayback, from an earlier
2026-09-17 run); still 12/12, now with 3 of those 12 having a second,
independent mirror.

No mirrors were applied to `cc/` -- see below for why.

## `cc/msvc-redist`: no mirrors possible, but candidate leads for older versions

The catalog's 4 `msvc-redist` entries are `aka.ms/vs/17/release/...`
permalinks that always serve **whatever is current** ("version": "latest"),
with no vendor checksum. A third-party host can only byte-match a
permalink like this by coincidence at the instant both are checked --
there is no stable "latest" file for a mirror to carry, so nothing here
qualifies as a confirmed identical mirror, matching the existing NOTES.md
line ("MSVC redistributables: not attempted... aka.ms permalinks").

What *is* useful: `abbodi1406/vcredist`'s public
`source_links/README.md` (github.com/abbodi1406/vcredist, MIT-style
community project, not Microsoft) keeps a hand-maintained history of every
VC++ redistributable build back to VC++ .NET 2002, each with its original
Microsoft URL(s). It shows, importantly, that current VC_redist downloads
under `download.visualstudio.microsoft.com/download/pr/<guid>/<SHA256>/...`
embed the file's own SHA-256 in the URL path (verified: the 14.51.36247.0
x64 URL's embedded hash `843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C`
matches this catalog's existing `checksum_corroboration` for that entry
byte-for-byte, case aside) -- a nice sanity check, but it's the same
Microsoft host as `aka.ms` redirects to, not a third-party mirror.

### Candidate catalog additions: older VC++ redistributables (2005-2013)

Not added as entries (out of scope per the brief) -- URLs and identifying
hashes for a future pass, all from `abbodi1406/vcredist`'s
`source_links/README.md`, cross-checked live where noted:

- **VC++ 2005 SP1 (8.0.50727.6229)**: `download.microsoft.com` links are
  dead per the README (superseded); it lists
  `gitlab.com/stdout12/adns/uploads/.../vcredist_x64_8.0.50727.6229.exe`
  and a OneDrive share as the only current sources -- both third-party
  re-uploads, not Microsoft. No hash given in the README for this build.
- **VC++ 2008 SP1 (9.0.30729.7523)**: same pattern -- GitLab re-upload +
  OneDrive share only; original `download.microsoft.com` KB2834565 link is
  gone.
- **VC++ 2010 SP1 (10.0.40219.473)**: still live at Microsoft --
  `download.microsoft.com/download/E/E/0/EE05C9EF-A661-4D9E-BCE2-6961ECDF087F/vcredist_{x64,x86}.exe`
  (per the README; not independently re-checked live here to stay inside
  budget). Multiple historical `download.windowsupdate.com` copies also
  exist for slightly earlier 10.0.40219.325/415 builds (see confirmed-live
  list below) -- useful if the exact 40219.473 build isn't reachable later.
- **VC++ 2012 (11.0.61030.0, "Update 4")**: Microsoft link
  `download.microsoft.com/download/1/6/B/16B06F60-3B20-4FF2-B699-5E9B7962F9AE/VSU_4/vcredist_{x64,x86,arm}.exe`,
  **plus two live `download.windowsupdate.com` copies, confirmed 2026-09-17**:
  - `http://download.windowsupdate.com/d/msdownload/update/software/crup/2015/02/vcredist_x64_1a5d93dddbc431ab27b1da711cd3370891542797.exe` -- HTTP 200, Content-Length 7186992, Last-Modified 2015-02-06. Filename embeds the file's own SHA-1: `1a5d93dddbc431ab27b1da711cd3370891542797`.
  - x86 counterpart at the same path (`vcredist_x86_96b377a27ac5445328cbaae210fc4f0aaa750d3f.exe`), not independently re-checked live (same host/pattern).
  - Also on Legacy Update's own archive, per its indexed page title "Visual C++ Redistributable for Visual Studio 2012 Update 4" (`legacyupdate.net/download-center/download/30679/...`) -- see gated section below.
- **VC++ 2013 (12.0.40664.0)**: `download.visualstudio.microsoft.com/download/pr/10912041/cee5d6bca2ddbcd039da727bf4acb48a/vcredist_x64.exe` (MD5-shaped hex in the path, per the README's naming convention for this era -- not confirmed as an actual MD5, just noted). No live `download.windowsupdate.com` copy was found in the source list for this specific major (only the 2010 and 2012 builds below had one listed). Also on Legacy Update per its indexed title "Visual C++ Redistributable Packages for Visual Studio 2013" (`legacyupdate.net/download-center/download/40784/...`).

**Confirmed-live `download.windowsupdate.com` samples (HEAD, 2026-09-17,
browser UA, plain http)** -- these are genuine Windows-Update-archive URLs
still serving VC++ payloads, the clearest direct evidence for the "yes"
answer above:

```
http://download.windowsupdate.com/msdownload/update/software/secu/2011/07/vcredist_x64_15d032d669078aa6f0f7fd1cbf4115a070bd034d.exe
  -> HTTP 200, Content-Length 10274136, Last-Modified 2011-07-19
     (VC++ 2010 SP1-era security update, x64; filename embeds its own SHA-1)

http://download.windowsupdate.com/d/msdownload/update/software/crup/2015/02/vcredist_x64_1a5d93dddbc431ab27b1da711cd3370891542797.exe
  -> HTTP 200, Content-Length 7186992, Last-Modified 2015-02-06
     (VC++ 2012 Update 4-era update, x64; filename embeds its own SHA-1)
```

**Microsoft Update Catalog, confirmed by direct search** (browser fetch of
`catalog.update.microsoft.com/Search.aspx?q=...`): searching "Visual C++
Redistributable" returns 6 real results, e.g. "Security Update for
Microsoft Visual C++ 2005 Service Pack 1 Redistributable Package
(KB973923)" (Visual Studio 2005, Security Updates, 8/28/2012, 3.2 MB); KB
numbers found: KB973923, KB973924, KB2565063, KB2538243, KB2538242,
KB2467173, spanning VC++ 2005/2008/2010. Each catalog entry links to a
`download.windowsupdate.com`-style URL like the ones above. Searching
"Visual C++ 2015-2022 Redistributable" (the catalog's current entries)
returns **zero** results -- current "latest" vc_redist builds are
distributed only via the `aka.ms` permalink / VS installer, not pushed
through Windows Update under a catalog-searchable title.

## `dotnet/gaps.json`: candidate leads for Framework 1.0 / 1.1 / 2.0 / 3.0

None of these are Microsoft-hosted any more (matches `gaps.json`'s existing
"no offline-installer link found... not pursued further per scope" reasoning
for 1.0/1.1/2.0/3.0). Internet Archive has community uploads, several
tagged `creator: Microsoft` (i.e. re-uploads of the original vendor binary,
not a repack) and one specifically validator-reviewed
("`checked for malware`"). Hashes are the archive.org item's own
(md5/sha1), **not** vendor-published -- there is nothing in `gaps.json`'s
own research to cross-check them against, so these are alternative-source
leads, not confirmed-identical mirrors of anything already in the catalog:

- **.NET Framework 1.0**: item `NETFramework10` (title "Microsoft .NET
  Framework 1.0", creator Microsoft) -- `NET_Framework10.exe`, 20659224
  bytes, md5 `e45cf233a672edef5c1d978a3722ee61`, sha1
  `5bebe55271463658d97bc053ca1b7db6a4896a92`. A second item `net10`
  ("Microsoft .NET Framework 1.0 x86/x64") has a different, larger file
  (`net10.EXE`, 41619456 bytes) -- likely a combined x86+x64 redistributable
  from a later point, worth comparing against Microsoft's original
  single-arch release notes before treating either as canonical.
- **.NET Framework 1.1**: item `microsoft-net-framework-1.1` (creator
  Microsoft, curator note "checked for malware", uploaded 2021) --
  `Microsoft Net Framework 1.1.exe`, 24265736 bytes, md5
  `52456ac39bbb4640930d155c15160556`, sha1
  `16a354a2207c4c8846b617cbc78f7b7c1856340e`.
- **.NET Framework 2.0**: item `dotnetfx2` ("Microsoft .NET Framework 2.0")
  -- `dotnetfx_a3625c59d7a2995fb60877b5f5324892a1693b2a.exe`, 23510720
  bytes, md5 `93a13358898a54643adbca67d1533462`, sha1
  `a3625c59d7a2995fb60877b5f5324892a1693b2a` (filename itself is the
  vendor's own SHA-1-tagged Windows-Update filename convention, matching
  the same pattern seen on `download.windowsupdate.com` above -- strong
  circumstantial evidence this is the genuine 2.0 SP-era redistributable,
  though the file wasn't cross-checked against a live Microsoft copy).
  Also a dedicated item `net-framework-2-0-sp-2` ("Microsoft .NET Framework
  2.0 SP2", creator Microsoft) worth checking if SP2 specifically is
  wanted instead of the base 2.0 RTM.
- **.NET Framework 3.0**: item `microsoft-.net-framework-3.0-3.0.4506.30`
  (creator "Microsoft Corporation") carries **both** architectures as
  separate files: `dotnetfx3.exe` (x86, 52770576 bytes, md5
  `7b26435437e8d779ff0084d4ea96d15a`) and `dotnetfx3_x64.exe` (94482712
  bytes, md5 `683ad678a5de2328b6bbf1eba7b25f62`).

## macOS

- **Apple's own update infrastructure carries at least one runtime-adjacent
  package family.** Fetched
  `swscan.apple.com/content/catalogs/others/index-10.15-...-leopard.merged-1.sucatalog`
  (6.9 MB plist, 200 OK) and grepped it for package names rather than
  reading it: **zero** `.pkg`/Java hits (packages here are `.tar`/`.dist`
  under `swcdn.apple.com`, not standalone runtime installers), but it does
  carry Xcode's **Command Line Tools** as its own package family --
  `CLTools_Executables.pkg`, `CLTools_macOS_SDK.pkg`, etc. under
  `swcdn.apple.com/content/downloads/46/21/001-89745-A_.../`. Confirmed
  live: `CLTools_Executables.pkg` HEAD returns 200, Content-Length
  354998770, Last-Modified 2021-01-21 -- so this is a genuine, currently
  serving, decade-plus-relevant archive of a developer runtime component,
  just not "Java for OS X" specifically in the catalog file checked.
  "Java for OS X" itself (an OS-component runtime Apple bundled/updated
  through ~2018) was not found in this merged catalog and wasn't chased
  further -- it likely lived only in now-superseded, OS-version-specific
  catalog files that aren't part of the current merged index.
- **`xcodereleases.com`**: itself freely fetchable (`data.json`, 453
  entries, sha1 checksums per build) -- good for checksum corroboration --
  but every `links.download.url` points at `download.developer.apple.com`,
  confirmed **login-gated** (unauthenticated HEAD 302s to
  `developer.apple.com/unauthorized/`). Gated/unavailable as an actual
  download source from this sandbox.
- **python.org / CRAN / Node macOS installers already in the catalog**:
  no further action taken -- coverage is already high (python 252/252,
  r 118/119, node 2723/2817 per `unmirrored-summary.txt`) from prior mirror
  hunts (official CRAN/Node mirror networks, Huawei/Tsinghua/etc. package
  mirrors, Wayback). This pass didn't find a Windows-Update-Catalog-style
  macOS analogue that changes that picture.
- **Apple-bundled Python/Ruby/Java (System Python, `/usr/bin/ruby`, the
  pre-Java-11 `/usr/bin/java` stub)**: OS components, not independently
  downloadable runtime installers -- note only, no catalog action, per the
  brief.
- **MacPorts / Tigerbrew**: both are old-macOS package managers that could
  hold old runtime builds as distfiles, but per the brief another agent's
  workstream owns distfile-mirror discovery generally -- noted here for
  cross-reference only, not investigated further in this pass.
- **Macintosh Garden**: reachable (200 OK) but its collection is
  overwhelmingly Classic Mac OS (68k/PowerPC, pre-OS X) abandonware --
  it predates every macOS entry already in this catalog (earliest is the
  2006 "Universal MacPython" OS X installer), so there was no overlapping
  version to hash-check. Not pursued further.
- **Macintosh Repository (`macintoshrepository.org`)**: unreachable from
  this sandbox (connection timeout on all attempts, same failure mode as
  `wsusoffline.net` below) -- gated/unavailable, not evaluated.

## WSUS Offline Update / Legacy Update: gated or non-mirroring

- **WSUS Offline Update** (`wsusoffline.net` and all subdomains): every
  connection attempt from this sandbox failed outright (`connect
  ECONNREFUSED` / timeout to 49.12.5.18), so nothing could be fetched
  directly. From public forum posts and the parallel pattern in
  `abbodi1406/vcredist`'s own README, its static download-link files just
  point at Microsoft's own `download.microsoft.com` /
  `download.visualstudio.microsoft.com` URLs (e.g. the VC++ 2015 links
  `download.microsoft.com/download/9/3/F/93FCF1E7-E6A4-478B-96E7-D4B285925B00/vc_redist.{x86,x64}.exe`)
  -- it orchestrates downloads for offline patching, it does not host or
  re-mirror the files itself. Not a distinct host either way.
- **Legacy Update** (`legacyupdate.net`): every request from this sandbox,
  including with a browser-like User-Agent, hit a Cloudflare Turnstile
  "Challenge required" page (HTTP 403, confirmed on both the homepage and a
  specific download-item URL) -- fully gated from here. Web search
  (allowed, one of the 4 used) surfaced its own GitHub org
  (`github.com/LegacyUpdate/LegacyUpdate`) and several of its indexed
  page titles confirming it **does** archive Microsoft Download Center
  files removed since 2012, including "Visual C++ Redistributable for
  Visual Studio 2012 Update 4" and "...for Visual Studio 2013" (both
  linked above as leads) and a Visual J# .NET redistributable -- but byte
  contents couldn't be verified, and no `.NET Framework`-titled page turned
  up in the search results used. Recorded as gated/unavailable; worth a
  retry from a network that isn't Cloudflare-flagged.

## Files in this folder

- `updates_1.jsonl`, `updates_2.jsonl` -- the exact `add_mirrors.py` input
  files applied (3 dotnet-framework mirrors total).
- `append_dotnet_notes.py` -- lock-safe (`fcntl.flock` on
  `catalog/.write.lock`), idempotent script that appended this pass's
  writeup to `catalog/dotnet/NOTES.md`; already run.
