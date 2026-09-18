# Minimum OS per compiler version

Compiled apps are built on the user's machine (installer-builder
`docs/design.md` 1.8), so the compiler itself has to run on the user's OS.
This file says which version to pick for an old Windows, macOS or Linux. The
machine-readable version, with ranges an installer can match and an
`evidence` list per range, is `compilers_min_os.json`.

Researched 2026-09-18. Covers Go, Rust, Zig, Nim and the C/C++ toolchains
(WinLibs GCC, w64devkit, LLVM/Clang).

## Where each fact comes from

- **vendor**: release notes, platform-support pages, READMEs.
- **binary**: read from the downloaded files in this pass: PE subsystem
  version plus the newest Windows API each exe imports; Mach-O
  `LC_BUILD_VERSION`/`LC_VERSION_MIN_MACOSX` minos; highest `GLIBC_` symbol,
  or "static". The loader refuses a PE whose subsystem version is higher than
  the OS, and a missing import stops it loading, so both are hard floors.
  Every downloaded Go, Zig and Nim archive was scanned, plus a sample of
  LLVM Linux builds (14.0.6, 18.1.8, 19.1.7).
  WinLibs `.7z` executables use the BCJ2 filter that py7zr can't decode, so
  WinLibs relies on the earlier pass's checks.
- **binary (catalogue)**: an earlier pass's check, recorded in
  `<runtime>/install.json` `min_os`.

Where vendor and binary disagree, the stricter one is the floor. A looser
binary floor ("loads, but not supported") is noted.

Windows versions are compared as NT numbers: XP 5.1, XP x64/2003 5.2,
Vista 6.0, 7 6.1, 8 6.2, 8.1 6.3, 10/11 10.0.

## Newest version that runs on each old OS

| OS | Go | Rust | Zig | Nim (compiler) | C/C++ |
| --- | --- | --- | --- | --- | --- |
| Windows XP | **1.10.8** | none, ever | none | any (2.2.12) + WinLibs i686 msvcrt 10.5 | WinLibs 10.5.0 i686 msvcrt; w64devkit x86 |
| Windows Vista | 1.10.8 | none | 0.3.0 x64 at best (binary only, needs VC++ 2015 redist; unsupported) | any + WinLibs msvcrt 10.5 | WinLibs 10.5.0 msvcrt (x64 or i686); LLVM 3.7.1 (not in catalogue) |
| Windows 7 SP1 | **1.20.14** | **1.77.2** | 0.5.0 (vendor); 0.6.0 x64 loads | any + WinLibs UCRT (with the UCRT update) | WinLibs UCRT 11+; LLVM latest; w64devkit x64 |
| Windows 8.1 | 1.20.14 | 1.77.2 | **0.10.1** | any | as 7 |
| Windows 10/11 | latest | latest | latest | latest | latest |
| macOS 10.6 | 1.4.3 (x86: 1.4.2 osx10.6 build) | none | none | source build | none planned |
| macOS 10.7 | 1.7.6 | **1.73.0** | none | source build | none planned |
| macOS 10.8-10.9 | 1.10.8 | 1.73.0 | none | source build | LLVM 5.0.2 (10.9) |
| macOS 10.10-10.11 | 1.14.15 | 1.73.0 | none | source build | LLVM 5.0.2 |
| macOS 10.12 | 1.16.15 | latest (x86_64) | none | source build | LLVM 5.0.2 |
| macOS 10.13-10.14 | 1.20.14 | latest | **0.9.1** | source build | LLVM 6.0.0 |
| macOS 10.15 | 1.22.12 | latest | 0.9.1 | source build | LLVM 11.0.0 |
| macOS 11 | 1.24.13 | latest | 0.9.1 (11.7+: 0.11.0; 11.7.1+: 0.13.0) | 1.6.20 | LLVM 12.0.0 (11.6+: 14.0.6) |
| macOS 12 | 1.26.8 | latest | 0.13.0 | 1.6.20 | LLVM 14.0.6 (12.6+: 15.0.7) |
| macOS 13-14 | latest | latest | latest | 1.6.20 (2.2 from source) | latest (arm64 needs 14.0 for 19+) |
| macOS 15+ | latest | latest | latest | 2.2.12 | latest |
| Linux kernel < 2.6.32 | 1.17.x | none | 0.14.1 | any | GCC from source |
| Linux kernel < 3.2 / glibc < 2.17 | 1.23.12 | **1.63.0** | 0.14.1 (3.16+) | 1.6+ (static) | GCC from source; LLVM builds per glibc |

Bold marks versions that were missing from `download_plan_majors.json`
before the OS-floor rule (see "Plan gaps" below); they're in it now.

## Per compiler

### Go

The toolchain is statically linked on Linux (binary, all 10 arches of
1.27.1), so only the kernel matters there. cgo needs a C compiler.

| Versions | Windows | macOS | Linux kernel | Source |
| --- | --- | --- | --- | --- |
| 1.0-1.2 | 2000 | 10.6 | 2.6.23 | vendor |
| 1.3-1.4 | XP | 10.6 (1.4.2 osx10.6 build has no minos) | 2.6.23 | vendor + binary |
| 1.5-1.7 | XP | 10.7 | 2.6.23 | vendor (medium) |
| 1.8-1.10 | XP / Vista | 10.8 | 2.6.23 | vendor |
| 1.11-1.14 | 7 | 10.10 | 2.6.23 | vendor |
| 1.15-1.16 | 7 | 10.12 | 2.6.23 | vendor |
| 1.17 | 7 | 10.13 | 2.6.23 | vendor |
| 1.18-1.20 | 7 | 10.13 | 2.6.32 | vendor |
| 1.21-1.22 | 10 | 10.15 | 2.6.32 | vendor |
| 1.23 | 10 | 11 | 2.6.32 | vendor |
| 1.24 | 10 | 11 | 3.2 | vendor |
| 1.25-1.26 | 10 | 12 | 3.2 | vendor (go.dev/wiki/MinimumRequirements) |
| 1.27 | 10 | 13 | 3.2 | vendor + binary: PE subsystem **10.0** on go/compile/link for x86, amd64, arm64 (the loader rejects them before 10; the imports are only Vista-level); Mach-O minos 13.0 |

Go before 1.7 builds programs that misbehave on macOS 10.12+.

### Rust

| Versions | Windows | macOS | Linux | Source |
| --- | --- | --- | --- | --- |
| 1.0-1.63 | 7 | x86_64 10.7 | kernel 2.6.32, glibc 2.11 | vendor |
| 1.64-1.73 | 7 | x86_64 10.7; arm64 11 (1.49+) | 3.2 / 2.17 | vendor |
| 1.74-1.77 | 7 | x86_64 10.12 | 3.2 / 2.17 | vendor |
| 1.78+ | **10** | 10.12 / 11 | 3.2 / 2.17 | vendor + binary |

Binary, 1.98.1: the `-msvc` (checked earlier in the catalogue) and `-gnu`
(this pass) `std-*.dll` and `rustc_driver-*.dll` import `WaitOnAddress`
(Windows 8), `GetSystemTimePreciseAsFileTime` (8) and `ProcessPrng`, so they
can't load on 7. Their PE headers say 5.2/6.0, which is not the real floor.
Programs built by 1.78+ import the same functions (checked on cross-built
x86_64 and i686 `-gnu` executables), so they need Windows 10 too. The Linux
toolchain's highest GLIBC symbol is 2.17 (catalogue). No official Rust ever
supported XP or Vista as a host.

Rust on Windows without Visual Studio Build Tools: see
`rust/NOTES.md` ("Windows without Build Tools"). In short, the `-gnu`
toolchains need nothing else for pure-Rust crates. Build Tools need
Windows 10 1909+ themselves, so `-gnu` 1.77.2 is the only way to build Rust
on Windows 7/8.1.

### Zig

Zig carries its own linker and libc, so the compiler binary is the only
floor.

| Versions | Windows | macOS (x86_64 / arm64) | Linux | Source |
| --- | --- | --- | --- | --- |
| 0.1-0.3 (x64 only) | Vista-level APIs, needs VC++ 2015+ redist (UCRT, vcruntime140); realistically 7 SP1 | 0.3: 10.13.7 | static; kernel unstated | binary (vendor states nothing) |
| 0.4-0.5 | 7 (`K32EnumProcessModulesEx`); needs VC++ 2015+ redist | 0.4: 10.13; 0.5: 10.14 | static; 0.5: 3.16 | vendor (0.5: 7+) + binary |
| 0.6 | 8.1 vendor; x64 loads on 7, x86 needs 8 | 10.14 (notes say 10.13) | 3.16 | vendor + binary |
| 0.7-0.10 | 8.1 vendor; loader floor 8 (`GetSystemTimePreciseAsFileTime`) | 0.7: 10.15.7 / 11.0; 0.8: no minos (notes 10.13) / none; 0.9: 10.13 / 11.6; 0.10: 11.7 | 3.16 | vendor + binary |
| 0.11-0.13 | 10 vendor; loads on 8 (0.12+ also need UCRT) | 0.11: 11.7; 0.12-0.13: 11.7.1 | 3.16 | vendor + binary |
| 0.14 | 10 | 13.0 | 3.16 | vendor + binary |
| 0.15-0.16 | 10 | 13.0 | 5.10 | vendor OS table + binary |

The Mach-O minos is stricter than the release notes for 0.5-0.6 (10.14 vs
10.13) and 0.10-0.14 (11.7 / 11.7.1 / 13.0 vs 11). dyld enforces the minos.

### Nim

The compiler binaries are undemanding: every Windows `nim.exe`/`nimble.exe`
(0.20.2, 1.6.20, 2.2.12) has PE subsystem 4.0 (x86) or 5.2 (x64) and no
post-XP imports (binary). Nim states no minimum OS. The floor is the C
compiler: the MinGW that Nim's `finish.exe` downloads (GCC 11.1) needs Vista+
(catalogue). On XP, use the catalogue's WinLibs 9.5/10.5 i686 msvcrt instead.

| Versions | Windows | macOS | Linux | Source |
| --- | --- | --- | --- | --- |
| 0.20 | XP (x64: XP x64/2003) | source build | glibc 2.7 (nimble; nim 2.3) | binary |
| 1.6 | XP | 11.0 (x86_64 binary) | static | binary |
| 2.2 | XP | **15.0** (x86_64 and arm64 binaries) | static | binary |

### C/C++

| Toolchain | Versions | Windows | Source |
| --- | --- | --- | --- |
| WinLibs GCC, MSVCRT | 9.5, 10.5 | i686: XP (gcc, cc1, cc1plus, as, ld import nothing newer); x64: Vista (as/ld import `GetFinalPathNameByHandleA`). Bundled cmake/ninja/gdb need Vista/7 | binary (catalogue) |
| WinLibs GCC, UCRT | 11-16 | 7 SP1 with the UCRT update (KB2999226); built into 10 | binary (catalogue) |
| w64devkit | all | x86 kit XP with SSE2 (its CMake/Ninja/ccache need 7); x64 kit 7 | vendor |
| LLVM/Clang | < 3.8 | Vista (XP for some builds); none in the catalogue | vendor |
| LLVM/Clang | 3.8+ | 7: "the minimum Windows version required for running LLVM is Windows 7" (3.8 notes). Targets the MSVC ABI, so it needs Build Tools headers/libs | vendor |
| rust-mingw (inside Rust -gnu) | GCC 14.2 / binutils 2.44 driver | Vista (ld.exe imports `GetFinalPathNameByHandleA`) | binary |

LLVM macOS minos per build (catalogue): x86_64 3.9.0 10.11, 4.0.1 10.12,
5.0.2 10.9, 6.0.0 10.13, 9.0.1-11.0.0 10.15, 12.0.0 11.0, 13.0.1-14.0.6
11.6, 15.0.7 12.6, 19.1.7-20.1.7 13.7 (no x86_64 build after 20.1.7);
arm64 14.0.6 13.2, 15.0.7-16.0.5 13.0, 17.0.6 13.6, 19.1.7-23.1.1 14.0.
LLVM Linux builds need glibc 2.15-2.32 depending on the build for 3.9-18
(catalogue); this pass read 2.27 from 14.0.6 (rhel-8.4) and 18.1.8
(ubuntu-18.04) and **2.34** from 19.1.7 (the catalogue's recipe says 2.35
for 19+; the binary needs only 2.34, so 20+ should be re-checked). GCC for Linux and macOS is source-only in the
catalogue.

## Plan gaps (now filled by the OS-floor rule)

These were missing from `download_plan_majors.json` on 2026-09-18.
`tools/make_major_plans.py` now also keeps, for go, rust, zig, nim and cc,
the newest release that runs on each OS id in `os_versions.json`, using the
`os_support` rules in `compilers_min_os.json` (or a runtime's own
`os_support.json`). Each entry of those plans has a `reason` such as
"newest for windows xp, vista". Added: Go 1.2.2 (Windows 2000), 1.4.3,
1.7.6, 1.10.8, 1.14.15, 1.16.15, 1.20.14, 1.22.12, 1.23.12 (Linux, all
arches), 1.24.13, 1.26.8; Rust 1.77.2 x86_64/i686 -gnu, 1.73.0 macOS,
1.63.0 Linux (all arches); Nim 2.2.12 source relabelled for macOS; w64devkit
2.10.0 x86 (XP); LLVM 3.4 Linux (glibc 2.17). Zig needed nothing: its plan
already holds every 0.x line. Nothing was downloaded.

| Compiler | Old OS | Add |
| --- | --- | --- |
| Go | Windows XP, Vista | **1.10.8** windows x86 + amd64 |
| Go | Windows 7, 8, 8.1 | **1.20.14** windows x86 + amd64 |
| Go | macOS 10.7 / 10.8-10.9 / 10.10-10.11 / 10.12 / 10.13-10.14 / 10.15 / 11 / 12 | 1.7.6, 1.10.8, 1.14.15, 1.16.15, 1.20.14, 1.22.12, 1.24.13, 1.26.8 (darwin amd64; arm64 from 1.16) |
| Go | Linux kernel 2.6.32-3.1 (RHEL/CentOS 6) | 1.23.12 |
| Rust | Windows 7, 8, 8.1 | **1.77.2** x86_64 and i686 `-gnu` (the plan has only 1.98.1, Windows 10+) |
| Rust | macOS 10.7-10.11 | 1.73.0 x86_64-apple-darwin |
| Rust | Linux glibc 2.11-2.16 | 1.63.0 x86_64/i686 linux-gnu |
| Rust, Zig | Windows XP, Vista | nothing exists; use Go 1.10.8, Nim + WinLibs, or C/C++ |
| Zig | macOS 10.12 and older | nothing exists (lowest minos is 10.13) |
| Nim | macOS < 15 for Nim 2.x, all macOS < 11 | 2.2.12 source tarball (build with Xcode CLT; untested on old macOS) |
| LLVM | Windows XP/Vista | 3.7.1 only if ever wanted (low priority: needs MSVC libs) |

Already covered: XP C/C++ (WinLibs 9.5/10.5 i686 msvcrt, both planned),
Windows 7 and 8.1 Zig (0.5.0, 0.10.1 planned), macOS 10.13-10.15 Zig (0.9.1
planned), Nim on XP (the compiler runs; pair it with WinLibs).

Rust -msvc 1.77.2 isn't added: it runs on 7, but nothing in the catalogue
can link for it there (the catalogue's Build Tools need Windows 10 1909), so
its rule has `plan_floor: false`.

## Found in passing

- `llvm/linux/amd64/10.0.1-ubuntu-16.04/clang%2Bllvm-10.0.1-x86_64-linux-gnu-ubuntu-16.04.tar.xz`
  has the expected size (380,908,816 bytes) but fails `xz -t` ("Compressed
  data is corrupt"). LLVM publishes no checksum for it, so the download was
  verified by size only. Re-download and compare before trusting it.
