# Ruby: newest version per system

Machine-readable data: `os_support.json`. Researched 2026-09-18.
ruby-lang.org ships source only. The binaries covered here are:

- **Windows:** RubyInstaller .7z archives. RubyInstaller 1.x covers
  1.8.7–2.3.3 and RubyInstaller2 covers 2.4.0 on. Separate `format: exe`
  rules cover the installers.
- **Linux/macOS:** ruby/ruby-builder "toolcache" tarballs, as used by
  `ruby/setup-ruby`.

Every Windows .7z version (290) and every macOS tarball (182) in `releases.json`
was downloaded and every executable inside was read. For Linux, the
first, middle and last tarball of each minor were read, bisected where
they differed (154 tarballs).

## Newest release that runs

Windows (.7z archives):

| System | x86 | x64 | arm64 |
|---|---|---|---|
| 2000 | 1.8.7-p374 | n/a | n/a |
| XP | 2.5.3 | n/a | n/a |
| XP x64 / Server 2003 | 2.5.3 (x86 build) | 2.0.0-p648 | n/a |
| Vista SP2 / Server 2008 | 3.3.12 | 3.3.12 | n/a |
| 7 | 3.3.12 | 3.3.12 | n/a |
| 8 / 8.1 | 3.4.10 (last x86) | 4.0.7 | n/a |
| 10 / 11 | 3.4.10 | 4.0.7 | 4.0.7 |

Most RubyInstaller2 builds from 2.6.10, 2.7.6, 3.0.4 and 3.1.0 up to 3.3.x
need **KB2533623** on Vista/7. That is the update that adds
`AddDllDirectory`, and it is not part of 7 SP1. The x64 builds from 3.1 on
(UCRT) also need the Universal C Runtime (KB2999226) before Windows 10.

The .exe installers add their own gate. Inno Setup `MinVersion` was 6.0
(Vista) until rubyinstaller2 commit 82c814b1 (2024-06-13), then 6.1. So
installers published after that date need Windows 7 even though the
payload runs on Vista: 3.1.7, 3.2.5+ and 3.3.3+.

macOS (ruby-builder; the Homebrew packages at the default prefix are
needed too, see below):

| System | x64 | arm64 |
|---|---|---|
| 10.14 | none | n/a |
| 10.15 | 3.2.1 | n/a |
| 11 | 3.3.3 | none |
| 12 | 3.3.6 | none |
| 13 | 3.4.7 | 3.3.3 |
| 14 | 3.4.7 | 4.0.7 |
| 15, 26 | 4.0.7 | 4.0.7 |

Linux (ruby-builder; the variant names the Ubuntu runner that built it):

| glibc id | ubuntu-22.04 build | ubuntu-24.04 build | ubuntu-26.04 build |
|---|---|---|---|
| ≤ glibc-2.34 (RHEL 9 and older) | none | none | none |
| glibc-2.35 / 2.36 (Ubuntu 22.04, Debian 12) | 4.0.7 | none | none |
| glibc-2.39 (Ubuntu 24.04) | 4.0.7 | 4.0.7 | none |
| glibc-2.41 (Debian 13) | 4.0.7 | 4.0.7 | 4.0.7 |

This holds for x64 and arm64 alike. Each build also needs distro
sonames: libffi.so.8, libyaml-0.so.2, libgmp.so.10, libz.so.1, libcrypt.so.1,
and for 3.1+ libssl.so.3/libcrypto.so.3. Older builds also need
libreadline.so.8 and libgdbm.so.6. Each rule's `extra` lists them. RHEL 9
fails on `GLIBC_2.35` alone.

## Findings

- **Windows floors come from the whole archive, not only ruby.exe.** The
  bundled `libwinpthread-1.dll` imports `GetTickCount64`, so most
  RubyInstaller2 builds from 2.4.6 on need Vista. Some early 2.4/2.5 x86
  builds still ran on XP. `win32/dll_directory.so` imports
  `AddDllDirectory`, and RubyInstaller's runtime loads it at every start.
  From 3.4.1 the ruby DLL itself imports `GetSystemTimePreciseAsFileTime`
  (x64/x86) or `GetCurrentThreadStackLimits` (arm64), so **3.4 and 4.0
  need Windows 8**.
- **RubyInstaller 1.x:** 1.8.7 runs on 2000 (PE 4.0, msvcrt only). 1.9.2
  through 2.3.3 x86 need XP (`getaddrinfo` in socket.so). 2.0.0 x64 needs
  XP x64 / Server 2003. 2.1–2.3 x64 need Vista (`socket.so` imports `if_indextoname`, a
  Vista API).
- **macOS minima jump around from patch to patch.** ruby-builder rebuilt
  versions on whichever runner image was current, so minos goes up and
  down between 10.15, 11, 12, 13 and 15 (x64) and between 13 and 14
  (arm64). All builds link Homebrew `gmp`, `libyaml`, `openssl@3` (3.1.5+),
  `readline` (<3.3) and `gdbm` (<3.1) by absolute path. In practice the
  target also needs a Homebrew that still serves bottles for that macOS.
  Treat these as CI toolcache builds, not end-user binaries.
- **Linux:** the builds need the glibc of their runner (2.35 for 22.04,
  2.38 for 24.04). The ubuntu-26.04 builds need OpenSSL ≥ 3.4
  (`OPENSSL_3.4.0` symbol version). Debian 13 (3.5) has it; Ubuntu 24.04
  (3.0) does not.

## Corrections to limitations.json

- **2.4:** "the switch away from the old mingw one-click installer also
  ends practical Windows XP support" is not quite right. RubyInstaller2
  x86 2.4.0–2.4.5 and 2.5.0–2.5.3 .7z payloads still run on XP (only the
  installer says Vista). The real XP cut-off is **2.5.3** (x86), and 2.4.6+
  / 2.5.5+ need Vista.
- **3.4:** "early/experimental arm64 Windows builds" understates it. arm64
  .7z builds exist from 3.4.1, and every 3.4/4.0 build (x86, x64, arm64)
  needs **Windows 8**. That is not stated anywhere in `limitations.json`.
- **4.0:** "requires MSVC 14.0+" concerns building Ruby with MSVC.
  RubyInstaller is MinGW/UCRT, so it does not apply to these binaries.
  4.0 has no x86 build (confirmed).
- **macOS/Linux "Source build/Homebrew":** the catalogue's ruby-builder
  binaries have hard floors (tables above) that limitations.json does not
  mention.
- **install.json** says Windows 7 for the 2.4+ .7z (installer
  MinVersion=6.1). That is correct only for installers published after
  2024-06-13. The .7z payloads of 2.4–3.3 run on Vista SP2, most with
  KB2533623.

## Open points

- RubyInstaller 1.x installers: their Inno Setup MinVersion was not read
  (`confidence: low`).
- The DevKit installer's MSYS2 has its own, later floor; not measured.
- ruby-builder macOS: the Homebrew bottle availability for old macOS
  versions was not checked.
- No VM tests; binary and document evidence only.
