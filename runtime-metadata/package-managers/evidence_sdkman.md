# SDKMAN (2026-09-17)

Checked `api.sdkman.io/2/broker/download/java/<candidate>/linuxx64` for
both vendors this catalog tracks:

- `21.0.4-tem` (Temurin) -> redirects to
  `release-assets.githubusercontent.com/...OpenJDK21U-jdk_x64_linux_hotspot_21.0.4_7.tar.gz`
  (GitHub's signed release-asset host, i.e. still `github.com/adoptium`'s
  own release, matching the catalog's existing `url`).
- `21.0.4-zulu`, `17.0.9-zulu`, `8.0.412-zulu` (Zulu) -> all redirect
  directly to `cdn.azul.com/zulu/bin/...` (the catalog's existing vendor
  host for Azul builds).

SDKMAN's broker is **redirect-only** to each vendor's own host for every
candidate checked -- it never itself hosts a byte. That fails
MIRROR-HUNT.md's explicit rule ("A mirror that merely 30x-redirects to the
vendor's own host is NOT a mirror"), so SDKMAN contributes nothing to this
catalog: no new mirror host, no checksum data of its own (the API's
metadata calls returned 400/404 in this environment and weren't pursued
further once the broker redirect made the point moot).

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources sdkman`
