# Node.js runtime catalog notes

## Sources
- https://nodejs.org/dist/index.json -- all Node.js releases (866 total as scraped; 726 in scope: 0.8/0.10/0.12 plus every integer major 4..latest).
- https://nodejs.org/dist/v<ver>/SHASUMS256.txt -- fetched for every in-scope node version (ground truth for exact filenames; the naming convention has changed several times across history, e.g. bare `node.exe`, dir-prefixed old msis, `-headers`, `-musl`, `.7z`, so filenames were parsed from these listings rather than guessed).
- https://iojs.org/dist/index.json -- io.js 1.x-3.x, 41 versions, variant "iojs".
- https://unofficial-builds.nodejs.org/download/release/index.json -- gap-filling builds, 419 versions in scope, variant "unofficial" (or "musl" when libc==musl).

## Discrepancy from the brief
The brief called out "win x86 for newer versions" as an unofficial-builds variant. As scraped, unofficial-builds.nodejs.org's index.json carries no win-x86 files at all (checked every version's file-key list programmatically) -- only win-arm64 (before it was official), linux-x86, linux-armv6l, linux-riscv64, linux-loong64, and various linux-x64 libc/build flavours. Where nodejs.org itself dropped official win-x86 (and later linux-x86, and solaris) with no unofficial fallback, that is recorded as a gap in gaps.json instead of fabricated.

## Classification rules worth knowing
- A bare `node.exe` (or `<arch>/node.exe`) is only kept as a release entry (kind=archive, format=exe) when no zip/msi exists for that arch+version -- true for pre-zip-era Windows builds. In modern releases the same bare exe ships alongside the full zip/msi as a headless companion binary (no npm); that companion is dropped so it doesn't masquerade as a complete runtime.
- `libc` is `glibc` for ordinary linux tar builds and `musl` for `-musl` builds; musl entries also get `variant="musl"` (rather than colliding with the glibc build under the same major/os/arch key in download_plan).
- Source tarballs (`node-vX.Y.Z.tar.gz/.tar.xz`) are recorded with kind="source", arch="any"; the schema has no platform-independent `os` value, so os="linux" is used by convention and noted on the entry.
- `min_os` is left null throughout -- getting it right per major needs BUILDING.md-style research the brief defers to a later limitations.json pass.

## Counts
- 20092 release entries across 29 node majors: 0.8, 0.10, 0.12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26.
- 20092/20092 entries carry a vendor sha256 checksum.
- 23 gap entries.
- 337 download_plan entries.

## Mirrors
Probed 6 candidates against >=5 sampled official files (old and new majors); 3 confirmed by matching Content-Length on every sample: npmmirror-cdn, npmmirror-registry, nodejs-download-release. Full per-sample results are in mirrors.json. Confirmed mirrors were applied to every official (non-iojs, non-unofficial) release entry, not just the sampled ones. iojs and unofficial-builds entries were not mirror-probed.

## Sizes
`size` is populated via HEAD request for every download_plan entry (and reused on the matching release entry). It is left null on the ~13,000+ other releases.json entries to avoid one HEAD request per file across 15 years of history; only the planned (newest-per-major/os/arch/variant) entries were sized.

## Mirror hunt (2026-09-17)
Extended the original 3 confirmed mirrors with `catalog/node/extra_mirrors.py` (stdlib, re-runnable, idempotent; results cached in `extra_mirrors_cache.json` beside it -- re-run after `scrape.py`, or to continue/refresh the partial mirrors below).

**New "full" mirrors** (>=8-file sample, old/mid/new versions and windows/linux/macos/amd64/arm64, every sample matched the vendor's Content-Length exactly; applied to every entry in scope unconditionally, same policy as the original 3): `mirror.yandex.ru/mirrors/nodejs.org/dist/` (Russia, non-China, http+https), `mirrors.aliyun.com/nodejs-release/` (China, http+https), and -- new for this pass -- npmmirror's own `node-unofficial-builds` path on both `cdn.npmmirror.com` and `registry.npmmirror.com` (15-file sample across linux-x86/armv6l/riscv64/loong64, win-arm64, and musl), which mirrors `unofficial-builds.nodejs.org` byte-for-byte and previously had zero mirror coverage (2424 entries: variant unofficial/musl).

**New "partial" mirrors** (huaweicloud, tuna, ustc -- all three previously rejected as "partial" -- plus new candidates tencent and dotsrc): real gaps were found in the sample, so `extra_mirrors.py` only applies a mirror to an entry after an individual HEAD check against that entry's own vendor Content-Length. Per mirror: huaweicloud (isolated old-version hole + newest release lag), tuna (newest release lag; also rate-limits repeated automated access -- see below), ustc (materially partial, ~15% hit rate, unrelated to recency), tencent (newest release lag), dotsrc (Denmark/EU, non-China -- but its sync is stale by whole majors: v24.0.0 present, v24.9.0/v25.x/v26.x entirely absent). Full per-sample detail and http/https support per mirror is in `mirrors.json` under `mirror_hunt_2026_09_17`.

**Scope actually run this session** (stopped early by the coordinator -- an exhaustive per-entry sweep of all 17088 official releases.json entries across 5 partial mirrors is ~85k HEAD checks, too slow/heavy given other runtimes' hunts share the same mirror infrastructure concurrently): `download_plan.json` and `download_plan_majors.json` are **fully** per-entry HEAD-checked against all 5 partial mirrors (every official entry, every mirror). For `releases.json`, huaweicloud and tuna ended up effectively fully checked too (17087/17088 each) before the stop; ustc got a partial pass (2055/17088, consistent with its low hit rate, so not prioritized further); tencent and dotsrc were only checked for the subset of releases.json entries that are also download_plan entries. Every releases.json entry without a per-entry-confirmed partial mirror still gets the full mirrors above (npmmirror x2, nodejs.org, aliyun, yandex) as checksum-verified failover, so it is not left with zero mirrors -- it just doesn't also carry huaweicloud/tuna/ustc/tencent/dotsrc unless individually confirmed. Re-running `extra_mirrors.py --only partial` (no `--max-checks`) will resume and complete the remaining releases.json entries using the existing cache.

**Wayback Machine (archive.org)**: checked as the only lead for io.js (variant=iojs; no live mirror exists for it anywhere -- iojs.org itself, still up, is the vendor; nodejs.org/dist, npmmirror, and aliyun were all checked directly and none carry it) and, per the brief, for node's oldest lines (0.8/0.10/0.12, already fully covered by the full mirrors above). https to web.archive.org was very unreliable from this network (connection resets, multi-minute hangs); plain http to the same host was fast and reliable, so `extra_mirrors.py` forces every archive.org hop back to http even when its own redirect Location says https. Coverage is partial as expected: of 3 io.js versions spot-checked, v1.0.0 has no capture but v2.0.0 and v3.3.1 do (v3.3.1's capture was downloaded in full and its sha256 matched the vendor's exactly). The per-entry sweep over the 580 iojs + 1044 old-node candidates was not run this session (stopped alongside the releases.json partial-mirror sweep); `extra_mirrors.py --only wayback` will run it.

**Rejected**: `mirror.sjtu.edu.cn/nodejs-release/` sits behind a "Cerberus" bot challenge that intermittently 403s a plain browser-UA request (http and https alike) even for files it carries -- unusable for unattended/old-client mirroring. JAIST: no evidence found of a nodejs/iojs mirror there (one web search). No mirror of iojs.org itself was found anywhere.

**Coverage**: releases.json mirrored-entries went from 17088/20092 (85.0%) to 19512/20092 (97.1%); download_plan_majors.json from 232/322 (72.0%) to 300/322 (93.2%).


## Mirror hunt round 2 (2026-09-17)

Per `catalog/MIRROR-HUNT-2.md`. Re-derived the unmirrored set from
`releases.json` with a script: 580 entries, all variant=iojs (matches
`unmirrored-summary.txt`) -- round 1 had left io.js with zero mirror
coverage after checking nodejs.org/dist, npmmirror, aliyun and Wayback
(partial) directly.

**Found: `mirrors.huaweicloud.com/iojs/` -- a full mirror of
`iojs.org/dist/`, closing the entire remaining node gap.** This is a
separate tree from the huaweicloud `/nodejs/` mirror already recorded as
"partial" in round 1 (that one mirrors official node.js builds and has
isolated gaps; this one is io.js only and had zero gaps in the full
sweep). Confirmed by HEAD-checking every one of the 580 unmirrored
entries individually (not a sample-then-blanket-apply, since io.js had no
prior mirror to extrapolate confidence from) -- 580/580 exact
Content-Length matches, spanning v1.0.0 through v3.3.1, linux/macos/
windows/solaris, archives/installers/source. A bogus version directory
and a bogus filename under a real version both 404 (not a catch-all
soft-200). Both http and https work. Downloaded
`iojs-v1.8.4-darwin-x64.tar.xz` (5,229,048 bytes, the smallest unmirrored
file) in full and verified its sha256 against `iojs.org`'s own
SHASUMS256.txt value -- matched exactly, then deleted.

Other leads checked per the brief, all dead ends (kept here so a future
pass doesn't repeat them):
- `https://iojs.org/download/release/` -- resolves, but it's the vendor's
  own alternate URL scheme for the same vendor host, not a third-party
  mirror (explicitly out of scope per the brief's own labelling
  instruction).
- `nodejs.org/dist/iojs-v*` and `nodejs.org/download/release/.../iojs-v*`
  -- both 404; nodejs.org never took over serving io.js files.
- `cdn.npmmirror.com/binaries/iojs/` and
  `registry.npmmirror.com/-/binary/iojs/` -- both `NoSuchKey`/`NOT_FOUND`.
  npmmirror does not carry an "iojs" binary bucket despite some third-party
  blog posts/configs referencing `NVM_IOJS_ORG_MIRROR` pointing at it --
  that env var exists in nvm's source but the bucket itself is empty/gone.
- `mirrors.ustc.edu.cn/node/` -- looked promising (200 on a real iojs
  filename) but failed the bogus-path control (a nonexistent filename
  also returns 200 with a small HTML body) -- it's a soft-catch-all, not a
  real hit. Rejected.
- `mirrors.dotsrc.org/nodejs/release/` -- 403 Forbidden outright.
- `mirror.yandex.ru/mirrors/iojs.org/dist/` -- 404, no iojs tree found
  there despite the general `mirror.yandex.ru/mirrors/nodejs.org/dist/`
  being confirmed for official node in round 1.
- TUNA (`mirrors.tuna.tsinghua.edu.cn`) -- its own nodejs-release help
  page makes no mention of io.js; not pursued further.

Applied via `tools/add_mirrors.py` (`node_iojs_updates.jsonl`, 580 lines)
rather than `extra_mirrors.py`, since it's a single confirmed
host-and-path-prefix swap with no partial-match risk (every entry was
individually verified, not extrapolated). **TODO:** add this template to
`extra_mirrors.py` itself so it survives the next `scrape.py` re-run.

**Coverage: releases.json 19512/20092 (97.1%) -> 20092/20092 (100%).**
`download_plan.json` and `download_plan_majors.json` were already at
100%/93.2% respectively for non-iojs entries in round 1; io.js was never
in `download_plan*.json` in the first place (only the newest
major/os/arch is planned, and 3.x is the newest io.js major already
covered). Node.js runtime catalog is now at 100% mirror coverage on
`releases.json`.

Budget used: 1 of 4 web searches for this runtime (iojs mirror hosts;
shared with php and r in the same session -- see php/NOTES.md and
r/NOTES.md for the other two).
