# Ruby runtime catalog notes

## Sources

- `https://cache.ruby-lang.org/pub/ruby/index.txt` -- ruby-lang.org's own
  flat index of every file under `pub/ruby/` (name, url, sha1, sha256,
  sha512, tab-separated). Task-mandated primary source for source-tarball
  release entries: one entry per stable version, `os: linux`, `arch: any`,
  `kind: source` (source builds and runs on any Unix-like OS, not just
  Linux -- noted in each entry's `notes` field).
- `https://raw.githubusercontent.com/ruby/www.ruby-lang.org/master/_data/releases.yml`
  -- the data file that drives ruby-lang.org's own downloads page.
  index.txt has no `date` or `size` column, so this file is used to
  backfill both by **exact URL match** (its `url:`/`size:` blocks list
  the same cache.ruby-lang.org URLs index.txt does) -- confirmed by spot
  checks (e.g. `ruby-3.3.5.tar.xz`, `ruby-1.9.3-p0.tar.gz` match
  byte-for-byte). It also gives a `{version: date}` map used to backfill
  `released` on RubyInstaller/ruby-builder entries (see "Release dates"
  below). Parsed with a small line-scanning regex, not a YAML library,
  to stay stdlib-only -- the file's indentation is completely uniform
  so this is reliable (spot-checked against `grep` output).
- `gh api repos/oneclick/rubyinstaller2/releases --paginate` -- Ruby
  2.4.0 onward, Windows. 7z archives and exe installers (plain and
  `-devkit-`, which bundles MSYS2 + a compiler toolchain), x86/x64, plus
  arm (== Windows on ARM64, see below) from Ruby 3.4.1-2 onward. Ruby
  4.0 dropped x86 (32-bit Windows) entirely.
- `gh api repos/oneclick/rubyinstaller/releases --paginate` -- Ruby
  1.8.7 through 2.3.3, Windows (RubyInstaller 1, predates
  RubyInstaller2). `https://rubyinstaller.org/downloads/archives/` was
  also fetched and cross-checked: every RubyInstaller1-era link on that
  page either points at this same GitHub repo or at `dl.bintray.com`
  (Bintray shut down in 2021 and 404s everywhere), so GitHub Releases is
  the only live source for these files.
- `gh api repos/ruby/ruby-builder --paginate` -- prebuilt "toolcache"
  tarballs for Linux and macOS, as used by the `ruby/setup-ruby` GitHub
  Action. **Not published by ruby-lang.org** -- ruby-lang.org has never
  shipped official Linux or macOS binaries, source tarball only (see
  Gaps). The repo also publishes jruby-\* and truffleruby(+graalvm)-\*
  tags; only `ruby-<version>` tags were kept (232 total release tags,
  111 are `ruby-*`, the rest skipped and counted in the scrape.py log).
- HEAD requests (≤10 concurrent, browser-like UA): only used for the
  handful of source entries where neither index.txt nor releases.yml
  gave a size (very old/oddly-dated pre-releases). No runtime file was
  ever downloaded in full by `scrape.py`.

## Scope: majors before 1.8 excluded

Per the catalog's major list ("1.8, 1.9, 2.0 ... 3.4, and 4.0"),
versions 0.49 through 1.7.3 (Ruby's entire pre-1.8 history --
irregular pre-1.0 snapshot releases, 1.1's alphabetic pre-release
scheme, etc.) are not enumerated in releases.json even though
cache.ruby-lang.org still serves their source tarballs. They predate
RubyInstaller and any binary distribution by years, so there would be
nothing to gap-check on Windows/Linux/macOS either. Not treated as a
gap (nothing plausible was missed) -- just out of scope, noted here.

## Stability filtering

Both index.txt and releases.yml list Ruby's actual prereleases
(`-preview\d`, `-rc\d`, `-dev`, `-alpha`, `-beta`) mixed in with stable
tags -- 220 preview/rc entries were excluded from the source list by a
regex on the version string. `1.9.0-0` (the only version literally
named `1.9.0` in the archives) is unusual -- historically a rougher
release than most 1.9 dot-zeros -- but is not marked preview/rc/dev in
either official source, so it's kept as-is; ruby-lang.org itself lists
it as a normal release.

## Release dates

`released` is backfilled from releases.yml's `{version: date}` map,
**not** from each repo's GitHub `published_at`, because that can be
wrong by years: every RubyInstaller1 tag for versions actually released
2003-2016 shows `published_at` in 2021-04/05 (a bulk import into
GitHub) or 2021-05 for a couple of stragglers, and RubyInstaller2/
ruby-builder tags can lag their underlying Ruby version's real release
by a few days. Where a version has no releases.yml entry (rare -- a
handful of very old dated pre-1.9 snapshots), `released` falls back to
the repo's own `published_at`, and ultimately to `null` per schema.
One imprecision worth flagging: RubyInstaller2 sometimes ships several
build revisions of the *same* Ruby version (e.g. `2.4.0-1` through
`2.4.0-8`, all Ruby 2.4.0) -- all revisions share Ruby 2.4.0's release
date, not their own (later) installer-build date, since releases.yml
only knows about Ruby versions, not installer build numbers.

## Checksums

- Source tarballs: sha256 from index.txt, always present for the
  versions in scope.
- ruby-builder: 628/628 entries have a GitHub asset `digest` (sha256).
- RubyInstaller2: only 144/677 entries have a checksum. GitHub started
  populating the asset `digest` field retroactively at some point
  between 2025-07-24 and the next release after it (`3.4.5-1` is the
  first stable tag where every asset has one; nothing published before
  that does, confirmed by scanning every release in publish order).
  RubyInstaller2 publishes GPG `.asc` signatures instead of hash sums,
  and no checksums appear in any release body, so per schema
  ("checksum: null if the vendor publishes none") nothing was invented
  for the pre-2025-07-24 releases.
- RubyInstaller1: only 20/172 entries have a checksum -- exactly the 5
  releases (of 63) that ship a `.md5` sidecar file (`ruby-2.1.9`,
  `ruby-2.2.6`, `ruby-2.3.0`, `ruby-2.3.1`, `ruby-2.3.3`). Each sidecar
  is a few bytes of text (`<hex> *<filename>`) fetched individually --
  not a runtime file. `algo: "md5"` per schema's allowed algo list.

## Windows ARM

RubyInstaller2 asset filenames use `-arm-` (e.g.
`rubyinstaller-3.4.10-1-arm.7z`), first appearing in `3.4.1-2`
(2025-01-18) and every RubyInstaller2 stable release since. This is
**64-bit Windows on ARM** (Ruby's own release notes and the
RubyInstaller2 repo both describe 3.4's new platform as "Windows
ARM64"), not 32-bit ARM/armv7 -- confirmed by file size (comparable to
the x64 build, an order of magnitude larger than any 32-bit ARM Ruby
build would be) and mapped to the catalog's `arm64`, with a `notes`
field on every such entry flagging the filename/arch mismatch so a
human doesn't misread it as 32-bit.

## Ruby 4.0 dropped 32-bit Windows

`RubyInstaller-4.0.0-1` (2025-12-27) onward ships no `x86` asset --
only `x64` and `arm`. Not a gap (amd64/arm64 are both covered for 4.0);
noted here since it's a real capability change a developer would hit.

## download_plan.json

100 entries, 4.5 GB total. Rules applied:
- Source (`os: linux, arch: any, kind: source`) is only planned for
  majors 1.8, 1.9 and 2.0, where no linux/macos binary exists at all
  (`majors_with_posix_binary` in scrape.py) -- per the brief, "don't
  plan source unless no binary exists for that major on linux/macos".
  2.1 onward has a real ruby-builder linux+macos binary, so no source
  entry is planned for those majors even though the tarball exists in
  releases.json.
- Linux/macOS: one ubuntu variant (newest LTS available for that
  major/arch: 26.04 > 24.04 > 22.04 > ...) per arch, one darwin variant
  per arch.
- Windows: newest patch per (major, arch, variant) where `variant`
  ("devkit" vs `null`) is treated as a real fork, not an alternate
  format -- a devkit installer bundles a compiler toolchain and is a
  meaningfully different artifact from the plain installer/archive, so
  both get their own plan entry. Within a variant, an archive (`.7z`)
  is preferred over an installer (`.exe`) per schema; devkit only ships
  as an installer, so that group's sole candidate is the exe.
- The version-tuple comparison used to pick "newest" parses **up to 4**
  numeric groups, not 3: Ruby's old `X.Y.Z-pNNN` scheme
  (`1.8.7-p22` vs `1.8.7-p374`) puts the real patch level *after* the
  third dotted component, so a naive 3-tuple would treat every
  `1.8.7-p*` as tied and could silently pick an arbitrary (much older)
  one. Caught by inspecting an early draft's plan, which had picked
  `1.9.3-p125` over the far newer `1.9.3-p551`.

## Gaps

Per SCHEMA.md's own PHP example ("php.net publishes no official Linux
binaries; source only" is *still* a recorded gap even though source
exists), a source tarball existing for a major does **not** suppress
its linux/macos gap entry -- a gap here means "no prebuilt binary",
which is what a developer choosing a runtime actually needs to know.
6 gaps recorded: majors 1.8, 1.9 and 2.0, each for both `linux` and
`macos` (ruby-builder's oldest tag is `ruby-2.1.9`; nothing precedes
it). No Windows gaps -- RubyInstaller1/2 between them cover every
major 1.8 through 4.0. No gaps recorded for majors 2.1+ on any OS.

## Mirror hunt (2026-09-17)

Followed MIRROR-HUNT.md. Started from the official
`https://www.ruby-lang.org/en/downloads/mirrors/` list (fetched
directly, not searched) plus the brief's named leads. Logic lives in
`extra_mirrors.py` (re-runnable, idempotent, caches HEAD/verification
results in `extra_mirrors_cache.json`) -- **run it again after every
`scrape.py` run**, since `scrape.py` rebuilds `releases.json` and every
`download_plan*.json`'s `mirrors` arrays from scratch with none
confirmed (its own `mirrors.json` output says so explicitly).

**Confirmed and added** (full detail, including per-file sample
results, in `mirrors.json`):

- `mirror.cyberbits.eu/ruby/` (France/Europe) -- full mirror of the
  source tree, https and http both work. Only independent (non-China)
  mirror found with a working modern TLS setup.
- `ftp.iij.ad.jp/pub/lang/ruby/` (Japan, IIJ) -- full mirror, https and
  http both work.
- `www.ring.gr.jp/pub/lang/ruby/` (Japan, RING Server Project) -- full
  mirror over http; https to this specific hostname times out (the
  `ftp.ring.gr.jp` name from ruby-lang.org's own list has the same
  problem -- `www.ring.gr.jp` plain http is the form that actually
  works).
- `ftp.fu-berlin.de/unix/languages/ruby/` (Germany/Europe) -- a
  **partial** mirror frozen around the 2.6 era (its own directory
  listing runs 1.0/ through 2.6/, nothing newer). HEAD-checked
  individually against all 237 source entries rather than blanket
  applied: 142/237 matched (majors 1.8 through partway into 2.6) and
  were added; the rest were not. This is the one mirror that actually
  helps the catalog's own linux/macos gap majors (1.8, 1.9, 2.0).
- `mirrors.nju.edu.cn` github-release proxy for `oneclick/rubyinstaller2`
  -- exists, but only keeps the single newest release
  (`RubyInstaller-4.0.7-1`, a `LatestRelease/` symlink plus one dated
  folder), not history. Applied only to that release's 6 non-.asc,
  non-x86 Windows assets. Notable quirk: this proxy answers every
  request with a `302` + `Set-Cookie: bcheck=true` back to the *same*
  URL first, and only a second request carrying that cookie gets the
  real file or a real 404 -- a bare `curl -I` (or any client without a
  cookie jar) will see it as permanently broken and wrongly conclude
  it's not mirrored at all.

Every "confirmed" mirror above was also verified by downloading one
full sample file and checking its hash: `ruby-1.8.7-p374.tar.gz`
(4.9 MB) against the source checksum for the four source-tree mirrors,
and `rubyinstaller-4.0.7-1-x64.7z` (16.9 MB) against the GitHub-digest
checksum for NJU. All five matched; all samples deleted afterward.

**Rejected** (detail and evidence in `mirrors.json`):

- `cache.ruby-china.com` -- dead, not just slow: expired TLS
  certificate, and even bypassing that (`-k`) or using plain http, the
  server answers every request with `405` / `{"code":"40510001",
  "msg":"invisible bucket"}`. The backing storage bucket looks to have
  been made private or removed.
- `ftp.ntua.gr` -- frozen even earlier than fu-berlin (tops out at
  2.0/) and inconsistent even within that range (one sampled 1.9 file
  404'd); superseded by fu-berlin's strictly larger, cleaner range.
- `ftp.kr.freebsd.org` -- 404 on the bare `/pub/ruby/` root; the path
  from ruby-lang.org's own mirror list no longer resolves to anything
  here.
- `mirrors.tuna.tsinghua.edu.cn/github-release/...` -- explicit
  access-denied page for this environment's egress IP; inconclusive,
  not treated as evidence the mirror doesn't exist, left unconfirmed.
- `mirrors.ustc.edu.cn/github-release/...` -- plain 404, not mirrored
  at this path.
- `mirrors.nju.edu.cn/github-release/ruby/` (for `ruby-builder`) -- no
  `ruby/` owner exists in NJU's github-release listing at all (only
  `oneclick/` does); ruby-builder's Linux/macOS assets have no mirror
  anywhere that was found.

**Wayback Machine**: not checked. The brief scopes this to "old
RubyInstaller 1 builds" specifically, but every RubyInstaller1 file is
still served live, at full speed, directly from GitHub Releases (the
same origin releases.json already points at) -- a Wayback capture of a
GitHub Releases URL would just be an archived copy of GitHub, not an
independent second source, so it adds no real redundancy here. Revisit
only if GitHub Releases itself ever becomes the bottleneck.

**Coverage**: before this hunt, every entry had 0 mirrors (scrape.py's
own baseline). After: 243/1714 releases.json entries (14.2%) and
7/100 download_plan.json entries (7%) have >=1 mirror -- essentially
all of it the 237 source-tarball entries (233 of which are mirrored by
at least the three full mirrors, minus a few where even
cache.ruby-lang.org's own index lacked a usable url) plus the 6
NJU-mirrored Windows 4.0.7 assets. RubyInstaller (both generations,
849 entries) and ruby-builder (810 Linux+macOS entries) remain
essentially unmirrored outside that one narrow NJU exception --
GitHub Releases is the only real distribution point for Ruby's Windows
and Linux/macOS binaries.

**Budget**: 0 of the 5 permitted web searches used -- every lead was
either given directly in the brief or reached by fetching a known page
(ruby-lang.org's own mirrors list, mirror root listings) rather than
searching. No runtime file over 60 MB was downloaded; the five hash-
verification samples (four source tarballs at ~4.9-16.4 MB, one 7z
archive at ~16.9 MB) were all deleted immediately after verification.


## Mirror hunt round 2 (2026-09-17)

Followed MIRROR-HUNT-2.md, targeting round 1's stated gap: RubyInstaller
(both generations) and ruby/ruby-builder binaries, essentially unmirrored
outside the one narrow NJU exception. Tested every lead in the brief.
Script and evidence: `catalog/package-managers/round2/ruby/mine_chocolatey.py`
(the one lead that produced a usable result -- see below); everything else
was checked by hand with curl (a browser UA, HEAD/redirect-disabled where it
mattered) and is recorded here since it didn't produce a re-runnable script.

**No new `mirrors` entries** -- every lead for the RubyInstaller/ruby-builder
binary gap was either dead, out of scope (different build, not the vendor's
file), or blocked in a way this environment can't get past. Mirror coverage
is unchanged from round 1: 243/1714 releases.json entries (14.2%),
5/28 download_plan_majors.json entries (17.9%).

**New: 20 `checksum_corroboration` entries** from Chocolatey's `ruby.install`
package, added via `add_mirrors.py` -- see "Chocolatey" below. 14 of the 20
were on previously null-checksum RubyInstaller2 entries; 0 mismatches.

- **rubyinstaller.cn** (`RubyMetric/RubyInstaller.cn` on GitHub) -- alive,
  a Chinese-language mirror of rubyinstaller.org's own content (changelogs,
  docs), explicitly "powered by" Shanghai Jiao Tong University's mirror
  service per its own announcement post
  (ruby-china.org/topics/40842: "rubyinstaller.cn 正式运行，感谢上海交通大学镜像服务").
  It does not host files itself -- every download link on it points straight
  at `mirror.sjtu.edu.cn` / `mirrors.sjtug.sjtu.edu.cn`'s github-release
  proxy for `oneclick/rubyinstaller2`. Not a mirror in its own right, but it
  confirmed SJTU carries this repo (a lead the brief only asked to check by
  guessing tsinghua/nju/etc.).
- **SJTU github-release proxy** (`mirror.sjtu.edu.cn` and
  `mirrors.sjtug.sjtu.edu.cn/github-release/oneclick/rubyinstaller2/...`) --
  real, and (unlike NJU's proxy from round 1) looks like it carries full
  history, not just the latest release. **Could not confirm**: both hostnames
  gate every request -- including a direct file HEAD, not just directory
  listings -- behind SJTUG's "Cerberus" bot-check
  (github.com/SJTUG/cerberus, a WASM proof-of-work challenge, not a simple
  cookie echo like NJU's `bcheck`). `mirror.sjtu.edu.cn` returns a flat 403
  "BLOCKED"; `mirrors.sjtug.sjtu.edu.cn` returns 200 with
  `cerberus-sec: CHALLENGE` and an HTML challenge page instead of the file,
  for every request including a fresh cookie jar. No JS/WASM execution is
  available in this environment to solve it, so this stays unconfirmed
  rather than added -- flagging in case a future pass has a real browser to
  throw at it, since the underlying mirror is plausibly the best remaining
  lead for RubyInstaller2 history.
- **ISCAS** (`mirror.iscas.ac.cn/github-release/`), **HUST**
  (`mirrors.hust.edu.cn`), **NYIST** (`mirror.nyist.edu.cn`) -- checked for
  a `github-release/oneclick/` path per the brief's lead list. ISCAS's
  github-release listing exists but has no `oneclick/` (or `ruby/`) owner at
  all (listed orgs: balena-io, git-for-windows, Homebrew, kubernetes, llvm,
  PowerShell, VSCodium, etc. -- checked the full listing). HUST and NYIST
  404 on the exact path. Not mirrored anywhere on these three.
- **mirrors.bfsu.edu.cn** -- 403 on the same path (network-reputation block
  on this environment's egress, same shape as round 1's TUNA rejection; not
  investigated further).
- **Ruby China** (`ruby-china.org`) -- its own wiki
  (`ruby-china.org/wiki/ruby-mirror`) and general site only point at
  `cache.ruby-china.com`, already confirmed dead in round 1 (expired TLS
  cert, 405 "invisible bucket" underneath). `gems.ruby-china.com` (gems,
  out of scope anyway per the brief) doesn't resolve/connect at all.
  `index.ruby-china.com` (the RubyGems index mirror) is alive but is gems
  metadata, not installer/source binaries -- not applicable to this gap.
- **rubies.travis-ci.org** and **rvm.io/binaries/** -- both alive and
  actively maintained (travis-ci.org has Ruby up to 4.0.1, newer than this
  catalog's 4.0.7 ceiling only by a hair, including `ubuntu/22.04` and
  `ubuntu/24.04` directories that looked promising). **Rejected**: these are
  RVM's own independently-built rubies, not copies of `ruby/ruby-builder`'s
  GitHub release assets -- different filename (`ruby-3.3.5.tar.bz2` vs
  ruby-builder's `ruby-3.3.5-ubuntu-22.04-x64.tar.gz`), different
  compression (bz2 vs gz), and a different size for the one pair checked
  (travis-ci.org's ubuntu-22.04/x86_64/ruby-3.3.5.tar.bz2 is 36,273,464
  bytes against ruby-builder's ubuntu-22.04-x64 tarball at 37,393,816 bytes
  for the same Ruby version) -- confirms it's a separate build, not eligible
  as a mirror of the cataloged file under any renamed-file allowance.
- **`ruby/setup-ruby`** (the GitHub Action) -- read `windows.js`,
  `ruby-builder.js`, `common.js`, `index.js` from its `master` branch
  directly. No mirror env var, no fallback host, anywhere: `ruby-builder.js`
  hardcodes
  `` `https://github.com/ruby/${repo}/releases/latest/download/...` `` as
  the only download URL, and the Windows path downloads straight from a
  static per-version GitHub URL table with no alternate-host logic at all.
  Confirms round 1's ruby-build (`rbenv/ruby-build`) finding: none of
  Ruby's toolchain scripts have a mirror layer for the binary artifacts.
- **Chocolatey's `ruby.install` package** -- interesting structural finding:
  it does **not** download RubyInstaller2 at install time. The .nupkg itself
  **bundles** the exact upstream `.exe` (verified: `ruby.install 3.4.10.1`'s
  nupkg contains `rubyinstaller-3.4.10-1-x64.exe` at the same 20,525,048
  bytes and identical sha256 as this catalog's existing GitHub-digest
  checksum for that file). This is **not usable as a `mirrors` URL** --
  fetching `community.chocolatey.org/api/v2/package/ruby.install/<version>`
  returns a `.nupkg` zip archive, not the raw `.exe`, so it fails schema's
  "mirrors: only URLs confirmed to serve this file" bar (a consumer would
  need to unzip it first). It's a legitimate `checksum_corroboration`
  source instead, which the round-2 brief explicitly allows writing:
  mined 10 versions of `ruby.install` spanning 2.2.6 (RubyInstaller1) through
  3.4.4.1 (the newest version below RubyInstaller2's own 3.4.5-1 checksum
  cutoff), extracted and sha256'd the bundled x86+x64 `.exe`s from each
  nupkg, and matched them to releases.json entries by the exact filename
  embedded inside (not by guessing from the choco version string -- choco's
  4th version component isn't reliably the installer build number, e.g.
  choco version `2.4.10.100` bundles `rubyinstaller-2.4.10-1-x64.exe`, build
  "1" not "100"). Result: 20/20 matched a releases.json entry, 20/20 sha256
  computed cleanly, 0 mismatches (the two RubyInstaller1 2.2.6 files were
  cross-checked against their vendor *md5* by hashing the same bytes with
  md5 too, since corroboration is always recorded as sha256 regardless of
  the vendor's own algo). 14 of the 20 were on entries that had **no**
  vendor checksum before (RubyInstaller2 predates its 3.4.5-1 digest cutoff
  for those). Applied via `add_mirrors.py`; script is re-runnable
  (`--versions`/`--all`/`--apply`) and left as-is at
  `catalog/package-managers/round2/ruby/mine_chocolatey.py` for anyone
  wanting to mine the remaining ~29 unfetched `ruby.install` versions.
- **Wayback Machine**: could not check. archive.org's own CDX API returned
  "Internet Archive services are temporarily offline" (503s) for the entire
  window this hunt ran in -- consistent with `catalog/wayback-retry.log`'s
  own concurrent backoff entries (`backing off 32s (503)` etc.), so this
  isn't specific to the query. The brief asks specifically whether any
  mirror covers older RubyInstaller1 builds (1.8-2.3): unanswered this
  round for that reason, not because it was skipped. Every RubyInstaller1
  file is live on GitHub Releases today regardless (round 1's point that a
  Wayback capture of a GitHub Releases URL is not independent of GitHub
  still applies) -- the only way Wayback would add real redundancy here is
  if it captured the *pre-2021* original hosts (rubyforge.org / Google Code
  / the dead Bintray URLs) from before GitHub's 2021 bulk import, which
  would need a retry once archive.org is back.

**Budget**: 1 of 4 permitted web searches used (Ruby China wiki mirror
listing -- direct guesses at the URL 404'd). No runtime file over 60MB
downloaded for mirror confirmation (none were confirmed); ~400MB of
Chocolatey `.nupkg` files were fetched for checksum corroboration (10
files, ~35-45MB each, all deleted after hashing) -- a different budget line
item from mirror-confirmation samples, since no mirror was being confirmed.

## Real-app fidelity (installer-builder, 2026-09-19)

Checked with installer-builder's `tests/fidelity/ruby` (a Gemfile with bcrypt
and json, which both compile a C extension, plus openssl over HTTPS,
readline, fiddle, the standard library and the gem command).

- **Windows: RubyInstaller's DevKit.** The plain RubyInstaller `.7z` has no
  compiler, so `bundle install` failed for any gem with a C extension ("make
  failed... No such file or directory - make"). The new recipe (`install.json`,
  Windows x64 7z, `>=2.4`) is used for apps that install gems: the policy's
  extra file `msys2-base.sfx.exe` (MSYS2's base system, 2026-06-11, 50.4 MB,
  pinned by SHA-256, PGP signature checked) is unpacked into
  `{runtime_dir}\msys64`, where RubyInstaller looks for MSYS2 first; bash's
  first start sets up pacman's keyring; `pacman -Sy`; then `ridk install 3`
  (autotools, make, the UCRT gcc toolchain: 89.8 MiB downloaded, 583 MiB
  installed, packages signature-checked by pacman). pacman's download cache is
  emptied and gpg-agent stopped so the folder can be removed. MSYS2 needs
  Windows 8.1+; on 7 and Vista the step removes `msys64` and goes on, so
  pure-Ruby gems still install. The `devkit` installer `.exe` variant stays
  excluded: it only adds the MSYS2 base, needs its own uninstall entries
  removed, and is 141 MB against 17.7 + 50.4 MB here.
- **Linux (ruby-builder):** native gems need gcc (rbconfig's CC), the C
  library's headers and make: policy `needs` gcc and make, for apps that
  install something.
- **macOS: relocatable builds** (`portable_ruby.py`, variants `rv-ruby` and
  `homebrew-portable`, 86 releases; re-run it after `scrape.py`, which rewrites
  releases.json). ruby-builder's macOS tarballs stay excluded (they load
  Homebrew's OpenSSL, libyaml and gmp by absolute path). rv-ruby
  (spinel-coop/rv-ruby, BSD-2-Clause scripts; Ruby under its own licence)
  carries the whole standard library and bundled gems, OpenSSL/libyaml/libffi
  built in, and its own CA bundle; arm64 builds need macOS 14, x86_64 builds
  macOS 15 (read from the binaries; the asset is named "ventura"). Homebrew's
  portable Ruby 3.4.5 (the archived tap's last release with GitHub digests;
  newer ones are homebrew-core bottles on ghcr.io, which need a token) covers
  older Macs: x86_64 10.11+, arm64 11.3+, but Homebrew strips most bundled
  gems (csv, bigdecimal, minitest, rexml, net-smtp...), so apps list them in
  their Gemfile. Both link nothing outside /usr/lib and /System.
  Their rbconfig.rb has `EXTDLDFLAGS = -bundle_loader '$(BUILTRUBY)'`; in a
  folder with a space (the default `~/Library/Application Support/ib`) make
  writes `Application\ Support` and the quotes keep the backslash, so every C
  extension failed to link. The recipe removes the quotes (tested with bcrypt
  and json). Native gems need the Xcode Command Line Tools (policy `needs`).
