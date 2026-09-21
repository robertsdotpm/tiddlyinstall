# Linux and macOS base installer

One POSIX `sh` engine, [`ti-engine.sh`](ti-engine.sh), is the whole base
installer on both systems (docs/plan.md 1.4). It reads the formats in
[docs/format.md](../../docs/format.md) with `awk`. Nothing in it is
per-runtime: runtimes and their quirks arrive as plan data. Only platform
plumbing branches on the OS: the downloader, the SHA-256 tool, the OS
version, dialogs, and menu entries.

| File | What it is |
| --- | --- |
| `ti-engine.sh` | The engine. Also copied into every installed app as `uninstall.sh` |
| `make_run.sh` | Builds the Linux base `out/ti-base.run` (the engine, syntax-checked with dash, bash and busybox) |
| `make_app.sh` | Builds the macOS base `out/TiddlyInstall.app` and `out/ti-base-macos.zip`. On a Mac it is ad-hoc signed and zipped with `ditto` |
| `macos-readme.txt` | Goes into that zip as `Read Me First.txt`, **beside** the app. Below |
| `verify/` | `tiverify`, the Ed25519 verifier the bases carry: source, `build.sh` (Zig), the built binaries |
| `test_verify.sh` | Plan signature cases (good over plain HTTP, `--plan`, tampered, replayed, unsigned) with openssl shadowed |
| `test_freshness.sh` | Stale plans (design.md 7.1): the nonce echoed, another nonce refused, none noted; the revocation list by record, source and file, cached and used offline, ignored when signed as the wrong kind; `signed`/`maxage` fresh, past `maxage`, past the hard limit, and **not refused when the clock can't be believed**; and a plan with the new fields on the engine from before them. Runs on Linux and on macOS (18/18 on both, 2026-09-20); on Darwin it builds and runs the `.app`, because a `.run` there has no verifier it can execute and LibreSSL cannot check Ed25519. `TI_OLD_ENGINE_FILE` stands in for the git checkout a Mac hasn't got |
| `test_prereqs.sh` | Prerequisites and the record icon |
| `append_meta.py` | Test tool: adds a record, plan and pack to a `.run` (appended block) or a base zip (`Contents/Resources/ti/`). The Go server has its own implementation |

Builds go to `out/` (ignored by git).

## Running it

**`sh <file>`, with no `chmod`.** A browser download has no executable
bit and GNOME will not run a text file anyway, so a double-click opens
the installer in an editor. `sh foo.run` needs no bit, so it is the one
command worth telling anybody; tested at mode 644 under bash, dash and
busybox. The engine's first lines say so to whoever opened it in the
editor (design.md 3, "Opened in a text editor instead of run"), and
`src/shared/builder.js` (`nameTheRun`) writes the app's name into that box
in place, to the same byte length, because the verifier offsets baked
into `TI_VERIFY_BLOBS` are absolute. Modes B and C only: a mode A file
stays byte for byte the base we publish.

```
sh install_node_hello_<hash>.run            # Linux (any file name works)
TiddlyInstall.app/Contents/MacOS/install          # macOS, from a terminal
```

**How the review is shown** (2026-09-21). Three ways, and which one you
get is decided before anything is fetched:

| | |
| --- | --- |
| **A window** | No arguments, and a display we can see. `zenity --text-info` (monospace, Install and Cancel as the buttons), else `kdialog --textbox` followed by its yes/no. Scrollable, resizable, and the whole review is in it. This is what `sh installer.run` on a desktop gets, which is what the box at the top of the file tells people to type |
| **The whole text** | Any argument, no display, `TI_NO_GUI=1`, or a display we could not open. Printed to stderr at once, terminal scrollback and all, with the one-line decision above the `Install X? [y/N]` prompt. This is the ordinary way to install over SSH and it is not a consolation prize: it is the same text, unabridged |
| **macOS** | Unchanged: a terminal gets the text, a double-clicked `.app` gets the `osascript` dialog with the full text behind "Details...". That dialog is not a review window, so taking a Terminal user out of the terminal would be a downgrade |

**There are two widths, 74 and 68, and no others** (2026-09-21).
**zenity and kdialog do not wrap anything**: `ti_confirm` hands them the
same `$TI_WORK/confirm.txt` the terminal gets, already hard-wrapped at 74
by `ti_wrap`, and shows it in a monospace box. So the window size decides
how much you can see at once and nothing about where the lines break —
`ti_dialog_size` is in pixels and is never converted back into columns.
On a 1920x1080 screen the dialog is 980x820, and 74 monospace columns are
about 590 px in it, so the widget never has to re-wrap; the 640 px floor
would be reached only on a screen narrower than 720 px. macOS is the one
exception, and it is a *second* pre-wrap rather than a widget: the short
form is wrapped at 68 by the same function, and AppleScript's sheet then
wraps whatever still overflows.

The practical consequence, which is easy to get wrong: **a review-screen
line that skips `ti_wrap` is not "wrapped by the dialog", it is not
wrapped at all**, and whatever shows it breaks it — a terminal mid-word,
zenity flush left with the indent thrown away. `SYSTEM-WIDE
PREREQUISITES` did exactly that, unnoticed, until 2026-09-21: a
catalogue `nwhy` is a sentence (Ruby's is 225 characters), and it read
`...are compiled when t / he app's gems are installed`. Windows had the
same fault in `NeedSummary`, worse, because at indent 6 `tisig.c` sets
the line in Courier New 8 pt: about 1500 px in a control near 730. Both
go through their wrappers now (`ti_wrap`, `SumPara`). If you add a
section, wrap it.

**"Any argument" means any argument at all** — `--yes`, `--plan=`,
`--log=`, anything. Not a list of the interesting ones, because a list
is a thing to keep in step with `ti_main`, and because there is no flag
whose presence suggests somebody wants a dialog. The Finder's own
`-psn_...` is not an argument anybody passed and does not count.
`TI_NO_GUI=1` forces the text even on a desktop, for scripting and
capture.

**A display is in one of three states, and only one earns a window.**
`ok` (the socket is there), `unknown` (a display on another host, which
cannot be checked from here) and `no` (nothing, or a local display
whose socket is missing). A window needs `ok`. With no terminal either,
`unknown` is still tried, because refusing outright is worse and is
what this did before — but `no` never starts a dialog, because a local
display whose socket has gone is exactly the case that hangs.

**The socket is what is checked** —
`/tmp/.X11-unix/X<n>` for X11, `$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY` for
Wayland. `$DISPLAY` being set is not evidence: a stale variable or an X
forwarding that has gone away leaves it set and pointing at nothing,
and **both zenity and kdialog hang** on a display that is not there
rather than failing — no window, no error, no prompt (measured
2026-09-21 with `DISPLAY=:91`). A display on another host, including
the `localhost:10.0` an `ssh -X` gives, cannot be checked this cheaply
and so never earns the window; it is only tried when there is no
terminal either, which is where the alternative was an error anyway.
If a dialog does start and then reports that it could not open the
display, the terminal takes over with the review **and** the question,
never one without the other.

**kdialog's textbox is not monospace**, so the columns and the rules do
not line up in it the way they do in zenity and in a terminal. zenity is
tried first for that reason; kdialog is the fallback, not the equal.

| Option | Meaning |
| --- | --- |
| `--yes` | Don't ask (install or uninstall unattended). No dialog of any kind is opened: messages go to stderr, and when administrator rights are needed without a terminal only `sudo -n` is tried |
| `--log=PATH` | Write the log here. Otherwise it goes to `$TMPDIR/ti-<time>-<pid>.log`, is kept on failure, and is copied to `<app>/install.log` on success |
| `--record=PATH` | Use this `ti-record` |
| `--plan=PATH` | Use this `ti-plan` (without it, the plan comes from the metadata or the backend). It must be signed by the built-in key: save it from `<backend>/api/plan/<record>` |
| `--unsigned-plan` | Accept an unsigned or edited `--plan` (or `install.txt` plan), for plans you wrote yourself; the transparency screen says so |
| `--backend=URL` | Where records and plans are fetched from. Otherwise the record's `backend` line, then `http://10.0.1.76:8080` |
| `--reinstall` | Install again even when this app is already fully installed with the same record (below) |
| `--uninstall` | Uninstall mode. `uninstall.sh` also switches to it by itself when `manifest.txt` is next to it |

### `Read Me First.txt`, beside the app

The zip holds two things: `TiddlyInstall.app` (renamed per installer by
`src/shared/builder.js`) and `Read Me First.txt`, from `macos-readme.txt`.
It is **beside** the bundle, not inside it: Finder shows a bundle as a
single item, so a file under `Contents/` is invisible to the person who
just extracted the zip and would never be read.

It is the macOS counterpart of the `.run` header box — short, addressed
to someone who has just extracted this and does not know what it is —
and most of it is about what macOS is about to do to them: a
browser-downloaded app that Apple has not notarized is **killed** on
macOS 15 and later, with a dialog that offers no way forward, and the
only route is System Settings → Privacy & Security → **Open Anyway**
(Control-click → Open was removed in macOS 15), or `xattr -dr
com.apple.quarantine`. docs/macos-packaging.md section 5 is where that
was measured; an ad-hoc signature buys nothing over none, so the file
says plainly that we have no Apple Developer ID. It also says that a
copy that arrived by `curl`, `scp`, a USB stick or a file share is not
quarantined and simply opens, which is why the matrix has never seen
this.

Two consequences worth knowing:

- Being a **second top-level entry**, it changes what Archive Utility
  does with the zip: a double-click now extracts a folder holding the
  app and the readme, where before it dropped a bare `.app` into
  Downloads. That is the point — the readme is next to the app instead
  of being a file nobody opens.
- The text is generic, because the base is. It cannot name the app (the
  `.app` is renamed per installer and the record is not in it yet), so
  it says "the app beside this file" and points at the installer's first
  screen for the name. The `.run` slot-filling trick (`nameTheRun`) has
  no equivalent here and nothing needs one.

**The macOS base must be built on a Mac.** `make_app.sh` ad-hoc signs
the bundle (`codesign -s -`) and zips it with `ditto` only there;
anywhere else it writes an unsigned zip, which is not what mode A
installers ship and not what the golden suites were recorded with. The
engine is this same file, so an engine change reaches macOS as soon as
the base is built there -- and `out/ti-base-macos.zip` on this machine
is whatever was last built there, nothing more.

**Last built 2026-09-22T08:48:37+10:00** (`TI_BUILD_TIME`
`2026-09-21T22:48:37Z`) on the Mac test server (macOS 26.2 `25C56`,
arm64, `Matthew@the-mac-test-host`), for `Read Me First.txt`: the zip now
holds the readme beside the app, and the engine inside it is unchanged
from the build before.

| | |
| --- | --- |
| `out/ti-base-macos.zip` | `7f2fb049c6b7f18f70d91b01c39158e25c801dc3cc39a3c7320e1e10fe90afe7`, 71,376 bytes |
| the engine inside it | `ti-engine.sh` with the baked lines filled, and **only** those four lines: diffed against the committed source, four lines differ. `8a476ef672a6993a905c8695b3ed534157e5b9f5727cce7598e9009ac3d2e77f` |
| `Read Me First.txt` | 1,961 bytes, mode 644, a top-level entry beside `TiddlyInstall.app/` |
| plan signing key | `97930ea1888d1a12` (unchanged) |
| `TI_BUILD_TIME` / `TI_BUILD_EPOCH` | `2026-09-21T22:48:37Z` / `1790030917` |
| signature | ad-hoc; `codesign --verify --strict` is happy on the bundle **and** on the bundle re-extracted from the zip with `ditto` ("valid on disk", "satisfies its Designated Requirement", `Signature=adhoc`); `spctl -a` rejects it, as it must. The readme is appended with `zip` after `ditto` has written the archive, which copies the app's entries through unchanged — that re-extract check is what proves it |

The build before this one was rebuilt on 2026-09-21 at about 23:44
local from the engine with the review-screen changes committed that
evening, and this table was not updated for it: it recorded
`6b149a3a…` / 69,901 bytes (`TI_BUILD_TIME` `2026-09-21T13:35:49Z`)
while the file on disk was `57228a9db112dc6dba268891b05b8e2fbf507121bccf3a4380f863dbfcab0151`,
70,278 bytes. Noted rather than reconstructed; the engine in it is the
same source this build used.

The build before that was **2026-09-21T13:35:49Z**, from `ti-engine.sh`
with the review screen's last two wrapping faults fixed: `SYSTEM-WIDE
PREREQUISITES` now goes through `ti_wrap` like every other section, and
the signature's scope sits on its own line under the signer instead of
running past 74 and stranding `installs)`. Its zip was
`6b149a3a01c35aac3cce7a87534ec3c9583d3f94870c78df0f8d9f1dc4224dba`,
69,901 bytes, `TI_BUILD_EPOCH` `1789997749`.

The build before this one was **2026-09-21T11:57:18Z**, from
`ti-engine.sh` with the review screen telling the truth about a source
that has no stored hash. Two lines where it used to print `0 B` and a
bare `sha256 -`:

```
  2. 0e322af87745eff34caffe4df68456ebc20d9068.tar.gz  (the project itself)
     size not known in advance: the archive is made when it is fetched
     no stored SHA-256: identified by its commit, fetched over HTTPS
```

and, while such a file is in the list, **every total on the screen says
"more than"** (`Download: 2 files, more than 34.2 MB in total`), because
a confident total that leaves one file out is the same claim nobody
measured, one size up. The second line is what the Windows engine has
printed since 2026-09-20; the first is new in both. Text only; nothing
it does changed.

| | |
| --- | --- |
| `out/ti-base-macos.zip` | `d9379f42c9839e863455ac62046b985c73f3168a617c53a8c110afffa041b932`, 69,262 bytes |
| the engine inside it | `ti-engine.sh` with the baked lines filled, and **only** those four lines: checked by diffing the extracted `Contents/MacOS/install` against the committed source |
| plan signing key | `97930ea1888d1a12` (unchanged) |
| `TI_BUILD_TIME` / `TI_BUILD_EPOCH` | `2026-09-21T11:57:18Z` / `1789991838` |
| signature | ad-hoc; `codesign --verify --strict` is happy on the bundle **and** on the bundle re-extracted from the zip with `ditto` ("valid on disk", "satisfies its Designated Requirement", `Signature=adhoc`); `spctl -a` rejects it, as it must |

There is still no checkout on the Mac: `ti-engine.sh`, `make_app.sh`,
`plankey.sh`, `verify/bin/tiverify-macos-*` and the **public** plan
signing key were copied to a temporary folder, built there with
`TI_PLAN_PUBKEY_FILE` pointing at the copy, and the folder removed
afterwards.

The build before this one was **2026-09-21T11:13:48Z**, zip
`7eaabafb3c29257412e56adc53c782c249356d36e3890e9460e3ac96feecbd89`
(68,834 bytes), from `ti-engine.sh` with the mode A row on the review
screen saying what is true of the file rather than assuming it. The row
was made one line --

```
  Mode:       A (signed, and carrying no settings of its own): it installs only the app its file name names, from <backend>
```

-- and no longer claims a signer. The `Signed by:` line directly above
already names one, read from the file, so naming one here said it twice
and could disagree with it: "signed by TiddlyInstall" printed over a
`.run`, which carries no signature at all, and over anyone else's
certificate. The mode A refusal and the `install.txt` log line dropped
"Our signature" for the same reason. Text only; nothing it does changed.

The build before that was **2026-09-21T10:39:05Z**, zip
`3c552f115cf303f44c56d4a57ecd823a93263721b8c3c620459c4e83052a312b`
(68,623 bytes), engine
`2eefef9ee145449cd8cef34eae9926ce9632897c3d299001b5c2e11aa2ae4a86`, from
`ti-engine.sh` at `af77744`, which gave mode A a `Mode:` row and a second
line reading "That signature is ours; the program it installs is not."
Both were replaced above.

The one before that was **2026-09-21T06:54:39Z**, from `ti-engine.sh`
with the SHA-256 promise said once, a label on every file in the download list,
the review shown in a window on a desktop, and the
**capability statement** on the review screen (design.md 11.3 and
docs/format.md section 3, "What engines must show: what this install can
do"): WHAT THIS INSTALL CAN DO, above the warnings, saying what this
installation can do that an ordinary one cannot -- administrator rights,
a machine-wide install, a system package, an unpinned project, a command
the publisher wrote, an instruction the engine does not know, and the
dependencies an `install` line fetches -- with the "we did not write
this program" sentence written by the same code path. Administrator
rights and an unpinned source left BEFORE YOU SAY YES with it; the
SHA-256 promise, which the `Sources:` line and WHAT IT DOWNLOADS were
both making on top of the `sha256` under every file, is now made once,
in the sentence that opens that section; and every file in the download
list says what it is -- `(the runtime)`, `(part of the runtime)`,
`(a tool the install needs)`, `(the project itself)`. The
engine is one file, so that change reached macOS only when this was
rebuilt. The macOS dialog's short form carries the same two claims, in
the same order, because it is the whole of what that dialog says.

Its zip was `07b3366106a8dfa5ac2758952edfdc8dd76f9b7be28ffa43fd0f240cfcf401ec`
(68,441 bytes), its engine
`cf895577e3a68cbd2601f4c4ba65f2dec3490ae899a6b83526112802c9cb8bb9`, built
at `TI_BUILD_TIME` `2026-09-21T06:54:39Z` / `1789973679`.

**One bug that build fixed is macOS-only**, and it took running the
engine on the Mac to see: `$(case $x in y) … esac)` is closed at the
first `)` by the bash 3.2 that macOS ships as `/bin/sh`, so the review
screen printed `Plan signed: <date> printf ' (fetched now)' ;; *) …` —
shell source, at the reader, on the one screen that exists to be
trusted. Every other shell parsed it correctly, which is why it lasted.
There is one such substitution in the engine and it is now an `if`.

The one before this was `d6c3fd38dbaaba722ada38168f952d0adeb30bac4b5051b97c77d6cbd2c03ecf`
(60,778 bytes), built 2026-09-21T02:55:39Z from the engine with the
review screen trimmed, and before that
`b430ccb1fd7e85f7dc5cfbe662dfedb7a830239d19b6653e70bcf37b474df8ce`
(54,896 bytes), built 2026-09-20T11:10:56Z from the engine at `566d31c`.

`spctl -a` still rejects it, as it must: an ad-hoc signature is not a
notarization ticket (docs/macos-packaging.md section 5).

How it was built, since there is no checkout on the Mac: copy this
folder without `out/` and the plan **public** key to a fresh working
directory there, run `TI_PLAN_PUBKEY_FILE=... sh make_app.sh`, copy
`out/ti-base-macos.zip` back, and remove the working directory. Take
`tests/arch/vmlock.py` around it, as the harnesses do.

**Running it again.** If the app is already fully installed where this
installer would put it, with the same `appid` and record hash (the same
settings), the installer doesn't install again: it starts the app
through `launch.sh`, as its shortcuts do, and exits (a console app
started from a desktop gets a terminal window, as its menu entry would;
`TI_NO_TERMINAL=1` keeps it in the installer's own process). With
`--yes` it never starts the app: it says the app is installed and exits
0. "Fully installed" means `<app>/.ti-installed` (format.md section 5),
the last file a successful install writes, names this appid and record.
A different record (new settings, a new version) has another appid, so
it installs beside the old one as before. This works offline: the
appid is derived from the record hash alone (`base32(sha256(<hash>
"/app"))[:12]`), so when the record hash is known before anything is
fetched (an embedded, `--record` or `install.txt` record, whose root
and rootname say where to look; the hash in a mode A file name, looked
for in the default folders for one user and for all users) the marker
is checked first, and the app is started without any network access.
Only plans by name, whose record hash only the server knows, are checked
after the plan is fetched. `--reinstall` removes the existing install, as its
uninstaller would, and installs again.

**How it asks.** In a terminal it prints the transparency text and asks
`[y/N]`. Without a terminal on Linux it uses `zenity --text-info`, or
`kdialog`, when there is a display. On macOS (double-clicked, so no
terminal) it uses `osascript` dialogs: a short summary with **Details...**
(opens the full text in TextEdit) and **Continue**, then a final "done"
or "failed" dialog with the log path. Plan text is passed to
`osascript` as arguments, never pasted into the AppleScript. If there is
no way to ask and no `--yes`, it stops.

## The review screen (2026-09-20)

Everything the installer will do, before it does any of it (design.md
section 3). One plain-text file, `$TI_WORK/summary.txt`, which is also
what is appended to the log and what zenity, kdialog and the macOS
dialog are given, so there is one text to get right and no way for the
screen and the log to disagree. Its shape is set out in `ti-engine.sh`
at "the review screen's shape"; in short:

- a heading, then **BEFORE YOU SAY YES** (only when there is something:
  an unsigned or stale plan, root, a prerequisite that cannot be
  installed here, a runtime built for another architecture, a project
  with no stored hash), then **IN SHORT** -- installs, from, runtime,
  download size, *who the files come from*, where they go, how many
  commands it runs, admin rights, who signed it, the record -- and the
  evidence under that.
- nothing wraps past 78 columns except a URL, which is never broken.
- nothing is said twice (design.md section 3, "Nothing is said twice").
  What the screen leaves out, the log carries in full: every URL in the
  order they are tried, every command, and this machine.
- whose commands they are is said once: every `step` in a plan is the
  catalogue's recipe for the runtime, `install` and `launch` are about
  the project, and WHAT IT RUNS ON THIS MACHINE is headed accordingly.
- WHERE FILES GO shows the root once and the leaf folders under it,
  with a line on why the runtime sits beside the app and not inside it
  (design.md 1.1: short paths).
- `ti_hsize` turns bytes into "34.2 MB", `ti_hosts` turns a list of
  URLs into the hosts behind them, `ti_origin_url` picks out the one a
  file comes from, `ti_wrap` wraps a `key: value` line so the value
  keeps its column, and `ti_cmd_wrap` wraps a command.

**Colour** is added by `ti_paint`, and only ever on the way to a
terminal: the file stays plain, so nothing escapes into a log, a pipe or
`--yes` output. `ti_want_colour` says no unless stderr is a terminal,
`TERM` is something that has colour, `NO_COLOR` is unset and this is not
an unattended run; `TI_COLOR=0` or `1` overrides it either way. `tput` is
used when it is there and a `TERM` list when it is not, because plenty
of minimal systems have no terminfo at all.

**In a terminal the text is longer than the screen** -- around sixty
lines against twenty-four -- so by the time the question appears the top
of it has scrolled away. One line stands above the prompt
(`$TI_WORK/decide.txt`): the app, that nobody signed it, where it is
going, and that nothing has been changed yet, with any `!!` warning
above it. Up to 2026-09-21 the whole short form was reprinted there, and
the operator's verdict was that it forced people to read the same thing
twice; in a dialog, where the whole text is visible at once, nothing is
reprinted and nothing ever was.

**The short form** (`$TI_WORK/short.txt`) is now the macOS dialog alone:
there it is the whole of what the dialog says, with the full text behind
"Details...", so it is not a repeat of anything.

**A command is wrapped, not cut,** while it fits in four lines
(`ti_cmd_line`, `TI_CMD_LINES`), with the continuation indented to
column 9 so it reads as one command. Past that it is shortened, with its
length and a pointer to the log. The wrapping is `ti_cmd_wrap`, not
`ti_wrap`: it breaks only at a space **outside double quotes**, because
a break inside `"C:\Users\John Smith\…"` reads as two arguments when it
is one path. `ti_cmd_line` renders a command and decides nothing about
whether it is worth showing -- that is the caller's.

**zenity** gets `--font="Monospace 10"` (columns and hashes do not line
up in a proportional font), a bigger window and `--ok-label=Install`. A
zenity too old for those options exits 255, which a cancel never is, and
the call is retried without them.

## Where the metadata comes from

In order (plan.md 1.1):

1. `--record` / `--plan`.
2. **The embedded metadata.** Linux: the block at the end of the `.run`
   (format.md section 4). The engine reads the 64-byte footer with
   `tail -c 64` and cuts out the parts with `tail -c +N | head -c LEN`.
   macOS: `Contents/Resources/ti/record.txt`, `plan.txt`, and packed files
   in `pack/<sha256>` (a `pack.tar` there works too).
3. `install.txt` next to the installer (next to the `.app` on macOS),
   either an `ti-record` or an `ti-plan`.
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
fill the engine's `TI_PLAN_PUBKEY=` and `TI_PLAN_KEYID=` lines
(`plankey.sh`) from `TI_PLAN_PUBKEY_FILE`, by default
`../../build_server/data/plan-signing-key.pub`, which the server writes on its
first start. They refuse to build without it.

The engine checks the signature with its own verifier, `tiverify`
([verify/](verify/README.md)): a static binary per CPU, TweetNaCl like the
Windows `tisig` plugin. The `.run` carries the Linux ones after the
script's final `exit $?` line (before any metadata block), and the
script's `TI_VERIFY_BLOBS` line, filled in by `make_run.sh`, gives each
one's arch, byte offset and length in fixed-width numbers; the engine cuts
out the one for `uname -m` with `tail -c +N | head -c LEN` into its temp
folder. The `.app` has `Contents/Resources/tiverify-x86_64` and
`-arm64`. If that doesn't run here, it uses `openssl pkeyutl -verify
-pubin -rawin`. Either is used only after it accepts RFC 8032 test vector
2 and rejects it with a changed message; the log says which checked the
plan (`Plan signature: ok:tiverify`). Then:

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

**When nothing can check Ed25519.** Only when the built-in verifier
can't run (a CPU it isn't built for, a `noexec` temp folder) and openssl
can't either (it needs OpenSSL 1.1.1 or later; RHEL/CentOS 7 has 1.0.2,
macOS LibreSSL, some 1.1.1 builds fail the test, Alpine has none). The
engine then fails closed on plain HTTP and accepts a plan only when it came over
HTTPS (curl and wget check the certificate, so it came from the
backend), and says so on the transparency screen. A warning instead of
refusing would have made the signature optional for exactly the old
machines on plain HTTP it exists for. On such machines, install OpenSSL
1.1.1+ (it only needs to be on `PATH`) or use an HTTPS backend.

**Mode A on macOS.** An `.app` signed with an identity (not ad hoc) whose
signature verifies and which has no files in `Contents/Resources/ti` is a
mode A base: it refuses `--record`, `--plan`, `--unsigned-plan` and
`--backend`, ignores `install.txt` and the record's `backend` line, and
only installs the record named in its bundle name from the built-in
backend (design.md section 3). Linux `.run` files carry no signature, so
nothing is locked there. `TI_TEST_MODE_A=1` turns the restriction on
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
   `XDG_DATA_HOME`) or `~/Library/<rootname>`; system-wide
   `/opt/<rootname>` or `/Library/<rootname>`. Before 2026-09-20 the
   macOS roots were `~/Library/Application Support/<rootname>` and
   `/Library/Application Support/<rootname>` (design.md 11, item 16);
   an app already installed in one of those keeps that folder when it
   is installed again, and the engine looks there too when deciding
   whether an app is already installed. An app folder that already exists and whose
   `.ti-owner` names this app (`--reinstall`, an interrupted install, or
   an install by an engine older than `.ti-installed`) is removed first,
   as its uninstaller would remove it; one that belongs to another app, or
   to nobody, stops the install, as does a file folder whose `.ti-owner`
   names another app.
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
   menu entries, `manifest.txt`, and last `.ti-installed` (written to a
   temporary name and renamed, so it is never half written). If the record has an `icon`
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
| `run` | `sh -c` in `{dir}`, stdin from `/dev/null`, output to the log. Non-zero fails. `TI_APP_DIR`, `TI_RUNTIME_DIR`, `TI_APP_NAME` are exported (design 1.5) |
| `mkdir`, `write`, `delete` | Only inside the app's folders or `{tmp}` (no `..`); anything else fails the install. `write` appends a line ending in `\n` |
| anything else | Fails the install (format.md: an unknown step is never skipped) |

Everything shown on screen (the transparency text, dialogs, the log tail
on failure) passes through `ti_clean`: control characters (C0 but tab
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

- **Linux:** `~/.local/share/applications/ti-<appid>.desktop` runs
  `launch.sh` (`Terminal=true` when `console 1`).
- **macOS:** `~/Applications/<App>/<App>.app` is a minimal bundle
  (Info.plist, `Contents/MacOS/run`, a shell script that runs
  `launch.sh`, and `Contents/Resources/ti-appid`). With `console 1` it
  runs `open -a Terminal launch.sh`, unless it already has a terminal
  or `TI_NO_TERMINAL` is set.

## Menus and uninstalling (plan.md 1.7)

| | Linux | macOS |
| --- | --- | --- |
| App | `~/.local/share/applications/ti-<appid>.desktop` | `~/Applications/<App>/<App>.app` |
| Uninstaller | `ti-<appid>-uninstall.desktop` → `sh <app>/uninstall.sh --uninstall` (in a terminal) | `~/Applications/<App>/Uninstall <App>.app` |
| Menu folder | `~/.local/share/desktop-directories/ti-<appid>.directory` + `~/.config/menus/applications-merged/ti-<appid>.menu` | the `~/Applications/<App>/` folder |
| Desktop (`desktop 1`) | `ti-<appid>.desktop` in the XDG desktop folder, if it exists | a symlink on `~/Desktop` |

**`menu 0`** writes nothing to the app menu: no `.desktop` in
`applications`, no uninstaller entry, no `.directory` or `.menu`, and on
macOS nothing in `~/Applications`, except, when a desktop shortcut is
asked for, a single `~/Applications/<App>.app` (no folder, no
uninstaller app) for the desktop symlink to open. Desktop shortcuts are
made for one-user installs only. The app is started with
`<app>/launch.sh`, the desktop shortcut, or by running the installer
again, and removed with `sh <app>/uninstall.sh`; the transparency
screen and the final message say so.

System installs use `/usr/local/share/applications`,
`/usr/local/share/desktop-directories`, `/etc/xdg/menus/applications-merged`
and `/Applications/<App>/`. GNOME Shell ignores `applications-merged`
menus, so there the two entries appear in the app grid without a folder.

`uninstall.sh` is a copy of the engine (the `.run` minus its block). It
reads `manifest.txt` next to it and removes exactly what it lists:

- `shortcut` files only if named `ti-<appid>*`; symlinks; `.app` bundles
  only if their `Contents/Resources/ti-appid` names this app;
- `dir` entries only if they are directly in the install root, 12
  base32 characters, not the app folder, and their `.ti-owner` names this
  app (a missing `.ti-owner` counts as someone else's);
- `.ti-installed` first, so an uninstall that stops half way is never
  taken for a finished install;
- then the app folder, if its own `.ti-owner` names the app, then the
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
- **Mode B:** the publisher adds the files to `Contents/Resources/ti/`
  and re-signs (`codesign -s <identity> -f TiddlyInstall.app`); `codesign
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
