# installer-builder
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
| `edit.html` | Editor for unsigned (mode C) installers: open a `.exe`, `.run` or macOS `.zip`, edit its settings record, plan and packed files, download it. Or start from a base installer. Nothing is uploaded |
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
| `tools/make_standalone.py` | Builds `editor-standalone.html` (gitignored): the editor as one self-contained file with the CSS, the JS and the three unsigned bases inside (from `bases/*/out/`, or placeholders if a base isn't built yet). Works from `file://` with no network, and has a **Save this page** button |
| `tests/ibfile.html` | Unit tests for `js/ibfile.js` in the browser. Prints PASS/FAIL. Its fixtures come from `tests/make_fixtures.py`, which uses Python's tarfile and zipfile |
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
