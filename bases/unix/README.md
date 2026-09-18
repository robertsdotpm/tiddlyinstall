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
| `--yes` | Don't ask (install or uninstall unattended). No dialog of any kind is opened: messages go to stderr, and when administrator rights are needed without a terminal only `sudo -n` is tried |
| `--log=PATH` | Write the log here. Otherwise it goes to `$TMPDIR/ib-<time>-<pid>.log`, is kept on failure, and is copied to `<app>/install.log` on success |
| `--record=PATH` | Use this `ib-record` |
| `--plan=PATH` | Use this `ib-plan` (without it, the plan comes from the metadata or the backend). It must be signed by the built-in key: save it from `<backend>/api/plan/<record>` |
| `--unsigned-plan` | Accept an unsigned or edited `--plan` (or `install.txt` plan), for plans you wrote yourself; the transparency screen says so |
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

With a record and no plan, the plan comes from `<backend>/api/plan/<hash>`.

### Plan signatures

The plan signing key ([format.md](../../docs/format.md), "Plan
signature") is baked in at build time: `make_run.sh` and `make_app.sh`
fill the engine's `IB_PLAN_PUBKEY=` and `IB_PLAN_KEYID=` lines
(`plankey.sh`) from `IB_PLAN_PUBKEY_FILE`, by default
`../../server/data/plan-signing-key.pub`, which the server writes on its
first start. They refuse to build without it.

The engine checks the signature with `openssl pkeyutl -verify -pubin
-rawin`, after proving that works on RFC 8032 test vector 2 (and that a
changed message fails). Then:

| Plan from | Signed by the built-in key | Unsigned or wrong | No way to check (see below) |
| --- | --- | --- | --- |
| a backend (`/api/plan/…`) | used | refused | used only if fetched over **HTTPS**, with a warning; refused over plain HTTP |
| `--plan`, or `install.txt` that is a plan | used | refused unless `--unsigned-plan` | refused unless `--unsigned-plan` |
| embedded (`.run` block, `.app` Resources) | used | used, with a warning | used, with a warning |

Every plan's `record` line must be the record being installed (an
embedded plan for an edited record is refused; the browser editor
rewrites the line and drops the signature). A plan by name must carry
the signed `request<TAB>name<TAB><runtime><TAB><package>` line the file
name asked for.

**When openssl can't check Ed25519.** That needs OpenSSL 1.1.1 or later.
RHEL/CentOS 7 (1.0.2), CentOS 6, and macOS's `/usr/bin/openssl`
(LibreSSL) can't; neither can a machine with no `openssl`. The engine
then fails closed on plain HTTP and accepts a plan only when it came over
HTTPS (curl and wget check the certificate, so it came from the
backend), and says so on the transparency screen. A warning instead of
refusing would have made the signature optional for exactly the old
machines on plain HTTP it exists for. On such machines, install OpenSSL
1.1.1+ (it only needs to be on `PATH`) or use an HTTPS backend.

**Mode A on macOS.** An `.app` signed with an identity (not ad hoc) whose
signature verifies and which has no files in `Contents/Resources/ib` is a
mode A base: it refuses `--record`, `--plan`, `--unsigned-plan` and
`--backend`, ignores `install.txt` and the record's `backend` line, and
only installs the record named in its bundle name from the built-in
backend (design.md section 3). Linux `.run` files carry no signature, so
nothing is locked there. `IB_TEST_MODE_A=1` turns the restriction on
anywhere, for tests.

curl, wget and openssl run with `HOME` set to the engine's temp folder,
so they can't leave `~/.pki` (curl with NSS on CentOS 7), `~/.wget-hsts`
or `~/.rnd` behind, and don't read the user's `~/.curlrc`.

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
   signature still verifies), where the metadata and plan came from,
   the plan signing key's id when the plan is signed, and a warning when
   a plan was accepted without a checked signature (above).
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
   Before that, the block's **prerequisites** (`need` entries, format.md
   "Prerequisites") are checked and, if missing, installed (below).
6. Unpacks the source into the app folder, runs `install` in it with
   `env`, `unset`, `ienv`, `iunset` and `path` applied.
7. Writes `launch.txt` (format.md 5), `launch.sh`, `uninstall.sh`, the
   menu entries, and `manifest.txt` last. If the record has an `icon`
   (format.md section 2) and the pack holds that PNG, it is copied to
   `<app>/icon.png` and the `.desktop` file's `Icon=` is its absolute
   path; otherwise `Icon=application-x-executable`.

### Prerequisites

A plan block can list system-wide prerequisites (`need`, format.md
"Prerequisites"): a shared library (`ncheck lib`), a command (`ncheck
cmd`) or a file (`ncheck file`), with distro package names per package
manager (`npkg`). Checks only look (`ldconfig -p` for this arch, else the
usual library folders; `command -v`; `[ -e ]`), so they run before the
transparency screen, which lists each prerequisite as present or
missing, why it is needed, the packages and the exact root command.

After the user agrees, the missing ones are installed with the first
package manager found (`apt-get`, `dnf`, `yum`, `zypper`, `apk`,
`pacman`), in one command, as root, for **that command only** (the app
still installs for the user):

| Situation | How it becomes root |
| --- | --- |
| already root | runs it |
| `sudo -n` works (no password needed) | `sudo -n sh -c ...` |
| `--yes` otherwise | doesn't: stops with **exit code 2** and the command to run, e.g. `sudo apt-get update && sudo apt-get install -y libatomic1` |
| a terminal | `sudo` (asks for the password there) |
| a desktop, no terminal | `pkexec` |

`apt-get install` is retried after `apt-get update` (fresh cloud images
have no package lists). The checks then run again; one still failing
stops the install. Nothing is removed on uninstall: other programs may
use the packages.

A missing prerequisite with no package for this machine's manager (or on
macOS, where there is no package manager to use) stops the install with
exit code 2 and the plan's `nhow` text. With a terminal or dialogs and
without `--yes`, the plan's `nstart` command is run first, as the user:
for Xcode's Command Line Tools that is `xcode-select --install`, which
opens Apple's own installer; the user runs this installer again after it.

`test_prereqs.sh` tests all of this offline in a clean environment
(`env -i`, a throwaway `HOME`, no display) with a fake package manager
and `sudo` on `PATH`, plus the icon.

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
| anything else | Fails the install (format.md: an unknown step is never skipped) |

Everything shown on screen (the transparency text, dialogs, the log tail
on failure) passes through `ib_clean`: control characters (C0 but tab
and newline, DEL, C1) and bidi controls (U+200E/F, U+202A-202E,
U+2066-2069) become `?`, so plan text can't blank or reorder the
terminal or a dialog.

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
  base32 characters, not the app folder, and their `.ib-owner` names this
  app (a missing `.ib-owner` counts as someone else's);
- then the app folder, if its own `.ib-owner` names the app, then the
  root if empty;
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
