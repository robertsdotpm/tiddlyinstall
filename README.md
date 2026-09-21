# TiddlyInstall (installer-builder)
Build installers and executables for Windows, Linux, and macOS

**What we sign is our installer program, never the software someone
installs with it.** One reusable program (the *base installer*: the same
bytes for everyone, which reads settings and installs what they name),
plus settings chosen afterwards. A code signature on it says the program
is ours and unmodified -- like the signature on a web browser, which
says nothing about the sites you visit. The vocabulary every page and
engine uses for this is [docs/design.md](docs/design.md) section 6,
"What we sign, and the words for it"; wording that blurs it is a bug.

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
| `src/web_client/runtimes.html` | The runtime catalogue editor: browse and change releases, recipes, support rules and policy, with a live plan preview. Changes are kept in this browser as an overlay and used when the page builds installers itself (docs/plan.md section 1.11) |
| `src/web_client/create.html` | Redirects to `new.html#write` |
| `src/web_client/builds.html` | Sample data still |

**Which build server:** `?api=` on the page URL, else the one saved in this
browser, else the page's own origin if the build server serves it, else
`http://10.0.1.76:8080`. Each page's footer shows it and has a **change**
button. If the server can't be reached, a banner says so and the page retries
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
| `src/web_client/overlay.js`, `src/web_client/catalog-editor.js` | The catalogue overlay (format, checks, applying it, storage, "Save this page" with it) and the Runtimes page |
| `src/web_client/change-list.js`, `src/web_client/overlay-consent.js` | One rendering of a list of catalogue changes (what each one does, field by field), and the panel that asks once a session before changes **found** in this browser's storage are used: until answered nothing builds with them (docs/plan.md section 1.11) |
| `src/web_client/lib/zlib.js`, `src/web_client/lib/inflate.js`, `src/web_client/lib/deflate.js` | Compression for the whole page: the browser's CompressionStream/DecompressionStream where it has them, else our own inflate and deflate (gzip, zlib, raw) |
| `src/web_client/lib/cryptox.js` | Cryptography for the whole page: WebCrypto per operation where it works, else our own code below. `USE_NATIVE` in it switches to our code everywhere |
| `src/web_client/lib/sha.js`, `src/web_client/lib/hmac-pbkdf2.js`, `src/web_client/lib/aes.js` | SHA-1/256/384/512, HMAC, PBKDF2, AES-CBC and CFB, from FIPS 180-4, RFC 2104, RFC 8018 and FIPS 197 (ours) |
| `src/web_client/lib/bignum.js`, `src/web_client/lib/rsa.js`, `src/web_client/lib/ec.js` | Big integers without BigInt (Montgomery multiplication), RSA PKCS#1 v1.5 (sign, verify, key generation), ECDSA P-256/384/521 with RFC 6979 nonces (ours) |
| `src/web_client/lib/ed25519.js` | Ed25519, ported from [TweetNaCl-js](https://github.com/dchest/tweetnacl-js) (public domain) |
| `src/web_client/has-shim.js`, `src/web_client/polyfills.js` | CSS `:has()` for browsers without it (classes kept on ancestors, the stylesheet rewritten in place), and the few newer built-ins the page uses. Both do nothing in current browsers |
| `tests/fallback-test.mjs` | The plain-JavaScript compression and crypto against Node's zlib and WebCrypto, openssl, and the FIPS/RFC test vectors; the `:has()` rewrite (`TI_CATALOG_DIR=<folder with catalog.gz> node tests/fallback-test.mjs [--quick]`) |
| `tests/es2017-test.mjs` | Parses the built `out/index.html` as ES2017 (acorn, `cd tests && npm install` once) and fails on newer syntax or built-ins |
| `tests/no-native.mjs`, `tests/no-native-browser.mjs` | Run a test as an old browser: `node --import ./tests/no-native.mjs tests/sign-test.mjs` (no streams, `crypto.subtle` or BigInt in Node), and `--no-native` on `offline-test.mjs`, `upload-test.mjs`, `catalog-editor-test.mjs` and `sign-ui-test.mjs` (the same in Chrome, and no `:has()`) |
| `tests/catalog-editor-test.mjs` | The Runtimes page in headless Chrome: edits, reload, preview, a built installer's plan, revert, export, import (a hostile file too), reset, the once-a-session question about changes found in storage, blocked storage (`node --experimental-websocket tests/catalog-editor-test.mjs [--site URL]`) |
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
node src/build_server/server.js -addr :8080 -redis 127.0.0.1:6390 -public http://10.0.1.76:8080
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
- [Test machines](docs/test-vms.md): VMs for testing installers
- [Runtime catalog](registry/README.md): where to download 13 languages' runtimes per OS, architecture and major version, mirrors, checksums, and per-version limitations (metadata backup; binaries live outside git)
