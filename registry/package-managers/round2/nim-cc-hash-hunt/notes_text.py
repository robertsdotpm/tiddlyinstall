NIM = """
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
"""

CC = """
Scope: the WinLibs / w64devkit / LLVM-release groups that rounds 1 and 2 left
unmirrored, approached by **content hash** this time. Work and evidence:
`catalog/package-managers/round2/nim-cc-hash-hunt/`.

### Hash-addressed lookup works for GCC once you supply the hash

GCC publishes no checksum, so every `gcc/source` entry has `checksum: null` --
which is why the round-2 Nix sweep, which only used entries that *had* a
catalogue checksum, never looked at them. Using the runtimes store's own pins
(`store/sha256-local.json`, 278 locally-hashed files) as the lookup key instead,
all 84 cc/nim entries with such a pin were swept against
`tarballs.nixos.org/sha256/<hex>`: **5 hits, all GCC source** -- 4.9.4, 5.5.0,
6.5.0, 7.5.0 and 15.3.0. That is a useful set: the first four had been pruned
from the Gentoo tree, so they were the only GCC entries in the catalogue with
**no corroborating hash at all**. Nix's canonical `sha512/<hex>` redirect target
for each is now recorded as `checksum_corroboration`. The cache works over plain
http as well as https; `gcc-7.5.0.tar.xz` (59.9 MiB, just under the sample cap)
was downloaded in full over **http** and its sha256 matched the store pin exactly.

### One new github-release mirror, and one that looks real and is not

Three CN university mirrors not previously tested turned out to carry
`github-release/llvm/llvm-project/`: **mirrors.bfsu.edu.cn**,
**mirrors.nyist.edu.cn** and **mirror.lzu.edu.cn** (lzu is the only host found
anywhere that also carries `brechtsanders/winlibs_mingw`). All three hold the
same rolling window as the already-confirmed NJU mirror -- the newest LLVM tag
only -- so they add redundancy, not coverage.

Only **mirrors.bfsu.edu.cn** is usable, and the reason is worth recording as a
method note. On nyist and lzu a HEAD returns **200 with the exact vendor
`Content-Length`**, over plain http too, and a bogus path in the same directory
404s -- a HEAD-only check would have confirmed both. A real GET 302s to
`/testpow/?url=...`, an nginx proof-of-work bot challenge no plain HTTP client
passes. Both rejected. BFSU serves real bytes: the first 1 MiB of
`LLVM-23.1.1-Linux-X64.tar.xz` fetched by `Range` is byte-identical to GitHub's
asset, and the sibling `llvm_man_pages-23.1.1.tar.xz` (357 KB) downloaded in
full matches GitHub's digest `66f368b2...708427349`. BFSU is https-only (http
301s). Applied to its 4 matching entries, all of which NJU already covered.

### Rejected / confirmed absent

- **mirrors.huaweicloud.com/github-release/**: soft-200 catch-all -- a bogus
  release directory and a bogus file name both 200, and a HEAD on a real
  `.tar.xz` returns `Content-Type: text/html` (the Angular portal shell).
- **No github-release tree at all**: mirrors.cloud.tencent.com, mirrors.aliyun.com,
  mirrors.zju.edu.cn, mirrors.pku.edu.cn, mirrors.hit.edu.cn, mirrors.xjtu.edu.cn
  (404); mirrors.jlu.edu.cn (302 loop); mirrors.sustech.edu.cn (302s to TUNA, no
  independent copy); mirrors.cqupt.edu.cn (503) and mirror.redrock.team (301s to
  it); mirror.sjtu.edu.cn ("No route for github-release" -- S3-like backend, not
  browsable); mirrors.chzu.edu.cn does not resolve.
- **Gentoo cannot help any cc binary entry**: `llvm-core/llvm`'s Manifest holds
  only `llvm-project-<ver>.src.tar.xz` plus manpage/patchset archives. Gentoo
  builds LLVM from source and carries none of the `clang+llvm-*` / `LLVM-*.exe`
  release assets, so the 147-host Gentoo distfiles mirror network is not a lead
  for this runtime.
- **Buildroot / Yocto / OpenWrt flat source mirrors**: every unmirrored cc file
  name (1184 of them) was HEAD-probed against `sources.buildroot.net`,
  `downloads.yoctoproject.org/mirror/sources/` and `sources.openwrt.org` --
  **3555/3555 clean 404**, controls included. These caches hold the *source*
  tarballs those build systems fetch; they carry none of the catalogue's
  prebuilt WinLibs / w64devkit / LLVM release assets.
- **Software Heritage**: same Anubis soft-200 challenge as recorded under nim.
- **w64devkit**: still nothing outside its canonical GitHub release. Absent
  (404) from bfsu, nyist and iscas this round, on top of nju/tuna/ustc/hust in
  rounds 1-2. Three rounds, no mirror.

### Coverage

No change in entry counts: releases.json stays at **232/1416 (16.4%)** and
download_plan_majors.json at **88/186 (47.3%)**, because both new hosts cover
files that were already mirrored. What did change is evidence quality: 5 GCC
entries gained a hash-addressed mirror and 4 of them gained their first
independent checksum. 18 mirror links and 5 `checksum_corroboration` entries
applied via `tools/add_mirrors.py`
(`package-managers/round2/nim-cc-hash-hunt/updates.jsonl`).

Note for the record: cc was *not* starting from zero plain-http URLs -- the 13
`gcc/source` entries already carry `http://mirror.lyrahosting.com/gnu/gcc/...`
from the round-1 GNU-mirror pass (16 such URLs). The Nix http URLs added here
land on 5 of those same entries, so the plain-http entry count is unchanged at
13/1416.

### Budget

0 of the 4 allotted web searches used. One file downloaded in full
(gcc-7.5.0.tar.xz, 59.9 MiB) plus one 357 KB and one 1 MiB range request; all
deleted.
"""
