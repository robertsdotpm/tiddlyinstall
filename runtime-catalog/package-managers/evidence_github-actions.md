# GitHub Actions tool caches (2026-09-17)

Checked `versions-manifest.json` from `actions/python-versions`,
`actions/node-versions` and `actions/go-versions` against the matching
catalog entries.

- **actions/python-versions**: ships `python-<version>-<platform>-<...>.tar.gz`
  for `linux-<distro>-<arch>` (e.g. `linux-22.04-arm64`, `rhel-9-x64`),
  darwin and windows -- a hostedtoolcache layout with no equivalent on
  python.org at all (python.org publishes no official Linux binaries, and
  its Windows/macOS artifacts are installers/pkgs, not this zip/tar.gz
  toolcache format). Not comparable; ruled out without downloading
  anything.
- **actions/node-versions**: same nominal (version, platform, arch) *does*
  exist on both sides, so checked by hash. `node-18.20.4-linux-x64.tar.gz`
  (GH Actions release asset) downloaded in full (44,647,376 bytes) and
  hashed: sha256 `3d57a13afa54c774b416e7e3d151c6eabf82bf46ee35cdb8e24dd99cf616a6e1`,
  which does **not** match the vendor's checksum for
  `node-v18.20.4-linux-x64.tar.gz`
  (`c4b0827dc47609d0a8379e6de6c74b3934da0b1312c733b5ebdcac16e3f1e954`,
  from nodejs.org's own SHASUMS256.txt). Different size too -- confirmed
  repackaged build, not a mirror. Sample file deleted after hashing.
- **actions/go-versions**: cheaper check first (sizes alone settle it):
  `go-1.10.8-linux-x64.tar.gz` is 101,500,639 bytes on GitHub vs.
  102,184,719 bytes for `go1.10.8.linux-amd64.tar.gz` on `dl.google.com`
  (per `catalog/go/releases.json`). Different -- no download needed to
  rule it out.

## Conclusion

All three are separate, repackaged builds (their own toolchain/compression
choices), not byte-identical to the vendor's files, exactly as
MIRROR-HUNT-adjacent guidance predicted. No mirror or
`checksum_corroboration` added; recorded here as evidence per the task's
"record non-identical ones only as evidence" instruction. No manifest hash
vs. vendor-checksum *disagreement on a matching corroboration* arose
(these aren't presented as corroboration sources at all, just non-matches),
so nothing needed reporting as a blocked disagreement either.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources github-actions`
