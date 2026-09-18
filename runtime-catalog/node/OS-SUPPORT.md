# Node.js: newest version per system

Machine-readable data: `os_support.json` (103 rules, `max_per_os` for every
OS id × arch × variant). Researched 2026-09-18. Every os/arch/variant group
in `releases.json` was swept one major at a time. The first, middle and last
release were read, then bisected wherever two reads disagreed: about 1,000
`node` binaries in all. Windows `node.exe` was fetched directly and
Linux/macOS `bin/node` was streamed out of the tarballs.

## Newest release that runs (official nodejs.org builds)

Windows:

| System | x86 | x64 | arm64 |
|---|---|---|---|
| XP (SP2+) | 5.12.0 | n/a | n/a |
| XP x64 / Server 2003 | 5.12.0 | 5.12.0 | n/a |
| Vista / Server 2008 | 5.12.0 | 5.12.0 | n/a |
| 7 / 2008 R2, 8 | 13.14.0 | 13.14.0 | n/a |
| Server 2012 (not R2) | 22.23.2 | 22.23.2 | n/a |
| 8.1 / 2012 R2 | 22.23.2 | 22.23.2 | n/a |
| 10 1507/1511 | 22.23.2 | 26.9.0 (but not 23.7.0–24.1.x) | 26.9.0 (same gap) |
| 10 1607+, Server 2016+, 11 | 22.23.2 (last x86 build) | 26.9.0 | 26.9.0 |

macOS:

| System | x64 | arm64 | 32-bit x86 |
|---|---|---|---|
| 10.5, 10.6 | 5.12.0 | n/a | 0.12.18 |
| 10.7 – 10.9 | 11.15.0 | n/a | 0.12.18 |
| 10.10 – 10.12 | 13.14.0 | n/a | 0.12.18 |
| 10.13, 10.14 | 17.9.1 | n/a | 0.12.18 |
| 10.15 | 20.20.2 | n/a | none |
| 11 – 13 (below 13.5) | 23.11.1 | 23.11.1 | none |
| 13.5+, 14, 15, 26 | 26.9.0 | 26.9.0 | none |

The universal `.pkg` has the same floor as its x64 slice.

Linux (glibc id; official builds unless marked):

| glibc id (e.g.) | x64 | arm64 | armv7 | ppc64le / s390x |
|---|---|---|---|---|
| glibc-2.5 (RHEL 5) | 7.10.0 | none | none | none |
| glibc-2.12 (RHEL 6) | 11.15.0 | none | none | none |
| glibc-2.17 (RHEL 7) / 2.19 | 17.9.1 | 17.9.1 | 9.11.2 | 17.9.1 |
| glibc-2.23 – 2.27 (Ubuntu 16.04–18.04, Debian 9) | 17.9.1 | 17.9.1 | 17.9.1 | 17.9.1 |
| glibc-2.28 (RHEL 8, Debian 10) | 26.9.0 | 26.9.0 | 19.9.0 | 26.9.0 |
| glibc-2.31 (Ubuntu 20.04, Debian 11) | 26.9.0 | 26.9.0 | 22.23.2 | 26.9.0 |
| glibc-2.35+ | 26.9.0 | 26.9.0 | 23.11.1 (last armv7) | 26.9.0 |
| musl (Alpine; unofficial musl builds) | 26.9.0 | 26.9.0 | n/a | n/a |

Other Linux archs are in `max_per_os`. Unofficial x86 runs up to 21.7.3 on
glibc-2.17 and later, and armv6 up to 22.23.2 on glibc-2.35. riscv64 and
loong64 (unofficial) need glibc-2.31/2.36 for older builds and glibc-2.39
for 20.19.5+ and 22.20+.

## What the binaries showed

- **Windows.** `node.exe` checks the Windows version itself when it starts:
  - **6.0.0–13.x:** refuses to start below Windows 7 ("This application
    is only supported on Windows 7, Windows Server 2008 R2, or higher").
    There is no override.
  - **14.0.0–22.x:** refuses to start below 8.1, but lets Server 2012
    (non-R2) through. From 14.5.0 the check can be skipped with
    `NODE_SKIP_PLATFORM_CHECK=1`.
  - **23.0.0 on:** refuses to start below Windows 10.

  Before 6.0 there is no check. The imports allow XP SP2 on x86
  (`GetAddrInfoW`) and XP x64 / 2003 on x64. The exceptions are io.js
  1.0.0–1.0.2 and Node 0.12.3, whose PE header is 6.0 (Vista).

  **23.7.0–24.1.x import `GetThreadDescription`/`SetThreadDescription`
  directly.** Those functions exist only from Windows 10 1607 (build
  14393), so on 10 1507/1511 these releases fail to load even with the
  skip variable. 24.2.0 removed the import again. The `.msi` launch
  condition (VersionNT ≥ 601 for 6–13; ≥ 603, or 602 on a server, for
  14+) is never stricter than `node.exe`'s own check.
- **macOS:** minos per slice. x64: 10.5 (0.8–5), 10.7 (6–11), 10.10
  (12–13), 10.13 (14–17), 10.15 (18–20), 11.0 (21–23), 13.5 (24+).
  arm64: 11.0 (16–23), 13.5 (24+). None of the `.pkg` Distribution files
  set `allowed-os-versions`.
- **Linux:** `bin/node` links `libstdc++.so.6` dynamically. So besides the
  highest `GLIBC_` symbol, the `GLIBCXX_` symbol version can set the floor,
  and on armv7 it does.

## Corrections to limitations.json

- **Windows 13.x runs on Windows 7.** `limitations.json` says 13 raised the
  floor to 8.1. The 13.14.0 binary still checks only for Windows 7, and
  BUILDING.md at v13.0.0 says "Windows 7/2008 R2/2012 R2". The raise came
  in **14.0.0**.
- **Windows 16–22 run on 8.1 / 2012 R2 (and Server 2012).**
  `limitations.json` says 16 raised the floor to Windows 10. BUILDING.md
  demoted 8.1 to "Experimental" at 18, but `node.exe` keeps accepting 8.1
  until 22.x. The hard floor of 10 arrives with **23.0.0**.
- **Windows 10 before build 14393** cannot run 23.7.0–24.1.x (see above).
  `limitations.json` does not mention this.
- **io.js** was documented as Vista+, but its binaries run on XP from
  1.0.3 on. They were never supported there.
- **macOS x64 floors are one step lower than the docs**, and the binary
  wins:
  - 6–11 run on 10.7 (docs: 10.10 for 6–9, 10.11 for 10–12).
  - 12–13 run on 10.10 (docs: 10.11, then 10.13).
  - 16–17 run on 10.13 (docs: 10.15).
  - **20.x runs on 10.15.** The docs say 11.0; the binary minos is 10.15
    through 20.20.2. The move to 11.0 is at **21.0.0**.
  - 24.0.0 needs 13.5 exactly as documented.
- **Linux x64 10.x–11.x need only glibc 2.9** (built on CentOS 6), so they
  run on RHEL/CentOS 6. The docs say glibc ≥ 2.17. 0.10.15–7.10.0 need
  just glibc 2.4 (RHEL 5).
- **Linux armv7 needs more than the documented glibc 2.28 from 20.0.0**,
  because of `GLIBCXX_3.4.26` (gcc 9 libstdc++, Ubuntu 20.04 / Debian 11).
  23.x needs `GLIBCXX_3.4.30` (Ubuntu 22.04 / Debian 12). 10.x–14.x need
  `GLIBCXX_3.4.20/21` (Ubuntu 16.04+), not the documented glibc 2.24.
- **The `install.json` Linux prerequisite line** ("10+: glibc>=2.17 … 6-9:
  glibc>=2.12") is conservative for x64 10–11. It is otherwise consistent
  with the binaries.

## Open points

- Windows arm64 builds before 19.9.0 are unofficial (12.1.0–19.3.0,
  `variant: unofficial`). They need Windows 8 by imports, but arm64
  Windows exists only as 10/11, so in practice they need 10.
- Versions between two reads that agree inherit their result without
  being read. A change that appeared and then reverted between two samples
  would be missed. This happened for the thread-description import on
  Windows; the bisection caught that one because the endpoints differed.
- unofficial-builds' `linux-x64-glibc-217` flavour (18+ for RHEL 7) is not
  in `releases.json`, so it is not covered.
- No VM tests were run: binary and document evidence only. The kernel
  minimum from the ELF ABI tag is recorded in each Linux rule's `extra`.
