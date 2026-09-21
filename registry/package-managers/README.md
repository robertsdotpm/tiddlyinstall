# Windows package-manager mining

Mirrors and checksum corroboration for the Windows entries in the runtime
catalog, mined from three Windows package managers rather than the vendors'
own indexes (which `<runtime>/scrape.py` already covers).

## Re-running

```
python3 catalog/package-managers/mine_windows.py [--scratch DIR] [--skip-clone] [--no-apply]
```

Python 3 stdlib only, plus the `git` CLI (needs network access). Clones/updates
its source repos under `--scratch` (default: `package-managers/sources/`,
gitignored), parses them, matches against every `<runtime>/releases.json`,
HEAD/ranged-GET-confirms any new mirror candidates, writes the evidence files
below, and applies mirrors + checksum corroborations via
`tools/add_mirrors.py` (which locks, dedupes, and queues folders another
process currently holds via `.busy`). Re-run any time the manifests move on
or a runtime gets new releases; it's idempotent (`add_mirrors.py` dedupes,
and the git clones are updated in place rather than re-cloned).

Pass `--skip-clone` to iterate on parsing/matching against whatever is
already in `--scratch`. Pass `--no-apply` to only write the evidence and
`*_updates.jsonl` files without touching the catalog.

## What each manager contributed

**winget-pkgs** (`microsoft/winget-pkgs`, sparse/blobless clone of the
manifest dirs for Python.Python.*, OpenJS.NodeJS*, EclipseAdoptium.Temurin.*,
Azul.Zulu.*, Microsoft.DotNet.*, GoLang.Go, Rustlang.Rust.*, PHP.PHP*,
RProject.R, RubyInstallerTeam.*, LLVM.LLVM, BrechtSanders.WinLibs.*):
6562 installer records parsed from 2721 manifests. 4320 exact URL matches
(all agreeing with vendor checksums where the catalog already had one, no
disagreements), 324 checksum corroborations for previously-null entries,
and 358 confirmed mirrors: `go.dev` (211, mirroring `dl.google.com`),
`download.microsoft.com` (84) and `builds.dotnet.microsoft.com` (16) for
dotnet, `downloads.php.net` (2, most already covered) and `cloud.r-project.org`
(25, CRAN's own round-robin CDN mirror of `cran.r-project.org`). 1516 manifest
entries are unmatched -- previews, hosting bundles, and old Azul Zulu builds
whose filename convention has since changed; not an error, just out of the
catalog's scope or not resolvable by filename.

**Scoop** (`ScoopInstaller/Main`, `Java`, `PHP`, `Extras` -- current bucket
state; `Versions` -- current state, full history available; plus a full
`git log`/`git show` walk of 18 actively-maintained `Main` bucket files --
`llvm.json`, `gcc.json`, `mingw*.json`, `rust*.json`, `python.json`,
`ruby.json`, `r.json`, `nodejs.json`, `php*.json`, `go.json` -- which only
keep the *latest* version of their major in the working tree, so history is
the only way to recover older ones): 3370 records (991 current-state + 2379
from history). 1568 exact URL matches, 852 checksum corroborations (mostly
PHP's `windows.php.net` archive, which the vendor doesn't checksum going
back to 5.2.x), 101 confirmed mirrors (`downloads.php.net` `~windows` alias,
`cloud.r-project.org`, `dotnetcli.azureedge.net` -- an older Microsoft CDN
edge for the same dotnet builds). **10 checksum disagreements found and
NOT applied** -- see `disagreements.json` and the mining reply for detail;
these look like transient upstream mistakes in specific Scoop commits
(Azul Zulu 12.1.3 JRE, PHP 8.1.34 NTS x64/x86, WinLibs GCC 16.1.0, R 4.0.3,
Python 3.9.4, Node 22.1.0/22.2.0), each superseded by a later commit in the
same bucket.

**Chocolatey** (`chocolatey-community/chocolatey-packages`): most packages
for these runtimes (`python`, `python3`, `nodejs` itself) are AU
"meta"/dependency packages with no literal URL in the repo -- the download
URL is resolved dynamically at publish time. But `nodejs.install`, `php`,
`python2`, `ruby.install` and `ruby.portable` commit a
`legal/VERIFICATION*.txt` with the resolved URL + checksum for whatever
version was last published; walking that file's git history (no `.nupkg`
downloads needed) recovered 96 records, all exact URL matches agreeing with
already-known vendor checksums (`nodejs.org` publishes `SHASUMS256.txt` for
everything Chocolatey ships, so nothing new to corroborate there).
`mkevenaar/chocolatey-packages` was checked but carries none of these
runtime packages.

## Evidence files

- `winget.json`, `scoop.json`, `chocolatey.json` -- one record per parsed
  manifest installer/version/arch, with its match result (`matched` folder+
  url, or `"unmatched"`) and `action` (`agrees_with_vendor_checksum`,
  `checksum_corroboration_added`, `DISAGREEMENT`, or an algo-mismatch note).
- `*_updates.jsonl` / `all_updates.jsonl` -- the lines fed to
  `tools/add_mirrors.py`.
- `disagreements.json` -- checksum disagreements found but never applied.

## Notes

- No runtime binaries were downloaded; all mirror confirmation was by
  `HEAD` (falling back to a 1-byte ranged `GET` for hosts like Azure Blob
  Storage that omit `Content-Length` on `HEAD`) comparing `Content-Length`
  against the catalog's recorded `size` or the vendor URL's own size.
- Two web searches were used in total, to locate the winget-pkgs manifest
  path convention and confirm the Scoop/Chocolatey repository layouts;
  everything else was direct API/git access to already-known URLs.
- A first pass produced duplicate `checksum_corroboration` entries (same
  hash, cosmetically different `source` label) because an earlier scratch
  version of this script used different `package_id` formatting than the
  version checked in here. Cleaned up once (see git history / mining reply);
  `mine_windows.py` now uses one consistent format, so re-running it will
  not reintroduce that.

## Review corrections (2026-09-17)

- **go.dev removed.** `mine_windows.py` confirmed `https://go.dev/dl/<file>` by size,
  but go.dev returns a 302 redirect to `dl.google.com`, the entries' primary URL.
  Redirect-only hosts aren't mirrors (golang.google.cn was rejected for the same
  reason), so the 211 go.dev mirrors were removed. If `mine_windows.py` is re-run,
  disable redirect-following when confirming mirrors, or it will add them again.
- **download.microsoft.com kept.** Checked a real URL with redirects disabled:
  served directly (HTTP 200, correct Content-Length). Microsoft-operated.
