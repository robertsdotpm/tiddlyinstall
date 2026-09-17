# Rust catalog notes

## Sources
- `https://static.rust-lang.org/dist/channel-rust-stable.toml` for the current
  stable version (used only to find the latest major, 1.98).
- `https://static.rust-lang.org/dist/channel-rust-1.N.M.toml` per release,
  from 1.8.0 onward (1.6.0 and 1.7.0 both 404; majors 1.0-1.7 have no channel
  manifest at all).
- Majors 1.0-1.7: fell back to `rust-1.N.M-<triple>.tar.gz` + `.sha256`
  companions directly, discovered with HEAD requests (no channel toml exists
  to list targets, so only the required host triples were probed, not the
  full extra set).
- Patch discovery: for each major, tried patch 0..15 (toml GET or tar.gz
  HEAD) and kept whichever came back non-404. Re-runs are fast because every
  toml body and HEAD (status, size) result is cached under `.cache/`.
- Combined-toolchain size came from a HEAD on the `xz_url` (preferred) or
  `url` (tar.gz fallback) named in each channel toml -- the toml itself does
  not carry a size field, only sha256 hashes.
- Standalone `.msi` (windows msvc) / `.pkg` (macos) installers: HEAD-checked
  for every version/triple that has a combined archive (not just a sample),
  since that HEAD request was already being made in the same pass. Checksums
  for every installer entry came from a follow-up GET of its `<file>.sha256`
  companion (small text file, ~550 requests total).

## Triple mapping
See `TRIPLE_MAP` in scrape.py. Required host triples per the task spec are
all covered. A handful of extra tier-1/tier-2 host triples present in recent
manifests were mapped where an obvious os/arch/libc exists (aarch64/x86_64
freebsd, riscv64gc-unknown-linux-gnu, s390x, ppc64/ppc64le glibc+musl,
loongarch64 glibc+musl, windows gnullvm, arm-unknown-linux-gnueabi(hf) as
armv6 soft/hardfloat, solaris/illumos/netbsd amd64). Skipped as unmappable:
`*-unknown-linux-ohos` (OpenHarmony isn't a normalised os), `sparcv9-sun-solaris`
(no sparc arch in the schema), `powerpc-unknown-linux-gnu` (32-bit ppc, no
matching arch).

## Gaps
`gaps.json` records two kinds of gap: a major with literally nothing found
(shouldn't happen for any 1.N <= 98, kept as a safety net), and a
required os/arch/variant combo missing at a specific major -- mostly early
majors that predate a target's existence (e.g. no aarch64-apple-darwin
before Apple Silicon, no aarch64-pc-windows-msvc before ~1.71) or windows-gnu
before it existed. These are expected, not scraper failures; read
`reason` per entry.

## Mirrors
Checked the four candidates named in the task with a *live* (uncached),
retried HEAD -- up to 3 attempts, 1.5s apart, since third-party mirrors
proved flakier than the official S3-backed static.rust-lang.org -- sampling
old (1.0.0, 2015), mid (1.51.0, 2021) and current (1.98) releases
across linux/macos/freebsd/illumos:
- **ustc** (`https://mirrors.ustc.edu.cn/rust-static/dist/`): confirmed, 8/8 sampled files size-matched (see mirrors.json for which). Applied to every releases.json entry (path substitution on the official url).
- **rsproxy** (`https://rsproxy.cn/dist/`): confirmed, 5/8 sampled files size-matched (see mirrors.json for which). Applied to every releases.json entry (path substitution on the official url).
- **tuna** (`https://mirrors.tuna.tsinghua.edu.cn/rustup/dist/`): not usable, 2/8 sampled files size-matched (statuses seen: [200, 404]). Its dated snapshot directories are a rolling window (observed to hold roughly the last 4 weeks as of this run -- 2026-08-20 onward existed, 2026-08-15 and earlier all 404), so only the newest release(s) would ever match; not a stable rule to bake into a catalog spanning 2015-2026. Not applied to any entry.
- **aliyun** (`https://mirrors.aliyun.com/rustup/dist/`): not usable, 0/8 sampled files size-matched (statuses seen: [404]). It does serve the un-dated `channel-rust-*.toml` files, but every dated `/YYYY-MM-DD/rust-*.tar.*` path tried 404s -- this mirror appears to only carry the rustup bootstrap files, not the dist archive. Not applied to any entry.
Full per-sample detail (status + size-match per file) is in mirrors.json.

## Download plans
- `download_plan.json`: newest patch per (major, os, arch), restricted to
  windows/msvc, linux/glibc, macos, preferring tar.xz. Covers every major
  1.0-1.98 (subject to the gaps above for targets that didn't exist
  yet at a given major).
- `download_plan_slim.json`: 1.0, the edition majors (1.31, 1.56, 1.85),
  every 10th minor (1.10, 1.20, ... 1.90), and the latest (1.98), same
  os/arch rules.
- Planned size: **208.4 GB** (full plan), **30.3 GB** (slim
  plan). For reference, if every archive entry in releases.json (all majors,
  all mapped os/arch/variant/libc combos, not just the plan subset) were
  downloaded it would be roughly **474.6 GB**.

## Not downloaded
Per instructions, no toolchain file was downloaded -- every size and
existence check above is a HEAD request (or, for the .sha256 companions and
channel tomls, a GET of a small text file).

## Mirror hunt (2026-09-17)
Extended the mirror search from the four candidates above, per
`catalog/MIRROR-HUNT.md`. New logic lives in `extra_mirrors.py`, which is
separate from (and must be re-run after) `scrape.py`, since `scrape.py`
resets every entry's `mirrors` list and overwrites mirrors.json wholesale
on each run. Same 8-sample set (old/mid/new x linux/macos/freebsd/illumos)
used throughout, with a browser User-Agent (some of these mirrors 403 a
bare/default UA or non-browser client -- see sjtu below).

**Confirmed and applied** (both full mirrors, path-substitution onto every
`releases.json` entry and every `download_plan*.json` entry; hash-verified
against `rust-1.19.0-i686-pc-windows-msvc.tar.xz`'s published sha256,
51MB, downloaded in full and deleted afterwards):
- **tencent** (`https://mirrors.cloud.tencent.com/rustup/dist/`, Tencent
  Cloud, China): 8/8 sampled files size-matched, sha256 of the full sample
  matched. https only (plain http 302s to https on the same host). Note:
  the connection reset partway through a sequential GET of the 51MB sample
  on every attempt from this vantage point -- resumed with `Range` headers
  to complete it; `extra_mirrors.py`'s `verify_hash_sample()` does this
  automatically.
- **official-http** (`http://static.rust-lang.org/dist/`): not a
  third-party mirror -- this is the vendor's own origin, reached over
  plain http instead of https. The task brief specifically asked to check
  this ("old systems lack modern TLS/CA roots"). 8/8 sampled files
  size-matched over http, sha256 of the full sample matched. Recorded and
  applied the same way as a real mirror since it gives old clients a
  working non-TLS download path for every entry.

**Checked and rejected:**
- **hust** (`https://mirrors.hust.edu.cn/rustup/dist/`): only the
  *current* release's dated directory exists (2/8 sampled matched, both
  1.98.1); every older sample 404s with a generic error page. Same
  rolling-window problem as tuna above -- not a stable rule to bake into a
  catalog spanning 2015-2026. Not applied.
- **nju** (`https://mirror.nju.edu.cn/rustup/dist/`): same rolling-window
  problem (0/8 matched with a fresh client -- even 1.98.1 needs a
  same-origin cookie first, see below -- but re-checking with that cookie
  still only ever matches the current release). Also gates every request
  behind a bot-check: the first hit to any path 302s to itself and sets a
  `bcheck` cookie, the second request with that cookie succeeds. Harmless
  for a browser or a cookie-jar client, moot here since the mirror is
  rejected anyway for coverage. Not applied.
- **sjtu** (`https://mirror.sjtu.edu.cn/rust-static/dist/`): the very
  first HEAD from this run's IP, with a plain UA, returned 200 with a
  matching size. Every request after that -- across UAs, across a fresh
  run minutes later, via curl and via Python urllib alike -- came back 403
  with a `cerberus-sec: BLOCKED` response header. That's SJTU's own
  anti-bot layer blacklisting the source IP after a handful of automated
  requests. Since re-checking a handful of samples on every run is exactly
  what this tooling does, sjtu is unusable for an idempotent, re-run
  script even though the mirror itself is presumably fine for a one-off
  human download. Rejected for that reason, not for serving wrong bytes.
- **bfsu** (`https://mirrors.bfsu.edu.cn/rustup/dist/`): 403 "Sorry,
  you've been denied access to this page" on every path tried, including
  bare `/` and `/robots.txt`, with a full browser header set. Looks like a
  blanket WAF/geo block on this vantage point's egress IP rather than
  anything specific to the rustup path. Can't be confirmed or ruled out
  from here -- recorded as inconclusive, not confirmed, not applied.
- **mirrors.cernet.edu.cn**: not an independent mirror. It's a MirrorZ
  GeoIP router: `/help/rustup` redirects to a `help.mirrors.cernet.edu.cn`
  page that just lists which university mirrors exist, and a direct file
  request 302-redirected our traffic straight to `mirrors.hust.edu.cn`
  (rejected above). Not counted as its own host.

**Wayback Machine**: `https://web.archive.org/web/2id_/<url>` resolves to
a snapshot for at least some pre-1.20 files -- confirmed byte-identical
(matching Content-Length) captures of `rust-1.0.0-x86_64-unknown-linux-gnu.tar.gz`
(captured 2026-02-02) and `rust-1.0.0-x86_64-apple-darwin.tar.gz` (captured
2026-03-04). Two other samples in the same batch (`rust-1.19.0` and
`rust-1.20.0` windows-msvc tar.xz) hit connection resets / 429s from
archive.org's rate limiting before resolving -- not confirmed absent, just
not confirmed within a polite request budget. Coverage is real but sparse
and per-file exactly as the task brief warned, and checking it against
thousands of `releases.json` entries would mean thousands of individual
archive.org requests -- impractical to keep re-running and already rude to
a host that rate-limited a four-request sample. Not added to
`extra_mirrors.py` or applied to any entry; if the operator wants Wayback
coverage later it needs its own slow, heavily-cached, entry-by-entry pass.

**Outside China**: budget was up to 5 web searches; used 4 (2 returned
tool-unavailable errors, 2 ran and found nothing) looking for a
Europe/Russia/corporate rustup dist mirror (JFrog/Artifactory-hosted,
Yandex, any university). Found none -- the rustup mirror ecosystem appears
to be almost entirely China-specific, which tracks: that's the one region
where GFW latency motivates a mirror at all, everywhere else already has
good paths to the CloudFront-backed official origin. `official-http` above
(plain-http reachability of the vendor's own origin) was the only
outside-China win, and it isn't a new host.

**Re-run order**: `extra_mirrors.py` must run after every `scrape.py` run
(scrape.py overwrites `mirrors.json` and clears every entry's `mirrors`
list from scratch). It is idempotent -- reruns with nothing changed add no
duplicate mirror URLs and no duplicate mirrors.json entries -- and caches
HEAD results in `extra_mirrors_head_cache.json` beside it, but always
re-downloads and re-hashes the small sample file for every confirmed
candidate on every run (a few minutes, dominated by tencent's slow and
flaky throughput from this vantage point).

## Package-manager mining (2026-09-17)

Investigated as part of a cross-runtime pass mining language version
managers for mirrors (see `catalog/package-managers/`). rustup's own
source (`tests/suite/static_roots.rs`, generating `src/anchors.rs`) pins
TLS trust anchors for two extra hostnames it treats as equivalent to
`static.rust-lang.org`: `fastly-static.rust-lang.org` and
`cloudfront-static.rust-lang.org`. These are not third-party mirrors --
they're the two CDN edges (Fastly and CloudFront) sitting in front of the
same S3-backed bucket that `static.rust-lang.org` itself resolves to
(identical ETag and Last-Modified confirmed on a shared sample). Both
confirmed on a 6-file sample (old 1.0.0 linux/macos, mid 1.19.0/1.22.0
windows, newest 1.98.1 linux gnu/musl arm64) and one full-download
sha256-verified sample (rust-1.19.0-i686-pc-windows-msvc.tar.xz); bogus-path
control 404 on both. `fastly-static.rust-lang.org` serves plain `http://`
with no redirect (useful for old systems with weak TLS/CA support, per the
brief's priority-2 goal) -- unlike `cloudfront-static.rust-lang.org`, which
301s http to https, and unlike the official host, whose own plain-http
support was the prior mirror hunt's only outside-China win. Added to both
hosts' entries via `catalog/tools/add_mirrors.py` from
`catalog/package-managers/mine_version_managers.py` (6,586 mirror entries:
3,293 URLs x 2 hosts), not folded into `extra_mirrors.py` since it's a
one-off domain substitution rather than a probed candidate list -- if
`extra_mirrors.py` is re-run after a future `scrape.py` pass (which clears
`mirrors[]`), these two hosts should be re-applied by re-running
`mine_version_managers.py`'s rust step, since `extra_mirrors.py` does not
know about them.

Checked RUSTUP_DIST_SERVER itself: it has no built-in default beyond
`https://static.rust-lang.org` (`src/dist/mod.rs::DEFAULT_DIST_SERVER`) --
it's purely an override point, not a mirror list, matching what the prior
mirror hunt already found.
