# Zig runtime catalog notes

## Sources

- `https://ziglang.org/download/index.json` -- the sole source for every
  release entry. Unlike Go's `?mode=json&include=all` (which only goes
  back to go1.2.2), Zig's own index already covers every stable release
  back to the first one, 0.1.1 (2017-10-17). Confirmed two ways before
  trusting that as complete:
  - The version keys in the JSON (minus `master`, which is an
    in-development build and dropped -- this catalog is stable releases
    only) exactly match every version number linked from the HTML page
    `https://ziglang.org/download/`.
  - `gh release list --repo ziglang/zig --limit 100` lists the same 21
    versions from 0.1.1 through 0.15.1. **Discrepancy**: ziglang.org's
    index/page additionally list 0.15.2 (2025-10-11) and 0.16.0
    (2026-04-13), which do not appear in GitHub's release list at all.
    Both are still included in `releases.json` per the task's instruction
    to treat `ziglang.org/download/index.json` as the source of truth;
    flagged here rather than silently trusted, since it's the one place
    the two sources disagreed. No GitHub-releases fallback or
    `ziglang.org/download/<ver>/` per-version listing scrape was needed
    for coverage as a result -- both remain available as fallbacks (per
    the task brief) if a future version ever goes missing from the index.

## Target mapping

Zig identifies platforms by LLVM-style target triples (`<arch>-<os>`),
not the catalog's `(os, arch)` pair, and has renamed a few over time:

- `i386-linux`/`i386-windows` (0.6.0-0.10.x) -> renamed
  `x86-linux`/`x86-windows` at 0.11.0. Same catalog `arch: "x86"`.
- `armv7a-linux` (0.6.0-0.14.1) -> renamed `arm-linux` at 0.15.1. Same
  catalog `arch: "armv7"`.
- `armv6kz-linux` (0.6.0 only -- ARM1176JZF-S / Raspberry Pi 1 baseline)
  maps to `arch: "armv6"`.
- `powerpc-linux` (0.11.0 only, then dropped) has **no slot** in the
  catalog's fixed ARCH enum (only `ppc64`/`ppc64le` exist, no 32-bit
  PowerPC) -- excluded from `releases.json` rather than invented or
  silently merged, same treatment `catalog/go` gives its unmappable mips
  variants. 1 file excluded.
- `src` -> `kind: "source"`, `os: "linux"`, `arch: "any"` per the task's
  instruction (ziglang.org serves one source tarball for any Unix host).
- `bootstrap` -> also `kind: "source"`, same `os`/`arch`, but
  `variant: "bootstrap"`: this is the separate `zig-bootstrap` tarball
  (Zig's source plus vendored LLVM/LLD/zlib/zstd source, for building a
  working Zig from nothing but a C++ compiler + CMake). It is not a
  per-platform binary and not needed for a normal install; kept as its
  own entry rather than folded into `src` since it's a genuinely
  different, much larger download.

`libc` is `null` throughout: Zig's own binaries are statically linked
(musl internally on Linux), so there is no glibc/musl choice to record,
unlike most other Linux toolchains in this catalog.

## Gaps (major-level only)

Diffed each version's target-key set against its neighbours (see
`scrape.py`'s `build_gaps`) and kept only cases where **every** patch in
a major lacks a target that adjacent majors have -- a target missing from
one patch but present in another patch of the same major isn't a gap,
since `download_plan.json` just falls back to the older patch (same
principle as `catalog/go`'s darwin dual-target handling). Three found,
recorded in `gaps.json`:

- **major 0.10, windows/x86**: absent from both 0.10.0 and 0.10.1.
  Present continuously 0.6.0-0.9.1 (as `i386-windows`) and again from
  0.11.0 (as `x86-windows`).
- **major 0.14, freebsd/amd64**: absent from both 0.14.0 and 0.14.1.
  Present continuously 0.11.0-0.13.0 and again from 0.15.1.
- **major 0.16, freebsd/ppc64**: absent from 0.16.0, currently the only
  patch in this major. `powerpc64-freebsd` was newly added at 0.15.1 and
  is present in both 0.15.x patches, so this reads as a dropped target
  rather than one not yet built -- worth re-checking once a 0.16.x patch
  exists (not in `download_plan.json`'s `PLAN_OSES` anyway, since freebsd
  isn't windows/linux/macos, but recorded as a gap since freebsd is one
  of Zig's own supported targets).

**Not** recorded as gaps (version-level only, major as a whole is
covered by another patch, so `download_plan.json` doesn't miss anything):
0.7.1 shipped no `aarch64-macos` build (0.7.0 and 0.8.0 both have it);
0.10.1 shipped no `armv7a-linux` or `x86_64-freebsd` build (0.10.0 has
both, 0.11.0 has both again).

## download_plan.json

130 entries: newest patch per (major, os, arch) for os in
windows/linux/macos (freebsd/netbsd/openbsd tracked in `releases.json`
but not planned, per the schema's `PLAN_OSES`). Every Zig release ships
exactly one archive per platform (no installer-kind builds exist for
Zig at all, and no per-platform ties), so "prefer archive, smallest by
size" never had a real tie to break here. 6.6 GB total. `windows` covers
majors 0.1-0.16 (Windows had a build from the very first release);
`macos` and `linux` start at 0.3 and 0.2 respectively, matching when
Zig first shipped those targets.

## Mirrors

`scrape.py` itself writes no mirrors (Zig has no equivalent of Go's
China-mirror-friendly CDN naming baked into its own release index; every
mirror candidate here comes from ziglang.org's own community-mirror list
or an OS/ports distro cache), so `extra_mirrors.py` must be run after
every `scrape.py` run (which resets `mirrors.json` and every entry's
`mirrors: []`) to reapply. `extra_mirrors.py` writes `releases.json` and
`download_plan.json` only through `catalog/tools/add_mirrors.py`, and
`mirrors.json` directly under `catalog/.write.lock` (read-modify-write,
atomic rename), per `MIRROR-HUNT-2.md`.

**Minisign public key** (from `https://ziglang.org/download/`, the page
that also lists these files' `.minisig` signatures):
`RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U`

### Community mirrors (`https://ziglang.org/download/community-mirrors.txt`)

This is the list ziglang.org itself publishes and that official tooling
(`setup-zig`, `zvm`, `anyzig`) tries; it names 16 candidates. Confirmed
**15 as full mirrors** of the entire `ziglang.org/download/` tree with a
9-file sample spanning `zig-0.1.1.tar.xz`/`zig-win64-0.1.1.zip` (2017,
the very first release) through `zig-x86_64-windows-0.15.2.zip` (2025,
current), covering linux/macos/windows, both the old (`zig-linux-x86_64-`)
and new (`zig-x86_64-linux-`) filename orderings, the `src` and
`bootstrap` variants, and one freebsd binary -- HEAD size-matched (with a
1-byte Range-GET fallback for hosts that don't send `Content-Length` on
HEAD, and a plain GET fallback for the couple that ignore Range too), a
bogus-path control returning a real 404 (not a soft-200 catch-all) on
every host, and a full download + sha256 verification of the small
(1.66 MB) `zig-0.1.1.tar.xz` matching `releases.json`'s vendor checksum
exactly, on **every** host:

`pkg.hexops.org/zig`, `zig.linus.dev/zig`, `zig.squirl.dev`,
`zig.mirror.mschae23.de/zig`, `zig.tilok.dev`, `zig-mirror.tsimnet.eu/zig`,
`zig.karearl.com/zig`, `pkg.earth/zig`, `zig.chainsafe.dev`,
`zig.savalione.com`, `zig.vortan.dev/zig`, `download.zigmirror.com`,
`zig.bcr.ist`, `fs.liujiacai.net/zigbuilds`,
`ziglang.freetls.fastly.net`.

Notes on quirks hit along the way (none block confirmation, all
accounted for above):
- `zigmirror.com` itself 302-redirects to `download.zigmirror.com`
  (counted as that one host, not separately).
- `zig.bcr.ist` always reports `Content-Length: 0` on HEAD (a server
  quirk -- `server: zigmirror/1.2.45`) but serves correct content and a
  correct `Content-Range` total on a Range GET; confirmed via the
  latter.
- `fs.liujiacai.net` and `zig.vortan.dev` are both Cloudflare-fronted and
  send no `Content-Length` on a cache-MISS GET (chunked transfer); both
  confirmed via actual downloaded byte counts (and, for `fs.liujiacai.net`,
  by decoding its weak `ETag`, whose second hex group is literally the
  file's byte size in hex -- e.g. `W/"333ea24-...` = `0x333ea24` =
  53,733,924, matching `zig-x86_64-linux-0.15.2.tar.xz` exactly).
- `zig.squirl.dev` and `pkg.earth` each returned one transient miss under
  30-way concurrent probing (429 rate-limit / connection error); both
  confirmed clean on a sequential retry -- treated as our own concurrency
  tripping their rate limits, not a real gap.
- `ziglang.freetls.fastly.net` doesn't answer HEAD at all (read timeout)
  but answers GET/Range fine, and its response carries
  `x-served-by-mirror: Fastly-Zig-Community-Mirror` -- this looks like an
  official Fastly-donated CDN mirror rather than a personal server, and
  is likely the most robust single entry in this list (global CDN, not
  one person's box).
- `serves_minisig` (HEAD on `<file>.minisig`) is `true` for every host
  **except** `download.zigmirror.com` (404).

**Rejected**: `zigmirror.hryx.net/zig` -- 502 Bad Gateway (Caddy) on
every sample file and the bogus-path control, every time it was checked
this session. Not a soft-200 catch-all (it fails honestly), just down.

Applied to every `releases.json` entry and every `download_plan.json`
entry: 289 entries x 15 confirmed hosts = 4,335 community-mirror links,
plus 50 distro-cache links (below) = 4,385 total. `extra_mirrors.py`
re-verifies only the cheap single-file hash sample on each run (not the
full 9-file spread) to stay fast; see the script's docstring for why.

### OS / ports distro caches

Same method as `catalog/package-managers/round2/os-distro-caches`:
checked each tree's own manifest/distinfo/Portfile, then live-confirmed
the derived URL (a manifest listing a file is not proof the cache still
serves it -- these trees prune old distfiles once a version leaves the
active tree).

- **Gentoo distfiles (`distfiles.gentoo.org`)** -- useful, source +
  some Linux binaries. `dev-lang/zig`'s ebuild Manifest lists 5 source
  tarballs (0.13.0, 0.14.1, 0.15.1, 0.15.2, 0.16.0 -- whatever's
  currently in the ebuild tree); all 5 live-confirmed by size at
  `distfiles.gentoo.org/distfiles/<blake2b(filename)[:2]>/<filename>`,
  and `zig-0.13.0.tar.xz` (17.2 MB) fully downloaded and sha256-verified
  against the vendor checksum (exact match). `dev-lang/zig-bin`'s
  Manifest additionally lists prebuilt **Linux** binaries (aarch64,
  arm/armv7a, riscv64, loongarch64, s390x, powerpc64le, x86, x86_64) for
  the same handful of versions; 42 of those matched a `releases.json`
  entry by filename + size and were live-confirmed, for 47 Gentoo
  mirrors total. (No macOS/Windows/BSD coverage -- Gentoo only packages
  Zig for Linux.)
- **FreeBSD ports distfiles (`distcache.freebsd.org`)** -- useful,
  narrow. `lang/zig`'s `distinfo` in the ports tree only ever has the
  *current* port revision's file (older ones are gone once the port
  bumps) -- at the time of this run that was 0.16.0, but
  `distcache.freebsd.org/ports-distfiles/<file>` (flat, no subdirectory)
  turned out to still serve 0.13.0 and 0.15.2 too, for 3 confirmed size
  matches (0.16.0's sha256 also matched the ports Makefile's `SHA256`
  line exactly). **https fails from this environment** (Fastly SNI/cert
  mismatch, same as the round-2 FreeBSD finding for other runtimes);
  **http works** and is what's recorded.
- **MacPorts distfiles (`distfiles.macports.org/zig/`)** -- useful,
  narrow. MacPorts packages Zig as one wrapper port (`lang/zig`) plus a
  versioned toolchain port per series (`zig-0.NN`, via a shared
  `zig_toolchain` PortGroup) that fetches straight from `ziglang.org`;
  only the *currently-current* per-series toolchain's distfile stays in
  the cache, which matched 2 of our source entries (0.15.2, 0.16.0) by
  size, one of which (0.16.0) was fully downloaded and sha256-verified
  (exact match).
- **Nix `tarballs.nixos.org`** -- checked, not usable: this is a
  content-addressed *fallback* cache keyed by the hash Nix itself
  computed for a `fetchurl`, i.e. only reachable if you already know
  Nix's own derivation hash for a given Zig build -- there's no
  filename-based listing to probe from a vendor checksum the way the
  other three caches allow. Not pursued further (same conclusion as
  round 1's per-package note that Nix is a narrow, hash-keyed win only
  where you already have the derivation hash in hand).

### China mirrors (TUNA / USTC / NJU / ISCAS) -- none found

None of the large Chinese OS-distro mirror stations named in the brief
carry a Zig directory, checked directly (browser UA, redirects
inspected, bogus-path controls where a 200 was seen):

- `mirrors.ustc.edu.cn/zig/` -- 404, no such path.
- `mirror.nju.edu.cn/zig/` -- redirects to itself in a loop (`Location:
  https://mirror.nju.edu.cn/zig/`); not a real listing.
- `mirrors.iscas.ac.cn/zig/` -- 301s to `mirror.iscas.ac.cn/zig/`, which
  404s there; no Zig content behind either name.
- `mirrors.tuna.tsinghua.edu.cn/zig/` and `.../help/zig/` -- TUNA's own
  anti-abuse block page ("your subnet has sent abnormal requests"),
  every time, for both paths -- inconclusive (this environment's egress
  IP appears blocklisted there), not evidence Zig isn't mirrored.
  Consistent with the same host being unreachable for the same reason in
  other runtimes' round-2 mirror hunts (see `catalog/go/NOTES.md`).
- `mirrors.aliyun.com/zig/`, `mirrors.cloud.tencent.com/zig/`,
  `mirrors.bfsu.edu.cn/zig/` -- 404 / 403, no Zig content.
- `mirrors.huaweicloud.com/zig/` -- returns HTTP 200, but so does a
  deliberately bogus path (`/zig-totally-bogus-path-xyz/`): this is
  Huawei's mirror-portal single-page app serving its shell for every
  route (a soft-200 catch-all, the same failure pattern the brief warns
  about for SourceForge-style hosts), not evidence of real content.
  Rejected on that control, not counted.

Zig isn't yet part of these stations' curated project lists the way
long-established runtimes (Go, Python, Node) are -- unsurprising given
how new and comparatively small the Zig ecosystem still is. The
Cloudflare-fronted `fs.liujiacai.net` community mirror (operator name
suggests a Chinese individual) is the closest thing to China-specific
coverage found, and it's already counted above.

### Budget

Zero web searches used for the entire mirror hunt (all findings came
from direct `curl`/`gh`/GitHub-raw fetches of known or brief-supplied
URLs); well under the 5-search budget. No runtime file over 60 MB was
downloaded in full; the only full downloads were the 1.66 MB
`zig-0.1.1.tar.xz` sample (once per community-mirror host, deleted
implicitly -- read into memory only) and two ~17-22 MB Gentoo/FreeBSD/
MacPorts source-tarball hash checks, all deleted after verification.
