# Installer Builder runtimes

Local store of runtime installers that base installers download at
install time. Every file here was checked against a published checksum or
signature before being recorded.

## Layout

```
<runtime>/<os>/<arch>/<version>/<file>
deps/<os>/<arch>/<name>/<version>/<file>
```

- `runtime`: `python` (Node.js and Ruby to follow)
- `os`: `windows` (Linux and macOS to follow)
- `arch`: `x86`, `amd64`, `arm64`, or `any` for files that cover several
- `version`: the release version, or a descriptive name for custom builds
  such as `3.5-xp-backport`

## Files

| File | What it holds |
| --- | --- |
| `manifest.json` | One entry per file: path, size, SHA-256, MD5, where it came from, how it was verified, and every mirror URL confirmed to serve it |
| `mirrors.json` | Mirror hosts and their URL templates |
| `README.md` | This file |

## Python on Windows

The newest python.org release of every Python 3 minor version that has
Windows installers, for every architecture python.org provides:

| Version | x86 | amd64 | arm64 | Format | Verified by |
| --- | --- | --- | --- | --- | --- |
| 3.0.1 | ✓ | ✓ | | MSI | python.org MD5 |
| 3.1.4 | ✓ | ✓ | | MSI | python.org MD5 |
| 3.2.5 | ✓ | ✓ | | MSI | python.org MD5 |
| 3.3.5 | ✓ | ✓ | | MSI | GPG signature, Martin v. Löwis |
| 3.4.4 | ✓ | ✓ | | MSI | python.org MD5 |
| 3.5.4 | ✓ | ✓ | | EXE | python.org MD5 |
| 3.6.8 | ✓ | ✓ | | EXE | python.org MD5 |
| 3.7.9 | ✓ | ✓ | | EXE | python.org MD5 |
| 3.8.10 | ✓ | ✓ | | EXE | python.org MD5 |
| 3.9.13 | ✓ | ✓ | | EXE | python.org MD5 |
| 3.10.11 | ✓ | ✓ | | EXE | python.org MD5 |
| 3.11.9 | ✓ | ✓ | ✓ | EXE | python.org MD5 |
| 3.12.10 | ✓ | ✓ | ✓ | EXE | python.org MD5 |
| 3.13.15 | ✓ | ✓ | ✓ | EXE | python.org SHA-256 |
| 3.14.7 | ✓ | ✓ | ✓ | EXE | python.org SHA-256 |

Later patch releases in older lines (e.g. 3.8.20) are source-only
security releases; python.org publishes no Windows installers for them.
3.15 has only pre-releases so far.

Plus the files from
[robertsdotpm/win-auto-py3](https://github.com/robertsdotpm/win-auto-py3),
verified against its `file_meta.txt`:

| Path | Used there for |
| --- | --- |
| `python/windows/x86/3.5-xp-backport/python_3_5_x86.zip` | Windows XP. **Custom build:** the msfn.org XP backport of Python 3.5, extracted, with pip added and changes to make asyncio work. It will not match the upstream installer |
| `python/windows/x86/3.7.0/python-3.7.0.exe` | Windows Vista |
| `python/windows/x86/3.8.0/python-3.8.0.exe` | Windows 7 and 8 |
| `python/windows/x86/3.13.0/python-3.13.0.exe` | Windows 10 and later |
| `deps/windows/any/vcredist-aio/0.35.0/VisualCppRedist_AIO_x86_x64.exe` | Visual C++ runtimes, installed first on XP and Vista |

## How files were found and verified

- **python.org releases:** candidates came from python.org's downloads API
  (`/api/v2/downloads/release_file/`). Because the API misses some
  releases (it has no 3.3.5 files), they were cross-checked against the
  directory listings under `https://www.python.org/ftp/python/`. Files were
  verified against the API's SHA-256 where published, otherwise its MD5.
- **3.3.5** has no checksums on python.org, only GPG signatures (`.asc`,
  kept next to the files). They verify with key
  `CBC5 4797 8A39 64D1 4B9A B36A 6AF0 53F0 7D9D C8D2` (Martin v. Löwis),
  which matches python.org's `pubkeys.txt` as archived in 2015 and the key
  ID listed on python.org's 2014 downloads page.
- **win-auto-py3 files:** SHA-256 from its `file_meta.txt`. The three
  python.org originals among them also match python.org's MD5s.

## Mirrors

Base installers pin each file's checksum, so mirrors don't need to be
trusted: a mirror serving the wrong bytes just fails verification and the
installer tries the next one. `manifest.json` lists, per file, only the
mirrors confirmed to serve it at the right size.

Most mirrors found so far are in China. Outside China the options are
python.org's CDN and the Internet Archive.

## Runtime catalog

`catalog/` now covers 13 languages (Python 2 and 3, C, C++, Java, .NET,
Node.js, Go, Rust, PHP, R, Ruby, Nim, Zig) across operating systems, architectures and major
versions, with limitations per version. Start with `catalog/README.md`.

The Python files described above predate the catalog and were verified
separately; the catalog's downloads go into the same layout.

## Gaps to fill

- Older builds for old systems beyond the XP backport (archive.org copies)
- See `catalog/GAPS-TO-REVIEW.md`
