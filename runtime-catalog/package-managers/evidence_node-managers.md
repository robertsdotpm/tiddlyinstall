# nvm / fnm / n / volta (2026-09-17)

- **nvm** (`nvm-sh/nvm`, `nvm.sh`): `NVM_MIRROR="${NVM_NODEJS_ORG_MIRROR:-https://nodejs.org/dist}"`.
  Default is the vendor's own origin; the variable is purely an
  opt-in override point, not a curated mirror list.
- **n** (`tj/n`, `README.md`): `N_NODE_MIRROR` has no default either;
  the README's own examples are `https://npmmirror.com/mirrors/node` and
  `https://unofficial-builds.nodejs.org/download/release` -- both already
  confirmed in `catalog/node/mirrors.json` (npmmirror-registry/cdn were
  confirmed in the original scrape; unofficial-builds is the vendor's own
  second host, already the catalog's `url` for those entries, not a mirror).
- **fnm** (`Schniz/fnm`): no mirror override documented in the README at
  all (checked for "mirror" case-insensitively -- no hits).
- **volta** (`volta-cli/volta`): same -- no mirror override in the README.

## Conclusion

None of these four tools ship or document a distinct mirror host beyond
what `catalog/node/mirrors.json` already confirmed in its 2026-09-17 hunt
(aliyun, yandex, npmmirror-cdn/registry, npmmirror-cdn-unofficial,
nodejs-download-release). No mirror or corroboration update from this
source.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources node-managers`
