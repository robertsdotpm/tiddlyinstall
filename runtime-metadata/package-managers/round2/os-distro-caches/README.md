# OS / ports package-manager caches as mirrors (round 2)

Question: do apt/yum-style OS package managers help mirror our vendor
files? Answer: their .deb/.rpm binaries are rebuilt and never match, but
several **source-fetch caches** behind those ecosystems store byte-identical
upstream files, addressed either by the original filename or by a content
hash. A few also cache vendor **binary** tarballs unmodified (Gentoo's
`-bin` ebuilds, Nix's fallback tarball cache), which is where the real
surprise was: our `java` catalog turned out to already contain real
Eclipse Temurin builds (not just Zulu), and those matched two independent
hash-addressed caches exactly.

All updates were applied with `catalog/tools/add_mirrors.py` under its
lock; nothing else was touched. Every mirror below passed: browser UA,
final-host check (no redirect-only entries), HEAD/GET size match on the
live host, a bogus-path control (real 404, not soft-200), and at least one
full download + local hash check per new host (deleted after). Where the
vendor publishes no checksum (GCC, some R versions), a distro-manifest
hash was recorded as `checksum_corroboration` instead of `mirror`.

## Method (re-runnable)

1. `gentoo_manifest_match.py` — pulls `Manifest` files for the ebuilds
   named in the brief (dev-lang/{python,ruby,php,R,go,rust-bin},
   dev-java/{openjdk-bin,openjdk-jre-bin}, net-libs/nodejs,
   dev-dotnet/dotnet-sdk-bin, sys-devel/gcc) from `gentoo/gentoo` on
   GitHub, matches `DIST <file> <size> BLAKE2B ... SHA512 ...` lines
   against our `releases.json` by exact filename + size, and (where our
   checksum algo overlaps) cross-checks the hash. Gentoo's distfiles
   layout is `filename-hash BLAKE2B 8` per `distfiles/layout.conf`, i.e.
   `https://distfiles.gentoo.org/distfiles/<blake2b(filename)[:2]>/<filename>`.
2. `verify_gentoo.py` — HEAD-verifies every candidate live (Gentoo prunes
   distfiles once an ebuild leaves the tree — 4 of the 13 GCC source
   versions were gone, e.g. gcc-{4.9.4,5.5.0,6.5.0,7.5.0} all 404; a
   generic filename-hash guess is not proof by itself).
3. `nix_probe.py` — same idea for `tarballs.nixos.org`, Nix's
   content-addressed fetchurl fallback cache (key = `sha256/<hex>`,
   redirecting to the canonical `sha512/<hex>`, per
   `maintainers/scripts/copy-tarballs.pl`). This is a *fallback*, not a
   full mirror: only 56 of 3349 sha256-checksummed, still-unmirrored
   entries were present (all Temurin JDK/JRE archives), but every one of
   those 56 matched by content-length and one downloaded sample matched
   its sha256 exactly.
4. FreeBSD, MacPorts, Debian snapshot, Fedora, Alpine, Buildroot, Yocto,
   OpenWrt and Arch were checked by hand against `distinfo`/`Portfile`/
   `srcfiles`/`sources`/APKBUILD/`.mk` metadata for the same runtimes,
   then the derived URL was HEAD- or GET-verified live (see the
   `*_updates.jsonl` files for the exact evidence string per entry).

## Per-source verdict

- **Gentoo distfiles — useful.** New host `distfiles.gentoo.org`
  (hash-addressed, both https and http work, CDN-backed — no separate
  per-mirror enumeration attempted). 520 mirror links applied across
  python (13), ruby (5), php (10), R (2), node (10), go (9), rust-bin
  (386), openjdk-bin (51), openjdk-jre-bin (10), dotnet-sdk-bin (24); plus
  9 GCC source mirrors and 9 `checksum_corroboration` entries for GCC
  (which the catalog records with **no vendor checksum at all**) using
  Gentoo's own BLAKE2B/SHA512. dotnet's SHA512 matched Gentoo's Manifest
  hash exactly, confirming the file byte-for-byte without needing a
  download (all dotnet SDK tarballs are >60 MB). Sample hash-verified:
  `go1.24.12.src.tar.gz` (sha256 match).
- **FreeBSD ports distfiles (distcache.freebsd.org) — useful.** Serves
  `ports-distfiles/<DIST_SUBDIR/><file>`; **https fails from this
  environment** (Fastly SNI/cert mismatch → curl error 60), **http
  works** and is the more relevant protocol for old systems anyway. 11
  files confirmed for python (5), php (4), ruby (1), R (1); 5 exact sha256
  matches, others by exact size; 1 corroboration (python 2.7.18, vendor
  only has md5) and 1 for R (no vendor checksum).
- **MacPorts distfiles — useful, smaller overlap.** `distfiles.macports.org/<portname>/<file>`,
  http confirmed (https returned 200 but stripped Content-Length on HEAD
  from here — used full GET instead). 5 files matched (python x2, php x2,
  R x1); one full download hash-verified.
- **Nix tarballs.nixos.org — partly useful, but a real find.** Confirmed
  hash-addressed fallback cache; only covers what Hydra happened to
  build. 56 Temurin JDK/JRE archives (all currently size-matched, one
  hash-verified) plus 1 Python source. Not worth relying on for broad
  coverage, but free wins where it hits.
- **Debian snapshot.debian.org — useful for Go specifically.** API used
  sparingly (a handful of `mr/package/.../srcfiles` calls). Go's Debian
  packages (`golang-1.24`..`golang-1.27`) use the pristine upstream
  `.orig.tar.gz` unmodified — 4 exact matches, one full-hash verified.
  **R was NOT usable**: Debian repacks `R-4.6.1.tar.gz` as
  `r-base_4.6.1.orig.tar.xz` (different compression → different bytes),
  correctly rejected on size mismatch rather than assumed equivalent.
- **Fedora lookaside cache — not usable from this environment.** The
  `sources` file in `src.fedoraproject.org/rpms/<pkg>` (git-raw, no
  challenge) confirmed byte-plausible SHA512 hashes for Python 3.11.16,
  ruby 4.0.6, go1.27.1 and R-4.6.1 — one (R, no vendor checksum) was
  recorded as `checksum_corroboration` since the hash itself is still
  good third-party evidence. But the actual download host
  (`src.fedoraproject.org/repo/pkgs/...`) is behind an "Anubis"
  JS bot-challenge that returns HTTP 200 HTML for *every* path including
  a bogus one — a soft-200 catch-all no scripted request gets past, so no
  mirror URL was added, consistent with the SourceForge precedent in
  round 1.
- **Alpine distfiles — useful for current versions.** Flat plain-filename
  layout (no hash prefix, despite older files in the same listing using
  one) at `distfiles.alpinelinux.org/distfiles/edge/`; only tracks
  whatever `edge` currently builds. 5 matches (python, php x2, go, R); one
  full download hash-verified.
- **Buildroot sources.buildroot.net — useful.** `<pkgname>/<file>` layout;
  confirmed go source, go's own linux-amd64 binary tarball (Buildroot's
  `go.mk` downloads the official prebuilt binary too, with its own sha256
  matching ours exactly), python3, and rust-bin's single pinned version.
- **Yocto downloads.yoctoproject.org/mirror/sources — useful, narrow.**
  Plain filenames; one match (Python 3.12.14, hash-verified) — everything
  else guessed was either too new or an unrelated point release.
- **OpenWrt sources.openwrt.org — useful, narrow.** One match
  (go1.27.1.src.tar.gz, hash-verified); python/php guesses 404'd (OpenWrt
  doesn't build those from source the same way).
- **MSYS2 — not useful for this catalog.** `repo.msys2.org` has no
  top-level `sources/` cache (only `msys/`, `mingw/`, `distrib/`); MSYS2 is
  a Windows/MinGW package repo, not a generic language-runtime source
  cache, and our Windows `cc` entries are winlibs/w64devkit builds it
  doesn't carry. Not pursued further.
- **Arch Linux — not useful.** No hash- or filename-addressed source
  cache found; `sources.archlinux.org/other/...` 404'd for the paths
  tried. PKGBUILDs fetch straight from upstream with no archival layer,
  by design.

## Net effect

10 new hosts confirmed and applied: `distfiles.gentoo.org`,
`distcache.freebsd.org`, `distfiles.macports.org`, `tarballs.nixos.org`,
`snapshot.debian.org`, `distfiles.alpinelinux.org`,
`sources.buildroot.net`, `downloads.yoctoproject.org`,
`sources.openwrt.org`, plus Fedora/Debian-derived
`checksum_corroboration` entries (2 for GCC batch... see counts below).
Total: 617 `mirror` links + 14 `checksum_corroboration` entries added via
`add_mirrors.py` (Gentoo 529/11, FreeBSD 11/2, MacPorts 5/0, Debian 4/0,
Nix 57/0, Alpine 5/0, Buildroot 4/0, Yocto 1/0, OpenWrt 1/0, Fedora 0/1),
spanning python, ruby, php, r, node, go, rust, java, dotnet and cc.
`validate.py` passes for all ten runtime folders afterwards.
