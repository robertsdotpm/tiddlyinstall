# .NET: OS support (newest version per system)

Researched 2026-09-18. Machine-readable data: `os_support.json` (same folder). Every cell is the newest release in `releases.json` whose rules allow that OS and architecture; `*` = needs an OS update (service pack / KB / point release, see the JSON row notes). `-` = nothing in the catalogue runs there; `n/a` = that OS does not exist for that architecture. Nothing here was run on a VM (`tested: false`); floors come from the binaries, see the rules' evidence.

## Windows

| System | amd64 runtime | amd64 windowsdesktop | amd64 framework | x86 runtime | x86 windowsdesktop | arm64 runtime | arm64 windowsdesktop | armv7 runtime |
|---|---|---|---|---|---|---|---|---|
| Windows 2000 | n/a | n/a | n/a | - | - | n/a | n/a | n/a |
| Windows XP | n/a | n/a | n/a | - | - | n/a | n/a | n/a |
| Windows XP x64 | - | - | 4.0* | n/a | n/a | n/a | n/a | n/a |
| Windows Server 2003 | - | - | 4.0* | - | - | n/a | n/a | n/a |
| Windows Vista | - | - | 4.6* | - | - | n/a | n/a | n/a |
| Windows Server 2008 | - | - | 4.6.2* | - | - | n/a | n/a | n/a |
| Windows 7 | 10.0.12* | 10.0.12* | 4.8* | 10.0.12* | 10.0.12* | n/a | n/a | n/a |
| Windows Server 2008 R2 | 10.0.12* | 10.0.12* | 4.8* | n/a | n/a | n/a | n/a | n/a |
| Windows 8 | 10.0.12* | 10.0.12* | 4.6.1 | 10.0.12* | 10.0.12* | n/a | n/a | n/a |
| Windows Server 2012 | 10.0.12* | 10.0.12* | 4.8 | n/a | n/a | n/a | n/a | n/a |
| Windows 8.1 | 10.0.12* | 10.0.12* | 4.8 | 10.0.12* | 10.0.12* | n/a | n/a | n/a |
| Windows Server 2012 R2 | 10.0.12* | 10.0.12* | 4.8 | n/a | n/a | n/a | n/a | n/a |
| Windows 10 | 10.0.12 | 10.0.12 | 4.8.1* | 10.0.12 | 10.0.12 | 10.0.12* | 10.0.12* | 3.1.32* |
| Windows Server 2016 | 10.0.12 | 10.0.12 | 4.8 | n/a | n/a | n/a | n/a | n/a |
| Windows Server 2019 | 10.0.12 | 10.0.12 | 4.8 | n/a | n/a | n/a | n/a | n/a |
| Windows Server 2022 | 10.0.12 | 10.0.12 | 4.8.1 | n/a | n/a | n/a | n/a | n/a |
| Windows 11 | 10.0.12 | 10.0.12 | 4.8.1 | n/a | n/a | 10.0.12 | 10.0.12 | n/a |
| Windows Server 2025 | 10.0.12 | 10.0.12 | 4.8.1 | n/a | n/a | n/a | n/a | n/a |

## macOS

| System | amd64 runtime | arm64 runtime |
|---|---|---|
| macOS 10.3 Panther | - | n/a |
| macOS 10.4 Tiger | - | n/a |
| macOS 10.5 Leopard | - | n/a |
| macOS 10.6 Snow Leopard | - | n/a |
| macOS 10.7 Lion | - | n/a |
| macOS 10.8 Mountain Lion | - | n/a |
| macOS 10.9 Mavericks | - | n/a |
| macOS 10.10 Yosemite | - | n/a |
| macOS 10.11 El Capitan | 1.1.2 | n/a |
| macOS 10.12 Sierra | 2.2.8 | n/a |
| macOS 10.13 High Sierra | 6.0.1 | n/a |
| macOS 10.14 Mojave | 7.0.20 | n/a |
| macOS 10.15 Catalina | 8.0.31 | n/a |
| macOS 11 Big Sur | 8.0.31 | 8.0.31 |
| macOS 12 Monterey | 10.0.12 | 10.0.12 |
| macOS 13 Ventura | 10.0.12 | 10.0.12 |
| macOS 14 Sonoma | 10.0.12 | 10.0.12 |
| macOS 15 Sequoia | 10.0.12 | 10.0.12 |
| macOS 26 Tahoe | 10.0.12 | 10.0.12 |

## Linux

| System | amd64 runtime | arm64 runtime | armv7 runtime |
|---|---|---|---|
| glibc-2.5 (RHEL/CentOS 5) | - | - | - |
| glibc-2.12 (RHEL/CentOS 6) | 3.1.11 | - | 3.1.32 |
| glibc-2.17 (RHEL/CentOS 7) | 9.0.20 | 9.0.20 | 8.0.31 |
| glibc-2.19 (Ubuntu 14.04, Debian 8) | 9.0.20 | 9.0.20 | 8.0.31 |
| glibc-2.23 (Ubuntu 16.04) | 9.0.20 | 9.0.20 | 8.0.31 |
| glibc-2.24 (Debian 9) | 9.0.20 | 9.0.20 | 8.0.31 |
| glibc-2.27 (Ubuntu 18.04) | 10.0.12 | 10.0.12 | 8.0.31 |
| glibc-2.28 (RHEL 8, Debian 10) | 10.0.12 | 10.0.12 | 8.0.31 |
| glibc-2.31 (Ubuntu 20.04, Debian 11) | 10.0.12 | 10.0.12 | 8.0.31 |
| glibc-2.34 (RHEL 9) | 10.0.12 | 10.0.12 | 10.0.12 |
| glibc-2.35 (Ubuntu 22.04) | 10.0.12 | 10.0.12 | 10.0.12 |
| glibc-2.36 (Debian 12) | 10.0.12 | 10.0.12 | 10.0.12 |
| glibc-2.39 (Ubuntu 24.04) | 10.0.12 | 10.0.12 | 10.0.12 |
| glibc-2.41 (Debian 13) | 10.0.12 | 10.0.12 | 10.0.12 |

## Where support changed (rules)

Each line is one rule from `os_support.json`: version range -> minimum OS (binary evidence unless noted).

- **linux amd64** (runtime,aspnetcore,sdk): `>=2.0,<3.2` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=5.0,<6.1` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=7.0,<9.1` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=10.0,<10.1` glibc-2.27 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=1.0,<1.2` glibc-2.17 to glibc-2.17 [CentOS 7] [file ^dotnet-centos-x64\.[0-9]]; `>=1.0,<1.2` glibc-2.19 to glibc-2.19 [Debian 8] [file ^dotnet-debian-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.24 to glibc-2.24 [Debian 9] [file ^dotnet-debian\.9-x64\.[0-9]]; `>=1.0,<1.2` glibc-2.17 to glibc-2.17 [Fedora 23 (glibc 2.22)] [file ^dotnet-fedora\.23-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.17 to glibc-2.17 [Fedora 24 (glibc 2.23)] [file ^dotnet-fedora\.24-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.17 to glibc-2.17 [Fedora 27 (glibc 2.26)] [file ^dotnet-fedora\.27-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.27 to glibc-2.27 [Fedora 28 (glibc 2.27)] [file ^dotnet-fedora\.28-x64\.[0-9]]; `>=1.0,<1.2` glibc-2.17 to glibc-2.17 [openSUSE 13.2 (glibc 2.19)] [file ^dotnet-opensuse\.13\.2-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.17 to glibc-2.17 [openSUSE Leap 42.1 (glibc 2.19)] [file ^dotnet-opensuse\.42\.1-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.17 to glibc-2.17 [openSUSE Leap 42.3 (glibc 2.22)] [file ^dotnet-opensuse\.42\.3-x64\.[0-9]]; `>=1.0,<1.2` glibc-2.17 to glibc-2.17 [RHEL 7] [file ^dotnet-rhel-x64\.[0-9]]; `>=2.1,<3.2` glibc-2.12 [file -rhel\.6-x64\.tar\.gz$]; `>=1.0,<1.2` glibc-2.19 to glibc-2.19 [Ubuntu 14.04] [file ^dotnet-ubuntu-x64\.[0-9]]; `>=1.0,<1.2` glibc-2.23 to glibc-2.23 [Ubuntu 16.04] [file ^dotnet-ubuntu\.16\.04-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.17 to glibc-2.17 [Ubuntu 16.10 (glibc 2.24)] [file ^dotnet-ubuntu\.16\.10-x64\.[0-9]]; `>=1.1,<1.2` glibc-2.27 to glibc-2.27 [Ubuntu 18.04] [file ^dotnet-ubuntu\.18\.04-x64\.[0-9]]
- **linux arm64** (runtime,aspnetcore,sdk): `>=2.1,<6.1` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=7.0,<7.0.4` glibc-2.27 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=7.0.4,<9.1` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=10.0,<10.1` glibc-2.27 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]
- **linux armv7** (runtime,aspnetcore,sdk): `>=2.1,<3.2` glibc-2.12 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=5.0,<6.1` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=7.0,<7.1` glibc-2.27 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=8.0,<8.1` glibc-2.17 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]; `>=9.0,<10.1` glibc-2.34 [file -linux-(x64|arm64|arm)\.(tar\.gz|zip)$]
- **macos amd64** (runtime,aspnetcore,sdk): `>=1.0,<1.0.7` 10.11; `>=1.0.7,<1.1` 10.12; `>=1.1,<1.1.4` 10.11; `>=1.1.4,<2.1.30` 10.12; `>=2.1.30,<2.2` 10.13; `>=2.2,<2.3` 10.12; `>=3.0,<3.1.20` 10.14; `>=3.1.20,<3.2` 10.15; `>=5.0,<6.0.2` 10.13; `>=6.0.2,<7.1` 10.14; `>=8.0,<8.1` 10.15; `>=9.0,<10.1` 12
- **macos arm64** (runtime,aspnetcore,sdk): `>=6.0,<8.1` 11; `>=9.0,<10.1` 12
- **windows amd64** (runtime,aspnetcore,sdk,windowsdesktop): `>=1.0,<1.2` 7 +SP1, KB2533623 (or Windows 8+), KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=2.0,<3.1.13` 7; `>=3.1.13,<3.2` 7 +SP1; `>=5.0,<5.0.4` 7; `>=5.0.4,<6.1` 7 +SP1; `>=7.0,<10.1` 7 +SP1, KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+)
- **windows amd64** (windowsdesktop): `>=6.0,<6.0.11` vista +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=6.0.11,<10.1` 7 +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+)
- **windows arm64** (runtime,aspnetcore,sdk,windowsdesktop): `>=2.1,<2.3` 10 (build 16299); `>=5.0,<10.1` 10 (build 16299)
- **windows arm64** (windowsdesktop): `>=6.0,<6.0.5` 10 (build 16299); `>=6.0.5,<10.1` 10 (build 16299)
- **windows armv7** (runtime,aspnetcore,sdk,windowsdesktop): `>=2.1,<3.2` 10 (build 16299)
- **windows x86** (runtime,aspnetcore,sdk,windowsdesktop): `>=1.0,<1.2` 7 +SP1, KB2533623 (or Windows 8+), KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=2.0,<3.1.13` 7; `>=3.1.13,<3.2` 7 +SP1; `>=5.0,<5.0.4` 7; `>=5.0.4,<6.1` 7 +SP1; `>=7.0,<10.1` 7 +SP1, KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+)
- **windows x86** (windowsdesktop): `>=6.0,<6.0.11` vista +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+); `>=6.0.11,<10.1` 7 +KB2999226 Universal C Runtime (Vista SP2 / 7 SP1 / 8 / 8.1; built into 10+)
- **windows amd64,x86** (None): `==3.5` xp to server2025 +XP SP2 / XP x64 SP1 / Server 2003 SP1 or later; `==4.0` xp to server2008r2 +XP SP3 / XP x64 SP2 / Server 2003 SP2 / Vista SP1 / Server 2008 SP2; `==4.5.1` vista to server2012r2 +Vista SP2 / Server 2008 SP2 / 7 SP1 / Server 2008 R2 SP1; `==4.5.2` vista to server2012r2 +Vista SP2 / Server 2008 SP2 / 7 SP1 / Server 2008 R2 SP1; `==4.6` vista to 10 +Vista SP2 / Server 2008 SP2 / 7 SP1 / Server 2008 R2 SP1; `==4.6.1` 7 to 10 +7 SP1 / Server 2008 R2 SP1; `==4.6.2` server2008 to server2016 +Server 2008 SP2 / 7 SP1 / Server 2008 R2 SP1; `==4.7` 7 to server2016 +7 SP1 / Server 2008 R2 SP1, Windows 10 version 1607 (build 14393) or later; `==4.7.1` 7 to server2016 +7 SP1 / Server 2008 R2 SP1, Windows 10 version 1607 (build 14393) or later; `==4.7.2` 7 to server2019 +7 SP1 / Server 2008 R2 SP1, Windows 10 version 1607 (build 14393) or later; `==4.8` 7 to 11 +7 SP1 / Server 2008 R2 SP1, Windows 10 version 1607 (build 14393) or later
- **windows amd64,x86,arm64** (None): `==4.8.1` 10 (build 19042) to server2025

## How the floors were measured

- 124 release series (runtime and Windows Desktop runtime, per os/arch/major; the .NET Core 1.x Linux
  builds per distro; the 2.1-3.1 `rhel.6-x64` builds separately) from `releases.json`. First and last
  archive of each series scanned, bisected to adjacent releases wherever the floor changed; the one
  series that went down again (linux-arm64 7.0) was scanned release by release. 465 archives read.
- Windows: `min_os` = the higher of the EXE subsystem version (dotnet.exe) and the newest function
  imported statically by the core files (dotnet.exe, hostfxr, hostpolicy, coreclr, clrjit,
  System.*.Native, clrcompression). For the Windows Desktop runtime all its own DLLs count (it has no
  EXE). Not counted: delay-loaded WinRT API sets in coreclr (Windows 8, only for WinRT interop) and
  msquic.dll (Windows 8 functions; QUIC only works on Windows 11 / Server 2022 anyway), which is why
  some rules' evidence says "optional libraries need 8".
- UCRT: 2.0-6.0 carry the Universal CRT app-locally (ucrtbase.dll + api-ms-win-*.dll), 1.x and 7.0+
  use the system copy, which Windows 10+ has built in and Vista SP2 - 8.1 get from KB2999226.
- .NET Framework: rules from Microsoft's version and system-requirement tables
  (github.com/dotnet/docs `versions-and-dependencies.md`, `system-requirements.md`). The offline
  installers' own PE headers (subsystem 4.0 / 5.1) do not limit anything; setup's built-in OS
  blocks do. `built_in` lists the Windows ids that ship each version.

## .NET Framework: built in versus installer

| Windows | Ships with | Newest installable (catalogue) | Notes |
|---|---|---|---|
| XP / XP x64 / Server 2003 | none (2003: 1.1) | 4.0 (XP SP3, XP x64 SP2, 2003 SP2) | 3.5 SP1 also installs (XP SP2+) |
| Vista | 2.0 + 3.0 | 4.6 (Vista SP2) | 3.5 needs the installer |
| Server 2008 | 2.0 + 3.0 | 4.6.2 (SP2) | Server 2008 SP2 got 4.6.2; Vista did not |
| 7 / Server 2008 R2 | 3.5.1 (feature) | 4.8 (SP1) | 3.5 is a Windows feature; 4.x via installer |
| 8 | 4.5 (+3.5 as Feature on Demand) | 4.6.1 | 4.6.2+ never supported Windows 8 client |
| Server 2012 | 4.5 (+3.5 FoD) | 4.8 | |
| 8.1 / Server 2012 R2 | 4.5.1 (+3.5 FoD) | 4.8 | |
| 10 | 4.6 (1507) ... 4.8 (1903+) (+3.5 FoD) | 4.8.1 on 20H2 (19042) and later | 4.7-4.8 need 1607+; 4.8.1 needs 20H2+ |
| Server 2016 | 4.6.2 (+3.5 FoD) | 4.8 | |
| Server 2019 | 4.7.2 (+3.5 FoD) | 4.8 | 4.8.1 not supported |
| Server 2022 | 4.8 (+3.5 FoD) | 4.8.1 | |
| 11 | 4.8 (21H2), 4.8.1 (22H2+) (+3.5 FoD) | 4.8.1 | |
| Server 2025 | 4.8.1 (+3.5 FoD) | 4.8.1 | |

"3.5 FoD": 3.5 (with 2.0/3.0) is an optional Windows feature; `dotnetfx35.exe` or
`DISM /Online /Enable-Feature /FeatureName:NetFx3` enables it, fetching from Windows Update or the
install media. The catalogue has no 4.5 installer (4.5.1 and later only). The Framework offline
installers are catalogued as `amd64` but are x86+x64 ("AllOS") and install on 32-bit Windows too; the
Framework rules list both arches, the `max_per_os` rows only show amd64 because that is the
catalogue's arch for those files.

## Corrections to `limitations.json` (os_support text)

| Major | limitations.json says | Binaries / tables show |
|---|---|---|
| 1.0, 1.1 | Windows 7 SP1+ | Also needs KB2533623 (hostpolicy.dll imports AddDllDirectory) and the system UCRT (KB2999226): these builds do not carry the UCRT. |
| 1.0, 1.1 | macOS 10.11+ | 10.11 only up to 1.0.5 / 1.1.2; 1.0.7+ and 1.1.4+ need 10.12 (their libuv.dylib is built for 10.12). |
| 1.0, 1.1 | Linux distro list | Right distros, but each build links that distro's own ICU/OpenSSL sonames (for example libicuuc.so.50 + libssl.so.10 for CentOS 7, libicuuc.so.55 + libssl.so.1.0.0 for Ubuntu 16.04), so a build only runs on its own distro release. glibc floor 2.14 everywhere (2.27 for the Fedora 28 and Ubuntu 18.04 builds). |
| 2.0-3.1 | Windows 7 SP1+ | 2.0 - 3.1.12 load on Windows 7 without SP1 (UCRT bundled, newest import is Windows 7 RTM); 3.1.13+ need SP1 (coreclr imports InitializeContext / GetEnabledXStateFeatures, Windows 7 SP1). |
| 2.1 | macOS 10.12+ | 2.1.30 (the last 2.1) needs 10.13. |
| 3.0 | macOS 10.13+ | All 3.0 builds need 10.14 (System.IO.Compression.Native.dylib minos 10.14). 3.1: 10.14 up to 3.1.19, 10.15 from 3.1.20. |
| 2.1-3.1 | Linux (RHEL 6 not explicit) | The `rhel.6-x64` builds need only glibc 2.11 (RHEL/CentOS 6 works); the portable linux-x64 builds need 2.14 (so RHEL 7+). linux-arm needs only 2.11. |
| 5.0 | Windows 7 SP1+ | 5.0.0 - 5.0.3 load on 7 RTM; 5.0.4+ need SP1. |
| 6.0 | macOS "11+ Intel and Apple Silicon" | x64 needs only 10.13 (6.0.0-6.0.1) / 10.14 (6.0.2+); arm64 11. |
| 6.0 | Linux "adds Arm64 across the board" | linux-arm64 exists since 2.1 (glibc 2.17). |
| 7.0 | Windows "10+ only; 7, 8, 8.1 dropped" | Dropped from *support* only. The binaries still load on Windows 7 SP1 / 8 / 8.1 with the system UCRT (KB2999226); the same holds for 8.0, 9.0 and 10.0. |
| 7.0 | macOS 12+ | x64 needs 10.14, arm64 11. |
| 7.0 | Linux RHEL 7+ | x64 glibc 2.17; linux-arm64 7.0.0 - 7.0.3 need glibc 2.27 (built on a newer image by mistake), 7.0.4+ back to 2.17; linux-arm 2.27. |
| 8.0 | macOS 12+ | x64 needs 10.15, arm64 11. |
| 8.0 | Linux "RHEL 8+, Ubuntu 20.04+" (docs libc table: glibc 2.23) | glibc 2.17 on x64, arm64 and arm: runs on RHEL/CentOS 7. |
| 9.0 | macOS 13+ | x64 and arm64 need macOS 12. |
| 9.0 | Linux "RHEL 8+, Ubuntu 22.04+" (docs: 2.23, arm32 2.35) | x64 and arm64 glibc 2.17; arm32 glibc 2.34 (docs say 2.35). |
| 10.0 | macOS 14+ | x64 and arm64 need macOS 12. |
| 10.0 | Linux (docs: 2.27, arm32 2.35) | x64/arm64 2.27 (agrees), arm32 2.34. |
| framework-3.5 | XP SP2+, Vista, 2003 SP1+/2008 | Also: built into Windows 7 / 2008 R2 (3.5.1); a Feature on Demand on 8 and later. |
| framework-4.6.2 | "same baseline" | Not Vista and not Windows 8 client, but Server 2008 SP2 yes. |
| framework-4.8.1 | "Windows 11 22H2 and Server 2022" | Installable on Windows 10 20H2+ and 11 21H2 too; built into 11 22H2+ and Server 2025; not Server 2019. |

## Vendor documents versus binaries

- The dotnet/core `supported-os.md` files list the OS versions *in support*, which for old
  releases now means only current OSes (for example 6.0 lists macOS 13-15). They are not floors.
  The binaries are much more permissive: every .NET from 2.0 to 10.0 loads on Windows 7 (SP1 from
  3.1.13/5.0.4 on; UCRT update from 7.0 on); macOS x64 floors are 10.12-10.15 up to 8.0 and 12 for
  9.0/10.0, although the docs say 12/13/14.
- Linux libc tables: binaries need less than the docs for 8.0 and 9.0 (2.17 vs 2.23) and arm32
  9.0/10.0 (2.34 vs 2.35); 6.0/7.0/10.0 x64 agree.
- `install.json` (recipes) already had the macOS minos per major; it is now exact per release, with
  the 2.1.30 / 3.1.20 / 6.0.2 steps.

## Data issues found in `releases.json`

- Some Windows/Linux/macOS *runtime* entries carry SDK-band version labels (for example version
  `2.1.801` and `2.1.700` on the `dotnet-runtime-2.1.12` / `2.1.11` files, `2.2.300` on 2.2.5). Rules
  are keyed by the runtime version in the URL; `max_per_os` skips entries whose label is not in the
  file name.
- The .NET Core 1.x Linux SDK entries (`dotnet-dev-<distro>-x64...`) match no rule: they are per-distro
  and were not scanned (EOL since 2019).

## Not settled

- Windows floors are static import analysis, not a run (the VM pass covers that). The Windows 7
  RTM results for 2.0-3.1.12 and 5.0.0-5.0.3 are `medium`.
- Windows 10 on Arm: every arm64/arm build is marked `min_build` 16299 (1709, the first release
  with native Arm64 apps); nothing narrower was checked.
- .NET Core 1.x distro builds for Fedora, openSUSE and Ubuntu 16.10 have no matching catalogue
  glibc id; their rules carry a `distro` field and are left out of `max_per_os`.
- musl (Alpine) builds are not covered.
