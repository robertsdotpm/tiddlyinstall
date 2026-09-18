# Windows base installer

One NSIS installer for every app and runtime (plan.md 1.1). It reads a
record and a plan ([docs/format.md](../../docs/format.md)), picks the
plan's first `[target]` that matches the machine, downloads and checks
each file, runs the recipe steps, installs the project, and writes the
launcher, shortcuts, manifest and uninstaller. There is no per-runtime
code in it. Unicode NSIS 3.09; runs on Windows XP SP3 to 11 and Server
2022.

## Files

| File | What it is |
| --- | --- |
| `base.nsi` | The installer and its uninstaller (`WriteUninstaller`) |
| `launcher.nsi` | `launch.exe`, copied into every app folder |
| `include/ibutil.nsh` | Helpers shared by both: UTF-8 in and out, tab-separated fields, base32, environment, elevation |
| `build.sh` | Builds `out/launcher.exe`, then `out/base.exe`, which embeds it |
| `append_meta.py` | Appends a metadata block (format.md section 4) to a base, for testing |
| `plugins/x86-unicode/` | Third-party NSIS plugins (below) |
| `tools/7za.exe` | 7-Zip 9.20 command line, for `7z` and `tar.*` |

```sh
./build.sh                                        # out/launcher.exe, out/base.exe
IB_BACKEND=http://127.0.0.1:8091 IB_OUTFILE=out/base-test.exe ./build.sh
python3 append_meta.py out/base.exe app.exe --record record.txt --plan plan.txt [--pack FILE...]
python3 append_meta.py --hash record.txt          # the record's 26-character hash
python3 append_meta.py --show app.exe             # the footer an exe carries
```

`makensis` is `~/.local/bin/makensis` (NSIS 3.09 with its stubs under
`~/.local/opt/ib-tools`). `out/` is not committed.

## Command line

| Option | Meaning |
| --- | --- |
| `/S` | Silent: no pages, same engine. Exit code 0 = installed, 2 = couldn't start (no metadata, no matching target, a `fail` block, no admin rights), 3 = install failed and was rolled back |
| `/log=<path>` | Append the detail log (the transparency text, every download, step and command output) to a UTF-8 file |
| `/record=<path>` | Use this record; the plan comes from `/plan=` or the backend |
| `/plan=<path>` | Use this plan |
| `/backend=<url>` | Backend for records and plans. Otherwise the record's `backend` line, otherwise the built-in `IB_BACKEND` (`http://10.0.1.76:8080`) |
| `/ib-elevated` | Internal: marks the copy started with `runas` |

Metadata is looked for in plan.md 1.1 order: command line, the appended
block (on a signed exe it ends at the certificate table, after skipping
up to 7 NUL bytes), `install.txt` beside the exe (a record), a 26-character
record hash as the last `_` token of the file name (copy suffixes such as
` (1)` and ` - Copy` are stripped first; the record is fetched from
`<backend>/api/records/<hash>` and must hash to the name), and last plain
`install_<runtime>_<project>` tokens, for which the plan is fetched from
`<backend>/api/plan/name/<runtime>/<project>` (docs/api.md, "Plans by
name").

## What gets installed

```
<root>\<appid>\            launch.exe, launch.txt, manifest.txt, uninstall.exe, the project
<root>\<appid>\data\
<root>\<hash12>\           one per plan `file`: base32(sha256(appid + name))[:12]
```

`<root>` is `%LOCALAPPDATA%\<rootname>`, or `C:\<rootname>` on XP/2003
(short paths) and for `root system`, which also means HKLM and all-users
shortcuts. `root system` or `admin 1` make the installer start itself
again with `runas` (Vista and later) and wait for that copy.

Shortcuts: Start menu folder `<App>` holding `<App>.lnk` (to
`launch.exe`) and `Uninstall <App>.lnk`, plus a desktop shortcut if
`desktop 1`. Add/Remove Programs: `HKCU` (or `HKLM`)
`Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-<appid>`.

The uninstaller reads `manifest.txt` in its own folder and removes only
`dir` entries that are `<root>\<12 base32 chars>`, `.lnk` shortcuts in a
Start menu or desktop folder (then the app's Start menu folder, if
empty), and the app's own `ib-<appid>` uninstall key; then its own folder,
and the root if that is now empty. Like every NSIS uninstaller it runs
from a copy in `%TEMP%\~nsuN.tmp`, which Windows deletes at the next
reboot.

## Launcher

`launch.exe` (a silent NSIS program) reads `launch.txt` beside it, sets
and unsets environment variables, prepends `path` entries to `PATH`, sets
the working folder and starts `exec`. With `console 1` it starts
`cmd /s /k "<exec>"` so the window stays open. `launch.exe /out=<file>`
(for tests) runs `cmd /s /c "<exec> >"<file>" 2>&1"`, waits, and exits
with the app's exit code. It is named `launch.exe` in every app folder;
the shortcuts carry the app's name.

## Engine notes

- Downloads use INetC (`/CONNECTTIMEOUT 10 /RECEIVETIMEOUT 60`) and try
  each `url` in order; each file is checked with HashInfo SHA-256
  (case-insensitive) before any step touches it. A packed copy (the pack
  tar, member named by the lowercase hex sha256) is used first.
- `run` steps and `install` go through `cmd /s /c "(<command>) >log 2>&1"`;
  the output goes into the detail log, and a non-zero exit fails the
  install. `install` also gets `IB_APP_DIR`, `IB_RUNTIME_DIR`,
  `IB_APP_NAME`.
- `unpack`, `mkdir`, `write` and `delete` refuse paths outside the app's
  folders and `{tmp}`. `zip` uses nsisunz; `7z`, `tar` and `tar.gz/.xz/.bz2`
  use 7za (a `.tar.*` is decompressed to `{tmp}` first). `strip 1` unpacks
  to `{tmp}` and moves the single top folder's contents.
- On failure the log stays on screen, and every folder created by this
  run, plus shortcuts and the uninstall key, is removed.
- NSIS strings are at most 1024 characters, so plan lines must be shorter
  than that (a longer line would be split).

## Third-party binaries

The plugins are the XP-tested copies from win-auto-py3 (the operator's
earlier installer); `file_meta.txt` there lists the same hashes.

| File | Source | SHA-256 |
| --- | --- | --- |
| `plugins/x86-unicode/INetC.dll` | https://nsis.sourceforge.io/Inetc_plug-in | `85e03805f90f72257dd41bfdaa186237218bbb0ec410ad3b6576a88ea11dccb9` |
| `plugins/x86-unicode/HashInfo.dll` | https://www.pawelporwisz.pl/nsis/plugins/HashInfo/HashInfo.php (one DLL for ANSI and Unicode) | `6ed33858b59ca6cb769db55c6a841288a1e08603409d5448867bc15eda4068ce` |
| `plugins/x86-unicode/nsisunz.dll` | https://nsis.sourceforge.io/Nsisunz_plug-in | `c31b590cba443de87f0f4a81712f0883ac3b506f3868759d918d9a81f84ea922` |
| `tools/7za.exe` | 7-Zip 9.20, `7za.exe` from https://www.7-zip.org/a/7za920.zip (zip sha256 `2a3afe19c180f8373fa02ff00254d5394fec0349f5804e0ad2f6067854ff28ac`) | `c136b1467d669a725478a6110ebaaab3cb88a3d389dfa688e06173c066b76fcf` |

MoreInfo isn't needed: the backend URL is a `!define` and the record's
`backend` line. HashInfo is 1.5 MB, most of the base's ~960 KB; SHA-256
through CryptoAPI with the System plugin would save about 0.6 MB if size
matters.
