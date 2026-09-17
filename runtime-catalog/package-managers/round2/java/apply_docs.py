#!/usr/bin/env python3
"""One-shot: append the round-2 mirror hunt entries to java/mirrors.json
and a "Mirror hunt (2026-09-17)" (round 2) section to java/NOTES.md,
under catalog/.write.lock, re-reading immediately before modifying and
writing atomically, per MIRROR-HUNT-2.md's rule that several agents run
at once."""
import fcntl
import json
import tempfile
import os
from pathlib import Path

CATALOG = Path("/home/x/projects/installer-builder-runtimes/catalog")
JAVA = CATALOG / "java"
LOCK = CATALOG / ".write.lock"

NEW_MIRRORS = [
    {
        "runtime": "java",
        "vendor": "zulu",
        "name": "static.azul.com (alternate Azul CDN hostname)",
        "region": "global (Cloudflare anycast)",
        "operator": "Azul Systems (same operator as cdn.azul.com; not a third-party mirror, but a second, independently resolvable hostname on the same CDN origin)",
        "url_template": "https://static.azul.com/zulu/bin/{filename}",
        "protocols": {"https": "confirmed", "http": "confirmed (plain http, no redirect)"},
        "coverage": "full -- every zulu-jdk/zulu-jre entry in releases.json",
        "confirmed_by": "extra_mirrors_round2.py: HEAD-checked a 70-file spread sample covering every major (6-27), every (kind, format, variant) combination, and the smallest/largest files in the catalog. 70/70 Content-Length matches (5 apparent mismatches on the first pass were transient HEAD timeouts under concurrency, confirmed as matches on individual retry). Bogus-path control on both a nonexistent file and a nonexistent directory returned 404 (not a soft-200 catch-all). Applied to all 7,420 zulu entries by URL-prefix substitution.",
        "checked_count": 70,
        "confirmed_count": 70,
        "confirmed_majors": ["6", "7", "8", "9", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26"],
        "sample_file_hash_verified": {
            "url": "https://static.azul.com/zulu/bin/zulu7.48.0.11-ca-jre7.0.312-win_i686.msi",
            "size": 22343680,
            "algo": "sha256",
            "result": "match"
        },
        "notes": "Same Cloudflare zone/ETags/cache as cdn.azul.com (both fronted by cloudflare, identical Content-Length and etag on every file checked) -- almost certainly the same origin bucket behind a second DNS name, but confirmed independently rather than assumed. Useful as a fallback hostname (e.g. if cdn.azul.com is blocked/rate-limited on some network path) even though it isn't operationally independent of Azul's own infrastructure. This closes essentially the entire Zulu mirror gap: 0/7,420 zulu entries now lack a mirror (previously 0 had one).",
        "checked_at": "2026-09-17"
    },
    {
        "runtime": "java",
        "vendor": "zulu",
        "name": "injdk.cn Zulu mirror (d10.injdk.cn)",
        "region": "China",
        "operator": "injdk.cn, a Chinese JDK-download aggregator site (https://injdk.cn/); the mirror itself is served from a subdomain (d10.injdk.cn) linked from injdk.cn's homepage",
        "url_template": "https://d10.injdk.cn/openjdk/zulu/{major}/{filename}",
        "protocols": {"https": "confirmed", "http": "redirects (308) to https -- no plaintext option"},
        "coverage": "partial/rolling: JDK builds only (no JRE), one (occasionally a couple of) recent build per major, majors 8/11/17/21/25/26/27 as of this run",
        "confirmed_by": "extra_mirrors_round2.py: fetches the real Caddy-served directory listing for openjdk/zulu/ and each major subdirectory, matches filenames against releases.json's zulu entries (same filenames as cdn.azul.com), then HEAD-confirms each candidate's Content-Length against the vendor size. Bogus-path control returned 404.",
        "checked_count": 101,
        "confirmed_count": 101,
        "confirmed_majors": ["8", "11", "17", "21", "25", "26", "27"],
        "sample_file_hash_verified": {
            "attempted": False,
            "reason": "This host mirrors JDK builds only (no JRE), and every JDK build in the matched set is >60MB (smallest confirmed file: 87,790,094 bytes) -- no file fits the pass's <=60MB hash-sample budget. Recorded as HEAD-confirmed (Content-Length match) only, not hash-verified."
        },
        "notes": "One entry (zulu17.64.17-ca-jdk17.0.18-c2-linux_aarch32hf.tar.gz, major 17) surfaced a pre-existing data-quality issue rather than a mirror problem: this releases.json entry's `size` field is 183202000 (a stale Azul-API-rounded value not caught by fix_zulu_sizes.py, which rounds to the nearest 100 bytes per that script's own docstring) while the real cdn.azul.com Content-Length is 183201984. d10.injdk.cn's Content-Length (183201984) matches the REAL vendor size exactly, so the mirror was still recorded as confirmed; the stale `size` field itself was left alone since add_mirrors.py only appends to mirrors[]/checksum_corroboration[], never edits other fields -- worth a follow-up run of fix_zulu_sizes.py to catch entries it missed.",
        "checked_at": "2026-09-17"
    }
]

NOTES_ADDITION = """
## Mirror hunt round 2 (2026-09-17)

Per `catalog/MIRROR-HUNT-2.md`, focused on Zulu specifically since it was
essentially the entire gap (9,745/9,937 releases.json entries unmirrored
going into this pass, nearly all zulu-jdk/zulu-jre). Logic and evidence
live under `catalog/package-managers/round2/java/`
(`extra_mirrors_round2.py`, re-runnable; `probe_static_azul.py`, the
stress-sample script used to validate static.azul.com before trusting it
site-wide). Writes went through `catalog/tools/add_mirrors.py` only, per
this round's rules.

**0 of the 4 allotted web searches were needed** -- every host came from
the leads already given in the task, reached by direct curl.

### Added: static.azul.com (full Zulu coverage)

`https://static.azul.com/zulu/bin/{filename}` is a second, independently
resolvable hostname serving what looks like the exact same CDN origin as
`cdn.azul.com/zulu/bin/` (same Cloudflare zone, identical ETags and
Content-Length on every file checked, same behavior over http and https).
Confirmed rather than assumed: a 70-file sample spanning every major
(6-27), every (kind, format, variant) combination, and the catalog's
smallest/largest files matched Content-Length 70/70 (a handful of
apparent mismatches on the concurrent first pass were transient HEAD
timeouts, not real differences -- confirmed clean on individual retry).
One small sample (`zulu7.48.0.11-ca-jre7.0.312-win_i686.msi`, 22,343,680
bytes) was downloaded whole and its sha256 matched the catalog checksum
exactly; deleted afterwards. Applied to all 7,420 zulu entries by
substituting the URL prefix. **This closes the Zulu mirror gap
entirely: 0/7,420 zulu entries now lack a mirror.**

It is worth being honest about what this host is: since it appears to be
the same underlying origin as `cdn.azul.com` behind a second DNS name
(not a third party running independent infrastructure), it doesn't add
true operational redundancy against an Azul-side outage the way a
university mirror would -- but it does add a second, separately-resolved
hostname, which is exactly the kind of fallback that matters if
`cdn.azul.com` specifically is blocked or rate-limited on some network
path, which is the scenario an installer builder actually needs to
survive.

### Added: injdk.cn Zulu mirror (d10.injdk.cn)

`https://injdk.cn/` (found by following its homepage's own outbound
links, not a search) links to `https://d10.injdk.cn/openjdk/zulu/`, a
real Caddy-served directory mirror (confirmed: browsing the directory
lists actual files with real HTML, and a bogus filename/directory both
404, so it isn't a soft-200 catch-all). It holds one (occasionally a
couple of) recent JDK build per major -- JDK only, no JRE -- for majors
8, 11, 17, 21, 25, 26, and 27, using the exact same filenames as
`cdn.azul.com`. Every candidate this implies was individually
HEAD-confirmed against the vendor size (partial/rolling mirror, same
treatment as TUNA/NJU/USTC in round 1): 101/101 confirmed. http
redirects (308) to https, so there's no plaintext path on this host.

The required <=60MB hash sample could not be completed: this host only
carries full JDK archives/installers, and the smallest matched file is
87,790,094 bytes -- over budget. Recorded as HEAD-confirmed
(Content-Length match), not hash-verified, in `mirrors.json`.

One of the 101 matches surfaced a **pre-existing data-quality issue**,
not a mirror problem: `zulu17.64.17-ca-jdk17.0.18-c2-linux_aarch32hf.tar.gz`
(major 17) has `size: 183202000` in `releases.json` -- a stale,
API-rounded value that `fix_zulu_sizes.py` (the earlier fix for exactly
this rounding bug) apparently missed for this entry. The real
`cdn.azul.com` Content-Length is 183201984. d10.injdk.cn's file matches
the *real* size exactly, so it was still recorded as a confirmed mirror;
the stale `size` field was left as-is since `add_mirrors.py` only
appends to `mirrors[]`/`checksum_corroboration[]` and this pass's rules
say never to edit `releases.json` directly. Flagging here for whoever
next runs `fix_zulu_sizes.py` -- there may be other entries with the same
leftover rounding.

### Leads tried and rejected

- **Temurin GitHub-asset mirrors named in the task**: ISCAS
  (`mirror.iscas.ac.cn`) has a real `github-release/` mirror directory,
  but it only carries a fixed allow-list of projects (FreeCAD, Homebrew,
  llvm, graalvm, ibmruntimes/Semeru, etc) -- no `adoptium` entry.
  SJTUG/SJTU (`mirrors.sjtug.sjtu.edu.cn`, `mirror.sjtu.edu.cn`) return
  403 "Cerberus-Sec: BLOCKED" on every path including the bare root, with
  both a plain and a full browser User-Agent -- not reachable from here,
  whatever it's gating on. HUST (`mirrors.hust.edu.cn`) is a Docusaurus
  documentation site *about* a mirror, not a file host itself, and its
  linked real mirror (`mirrors.hust.college`) wasn't tried further since
  the task's target was HUST specifically. `packages.adoptium.net/artifactory`
  (its own Artifactory instance) only exposes `apk`, `deb`, `jmc-libs(-snapshots)`
  and `rpm` repositories via its API -- no generic tarball repo, and the
  catalog has no deb/rpm Temurin entries to match against anyway (Temurin
  entries here are tar.gz/zip/msi/pkg only). `download.eclipse.org` has
  no adoptium-related directory at all.
- **Huawei Cloud** (`mirrors.huaweicloud.com/java/`, `/zulu/`): `/zulu/`
  is the same JS SPA + WAF portal round 1 already rejected. `/java/` (not
  tried in round 1) turned out to be a real Artifactory listing, but it
  only holds `jdk/`, i.e. `jdk.java.net` community OpenJDK build tags
  (`10.0.1+10`, `11+28`, ...) last modified in 2021 -- a different
  vendor, stale, and already out of scope per round 1's reasoning for the
  same content. Tencent Cloud mirrors, injdk.cn's own homepage otherwise,
  and Huawei's `repo.huaweicloud.com/java/` were checked and don't carry
  Zulu/Temurin either.
- **`api.azul.com` download URLs**: every package's `download_url` in
  the metadata API is `cdn.azul.com/zulu/bin/...` -- no alternate host
  embedded in the API response itself (static.azul.com was found via
  direct hostname guessing from the task's own hint, not from the API).
  `repos.azul.com/zulu/` -- 404, doesn't exist.
- **foojay Disco API** (`api.foojay.io/disco/v3.0/packages`): its
  `pkg_download_redirect` link is a 301 straight to `cdn.azul.com` (for
  Zulu) -- a redirect-only wrapper, not an independent host, per this
  hunt's own rule that redirect-only hosts don't count.
- **`joschi/java-metadata`**: purely a metadata API (OpenAPI/Swagger
  spec), hosts no binaries at all, as its name suggests.
- **JetBrains**: `jdk.download.jetbrains.com` does not resolve in DNS at
  all from here -- not a live host. `cache-redirector.jetbrains.com`
  resolves and serves a generic redirector page pointing to an internal
  TeamCity-hosted redirect table (`teamcity-it.intellij.net/...`) that
  itself required auth (302 to a login) and wasn't reachable to see
  whether it proxies Adoptium/Zulu at all; a guessed path
  (`.../github.com/adoptium/temurin8-binaries/...`) 404'd. Given JBR
  (JetBrains Runtime) is a different, patched build per the task's own
  note, and no evidence surfaced that this redirector also proxies
  vanilla vendor JDKs, this lead is treated as a dead end rather than
  worth further guessing.
"""


def main():
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        mirrors_path = JAVA / "mirrors.json"
        mirrors = json.loads(mirrors_path.read_text())
        existing_names = {m.get("name") for m in mirrors}
        added = 0
        for m in NEW_MIRRORS:
            if m["name"] not in existing_names:
                mirrors.append(m)
                added += 1
        fd, tmp = tempfile.mkstemp(dir=mirrors_path.parent, prefix=mirrors_path.name, suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(mirrors, f, indent=1, ensure_ascii=False)
        os.replace(tmp, mirrors_path)
        print(f"mirrors.json: appended {added} new entries ({len(mirrors)} total)")

        notes_path = JAVA / "NOTES.md"
        notes = notes_path.read_text()
        marker = "## Mirror hunt round 2 (2026-09-17)"
        if marker in notes:
            print("NOTES.md: round 2 section already present, not duplicating")
        else:
            new_notes = notes.rstrip("\n") + "\n" + NOTES_ADDITION
            fd, tmp = tempfile.mkstemp(dir=notes_path.parent, prefix=notes_path.name, suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                f.write(new_notes)
            os.replace(tmp, notes_path)
            print("NOTES.md: appended round 2 section")


if __name__ == "__main__":
    main()
