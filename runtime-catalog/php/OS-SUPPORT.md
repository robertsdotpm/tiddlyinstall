# PHP: newest version per system

Machine-readable data: `os_support.json` (rules + `max_per_os`). Researched
2026-09-18 from the binaries themselves, not from `limitations.json`.

## Newest release that runs

Windows (windows.php.net / museum.php.net zips; the newest file is the
`nts-vs17` zip unless the row says otherwise):

| System | x86 | x64 |
|---|---|---|
| 2000 | 5.2.17 | n/a |
| XP | 5.4.45 | n/a |
| XP x64 / Server 2003 | 5.4.45 (x86 build) | none (x64 builds need Vista) |
| Vista SP2 / Server 2008 | 7.1.33 | 7.1.33 |
| 7 SP1 / 2008 R2 | 8.2.33 | 8.2.33 |
| 8 / Server 2012 and later | 8.5.10 | 8.5.10 |

Every build from 5.3 on needs the matching Visual C++ runtime:
2008 SP1 (5.3–5.4), 2012 Update 4 (5.5–5.6), or 2015–2022 (7.0 and later).
On 7/8/8.1 the 2015–2022 runtime also installs the Universal C Runtime.

macOS (static-php-cli, unofficial):

| System | Intel | Apple silicon |
|---|---|---|
| 10.15, 11 | none | none |
| 12 and later | 8.5.8 | 8.5.8 |

Linux (static-php-cli, unofficial): 8.5.8 on every glibc id and on musl
(Alpine), x64 and arm64. The binaries are fully static, so they need no
particular libc.

## How it was measured

- **Windows:** the zips were grouped by toolchain (vc6, vc9, vc11, vc14,
  vc15, vs16, vs17). For each minor line the first, middle and last zip
  were downloaded, plus more wherever two of them disagreed (82 zips in
  all). Every PE file in each zip was read for its subsystem version and
  its imports, and each imported function was mapped to the Windows
  version that introduced it. `min_os` comes from the core files:
  `php.exe`, `php-cgi.exe`, `php-win.exe` and `phpN[ts].dll`. Optional
  extensions that need more than the core are listed in the rule notes.
  The results never changed within a minor line.
- **macOS:** all 170 static-php-cli tarballs were read (`LC_BUILD_VERSION`
  minos).
- **Linux:** the first, middle and last tarball of each minor were read.
  All were static: no `PT_INTERP` and no `GLIBC_` symbol versions.

## What set each floor

| Versions | Floor | Binary evidence | Vendor doc |
|---|---|---|---|
| 4.4.0–5.2.17 | 2000 | PE 4.0; imports only pre-XP APIs and msvcrt.dll | — |
| 5.3.29–5.4.45 | XP | PE 5.0; `php5.dll` imports `freeaddrinfo`/`getaddrinfo` (added in XP), and no bundled extension needs anything newer | — |
| 5.5.38–7.1.33 | Vista | `php5.dll`/`php7.dll` and `php-cgi.exe` import `inet_pton`/`inet_ntop`/`GetTickCount64`; PE 6.0 | 7.2 UPGRADING: "Minimum supported Windows versions are Windows 7/Server 2008 R2" (so 7.0/7.1 still supported Vista) |
| 7.2.0–8.2.33 | 7 | `php7.dll`/`php8.dll` import `K32GetProcessMemoryInfo` (added in 7) | same |
| 8.3.0 onwards | 8 | `php8.dll` imports `GetCurrentThreadStackLimits` (8.4+ also `GetSystemTimePreciseAsFileTime`), both added in 8 | PHP-8.3 UPGRADING: "Minimum supported Windows version has been bumped to Windows 8 or Windows Server 2012" |

## Corrections to limitations.json

- **8.3 (not 8.4) is the first line that needs Windows 8 / Server 2012.**
  `limitations.json` lists 8.3 as "Windows 7/Server 2008 R2 and later".
  But 8.3.0's `php8.dll` already imports `GetCurrentThreadStackLimits`, so
  it will not load on Windows 7, and PHP-8.3's UPGRADING says the same.
  The newest PHP for Windows 7 is **8.2.33**.
- **8.4's stated reason is wrong.** `limitations.json` says the VS2022
  v143 toolset "no longer targets Windows 7". It does target 7; the
  Windows 8 floor comes from PHP's own code in 8.3, which was still built
  with VS16. The floor is right, the reason is not.
- **7.0 and 7.1 run on Vista SP2 / Server 2008.** `limitations.json` says
  7+. The binaries import nothing newer than Vista, and 7.2's UPGRADING
  names 7.2 as the release that raised the floor to 7.
- **5.5 and 5.6:** Vista is correct. The core DLL imports `inet_pton`,
  which XP does not have.
- **4.4 to 5.1:** these also ran on 98/NT4, but `os_versions.json` has no
  id for them. 2000 is the lowest id.
- **macOS:** "static-php-cli builds exist going back to this line" holds
  only in a narrow sense. For 8.0 the catalogue has just 8.0.30 (it needs
  13 on Intel, 14 on Apple silicon). The minimum macOS moves between 12,
  13, 14 and 15 from patch to patch, depending on when static-php-cli last
  rebuilt the file. `install.json`'s "macOS 12.0" holds only for the
  newest builds (8.3.30+, 8.4.16+ and 8.5.x).

## Open points

- static-php-cli overwrites files in place and publishes no checksums, so
  the macOS minima describe the files as served on 2026-09-18 and can
  change after a rebuild.
- The old installers (`php-4.x/5.0/5.1-installer.exe`, and the 5.2.17 and
  5.3.29 `.msi` files) are assumed to have their zip's floor, marked
  `confidence: low`. Their own launch conditions were not read.
- The TS zips were not scanned. Their rules are inferred from the NTS zip
  of the same version and toolchain (`confidence: medium`).
- No VM tests were run; this is binary and document evidence only.
