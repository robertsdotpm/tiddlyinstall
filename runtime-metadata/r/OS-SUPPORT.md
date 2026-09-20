# R: OS support (newest version per system)

Researched 2026-09-18. Machine-readable data: `os_support.json` (same folder). Every cell is the newest release in `releases.json` whose rules allow that OS and architecture; `*` = needs an OS update (service pack / KB / point release, see the JSON row notes). `-` = nothing in the catalogue runs there; `n/a` = that OS does not exist for that architecture. Nothing here was run on a VM (`tested: false`); floors come from the binaries, see the rules' evidence.

## Windows

| System | amd64 | x86 |
|---|---|---|
| Windows 2000 | n/a | - |
| Windows XP | n/a | 3.6.0* |
| Windows XP x64 | 3.6.0* | n/a |
| Windows Server 2003 | 3.6.0* | 3.6.0* |
| Windows Vista | 4.2.3* | 4.1.3 |
| Windows Server 2008 | 4.2.3* | 4.1.3 |
| Windows 7 | 4.6.1* | 4.1.3 |
| Windows Server 2008 R2 | 4.6.1* | n/a |
| Windows 8 | 4.6.1* | 4.1.3 |
| Windows Server 2012 | 4.6.1* | n/a |
| Windows 8.1 | 4.6.1* | 4.1.3 |
| Windows Server 2012 R2 | 4.6.1* | n/a |
| Windows 10 | 4.6.1 | 4.1.3 |
| Windows Server 2016 | 4.6.1 | n/a |
| Windows Server 2019 | 4.6.1 | n/a |
| Windows Server 2022 | 4.6.1 | n/a |
| Windows 11 | 4.6.1 | n/a |
| Windows Server 2025 | 4.6.1 | n/a |

## macOS

| System | amd64 | arm64 |
|---|---|---|
| macOS 10.3 Panther | - | n/a |
| macOS 10.4 Tiger | - | n/a |
| macOS 10.5 Leopard | 2.15.3 | n/a |
| macOS 10.6 Snow Leopard | 3.1.3 | n/a |
| macOS 10.7 Lion | 3.1.3 | n/a |
| macOS 10.8 Mountain Lion | 3.1.3 | n/a |
| macOS 10.9 Mavericks | 3.3.3 | n/a |
| macOS 10.10 Yosemite | 3.3.3 | n/a |
| macOS 10.11 El Capitan | 3.6.3* | n/a |
| macOS 10.12 Sierra | 3.6.3 | n/a |
| macOS 10.13 High Sierra | 3.6.3 | n/a |
| macOS 10.14 Mojave | 4.2.3 | n/a |
| macOS 10.15 Catalina | 4.2.3 | n/a |
| macOS 11 Big Sur | 4.6.1 | 4.5.3 |
| macOS 12 Monterey | 4.6.1 | 4.5.3 |
| macOS 13 Ventura | 4.6.1 | 4.5.3 |
| macOS 14 Sonoma | 4.6.1 | 4.6.1 |
| macOS 15 Sequoia | 4.6.1 | 4.6.1 |
| macOS 26 Tahoe | 4.6.1 | 4.6.1 |

## Linux

| System | amd64 | arm64 |
|---|---|---|
| glibc-2.5 (RHEL/CentOS 5) | - | - |
| glibc-2.12 (RHEL/CentOS 6) | - | - |
| glibc-2.17 (RHEL/CentOS 7) | - | - |
| glibc-2.19 (Ubuntu 14.04, Debian 8) | - | - |
| glibc-2.23 (Ubuntu 16.04) | - | - |
| glibc-2.24 (Debian 9) | - | - |
| glibc-2.27 (Ubuntu 18.04) | - | - |
| glibc-2.28 (RHEL 8, Debian 10) | - | - |
| glibc-2.31 (Ubuntu 20.04, Debian 11) | - | - |
| glibc-2.34 (RHEL 9) | 4.6.1 (posit-rhel-9) | 4.6.1 (posit-rhel-9) |
| glibc-2.35 (Ubuntu 22.04) | 4.6.1 (posit-ubuntu-2204) | 4.6.1 (posit-ubuntu-2204) |
| glibc-2.36 (Debian 12) | - | - |
| glibc-2.39 (Ubuntu 24.04) | - | - |
| glibc-2.41 (Debian 13) | - | - |

## Where support changed (rules)

Each line is one rule from `os_support.json`: version range -> minimum OS (binary evidence unless noted).

- **linux amd64** (posit-rhel-9): `>=3.0.0,<=4.6.1` glibc-2.34 to glibc-2.34 [RHEL 9 and rebuilds]
- **linux amd64** (posit-ubuntu-2204): `>=3.0.0,<=4.6.1` glibc-2.35 to glibc-2.35 [Ubuntu 22.04]
- **linux arm64** (posit-rhel-9): `>=3.0.0,<=4.6.1` glibc-2.34 to glibc-2.34 [RHEL 9 and rebuilds]
- **linux arm64** (posit-ubuntu-2204): `>=3.0.0,<=4.6.1` glibc-2.35 to glibc-2.35 [Ubuntu 22.04]
- **macos amd64** (None): `>=3.0.0,<3.2.0` 10.6 [file ^R-[0-9.]+\.pkg$]; `>=3.2.0,<3.4.0` 10.9 [file ^R-[0-9.]+\.pkg$]; `>=3.4.0,<4.0.0` 10.11 [file ^R-[0-9.]+\.pkg$] +OS X / macOS 10.11.4 or later; `>=4.0.0,<4.0.4` 10.15 [file ^R-[0-9.]+\.pkg$]; `>=4.0.4,<=4.2.3` 10.14 [file ^R-[0-9.]+\.pkg$]; `>=4.3.0,<=4.6.1` 11 [file -x86_64\.pkg$]; `>=3.1.0,<3.1.2` 10.9 [file -mavericks\.pkg$]; `>=3.1.2,<=3.1.2` 10.10 [file -mavericks\.pkg$]; `>=2.10,<3.0` 10.5 [file ^R-[0-9.]+\.pkg$]
- **macos arm64** (None): `>=4.1.0,<4.1.3` 11 [file -arm64\.pkg$]; `>=4.1.3,<4.2.0` 26 [file -arm64\.pkg$]; `>=4.2.0,<4.4.3` 12 [file -arm64\.pkg$]; `>=4.4.3,<=4.5.3` 11 [file -arm64\.pkg$]; `>=4.6.0,<=4.6.1` 14 [file -arm64\.pkg$]
- **windows amd64** (None): `>=2.12.0,<4.2.0` xp-x64 +XP SP3 / XP x64 SP2 / Server 2003 SP2 (VS2008+ C runtimes and EncodePointer need them); `>=4.2.0,<4.3.0` vista +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=4.3.0,<4.4.3` 7 +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=4.4.3,<=4.6.1` vista +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=2.12,<3.6.1` xp-x64; `>=3.6.1,<4.4.0` vista; `>=4.4.0` 7
- **windows x86** (None): `>=2.12.0,<3.3.0` xp +XP SP3 / XP x64 SP2 / Server 2003 SP2 (VS2008+ C runtimes and EncodePointer need them); `>=1.0.0,<=2.11.1` xp +XP SP3 / XP x64 SP2 / Server 2003 SP2 (VS2008+ C runtimes and EncodePointer need them); `>=3.3.0,<4.2` xp +XP SP3 / XP x64 SP2 / Server 2003 SP2 (VS2008+ C runtimes and EncodePointer need them); `>=2.12,<3.6.1` 2000; `>=3.6.1,<4.4.0` vista

## How the floors were measured

- 11 build flavours from `releases.json` (Windows 32-bit-only 1.0-2.11, Windows combined/64-bit
  2.12-4.6, the macOS CRAN flavours, Posit's Ubuntu 22.04 and RHEL 9 builds). First and last
  installer of each flavour scanned, bisected to adjacent releases wherever the floor changed; the
  non-monotonic big-sur-arm64 flavour was scanned release by release. 44 installers read. Old CRAN
  files came through the Wayback Machine copies listed as mirrors in `releases.json`
  (cran-archive.r-project.org itself was serving under 1 KB/s).
- Windows: Inno Setup installers unpacked with innoextract 1.9; R's own files (R.dll, Rblas,
  Rlapack, Rgraphapp, Riconv, R/Rgui/Rterm/Rscript.exe) judged per machine, because 2.12-4.1 ship i386
  and x64 R in one installer. The installer's Inno Setup `MinVersion`, which setup enforces, is a
  second rule: 0,5.0 (Windows 2000) up to 3.6.0, 0,6.0 (Vista) for 3.6.1-4.3.x, 0,6.1 (Windows 7)
  from 4.4.0 (R sources: `src/gnuwin32/installer/header1.iss` on the R-3-5, R-3-6, R-4-3 and R-4-4
  branches). Both rules must pass.
- macOS: flat .pkg unpacked in Python (xar + gzip/pbzx cpio). The optional Tcl/Tk and Texinfo
  sub-packages are left out of the floor (texinfo alone would push 4.2-4.4.2 arm64 to 12 and 4.6 to
  14). R 2.x binaries have no minos load command, so the pkg's own Distribution check (10.5) is used.
- Linux: Posit builds are distro-locked (Ubuntu 22.04 .deb links libicu*.so.70, libtiff.so.5,
  libjpeg.so.8; RHEL 9 .rpm links libicu*.so.67, libjpeg.so.62, libflexiblas), so each is pinned
  with `min_os` = `max_os` to its distro's glibc id (glibc-2.35 / glibc-2.34). `install.json` already
  found the 22.04 build does not run on 24.04.

## Corrections to `limitations.json` (os_support text)

| Major | limitations.json says | Binaries / installer show |
|---|---|---|
| 1.x-2.11 | Windows 95/98/NT4/2000 (and "XP/Vista/7" for 2.11) | EXE subsystem 4.0, no post-XP import: loads on XP SP3; whether it still runs on 2000/9x cannot be decided from ReactOS-based tables (not tested). |
| 2.12-2.15 | Windows XP/Vista/7 | Also XP x64 / Server 2003 (x64 R, subsystem 5.2); installer MinVersion 5.0. |
| 3.0-3.2 | Windows "XP SP3/Vista/7/8/8.1" | Agrees (XP SP3); installer MinVersion 5.0. |
| 3.3-3.6 | Windows "Vista/7/8/8.1/10 (XP no longer supported)" | Binaries of 3.3-3.6 still load on XP (core imports XP-level; only optional DLLs need Vista) and the installer only blocks XP from 3.6.1 (MinVersion 0,6.0). So 3.6.0 is the newest R that installs on XP / Server 2003. |
| 4.0-4.1 | Windows "7 SP1/8/8.1/10/11" | Binaries XP-level; installer needs Vista (3.6.1+ MinVersion). Newest for Vista (32 and 64-bit): 4.1.3 (64-bit: 4.2.3 with the UCRT update). |
| 4.2-4.4 | Windows "7 SP1/8.1/10/11, 64-bit, UCRT" | 4.2.x binaries need only Vista + UCRT (KB2999226); 4.3.0-4.4.2 import ResolveLocaleName (Windows 7); 4.4.3+ back to Vista-level imports, but the installer requires Windows 7 from 4.4.0. |
| 4.5-4.6 | Windows 10/11 | Installer allows Windows 7 (MinVersion 0,6.1) and the binaries load there with the UCRT update; R Core only tests 10+. |
| 3.0-3.2 | macOS "10.6 to 10.8 and higher" | The base pkgs are Snow Leopard builds: 10.6 for 3.0.0-3.1.3; 3.2.0-3.3.3 need 10.9 (the base directory switched to the Mavericks build at 3.2.0). |
| 3.1 (mavericks pkg) | - | R-3.1.0/3.1.1-mavericks.pkg need 10.9, R-3.1.2-mavericks.pkg needs 10.10 (its `R` binary). |
| 3.3-3.5 | macOS "10.9 (Mavericks) and higher" | 3.3.x 10.9 agrees; 3.4.0-3.6.3 need OS X 10.11.4 (bundled libgcc_s/libgfortran minos 10.11.4), not plain 10.11 and not 10.9 for 3.4/3.5. |
| 4.0 | macOS 10.13 | 4.0.0-4.0.3 need 10.15 (R.app's `sush` helper; the framework itself is older); 4.0.4-4.2.3 need 10.14 (libgfortran.5.dylib). CRAN says 10.13. |
| 4.1-4.2 | arm64 "macOS 11" | 4.1.0-4.1.2: 11. 4.1.3: `R` and `Rscript` carry minos 20.0 (see notes; rule says 26, confidence low). 4.2.0-4.4.2: 12. 4.4.3-4.5.3: 11 again. |
| 4.6 | arm64 macOS 14 | Agrees (fc-cache in the framework is 14; libR itself 13). |
| 3.0+ | Linux "Posit .deb (Ubuntu 22.04) and .rpm (RHEL 9)" | Right, and each is locked to that distro release (sonames above); glibc floors 2.35 / 2.34. |

## Vendor documents versus binaries

- CRAN's macOS pages understate some floors (4.0.x "10.13" vs 10.15 / 10.14 in the binaries) and
  overstate others (the FAQ's Windows 10+ for current R, while the installer allows 7).
- R-admin / rw-FAQ say R 4.2+ needs the UCRT; the binaries agree (they import api-ms-win-crt-*,
  not bundled), so on Vista SP2 - 8.1 KB2999226 is required.

## Not settled

- Windows 2000 / 9x for R 1.x-2.11: plausible (subsystem 4.0) but not provable from the import
  tables used; `min_os` says xp.
- The 4.1.3 arm64 minos 20.0 anomaly (probably harmless in practice) is untested.
- Windows floors are static analysis; the VM pass should confirm XP (3.6.0) and Vista (4.1.3/4.2.3).
- Windows interior releases were bisected, not all scanned: the 64-bit series went vista -> 7 -> vista
  (4.3.0 / 4.4.3), so another blip between two equal samples cannot be ruled out (all sampled
  boundaries are exact).
- R for Windows on ARM (native since 4.4) and the macOS Tiger / ppc builds are not in the catalogue.
- The 32-bit R in the 2.12-4.1 `R-x.y.z-win.exe` installers is catalogued under `amd64`; the x86
  rules and x86 `max_per_os` rows describe that same file.
