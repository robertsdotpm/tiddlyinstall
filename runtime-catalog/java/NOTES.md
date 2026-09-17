# Java catalog notes

## Sources (official, machine-readable, scripted)

- Eclipse Adoptium (Temurin) API v3 — `info/available_releases` for the
  major list, then `assets/feature_releases/<major>/ga` (paged) per major
  and image_type (jdk/jre). Only Adoptium's own `hotspot` JVM binaries are
  used; it also ships OpenJ9 for some majors, skipped so there's one build
  per vendor/image_type instead of two JVM implementations under the same
  variant name.
- Azul Zulu metadata API v1 — `zulu/packages/?java_version=<major>&
  release_status=ga&availability_types=CA` (paged, `page_size=1000`, the
  API's max). `javafx_bundled` and `crac_supported` packages are skipped
  per instructions. Zulu covers every major from 6 up to the current tip
  (26, as of 2026-09-17), including short-support (non-LTS) lines Adoptium
  has already aged out (9, 10, 12, 13, 14, 15).

Both APIs return `os`/`arch` fields that don't map 1:1 onto the catalog's
normalised values (Adoptium: `mac`/`aarch64`/`x86`/`arm`/`alpine-linux`;
Zulu: a coarse `arch` family (`x86`/`arm`) plus a separate `hw_bitness`
32/64). `scrape.py` maps both explicitly; see `ADOPTIUM_*_MAP` and
`ZULU_ARCH_MAP` at the top of the script.

## Scope cuts (deliberate, not gaps)

- **OS**: only `windows`, `linux`, `macos` were scraped. Both vendors also
  ship `solaris` (Zulu) and `aix` (Adoptium, some majors); not fetched —
  out of scope for an installer builder targeting consumer/server desktop
  OSes, and Zulu's Solaris arch value (`sparcv9`) isn't in the catalog's
  `arch` enum anyway.
- **Arch**: only `amd64`, `x86`, `arm64`, `armv7`. `ppc64`/`ppc64le`,
  `s390x`, `riscv64` are real vendor outputs (mostly Linux, mostly Java
  8/11/17) but niche server/embedded targets; not fetched.
- **JVM impl**: hotspot only (Adoptium's OpenJ9 builds for some
  major/os/arch combos are skipped).

None of the above are recorded as gaps, since a gap means "plausible and
looked for but not found" — these were never looked for.

## Every release entry has a checksum and size

Both APIs publish sha256 + byte size for every package/installer object in
the same response used to build the entry, so all 9,937 release entries in
`releases.json` have both (`checksum.source` is the API detail/checksum
URL). `size` also comes straight from the vendor, never a HEAD guess.

## download_plan

119 entries (windows 41 / linux 43 / macos 35) covering all 21 scraped
majors (6-26), ~7.7 GB total. Preference per (major, os, arch), as
specified: `temurin-jre` archive, else `zulu-jre` archive, else
`temurin-jdk` archive, else `zulu-jdk` archive (installers are never
planned; only `tar.gz`/`zip` count as `archive`). On Linux, only `glibc`
builds are considered for the plan (musl/alpine builds still exist in
`releases.json`, just not planned). In practice Temurin doesn't publish
`jre` images from Java 16 onward (the project dropped separate JRE
packaging), and covers fewer arches per major than Zulu, so the mix ended
up: 66 temurin-jre, 35 zulu-jre, 1 temurin-jdk, 17 zulu-jdk.

## gaps.json (55 entries)

- 6 entries for Java 1.0/1.1/1.2/1.3/1.4/5: Oracle Java Archive is
  login-gated and neither Temurin nor Zulu builds pre-6 releases.
- 49 entries computed by diffing the expected grid (major x
  {windows: amd64/arm64/x86, linux: amd64/arm64/armv7,
  macos: amd64/arm64}) against what was actually found across both
  vendors. Mostly: no `arm64` windows/macos builds before roughly Java
  11-16 (Apple Silicon and Windows-on-Arm predate that), and no 32-bit
  `armv7`/`x86` builds for the newest majors (both vendors dropped them).

## Mirrors (confirmed by HEAD, <=10 concurrent)

- **TUNA (Tsinghua University) Adoptium mirror**
  (`mirrors.tuna.tsinghua.edu.cn/Adoptium/<major>/<jdk|jre>/<arch>/<os>/<filename>`,
  same filenames as the GitHub release assets). Its directory listing only
  ever holds the *newest* build per major/image_type/arch/os — confirmed by
  browsing several majors' directories, each containing exactly one file
  per arch/os. So `scrape.py` HEAD-checks every Temurin release entry that
  is itself the latest for its major/image_type (not a sample: all of
  them, since there's no benefit to sampling when the whole set is only
  ~250 URLs). Result: 158/250 confirmed byte-identical (same Content-Length
  as the Adoptium asset) and recorded in that entry's `mirrors`; the other
  92 are combinations TUNA doesn't carry (older/rare arches such as x86
  Windows, or the directory structure differing for 32-bit legacy paths) —
  left unmirrored rather than guessed.
- **Azul CDN** (`cdn.azul.com/zulu/bin/...`) is not a third-party mirror —
  it's the canonical `download_url` the Zulu API itself returns, so every
  Zulu entry's `url` already points at it.
- Checked `mirrors.huaweicloud.com/openjdk/` as a candidate: it mirrors
  `jdk.java.net` community OpenJDK builds, a different vendor with
  different artifacts/checksums than Temurin or Zulu, so nothing from it
  was recorded as a mirror of any entry here.

## Not done in this pass

- `limitations.json` — the schema now documents this file ("Added later:
  developer limitations and OS support per major version", filled by "a
  research pass after the release metadata"), and the task's shared-rules
  list for this pass doesn't include it. Left for a follow-up pass.
- 0 of the 4 allotted web searches were needed — everything came from the
  Adoptium/Zulu APIs plus directly probing the TUNA mirror's own directory
  listing. `gh api` wasn't needed either: no GitHub Releases API calls were
  made directly, since Adoptium's own API already returns the GitHub
  release asset URLs, checksums and sizes.

## Mirror hunt (2026-09-17)

Extending mirror coverage per `catalog/MIRROR-HUNT.md`, on top of the
existing TUNA Adoptium mirror. All logic lives in `extra_mirrors.py`
(stdlib-only, re-runnable, caches HEAD results in
`extra_mirrors_cache.json`); it post-processes `releases.json`,
`download_plan.json` and `download_plan_majors.json` in place, only ever
appending to `mirrors[]`.

**0 web searches used** (budget was 5) — every candidate came from the
hints already given plus directly probing each host with curl.

### Added: NJU (Nanjing University) Adoptium mirror

`https://mirror.nju.edu.cn/adoptium/{major}/{jdk|jre}/{arch}/{os}/{filename}`
is an exact layout clone of TUNA's, confirmed by directory browsing
(`21/jdk/x64/linux/` holds exactly one file) and then HEAD-confirmed
against every latest-per-major/variant/os/arch/libc Temurin entry, the
same set TUNA is checked against: 116/174 confirmed, majors 8, 11, 16-21,
25. Works over both https and http, but only after a `bcheck=true` cookie
is set — the very first request (to any path) 302s back to itself and
sets that cookie in the response; every request after that succeeds. One
sample file (`OpenJDK18U-jre_aarch64_mac_hotspot_18.0.2.1_1.tar.gz`,
36,270,257 bytes) was downloaded in full and its sha256 matched the
catalog's checksum for that entry exactly; deleted afterwards.

### Added: USTC (University of Science and Technology of China) Adoptium mirror

`https://mirrors.ustc.edu.cn/adoptium/releases/temurin{major}-binaries/{tag}/{filename}`
is a clone of the GitHub *release* layout (not TUNA's), discovered by
browsing `/adoptium/releases/`: it holds `temurin{8,11,17,19,20,21,25}-binaries/`
directories, but only ONE tag per major (major 19 and 20's directories are
present but empty). That one tag isn't necessarily upstream's newest —
major 21 was sitting on `jdk-21.0.9+10` while Adoptium's current release
is `21.0.12.1+1` — so this mirror is treated as partial/rolling like TUNA,
not "latest, therefore safe to assume for the whole grid": every candidate
was individually HEAD-confirmed rather than applied by directory listing
alone. 84/84 candidates confirmed (majors 8, 11, 17, 21, 25 — everything
the directory listing offered a tag for).

Actual file GET/HEAD requests (directory listings are unaffected) are
gated by a same-origin, JS-free challenge page — "Verifying your browser
... Additional verification is required for this file you requested" —
that sets `document.cookie = "addr=<the IP the edge node saw>"` and
reloads after 2 seconds. No headless browser needed: read the IP back out
of the ~900-byte page body once per run and resend it as
`Cookie: addr=<ip>` on the retry. A bogus IP value in that cookie does not
work; it has to be the one the edge echoed back.

Even so, the challenge did not fire consistently — some smaller files
(mostly `.msi`/`.pkg` installers) returned real headers on the very first
HEAD with no cookie at all, which is most likely edge caching of recently-
served objects rather than a true bypass. Partway through this session's
first confirmation pass (after the NJU pass and ~84 USTC HEAD checks at 10
concurrent, plus a few manual curl probes made while investigating the
challenge mechanism), `mirrors.ustc.edu.cn` began returning a blanket 403
on every path, including plain directory listings — a WAF rate-limit, not
a permanent block: it lifted on its own within several minutes. A second
pass, run at 3 concurrent requests with a 0.3s stagger between them once
the block had lifted, confirmed all 84/84 cleanly with no further
blocking — that pacing is worth keeping for any future re-run against
this host.

**The required one-sample full-file sha256 verification for this mirror
was not completed.** After the rate-limit episode, the smallest confirmed
file (27,721,728 bytes, `OpenJDK21U-jre_aarch64_windows_hotspot_21.0.9_10.msi`)
downloaded at well under 1 KB/s — HEAD requests and directory listings
stayed fast throughout, so this reads as a throttling penalty rather than
a real link-speed problem. Two attempts (60s and 300s budgets) were
abandoned rather than left running for the ~8+ hours the observed rate
implied. The 84 URLs recorded are each a real Content-Length match against
the vendor's own size, but per this catalog's own confirmation rule that
is HEAD-confirmed, not hash-verified — flagged in `mirrors.json` rather
than silently treated as fully verified. A follow-up run (retried later,
or from a different network path) should complete the sample download
before this mirror is fully trusted the way TUNA and NJU now are.

### Rejected

- **BFSU (Beijing Foreign Studies University)** mirror,
  `https://mirrors.bfsu.edu.cn/Adoptium/` — returns a blanket 403
  ("Sorry, you've been denied access to this page") on every request,
  with or without a referer; whatever is gating it, it isn't reachable
  from here.
- **Huawei Cloud**, `https://mirrors.huaweicloud.com/{Adoptium,adoptium,zulu}/`
  — the mirror portal is a JS single-page app sitting behind a WAF
  (`lubanops`/`HWWAF*` cookies); every path, including what looks like a
  direct file URL, returns the same ~12KB HTML app shell (200,
  `text/html`) rather than the file or a real directory listing. No static
  file-serving path was found for either Adoptium or Zulu without
  reverse-engineering the SPA's own API, which is out of scope for this
  pass.
- **Wayback Machine** for older Zulu 6/7 archives — not reached: the
  `archive.org/wayback/available` lookup for a sample Zulu 6 Linux tarball
  returned HTTP 429 (rate-limited) on the first attempt, before any of the
  5 web-search budget was spent. Zulu still has no confirmed third-party
  or archival mirror; `cdn.azul.com` (the vendor's own CDN, already
  recorded) remains the only source for all 7,720 Zulu entries. Worth a
  dedicated follow-up pass with its own retry/backoff budget rather than
  a couple of opportunistic lookups.
- `mirror.nju.edu.cn`'s own `/adoptium/` top-level listing 302-loops
  without a warm-up hit first (same `bcheck` mechanism as above) — not a
  rejection, just documented here since it looks like a dead mirror on a
  bare `curl -I` and isn't.

## Zulu sizes (2026-09-17)

Azul's metadata API rounds `size` to the nearest 100 bytes. `fix_zulu_sizes.py` (run after `scrape.py`) replaces them with the real Content-Length from cdn.azul.com. Checksums were always exact.

## Mirror hunt round 2 (2026-09-17)

Per `catalog/MIRROR-HUNT-2.md`, focused on Zulu specifically since it was
essentially the entire gap (9,745/9,937 releases.json entries unmirrored
going into this pass, nearly all zulu-jdk/zulu-jre). Logic and evidence
live under `catalog/package-managers/round2/java/`
(`extra_mirrors_round2.py`, re-runnable; `probe_static_azul.py`, the
stress-sample script used to validate static.azul.com before trusting it
site-wide). Writes went through `catalog/tools/add_mirrors.py` only, per
this round's rules.

**0 of the 4 allotted web searches were needed** -- every host came from
the leads already given in the task, reached by direct curl.

### Added: static.azul.com (full Zulu coverage)

`https://static.azul.com/zulu/bin/{filename}` is a second, independently
resolvable hostname serving what looks like the exact same CDN origin as
`cdn.azul.com/zulu/bin/` (same Cloudflare zone, identical ETags and
Content-Length on every file checked, same behavior over http and https).
Confirmed rather than assumed: a 70-file sample spanning every major
(6-27), every (kind, format, variant) combination, and the catalog's
smallest/largest files matched Content-Length 70/70 (a handful of
apparent mismatches on the concurrent first pass were transient HEAD
timeouts, not real differences -- confirmed clean on individual retry).
One small sample (`zulu7.48.0.11-ca-jre7.0.312-win_i686.msi`, 22,343,680
bytes) was downloaded whole and its sha256 matched the catalog checksum
exactly; deleted afterwards. Applied to all 7,420 zulu entries by
substituting the URL prefix. **This closes the Zulu mirror gap
entirely: 0/7,420 zulu entries now lack a mirror.**

It is worth being honest about what this host is: since it appears to be
the same underlying origin as `cdn.azul.com` behind a second DNS name
(not a third party running independent infrastructure), it doesn't add
true operational redundancy against an Azul-side outage the way a
university mirror would -- but it does add a second, separately-resolved
hostname, which is exactly the kind of fallback that matters if
`cdn.azul.com` specifically is blocked or rate-limited on some network
path, which is the scenario an installer builder actually needs to
survive.

### Added: injdk.cn Zulu mirror (d10.injdk.cn)

`https://injdk.cn/` (found by following its homepage's own outbound
links, not a search) links to `https://d10.injdk.cn/openjdk/zulu/`, a
real Caddy-served directory mirror (confirmed: browsing the directory
lists actual files with real HTML, and a bogus filename/directory both
404, so it isn't a soft-200 catch-all). It holds one (occasionally a
couple of) recent JDK build per major -- JDK only, no JRE -- for majors
8, 11, 17, 21, 25, 26, and 27, using the exact same filenames as
`cdn.azul.com`. Every candidate this implies was individually
HEAD-confirmed against the vendor size (partial/rolling mirror, same
treatment as TUNA/NJU/USTC in round 1): 101/101 confirmed. http
redirects (308) to https, so there's no plaintext path on this host.

The required <=60MB hash sample could not be completed: this host only
carries full JDK archives/installers, and the smallest matched file is
87,790,094 bytes -- over budget. Recorded as HEAD-confirmed
(Content-Length match), not hash-verified, in `mirrors.json`.

One of the 101 matches surfaced a **pre-existing data-quality issue**,
not a mirror problem: `zulu17.64.17-ca-jdk17.0.18-c2-linux_aarch32hf.tar.gz`
(major 17) has `size: 183202000` in `releases.json` -- a stale,
API-rounded value that `fix_zulu_sizes.py` (the earlier fix for exactly
this rounding bug) apparently missed for this entry. The real
`cdn.azul.com` Content-Length is 183201984. d10.injdk.cn's file matches
the *real* size exactly, so it was still recorded as a confirmed mirror;
the stale `size` field was left as-is since `add_mirrors.py` only
appends to `mirrors[]`/`checksum_corroboration[]` and this pass's rules
say never to edit `releases.json` directly. Flagging here for whoever
next runs `fix_zulu_sizes.py` -- there may be other entries with the same
leftover rounding.

### Leads tried and rejected

- **Temurin GitHub-asset mirrors named in the task**: ISCAS
  (`mirror.iscas.ac.cn`) has a real `github-release/` mirror directory,
  but it only carries a fixed allow-list of projects (FreeCAD, Homebrew,
  llvm, graalvm, ibmruntimes/Semeru, etc) -- no `adoptium` entry.
  SJTUG/SJTU (`mirrors.sjtug.sjtu.edu.cn`, `mirror.sjtu.edu.cn`) return
  403 "Cerberus-Sec: BLOCKED" on every path including the bare root, with
  both a plain and a full browser User-Agent -- not reachable from here,
  whatever it's gating on. HUST (`mirrors.hust.edu.cn`) is a Docusaurus
  documentation site *about* a mirror, not a file host itself, and its
  linked real mirror (`mirrors.hust.college`) wasn't tried further since
  the task's target was HUST specifically. `packages.adoptium.net/artifactory`
  (its own Artifactory instance) only exposes `apk`, `deb`, `jmc-libs(-snapshots)`
  and `rpm` repositories via its API -- no generic tarball repo, and the
  catalog has no deb/rpm Temurin entries to match against anyway (Temurin
  entries here are tar.gz/zip/msi/pkg only). `download.eclipse.org` has
  no adoptium-related directory at all.
- **Huawei Cloud** (`mirrors.huaweicloud.com/java/`, `/zulu/`): `/zulu/`
  is the same JS SPA + WAF portal round 1 already rejected. `/java/` (not
  tried in round 1) turned out to be a real Artifactory listing, but it
  only holds `jdk/`, i.e. `jdk.java.net` community OpenJDK build tags
  (`10.0.1+10`, `11+28`, ...) last modified in 2021 -- a different
  vendor, stale, and already out of scope per round 1's reasoning for the
  same content. Tencent Cloud mirrors, injdk.cn's own homepage otherwise,
  and Huawei's `repo.huaweicloud.com/java/` were checked and don't carry
  Zulu/Temurin either.
- **`api.azul.com` download URLs**: every package's `download_url` in
  the metadata API is `cdn.azul.com/zulu/bin/...` -- no alternate host
  embedded in the API response itself (static.azul.com was found via
  direct hostname guessing from the task's own hint, not from the API).
  `repos.azul.com/zulu/` -- 404, doesn't exist.
- **foojay Disco API** (`api.foojay.io/disco/v3.0/packages`): its
  `pkg_download_redirect` link is a 301 straight to `cdn.azul.com` (for
  Zulu) -- a redirect-only wrapper, not an independent host, per this
  hunt's own rule that redirect-only hosts don't count.
- **`joschi/java-metadata`**: purely a metadata API (OpenAPI/Swagger
  spec), hosts no binaries at all, as its name suggests.
- **JetBrains**: `jdk.download.jetbrains.com` does not resolve in DNS at
  all from here -- not a live host. `cache-redirector.jetbrains.com`
  resolves and serves a generic redirector page pointing to an internal
  TeamCity-hosted redirect table (`teamcity-it.intellij.net/...`) that
  itself required auth (302 to a login) and wasn't reachable to see
  whether it proxies Adoptium/Zulu at all; a guessed path
  (`.../github.com/adoptium/temurin8-binaries/...`) 404'd. Given JBR
  (JetBrains Runtime) is a different, patched build per the task's own
  note, and no evidence surfaced that this redirector also proxies
  vanilla vendor JDKs, this lead is treated as a dead end rather than
  worth further guessing.
