# Runtime catalog

Where to find every version of 10 languages' runtimes, per OS, architecture
and major version, what developers couldn't do with each version, and local
downloads of the newest patch of each major.

Languages (TIOBE September 2026 top 10, plus Go, PHP, Ruby, Nim and Zig; SQL and
classic VB6 excluded as not app runtimes, VB.NET covered by .NET):
Python (2 and 3), C, C++, Java, C# / VB.NET (.NET), JavaScript / TypeScript
(Node.js), Go, Rust, PHP, R, Ruby, Nim, Zig.

## Ask the question

```sh
python3 tools/query.py python windows                 # every Python major on Windows
python3 tools/query.py rust macos --major 1.56        # one major
python3 tools/query.py c linux --arch arm64           # C/C++ toolchains (LLVM, GCC)
python3 tools/query.py --build-report                 # regenerate AVAILABILITY.md
```

Each answer shows the versions available, architectures, which version is
downloaded here, the OS support at the time, the main limitations, capability
milestones (async/await, TLS 1.3, HTTP/2, ARM64 …), and any recorded gaps.

## Files

| Path | What |
| --- | --- |
| `AVAILABILITY.md` | Every runtime on every OS, pre-generated |
| `GAPS-TO-REVIEW.md` | Everything not found or not downloaded, with explanations |
| `SCHEMA.md` | Data format |
| `<runtime>/releases.json` | Every build found: URL, confirmed mirrors, vendor checksum, size |
| `<runtime>/gaps.json` | Versions/platforms that plausibly existed but weren't found |
| `<runtime>/limitations.json` | Per major: OS support, added capabilities, limitations, confidence |
| `<runtime>/download_plan*.json` | What `tools/download.py` fetches |
| `<runtime>/mirrors.json`, `NOTES.md`, `scrape.py`, `extra_mirrors.py` | Mirror evidence, quirks, re-runnable scraper, and the mirror-hunt post-processor (re-run after `scrape.py`) |
| `download-log.jsonl`, `download-gaps.json` | Download results |
| `tools/` | `validate.py`, `download.py`, `query.py`, `gaps_report.py` |

Runtime folders: `python`, `node`, `java`, `dotnet`, `go`, `rust`, `php`, `r`,
`ruby`, `nim`, `zig`, `cc` (C/C++: LLVM, GCC via WinLibs/w64devkit, GCC source, MSVC redistributable).

## What's downloaded

**One version per true major version**, the newest minor and patch
(`download_plan_majors.json`, built by `tools/make_major_plans.py`):
Python 2.7 and 3.14, Go 1.27, Rust 1.98, PHP 4.4/5.6/7.4/8.5,
R 1.9/2.15/3.6/4.6, Nim 0.20/1.6/2.2, Zig every 0.x line (pre-1.0: each minor is a breaking release), .NET 1.1/2.2/3.1/5–10, Node.js 0.12 and 4–26, Java 6–26,
LLVM 3.9 and 4–23, GCC per major.

- Per OS and architecture: if the newest minor dropped a platform, that
  platform keeps the newest minor that still had it (e.g. Go 1.23 for
  platforms Go 1.24+ dropped).
- Source tarballs only where no prebuilt binary exists for that major and OS.
- Verified against the vendor checksum where one exists (size otherwise),
  into `../<runtime>/<os>/<arch>/<version>[-<variant>]/`.
- Everything else was deleted by `tools/prune.py`, except files in the root
  `manifest.json` (the operator-tested and separately verified Windows Python
  builds), `deps/` and `reference/`.
- The catalog itself still lists every version and its limitations, and the
  older `download_plan*.json` files are kept as metadata.

## Metadata only

- **Ruby** (2026-09-17): catalogued (releases, gaps, limitations, mirrors) but
  **not downloaded**, by operator decision. Pre-compiled Ruby is distributed
  almost only via GitHub (RubyInstaller, ruby-builder). To fetch it later:
  `python3 tools/download.py --plan-name download_plan_majors.json ruby`
  (about 1.6 GB).
