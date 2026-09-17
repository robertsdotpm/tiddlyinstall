# cc (C/C++ toolchains) mirror hunt, round 2 -- 2026-09-17

Task: extend WinLibs, LLVM prebuilt-binary, and w64devkit mirror coverage
beyond round 1 (which left these three GitHub-release-only, at 192/1416 =
13.6% releases.json / 47/182 = 25.8% download_plan_majors.json).

## Files here

- `probe.py` -- re-runnable, read-only (HEAD/GET only, no full downloads)
  script reproducing every check this pass made: the SourceForge
  reachability control, the ISCAS confirmed/rejected file checks, HUST's
  unlistable-via-plain-HTTP directory, the SJTUG redirect, the TUNA
  GET-blocked/HEAD-passes asymmetry, winlibs.com's link targets, MSYS2's
  own package versioning, and install-llvm-action's download source.
- `cc_round2_updates.jsonl` -- the two mirror updates actually applied via
  `catalog/tools/add_mirrors.py` (already run; kept here for the record).
- `update_notes.py` -- the one-shot, lock-safe, idempotent script that
  appended the new mirror to `catalog/cc/mirrors.json` and the "Mirror hunt
  round 2" section to `catalog/cc/NOTES.md` (already run).

## Result

One new mirror confirmed: **ISCAS** (`mirror.iscas.ac.cn/github-release/`),
a partial/frozen single-snapshot mirror of only the newest llvm/llvm-project
release at its last sync (llvmorg-20.1.6, May 2025) -- and even for that one
release only 2 of 7 releases.json rows are actually present (the rest 404
despite stale metadata rows in its own listing). Applied to those 2 exact
entries. Net: releases.json 192->194 (13.6%->13.7%); download_plan_majors.json
unchanged (20.1.6 isn't the newest 20.x patch).

Everything else tested was rejected or confirmed still blocked -- see
`catalog/cc/NOTES.md` "Mirror hunt round 2 (2026-09-17)" for the full
per-host detail (SourceForge network-unreachable in general, not just
Cloudflare-challenged; winlibs.com and install-llvm-action both just
front GitHub directly; MSYS2 builds its own gcc package; TUNA and SJTUG
rejected for the reasons above; HUST's directory contents couldn't be
enumerated without JS).

No web searches were used (0 of the allotted 4) -- every host/path came
from the task brief or from walking a mirror's own directory listing.
