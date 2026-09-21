# jabba (2026-09-17)

Source: `github.com/shyiko/jabba`, `index.json` (its version index --
190KB, all vendor download URLs inline, no external mirror API).

Hosts referenced across the whole index:
`azure.azulsystems.com`, `cdn.azul.com`, `corretto.aws`,
`d3pxv6yz143wms.cloudfront.net`, `download.java.net`, `download.oracle.com`,
`github.com`, `public.dhe.ibm.com`, `support.apple.com`.

- `cdn.azul.com` and `github.com` are already this catalog's vendor hosts
  for the two Java vendors it tracks (Zulu, Temurin). No new mirror there.
- `corretto.aws` and `d3pxv6yz143wms.cloudfront.net` (Amazon Corretto's own
  CDN) are a vendor **not tracked in `catalog/java` at all** -- out of
  scope for a mirror addition (this task mines mirrors for existing
  catalog vendors, not new vendors).
- `azure.azulsystems.com` (old Zulu CDN, e.g.
  `zulu1.7.0_40-7.1.0.0-win64.zip`) times out on connect -- dead
  infrastructure, not usable even if it were in scope.
- `download.java.net`, `download.oracle.com`, `public.dhe.ibm.com`,
  `support.apple.com` are for JDK builds/vendors outside this catalog's
  two tracked vendors.

## Conclusion

No new mirror or corroboration for `catalog/java` from jabba.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources jabba`
