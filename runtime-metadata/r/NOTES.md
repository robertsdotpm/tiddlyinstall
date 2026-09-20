# R runtime catalog notes

## What this covers

- 107 Windows installer releases (`bin/windows/base/`,
  `bin/windows/base/old/`, and `cran-archive.r-project.org/bin/windows/base/old/`
  for anything before R 4.0.0). Arch is recorded per the vendor's own history:
  x86-only before 2.12.0, a combined 32/64-bit installer from 2.12.0 to 4.1.x
  (recorded as `amd64`, noted in each entry), 64-bit-only from 4.2.0 on.
- 119 macOS installer releases. Current CRAN layout
  (`base/` = Intel High Sierra+, `big-sur-arm64/base/` and `big-sur-x86_64/base/`,
  `sonoma-arm64/base/` for the newest Apple-silicon builds) plus
  `cran-archive.r-project.org/bin/macosx/base/` for R 2.0.1-3.6.3, where one
  canonical file per version was picked among several historical variants
  (mini/-nn/-signed/-mavericks/-snowleopard/etc; see each entry's `notes`).
  Pre-2.0.1 macOS builds use a different, non-uniform CRAN-archive layout and
  were left as a gap rather than hand-walked.
- 236 Linux installer releases: Posit r-builds prebuilt R
  packages for `ubuntu-2204` (.deb) and `rhel-9` (.rpm), amd64 and arm64,
  confirmed to exist for every R version Posit lists (>= 3.0.0) via HEAD.
  CRAN itself ships no generic Linux binaries; only Posit's r-builds do.
- 122 source tarballs from `src/base/R-{1,2,3,4}/`, one per
  version (preferring plain `R-<ver>.tar.gz` over the historical
  `-recommended` bundle). Source builds on any Unix-like OS, so these are
  recorded once (`os: linux, arch: any`) rather than duplicated.

## Download plan

`download_plan.json` has the newest patch per (major, os, arch) for
windows/linux/macos, `posit-ubuntu-2204`/amd64 only for Linux (per spec).
Source tarballs are intentionally not planned (also per spec). Total planned
size: ~5.34 GB across 88 files.

## Mirrors

Candidates came from `CRAN_mirrors.csv`. 5 confirmed by HEAD
content-length match against cran.r-project.org across 5 sample files
spanning old (R 3.6.3 / R 4.0.0 era) and current (R 4.6.1) releases:
https://cloud.r-project.org/, https://mirrors.tuna.tsinghua.edu.cn/CRAN/, https://ftp.fau.de/cran/, https://pbil.univ-lyon1.fr/CRAN/, https://cran.csiro.au/.
Confirmed mirrors are applied to every CRAN-hosted release entry (windows,
macos, source) by substituting the path after the CRAN host, since CRAN
mirrors replicate the exact same directory tree. Posit's CDN
(`cdn.posit.co`) is not part of the CRAN mirror network, so Linux release
entries carry no mirrors.

## Known gaps

See `gaps.json`. Notable ones: R 1.x/2.x has no Linux binaries anywhere
(Posit r-builds starts at 3.0.0); pre-2.0.1 macOS used a different CRAN
archive layout not walked by this script.

## Checksums

Windows: parsed from each version's `md5sum.txt` (or `md5sum.R-<ver>.txt`
for the current release) when present. macOS and Linux: CRAN's autoindex
and Posit's CDN publish no per-file checksum manifests for these paths, so
`checksum` is `null` there (a few individual legacy macOS builds have an
MD5/SHA1 printed inline in `bin/macosx/`'s landing-page prose, but this
script does not scrape prose for checksums -- only manifest files).

## Mirror hunt (2026-09-17)

Extended mirror coverage per `catalog/MIRROR-HUNT.md`. All logic lives in
`extra_mirrors.py` (stdlib only, idempotent, caches Wayback CDX lookups in
`mirror_cache.json`); it must be re-run after `scrape.py` regenerates
`releases.json`. Coverage went from 200/584 releases.json entries (34.2%,
the 5 pre-existing CRAN mirrors only) to **579/584 (99.1%)**;
`download_plan_majors.json` went to 11/11 (100%); `download_plan.json`
went to 86/88 (the 2 remaining are R Windows archive builds with no
capture on Wayback, a genuine gap).

**14 new CRAN mirrors** (all confirmed by HEAD content-length match against
cran.r-project.org on 8 samples spanning `src/base/R-1`, `R-2`, `R-4`,
`bin/windows/base/old/4.0.0` and `/4.6.1`, and `bin/macosx/base/R-4.0.0.pkg`
+ `big-sur-x86_64` + `sonoma-arm64`; sample=8/8 for all 14; each also
verified by downloading `src/base/R-1/R-1.0.0.tgz` in full and comparing
its sha256 byte-for-byte against the same file from cran.r-project.org --
no R release in the current CRAN tree that has a *vendor-published*
checksum is small enough to fit the 60 MB sample budget, since every
checksummed Windows build is 80+ MB, so this hunt substitutes a full-content
hash comparison against the live vendor copy instead):
Argentina (`mirror.fcaglp.unlp.edu.ar`, http only), Brazil
(`cran-r.c3sl.ufpr.br`), Morocco (`mirror.marwan.ma`), India
(`mirror.niser.ac.in` and `cran.isid.ac.in`), Japan
(`ftp.yz.yamagata-u.ac.jp`), Russia (`mirror.truenetwork.ru`), Saudi Arabia
(`mirror.maeen.sa`), UAE (`cran.nyuad.nyu.edu`), Czech Republic
(`cran.nic.cz`), Canada (`mirror.csclub.uwaterloo.ca`), USA
(`ftp.ussg.iu.edu`, http+https), Germany (`ftp.gwdg.de`). Applied to all
200 cran.r-project.org-hosted entries (windows/macos/source), same as the
existing 5. Every cran.r-project.org entry now carries 19 mirrors.

**Posit CDN alias**: `cdn.rstudio.com` is Posit's old brand name for the
same CDN now at `cdn.posit.co` -- confirmed identical Content-Length on 6
samples (ubuntu-2204/rhel-9, amd64/arm64, R 3.0.0-4.6.1). Labelled as an
alias, not an independent mirror, but applied to all 236 Linux entries
since it is the same infrastructure. No checksum verification was possible
here: CRAN/Posit publish no per-file checksums for any Linux entry (see
"Checksums" above), so there is nothing to hash-check against -- recorded
in `mirrors.json` as "no vendor checksum exists for any Linux (Posit)
entry".

**cran-archive.r-project.org (old Windows/macOS, 148 entries)**: none of
the 19 CRAN mirrors above carry this host's paths at all (tested all 19
against 6 archive-tree samples: 0/6 for every one -- cran-archive is not
part of the standard CRAN mirror sync). Used the Internet Archive instead:
per entry, `extra_mirrors.py` queries the Wayback CDX API for the most
recent 200-status capture of the exact URL, then HEAD-checks the `if_`
capture URL against the entry's recorded size before adding it as a
mirror (Wayback is explicitly a partial/rolling source, so every entry is
checked individually, not blanket-applied). Verified end-to-end by
downloading `bin/windows/base/old/1.6.2/rw1062.exe` in full from its
Wayback capture: md5 `6092f65a86bd76e218fb05043afb7fea` matches CRAN's own
`md5sum.txt` exactly. Result: **143/148 archive entries now have a Wayback
mirror**. 4 have no capture on Wayback at all (genuine gaps): R 3.1.0 and
3.3.0 and 3.4.3 Windows, R 2.2.1 macOS. 1 is deliberately excluded -- see
next section.

**R 1.8.1 Windows (`rw1081.exe`) -- vendor-side checksum problem, not a
mirror gap.** Per the brief's specific ask: this file's download had
already failed its md5 check (`d81429b482d915dab41dca293122d6b7` per
CRAN's own `md5sum.txt`) before this hunt started. Investigation: the
*current live* file at `cran-archive.r-project.org` hashes to
`4db990588f3006bd453df6a2e2e77a95` (same size, 22968875 bytes, a valid
Inno Setup executable -- not truncated or corrupted in transit). The
earliest available Wayback capture (2025-05-23) of the same URL hashes
identically to that same wrong value, not to the manifest's value, and no
capture of the file exists from when it was still served directly from
`cran.r-project.org` (pre-archive-split; Wayback only ever captured
directory-listing HTML there, never the binary). So neither the live copy
nor any available historical copy matches CRAN's own decades-old manifest
entry -- this is a stale/incorrect `md5sum.txt` line (or a long-ago,
undocumented repack) on CRAN's side, not something a mirror or Wayback can
fix. `extra_mirrors.py` deliberately does not add a mirror for this entry
(it would just reproduce the same failing bytes); it is listed in
`gaps.json`-adjacent NOTES here instead so a reviewer doesn't waste time
re-chasing it.

**Rejected candidates** (kept as commented-out entries in
`extra_mirrors.py` so a future run doesn't retry them blind):
- `https://cran.yu.ac.kr/` (Korea) -- connection refused; the only Korea
  mirror in `CRAN_mirrors.csv`, so Korea currently has no CRAN mirror at
  all in this hunt.
- `https://mirrors.ustc.edu.cn/CRAN/` (China) -- HEAD/GET return HTTP 200
  but the body for several sample paths is a "Verifying - USTC Mirrors"
  anti-bot interstitial page, not the file. Real mirror for browsers, not
  safe for unattended scripted downloads.
- `https://mirrors.bfsu.edu.cn/CRAN/` (China) -- passed the 8-sample HEAD
  check (200 + correct Content-Length) and was briefly applied, but a real
  GET of the same URL consistently returns HTTP 403 with an HTML body --
  a WAF/anti-hotlink rule that treats HEAD and GET differently. Only
  caught during the full-download hash-verification step; removed
  afterwards.
- `https://cran.icts.res.in/` (India) -- TLS certificate expired.
- `https://cran.um.ac.ir/` (Iran) -- connection timed out.

Budget used: 0 web searches (everything came from `CRAN_mirrors.csv`,
direct HEAD/GET probes, and the Wayback CDX API, all fetched directly per
the brief's allowance).

## Mirror-ecosystem hunt (2026-09-17, package-managers/)

A second, separate pass from the hunt above: catalog/package-managers/
mirror_hosts.json (built from Cygwin/Debian/Ubuntu/Arch/CTAN/GNU/Fedora/
FreeBSD/MSYS2/CPAN's own mirror lists, plus CRAN_mirrors.csv again) was
probed directly for a `CRAN/` directory, then every hit was HEAD-verified
per-entry against all 200 releases.json entries under
`https://cran.r-project.org/`. 21 new full mirrors confirmed (200/200 or
179/200 for the one partial), plus 3 hosts already in the list above
(mirror.csclub.uwaterloo.ca, mirror.truenetwork.ru, mirrors.tuna.tsinghua.edu.cn)
skipped as duplicates. New hosts: ca.mirrors.cicku.me (CA), ftp.kaist.ac.kr
(KR), ftp.uni-sofia.bg (BG), mirror-hk.koddos.net (HK),
mirror.clientvps.com, mirror.cedia.org.ec (EC), mirror.lyrahosting.com
(NL), mirror.lzu.edu.cn (CN), mirror.nju.edu.cn (CN), mirror.nyist.edu.cn
(CN), mirror.twds.com.tw (TW), mirrors.bfsu.edu.cn (CN), mirrors.aliyun.com
(CN), mirrors.cloud.tencent.com (CN, partial 179/200), mirrors.hust.edu.cn
(CN), mirrors.nju.edu.cn (CN), mirrors.rit.edu (US), mirrors.sjtug.sjtu.edu.cn
(CN), mirrors.ustc.edu.cn (CN), mirrors.qlu.edu.cn (CN), us.mirrors.cicku.me
(US).

**Important reconciliation**: this pass's real GET + sha256 check of
`src/base/R-1/R-1.0.0.tgz` succeeded and byte-matched the vendor on
*every* one of the 21 hosts, including mirrors.bfsu.edu.cn and
mirrors.ustc.edu.cn -- both of which the hunt above explicitly rejected
for this exact reason ("HEAD 200, but a real GET returns a WAF/anti-bot
interstitial"). Re-checked independently with `curl -D-` outside the
script too; both returned clean `HTTP/2 200`, correct
`content-length: 2896632`, and the right gzip bytes. Both are re-added
with a `caveat` field on their mirrors.json entries pointing back at this
paragraph -- the anti-bot behaviour observed earlier the same day may be
intermittent (geo/IP/rate-based) rather than fixed, so don't treat this
as a correction of the earlier finding, just a note that it varied.
Re-verify with a real GET (not HEAD) before an unattended bulk download
relies on either host.

Applied directly via `tools/add_mirrors.py` (catalog/.busy was empty by
the time this ran) rather than through `extra_mirrors.py`; run
`extra_mirrors.py` after the next `scrape.py` as usual, independent of
this.


## Mirror hunt round 2, second pass (2026-09-17)

Re-derived the unmirrored set from `releases.json` with a script per
`catalog/MIRROR-HUNT-2.md`: still exactly 5 (matches
`unmirrored-summary.txt`) -- R 1.8.1/3.1.0/3.3.0/3.4.3 Windows installers
and R 2.2.1 macOS installer, all on `cran-archive.r-project.org`. The
round-1 pass earlier today already established: 1.8.1 is a vendor-side
stale-checksum problem (not a mirror gap, see above), and the other 4 have
no Wayback capture and no coverage on any of the 19+21=40 CRAN mirrors
already tested that day.

This pass directly HEAD-checked the exact 4 unresolved archive paths
(3.1.0, 3.3.0, 3.4.3 Windows; 2.2.1 macOS) against 5 more CRAN-mirror-network
candidates suggested by the round-2 brief that were not in either of
round 1's two mirror lists: `mirror.las.iastate.edu/CRAN`,
`cran.ma.imperial.ac.uk`, `cran.csiro.au`, `cran.stat.auckland.ac.nz`,
`mirror.aarnet.edu.au/pub/CRAN`. All 5 hosts are live (200 on their CRAN
root) but **all 5 returned 404 on all 4 paths** -- confirms the round-1
finding that `bin/windows/base/old/<ver>/` and `bin/macosx/base/` under
`cran-archive.r-project.org`'s own layout are simply not part of the
standard CRAN rsync tree that any mirror (regardless of operator) syncs;
CSIRO and AARNet were specifically named in the brief and both came back
negative like the rest.

Two manual Wayback re-checks were attempted for these same 4 URLs
(`archive.org/wayback/available`) but got HTTP 429 rate-limited on every
attempt -- consistent with the background `wayback_retry.py` job hammering
the same API per the round-2 brief's warning; not retried further, per
the brief's explicit ask not to add load. The background job is already
covering every unmirrored file including these.

**Conclusion: all 5 R gaps are genuinely unmirrorable right now** --
4 for lack of any surviving copy outside `cran-archive.r-project.org`
itself (live or archived), 1 for the vendor's own manifest being wrong
about a file that hasn't changed. R coverage stays at 579/584 (99.1%),
which is "100% of what can be mirrored" per the round-2 brief's framing.
No web search was spent on this (all candidate hostnames were already
known CRAN mirror names; direct HEAD checks only).

## Real-app fidelity (installer-builder, 2026-09-19)

Checked with installer-builder's `tests/fidelity/r` (install.packages of
digest and jsonlite, which compile C, then tcltk, HTTPS and capabilities()).

- **Windows:** the recipes' `executable` held a note ("bin\Rscript.exe  (R
  2.12-4.1 also have ...)"), which became part of `{runtime}`, so any install
  command using `{runtime}` failed ("The system cannot find the path
  specified"). The notes moved to `notes`.
- **macOS:** Rscript has R's install path compiled in and exits with
  "Rscript execution error: No such file or directory" anywhere else, which
  is why R failed on the Mac (not the space in "Application Support": R 4.6's
  bin/R quotes its paths). The extract recipe now wraps Rscript as the Linux
  recipe does (RHOME from the wrapper's own folder).
- **Linux (Posit r-builds):** installing CRAN packages compiles them (Makeconf:
  gcc, g++ -std=gnu++20, gfortran); the policy now needs gcc, g++ and make for
  apps that install something. tcltk needs the distribution's Tk 8.6
  (libtk8.6, the `libtk` prerequisite apps can name); it isn't forced on every
  R app.
