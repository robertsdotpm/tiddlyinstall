# rustup (2026-09-17)

Source: `github.com/rust-lang/rustup`.

## RUSTUP_DIST_SERVER

`src/config.rs::dist_root_server()` falls back to
`dist::DEFAULT_DIST_SERVER` (`src/dist/mod.rs`) = `https://static.rust-lang.org`
when unset -- an override point, no alternate default baked in. This
matches what the prior `catalog/rust` mirror hunt already concluded (its
`NOTES.md` "Outside China" section: the rustup mirror ecosystem is almost
entirely China-specific).

## New find: rustup's own TLS-anchor test hosts

`tests/suite/static_roots.rs` (which generates `src/anchors.rs`) connects
to two hostnames to capture and pin their TLS root certificates as a
fallback for systems whose CA trust store is broken/missing:

```rust
const HOSTS: &[&str] = &[
    "fastly-static.rust-lang.org",
    "cloudfront-static.rust-lang.org",
];
```

These are **not third-party mirrors** -- they are the two CDN edges
(Fastly and CloudFront) that already sit in front of the same S3 bucket
`static.rust-lang.org` itself resolves to. Confirmed by identical ETag
(`"0dd536ce6b41e0be7651f01f12140ef8-7"`) and Last-Modified on both hosts
for the same file, and:

- **6-sample check** (old: 1.0.0 linux amd64 + macos amd64; mid: 1.19.0 +
  1.22.0 windows x86; newest: 1.98.1 linux amd64 + arm64 musl):
  6/6 matched on both hosts. `fastly-static.rust-lang.org` doesn't return
  `Content-Length` on HEAD (chunked through Varnish); confirmed instead via
  `Range: bytes=0-0` -> `Content-Range: bytes 0-0/<total>`.
- **Hash-verified sample**: `rust-1.19.0-i686-pc-windows-msvc.tar.xz`
  (51,167,056 bytes) downloaded in full from both hosts; sha256
  `5e00c99827b795eda1c15d65e2b0425de9e1a891a4ea66af5ed9b7a3f82e8142`
  matched the catalog's vendor checksum on both, then deleted.
- **Bogus-path control**: `rust-9.9.9-bogus-nonexistent.tar.gz` -> 404 on
  both hosts (and on `static.rust-lang.org` itself).
- **Protocols**: `fastly-static.rust-lang.org` serves plain `http://` with
  no redirect (200) -- useful for old systems with weak TLS/CA support,
  which is exactly the priority-2 goal in MIRROR-HUNT.md.
  `cloudfront-static.rust-lang.org` 301-redirects http to https.

## Applied

6,586 mirror entries (3,293 `releases.json` URLs x 2 hosts) added via
`tools/add_mirrors.py`. Also recorded in `catalog/rust/mirrors.json` (two
new entries) and `catalog/rust/NOTES.md` ("Package-manager mining
(2026-09-17)" section). Not folded into `catalog/rust/extra_mirrors.py`
(that script probes a *candidate list*; this is a fixed domain
substitution) -- if `scrape.py` is re-run (which clears `mirrors[]`),
re-run this script's rustup step to reapply.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources rustup --apply`
