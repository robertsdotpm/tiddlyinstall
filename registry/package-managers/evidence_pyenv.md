# pyenv / python-build (2026-09-17)

Source: `github.com/pyenv/pyenv`, `plugins/python-build/{bin/python-build,share/python-build/*}`.
292 CPython definitions found (2.1.3 .. 3.16-dev), 248 of them containing a
`Python-<version>.tar.xz|.tgz` URL with a `#sha256` suffix (443 url+sha256
pairs total, counting both `.tar.xz` and `.tgz` per version where present).

## Mirror: PYTHON_BUILD_MIRROR_URL

Default (when unset): `https://pyenv.github.io/pythons`, keyed by sha256
(`<mirror>/<sha256>`), confirmed in `bin/python-build` line ~2550.

**Checked, does not help this catalog.** The backing repo
(`pyenv/pyenv.github.io`, `pythons/` dir) has only 44 files (via GitHub
contents API), and every one we could identify by hash is a *build
dependency* referenced from a definition (e.g. `readline-8.2`'s
`3feb7171f16a84ee82ca18a36d7b9be109a52c04f492a053331d7d1095007c35`, present
in the list at 3,043,952 bytes) -- openssl, readline, tcl/tk, etc, not
CPython itself. All actual CPython source-tarball hashes we tried
(e.g. Python-3.11.9.tar.xz's checksum, Python-2.7.18.tar.xz's checksum)
returned **404** from `pyenv.github.io/pythons/<hash>`. So this "mirror"
does not host the files this catalog tracks; no mirror added.

## Checksum corroboration

python-build's definitions carry the exact vendor sha256 (sourced from
python.org's own release process) for the `Python-<version>.tar.xz`/`.tgz`
source URL. Matched against `catalog/python/releases.json`:

- 206 entries had `checksum: null` (or a non-sha256 algo) and a matching
  pyenv sha256 -> added as `checksum_corroboration` via
  `tools/add_mirrors.py`. All are old source tarballs (2.1.3 through
  3.14.2) that predate the catalog's own checksum collection depth.
- 15 entries already had a sha256 checksum from python.org and it
  **agreed** in every case (sanity check).
- **0 disagreements.**
- Only `kind=source` (linux/any) entries are covered -- python-build only
  builds from source, so Windows/macOS installer entries (which make up
  most of the remaining null-checksum entries) are untouched by this
  source.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources pyenv --apply`
