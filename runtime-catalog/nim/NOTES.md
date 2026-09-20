# Nim runtime catalog notes

## Why this scraper looks different from go/scrape.py

Nim has no machine-readable release index anywhere. `scrape.py`'s docstring
covers the mechanics; the short version:

- `https://nim-lang.org/download/` (the actual file host) returns a plain
  nginx **403 for the bare directory** -- autoindex is off, this is not a
  bot/WAF block -- while every individual file under it (any client, any
  User-Agent) returns 200 fine. There is no JSON/XML listing.
- `https://nim-lang.org/download.html` 302s to `https://nim-lang.org/install.html`,
  which has a real "Install previous versions" HTML table -- but a bare
  `python-urllib` User-Agent gets 403'd by nim-lang.org's front end (curl's
  default UA also got 403'd on the *directory* path specifically). Every
  request in `scrape.py` sends a Chrome-like UA; this was verified
  empirically (curl with `-A "Mozilla/5.0 ..."` succeeds, `urllib`'s
  default `Python-urllib/3.x` UA gets a 403) before writing any code.
- `nim-lang/Nim` has git tags for every release but **zero GitHub Releases**
  (`gh api repos/nim-lang/Nim/releases` returns `[]`) -- no attached
  binaries there at all.
- Binaries for several targets (macOS, Linux arm64/armv7) instead live on
  `nim-lang/nightlies`, under dated "backport to stable branch" release
  tags, and are only discoverable via the version->asset-URL mapping in
  install.html's table -- there's no tag-name pattern to construct them
  from directly.

So `releases.json` was built by: (1) enumerating all 72 stable git tags
(`v0.8.14` .. `v2.2.12`, confirmed by hand to contain no rc/beta suffix)
via `gh api repos/nim-lang/Nim/tags`, with `released` from each tag's
commit date (`gh api repos/nim-lang/Nim/commits/<sha>`); (2) HEAD-checking
a fixed superset of candidate filenames per version directly against
`nim-lang.org/download/`, using the exact naming choosenim itself builds
(`nim-lang/choosenim`, `src/choosenimpkg/download.nim`'s `binaryUrl` /
`websiteUrlXz` and `cliparams.nim`'s `getBinArchiveFormat`); (3) parsing
install.html's release table for GitHub asset URLs, added to
`releases.json` **only** where nim-lang.org itself has nothing for that
exact (version, os, arch) -- so this step contributes macOS and Linux
arm64/armv7 history without ever duplicating or second-guessing the
canonical host. No runtime file was downloaded in full; every check is a
HEAD request or a GET of a several-byte `.sha256` sidecar or the
~350KB install.html page.

864 candidate URLs were HEAD-checked against nim-lang.org directly; 342
resolved. 118 more came from the nightlies-table backfill (only entries
not already covered directly). Total: 460 release entries.

## The Nimrod -> Nim rename (majors 0.8, 0.9)

Nim was called "Nimrod" through v0.9.6; the project renamed itself at
v0.10.2 (2014) around when nim-lang.org itself came into existence. Every
candidate filename under `nim-lang.org/download/` for 0.8.14, 0.9.0,
0.9.2, 0.9.4 and 0.9.6 was checked and 404s (Nim's own naming, `nim-...`,
would never have applied to Nimrod-branded files anyway), and the old
`nimrod-lang.org` domain no longer resolves at all (connection times out).
Recorded as one gap entry each for 0.8 and 0.9 at `os`/`arch` = `"all"`.
No Wayback Machine lookups were attempted for this catalog pass (that
tool is reserved/rate-limited for the mirror-hunt round; also, out of
scope for "official sources" per the task brief).

## Windows: an surprising within-major gap (0.19.0 / 0.19.2)

Every 0.19.x patch was checked individually, not just the newest: v0.19.0
and v0.19.2 have **no** Windows build of any kind (no `_x64.zip`,
`_x32.zip`, or `_x32.exe`) at nim-lang.org, while v0.19.4 and v0.19.6 (the
same minor!) do. This isn't treated as a schema-level gap for major
`"0.19"` since the major as a whole *is* covered (download_plan picks the
newest patch, 0.19.6, same as it would for any major) -- it's recorded
here only as a real, verified oddity in the release history, not a
scraping miss. Majors 0.17 and 0.18, by contrast, have **zero** Windows
builds across every patch they contain -- that is a genuine major-level
gap.

## Linux and macOS binaries did not always exist

- **Linux**: nim-lang.org's first Linux binary tarball is `nim-0.20.0-linux_x64.tar.xz`.
  Every 0.10.x through 0.19.x release predates this; Linux users had to
  build from source (or use a distro package) for those majors. Recorded
  as a gap per major (0.10-0.19) rather than one blanket entry, since each
  major has its own newest-patch source fallback in download_plan.json.
- **v0.10.2 is a genuine oddity**: it has an installer
  (`nim-0.10.2_x32.exe`) but **no source tarball at all** under any of
  `nim-0.10.2.tar.xz` / `.tar.gz` / `.zip` -- checked and 404 on all three.
  This is the one major (0.10) where download_plan.json has *no* Linux or
  macOS entry at all, because there is no source to fall back to either
  (not a bug in the fallback logic -- confirmed by hand against
  releases.json, which has exactly one entry for 0.10.2: the Windows
  installer).
- **macOS**: choosenim's own `download.nim` only builds a binary URL
  `when defined(Windows) or defined(linux)` -- it falls straight to
  source for macOS, confirming nim-lang.org itself never shipped one
  historically. The nightlies-table backfill (see above) does provide
  real macOS `.tar.xz` builds from **v1.0.8 onward** (amd64; arm64 joins
  at v2.0.0-era releases, matching when Apple Silicon became relevant).
  Majors 0.10 through 0.20 have no macOS build anywhere and fall back to
  source in download_plan.json.

## nim-lang.org started mirroring nightlies-built targets itself at 2.2.8

The most surprising finding: starting with **v2.2.8** (released
2026-02-23), nim-lang.org/download/ itself began serving
`nim-X.Y.Z-macosx_x64.tar.xz`, `-macosx_arm64.tar.xz`, `-linux_arm64.tar.xz`
and `-linux_armv7l.tar.xz` directly -- the exact same filenames the
nightlies-backport release for that version uses. Checked and confirmed:
v2.2.0 through v2.2.6 have none of these on nim-lang.org (404), v2.2.8
onward do (200). Older still-maintained branches (2.0.16, 1.6.20, 1.4.8
checked by hand) were **not** backfilled with this at nim-lang.org --
only 2.2.x got it, and only from 2.2.8 forward. Where nim-lang.org has it
directly, that's what's in releases.json (`variant: null`, matching every
other nim-lang.org file); where it doesn't, the nightlies-table entry
fills the gap with `variant: "nightlies"` and a note.

**v2.2.12 is missing `linux_armv7l`** specifically (2.2.8 and 2.2.10 both
have it; checked and confirmed 404 for 2.2.12) -- looks like that one
target failed to build for that specific release. Not treated as a major-
level gap since 2.2.10's armv7 build is what download_plan.json's
"newest complete" selection would need to consider, but download_plan
picks strictly the newest *available* patch per (major, os, arch), which
for `linux`/`armv7`/major `2.2` is 2.2.10, not 2.2.12 -- so the plan is
unaffected; recorded here for the "why isn't this using the latest patch
everywhere" question.

## The `nim-0.12.0.zip` file

One early release, v0.12.0, has a plain `nim-0.12.0.zip` (no `_x32`
suffix) at 33.8MB -- far larger than that version's `nim-0.12.0.tar.xz`
source (3.1MB) or `nim-0.12.0_x32.exe` installer (6.2MB). Classified as
`os: windows, arch: x86, kind: archive, format: zip`: too large to be
plain source, and the size is consistent with a self-contained
Windows package bundling a C toolchain (avoiding the separate installer's
MinGW download step). No other version has a file matching this bare
`nim-X.Y.Z.zip` pattern (checked for all 72 versions).

## Checksums

`.sha256` sidecar files (`<file>.sha256`, containing `<hex>  <filename>`)
started appearing around the v0.15.2/v0.16.0 timeframe -- checked and
confirmed absent for v0.10.2 through v0.14.2. 321/460 release entries
have a vendor checksum; the rest (pre-0.15.2 direct files, and the
handful of nightlies-table assets whose `.sha256` companion didn't
resolve) have `checksum: null` per schema ("null if the vendor publishes
none"), never computed locally.

## download_plan.json

80 entries: newest patch per (major, os, arch) for windows/linux/macos
where a real binary exists (55 archives + 4 installers, the installer
cases being majors 0.10-0.14 which never got a zip alternative), plus 21
source-fallback entries (relabelled with the target `os`) for every
(major, os) pair with zero binaries -- except major `0.10`, which has
none at all to fall back to (see above). Total: 0.957 GB.

## Sources used

- `https://nim-lang.org/download/<filename>` -- the canonical binary/
  source host; HEAD-checked per the candidate list in `scrape.py`.
- `https://nim-lang.org/install.html` -- parsed for the nightlies-backport
  table (version -> nim-lang/nightlies GitHub asset URLs for macOS and
  Linux arm64/armv7). Confirmed as builds of the *tagged stable* release
  (not devel) because the table's own version column (`2.2.12`, `2.2.10`,
  ...) matches real `vX.Y.Z` git tags one-for-one, under nim-lang.org's
  own "Install previous versions" heading.
- `gh api repos/nim-lang/Nim/tags` and `.../commits/<sha>` -- version list
  and release dates (no GitHub Releases exist on this repo at all).
- `nim-lang/choosenim` source (`src/choosenimpkg/download.nim`,
  `cliparams.nim`) -- read to confirm exact filename conventions rather
  than guess them; also confirms macOS was never in choosenim's binary
  download path.

## Budget

0 web searches used for Part 1 (choosenim source + direct HTTP checks
answered everything). No runtime file was downloaded in full.


## Mirror hunt, round 2 (2026-09-17)

Ran `extra_mirrors.py` per `MIRROR-HUNT-2.md`. Four real, independently-
operated hosts confirmed (see `mirrors.json` for full detail on each:
region, protocols, sample files, hash-verified sample):

- **distfiles.gentoo.org** -- hash-addressed Gentoo distfiles cache,
  confirmed via `dev-lang/nim`'s Manifest. Only the 2 versions currently
  in the Gentoo tree (2.2.10, 2.2.12) -- portage prunes distfiles for
  removed ebuild versions.
- **distcache.freebsd.org** -- FreeBSD ports distfiles cache, confirmed
  via `lang/nim`'s distinfo. https fails from this environment (same
  Fastly SNI/cert issue noted for other runtimes); http works. Only the
  current port version (2.2.12).
- **distfiles.macports.org** -- confirmed via `lang/nim`'s Portfile. Only
  the version MacPorts has gotten around to packaging (2.2.6 -- the port
  lags upstream by several releases).
- **tarballs.nixos.org** -- Nix's hash-addressed Hydra fallback cache
  (`sha256/<hex>`). By far the best *historical* coverage of the four:
  swept all 57 source entries with a vendor sha256, 14 resolved. Unlike
  the three distro caches above, this isn't pruned to "whatever's
  currently packaged" -- it holds whatever nixpkgs happened to reference
  across its history (0.17.2 through 2.2.4, unevenly).

All four: HEAD size match against the vendor entry, a bogus-path control
returning a genuine 404 (Gentoo, FreeBSD, Nix) or the manifest/distinfo/
Portfile hash matching our vendor checksum directly (all four), plus one
full download + local sha256 verification per host (deleted after):
nim-2.2.10.tar.xz (Gentoo, https), nim-2.2.12.tar.xz (FreeBSD, http),
nim-2.2.6.tar.xz (MacPorts, https), nim-1.6.20.tar.xz + nim-0.17.2.tar.xz
(Nix, https and http respectively). 18 mirror links applied total via
`add_mirrors.py` (2 Gentoo + 1 FreeBSD + 1 MacPorts + 14 Nix) -- all to
source (`kind: source`, `.tar.xz`) entries; none of these four sources
carry Nim's platform binaries (all four build Nim from source).

**Rejected / inconclusive** (full detail in `mirrors.json`):

- General China mirrors checked for a `nim/` directory: USTC, ISCAS,
  Aliyun all clean-404 (real negative -- these hosts do serve other
  runtimes at neighboring paths, e.g. go/'s `/golang/`, so a 404 here is
  a meaningful signal, not a block). **Huawei Cloud** 200s `/nim/` but
  also 200s a bogus control path with the identical Angular SPA shell --
  a soft-200 catch-all, rejected on the same grounds as round 1's
  SourceForge case. **NJU** 302-redirects `/nim/` to itself, but so does
  a bogus path AND `/golang/` (a real, already-mirrored path per go/'s
  catalog) -- every subpath 302s identically here, so this host gives no
  usable signal either way for Nim specifically. **TUNA** hard-403s
  every path with an anti-abuse block page, same as observed in go/'s
  round-1 hunt -- looks like a standing block on this environment's
  egress IP, not evidence the mirror doesn't exist.
- **github.com/nim-lang/Nim releases**: confirmed dead end already in
  Part 1 (`gh api repos/nim-lang/Nim/releases` is `[]` -- no assets
  exist to mirror).
- **Scoop** (`ScoopInstaller/Main`): sha256 corroboration matches our
  vendor checksum exactly for the current Windows zips, but it points at
  nim-lang.org itself (not an independent host) and only covers the
  latest version, which already has a vendor checksum -- checked, adds
  nothing.

**Budget**: 0 web searches used (all leads resolved by direct HTTP checks
and reading GitHub-hosted package-manager metadata via `gh api`/raw
fetches). No runtime file over 60MB was downloaded; the four full
downloads above (all well under 11MB) were deleted immediately after
their local sha256 was checked.

Coverage: before this hunt, 0/460 releases.json entries had any mirror.
After: 18/460 (all 18 are among the 57 vendor-checksummed `kind: source`
entries) -- i.e. roughly 32% of source entries, 0% of binary entries (no
binary mirror source was found for any OS/arch; all four confirmed hosts
build Nim from source only). `download_plan.json`: of its 21 source-kind
entries, the ones at exactly 0.17.2, 0.18.0, 0.19.6 (nightlies picked
0.19.6, not 0.19.4 -- so the Nix hit on 0.19.4 doesn't carry through to
the plan), 0.20.2, 2.0.16 now have a mirror; the plan's other source rows
(0.10-0.16, 1.0-1.6 era's *newest* patch specifically) mostly land on
patches this hunt didn't find a mirror for, since Nix's coverage is
uneven across patches within a major.

## Real-app fidelity (installer-builder, 2026-09-19)

A Nim program built with `-d:ssl` (std/httpclient over HTTPS, as installer-
builder's `tests/fidelity/nim` is) stopped at start on Windows: `could not
load: (libcrypto-1_1-x64|libeay64).dll`. The Windows zip has no DLLs; Nim's
installer (finish.exe) downloads `dlls.zip` (OpenSSL 1.1, PCRE, SQLite,
pdcurses). The Windows recipe for 1.6 and 2.2 now unpacks the policy's pinned
`dlls.zip` into `bin` (Windows's tar.exe on 10 1803+, the shell's zip folder
support on 7 and 8.1), adds a current `cacert.pem` there (std/net looks for it
beside the program or on PATH; dlls.zip's is from 2021), and puts `bin` on the
app's PATH (`launch.path_prepend`). dlls.zip's OpenSSL is 1.1.1k (2021),
what Nim still ships.


## Mirror hunt round 3 (2026-09-20, hash-addressed / distro-archive pass)

Goal for this round: mirrors found by **content hash** rather than by file name,
and mirrors reachable over **plain `http://`** (nim had exactly one such URL
before: distcache.freebsd.org for 2.2.12). Work and evidence:
`catalog/package-managers/round2/nim-cc-hash-hunt/`.

### The finding: Debian's archive carries early nim tarballs unmodified

`snapshot.debian.org` is a permanent, content-addressed archive
(`/file/<sha1>`) of every source file Debian has ever shipped -- unlike Gentoo,
FreeBSD, MacPorts or Alpine, it is never pruned to "whatever is packaged now".
Its `/mr/package/nim/<version>/srcfiles?fileinfo=1` API was read for all 37
upstream versions present in both Debian and this catalogue. Debian renames the
file (`nim-0.12.0.tar.xz` -> `nim_0.12.0.orig.tar.xz`), and for most of nim's
history it also **repacks** it -- a git export bundling csources/nimble, 30-130 MB
against upstream's 3-10 MB. Those were rejected on size, not assumed equivalent.
Seven versions matched our size exactly: **0.12.0, 0.13.0, 0.15.0, 0.15.2,
0.16.0, 0.17.2, 2.2.12**. Per MIRROR-HUNT-2's renamed-file rule, all seven were
then downloaded in full from Debian *and* from nim-lang.org in the same pass and
compared: **7/7 byte-identical**, and for the three that carry a vendor checksum
(0.16.0, 0.17.2, 2.2.12) the vendor download also matched `releases.json`
exactly.

Those same `.orig.tar.xz` files are then reachable over **plain http** from the
ordinary Debian/Ubuntu pools, which is what an XP/Vista machine needs:

- `deb.debian.org` -- 2.2.12 (the live pool, so current version only)
- `archive.debian.org` -- 0.16.0 (end-of-life suites)
- `archive.ubuntu.com` -- 0.12.0, 0.17.2
- `old-releases.ubuntu.com` -- 0.13.0, 0.15.2, 0.17.2
- `ports.ubuntu.com` -- 0.12.0, 0.17.2

All five serve the identical bytes over both http and https, 404 a bogus pool
filename, and one file per host was downloaded in full over **http** and
sha256-verified. `snapshot.debian.org` itself also works over plain http
(verified by a full download of nim_0.15.0.orig.tar.xz). **0.15.0 exists on no
other mirror at all**, snapshot included -- it is the only source for it.

### NetBSD pkgsrc distfiles

`ftp.netbsd.org/pub/pkgsrc/distfiles/` is flat (lang/nim sets no `DIST_SUBDIR`)
and plain-http-capable, but pruned to the currently-packaged version: all 112
nim source filenames were probed and exactly one, **nim-2.0.4.tar.xz**, is
present. HEAD size match over both protocols, real 404 on a bogus name
(bozohttpd), full download over http, sha256 matched the vendor checksum.

### Gentoo distfiles mirror network (plain http, nine institutions)

Round 2 recorded only `distfiles.gentoo.org` itself. All 273 reachable
http/https roots on `api.gentoo.org/mirrors/distfiles.xml` were probed for both
nim tarballs plus a bogus filename-hash control: **194 serve both with an exact
size match and a real 404**. Adding all of them would put ~200 URLs on two
entries, so nine university / NREN hosts were selected, one or two per region --
University of the Free State (ZA), JAIST (JP), AARNet (AU), C3SL/UFPR (BR), MIT
(US), University of Waterloo CSC (CA), Lysator/Linkoping (SE), UK Mirror Service
(GB), SNT/Universiteit Twente (NL). `nim-2.2.10.tar.xz` was downloaded in full
over **plain http** from all nine and its sha256 matched the vendor checksum
9/9. Only the http URLs were applied (https on these hosts adds nothing over
distfiles.gentoo.org). This is the only plain-http source that exists for
nim 2.2.10. The full 194-host result is kept in `gentoo_network.json`.

### Rejected this round (detail in mirrors.json)

- **Software Heritage** (`archive.softwareheritage.org/api/1/content/sha256:<hex>/`),
  the most promising hash-indexed lead: unusable from here. Every request,
  including a bogus all-zero-hash control, returns HTTP 200 with an "Anubis"
  JavaScript bot challenge instead of JSON. Soft-200 catch-all; blocked, not
  proven absent.
- **Guix** (`ci.guix.gnu.org/file/<name>/sha256/<nix-base32>`): clean 404 for all
  104 hashed nim source files. Guix's nim package builds from a git checkout,
  so its content-addressed cache has nothing to hold.
- **Alpine** `distfiles.alpinelinux.org/distfiles/edge/`: 112/112 clean 404.
- **Void** `sources.voidlinux.org`: 112/112 404 -- Void fetches
  `github.com/nim-lang/Nim/archive/v<ver>.tar.gz`, a GitHub-generated archive
  with different bytes, not nim-lang.org's release tarball.
- **nim-lang.org has no mirror or alternate-download list** (the task asked):
  install.html, download.html, install_unix.html and install_windows.html were
  all fetched; every link points at nim-lang.org or github.com and the word
  "mirror" does not appear. The vendor offers no plain-http path either --
  `http://nim-lang.org/download/...` 301s to https (Cloudflare).

### Still true after three rounds

**No mirror exists anywhere for nim's platform binaries.** Every host confirmed
so far (Gentoo, FreeBSD, MacPorts, Nix, and now Debian/Ubuntu/NetBSD) is a
*source* cache, because every one of them builds Nim from source. The 109
Windows archives, 105 Linux archives, 6 macOS archives, 10 Windows installers
and 118 `nightlies` assets remain vendor-only; the Wayback Machine (already
being swept by `tools/wayback_retry.py`) is the only remaining avenue for them.

### Coverage

releases.json 21/460 (4.6%) -> **26/460 (5.7%)**; entries with at least one
plain-`http://` URL 1/460 -> **9/460 (2.0%)**. download_plan.json 11/80 (13.8%)
-> **19/80 (23.8%)**, plain-http 0/80 -> **11/80 (13.8%)**.
download_plan_majors.json unchanged at 6/21 (the versions found are not the
newest patch in their major). 52 mirror links applied via `tools/add_mirrors.py`
(`updates.jsonl` and `gentoo_updates.jsonl` in this hunt's folder); as in round
2 these were applied directly, independently of `nim/extra_mirrors.py`, which
still needs re-running after any future `scrape.py`.

Restricted to binaries the resolver can offer, nothing moved: Windows archives
2/109, Linux archives 2/105, macOS archives 0/6, Windows installers 0/10,
nightlies 0/118. Every gain is on `kind: source` entries (which
`download_plan.json` relabels per OS as the build-from-source fallback, which is
why the plan number moved more than releases.json did).

### Budget

0 of the 5 allotted web searches used -- every lead was reached by fetching a
known URL or reading package metadata from GitHub. 24 files downloaded in full
for hash verification (all 2.9-10.3 MB, well under the 60 MB cap), all deleted
immediately afterwards.
