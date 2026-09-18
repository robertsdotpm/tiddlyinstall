# Linux and macOS base installer

One POSIX `sh` engine, [`ib-engine.sh`](ib-engine.sh), is the whole base
installer on both systems (docs/plan.md 1.4). It reads the formats in
[docs/format.md](../../docs/format.md) with `awk`. Nothing in it is
per-runtime: runtimes and their quirks arrive as plan data. Only platform
plumbing branches on the OS: the downloader, the SHA-256 tool, the OS
version, dialogs, and menu entries.

| File | What it is |
| --- | --- |
| `ib-engine.sh` | The engine. Also copied into every installed app as `uninstall.sh` |
| `make_run.sh` | Builds the Linux base `out/ib-base.run` (the engine, syntax-checked with dash, bash and busybox) |
| `make_app.sh` | Builds the macOS base `out/Install.app` and `out/ib-base-macos.zip`. On a Mac it is ad-hoc signed and zipped with `ditto` |
| `append_meta.py` | Test tool: adds a record, plan and pack to a `.run` (appended block) or a base zip (`Contents/Resources/ib/`). The Go server has its own implementation |

Builds go to `out/` (ignored by git).

## Running it

```
sh install_node_hello_<hash>.run            # Linux (any file name works)
Install.app/Contents/MacOS/install          # macOS, from a terminal
```

| Option | Meaning |
| --- | --- |
| `--yes` | Don't ask (install or uninstall unattended). Also skips the done/failed dialogs |
| `--log=PATH` | Write the log here. Otherwise it goes to `$TMPDIR/ib-<time>-<pid>.log`, is kept on failure, and is copied to `<app>/install.log` on success |
| `--record=PATH` | Use this `ib-record` |
| `--plan=PATH` | Use this `ib-plan` (without it, the plan comes from the metadata or the backend) |
| `--backend=URL` | Where records and plans are fetched from. Otherwise the record's `backend` line, then `http://10.0.1.76:8080` |
| `--uninstall` | Uninstall mode. `uninstall.sh` also switches to it by itself when `manifest.txt` is next to it |

**How it asks.** In a terminal it prints the transparency text and asks
`[y/N]`. Without a terminal on Linux it uses `zenity --text-info`, or
`kdialog`, when there is a display. On macOS (double-clicked, so no
terminal) it uses `osascript` dialogs: a short summary with **Details...**
(opens the full text in TextEdit) and **Continue**, then a final "done"
or "failed" dialog with the log path. Plan text is passed to
`osascript` as arguments, never pasted into the AppleScript. If there is
no way to ask and no `--yes`, it stops.

## Where the metadata comes from

In order (plan.md 1.1):

1. `--record` / `--plan`.
2. **The embedded metadata.** Linux: the block at the end of the `.run`
   (format.md section 4). The engine reads the 64-byte footer with
   `tail -c 64` and cuts out the parts with `tail -c +N | head -c LEN`.
   macOS: `Contents/Resources/ib/record.txt`, `plan.txt`, and packed files
   in `pack/<sha256>` (a `pack.tar` there works too).
3. `install.txt` next to the installer (next to the `.app` on macOS),
   either an `ib-record` or an `ib-plan`.
4. **Mode A:** a 26-character base32 hash as the last `_` token of the
   file name (`.run` stripped; on macOS the `.app` bundle's name; copy
   suffixes ` (1)`, `(1)` and ` - Copy` stripped; case ignored). The
   record comes from `<backend>/api/records/<hash>` and must hash to the
   same name, or nothing is installed.
5. **Plain tokens** `install_<runtime>_<package>`: fetches
   `<backend>/api/plan/name/<runtime>/<package>` (docs/api.md, "Plans by
   name"): the package from the runtime's registry with default settings.

With a record and no plan, the plan comes from `<backend>/api/plan/<hash>`
and its `record` line must match. An embedded plan whose `record` line
doesn't match the record (someone edited the record) is used, with a
warning on the transparency screen.

The pack is used whatever the metadata's source: before downloading a
`file` (or the source), the engine looks for its SHA-256 in the pack.

## What it does

1. Picks the first `[target]` whose `when` matches: `linux` plus the
   glibc version as `major*100+minor` (`getconf GNU_LIBC_VERSION`, else
   `ldd --version`; `0` for musl), or `macos` plus `sw_vers
   -productVersion`; the arch from `uname -m` (`x86_64`/`amd64` → amd64,
   `i?86` → x86, `aarch64`/`arm64` → arm64; on macOS `hw.optional.arm64`
   wins over Rosetta). No match, or a `fail` line: stops with the message.
2. Shows the transparency text: project and source, runtime, record
   hash, every download with size, SHA-256 and URLs (or "packed"), every
   `run` command and the install and launch commands with tokens filled
   in, every folder, the shortcuts and uninstaller, `note`s, whether
   admin rights are needed, who signed the installer (Linux: nobody,
   plus the file's SHA-256; macOS: `codesign -dv`, and whether the
   signature still verifies), and where the metadata and plan came from,
   with a warning when the plan came over plain HTTP.
3. `root system` or `admin 1`: re-runs itself as root, with the record
   and plan already resolved: `sudo` in a terminal, `pkexec` on a Linux
   desktop, `osascript ... with administrator privileges` on macOS.
   **Untested** (no root on the test machines).
4. Installs into `<root>/<appid>/` and one `<root>/<hash12>/` per `file`
   (`hash12` = base32 of SHA-256 of `appid` + the file's `name`, with no
   separator). The root is `~/.local/share/<rootname>` (honours
   `XDG_DATA_HOME`) or `~/Library/Application Support/<rootname>`;
   system-wide `/opt/<rootname>` or `/Library/Application
   Support/<rootname>`. It refuses an app folder that already exists
   (same app: "uninstall first"; another app's manifest: collision) and a
   file folder whose `.ib-owner` names another app.
5. Per `file`: pack, else each `url` in turn (`curl -fL`, 20 s connect
   timeout, abort below 1 KB/s for 60 s, 2 retries; else `wget -T 60 -t
   2`), SHA-256 checked (`sha256sum`, `shasum -a 256` or `openssl`), a
   wrong checksum moves on to the next URL. Then the steps. A file with no
   steps is copied into its folder as is.
6. Unpacks the source into the app folder, runs `install` in it with
   `env`, `unset`, `ienv`, `iunset` and `path` applied.
7. Writes `launch.txt` (format.md 5), `launch.sh`, `uninstall.sh`, the
   menu entries, and `manifest.txt` last.

On any failure, everything this run created is removed, newest first
(folders it only created as parents are removed only if empty), and the
log is shown: its last lines in a terminal, the whole log in zenity, the
path and last lines in an `osascript` dialog.

### Steps

| Step | Unix behaviour |
| --- | --- |
| `unpack` | `tar` (`-o` when root); `tar.gz` via `gzip -dc`; `tar.xz` via `xz -dc`, else `tar -xJf` (macOS has no `xz`, its libarchive `tar` reads it); `tar.bz2` via `bzip2 -dc`; `zip` via `unzip`, else `ditto -x -k`; `7z` via `7zz`/`7z`/`7za`/`7zr` if present, else it fails saying so. Extraction goes to a staging folder; `strip 1` then moves the contents of each top-level folder into `dest` (merging), and drops top-level plain files, like `tar --strip-components=1`. `strip` isn't passed to `tar` because busybox and old tars lack it. A leading `./` is not counted as a component |
| `run` | `sh -c` in `{dir}`, stdin from `/dev/null`, output to the log. Non-zero fails. `IB_APP_DIR`, `IB_RUNTIME_DIR`, `IB_APP_NAME` are exported (design 1.5) |
| `mkdir`, `write`, `delete` | Only inside the app's folders or `{tmp}` (no `..`); anything else fails the install. `write` appends a line ending in `\n` |

Tokens are replaced by plain string substitution in `awk`, with values
passed through the environment so nothing is re-escaped; unknown `{...}`
is left alone. Token values are pasted raw into shell command strings, so
recipes must quote them (`"{runtime}"`); the macOS root contains a space.
The engine refuses an install root containing `"`, `$`, backtick or
backslash, which quoting can't protect.

## The launcher

`launch.sh` in the app folder is **the same script for every app**: it
reads `launch.txt` next to it (`cwd`, `env`, `unset`, `path` prepended in
order, `exec`) and runs `eval "exec <exec line> \"$@\""`, so the exec line
is shell-quoted text and arguments pass through. I chose this over
generating a resolved script so the launcher is identical everywhere
(design 1.7) and `launch.txt` stays the single source of truth.

- **Linux:** `~/.local/share/applications/ib-<appid>.desktop` runs
  `launch.sh` (`Terminal=true` when `console 1`).
- **macOS:** `~/Applications/<App>/<App>.app` is a minimal bundle
  (Info.plist, `Contents/MacOS/run`, a shell script that runs
  `launch.sh`, and `Contents/Resources/ib-appid`). With `console 1` it
  runs `open -a Terminal launch.sh`, unless it already has a terminal
  or `IB_NO_TERMINAL` is set.

## Menus and uninstalling (plan.md 1.7)

| | Linux | macOS |
| --- | --- | --- |
| App | `~/.local/share/applications/ib-<appid>.desktop` | `~/Applications/<App>/<App>.app` |
| Uninstaller | `ib-<appid>-uninstall.desktop` → `sh <app>/uninstall.sh --uninstall` (in a terminal) | `~/Applications/<App>/Uninstall <App>.app` |
| Menu folder | `~/.local/share/desktop-directories/ib-<appid>.directory` + `~/.config/menus/applications-merged/ib-<appid>.menu` | the `~/Applications/<App>/` folder |
| Desktop (`desktop 1`) | a copy of the `.desktop` in the XDG desktop folder, if it exists | a symlink on `~/Desktop` |

System installs use `/usr/local/share/applications`,
`/usr/local/share/desktop-directories`, `/etc/xdg/menus/applications-merged`
and `/Applications/<App>/`. GNOME Shell ignores `applications-merged`
menus, so there the two entries appear in the app grid without a folder.

`uninstall.sh` is a copy of the engine (the `.run` minus its block). It
reads `manifest.txt` next to it and removes exactly what it lists:

- `shortcut` files only if named `ib-<appid>*`; symlinks; `.app` bundles
  only if their `Contents/Resources/ib-appid` names this app;
- `dir` entries only if they are directly in the install root, 12
  base32 characters, not the app folder, and not owned by another app;
- then the app folder, then the root if empty;
- `shortcut` entries that are folders (parents the installer created,
  such as `~/Applications/<App>` or `~/.config/menus`) only if empty.

Any path with `..`, a relative path, or a failed check is refused and
reported. It asks first (terminal, zenity/kdialog, or `osascript`) unless
`--yes`. If the root isn't writable it re-runs itself as root.

## macOS notes

- The `.app`'s executable is a shell script. That is fine for a proof of
  concept: LaunchServices runs it with `/bin/sh` (bash 3.2 in POSIX mode
  on macOS 26), and `codesign` signs it, storing the signature in
  `Contents/_CodeSignature/` (no extended attributes, so any zip tool
  keeps it). A native stub would later give a proper About window,
  `Credits.rtf`, and a Dock icon that doesn't vanish.
- **Mode A:** renaming the `.app` (or the zip) keeps the signature valid.
  The bundle name is read from the executable's path, which App
  Translocation preserves. (`install.txt` next to a translocated `.app`
  can't be found; use mode A, B or C on macOS.)
- **Mode B:** the publisher adds the files to `Contents/Resources/ib/`
  and re-signs (`codesign -s <identity> -f Install.app`); `codesign
  --verify` then passes.
- **Mode C:** adding files breaks the base's ad-hoc signature, and a
  broken signature is worse than none (Gatekeeper says "damaged"). So
  `append_meta.py app --strip-signature` drops `_CodeSignature/`; the
  browser editor should do the same.

## Testing

See the report in the commit that added this folder. In short: hello-world
Node.js 22.23.2 and Python 3.14.7 (python-build-standalone) apps, modes
A, B and C, installed, run through the launcher, and uninstalled with
nothing left, on Ubuntu 24.04 (glibc 2.39, dash, bash and busybox sh) in
a throwaway `HOME`, and macOS 26.2 arm64 (`/bin/sh` and `/bin/dash`).
