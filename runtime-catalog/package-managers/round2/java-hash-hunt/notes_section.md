## Mirror hunt round 3 -- search by hash (2026-09-20)

Java had the largest absolute gap in the catalogue and, going into this pass,
**not one Java entry on any platform had a plain `http://` URL** -- which
matters because XP/Vista/Win7 clients often cannot complete a modern TLS
handshake, and every file here is pinned by SHA-256 so http costs no integrity.
The technique asked for was searching by *hash* rather than by name: SHA-1 and
MD5 were computed locally for all 133 Java files in
`~/projects/installer-builder-runtimes/java/` (all 133 SHA-256-matched their
catalogue entry) and used to query hash-indexed services.

Scripts, evidence JSON and a full write-up:
`catalog/package-managers/round2/java-hash-hunt/` (see its `README.md`).
All writes went through `catalog/tools/add_mirrors.py`; `mirrors.json` and this
file were rewritten under `catalog/.write.lock`.

### Added

| host | what | entries |
| --- | --- | --- |
| `static.azul.com` (https) | the `/zulu-embedded/bin/` path round 2's prefix substitution skipped | 300 |
| `cdn.azul.com` (**plain http**) | same paths, HTTP 200, no redirect | 7,720 |
| `static.azul.com` (**plain http**) | same | 7,720 |
| `mirror.bazel.build` (https) | **new host** -- the Bazel project's Zulu mirror | 23 |
| `tarballs.nixos.org` (https) | zulu hashes, which round 2 never probed | 18 |
| `mirror.nju.edu.cn` (**plain http**) | http variant of its 116 recorded Temurin URLs | 116 |
| `distfiles.gentoo.org` (**plain http**) | http variant of its 61 recorded Temurin URLs | 61 |
| `distfiles.gentoo.org` (https + http) | 19 more Temurin files, found by computing Gentoo's `blake2b(filename)[:2]` distfiles layout offline instead of reading a `Manifest` | 19 |

15,996 mirror links in total. Coverage, `releases.json`: **7,697 -> 8,016
entries with at least one mirror (77.5% -> 80.7%)**, and **0 -> 7,884 entries
with a plain-http URL (0% -> 79.3%)**. In `download_plan_majors.json`: 135/157
mirrored (86.0%, unchanged -- those entries already had a mirror) and 0 -> 133
with plain http (84.7%); `download_plan.json` 99/119 mirrored, 98 with plain
http. Per OS: linux 4,250/4,982 mirrored (85.3%), http 84.0%; macos
2,169/2,899 (74.8%), http 73.5%; windows 1,597/2,056 (77.7%), http 76.2%.

`mirror.bazel.build/openjdk/` is the only genuinely new host, and the first
Zulu mirror found that Azul does not operate. It publishes a `SHA256SUM` beside
each version directory, and all 23 of those hashes equalled the catalogue's
vendor sha256 -- hash-level agreement, which is exactly what this pass was
looking for. Its one hash sample was 76 MB (over the pass's 60 MB budget) only
because the host carries no JREs at all.

### Rejected

- **Software Heritage** -- the sha256 content API does work (needs
  `Accept: application/json`; the HTML site is behind an Anubis challenge) but
  holds none of 18 sampled Zulu hashes. It archives source code, not vendor
  binaries.
- **Maven Central SHA-1 search** -- 0 hits for 4 locally computed SHA-1s. JDK
  distributions are not Maven artifacts.
- **SDKMAN** -- `api.sdkman.io/2/broker/download/java/...` 302s straight to
  `cdn.azul.com`: redirect-only, not a mirror.
- **`mirrors.sustech.edu.cn`, `mirrors.xtom.com`** -- both returned HTTP 200 for
  `/adoptium/`, `/Adoptium/` *and* `/zulu/`, and both are **soft-200
  catch-alls** (SUSTech serves a bot-challenge page for every path; xTom returns
  `200` with the body `404 Not Found`). Caught by the bogus-path control.
- **`mirrors.ustc.edu.cn` over http** -- 84/84 return 200, but so does a bogus
  path (its "Verifying your browser" page). Its https URLs stand.
- **USTC `github-release/adoptium/`** -- a second path to the same single tag
  per major already recorded; an alias, not extra coverage.
- **TUNA and NJU `github-release/` mirrors** -- listed in full; neither carries
  `adoptium`.
- **MirrorZ/CERNET** -- every member site's `mirrorz.json` was fetched; only
  USTC publishes an Adoptium repo (already recorded) and none publishes Zulu.
- **17 institutional mirror roots** (dotsrc, acc.umu.se, csclub.uwaterloo.ca,
  mirrors.kernel.org, jaist, rackspace, leaseweb, aliyun, tencent, yandex, pku,
  cqupt, sjtu, hit, neusoft, bjtu, zju, lzu) -- no adoptium or zulu tree.
  `mirror.yandex.ru` mirrors `packages.adoptium.net`, but that is the apt/yum
  repo and the catalogue has no deb/rpm Temurin entries.
- **`cache.nixos.org`** -- serves `.nar` archives of built store paths, not the
  upstream tarball, so it cannot serve these bytes.
- **Wayback** -- deliberately untouched in bulk per `MIRROR-HUNT-2.md`.

### Still open

1,921 Temurin entries remain unmirrored. Every Temurin mirror found to date
(TUNA, NJU, USTC) is *rolling* -- newest build per major only -- so historical
patch releases have no mirror anywhere but `wayback_retry.py`'s finds and
Gentoo's distfiles. `gentoo_sweep.py` in the round-3 folder re-checks Gentoo
cheaply by computing its `blake2b(filename)[:2]` distfiles layout offline.

`fix_zulu_sizes.py` needs re-running: three more entries were found with a
stale, API-rounded `size` (`zulu11.35.36-ca-jdk11.0.5-linux_aarch64.tar.gz`,
`zulu11.31.15-ca-jdk11.0.3-linux_aarch64.tar.gz`, and
`zulu8.21.0.1-jdk8.0.131-macosx_x64.zip`, the last off by 3,760 bytes -- well
beyond the documented 100-byte rounding). In each case the mirrors match the
real `cdn.azul.com` Content-Length and the catalogue's `size` is the wrong
number.

**The http URLs are recorded in each entry's `mirrors[]`**, next to the https
ones. `SCHEMA.md` also sketches a per-host `reachability.json` with an
`http_plain` flag; if that is the preferred home for this, the URLs can be
dropped again with a one-line filter on the scheme, and `mirrors.json` records
the per-host verdict either way.
