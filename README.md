# installer-builder
Build installers and executables for Windows, Linux, and macOS

## Prototype front-end

Plain HTML and CSS. No build step, no server. Open `index.html` in a browser.

| Page | What it is |
| --- | --- |
| `index.html` | What the service does |
| `new.html` | The installer form. Main view: app name and icon, what to package, language, platforms. Everything else, including the signing choice, is optional and collapsed under "Customise" with its default shown |
| `bases.html` | Catalogue of base installers, and the three ways to ship them |
| `edit.html` | Mock-up of editing an unsigned installer in the browser |
| `builds.html` | List of builds |
| `build.html` | One build: steps, downloads with hashed file names, what users see before installing, the settings record |

All data is sample data. Submitting the form just opens `build.html`.

## Design notes

- [Design](docs/design.md): the whole design, decisions and open questions
