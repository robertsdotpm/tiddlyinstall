# Python catalog notes

## Sources
- python.org downloads API (`/api/v2/downloads/release/`, `/release_file/`) for the list of
  every published, non-prerelease Python release and whatever checksums it publishes.
- python.org ftp directory listings (`https://www.python.org/ftp/python/<version>/`), crawled for
  every one of the 261 stable releases, as the ground truth for which windows/macos/source
  files actually exist -- the API is missing some (e.g. the 3.3.5 Windows MSIs are absent from
  `release_file`, and several ancient security-only patch releases such as 2.5.6 shipped source
  only, with no installer at all, which the API doesn't make obvious). Files found only via the
  ftp listing have `"checksum": null` and a note saying so.
- `astral-sh/python-build-standalone` (formerly `indygreg/python-build-standalone`) GitHub releases,
  via `gh api`, for prebuilt relocatable Linux/macOS builds (`install_only` and `install_only_stripped`
  tar.gz assets). Checksums come from each asset's `digest` field (sha256), which this repo provides
  directly on the release-asset JSON -- there is no separate `SHA256SUMS` asset in this repo (unlike
  some other astral-sh repos); a per-asset `.sha256` sidecar file also exists but the API digest is
  equivalent and avoids an extra request per file.
- Latest python-build-standalone release only covers currently-maintained minors (3.10-3.14 as of this
  run, plus a 3.15 prerelease that is excluded as non-stable). Two historical release tags
  (20250918, 20241002) were used as anchors to pick up the final builds for 3.9 (3.9.23) and 3.8
  (3.8.20) before astral-sh stopped building them post-EOL.

## Scope decisions
- "Python install manager" releases (25.x, 26.x on python.org) are a separate launcher/installer
  tool, not a Python runtime -- excluded entirely.
- Windows: the newer `-embeddable-*.zip` asset name (appearing alongside the classic `-embed-*.zip`
  from Python 3.11 on) is skipped as a near-duplicate of `-embed-*.zip` (slightly different byte size,
  undocumented on the downloads page) to avoid double-counting the same conceptual artifact. Likewise
  skipped: the bare `-amd64.zip`/`-win32.zip`/`-arm64.zip` (no "embed"), the free-threaded `t-*.zip`
  variants, and `-test-*.zip` bundles -- all present on the ftp server but not linked from the official
  downloads page, and out of scope for this pass.
- Android/iOS builds present under recent version directories (`*-linux-android.tar.gz`) are skipped;
  not one of the target OSes here.
- macOS variant strings (`macosx10.5`, `macosx10.9`, `macos11`, `macpython`, ...) encode the vendor's
  own minimum-OS naming for that installer generation; `arch` is `amd64` only for the Intel-only
  `macosx10.9` generation, `universal` for every fat/universal2 build (including old PPC/Intel dmgs and
  the modern arm64+x86_64 `macos11.pkg`).
- Linux: python.org ships no Linux binaries at all, at any version. Every stable release gets exactly
  one `os: "linux", arch: "any", kind: "source"` entry (the source tarball, applies to any Unix); this
  is recorded once per version rather than duplicated per (linux/freebsd/etc) since the same tarball is
  what every Unix builds from.
- python-build-standalone microarchitecture variants (`x86_64_v2/v3/v4`) and the plain
  `armv7-unknown-linux-gnueabi` (non-hf) triple are skipped in favour of the baseline `x86_64` and
  `armv7...gnueabihf` builds, to keep `arch` values within the schema's enum.

## download_plan.json selection
- Windows: both the full installer (`variant: null`) and the embeddable zip (`variant: "embed"`) are
  planned per arch/major, since they're different products, not competing formats of the same one.
- macOS and Linux: when python-build-standalone covers a major at all (3.8+), its `install_only` or
  `install_only_stripped` (whichever is smaller) is the plan entry, in preference to the official
  installer / source tarball, per arch. Older majors (2.x, 3.0-3.7) fall back to the newest available
  official pkg/dmg installer (macOS) or the source tarball (Linux) -- recorded as a gap for the missing
  prebuilt Linux binary.

## Old-Windows testing
Separately-tested known-good builds for XP/Vista/7/8/10/11 (asyncio confirmed working, not just
"installs") are documented in `/home/x/projects/installer-builder-runtimes/TESTED-WINDOWS.md` and are
not duplicated here; this catalog covers every published patch, that file covers what was actually
verified on real old Windows installs.

## Mirrors
See mirrors.json for which of the root `mirrors.json` templates were confirmed (by HEAD, sampled
across old/new and windows/macos/source files) and applied to every matching release.

## Mirror hunt (2026-09-17)

Extended the confirmed mirrors per `catalog/MIRROR-HUNT.md`. `extra_mirrors.py`
in this folder applies the results below and must be re-run after `scrape.py`
(it's idempotent and safe to run repeatedly). Full detail, including exactly
how each was confirmed or rejected, is in `mirrors.json`.

**Added:**
- `http://` variants of `huaweicloud`, `huaweicloud-repo` and `aliyun`
  (already-confirmed `https` mirrors) -- same host and layout, plain http
  also serves byte-identical content. Sampled across the same 6 files as the
  original https confirmation (2 for aliyun, which is windows-only) and
  additionally full-downloaded + checksum-verified one small file
  (`python-3.9.9-embed-win32.zip`, md5 `a54f24cee83fe5ef2e65f707b3af4fc2`)
  from all three over http. Aliyun's http path is throttled to ~800KB/s by
  its CDN (a 28MB file times out under a 20s curl `--max-time` but completes
  and hash-matches given a realistic timeout) -- not a correctness problem,
  just slow; worth knowing before treating a short http timeout there as
  "mirror is broken".
- A brand-new mirror for **python-build-standalone** (PBS) releases, which
  previously always had `mirrors: []` since they're GitHub-hosted and none
  of the python.org-ftp-layout templates apply to them. npmmirror mirrors
  `astral-sh/python-build-standalone` releases at
  `registry.npmmirror.com/-/binary/python-build-standalone/{tag}/{file}`
  (redirects to `cdn.npmmirror.com/binaries/python-build-standalone/{tag}/{file}`,
  added as a second, separate mirror URL since both hosts serve it directly).
  All 3 release tags this catalog references (20241002, 20250918, 20260901)
  are present on npmmirror, and all 130 PBS entries in `releases.json` were
  matched against npmmirror's own live directory listing by size (130/130);
  two files were additionally downloaded whole and checksum-verified. Since
  npmmirror's PBS mirror is a rolling copy of GitHub releases (not guaranteed
  complete for tags outside those 3), `extra_mirrors.py` re-checks every
  candidate entry's size against npmmirror's listing on every run rather than
  assuming coverage once confirmed.
- This closes every remaining gap in `releases.json` (1140/1270 -> 1270/1270
  entries with >=1 mirror) and in `download_plan_majors.json` (13/21 -> 21/21)
  -- the gap was entirely the PBS entries, which make up a majority of
  `download_plan_majors.json`'s macOS/Linux picks for 3.8+.

**Tried and rejected** (see `mirrors.json`'s `rejected_2026-09-17` for detail
on each): Tencent Cloud (`/python/` exists but is empty), SJTU and USTC
(both now pass the browser-UA check that used to 403, but serve an HTML
anti-bot "verifying" interstitial instead of the file for almost every
request -- not something `curl`/a script can pass, so file identity can't be
confirmed; USTC let exactly one sampled file through, inconsistently, which
isn't enough to trust), USTC's and Tsinghua's `github-release` PBS proxies
(same anti-bot wall / an outright 403), NJU's `github-release` PBS proxy
(infinite redirect loop), dotsrc.org, ftp.jaist.ac.jp and mirror.yandex.ru
(none of the three actually mirror python.org at all -- checked their own
published mirror lists / directory trees).

`http://` was also tried for the existing `python.org`, `npmmirror`,
`npmmirror-cdn`, `tuna`, `nju` and `bfsu` templates: all either 301/302-
redirect straight back to their own https (so plain http isn't actually
served, even though the host works fine over https) or, for `nju`, loop
forever without resolving. Recorded per-template in `mirrors.json` rather
than silently omitted, since "tried and it just redirects to https" is a
different, more useful fact than "not tried".

## Old .tgz checksums

python.org's downloads API records the md5 and size of the *decompressed* tar for many old `.tgz` source files. `fix_tgz_checksums.py` (run after `scrape.py`) marks those checksums `applies_to: decompressed` and stores the served size; `tools/download.py` verifies such files by hashing the gunzipped contents.

## python-build-standalone's standard library (installer-builder, 2026-09-19)

Every module in `sys.stdlib_module_names` was imported from the
`install_only_stripped` 3.14.7 builds (Linux x86_64 on Ubuntu 24.04, macOS
arm64 on macOS 26): all import except `_gdbm` (`dbm.gnu`; GNU dbm is
GPL-licensed and python-build-standalone leaves it out, so `dbm` uses
`dbm.sqlite3` or `dbm.ndbm`) and the other platform's modules (`winreg`,
`msvcrt`, `_scproxy`...). tkinter has Tcl/Tk 9.0 built in; a Tk window
needs a display (X11 on Linux, a window server on macOS). installer-builder's
`tests/fidelity/python` also checks ssl, sqlite3, ctypes, venv, pip with
compiled wheels and multiprocessing: all pass there, on Ubuntu 22.04, and
with python.org's builds on Windows 10 and 7.
