# Runtime catalog schema

One folder per runtime family under `catalog/`:
`python`, `node`, `java`, `dotnet`, `go`, `rust`, `php`, `r`, `ruby`, `nim`, `zig`, `cc` (C/C++ toolchains).

Each folder contains:

| File | Contents |
| --- | --- |
| `scrape.py` | Reproducible script that builds the JSON files below from official indexes. Python 3 standard library only. |
| `releases.json` | Every downloadable build found (array of **release entries**) |
| `gaps.json` | Expected combinations that couldn't be found (array of **gap entries**) |
| `download_plan.json` | One chosen release entry per (runtime, major, os, arch): the newest patch, preferring a portable archive over an installer, and the smallest official format |
| `mirrors.json` | Mirror URL templates found for this runtime, each with how it was confirmed |
| `limitations.json` | Added later: developer limitations and OS support per major version |
| `NOTES.md` | Short notes: sources used, quirks, anything a human should know |

## Normalised values

- `os`: `windows`, `linux`, `macos`, `freebsd`, `openbsd`, `netbsd`, `solaris`, `aix`, `android`, `illumos`, `dragonfly`, `plan9` (lowercase; add others only if a vendor ships them)
- `arch`: `x86` (32-bit Intel), `amd64`, `arm64`, `armv7`, `armv6`, `ppc64le`, `ppc64`, `s390x`, `riscv64`, `loong64`, `mips64le`, `ia64`, `universal` (macOS fat binaries), `any` (arch-independent, e.g. source)
- `kind`: `installer` (runs a setup program), `archive` (unpack and use), `source` (must be compiled)
- `major`: the version line people choose between, as a string:
  python `3.12` / `2.7`, ruby `3.3`, nim `2.2`, zig `0.14`, node `20`, java `17`, dotnet `8.0`, go `1.22`, rust `1.80`, php `8.3`, r `4.4`, llvm `18`, gcc `14`

## Release entry

```json
{
  "runtime": "node",
  "languages": ["javascript", "typescript"],
  "major": "20",
  "version": "20.17.0",
  "os": "windows",
  "arch": "amd64",
  "kind": "archive",
  "format": "zip",
  "variant": null,
  "libc": null,
  "url": "https://nodejs.org/dist/v20.17.0/node-v20.17.0-win-x64.zip",
  "mirrors": ["https://cdn.npmmirror.com/binaries/node/v20.17.0/node-v20.17.0-win-x64.zip"],
  "checksum": {"algo": "sha256", "value": "…", "source": "https://nodejs.org/dist/v20.17.0/SHASUMS256.txt"},
  "size": 32000000,
  "released": "2024-08-21",
  "min_os": null,
  "metadata_source": "https://nodejs.org/dist/index.json",
  "notes": null
}
```

- `variant`: build flavour when a runtime ships several for the same os/arch, e.g. `jdk`/`jre`, `sdk`/`runtime`, `nts`/`ts`, `msvcrt`/`ucrt`, `posix`/`win32` threads. `null` if only one.
- `libc`: `glibc` or `musl` for Linux builds where it matters, else `null`.
- `mirrors`: only URLs **confirmed** to serve this file (same size, or same hash for a sample). Unconfirmed guesses don't go here.
- `checksum`: `null` if the vendor publishes none. `algo` is `sha256`, `sha512`, `sha1` or `md5`. Always record the vendor's value, never one computed locally.
- `size`: bytes, from the vendor's index or a HEAD request; `null` if unknown.
- `min_os`: the vendor's stated minimum OS for this build, verbatim, if stated.

## Gap entry

```json
{
  "runtime": "php", "major": "8.3", "os": "linux", "arch": "amd64",
  "reason": "php.net publishes no official Linux binaries; source only",
  "looked_at": ["https://www.php.net/downloads.php"]
}
```

Record a gap when a combination is plausible but not found: the vendor supported that OS at the time but no file could be located, or an archive/listing was unreachable.

## Download layout (filled later)

Downloaded files go to `<root>/<runtime>/<os>/<arch>/<version>[-<variant>]/<file>`, matching the existing Python files (`tools/download.py`). Every attempt is logged to `catalog/download-log.jsonl`; failures and skips go to `catalog/download-gaps.json`.

## limitations.json

Written by a research pass after the release metadata. One file per
language family folder (for `cc`, one file covering C, C++ and the
toolchains).

```json
{
  "runtime": "python",
  "languages": ["python"],
  "researched": "2026-09-17",
  "sources": ["https://docs.python.org/3/whatsnew/index.html"],
  "milestones": [
    {"capability": "async_await", "since": "3.5", "notes": "asyncio module 3.4 (provisional); async/await syntax 3.5"}
  ],
  "majors": [
    {
      "major": "3.5",
      "released": "2015-09-13",
      "end_of_life": "2020-09-30",
      "os_support": {
        "windows": "Vista and later (XP dropped)",
        "macos": "10.6 and later",
        "linux": "any glibc Linux (source); no official binaries"
      },
      "added": ["async/await syntax (PEP 492)", "type hints module (PEP 484)"],
      "limitations": ["no f-strings (3.6)", "dict order not guaranteed (3.7)", "asyncio still provisional"],
      "confidence": "high"
    }
  ]
}
```

- `milestones.capability` uses these ids where they apply (add others if a
  language needs them): `async_await`, `native_threads`, `true_parallelism`,
  `tls_1_2`, `tls_1_3`, `http2_client`, `http3_client`, `ipv6`,
  `unicode_default`, `package_manager_bundled`, `modules`, `generics`,
  `64bit_windows`, `arm64_macos`, `arm64_windows`, `arm64_linux`.
- `os_support`: what the language's own project said that major supported,
  in plain words, including the minimum OS versions. Use `"none"` when the
  vendor shipped nothing for that OS.
- `limitations`: things a developer at the time could NOT do or had to work
  around, phrased with the version that fixed it where known.
- `confidence`: `high` (from official docs), `medium` (secondary sources),
  `low` (inferred).

## Later additions

- `checksum_corroboration` (optional, array): hashes for the same file published
  by third parties such as package manager manifests (winget, Scoop, Chocolatey,
  pyenv, ruby-build), each `{"algo", "value", "source"}`. They are NOT vendor
  checksums and never replace `checksum`, but they let a file with no vendor
  checksum be verified against an independent record.
- Mirrors found after scraping are added through `tools/add_mirrors.py`, which
  also logs evidence to `<runtime>/mirror_evidence.jsonl`.
