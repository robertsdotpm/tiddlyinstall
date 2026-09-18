# Java: OS support (newest version per system)

Researched 2026-09-18. Machine-readable data: `os_support.json` (same folder). Every cell is the newest release in `releases.json` whose rules allow that OS and architecture; `*` = needs an OS update (service pack / KB / point release, see the JSON row notes). `-` = nothing in the catalogue runs there; `n/a` = that OS does not exist for that architecture. Nothing here was run on a VM (`tested: false`); floors come from the binaries, see the rules' evidence.

## Windows

| System | amd64 | x86 | arm64 |
|---|---|---|---|
| Windows 2000 | n/a | - | n/a |
| Windows XP | n/a | 8.0.292 (zulu)* | n/a |
| Windows XP x64 | 8.0.292 (zulu)* | n/a | n/a |
| Windows Server 2003 | 8.0.292 (zulu)* | 8.0.292 (zulu)* | n/a |
| Windows Vista | 9.0.7 (zulu) | 9.0.7 (zulu) | n/a |
| Windows Server 2008 | 9.0.7 (zulu) | 9.0.7 (zulu) | n/a |
| Windows 7 | 26.0.2.1 (temurin) | 19.0.0 (zulu) | n/a |
| Windows Server 2008 R2 | 26.0.2.1 (temurin) | n/a | n/a |
| Windows 8 | 26.0.2.1 (temurin) | 19.0.0 (zulu) | n/a |
| Windows Server 2012 | 26.0.2.1 (temurin) | n/a | n/a |
| Windows 8.1 | 26.0.2.1 (temurin) | 19.0.0 (zulu) | n/a |
| Windows Server 2012 R2 | 26.0.2.1 (temurin) | n/a | n/a |
| Windows 10 | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 25.0.4.1 (zulu)* |
| Windows Server 2016 | 26.0.2.1 (temurin) | n/a | n/a |
| Windows Server 2019 | 26.0.2.1 (temurin) | n/a | n/a |
| Windows Server 2022 | 26.0.2.1 (temurin) | n/a | n/a |
| Windows 11 | 26.0.2.1 (temurin) | n/a | 25.0.4.1 (zulu) |
| Windows Server 2025 | 26.0.2.1 (temurin) | n/a | n/a |

## macOS

| System | amd64 | arm64 |
|---|---|---|
| macOS 10.3 Panther | - | n/a |
| macOS 10.4 Tiger | - | n/a |
| macOS 10.5 Leopard | - | n/a |
| macOS 10.6 Snow Leopard | - | n/a |
| macOS 10.7 Lion | - | n/a |
| macOS 10.8 Mountain Lion | - | n/a |
| macOS 10.9 Mavericks | 16.0.2 (temurin) | n/a |
| macOS 10.10 Yosemite | 16.0.2 (temurin) | n/a |
| macOS 10.11 El Capitan | 16.0.2 (temurin) | n/a |
| macOS 10.12 Sierra | 21.0.9 (temurin) | n/a |
| macOS 10.13 High Sierra | 21.0.9 (temurin) | n/a |
| macOS 10.14 Mojave | 21.0.9 (temurin) | n/a |
| macOS 10.15 Catalina | 21.0.9 (temurin) | n/a |
| macOS 11 Big Sur | 26.0.2.1 (temurin) | 26.0.2.1 (temurin) |
| macOS 12 Monterey | 26.0.2.1 (temurin) | 26.0.2.1 (temurin) |
| macOS 13 Ventura | 26.0.2.1 (temurin) | 26.0.2.1 (temurin) |
| macOS 14 Sonoma | 26.0.2.1 (temurin) | 26.0.2.1 (temurin) |
| macOS 15 Sequoia | 26.0.2.1 (temurin) | 26.0.2.1 (temurin) |
| macOS 26 Tahoe | 26.0.2.1 (temurin) | 26.0.2.1 (temurin) |

## Linux

| System | amd64 | x86 | arm64 | armv7 |
|---|---|---|---|---|
| glibc-2.5 (RHEL/CentOS 5) | 8.0.504 (temurin) | 8.0.504 (zulu) | - | 8.0.504 (temurin) |
| glibc-2.12 (RHEL/CentOS 6) | 26.0.2.1 (zulu) | 19.0.0 (zulu) | - | 13.0.4 (zulu) |
| glibc-2.17 (RHEL/CentOS 7) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 18.0.2.1 (temurin) |
| glibc-2.19 (Ubuntu 14.04, Debian 8) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.23 (Ubuntu 16.04) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.24 (Debian 9) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.27 (Ubuntu 18.04) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.28 (RHEL 8, Debian 10) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.31 (Ubuntu 20.04, Debian 11) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.34 (RHEL 9) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.35 (Ubuntu 22.04) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.36 (Debian 12) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.39 (Ubuntu 24.04) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |
| glibc-2.41 (Debian 13) | 26.0.2.1 (temurin) | 19.0.0 (zulu) | 26.0.2.1 (temurin) | 19.0.2 (temurin) |

## Where support changed (rules)

Each line is one rule from `os_support.json`: version range -> minimum OS (binary evidence unless noted).

- **linux amd64** (temurin-jre,temurin-jdk): `>=8,<9` glibc-2.5; `>=11,<12` glibc-2.12; `>=16,<20` glibc-2.12; `>=20,<25` glibc-2.17; `>=25,<27` glibc-2.17
- **linux amd64** (zulu-jre,zulu-jdk): `>=6,<9` glibc-2.5; `>=9,<11` glibc-2.12; `>=11,<15` glibc-2.12; `>=15,<27` glibc-2.12
- **linux arm64** (temurin-jre,temurin-jdk): `>=8,<27` glibc-2.17
- **linux arm64** (zulu-jre,zulu-jdk): `>=8,<15.0.4` glibc-2.17; `>=15.0.4,<15.0.6` glibc-2.31; `>=15.0.6,<27` glibc-2.17
- **linux armv7** (temurin-jre,temurin-jdk): `>=8,<9` glibc-2.5; `>=11,<19` glibc-2.17; `>=19,<20` glibc-2.19
- **linux armv7** (zulu-jre,zulu-jdk): `>=8,<9` glibc-2.5; `>=11,<11.0.20` glibc-2.12; `>=11.0.20,<12` glibc-2.17; `>=13,<14` glibc-2.12; `>=17,<18` glibc-2.27
- **linux x86** (zulu-jre,zulu-jdk): `>=7,<9` glibc-2.5; `>=9,<11` glibc-2.12; `>=11,<15` glibc-2.12; `>=15,<20` glibc-2.12
- **macos amd64** (temurin-jre,temurin-jdk): `>=8,<8.0.482` 10.9; `>=8.0.482,<9` 11; `>=11,<11.0.16` 10.9; `>=11.0.16,<11.0.30` 10.12; `>=11.0.30,<12` 11; `>=16,<17` 10.9; `>=17,<17.0.18` 10.12; `>=17.0.18,<18` 11; `>=18,<21.0.10` 10.12; `>=21.0.10,<27` 11
- **macos amd64** (zulu-jre,zulu-jdk): `>=7,<7.0.95` 10.9; `>=7.0.95,<7.0.262` 10.10; `>=7.0.262,<8.0.71` 10.9; `>=8.0.71,<8.0.252` 10.10; `>=8.0.252,<8.0.392` 10.9; `>=8.0.392,<8.0.462` 10.15; `>=8.0.462,<8.0.482` 10.14; `>=8.0.482,<9` 11; `>=9,<11.0.6` 10.10; `>=11.0.6,<11.0.11` 10.13; `>=11.0.11,<11.0.16` 10.9; `>=11.0.16,<11.0.30` 10.12; `>=11.0.30,<12` 11; `>=12,<13.0.7` 10.13; `>=13.0.7,<14` 10.9; `>=14,<15.0.2` 10.13; `>=15.0.2,<17` 10.9; `>=17,<17.0.18` 10.12; `>=17.0.18,<18` 11; `>=18,<21.0.10` 10.12; `>=21.0.10,<27` 11
- **macos arm64** (temurin-jre,temurin-jdk): `>=11,<27` 11
- **macos arm64** (zulu-jre,zulu-jdk): `>=8,<8.0.462` 11; `>=8.0.462,<8.0.482` 13; `>=8.0.482,<27` 11
- **windows amd64** (temurin-jre,temurin-jdk): `>=8,<27` 7
- **windows amd64** (zulu-jre,zulu-jdk): `>=6,<8.0.302` xp-x64 +XP SP3 / XP x64 SP2 / Server 2003 SP2 (VS2008+ C runtimes and EncodePointer need them); `>=8.0.302,<9` 7; `>=9,<10` vista; `>=10,<27` 7
- **windows arm64** (temurin-jre,temurin-jdk): `>=21,<24` 10 (build 16299)
- **windows arm64** (zulu-jre,zulu-jdk): `>=16,<26` 10 (build 16299)
- **windows x86** (zulu-jre,zulu-jdk): `>=7,<8.0.302` xp +XP SP3 / XP x64 SP2 / Server 2003 SP2 (VS2008+ C runtimes and EncodePointer need them); `>=8.0.302,<9` 7; `>=9,<10` vista; `>=10,<20` 7

## How the floors were measured

- 199 release series (vendor x os x arch x major, Temurin and Zulu, glibc builds only) from `releases.json`.
  For each series the first and last archive were downloaded and scanned; wherever the two floors
  differed the series was bisected down to adjacent releases, so every range boundary above is the
  exact release where the floor moved. Series whose sampled floors went down again later (Zulu
  macOS 7, 8, 11, 13, 15; Zulu linux-arm64 15) were scanned release by release. 678 archives
  were read; none were kept.
- JRE and JDK of the same vendor build were treated as one: one of them was scanned per release.
- Windows: `min_os` = the higher of the EXE subsystem version and the newest Windows function that
  the core runtime files import statically (java.exe, jvm.dll, java.dll, jli.dll, net, nio, zip,
  verify and the bundled msvcr100/msvcr120/msvcp140/vcruntime140). Optional libraries are listed in
  the evidence but do not set `min_os`: awt.dll imports d2d1.dll in some Zulu 9-12 releases, which needs Windows 7
  or Vista with the Platform Update, and sunmscapi.dll imports ncrypt.dll from 8u252, which needs
  Vista (only for the Windows-MY keystore). Delay-loaded Vista functions (SHGetKnownFolderPath,
  IcmpSendEcho2Ex) fall back gracefully at run time.
- Function ages come from ReactOS export tables (`-version=0x600+` etc.), corrected against the
  Microsoft Learn "Minimum supported client" (for example RaiseFailFastException is Windows 7, which
  ReactOS tags 8.1).

## Corrections to `limitations.json` (os_support text)

| Major | limitations.json says | Binaries in the catalogue show |
|---|---|---|
| 6 | Windows 2000/XP/2003/Vista (Sun) | The only build here (Zulu 6, amd64) is EXE subsystem 5.2: XP x64 / Server 2003 SP2 and later. Linux: glibc 2.4. |
| 7 | macOS "OS X 10.7.3 Lion and later" | That was Oracle's build. Zulu 7 (the only one here) needs 10.9 below 7.0.95, 10.10 for 7.0.95 up to (not including) 7.0.262, and 10.9 again from 7.0.262. Windows: x86 XP SP3, x64 XP x64 SP2 (confirmed). |
| 8 | Windows: "Vista SP2/7/8/8.1/10; XP dropped" | Zulu 8 up to 8.0.292 still loads on XP SP3 (x86) and XP x64/Server 2003 (x64): subsystem 5.1/5.2, no post-XP static imports in the core. Zulu 8.0.302+ and every Temurin 8 in the catalogue (8.0.302+) need Windows 7 (kernel32 K32EnumProcessModules, TryAcquireSRWLockExclusive in msvcp140). No release here needs Vista specifically. |
| 8 | macOS "OS X 10.7.3 Lion and later" | Temurin 8: 10.9 up to 8.0.472, macOS 11 from 8.0.482. Zulu 8 x64 moves around (half-open ranges): `<8.0.71` 10.9, `8.0.71-<8.0.252` 10.10, `8.0.252-<8.0.392` 10.9, `8.0.392-<8.0.462` 10.15, `8.0.462-<8.0.482` 10.14, `>=8.0.482` 11. Zulu 8 arm64: 11, except `8.0.462-<8.0.482`, which need macOS 13. |
| 9 | Windows 7/8/8.1/10 | Zulu 9 core needs only Vista (GetDynamicTimeZoneInformation, InitOnceExecuteOnce); AWT needs Windows 7 or Vista + Platform Update (d2d1). |
| 11 | Windows 7 SP1 | Loads on Windows 7 without SP1 (no SP1-only import); vendors state 7 SP1 or newer. |
| 11 | macOS 10.12+ | Temurin 11: `<11.0.16` 10.9, `11.0.16-<11.0.30` 10.12, `>=11.0.30` 11. Zulu 11: `<11.0.6` 10.10, `11.0.6-<11.0.11` 10.13, `11.0.11-<11.0.16` 10.9, `11.0.16-<11.0.30` 10.12, `>=11.0.30` 11. |
| 12-16 | Windows 8.1/10 | All load on Windows 7 (same K32* imports as 11); nothing needs 8.1. |
| 13, 15, 16 | 16: "macOS x86_64 only, native arm64 arrives in 17" | Zulu ships macOS arm64 builds of 13, 15 and 16 (and 11), minos 11. |
| 17 | Windows 8.1/10/11; macOS 10.13+ | Windows 7. macOS: 10.12 up to 17.0.17, macOS 11 from 17.0.18 (both vendors). |
| 17-19 | Linux "x86_64, arm64, armv7" / 19 "x86_64, arm64" | Zulu also ships 32-bit x86 Linux for 7-19; Temurin ships armv7 up to 19. |
| 18-26 | Windows 10/11 | x64 builds load on Windows 7 (EXE subsystem 6.0; newest import GetActiveProcessorCount/K32*, all Windows 7). x86 (Zulu, up to 19) the same. arm64 builds need Windows 10 1709+ on Arm. |
| 18-26 | macOS "Apple Silicon and x86_64" (no version) | x64: 10.12 for 18-20 and 21.0.0-21.0.9, macOS 11 from 21.0.10 and for 22-26. arm64: 11. |
| 20-26 | Linux (no glibc stated) | Temurin x64: glibc 2.9 for 16-19, 2.15 for 20-24, 2.17 for 25-26; Zulu x64 2.9 for 15-26 (so Zulu is the only 20+ build for RHEL/CentOS 6, glibc 2.12). aarch64 always 2.17. Temurin armv7 2.15 (11-18), 2.18 (19). |
| 24 | Windows "amd64 and arm64" | No Windows arm64 build of 24 exists in the catalogue (Temurin or Zulu). |

## Vendor documents versus binaries

- Adoptium's platform list (Windows 10/11 and Server 2019+, macOS 12+, glibc 2.17; up to 17 glibc 2.12)
  and Azul's (Windows 11 / Server 2016+, macOS 14+) are *support* statements for the current
  releases. The binaries load on much older systems: Windows 7 for every x86/x64 build since 8u302,
  macOS 10.12 for 17.0.0-17.0.17 and 21.0.0-21.0.9, 10.9 for Temurin 8 up to 8u472. Where the
  binary floor is lower the rule uses it and says so in `notes`; installers built from this table
  are offering unsupported-but-loadable builds on those systems.
- Adoptium's "versions up to 17 will work with glibc 2.12" agrees with the binaries (2.7 / 2.9);
  its "glibc 2.17 or higher" for 20+ is conservative (Temurin 20-24 need 2.15).
- The `install.json` recipe note "current Temurin builds need macOS 11 per the binaries" is right and
  now has exact first releases: 8u482, 11.0.30, 17.0.18, 21.0.10, and all of 22+.
- `install.json` says only Zulu 7 x86 can load on XP; Zulu 8 up to 8.0.292 can too (same method).

## Not settled

- Windows floors are static import analysis, not a run. XP/Vista claims (Zulu 6-9) are `medium`
  confidence until the VM pass confirms them; everything at Windows 7 is `high`.
- Windows 7 without SP1: no SP1-only function is imported, but the bundled VS2017+ CRT is only
  supported by Microsoft on SP1; treat 7 RTM as unverified.
- musl (Alpine) builds are not covered (no musl ids in `os_versions.json`).
- `.msi`/`.pkg`/`.deb`/`.rpm` installers inherit the archive rules; the installers' own OS checks
  (Windows Installer version, pkg `allowed-os-versions`) were not read.
