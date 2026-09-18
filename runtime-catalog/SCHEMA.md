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

## cors.json

Whether a web page can download from each host with `fetch()` (CORS), used
to build offline installers in the browser (installer-builder
`docs/offline.md`). One record per host, written through
`tools/add_cors.py`; evidence appended to `cors_evidence.jsonl`.
`tools/cors_probe.py` checks sample catalogue URLs following the browser's
rules (every redirect hop must allow the origin; after a cross-origin
redirect the origin becomes `null`).

```json
{"hosts": {"cdn.npmmirror.com": {
  "host": "cdn.npmmirror.com",
  "status": "yes",
  "allow_origin": "echo",
  "redirects_to": [],
  "path_rules": [],
  "browser_confirmed": true,
  "tested": "2026-09-18",
  "samples": ["https://cdn.npmmirror.com/binaries/node/v0.10.48/node-v0.10.48-darwin-x86.tar.xz"],
  "notes": null
}}}
```

- `status`: `yes` (every sample works from a browser), `no`, `partial`
  (depends on the path; see `path_rules`), `unreachable` (couldn't test).
- `allow_origin`: `"*"`, `"echo"` (the request's origin is sent back), or
  `null`.
- `redirects_to`: other hosts the downloads redirect through; they must allow
  CORS too.
- `path_rules`: for `partial`, `[{"prefix": "/dist/", "status": "yes"}]`.
- `browser_confirmed`: a real headless Chrome `fetch()` gave the same answer.

## install.json

How to install each downloaded file into an app's own runtime folder,
assuming the installer runs as root / administrator. One file per runtime
folder. Written by a research pass; `tested` says whether a recipe was
actually run.

The goal is installer-builder's per-app isolation (its `docs/design.md`
section 1.1): everything inside `{runtime_dir}`, nothing added to PATH, no
file associations or shortcuts, and **two copies of the same version able
to exist side by side** for two different apps. Anything a recipe does
outside `{runtime_dir}` is listed in `side_effects`.

```json
{
  "runtime": "python",
  "researched": "2026-09-18",
  "assumes": "root/administrator",
  "recipes": [
    {
      "match": {"os": "windows", "kind": "installer", "format": "exe", "versions": ">=3.5", "arch": null},
      "method": "extract",
      "steps": [
        {"run": "\"{file}\" /quiet /layout ...", "shell": "cmd"},
        {"unpack": "zip", "to": "{runtime_dir}", "strip_components": 0}
      ],
      "prerequisites": ["msvc-redist 2015-2022 x86 on Windows < 10"],
      "executable": "python.exe",
      "package_manager": "\"{runtime_dir}\\python.exe\" -m pip",
      "verify": "\"{runtime_dir}\\python.exe\" -c \"import sys; print(sys.version)\"",
      "uninstall": "delete {runtime_dir}",
      "side_effects": [],
      "isolation": "full",
      "relocatable": true,
      "min_os": "Windows 8.1 for 3.9+",
      "tested": false,
      "confidence": "high",
      "sources": ["https://docs.python.org/3/using/windows.html"],
      "notes": null
    }
  ]
}
```

- `match`: which catalogue files the recipe applies to. `versions` is a
  PEP 440-style range over the release `version`; null fields match
  anything. The most specific match wins.
- `method`: `unpack` (archive, just extract), `extract` (take the files out
  of an installer without running its setup logic, e.g. `msiexec /a`,
  `pkgutil --expand-full`, `dpkg-deb -x`, `innoextract`, `7z x`), `run`
  (the vendor's installer with silent flags and a target folder), or
  `build` (compile from source).
- `steps`: in order. `run` is a command (`shell`: `cmd` on Windows, which
  must work back to XP, so no PowerShell; `sh` elsewhere). `unpack` is done
  by the base installer itself (it bundles its own zip/7z/tar/xz code), so
  it names the format, not a tool. Tokens: `{file}` the downloaded file,
  `{runtime_dir}` the target folder (absolute, may contain spaces),
  `{tmp}` a scratch folder deleted afterwards.
- `executable`: the runtime's main program, relative to `{runtime_dir}`.
- `package_manager`: how the app's dependencies get installed with this
  runtime, if it has one.
- `isolation`: `full` (nothing outside `{runtime_dir}`), `leaks` (works,
  but see `side_effects`), `impossible` (only installs to a fixed system
  location or once per machine).
- `relocatable`: works from any folder, including one with spaces.

### Launch and project install (added 2026-09-18)

Two more recipe fields, used by installer-builder to run apps and install
projects without anything leaking out of `{runtime_dir}` (its
`docs/design.md` section 1.7):

```json
"launch": {
  "program": "{runtime_dir}/bin/java",
  "args": [],
  "env": {"JAVA_HOME": "{runtime_dir}"},
  "notes": null
},
"project_install": {
  "command": "\"{runtime_dir}/bin/python3\" -s -m pip install --no-warn-script-location .",
  "env": {"PIP_CONFIG_FILE": "{runtime_dir}/pip.conf"},
  "cwd": "{app_dir}",
  "notes": null
}
```

- `launch.program` / `args`: what to start and the runtime's own flags
  (e.g. Python `-s`, PHP `-c {runtime_dir}/php.ini`). The app's own
  command (`-m myapp`) is appended by installer-builder.
- `launch.env`: environment the runtime needs on every run. Tokens:
  `{runtime_dir}`, `{app_dir}` (the app's folder), `{data_dir}` (a
  writable folder inside the app's folder for caches).
- `project_install`: the default command to install the app's project
  and its dependencies with this runtime, and the environment for it.
  `null` if the runtime has no package manager.
- `env` values: a string sets the variable, `""` sets it empty, and
  `null` **removes** it from the app's environment (used to stop a user's
  global settings such as `JAVA_TOOL_OPTIONS` or `RUSTFLAGS` leaking in).
- `path_prepend`: folders put first on PATH for the app's own process
  only (Node.js scripts start with `#!/usr/bin/env node`).
- `launch.program` is `null` for compiled languages (Go, Rust, Nim, Zig, C/C++),
  which are built on the user's machine by `project_install`; the built program
  then runs directly.
- Filled by `tools/add_launch.py <runtime>`, which applies the research
  findings uniformly; re-running it only rewrites these two fields.

## Old-machine reachability (planned, 2026-09-18)

Very old systems often have broken DNS and can't do modern HTTPS (XP:
TLS 1.0 only, no SNI, old root certificates). Plain HTTP and fixed IPs
are still useful there, because every file is checked against its pinned
checksum. Per mirror host, record in `reachability.json` (to be
collected):

```json
{"hosts": {"mirrors.huaweicloud.com": {
  "http_plain": true,
  "ips": [{"ip": "203.0.113.7", "seen": "2026-09-18"}],
  "ip_with_host_header": true,
  "ip_bare": false,
  "tls_versions": ["1.2", "1.3"],
  "sni_required": true,
  "tested": "2026-09-18",
  "notes": null
}}}
```

- `http_plain`: the same files are served over `http://` (same size or
  hash on a sample), not just a redirect to https.
- `ips`: addresses the name resolved to, with dates; they go stale,
  especially behind CDNs.
- `ip_with_host_header`: a request to the IP, sending the host name in
  `Host`, gets the file (skips only DNS). `ip_bare`: it works without it.
- `tls_versions` / `sni_required`: which old clients can use its HTTPS.

## os_support.json (added 2026-09-18)

Machine-readable OS support per runtime, precise enough for the installer
to pick **the newest version that runs on the user's system** with no
human in the loop. OS ids come from `catalog/os_versions.json`.

```json
{
  "runtime": "python",
  "researched": "2026-09-18",
  "rules": [
    {
      "versions": ">=3.9,<3.13",
      "os": "windows",
      "arch": ["x86", "amd64"],
      "min_os": "8.1",
      "min_build": null,
      "max_os": null,
      "extra": [],
      "applies_to": "python.org installers and embeddable zips",
      "evidence": [
        {"kind": "vendor-doc", "source": "https://peps.python.org/pep-0011/"},
        {"kind": "binary", "source": "python39.dll imports ... (absent before 8)"}
      ],
      "confidence": "high",
      "notes": null
    }
  ],
  "max_per_os": [
    {"os": "windows", "os_version": "xp", "arch": "x86",
     "max_version": "3.4.4", "variant": null, "tested": false, "notes": null}
  ]
}
```

- `rules`: version ranges (PEP 440 style, down to the patch where support
  changed mid-series) with the minimum OS per os/arch. `max_os` is for
  builds that stop working on newer systems (e.g. 32-bit on macOS 10.15+).
  `extra` lists required OS updates (SP1, KB numbers).
- `evidence` kinds: `vendor-doc` (release notes, support pages),
  `binary` (read from the actual file: PE subsystem version and imported
  functions compared with what each Windows version exports; Mach-O
  `LC_BUILD_VERSION`/`LC_VERSION_MIN_MACOSX`; the highest `GLIBC_x.y`
  symbol an ELF needs), `vm-test` (ran on a test machine), `secondary`.
- When vendor docs and the binary disagree, the binary wins and the
  disagreement goes in `notes`.
- `max_per_os`: for every OS id and arch, the newest release in
  `releases.json` that runs there, derived from `rules`. This is what the
  form's "newest that runs on the user's system" shows.
- `format` (optional, list): limits a rule to those file formats, e.g.
  `["zip"]` vs `["exe"]` when a vendor's installer refuses an OS that
  the same release's archive runs on (Python 3.9–3.11 on Windows 8).
  `variant` and `kind` limit rules the same way. Without them a rule
  applies to every file of that os/arch/version, and every applying rule
  must allow the OS.
- `tools/make_major_plans.py` uses these rules to keep, per OS id, the
  newest release that runs there (runtimes listed in its
  `OS_FLOOR_RUNTIMES`); each such plan entry gets a `reason`.
- `file_match` (optional): a regular expression matched against the
  download's file name, for builds that variant, kind and format can't
  tell apart (e.g. .NET's rhel.6 builds, R's Mavericks .pkg).
