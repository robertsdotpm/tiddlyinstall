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
| `build.sh` | Builds `out/launcher.exe`, then `out/base.exe`, which embeds it and the plan signing key |
| `append_meta.py` | Appends a metadata block (format.md section 4) to a base, for testing |
| `plugins/x86-unicode/` | NSIS plugins (below) |
| `plugin-src/` | Source of our `ibsig` plugin and its `build.sh` |
| `tools/7za.exe` | 7-Zip 9.20 command line, for `7z` and `tar.*` |

```sh
./build.sh                                        # out/launcher.exe, out/base.exe
IB_BACKEND=http://127.0.0.1:8091 IB_OUTFILE=out/base-test.exe ./build.sh
IB_PLAN_PUBKEY_FILE=/srv/ib/data/plan-signing-key.pub ./build.sh
python3 append_meta.py out/base.exe app.exe --record record.txt --plan plan.txt [--pack FILE...]
python3 append_meta.py --hash record.txt          # the record's 26-character hash
python3 append_meta.py --show app.exe             # the footer an exe carries
```

`makensis` is `~/.local/bin/makensis` (NSIS 3.09 with its stubs under
`~/.local/opt/ib-tools`). `out/` is not committed.

**The plan signing key** ([format.md](../../docs/format.md), "Plan
signature") is built into the base: `build.sh` reads one line of base64
(the raw 32-byte Ed25519 public key) from `IB_PLAN_PUBKEY_FILE`, by
default `../../backend/data/plan-signing-key.pub`, which the server writes
on its first start. It refuses to build without one. A base only trusts
plans from the server whose key it was built with, so production bases
must be built with production's `plan-signing-key.pub`.

## Command line

Values end at the next space, or at a closing `"` if they start with one
(`/log="C:\My logs\i.log"`). `/` inside a value is fine.

| Option | Meaning |
| --- | --- |
| `/S` | Silent: no pages, same engine. Exit code 0 = installed, 2 = couldn't start (no metadata, no matching target, a `fail` block, no admin rights, a plan refused, a missing prerequisite it may not install), 3 = install failed and was rolled back |
| `/log=<path>` | Append the detail log (the transparency text, every download, step and command output) to a UTF-8 file |
| `/record=<path>` | Use this record; the plan comes from `/plan=` or the backend |
| `/plan=<path>` | Use this plan. It must be signed by the built-in key (save it from `<backend>/api/plan/<record>`) |
| `/unsigned-plan` | Accept an unsigned (or edited) `/plan=`, for plans you wrote yourself. The review page says so |
| `/backend=<url>` | Backend for records and plans. Otherwise the record's `backend` line, otherwise the built-in `IB_BACKEND` (`http://10.0.1.76:8080`) |
| `/reinstall` | Install again even when this app is already fully installed with the same record (below) |
| `/?`, `/help` | Show these options and quit |
| `/ib-elevated` | Internal: marks the copy started with `runas` |

**Running it again.** If the app is already fully installed where this
installer would put it, with the same `appid` and record hash (the same
settings), the installer doesn't install again: in `.onInit`, before any
page, it starts the app through `launch.exe`, as the shortcuts do, and
quits with exit code 0. With `/S` it never starts the app: it logs that
the app is installed and exits 0. "Fully installed" means
`<app>\.ib-installed` (format.md section 5), the last file a successful
install writes, names this appid and record, and the folder's
`.ib-owner` names the app. A different record (new settings, a new
version) has another appid, so it installs beside the old one as before.
This works offline: the appid is derived from the record hash alone
(`base32(sha256(<hash> "/app"))[:12]`), so with an embedded, `/record=`
or `install.txt` record (its `root` and `rootname` say where to look),
or the hash in a mode A file name (looked for in the default folders for
one user and for all users), the marker is checked before anything is
fetched. Only plans by name, whose record hash only the server knows,
are checked after the plan is fetched. `/reinstall` goes
on to install, removing the earlier install first as before.

**Mode A (a signed base with no appended block)** accepts none of
`/record=`, `/plan=`, `/unsigned-plan` and `/backend=` (it stops with
exit code 2 and says why), ignores `install.txt` and the record's
`backend` line, and installs only the record named in its file name,
from the built-in backend (design.md section 3). Use an unsigned base
(mode C) or your own signed build (mode B) for custom settings.

**Plans must be signed.** A plan fetched from a backend, and a
`/plan=` file without `/unsigned-plan`, is refused unless the `ibsig`
plugin finds a valid signature by the built-in key; a plan embedded in
the installer may be unsigned (the review page warns). Every plan must
name the record being installed, and a plan by name must say, in its
signed `request` line, the runtime and package the file name asked for.
The review page shows the key id.

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
again with `runas` (Vista and later) and wait for that copy. With `root
system`, `C:\<rootname>` gets a protected ACL (owner Administrators;
Administrators and SYSTEM full control, Users read and execute, nothing
inherited from `C:\`), set with `SetNamedSecurityInfoW` from SDDL so it
works the same from XP on and doesn't depend on localised group names.
Every folder the installer makes holds a `.ib-owner` file naming the app
(format.md section 5).

Shortcuts: Start menu folder `<App>` holding `<App>.lnk` (to
`launch.exe`) and `Uninstall <App>.lnk`, plus a desktop shortcut if
`desktop 1`. With `menu 0` nothing is written to the Start menu (no
shortcut, no uninstaller shortcut, no folder); the app is started with
`launch.exe`, the desktop shortcut or by running the installer again,
and the review and finish pages say so. Add/Remove Programs (always):
`HKCU` (or `HKLM`)
`Software\Microsoft\Windows\CurrentVersion\Uninstall\ib-<appid>`.
The last thing a successful install writes is `.ib-installed` (to a
temporary name, then renamed); an earlier install of the same app is
removed first (its `.ib-installed` before anything else).

The uninstaller deletes `.ib-installed` first (so a half-finished
uninstall is never taken for an install), then reads `manifest.txt` in
its own folder and removes only
`dir` entries that are `<root>\<12 base32 chars>` and whose `.ib-owner`
names this app, `.lnk` shortcuts in a Start menu or desktop folder (then
the app's Start menu folder, if empty), and the app's own `ib-<appid>`
uninstall key; then its own folder, if its `.ib-owner` names the app, and
the root if that is now empty. A folder with a missing or different
`.ib-owner` is kept and reported. Like every NSIS uninstaller it runs
from a copy in `%TEMP%\~nsuN.tmp`, which Windows deletes at the next
reboot; the `uninstall.exe` it was started as may still be running for a
moment, so removing the app folder is retried for up to 15 s, then left
to the next restart (`/REBOOTOK`).

## Prerequisites

A plan block's `need` entries (format.md "Prerequisites") are checked in
`.onInit`, before the review page: `reg` reads a DWORD in the 32- or
64-bit registry view (present if at least the minimum), `file` looks for
a path with `%VARIABLES%` expanded and file-system redirection off (so
`System32` is the native one). The review page lists each as already
installed or missing, why the app needs it, and for missing ones the
installer file, its SHA-256 and URLs, and the command that will run.

Any missing one with an `nrun` makes the install need administrator
rights, through the same `runas` relaunch as `root system` and `admin 1`
(Vista and later; XP must be run as an administrator). A silent install
(`/S`) without administrator rights doesn't prompt: it stops with exit
code 2 and a message naming what is missing. A missing one without
`nrun` stops with exit code 2 and the plan's `nhow`.

In the install, prerequisites come first, before anything of the app
(or an earlier install of it) is touched: each missing one's `nfile` is
taken from the pack or downloaded from its `nurl`s and checked by
SHA-256, `nrun` is run through `cmd /c` with `{file}` as its path, and
an exit code outside `nok` (default `0`) fails the install (exit code
3). `3010` means Windows wants a restart; it is logged and the install
goes on. Then every check must pass. A prerequisite is never removed,
on failure or by the uninstaller: it is shared with other programs.

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
- The review page and error dialogs show control characters (C0 but tab
  and newlines, DEL, C1) and bidi controls (U+200E/F, U+202A-202E,
  U+2066-2069) from the record and plan as `?` (`ibsig::cleanfile`,
  `ibsig::cleanstr`), so a name can't reorder or hide what is shown.
- An HTTP 451 from the backend is reported as a takedown (design.md 7).

## Stale plans (2026-09-20)

The engine sends `?nonce=` with every plan it fetches and refuses one
that answers another request; for a plan it carries, it fetches the
signed revocation list and judges the plan's age by `signed`/`maxage`,
but only when this machine's clock is plausible against `IB_BUILD_DAYS`
(design.md 7.1, format.md sections 3 and 7). Days, not seconds: NSIS
arithmetic is 32-bit signed and epoch seconds overflow it in 2038.

**Not yet run on a VM** (2026-09-20; the ESXi machines are waiting on
credentials). It compiles (`makensis -WX`, so warnings are errors) and
the shared plan-signature code is covered by the plugin's host test, but
nothing here has executed on Windows. What to run when the VMs are
available, on **XP SP3** (the oldest engine path, and the worst clock)
and **Windows 11** (the newest):

1. Build a base against a throwaway key and a local backend, as
   `bases/unix/test_freshness.sh` does for the other engine:
   `IB_PLAN_PUBKEY_FILE=... IB_BACKEND=http://<host>:<port> ./build.sh`.
   Serve that port with `python3 -m http.server` over a folder holding
   `api/records/<hash>`, `api/plan/<hash>` and `api/revocations` --
   it ignores the query string, which is what lets a pre-signed answer
   stand in for one made for this nonce.
2. **Nonce.** Name the .exe `install_..._<hash>.exe` and run it against
   a plan that echoes the nonce, one that echoes another, and one that
   echoes none. There is no `IB_TEST_NONCE` here, so read the nonce the
   engine sent out of its log (`Fetching the plan: ...?nonce=...`) and
   sign the answer for it, or point the port at a two-line CGI that
   signs on the fly. Expect: installs; **refuses** with "the answer to
   another request"; installs with "no nonce in the answer" on the
   review page.
3. **The list.** With `/plan=` and `/record=` (a carried plan), serve a
   revocation list naming the record, then `source github <owner/repo>`,
   then `file <sha256>` of a file the plan downloads. Each must refuse
   with "has been withdrawn". Then serve one naming something else, and
   one signed as an `ib-plan`: both must install, the second logging
   "not the document this installer asked for". Then kill the server and
   run again: `%LOCALAPPDATA%\TiddlyInstall\revocations.txt` must still
   refuse it.
4. **Age.** A carried plan with `signed` 120 days back (warn and
   install), 400 days back (**refuse**, naming the 365-day limit), and
   the same 400-day plan against a base built with
   `SOURCE_DATE_EPOCH=$(date -d "+10 years" +%s)` -- the wrong-clock
   case, which **must install** with "which can't be right". On XP, set
   the machine's clock back to 2001 and check the 400-day plan still
   installs: that is the case the whole design exists to protect.
5. **Old and new.** A plan carrying `signed`, `maxage` and a
   `request<TAB>nonce` line, given to a base built from the engine
   before this change (`git show <rev>:bases/windows/base.nsi`), must
   still install when it is a plan by record.

## The `ibsig` plugin

`plugins/x86-unicode/ibsig.dll` (ours, built from `plugin-src/`):

```nsis
ibsig::check "<plan file>" "<base64 public key>"  ; Pop: ok | unsigned: … | bad: … | error: …
ibsig::checkdoc "<file>" "<key>" "ib-revocations" ; the same for another document the plan key signs
ibsig::cleanfile "<UTF-16LE file>"                ; rewrites it with unsafe characters as '?'
ibsig::cleanstr "<text>"                          ; Pop: the cleaned text
```

Ed25519 verification is TweetNaCl 20140427 (public domain), cut down to
what verifying needs (SHA-512, field and point arithmetic, reduction mod
L, point decompression) plus the RFC 8032 check that S < L, which
TweetNaCl leaves out. `plancheck.c` finds the `sig` line and checks the
signed bytes start with the header the caller asked for -- `ib-plan<TAB>`
for a plan, `ib-revocations<TAB>` for the revocation list (format.md
section 7) -- so one kind's signature can never be read as the other's. The DLL links no C runtime and
imports only `CreateFileW`, `ReadFile`, `WriteFile`, `SetFilePointer`,
`GetFileSize`, `CloseHandle`, `GlobalAlloc`, `GlobalFree` and
`lstrcpynW` from kernel32; it is built for Pentium MMX (no SSE2) with
subsystem and OS version 5.1, so XP's loader takes it. Tested on XP SP3
and Windows 10. The committed DLL (llvm-mingw 20260908, no timestamp) has
sha256 `9b473a027c8e1161c6be7db401de557c3bab16fc023c88a848b3084496686c0b`.

```sh
LLVM_MINGW=~/.local/opt/llvm-mingw-20260908-msvcrt-ubuntu-22.04-x86_64 plugin-src/build.sh
```

`plugin-src/build.sh` also builds `test_host.c` with the host compiler
and runs the RFC 8032 test vectors; `test_host <plan> <key>` checks a
plan file the way the plugin does. llvm-mingw
(https://github.com/mstorsjo/llvm-mingw) is a tarball: unpack it
anywhere, nothing is installed.

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
