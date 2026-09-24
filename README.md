# TiddlyInstall

**Make an installer for a program, for Windows, Linux and macOS, from a
web page that needs no server.**

You point it at a program -- a GitHub repository, or a URL -- and say what
it needs to run: Python, Node.js, Ruby, PHP, Java, .NET, R, Go, Rust,
Zig, Nim, a C compiler. It builds an installer for each platform that
brings that runtime with it, so the person installing does not have to
have anything already.

The page is one HTML file. Save it and it keeps working: no server, no
network, no account. It targets machines as old as Windows XP, Linux with
glibc 2.17, and macOS 10.9, and it can install any of 30,828 runtime
releases from a catalogue built into the file.

**[Open `tiddlyinstall.html`](tiddlyinstall.html)** -- download it and
open it in a browser. That file is the whole product.

## What it will and will not tell you

An installer built here says, before it changes anything, exactly what it
is about to do: what it downloads, the SHA-256 of each file, where things
go, and what runs. Then it asks.

Two of those claims are checkable and one is not, and the difference is
the point:

- **The runtime setup is ours, provably.** Every runtime install we
  publish is signed in advance, and an installer that uses one unchanged
  carries a proof that the steps inside it are the ones we published.
  Your machine checks that proof against a key built into the installer,
  offline, with no network. Change one byte of a download's hash and the
  proof stops matching. Two things we cannot sign in advance, because
  they are not written until you ask: an install command a publisher
  wrote themselves, and a package build, whose command carries the
  package name. Those carry no proof, and the installer says so rather
  than implying one.
- **What we sign is our installer program, never the software someone
  installs with it.** A code signature says the program is ours and
  unmodified -- like the signature on a web browser, which says nothing
  about the sites you visit.
- **We cannot tell you the program is safe.** We did not write it and
  have not read it. Install it because you trust whoever published it.

The page has a **Trust** page that says all of this against the file you
are actually holding -- checking the documents inside it as it loads,
and saying so when one does not check out -- and a **Verify** page that
reads an installer back and tells you what it can and cannot prove about
it. Neither asks you to take its word for anything.

## The signing key

Everything we sign uses one Ed25519 key, id `97930ea1888d1a12`. It is
named in [`plan-key.id`](plan-key.id), and every build from this
repository refuses to proceed with a different one. Comparing a page's
fingerprint with that file is a check made somewhere we do not control
your copy of the page -- which is the only kind worth making.

## Licence

MIT, `LICENSE` at the root. Third-party code keeps its own notices and
they travel with any copy of the one-file page; the list is under
[Third-party code](#third-party-code).

---

# Working on the code

Everything below is for people changing TiddlyInstall rather than using
it.

## Where things are

```
src/web_client/      the pages and their JavaScript (was web/)
src/build_server/    the Node build server (was server/)
src/installers/      the Windows, Linux and macOS base installers (was installer/)
src/shared/          the code the page and the server both run (was shared/)
src/vendor/          third-party bundles (was vendor/)
out/                 the built one-file site, gitignored (was dist/)
registry/            the runtime registry (was runtime-metadata/)
docs/ tests/ tools/                       unchanged
```

Renamed on 2026-09-22. Three things follow from it and are easy to get
wrong: the page's relative imports (`../shared/x.js`, `../vendor/x.js`)
still resolve because all three moved into `src/` together; the build
server computes the repository root two levels up now, not one; and the
`ti-server`, `ti-server-mac` and `ti-redis` systemd user units name the
new paths -- a unit left pointing at the old one serves a stale page
without saying so.

**`registry/` is the runtime registry**: where to get each language's
runtime, per OS, architecture and version. It is **not** a package
registry. "Registry" on its own -- in this repository's code, on the
review screen, on the installer form, in docs/launch-shapes.md's
derivation ladder, and in the offline page's promise that nothing but
registry lookups leaves the page -- still means npm, PyPI, RubyGems or
crates.io, and none of that wording changed with the folder. So the
folder is always written with its slash, and where a slash will not
fit, write "the runtime registry".

## Front end

Plain HTML, CSS and ES modules (ES2017, so the one-file site runs in Firefox
52 ESR, Chrome 58+, Safari 12; docs/plan.md section 1.11). No framework. The pages talk
to the build server ([docs/api.md](docs/api.md)); serve them over http
(`python3 -m http.server` at the repository root, then open
`/src/web_client/index.html`), since browsers don't load ES modules from `file://`. Without JavaScript the pages still show the form and its
CSS-only behaviours.

| Page | What it is |
| --- | --- |
| `src/web_client/index.html` | What the service does |
| `src/web_client/new.html` | The installer form. Submitting sends `POST /api/jobs` and opens the build's page. The "Newest that runs on the user's system" table comes from `GET /api/catalog/runtimes` when the server is reachable. Above each "Build installers" button it says where the build will happen: in this page, or on the build server (docs/plan.md section 1.11). "Signed by TiddlyInstall" is shown but off in this prototype (no code-signing certificate yet); Unsigned is the default |
| `src/web_client/build.html#job=<id>` | One build, live: ticket number, place in the queue, estimated wait, progress, then downloads with sizes, SHA-256 and who signed each installer file, and where the job was built. Survives reloads |
| `src/web_client/edit.html` | Editor for installer files that carry no signature (mode C; a signature covers every byte, so editing would break it): open a `.exe`, `.run` or macOS `.zip`, edit its settings record, plan, packed files and **icon**, download it. Or start from a base installer. Nothing is uploaded |
| `src/web_client/runtimes.html` | **Registry**, the runtime catalogue editor (the file name and the `#runtimes` section id keep the old spelling; only the label changed): browse and change releases, recipes, support rules and policy, with a live plan preview. Changes are kept in this browser as an overlay and used when the page builds installers itself (docs/plan.md section 1.11) |
| `src/web_client/create.html` | Redirects to `new.html#write` |

## Third-party code

MIT, `LICENSE` at the root.

The one-file page carries the notices for the code that is *in the page*
-- they are in its `ti-licences` block, so they travel with any copy of
it. The Windows base additionally ships `7za.exe` (7-Zip 9.20, LGPL 2.1)
and three NSIS plugin DLLs, and their notices are **not** in that block
yet: the sentence that used to be here said every notice travelled with
every copy, and for those it was not true. Until they are added, the
table below is where they are recorded, and the LGPL's written offer for
7-Zip's source is at <https://www.7-zip.org/>.

| What | Licence | Where |
| --- | --- | --- |
| resedit-js 2.0.3, pe-library 1.0.1 | MIT, (c) 2018 jet | `src/vendor/LICENSE.resedit`, `src/vendor/LICENSE.pe-library` |
| Ed25519, ported from TweetNaCl-js | public domain | `src/web_client/lib/ed25519.js` |
| core-js (the ES5 build only) | MIT | `tests/../out/index.html` ES5 copy; upstream notice retained |
| NSIS (the Windows base is built with it) | zlib/libpng, with an exception | nsis.sourceforge.io |
| 7-Zip 9.20 (`7za.exe`, shipped inside the Windows base) | LGPL 2.1 | <https://www.7-zip.org/>, `src/installers/windows/README.md` |
| NSIS plugins (`tisig.dll` is ours; the others ship with NSIS) | zlib/libpng, with an exception | nsis.sourceforge.io |

**Which build server:** `?api=` on the page URL, else the one saved in this
browser, else whichever server is serving the page: its own origin when a
build server answers there, or `https://tiddlyinstall.warpgate.io` when the page came
from there. A copy hosted anywhere else builds in the page and
contacts nobody until **Default** is pressed, which offers the server the
page was built with. Each page's footer shows which it is and has a
**change** button. If the server can't be reached, a banner says so and the page retries
with backoff (1 s up to 60 s) and carries on once it's back. Nothing on the
page is lost.

| Script | What it is |
| --- | --- |
| `src/web_client/api.js` | The one client for the server: backend choice, the outage banner and retries, errors |
| `src/shared/tifile.js` | Installer metadata (docs/format.md section 4): the appended block for `.exe` (it stops before a certificate table) and `.run`, the files in the `.app` of a macOS `.zip`, tar packs, record hashes, and a small zip reader and writer that keeps permissions and symlinks |
| `src/web_client/new.js`, `src/web_client/build.js`, `src/web_client/edit.js` | The three live pages |
| `src/shared/icon.js` | Icons in the browser: a `.ico` (BMP for XP + PNG) written into a `.exe` with resedit-js, an `.icns` for the `.app`, and the Linux launcher PNG packed with an `icon` record key. PNG is encoded in JS so it is deterministic |
| `src/vendor/resedit-bundle.js` | resedit-js 2.0.3 + pe-library 1.0.1 (MIT, (c) 2018 jet; see `src/vendor/LICENSE.*`), bundled by `tools/build_resedit_bundle.py`. `src/web_client/edit.html` loads it; the one-file site inlines it |
| `tools/build_site.py` | Builds the site: one HTML file, `out/index.html` (gitignored), with every page, the CSS, the JS, the resedit bundle, the three unsigned bases and the catalogue inside, split by catalogue folder so the page unpacks only the runtimes it uses (docs/format.md section 6). The build server serves it; saved and opened from disk it builds installers with no server (docs/plan.md section 1.11). `--multi` also writes separate pages |
| `src/shared/resolve.js`, `src/shared/builder.js`, `src/web_client/local-api.js`, `src/web_client/router.js` | The plan resolver and the job builder (both shared with the build server in `src/build_server/`), the in-page API used when there is no build server, and the one-file site's page switching |
| `src/web_client/overlay.js`, `src/web_client/catalog-editor.js` | The catalogue overlay (format, checks, applying it, storage, "Save this page" with it) and the Registry page |
| `src/web_client/change-list.js`, `src/web_client/overlay-consent.js` | One rendering of a list of catalogue changes (what each one does, field by field), and the panel that asks once a session before changes **found** in this browser's storage are used: until answered nothing builds with them (docs/plan.md section 1.11) |
| `src/web_client/lib/zlib.js`, `src/web_client/lib/inflate.js`, `src/web_client/lib/deflate.js` | Compression for the whole page: the browser's CompressionStream/DecompressionStream where it has them, else our own inflate and deflate (gzip, zlib, raw) |
| `src/web_client/lib/cryptox.js` | Cryptography for the whole page: WebCrypto per operation where it works, else our own code below. `USE_NATIVE` in it switches to our code everywhere |
| `src/web_client/lib/sha.js`, `src/web_client/lib/hmac-pbkdf2.js`, `src/web_client/lib/aes.js` | SHA-1/256/384/512, HMAC, PBKDF2, AES-CBC and CFB, from FIPS 180-4, RFC 2104, RFC 8018 and FIPS 197 (ours) |
| `src/web_client/lib/bignum.js`, `src/web_client/lib/rsa.js`, `src/web_client/lib/ec.js` | Big integers without BigInt (Montgomery multiplication), RSA PKCS#1 v1.5 (sign, verify, key generation), ECDSA P-256/384/521 with RFC 6979 nonces (ours) |
| `src/web_client/lib/ed25519.js` | Ed25519, ported from [TweetNaCl-js](https://github.com/dchest/tweetnacl-js) (public domain) |
| `src/web_client/has-shim.js`, `src/web_client/polyfills.js` | CSS `:has()` for browsers without it (classes kept on ancestors, the stylesheet rewritten in place), and the few newer built-ins the page uses. Both do nothing in current browsers |
| `tests/fallback-test.mjs` | The plain-JavaScript compression and crypto against Node's zlib and WebCrypto, openssl, and the FIPS/RFC test vectors; the `:has()` rewrite (`TI_CATALOG_DIR=<folder with catalog.gz> node tests/fallback-test.mjs [--quick]`) |
| `src/installers/screen-checks.sh` | What the review screen must say, asserted once and run over both engines' output from one fixture (`src/installers/test-proved.plan`, which carries a windows and a linux target). The screen is written twice and every fault found in it since 2026-09-21 was in what it *says*, which no suite that checks what the engine *does* can see |
| `src/installers/unix/test_screen_cases.sh` | Renders the screen with this engine in the three states that decide what it may claim -- the plan signed and the setup proved, the signature gone, neither -- and reads it back through `screen-checks.sh` |
| `src/installers/windows/test_screen_windows.sh` | The same three, on Windows: `TI_WIN=user@host src/installers/windows/test_screen_windows.sh`. The installer is run with `/ti-review=<file>`, which writes the review text and installs nothing; it is the same file the review page shows and the log keeps. Skipped with no `TI_WIN` |
| `tests/proof-test.mjs` | The primitives the whole claim rests on, written as refusals: the Merkle tree an installer proves its runtime setup against (including CVE-2012-2459 -- `[a,b,c]` and `[a,b,c,c]` must not share a root), the hash chain that makes a rewritten release ledger visible, and the signature check the Verify page and the page's own builder share. Every one was watched failing against a deliberately broken copy of the module before being kept |
| `tests/verify-test.mjs` | The Verify page and the Trust page in a browser: a signed and proved installer, the same one with its signature stripped (what a page with no server builds), and one with a download's hash edited. Also that the page never calls the half we sign and the wrapper we do not by one name, which is the fault of 2026-09-23 |
| `tests/autoconnect-test.mjs` | Which server a page connects to on its own, and which it does not: a copy hosted anywhere else must build in the page and ask the built-in default *nothing* (every request the page makes is checked, not just what it says), while a page its own server handed over still connects. `node --experimental-websocket tests/autoconnect-test.mjs [--site URL]` |
| `tests/es2017-test.mjs` | Parses the built `out/index.html` as ES2017 (acorn, `cd tests && npm install` once) and fails on newer syntax or built-ins |
| `tests/no-native.mjs`, `tests/no-native-browser.mjs` | Run a test as an old browser: `node --import ./tests/no-native.mjs tests/sign-test.mjs` (no streams, `crypto.subtle` or BigInt in Node), and `--no-native` on `offline-test.mjs`, `upload-test.mjs`, `catalog-editor-test.mjs` and `sign-ui-test.mjs` (the same in Chrome, and no `:has()`) |
| `tests/catalog-editor-test.mjs` | The Registry page in headless Chrome: edits, reload, preview, a built installer's plan, revert, export, import (a hostile file too), reset, the once-a-session question about changes found in storage, blocked storage (`node --experimental-websocket tests/catalog-editor-test.mjs [--site URL]`) |
| `tests/tifile.html`, `tests/icon.html` | Unit tests for `src/shared/tifile.js` and `src/shared/icon.js` in the browser. Print PASS/FAIL. Fixtures come from `tests/make_fixtures.py` (Python's tarfile and zipfile, plus a synthetic PE with an icon resource) |
| `tests/uninstaller-icon-test.mjs` | The NSIS uninstaller survives a custom icon: re-icons the real `src/installers/windows/out/base.exe`, checks the bytes NSIS's patch table names are untouched and that no live resource sits on them, then performs the patch itself and checks the manifest, dialogs and icons survive (`node tests/uninstaller-icon-test.mjs`). The VM half is `behaviour.py --variants icon` |
| `tests/mock_server.py` | A stand-in build server for trying the pages (`python3 tests/mock_server.py 8094`, then open `src/web_client/new.html?api=http://127.0.0.1:8094`) |

Headless test run:

```
python3 -m http.server 8093 &
google-chrome --headless=new --virtual-time-budget=20000 --dump-dom http://127.0.0.1:8093/tests/tifile.html | grep -o 'PASS all [0-9]*\|FAIL [^<]*'
```

## Build server

`src/build_server/` is the build server: plain ES modules on Node.js 20 or later
(`node:http`, no web framework), with BullMQ and ioredis for the job queue
on Redis. It runs the same JavaScript as the page: `src/shared/resolve.js` (plans),
`src/shared/builder.js` (jobs), `src/shared/tifile.js` (installer files) and `src/shared/icon.js`
(icons). It serves the API ([docs/api.md](docs/api.md)), the one-file site
from `out/` (`python3 tools/build_site.py` writes it), our copies of the
runtime files at `/mirror/`, and the built installers. (It replaced a Go
server on 2026-09-19; docs/plan.md section 1.8.)

```
cd src/build_server && npm ci                      # BullMQ and ioredis
node src/build_server/server.js -addr :8080 -redis 127.0.0.1:6390 -public https://tiddlyinstall.warpgate.io
```

`node src/build_server/server.js -h` lists the flags: `-addr`, `-redis`,
`-redis-db`, `-data` (records, sources, icons, built files, the signing
keys and the plan signing key; default `src/build_server/data`, gitignored),
`-catalog` and `-local` (the runtime catalogue and our copies of its files,
default under `~/projects/installer-builder-runtimes`), `-policy` (default
`src/build_server/policy.json`), `-site`, `-bases`, `-public` (this server's URL,
written into records), `-workers`, `-mirror` and `-mirror-last` (where
plans point for our mirror, and whether it comes last). A second instance
needs its own `-redis-db` and `-data` (the Mac test server's is
`src/build_server/data-mac`). On this machine they run as the systemd user units
`ti-server` (:8080) and `ti-server-mac` (127.0.0.1:8081), on Redis from
`ti-redis` (its files in `src/build_server/data/redis`).

Tests:

```
cd src/build_server && npm test                    # node --test: unit tests and the server end to end
node tests/resolve-test.mjs              # the resolver against 3,095 saved plans and answers, also lazily loaded
node tests/linux-x86-test.mjs            # what 32-bit x86 Linux is offered, per runtime (design.md 1.11)
node tests/refusal-test.mjs              # combinations refused up front, and the many that must not be
node tests/builder-golden.mjs            # src/shared/builder.js: records and plans for every runtime, also lazily loaded
node tests/github-test.mjs               # GitHub sources: the page and the server write the same record (--live also
                                         # checks the API's file list against the real tarball; it costs rate limit)
node tests/backend-golden.mjs            # a running server (default :8080, --data src/build_server/data)
sh src/installers/unix/test_freshness.sh          # the Linux engine on stale plans: nonce, revocation list, expiry
                                         # against saved answers: errors, jobs, plans, takedown
```

The server test needs Redis and uses database 5 (`TI_TEST_REDIS`,
`TI_TEST_REDIS_DB`). The three golden tests compare with answers saved in
`tests/golden/` from the Go server while it was the reference the JS was
checked against byte for byte; each test's header says what is kept and
how to record the goldens again after an intended change.

Tools: `tools/snapshot.mjs` writes the catalogue snapshot and runtimes
summary the one-file site carries (and with `-split DIR`, the snapshot split
by folder as the page carries it; `-from catalog.gz -split DIR` splits one
already written); `tools/resolve.mjs` prints a plan, or
the files with no copy on our mirror; `tools/plansig.mjs` signs and checks
plans with a plan signing key; `tools/mirror_fetch.py` fills the mirror
host from the vendors and `tools/mirror_check.py` says whether the
manifest, the local runtime store and the mirror host agree;
`tools/mirror_scope.mjs` says what mirroring **every version we offer**
would cost (files and bytes, per runtime) and, with `-out DIR`, writes
both halves of the fetch — a `download_plan_all.json` per folder for
`registry/tools/download.py --plan` (the local store) and a
`mirror-manifest-all.json` for `mirror_fetch.py` (the mirror host) —
from one enumeration, so the two cannot disagree about what is in scope.
Files we have no permission to mirror are listed in
`registry/store/mirror-excluded.json` and left out of both.

**Topping up the mirror is two halves: the mirror host *and* the local
runtime store, or the pull achieves nothing.** A mirror URL only reaches
a plan through `LocalIndex` (`src/build_server/lib/catalog.js`), which walks this
machine's copies under `~/projects/installer-builder-runtimes`; a file
that is on the mirror host but that this machine has never seen has no
`local` path, so its plans still name the vendor alone.
`tools/mirror_check.py` exits non-zero on exactly that state, for the
manifest and every mirror host in
`registry/store/mirror-hosts.json`.

Two manifests, deliberately separate:
`registry/store/mirror-manifest.json` is what installers
download, and `registry/store/toolchain-manifest.json` is what we
build them with (NSIS, osslsigncode, llvm-mingw, Redis) — no plan ever
names those, and keeping them out is what lets the runtime check stay a
clean pass or fail. Check the second with
`tools/mirror_check.py registry/store/toolchain-manifest.json`.

## Design notes

- [Design](docs/design.md): the whole design, decisions and open questions
- [Packed files](docs/packed-files.md): files carried inside an installer (your own files, extra installers to run, offline copies of downloads), and how the installer stays signed
- [macOS packaging](docs/macos-packaging.md): a self-contained `.app` in a `.dmg`, with measured sizes, and what Gatekeeper does to an app that isn't notarized
- [Tested Python on old Windows](docs/windows-python-compat.md): known-good builds with working asyncio, per Windows version
- [Test machines](docs/local/test-vms.md): VMs for testing installers
- [Runtime catalog](registry/README.md): where to download 13 languages' runtimes per OS, architecture and major version, mirrors, checksums, and per-version limitations (metadata backup; binaries live outside git)
