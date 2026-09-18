# installer-builder
Build installers and executables for Windows, Linux, and macOS

## Prototype front-end

Plain HTML and CSS. No build step, no server. Open `index.html` in a browser.

| Page | What it is |
| --- | --- |
| `index.html` | What the service does |
| `new.html` | The installer form. Main view: app name, where the code comes from (a GitHub repo or package, or written on the page: template, editor, Run with output in an overlay), language, platforms, offline installers. Everything else, including the signing choice, is optional and collapsed under "Customise" with its default shown |
| `create.html` | Redirects to `new.html`; writing an app is now a choice there |
| `bases.html` | Catalogue of base installers, and the three ways to ship them |
| `edit.html` | Mock-up of editing an unsigned installer in the browser |
| `builds.html` | List of builds |
| `build.html` | One build: steps, downloads with hashed file names, what users see before installing, the settings record |

All data is sample data. Submitting the form just opens `build.html`.

## Design notes

- [Design](docs/design.md): the whole design, decisions and open questions
- [Offline installers](docs/offline.md): single-file installers carrying their own downloads, and how they stay signed
- [Tested Python on old Windows](docs/windows-python-compat.md): known-good builds with working asyncio, per Windows version
- [Test machines](docs/test-vms.md): VMs for testing installers
- [Runtime catalog](runtime-catalog/README.md): where to download 13 languages' runtimes per OS, architecture and major version, mirrors, checksums, and per-version limitations (metadata backup; binaries live outside git)
