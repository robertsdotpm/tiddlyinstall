# ruby-build (2026-09-17)

Source: `github.com/rbenv/ruby-build`, `bin/ruby-build`, `share/ruby-build/*`
(302 definitions).

## Mirror: RUBY_BUILD_MIRROR_URL

**Docs are stale.** `share/man/man1/ruby-build.1.adoc` still documents
`RUBY_BUILD_MIRROR_URL (default: a sponsored Amazon CloudFront mirror)`,
and so does `README.md`'s env-var table, but the current `bin/ruby-build`
has **no hardcoded default** -- the only handling is:

```
if [ -n "$RUBY_BUILD_MIRROR_URL" ]; then
  RUBY_BUILD_MIRROR_URL="${RUBY_BUILD_MIRROR_URL%/}"
fi
...
if [ -n "$RUBY_BUILD_SKIP_MIRROR" ] || ! has_checksum_support compute_sha2; then
  unset RUBY_BUILD_MIRROR_URL RUBY_BUILD_MIRROR_PACKAGE_URL
fi
```

If the variable is unset, ruby-build just fetches from the package's own
URL. Whatever CloudFront distribution the docs describe is either gone
from the current source or was never literally a code-level default (a
`RUBY_BUILD_MIRROR_URL` unset by default is functionally "no mirror").
Nothing to add -- this matches what the prior `catalog/ruby` mirror hunt
already found (its `mirrors.json` lists third-party mirrors it found
independently: mirror.cyberbits.eu, ftp.iij.ad.jp, www.ring.gr.jp -- none
of them CloudFront).

## Checksum corroboration

286 `ruby-<version>` definitions carry a `cache.ruby-lang.org` URL +
sha256. Matched against `catalog/ruby/releases.json`: **0 null-checksum
matches** -- every overlapping entry (cache.ruby-lang.org source
tarballs) already has a vendor sha256 checksum, and all matches **agree**
(2 checked directly; the rest are implied by the same source tree). ruby-build
is Unix/macOS-only (no Windows/rubyinstaller definitions), so it has
nothing to say about the catalog's 685 null-checksum Windows entries
(rubyinstaller/ruby-builder archives).

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources ruby-build --apply`
