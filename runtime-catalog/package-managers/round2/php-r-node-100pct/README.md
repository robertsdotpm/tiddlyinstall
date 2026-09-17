# Mirror hunt round 2: php, r, node -> 100% coverage goal

Scripts here are re-runnable (Python 3 stdlib only) and re-derive gaps
directly from each runtime's `releases.json` rather than trusting
`catalog/unmirrored-summary.txt`.

- `gaps.py` -- prints the current unmirrored count and (os, kind, variant)
  breakdown for php, r, node. Run this first after any change to confirm
  where the remaining gaps are.
- `check_spc.py` -- HEAD-checks every php `variant=="static-php-cli"`
  entry against `https://static-php-cli.fra1.digitaloceanspaces.com/...`
  (the DigitalOcean Spaces bucket that `dl.static-php.dev` 302-redirects
  to). Confirmed 338/338 on 2026-09-17; applied as a mirror to all of
  them via `tools/add_mirrors.py`.
- `check_iojs_huawei.py` -- HEAD-checks every node `variant=="iojs"` entry
  without a mirror against `https://mirrors.huaweicloud.com/iojs/...`.
  Confirmed 580/580 on 2026-09-17 (the whole remaining node gap); applied
  via `tools/add_mirrors.py`.

## Outcome (2026-09-17)

- **node: 100%** (20092/20092 releases.json entries mirrored). io.js had
  zero mirror coverage going into this session; `mirrors.huaweicloud.com/iojs/`
  closed it entirely.
- **php: 130/2277 still unmirrored** (was 470). The static-php-cli gap
  (338 entries) is closed via the DigitalOcean Spaces origin above. The
  remaining 130 (93 source + 21 Windows archive + 16 Windows installer)
  are all old files that only exist on `museum.php.net`, which no
  second host was found to mirror -- see `catalog/php/NOTES.md` for every
  lead chased and why each failed.
- **r: 5/584 still unmirrored** (unchanged from round 1). Re-confirmed via
  5 more CRAN-mirror-network hosts (iastate, imperial, csiro, auckland,
  aarnet) that none carry `cran-archive.r-project.org`'s old
  `bin/windows/base/old/` or `bin/macosx/base/` trees. See
  `catalog/r/NOTES.md` for the full writeup, including why R 1.8.1 is a
  vendor checksum problem rather than a mirror gap.

Full evidence and reasoning for each finding (including rejected
candidates) is in `catalog/php/NOTES.md`, `catalog/r/NOTES.md` and
`catalog/node/NOTES.md` under their "Mirror hunt round 2" sections, per
the round-2 brief's requirement to record NOTES.md updates there rather
than here. This directory only holds the scripts and a pointer.
