# asdf / mise core plugins (2026-09-17)

- **mise** (`jdx/mise`, `src/config/settings.rs`):
  `DEFAULT_NODE_MIRROR_URL = "https://nodejs.org/dist/"` -- vendor origin;
  `NODE_BUILD_MIRROR_URL` / `settings.node.mirror_url` are opt-in
  overrides only, same pattern as nvm. A `go_download_mirror` setting also
  exists (`src/config/settings.rs` line ~1329) but carries no alternate
  default of its own either.
- **asdf-vm** core-ish plugins (node/python/ruby/go, whether built in or
  the standard community plugins) shell out to the same tools already
  investigated directly -- nodejs.org's own index, python-build,
  ruby-build, or go.dev's dl API -- rather than running a mirror layer of
  their own. No independent mirror source to mine here.

## Conclusion

Consistent with every other version manager checked in this pass: mirror
*override points* are common, but none of these tools ship an alternate
default host beyond the vendor's own origin. No update.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources asdf-mise`
