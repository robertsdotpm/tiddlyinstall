# Homebrew (light touch) (2026-09-17)

Sampled `homebrew-core` formulas for node, python@3.12, go, ruby and rust:
every one builds from (or downloads directly) the exact vendor URL already
in the catalog --

- node: `https://nodejs.org/dist/v26.8.2/node-v26.8.2.tar.xz`
- python@3.12: `https://www.python.org/ftp/python/3.12.14/Python-3.12.14.tgz`
- go: `https://go.dev/dl/go1.27.1.src.tar.gz`
- ruby: `https://cache.ruby-lang.org/pub/ruby/4.0/ruby-4.0.7.tar.gz`
- rust: `https://static.rust-lang.org/dist/rustc-1.98.1-src.tar.gz`

Homebrew builds these itself (or, for rust, downloads prebuilt
`static.rust-lang.org` artifacts directly for bootstrapping) rather than
serving a prebuilt mirror of its own. No alternative host found; per the
task brief ("different builds, not mirrors... only note if a formula
points at a vendor file on an alternative host") there is nothing to add.

conda-forge, MSYS2 and Cygwin were not separately probed beyond this
reasoning: all three package their *own* builds for their own runtime
environment (conda's own binary format, MSYS2/Cygwin's own POSIX-layer
builds) rather than redistributing the vendor's installer/archive
byte-for-byte, so a mirror match would be structurally unlikely for the
same reason Homebrew's didn't apply -- flagged here rather than spending
further searches confirming a very-low-probability negative.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources homebrew`
