# TiddlyInstall (installer-builder)
Build installers and executables for Windows, Linux, and macOS

## Front end

Plain HTML, CSS and ES modules. No build step, no framework. The pages talk
to the build server ([docs/api.md](docs/api.md)); serve them over http
(`python3 -m http.server`), since browsers don't load ES modules from
`file://`. Without JavaScript the pages still show the form and its
CSS-only behaviours.

| Page | What it is |
| --- | --- |
| `index.html` | What the service does |
| `new.html` | The installer form. Submitting sends `POST /api/jobs` and opens the build's page. The "Newest that runs on the user's system" table comes from `GET /api/catalog/runtimes` when the server is reachable |
| `build.html#job=<id>` | One build, live: ticket number, place in the queue, estimated wait, progress, then downloads with sizes, SHA-256 and who signed them. Survives reloads |
| `edit.html` | Editor for unsigned (mode C) installers: open a `.exe`, `.run` or macOS `.zip`, edit its settings record, plan, packed files and **icon**, download it. Or start from a base installer. Nothing is uploaded |
| `create.html` | Redirects to `new.html#write` |
| `bases.html`, `builds.html` | Sample data still |

**Which build server:** `?api=` on the page URL, else the one saved in this
browser, else the page's own origin if the build server serves it, else
`http://10.0.1.76:8080`. Each page's footer shows it and has a **change**
button. If the server can't be reached, a banner says so and the page retries
with backoff (1 s up to 60 s) and carries on once it's back. Nothing on the
page is lost.

| Script | What it is |
| --- | --- |
| `js/api.js` | The one client for the server: backend choice, the outage banner and retries, errors |
| `js/ibfile.js` | Installer metadata (docs/format.md section 4): the appended block for `.exe` (it stops before a certificate table) and `.run`, the files in the `.app` of a macOS `.zip`, tar packs, record hashes, and a small zip reader and writer that keeps permissions and symlinks |
| `js/new.js`, `js/build.js`, `js/edit.js` | The three live pages |
| `js/icon.js` | Icons in the browser: a `.ico` (BMP for XP + PNG) written into a `.exe` with resedit-js, an `.icns` for the `.app`, and the Linux launcher PNG packed with an `icon` record key. PNG is encoded in JS so it is deterministic |
| `vendor/resedit-bundle.js` | resedit-js 2.0.3 + pe-library 1.0.1 (MIT, (c) 2018 jet; see `vendor/LICENSE.*`), bundled by `tools/build_resedit_bundle.py`. `edit.html` loads it; the one-file site inlines it |
| `tools/build_site.py` | Builds the site: one HTML file, `dist/index.html` (gitignored), with every page, the CSS, the JS, the resedit bundle, the three unsigned bases and the catalogue snapshot inside. The build server serves it; saved and opened from disk it builds installers with no server (docs/plan.md section 1.11). `--multi` also writes separate pages |
| `js/resolve.js`, `js/builder.js`, `js/local-api.js`, `js/router.js` | The plan resolver, the job builder (shared with the server), the in-page API used when there is no build server, and the one-file site's page switching |
| `tests/ibfile.html`, `tests/icon.html` | Unit tests for `js/ibfile.js` and `js/icon.js` in the browser. Print PASS/FAIL. Fixtures come from `tests/make_fixtures.py` (Python's tarfile and zipfile, plus a synthetic PE with an icon resource) |
| `tests/mock_server.py` | A stand-in build server for trying the pages (`python3 tests/mock_server.py 8094`, then open `new.html?api=http://127.0.0.1:8094`) |

Headless test run:

```
python3 -m http.server 8093 &
google-chrome --headless=new --virtual-time-budget=20000 --dump-dom http://127.0.0.1:8093/tests/ibfile.html | grep -o 'PASS all [0-9]*\|FAIL [^<]*'
```

## Design notes

- [Design](docs/design.md): the whole design, decisions and open questions
- [Packed files](docs/packed-files.md): files carried inside an installer (your own files, extra installers to run, offline copies of downloads), and how the installer stays signed
- [Tested Python on old Windows](docs/windows-python-compat.md): known-good builds with working asyncio, per Windows version
- [Test machines](docs/test-vms.md): VMs for testing installers
- [Runtime catalog](runtime-catalog/README.md): where to download 13 languages' runtimes per OS, architecture and major version, mirrors, checksums, and per-version limitations (metadata backup; binaries live outside git)
