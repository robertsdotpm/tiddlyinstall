# CMake runtime catalog notes

CMake is a build tool, catalogued here so installer-builder can build C/C++
projects on the user's machine (installer-builder `docs/design.md` 1.8). Its
`install.json` recipes have `launch.program: null`; `project_install` is the
configure + build + install command, with Ninja from `catalog/ninja`.

## Sources

- `https://cmake.org/files/` -- Apache index, one folder per minor line
  (`v1.2` ... `v4.4`). Primary source for every file, with upload dates.
- `cmake-<ver>-SHA-256.txt` in each folder: vendor SHA-256 for **every
  release from 3.0.0** (PGP-signed `.asc` beside it). **Before 3.0.0 Kitware
  published no checksum at all** (426 entries, `checksum: null`).
- `cmake-<ver>-files-v1.json` (3.20+): per-file OS/arch/class and `macOSmin`,
  used for `min_os` on macOS files.
- GitHub Releases (`Kitware/CMake`): the same files, back-filled in 2018 to
  2.4.8. Used as a per-file mirror (see Mirrors).
- Release notes (`/cmake/help/latest/release/<X.Y>.html`) for OS support.

`scrape.py` needs `GITHUB_TOKEN` only to avoid the API rate limit. A full
run takes ~10 minutes (about 3,100 HEAD requests to cmake.org for sizes
of files GitHub doesn't carry with a matching hash, and ~800 to the distro
caches; 167 matched). It retries timeouts.

## What's recorded

3,760 entries, 275 versions, 46 minor lines (1.2 -> 4.4), final releases
only (no `-rc`). Windows x86 (1.4-4.4), x64 (3.6+), arm64 (3.24+); Linux
i386 (1.2-3.6), x86_64 (3.1+), aarch64 (3.19.3+); macOS universal/x86_64
(2.4+); Solaris x86_64 (4.0+); plus source `.tar.gz`/`.zip`.

- `variant` separates the macOS builds that share `arch: universal`:
  `darwin-universal` (PowerPC + i386, 2.4-3.1), `darwin64-universal`
  (i386 + x86_64, 3.0-3.1), `null` (x86_64 + arm64, 3.19+, needs 10.13) and
  `macos10.10` (the same pair built for 10.10, 3.19.3+).
- `libc: glibc` on Linux binaries.
- `2.4.2-2` is a Kitware re-spin of the 2.4.2 Mac build (`version` keeps the
  suffix).
- **Not recorded**: `v2.3` (11 date-stamped development snapshots), Cygwin
  packages (`-1.tar.bz2` / `-1-src.tar.bz2`, 32 files), and 508 files for
  platforms with no slot in the catalogue's OS/ARCH enums (AIX PowerPC,
  IRIX, HP-UX PA-RISC, Tru64 Alpha, Solaris SPARC including 4.x
  `sunos-sparc64`, and the PowerPC-only 1.x-2.2 Mac builds). Counts are
  printed by `scrape.py`.
- `gaps.json` is empty: no platform disappears for a single minor line and
  returns. Linux i386 ending at 3.6 and macOS Intel-only ending at 3.19 are
  vendor decisions, not gaps.

## Download plan

`download_plan.json`: newest patch per (minor, os, arch), preferring the
archive (`.zip`/`.tar.gz`) over installers, `.tar.gz` over `.tar.Z`, and the
macOS build without a variant suffix (the newest deployment target). 204
entries. `download_plan_majors.json` (via `tools/make_major_plans.py`) keeps one
version per true major and platform: 20 files, 0.8 GB -- 4.4.3 and 3.31.12
everywhere, plus the last build of platforms that ended (2.8.12.2 macOS
ppc/i386 universal, 3.6.3 Linux i386, 3.19.1 macOS x86_64-only, 2.4.2 macOS
i386, 1.8.3 and 2.8.12.2 Windows x86/Linux i386). **3.13.5 (the last for XP) and
4.2.8 (the last for Windows 7) are not in it**, because newer 3.x/4.x still
ship the same platforms; take them from `download_plan.json` if they are
to be downloaded.

## Old operating systems (the installer picks the newest that runs)

Measured from the binaries, not only the release notes:

| CMake | Windows | macOS | Linux x86_64 glibc |
| --- | --- | --- | --- |
| 2.8-3.13 | **XP** (PE subsystem 5.0/5.1 x86, 5.2 x64; no post-XP imports in 2.8.12.2, 3.0.2, 3.6.3, 3.10.3, 3.13.5) | 10.7 from 3.6 (minos measured on 3.6.3, 3.13.5) | 2.6 (3.13.5) |
| 3.14-4.2 | **7** (3.14 notes; subsystem 6.1 measured on 3.14.0 ... 4.2.8) | 10.7 to 3.18; 10.13 or 10.10 build from 3.19.3 | 2.6-2.10 to 3.18; 2.10 (3.19.8, 3.27.9); 2.17 from 3.28 (notes + 3.31.12) |
| 4.3-4.4 | **8** (subsystem 6.2; imports `CreateFile2`, `GetSystemTimePreciseAsFileTime`; **not in the release notes**) | 10.13 CLI / 10.10 build; cmake-gui 12 on the 10.13 build | 2.17; aarch64 2.28 |

- **Last for XP and Vista: 3.13.5** (x86 zip; x64 zip for XP x64).
- **Last for Windows 7: 4.2.8.** Bisected with HTTP range requests that
  pulled only `bin/cmake.exe` out of each zip: 4.2.0-4.2.8 are subsystem 6.1
  with no Windows 8 APIs; 4.3.0 is 6.2 for both x64 and i386.
- Linux glibc steps from 2.6 to 2.10 somewhere between 3.13.5 and 3.19.8
  (not bisected; each check needs a full ~40 MB tarball).
- 4.0 made `cmake_minimum_required(VERSION <3.5)` an error: older projects
  need `-DCMAKE_POLICY_VERSION_MINIMUM=3.5`, or CMake 3.x.

## Mirrors

- **github.com** (Kitware's own second channel): 3,381 files confirmed per
  file, by GitHub `digest` == vendor SHA-256 (3.0+) or by size (older, no
  digest). Zero mismatches.
- **Distro source caches** (source `.tar.gz` only, whatever the ports trees
  currently reference): Gentoo distfiles, FreeBSD distcache (http only),
  MacPorts distfiles. Per-file HEAD size match in `scrape.py`; one file
  each for Gentoo and FreeBSD downloaded and matched to the vendor SHA-256;
  bogus-name 404 control on all three.
- **None in China.** Huawei Cloud `/cmake/` is a soft-200 catch-all (same
  portal page for a bogus path); Aliyun, Tencent and npmmirror 404; the
  USTC/NJU/ISCAS/HUST/TUNA `github-release` mirrors don't carry Kitware/CMake.
- The PyPI `cmake` package (scikit-build) is a different, third-party
  build, not a mirror. It does exist for more Linux architectures and musl.

## Testing (2026-09-18, Linux only, no root)

3.13.5, 3.31.12 and 4.4.3 Linux x86_64 tarballs (vendor SHA-256 verified)
unpacked into a folder with a space; `--version`; hello-world C project
configured with `-G Ninja`, built and installed with Ninja 1.13.2 (3.13.5
also with Ninja 1.6.0) and the system gcc, using the exact `project_install`
command with tokens substituted and Ninja found only via PATH. An empty fake
`HOME` stayed empty. Windows and macOS recipes were not run.
