# Meson runtime catalog notes

Build system for C/C++ projects, catalogued for installer-builder's
build-on-the-user's-machine path (`docs/design.md` 1.8). Meson is written in
Python and runs Ninja (`catalog/ninja`) to do the build.

## Sources

- `https://pypi.org/pypi/meson/json`: every sdist and wheel with the
  **vendor sha256**, size, upload date and `requires_python`.
- GitHub Releases (`mesonbuild/meson`): the source tarball (the same file
  as the PyPI sdist wherever both exist, confirmed per file), Windows
  `.msi` (`-64`, and `-32` up to 0.53.1), macOS `.pkg` (some releases
  0.58.1-1.8.2), `meson.pyz` (1.7.2, 1.8.5, 1.9.1, 1.11.1), and 0.17-0.28
  tarballs that were never on PyPI. Tarballs are GPG-signed (`.asc`). The
  **MSI, pkg and pyz have no vendor checksum**: `checksum` is GitHub's
  upload digest where present, else null.
- Each tag's `mesonbuild/mesonmain.py` / `environment.py` for the minimum
  Python (before PyPI metadata had it) and the minimum Ninja.

## Layout of the data

The pure-Python files (sdist `.tar.gz`, wheel `.whl`, `.pyz`) are identical
on every OS, so each is recorded three times (windows/linux/macos) with
`arch: any`, `variant: pure-python`, `min_os: "needs Python <x>"`. 761
entries, 144 versions (0.17.0-1.12.0), 61 minor lines. Wheels exist from
0.59.3.

Version-specific facts measured from the files:

- `.msi` = PyInstaller-frozen `meson.exe` + `pythonXY.dll` + UCRT DLLs +
  `ninja.exe`. Bundled Python by sampling 20 MSIs: 3.6 (0.42.1-0.50.1), 3.7
  (0.52.1-0.54.3), 3.9 (0.56.2-0.59.4), 3.10 (0.61.5-0.64.1, and 1.1.1),
  3.11 (1.0.1), 3.12 (1.3.2-1.10.0), 3.14 (1.11.0, 1.12.0). Unsampled
  boundaries (0.51, 0.55, 0.60, 1.2) are marked as such in `limitations.json`.
- `.pkg` = PyInstaller build expanded to `/usr/local/share/meson-<ver>/`
  plus `/usr/local/bin/ninja`. From the Mach-O headers in the payload:
  **x86_64-only for 0.58.1-1.2.2** (meson minos 10.7 in 0.58.1, 10.13 in
  1.1.1-1.2.2), **arm64-only for 1.6.1-1.8.2** (minos 11.0; its ninja 14.0).
  No universal build was ever shipped.

## Python and Ninja each Meson line needs

| Meson | Python | Ninja |
| --- | --- | --- |
| 0.29-0.41 | 3.3 | any (0.29), 1.5 (0.40+) |
| 0.42-0.44 | 3.4 | 1.5 |
| 0.45-0.56 | 3.5 | 1.5 (to 0.53), 1.7 (0.54-0.56) |
| 0.57-0.61 | 3.6 | 1.8.2 |
| 0.62-1.11 | 3.7 | 1.8.2 |
| 1.12 | 3.10 | 1.8.2 |

## Recommendation for installer-builder

**Install Meson as pure Python by default, on every OS**: unpack the sdist
into Meson's own `{runtime_dir}` and run `python -E -s meson.py`, using the
app's own Python if it has one, or the catalogue's Python installed as a
build-only runtime (removed with the other build tools after the build).
If the app is a Python app, `pip install` of the wheel into its own Python
is equivalent. Why:

- the vendor sha256 comes from PyPI, and four China PyPI mirrors are
  confirmed (below); the MSI has neither;
- no network, pip or compiler needed at install time (Meson has no
  dependencies);
- the choice of Python sets the OS floor, which reaches much further back
  than the MSIs (see old OSes).

Use the **Windows MSI** only when the app has no Python and the user's
Windows meets its bundled Python's floor. It's self-contained and even
brings `ninja.exe`, but it's x64-only from 0.54, missing for some releases
(1.5.2, 1.7.2 ...), has no vendor checksum, and must be extracted with
`msiexec /a` (a normal install is per-machine and may add itself to PATH; not verified).
**Don't use the macOS .pkg**: it installs to `/usr/local`, is single-arch,
and stopped after 1.8.2.

The recipes use a new token, `{python}`: the interpreter of the Python
runtime installed for this app. installer-builder has to resolve it, like
the Ninja runtime's `path_prepend`.

## Old operating systems

- **Windows XP**: Meson 0.44.1 (the last to accept Python 3.4) with the
  catalogue's Python 3.4 and Ninja 1.6.0 (x86). 0.45-0.53.2 need Python
  3.5, which runs on XP only with the operator-tested custom 3.5 backport
  (Ninja 1.6.0 still satisfies their >=1.5). From 0.54 Meson needs Ninja
  >=1.7, and every Ninja from 1.7.1 is x86-64 and Vista+, so **no newer
  Meson can build on XP or on 32-bit Windows**. Untested.
- Windows Vista x64 / 7: up to 1.11.x with Python 3.7/3.8. 8+: newest.
- macOS / Linux: whatever Python is available; 1.12 needs 3.10.

## Mirrors

- github.com: the sdists, confirmed per file (digest or size equal to
  PyPI's): 79 versions.
- China PyPI mirrors, same path as `files.pythonhosted.org`: Aliyun,
  Huawei Cloud, Tencent Cloud, Douban. Five samples (0.29.0 sdist, 0.61.5 and
  1.12.0 sdist + wheel) size-matched; the 1.12.0 wheel downloaded in full
  from each and sha256-matched PyPI; a bogus filename 404s on each.
  Pull-through caches, applied to every PyPI file.
- Rejected: TUNA and BFSU (HEAD sizes matched but full GETs were refused
  with 403, the same block other runtimes' hunts hit), USTC (403), NJU (302).
  No mirror carries the MSI or pkg.

## Testing (2026-09-18, Linux)

- sdist 1.12.0 unpacked into a folder with a space, run with the system
  Python 3.12 and with the catalogue's python-build-standalone 3.14.7.
- wheel 1.12.0 pip-installed (`--no-index`, `PIP_CONFIG_FILE=/dev/null`)
  into a copy of that 3.14.7, used through `-m mesonbuild.mesonmain` and
  through its `bin/meson` wrapper.
- `meson.pyz` 1.11.1 run from a folder with a space.

Each one configured, built and installed a hello-world C project with Ninja
1.13.2 and gcc, including the exact `project_install` command with tokens
substituted and Ninja found only via PATH. With no Ninja on PATH, Meson
fails with "Could not detect Ninja v1.8.2 or newer". `meson compile` needs
Ninja on PATH too, not only `setup`. An empty fake `HOME` stayed empty.
The MSI and pkg recipes were not run.
