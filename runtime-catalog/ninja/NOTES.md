# Ninja runtime catalog notes

Build tool for CMake (`-G Ninja`) and Meson; catalogued for installer-builder's
build-on-the-user's-machine path (`docs/design.md` 1.8). `install.json`
recipes have no launch program; `project_install.path_prepend` puts the
folder on PATH for the other build tools.

## Sources

- `https://api.github.com/repos/ninja-build/ninja/releases` -- the only
  place binaries are published. One zip per platform with a single file.
- `.../tags` -- versions tagged without binaries.
- winget-pkgs manifests `manifests/n/Ninja-build/Ninja/<ver>/` for
  third-party SHA-256 (`checksum_corroboration`, 8 files: 1.11.1-1.13.2
  Windows zips).

**The Ninja project publishes no checksums or signatures.** `checksum` is
GitHub's upload `digest` where GitHub has one (only the 1.13.x assets, 15
files); everything older has `checksum: null`.

## What's recorded

63 files, 18 versions (1.4.0-1.13.2). Windows x86 (1.4.0-1.6.0) then x64
(1.7.1+), Windows arm64 (1.12+), Linux x86_64 (all), Linux aarch64 (1.12+),
macOS x86_64 (to 1.10.1) then universal (1.10.2+).

The zip names never say the architecture, and it changed. Every binary was
downloaded (all under 320 KB) and inspected:

- `ninja-win.zip`: PE i386, subsystem 5.1, kernel32 only for 1.4.0-1.6.0;
  PE x86-64, subsystem 6.0 from 1.7.1. From 1.11 it imports Vista APIs
  (`InitializeCriticalSectionEx`, `LCMapStringEx`; SRW locks from 1.12). No
  Windows 7/8-only APIs in any version.
- `ninja-winarm64.zip`: ARM64, subsystem 6.2 (Windows 10/11 on ARM).
- `ninja-mac.zip`: x86_64 minos 10.6 (1.4-1.8.2), 10.13 (1.9.0), 10.15
  (1.10.0), 10.12 (1.10.1); universal x86_64 10.12 + arm64 11.0 (1.10.2-1.11.1);
  universal 10.15 + 11.0 (1.12+).
- `ninja-linux.zip`: x86_64; highest GLIBC_ symbol 2.14 (1.4.0), 2.4
  (1.5.1-1.8.2), 2.15 (1.9.0+). `ninja-linux-aarch64.zip`: 2.17, except
  **1.13.0's aarch64 build needs glibc 2.38** (1.13.1 is back to 2.17).

## Gaps and oddities

- 1.0-1.3 (and two 2012 `release-*` tags): tagged, never shipped binaries
  (`gaps.json`, one entry per OS per line).
- 1.5.0, 1.7.0, 1.8.0, 1.8.1: tagged without a release; each line has a
  later patch with binaries, so not recorded as gaps.
- **1.7.2's `ninja-win.zip` returns 404** although the API still lists it
  (size 188,813). Left out of `releases.json` (recorded in `gaps.json`);
  1.7.1 is the Windows build for that line.

## Old operating systems

- **Windows XP, and any 32-bit Windows: 1.6.0** (the last x86 build).
- Windows Vista x64 and later: newest.
- macOS 10.6-10.11: 1.8.2; 10.12-10.14: 1.11.1; 10.15+: newest.
- Linux glibc 2.4-2.14: 1.8.2; 2.15+: newest.
- What the consumers need: Meson <0.54 needs ninja >=1.5, 0.54-0.56 >=1.7,
  0.57+ >=1.8.2 (read from `detect_ninja` in Meson's source at each tag).
  CMake's Ninja Multi-Config needs 1.10 and C++20 modules 1.11.

## Mirrors

None found for the vendor's own zips: the China `github-release` mirrors
(USTC, NJU, ISCAS, HUST, TUNA) don't carry ninja-build/ninja and npmmirror
has no `ninja` binary. The PyPI `ninja` package (scikit-build) is a separate
third-party build: an alternative source with many more Linux
architectures and musl wheels, not a mirror.

## Download plan

Newest patch per (minor, os, arch): 35 entries. `download_plan_majors.json`
keeps 1.13.2 for every platform plus 1.6.0 for Windows x86 and 1.10.1 for
macOS x86_64 (the newest builds of those arches).

## Testing (2026-09-18, Linux)

1.13.2 and 1.6.0 Linux zips unpacked into folders with spaces, `--version`,
then used by CMake 3.13.5/3.31.12/4.4.3 and Meson 1.11.1/1.12.0 to build a
hello-world C project, found through PATH only. The binary needs libstdc++,
libgcc_s, libm and libc from the system.
