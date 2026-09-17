# phpenv / php-build (2026-09-17)

- **php-build** (`php-build/php-build`, `bin/php-build` +
  `share/php-build/definitions/*`, 504 definitions): definitions use
  `install_package "https://www.php.net/distributions/php-X.Y.Z.tar.bz2"`
  with **no checksum suffix at all** (unlike pyenv/ruby-build, which
  append `#sha256`). Grepped `bin/php-build` for
  `mirror`/`checksum`/`sha256`/`md5`: no matches. php-build has neither a
  mirror-override mechanism nor any checksum data to corroborate with.
- **phpenv** (`phpenv/phpenv`): a thin rbenv-style version-switcher; it
  shells out to php-build for actual installs and has no download/mirror
  logic of its own (checked README for "mirror": no hits).

## Conclusion

Neither tool contributes anything to `catalog/php` -- no mirror host, no
checksum corroboration source. `catalog/php/mirrors.json`'s existing
`museum.php.net` mirror (from the original scrape) remains the only one.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources php-managers`
