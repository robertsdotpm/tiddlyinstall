# rig (r-lib/rig) (2026-09-17)

Source: `github.com/r-lib/rig`. Package-repo (CRAN mirror) references in
the source (`cloud.r-project.org`, `p3m.dev`) are for R *packages*, not R
itself -- not relevant here. rig resolves which R binary to download via
an external API, `src/resolve.rs`:

```rust
const API_URI: &str = "https://api.r-hub.io/rversions/resolve/";
const API_ROOT: &str = "https://api.r-hub.io/rversions/";
```

## New find: cran.rstudio.com

`api.r-hub.io/rversions/resolve/4.4.1` and
`api.r-hub.io/rversions/available/macos/arm64` both return download URLs on
**`cran.rstudio.com`** (Posit/RStudio's own CRAN mirror), not
`cran.r-project.org` or `cloud.r-project.org` -- a host not previously in
`catalog/r/mirrors.json`.

- **5-sample check**, reusing `r/mirrors.json`'s existing sample set
  (`src/base/R-4/R-4.6.1.tar.gz`, `src/base/R-3/R-3.6.3.tar.gz`,
  `bin/windows/base/R-4.6.1-win.exe`,
  `bin/windows/base/old/4.0.0/R-4.0.0-win.exe`, `bin/macosx/base/R-4.0.0.pkg`):
  5/5 `Content-Length` matched `cran.r-project.org`.
- **Hash verification**: no catalog entry under `cran.r-project.org` has a
  vendor checksum small enough to sample (the catalog's 82 checksummed R
  entries are all on the separate `cran-archive.r-project.org` host, which
  `cran.rstudio.com` was not checked against). Instead, `R-3.6.3.tar.gz`
  (33,308,185 bytes) was downloaded in full from both `cran.r-project.org`
  and `cran.rstudio.com` and compared directly: sha256
  `89302990d8e8add536e12125ec591d6951022cf8475861b3690bc8bf1cefaa8f`,
  identical on both. Both files deleted after hashing.
- **Protocols**: plain `http://` works (200, no redirect).
- **Bogus-path control**: `src/base/R-9/R-9.9.9-bogus.tar.gz` -> 404.

## Applied (queued)

200 mirror entries prepared for every `cran.r-project.org` URL in
`catalog/r/releases.json`. `catalog/.busy` listed `r` as busy at the time
this was run, so `tools/add_mirrors.py` automatically queued them to
`catalog/pending_updates/r.jsonl` instead of writing directly -- run
`add_mirrors.py --flush-pending` once `r` is no longer busy.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources rig --apply`
