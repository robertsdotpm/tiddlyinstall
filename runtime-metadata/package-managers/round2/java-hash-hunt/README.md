# Java mirror hunt, round 3: search by hash (2026-09-20)

Target: the Java gap (largest in the catalogue). Vendor focus per the brief was
Azul Zulu (`cdn.azul.com`, variants `zulu-jdk`/`zulu-jre`), plus the standing
question of whether *any* Java file can be fetched over plain `http://` — old
Windows (XP/Vista/7) often cannot complete a modern TLS handshake, and every
file here is pinned by SHA-256 anyway.

Everything written to the catalogue went through
`catalog/tools/add_mirrors.py` (which takes `catalog/.write.lock` itself);
`java/mirrors.json` and `java/NOTES.md` were rewritten under the same lock.
Nothing else was touched, and no git command other than `git status` was run.

## Scripts (all stdlib-only, re-runnable, in dependency order)

| script | what it does |
| --- | --- |
| `local_hashes.py` | SHA-256/SHA-1/MD5 of all 133 locally downloaded Java files in `~/projects/installer-builder-runtimes/java/`, matched to catalogue entries by file name → `local_hashes.json` (133/133 sha256-matched the catalogue). These SHA-1/MD5 values are what the hash-indexed lookups below were driven with. |
| `probe.py azul-embedded` | HEADs `static.azul.com/zulu-embedded/bin/<file>` for every `cdn.azul.com/zulu-embedded/bin/` entry → `azul_embedded_results.json` |
| `probe.py azul-http` | plain-`http://` spread sample on both Azul hostnames, redirects disabled → `azul_http_results.json` |
| `probe.py nix-zulu` | `https://tarballs.nixos.org/sha256/<vendor sha256>` for all 7,720 zulu entries → `nix_zulu_results.json` |
| `probe.py swh` | Software Heritage `api/1/content/sha256:<hex>/` for a 18-file spread → `swh_results.json` |
| `probe.py control` | bogus-path controls → `control_results.json` |
| `bazel_mirror.py` | parses `mirror.bazel.build/openjdk/index.html`, matches by file name, compares each version directory's own `SHA256SUM` with the catalogue's vendor sha256, HEADs each file over https **and** http with redirects disabled → `bazel_results.json` |
| `http_variants.py` | for every host already recorded as a java mirror, re-HEADs all of its recorded URLs over plain `http://` with redirects disabled, plus a per-host bogus control → `http_variant_results.json`; `emit_updates()` writes `http_variant_updates.jsonl` |
| `gentoo_sweep.py` | hash-addressed sweep (19 hits): Gentoo's distfiles layout is `distfiles/<blake2b(filename)[:2]>/<filename>` (`distfiles/layout.conf`: `filename-hash BLAKE2B 8`), computable offline, so every still-unmirrored java file was asked for directly instead of only the ones in a current `Manifest` → `gentoo_sweep_results.json` |
| `make_updates.py` | turns the result files into `java_hash_hunt_updates.jsonl` |

## Confirmed and applied

### `static.azul.com/zulu-embedded/bin/` — 300 entries (path the round-2 pass missed)

Round 2 applied `static.azul.com` to the 7,420 entries under
`cdn.azul.com/zulu/bin/` by prefix substitution, which silently skipped the 300
entries under **`cdn.azul.com/zulu-embedded/bin/`** (Zulu Embedded: aarch32/
aarch64 and the old `zre*-cp3-wr-*` builds). All 300 were HEAD-checked here:
296 matched on the first pass; of the other four, two were HEAD timeouts that
matched on individual retry and two are **stale `size` fields in
`releases.json`**, not mirror problems — `static.azul.com` returns exactly what
`cdn.azul.com` returns for both. Bogus file and bogus directory → 404.

### Plain `http://` on both Azul hostnames — 7,720 entries each

`http://cdn.azul.com/...` and `http://static.azul.com/...` serve the same paths
with **no redirect at all** (not a 301 to https): 32/32 HEADs on a 16-file
spread sample (majors 6–24, every os/arch/kind/format/variant combination, plus
the catalogue's smallest and largest zulu files) returned 200 with
Content-Length equal to the vendor size. Bogus paths 404 on both.
`zre8.23.0.3-cp3-wr-jre8.0.144-linux_i686.tar.gz` (21,377,456 B) was downloaded
in full over plain http from **each** host (`curl --proto '=http'`, 0 redirects,
`scheme=HTTP`) and its SHA-256 matched the catalogue checksum exactly.

This is the first plain-http path to any Java file in the catalogue.

### `mirror.bazel.build/openjdk/` — 23 entries — NEW HOST

The Bazel project's (Google-operated, global GCS-backed anycast) OpenJDK mirror
holds 13 Azul Zulu version directories, `azul-zulu<version>/<original filename>`,
with a `SHA256SUM` beside each. 23 of its files are catalogue entries.
**All 23 of the mirror's own SHA256SUM values equal the catalogue's vendor
sha256** — hash-level agreement, not just a size match — and 23/23 HEADs
returned 200 with Content-Length equal to the *real* `cdn.azul.com`
Content-Length. `zulu8.21.0.1-jdk8.0.131-win_x64.zip` (76,357,880 B, the
smallest file this host carries — it holds no JREs, so the ≤60 MB sample budget
could not be met) was downloaded in full and sha256-verified. Bogus file and
bogus directory → 404. `http://` 301-redirects to https, so no plaintext URL
was recorded for it.

### `tarballs.nixos.org` — 18 more entries

Round 2 probed this hash-addressed Nix fetchurl fallback cache only for
*then-unmirrored* entries, which by that point excluded every zulu entry. All
7,720 zulu sha256 values were probed here: 18 present, all with Content-Length
equal to the vendor size. The URL key **is** the vendor sha256, so byte
identity is guaranteed by the host's addressing; the host was already
hash-verified for java in round 2. `http://` 301-redirects to https.

### Plain `http://` on two hosts already recorded for java — 177 entries

- `mirror.nju.edu.cn/adoptium/...`: 116/116 of its recorded URLs also serve over
  http (redirects disabled, `Cookie: bcheck=true`), bogus path 404,
  `OpenJDK18U-jre_aarch64_mac_hotspot_18.0.2.1_1.tar.gz` (36,270,257 B)
  downloaded in full over http and sha256-verified.
- `distfiles.gentoo.org/distfiles/...`: 61/61, bogus path 404,
  `OpenJDK8U-jre_x64_linux_hotspot_8u504b01.tar.gz` (41,844,148 B) downloaded in
  full over http and sha256-verified.

These are Temurin entries, so they are the only plain-http path for anything
that is not Zulu.

### `distfiles.gentoo.org` hash-layout sweep — 19 more entries

Gentoo's distfiles layout is computable offline (`distfiles/layout.conf`:
`filename-hash BLAKE2B 8`, i.e.
`distfiles/<blake2b(filename)[:2]>/<filename>`), so rather than only asking for
the files named in a current `Manifest` (round 2's method), `gentoo_sweep.py`
asked the host directly for all 1,940 still-unmirrored Java files. 19 were
there — Temurin 8/11/17/21/25 archives from ebuild revisions that have left the
tree but whose distfiles have not been pruned — every one a Content-Length
match over **both** https and http. Bogus layout path 404. This brings Gentoo
to 80 java entries and drops the unmirrored count to 1,921.

## Tried and rejected

- **Software Heritage** (`archive.softwareheritage.org/api/1/content/sha256:<hex>/`)
  — the API *is* genuinely hash-indexed and does work from here, but only with
  `Accept: application/json` (the HTML site is behind an Anubis bot challenge
  that returns 200 HTML for everything). 0 of 18 spread-sample Zulu hashes were
  present: SWH archives source code, not vendor binary tarballs.
- **Maven Central SHA-1 search** (`search.maven.org/solrsearch/select?q=1:"<sha1>"`,
  and the `central.sonatype.com` copy) — 0 hits for 4 locally computed SHA-1s
  spanning Zulu JRE/JDK and Temurin. JDK distributions are not published to
  Maven Central as artifacts.
- **SDKMAN** (`api.sdkman.io/2/broker/download/java/21.0.9-zulu/linuxx64`) —
  302 straight to `cdn.azul.com`. Redirect-only, so not a mirror by this hunt's
  own rule. (Its candidate index is useful metadata, nothing more.)
- **`mirrors.sustech.edu.cn` and `mirrors.xtom.com`** — both looked like hits
  (`/adoptium/`, `/Adoptium/` **and** `/zulu/` all returned HTTP 200) and both
  are **soft-200 catch-alls**: SUSTech serves an Anubis bot-challenge page for
  every path, and xTom returns `200` with the body `404 Not Found`. Caught by
  the bogus-path control; nothing was added. A status-code-only probe would have
  added three fictional mirrors to each.
- **`mirrors.ustc.edu.cn` over http** — 84/84 return 200, but the bogus-path
  control also returns 200 (the "Verifying your browser" challenge page). Soft
  200, so http is not usable on that host; its https URLs stand.
- **USTC `github-release/adoptium/`** — a real second path to the same content
  (`/github-release/adoptium/temurin<major>-binaries/<tag>/`), but it holds
  exactly the same single tag per major as the `/adoptium/releases/` path
  already recorded in round 2. An alias, not extra coverage.
- **TUNA and NJU `github-release/` mirrors** — both exist and were listed in
  full; neither carries `adoptium` (TUNA: 43 projects, NJU: 86; `graalvm` and
  `ibmruntimes` yes, Adoptium no).
- **MirrorZ / CERNET aggregate** — the site list was pulled straight from
  `mirrorz.org`'s own bundle and each site's `mirrorz.json` was fetched
  (iscas, lzu, jlu, sdu, sustech, ustc, wsyu, zju, tuna, nju). Only USTC
  publishes an Adoptium repo, and it is the one already recorded. No site
  publishes a Zulu repo.
- **Institutional mirror roots** checked for an adoptium/zulu tree and having
  none: `mirrors.dotsrc.org`, `ftp.acc.umu.se`, `mirror.csclub.uwaterloo.ca`,
  `mirrors.kernel.org`, `ftp.jaist.ac.jp`, `mirrors.pku.edu.cn`,
  `mirrors.cqupt.edu.cn`, `mirror.rackspace.com`, `mirror.leaseweb.net`,
  `mirrors.aliyun.com`, `mirrors.cloud.tencent.com`, `mirror.sjtu.edu.cn`,
  `mirrors.hit.edu.cn`, `mirrors.neusoft.edu.cn`, `mirror.bjtu.edu.cn`,
  `mirrors.zju.edu.cn`, `mirror.lzu.edu.cn`. `mirror.yandex.ru` mirrors
  `packages.adoptium.net` — but that is the apt/yum repo only, and the catalogue
  has no deb/rpm Temurin entries.
- **`d10.injdk.cn/openjdk/`** — its sibling directories are `graalvm/`,
  `openjdk/` (community jdk.java.net builds) and `oraclejdk/`; no Temurin, and
  the `zulu/` tree is already recorded.
- **NixOS binary cache** (`cache.nixos.org`) — stores `.nar` archives of built
  store paths, not the upstream tarball, so it cannot serve these bytes. Only
  `tarballs.nixos.org` is a real fallback cache.
- **Wayback Machine** — deliberately not touched in bulk, per
  `MIRROR-HUNT-2.md`; `catalog/tools/wayback_retry.py` is already working
  through it.

## Web searches

2 of the ≤4 allowed. The first (`mirror site index of "zulu" Azul JDK tar.gz
directory listing mirror`) is what surfaced `mirror.bazel.build/openjdk` — the
only genuinely new host this round. The second, looking for a Temurin mirror
holding full release history, turned up nothing that is not already recorded.

## Still open

1,921 Temurin entries remain unmirrored (majors 8/11/17 dominate). Every public
Temurin mirror found so far — TUNA, NJU, USTC — is *rolling*: it carries only the
newest build per major, so historical patch releases have no mirror anywhere
except what `wayback_retry.py` finds. Gentoo distfiles is the one host that keeps
older ones, and `gentoo_sweep.py` exists to re-check it cheaply as its tree moves.

`fix_zulu_sizes.py` should be re-run: this pass found two more entries whose
`size` field is a stale rounded value (`zulu11.35.36-ca-jdk11.0.5-linux_aarch64.tar.gz`
431863000 vs real 431862694, `zulu11.31.15-ca-jdk11.0.3-linux_aarch64.tar.gz`
417182000 vs real 417182286) plus `zulu8.21.0.1-jdk8.0.131-macosx_x64.zip`
(78856200 vs real 78852440, off by 3,760 bytes — larger than the documented
100-byte rounding, so worth a look). That is on top of the one round 2 flagged.
