# nim + cc mirror hunt, round 3 (2026-09-20) — hash-addressed and distro-archive sources

Task: more download mirrors for the **nim** and **C/C++ (`cc`)** runtimes, with
an explicit interest in (a) searching **by content hash** rather than by file
name, and (b) mirrors reachable over **plain `http://`**, because XP/Vista/7
often cannot complete a modern TLS handshake.

Everything here is re-runnable with Python 3 stdlib only. Nothing was written to
`releases.json` or any `download_plan*.json` directly: all catalogue writes went
through `catalog/tools/add_mirrors.py` (see `updates.jsonl`), and `mirrors.json`
/ `NOTES.md` were written by `update_notes.py` under `catalog/.write.lock`.

## Files

| file | what it does |
| --- | --- |
| `probe.py` | generic HEAD prober: redirects **disabled**, browser-ish UA `installer-builder-catalog`, ≤10 workers per host, results cached in `cache.json`. `probe.py <tag> <urls-file>` where each line is `<expected-size-or-dash> <url>`. |
| `debian_nim.py` | reads `snapshot.debian.org`'s `/mr/package/nim/.../srcfiles?fileinfo=1` for every nim version Debian ever packaged and compares its `.orig.tar.xz` size with ours → `debian_nim.json`. |
| `verify_samples.py` | one full download + SHA-256 per newly-confirmed host → `verify_samples.json`. Samples are deleted immediately. |
| `local_sha_map.py` | joins the runtimes store's locally-computed SHA-256 pins (`store/sha256-local.json`, for the 278 files no vendor publishes a checksum for) onto cc/nim entries → `local_sha_map.json`. This is what makes a hash-addressed lookup possible for GCC and old LLVM, whose catalogue `checksum` is `null`. |
| `cn_github_release.py` | enumerates the three newly-found CN `github-release` mirrors and HEAD-verifies every filename match. |
| `gentoo_network.py` | probes all 147 hosts × 2 protocols on `api.gentoo.org/mirrors/distfiles.xml` for the two nim tarballs Gentoo carries. |
| `build_updates.py` | emits `updates.jsonl` for `tools/add_mirrors.py`. |
| `update_notes.py` | appends to `{nim,cc}/mirrors.json` and `{nim,cc}/NOTES.md` under `catalog/.write.lock`, atomically and idempotently. |
| `urls_*.txt`, `*_updates.jsonl`, `*.json` | probe inputs and raw evidence. |

## Gotcha

`cache.json` is a whole-file read-modify-write, so **do not run two probes
concurrently** — they clobber each other's cache entries. Each script's own
printed results are still correct (they come from its in-memory copy), but the
cache file is not a reliable record after a concurrent run. Re-run serially if
you need the cache to be complete.

## Method notes worth keeping

- **HEAD is not enough on challenge-protected mirrors.** `mirrors.nyist.edu.cn`
  answers HEAD with 200 and the exact vendor `Content-Length`, and 404s a bogus
  path — but a real GET 302s to an nginx proof-of-work page (`/testpow/`).
  Every host here was therefore also checked with a real GET (a full download,
  or a `Range` request compared byte-for-byte against the vendor).
- **Renamed files need a hash, not a size** (MIRROR-HUNT-2). Debian renames
  `nim-X.Y.Z.tar.xz` to `nim_X.Y.Z.orig.tar.xz`, so all 7 size-matching
  candidates were downloaded in full from Debian *and* from nim-lang.org in the
  same pass and compared byte-for-byte.
- **Hash-addressed caches need a hash.** GCC and old LLVM have
  `checksum: null`, so `store/sha256-local.json` (the store's own pins) was used
  as the lookup key — which is how five GCC tarballs were found in Nix's cache
  and gained an independent `checksum_corroboration` they did not have.
