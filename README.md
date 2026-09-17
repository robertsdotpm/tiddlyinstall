# installer-builder
Build installers and executables for Windows, Linux, and macOS

## Prototype front-end

Plain HTML and CSS. No build step, no server. Open `index.html` in a browser.

| Page | What it is |
| --- | --- |
| `index.html` | What the service does |
| `new.html` | The installer form. Main view: app details (name and icon, the only metadata Windows, Linux and macOS all support; reused for the installed launcher), what to package, language, platforms. Everything else is optional, collapsed under "Customise" with its default shown |
| `bases.html` | Catalogue of reusable base installers (`install_python_x`, …) |
| `builds.html` | List of builds |
| `build.html` | One build: steps, downloads, install layout, metadata, log |

All data is sample data. Submitting the form just opens `build.html`.
