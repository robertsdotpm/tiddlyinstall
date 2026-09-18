# Python: newest version per operating system

Researched 2026-09-18. The machine-readable version is `os_support.json`
in this folder (rules with evidence, plus `max_per_os`). This page is the
human summary.

**How it was checked:**

- **Windows:** PE headers and every imported function of every `.exe`,
  `.dll` and `.pyd` in all 262 embeddable zips. The same check was run on
  the contents of 25 `.msi` installers covering 2.4 to 3.4. Imports were
  matched against export tables copied from the XP, Vista, 7, 8.1, 10, 11
  and Server 2022 test VMs. The Burn UX container of the `.exe` installers
  and CPython's `PythonBootstrapperApplication.cpp` were read for the
  installers' own OS checks. The boundary builds were then run on the VMs.
- **macOS:** Mach-O `LC_BUILD_VERSION`/`LC_VERSION_MIN_MACOSX` per slice,
  read from 32 python.org `.pkg` files (sampled, with bisection at the
  boundaries) and all 14 python-build-standalone (PBS) macOS archives.
- **Linux:** the highest `GLIBC_x.y` needed by each of the 38 PBS glibc
  archives. PBS musl archives were checked for `PT_INTERP`.

## Windows

Newest release in `releases.json` that runs there. **Bold** means the
build was run on the VM during this research and `import sys, asyncio`
worked. *Known-good* is the operator's tested build from
`TESTED-WINDOWS.md`.

| Windows | x86 installer | x86 embed zip | amd64 installer | amd64 embed zip | arm64 | Known-good (x86) | Prerequisites |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2000 | 3.2.5 (msi) | none | none | none | none | | SP3+ (Windows Installer 2.0). Low/medium confidence: no VM |
| XP | 3.4.4 (msi) | none | none | none | none | 3.5.0 XP backport (`python_3_5_x86.zip`), re-run here OK | SP2+ for 3.3/3.4 |
| XP x64 / Server 2003 | 3.4.4 | none | 3.4.4 | none | none | | SP1+ for 3.3/3.4 |
| Vista / Server 2008 | 3.7.9 | **3.7.9** | 3.7.9 | 3.7.9 | none | 3.7.0 `.exe` | SP2; UCRT (KB2999226) for the zip |
| 7 / Server 2008 R2 | 3.8.10 | **3.8.10** | 3.8.10 | **3.8.10** | none | 3.8.0 `.exe` | SP1 + KB2533623; UCRT for the zip |
| 8 | 3.8.10 | 3.11.9 | 3.8.10 | 3.11.9 | none | 3.8.0 `.exe` | UCRT for the zip |
| Server 2012 | 3.11.9 | 3.11.9 | 3.11.9 | 3.11.9 | none | | UCRT for the zip |
| 8.1 / Server 2012 R2 | 3.13.15 | **3.14.7** | 3.13.15 | **3.14.7** | none | 3.8.0 `.exe` | UCRT for the zip |
| 10 / Server 2016, 2019 | 3.14.7 | **3.14.7** | 3.14.7 | **3.14.7** | 3.14.7 (1709+) | 3.13.0 `.exe` | none |
| 11 | 3.14.7 | **3.14.7** | 3.14.7 | **3.14.7** | 3.14.7 | 3.13.0 `.exe` | none |
| Server 2022 | 3.14.7 | **3.14.7** | 3.14.7 | **3.14.7** | none | | none |
| Server 2025 | 3.14.7 | 3.14.7 | 3.14.7 | 3.14.7 | none | | none |

Itanium (ia64): 2.5.4 on XP 64-bit Edition, Server 2003, 2008 and 2008 R2
for Itanium.

The installer and the embeddable zip differ in three places:

- **Windows 8:** the 3.9 to 3.13 installers refuse client 8.0, although
  3.9 to 3.11 run there. From 3.12, `python312.dll` imports
  `PssCaptureSnapshot`, which needs 8.1 or later.
- **Server 2012:** the 3.12 and 3.13 installers accept it, but
  `python3xx.dll` then fails to load.
- **8.1:** the 3.14 installer refuses anything below Windows 10. The
  3.14.0 to 3.14.7 zips still run on 8.1: they ran on the VM, and their
  imports resolve against the 8.1 export tables.

## macOS

| macOS | amd64 (x86_64) | arm64 | universal installer |
| --- | --- | --- | --- |
| 10.3, 10.4 | none | none | 3.2.5 (`macosx10.3` dmg, PPC/i386; dmg not opened) |
| 10.5 | none | none | 3.5.4 (`macosx10.5`, PPC + i386) |
| 10.6 to 10.8 | none | none | 3.7.6 (`macosx10.6`, i386 + x86_64) |
| 10.9 to 10.12 | 3.9.13 (`macosx10.9` pkg) | none | 3.12.5 (universal2) |
| 10.13, 10.14 | 3.9.13 | none | 3.13.15 (universal2) |
| 10.15 | 3.14.7 (PBS) | none | 3.14.7 (universal2) |
| 11 and later | 3.14.7 (PBS) | 3.14.7 (PBS) | 3.14.7 (universal2) |

- The 32-bit-only families (`macosx10.3`, `macosx10.5`, `macpython`,
  `macosx`) stop at 10.14.
- Apple silicon Macs also run the amd64 builds under Rosetta 2.

## Linux (glibc)

| glibc | amd64, arm64, armv7, ppc64le, s390x | riscv64 |
| --- | --- | --- |
| 2.5, 2.12 | none (build from source) | none |
| 2.17 to 2.27 | 3.14.7 (PBS) | none |
| 2.28 and later | 3.14.7 | 3.14.7 |

- PBS glibc archives need glibc 2.17 at every version from 3.8.20 to
  3.14.7. riscv64 needs 2.28.
- The armv7 archives also need `GCC_3.5` from libgcc_s.
- The PBS musl archives are dynamically linked from 3.9.23 and need a
  musl host such as Alpine. 3.8.20 (amd64) is fully static.

## Where the docs and the binaries disagree

The binary wins in each case.

1. **3.8 on Vista.** The docs, the Windows download page and the 3.8
   installer all accept Vista SP2. However, `python38.dll` imports
   `GetActiveProcessorCount`, which needs Windows 7. The 3.8.0 zip exited
   with 0xC0000139 on the Vista VM. **The last Python for Vista is
   3.7.9.**
2. **3.9 to 3.11 on Windows 8.0.** The docs and the installer say 8.1.
   The binaries need only Windows 8 APIs (PathCch*). The embeddable zip
   should therefore work, but no Windows 8 VM was available to confirm it.
3. **3.12 needs 8.1, not 8:** it imports `PssCaptureSnapshot`. The docs
   say "8.1", which is correct here.
4. **3.13 and 3.14 on 8.1.** PEP 11's lifecycle rule and the 3.14 docs
   say 3.12 is the last for 8.1, while the 3.13 docs still say 8.1.
   Every 3.13.x and 3.14.0 to 3.14.7 zip imports nothing newer than 8.1.
   The VM ran 3.13.0, 3.13.15, 3.14.0 and 3.14.7 with asyncio. The 3.13
   installer accepts 8.1; the 3.14 installer does not.
5. **macOS universal2 "macos11" packages.** The file name and
   `releases.json` suggest macOS 11. The x86_64 slice actually needs:
   - 10.9 for 3.9.1 to 3.12.5
   - 10.13 for 3.12.6 to 3.13.x (the boundary was bisected: 3.12.5 is
     10.9, 3.12.6 is 10.13)
   - 10.15 for 3.14.x

   Only 3.8.10's universal2 package really needs macOS 11.
6. **PBS macOS x86_64** needs 10.15 from 3.9.23 (tag 20250918) onward;
   3.8.20 (tag 20241002) needs 10.9. The arm64 builds need 11.0.

## VM results (2026-09-18, `C:\ib-ossupport`, deleted afterwards)

| VM | Build | Result |
| --- | --- | --- |
| XP SP3 | 3.5.0 x86 zip | hung on a loader error dialog, killed after 90 s |
| XP SP3 | XP backport `python_3_5_x86.zip` | OK |
| Vista SP2 (6.0.6003) | 3.7.0, 3.7.9 x86 zip | OK |
| Vista SP2 | 3.8.0 x86 zip | exit 0xC0000139 (entry point not found) |
| 7 SP1 x64 | 3.8.10 x86, amd64 zip | OK |
| 7 SP1 x64 | 3.9.0 x86, amd64 zip | exit 0xC0000135 (DLL not found) |
| 8.1 x64 | 3.11.9 amd64; 3.12.10, 3.13.0 x86+amd64; 3.13.15, 3.14.0 amd64; 3.14.7 x86+amd64 | all OK |
| 10 22H2, 11 24H2, Server 2022 | 3.14.7 x86+amd64 zip | OK |

The VMs already have the UCRT (from the VC++ AIO redistributable),
KB2533623 and late updates. The Vista VM is on build 6003, which has the
2019+ Server 2008 updates. The results therefore show what runs on a
patched system.

## Corrections to `limitations.json` (not edited)

- **3.8 windows:** "Vista/7/8/8.1 and later" is wrong. It needs Windows 7
  (SP1 + KB2533623).
- **3.8 windows:** "Last CPython line with unmodified upstream support for
  7/8/8.1" is wrong. That is true of 7 only: 8 gets up to 3.11.9
  (embeddable zip) and 8.1 up to 3.13.15 (installer) or 3.14.7 (zip). The
  same applies to limitation "last major with reliable stock support on
  Windows 7/8/8.1".
- **3.9 windows:** "Windows 8 and later only". The installer requires 8.1
  (client) or Server 2012. The binaries themselves run on 8.0. Also,
  `api-ms-win-core-path-l1-1-0.dll` is imported, not "statically linked".
  "Dropped Windows Vista and 7": Vista was already lost at 3.8.0.
- **3.10 and 3.11 windows:** "Windows 8 and later". This holds for the
  embeddable zip only; the installer needs 8.1 or Server 2012.
- **3.12 windows:** "Windows 8 and later" is wrong. 3.12 needs 8.1 or
  Server 2012 R2 (`PssCaptureSnapshot`).
- **3.13 windows:** "installs on 8+". The installer needs 8.1 or Server
  2012 (but not Server 2012 in practice), and the binaries need 8.1. It
  is not "Windows 10 in practice".
- **3.14 windows:** "same floor as 3.13" is wrong. The 3.14 installer
  needs Windows 10 or Server 2016, while the 3.14.0 to 3.14.7 embeddable
  zips still run on 8.1.
- **3.10 to 3.14 macos:** "macOS 11 (Big Sur) baseline for the universal2
  installer" is wrong. The baselines are 10.9 (3.10.x, 3.11.x, up to
  3.12.5), 10.13 (3.12.6 to 3.13.x) and 10.15 (3.14.x).
- **3.8 macos:** add the 3.8.10 universal2 package, which needs macOS 11
  (both slices).
- **3.9 macos:** the universal2 package from 3.9.1 needs 10.9 on Intel
  and 11 on arm64. PBS 3.9.23 x86_64 needs 10.15.
- **3.5 macos:** "10.6 and later" is incomplete. There is also a 10.5
  PPC/i386 installer (3.5.0 to 3.5.4).
- **3.3 and 3.4 windows:** XP needs SP2, because msvcr100 imports
  `EncodePointer`.
- **2.7 windows:** "2000/XP/Vista/7 across its lifetime". 2.7.18 still
  runs on everything from 2000 (medium confidence) up to 11.
- **3.8+ linux:** say which glibc: 2.17 for every PBS arch except riscv64,
  which needs 2.28. The musl archives need a musl host from 3.9.23.
- **milestone arm64_macos:** 3.8.10 also shipped universal2 (macOS 11
  only).

Other catalogue fields with the same errors (not edited):

- `releases.json`: `min_os` on every `macos11`/`macos11.0` pkg says
  "macOS 11"; see disagreement 5 for the real minimums.
- `install.json`: "3.5-3.8: Windows Vista" should be 3.5-3.7. "3.13+/3.14:
  Windows 10 in practice" is true only for the 3.14 installer.

## Not settled

- **Windows 2000:** no VM or 2000 export tables. 2.4 to 3.2.5 is based on
  PE headers, a hand list of XP-only functions and PEP 11.
- **Windows 8.0:** no VM. The 3.9 to 3.11 zips are inferred from import
  tables.
- **arm64 Windows:** no ARM64 VM. The imports were checked against x64
  export names.
- **64-bit XP/2003:** no VM. The 32-bit export tables were used as a
  proxy.
- **Binary check limits:** the check covers static imports and loader
  failures only. Functions resolved at run time (`GetProcAddress`), and
  any installer `.exe` other than the operator's, were not exercised.
- **Old macOS dmgs:** the 2.4.3, 2.5 to 3.1 `macosx` and `macosx10.3`
  dmgs were not opened, so their minimums come from vendor naming only.
- **Later releases:** 3.13.16+ and 3.14.8+ are placeholder rules
  (Windows 10, low confidence) until their binaries are checked.
