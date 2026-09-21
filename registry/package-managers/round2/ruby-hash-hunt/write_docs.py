#!/usr/bin/env python3
"""Write the round-2 hash-hunt findings into ruby/mirrors.json and ruby/NOTES.md.

Takes catalog/.write.lock (fcntl.flock) first, re-reads both files, then writes
each atomically (temp file + rename), because several agents run at once.
Idempotent: re-running replaces the sections it owns rather than duplicating.
"""
import fcntl
import json
import os
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
RUBY = CATALOG / "ruby"
LOCK = CATALOG / ".write.lock"
D = "2026-09-20"
MARK = "## Mirror hunt round 2b: search by hash (2026-09-20)"


def atomic_write_text(path, text):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def atomic_write_json(path, data):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def counts():
    e = json.loads((RUBY / "releases.json").read_text())
    n = {}
    for x in e:
        for m in x.get("mirrors") or []:
            h = m.split("/")[2]
            n[h] = n.get(h, 0) + 1
    return n


UA_NOTE = ("Reached with a NON-browser User-Agent. MIRROR-HUNT.md's advice to use a browser-like UA is "
           "actively counterproductive on this host: a 'Mozilla/...' UA gets a bot-check or a block, a plain "
           "'installer-builder-catalog/1.0' UA is waved through.")


def new_confirmed(n):
    return [
        {
            "host": "mirror.sjtu.edu.cn",
            "url_template": "https://mirror.sjtu.edu.cn/github-release/oneclick/rubyinstaller2/releases/download/<tag>/<file>  (301s, within SJTU, to https://s3.jcloud.sjtu.edu.cn/899a892efef34b1b944a19981040f55b-oss01/github-release/<same path>)",
            "applies_to": "RubyInstaller2 Windows assets only",
            "region": "China (Shanghai)",
            "operator": "Shanghai Jiao Tong University / SJTUG mirror service",
            "protocols": {
                "https": "works (with a plain UA; see ua_note)",
                "http": "308s to https -- no plain-http bytes",
            },
            "full_or_partial": ("partial -- 213 of the 677 oneclick/rubyinstaller2 entries, covering 29 Ruby versions from "
                                "RubyInstaller-3.1.7-1 upward (nothing older). Of the rest, 336 404 outright and 128 are "
                                "proxied on demand to release-assets.githubusercontent.com -- GitHub's own bytes over SJTU's "
                                "hostname, so NOT a mirror; those 128 were excluded. SJTU holds none of oneclick/rubyinstaller "
                                "(v1), ruby/ruby-builder, spinel-coop/rv-ruby or Homebrew/homebrew-portable-ruby: all 886 of "
                                "those entries were HEAD-checked individually and all 886 proxy through to GitHub."),
            "confirmed_by": ("per-entry HEAD following redirects: final host must be s3.jcloud.sjtu.edu.cn (not github.com, not "
                             "release-assets.githubusercontent.com) and final Content-Length must equal the catalogue's vendor "
                             "size -- 213/213 matched, 0 size mismatches. Bogus tag RubyInstaller-9.9.9-1 404s."),
            "hash_verified_sample": ("rubyinstaller-4.0.7-1-x64.7z (17,742,012 bytes) downloaded in full from SJTU and "
                                     "sha256-verified against releases.json (7a9be96d...0474f); deleted after verification"),
            "ua_note": ("Round 2 recorded this host as unconfirmable behind SJTUG's 'Cerberus' WASM proof-of-work. That was an "
                        "artefact of the browser-like User-Agent: with a plain UA the response carries 'cerberus-sec: DISABLED' "
                        "and no challenge at all. No challenge was solved or circumvented."),
            "entries_covered": n.get("mirror.sjtu.edu.cn", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass)",
        },
        {
            "host": "mirrors.ustc.edu.cn",
            "url_template": "http://mirrors.ustc.edu.cn/homebrew-bottles/bottles-portable-ruby/<file>  (https works on the identical path)",
            "applies_to": "Homebrew/homebrew-portable-ruby bottles (the catalogue's macos 'homebrew-portable' variant)",
            "region": "China (Hefei)",
            "operator": "University of Science and Technology of China",
            "protocols": {"https": "works", "http": "works -- same path, same bytes (hash-verified)"},
            "full_or_partial": "partial -- exactly the 2 portable-ruby 3.4.5 bottles the catalogue carries (el_capitan x86_64, arm64_big_sur); older portable-ruby versions are not in the catalogue",
            "confirmed_by": ("HEAD with redirects disabled over both http and https, Content-Length == vendor size on both files; "
                             "bogus filename portable-ruby-3.4.5.NOPE.bottle.tar.gz 404s"),
            "hash_verified_sample": ("portable-ruby-3.4.5.el_capitan.bottle.tar.gz (11,730,364 bytes) downloaded in full over "
                                     "PLAIN HTTP and sha256-verified against the vendor checksum (0c78b38f...98cf); deleted after"),
            "ua_note": ("With a browser-like UA this host answers 200 + an HTML SPA page for EVERY path including bogus ones -- "
                        "a soft-200 catch-all that a bogus-path control correctly rejects. With a plain UA it serves the real "
                        "file and 404s the bogus path. " + UA_NOTE),
            "entries_covered": n.get("mirrors.ustc.edu.cn", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass)",
        },
        {
            "host": "mirrors.tuna.tsinghua.edu.cn",
            "url_template": "http://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/bottles-portable-ruby/<file>  (https works on the identical path)",
            "applies_to": "Homebrew/homebrew-portable-ruby bottles",
            "region": "China (Beijing)",
            "operator": "Tsinghua University TUNA Association",
            "protocols": {"https": "works", "http": "works -- same path, same bytes (hash-verified)"},
            "full_or_partial": "partial -- the 2 portable-ruby 3.4.5 bottles the catalogue carries",
            "confirmed_by": "HEAD with redirects disabled over both http and https, Content-Length == vendor size on both files; bogus filename 404s",
            "hash_verified_sample": ("portable-ruby-3.4.5.arm64_big_sur.bottle.tar.gz (12,126,160 bytes) sha256-verified against the "
                                     "vendor checksum (20fa6578...830a) over https, and portable-ruby-3.4.5.el_capitan.bottle.tar.gz "
                                     "(11,730,364 bytes) over plain http; both deleted after"),
            "ua_note": ("With a browser-like UA every GET (even a directory listing) returns TUNA's 403 'your subnet has sent "
                        "abnormal requests' page while HEAD still succeeds -- which is what made round 1 and round 2 record this "
                        "host as blocked. " + UA_NOTE),
            "entries_covered": n.get("mirrors.tuna.tsinghua.edu.cn", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass)",
        },
        {
            "host": "mirrors.bfsu.edu.cn",
            "url_template": "http://mirrors.bfsu.edu.cn/homebrew-bottles/bottles-portable-ruby/<file>  (https works on the identical path)",
            "applies_to": "Homebrew/homebrew-portable-ruby bottles",
            "region": "China (Beijing)",
            "operator": "Beijing Foreign Studies University",
            "protocols": {"https": "works", "http": "works -- same path, same bytes (hash-verified)"},
            "full_or_partial": "partial -- the 2 portable-ruby 3.4.5 bottles the catalogue carries",
            "confirmed_by": ("HEAD with redirects disabled over both http and https, Content-Length == vendor size on both files; "
                             "a bogus filename falls through to a 302 at the long-dead homebrew.bintray.com rather than a soft 200"),
            "hash_verified_sample": ("portable-ruby-3.4.5.el_capitan.bottle.tar.gz (11,730,364 bytes) downloaded in full over https "
                                     "AND again over plain http, sha256 matched the vendor checksum (0c78b38f...98cf) both times; deleted after"),
            "ua_note": "Same browser-UA 403 as TUNA (BFSU runs the same mirror software and policy). " + UA_NOTE,
            "entries_covered": n.get("mirrors.bfsu.edu.cn", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass)",
        },
        {
            "host": "distcache.freebsd.org",
            "url_template": "http://distcache.freebsd.org/ports-distfiles/ruby/<file>",
            "applies_to": "source tarballs (cache.ruby-lang.org tree) only",
            "region": "global (Fastly-fronted)",
            "operator": "FreeBSD ports distfiles cache",
            "protocols": {"https": "fails from this environment (Fastly SNI/cert error, same as every other runtime hunted here)",
                          "http": "works"},
            "full_or_partial": ("partial -- lang/ruby* ports use DIST_SUBDIR=ruby, so the path is ports-distfiles/ruby/<file>. "
                                "All 237 source entries were HEAD-checked individually: 63 present and size-matched (2.4.9 through "
                                "4.0.4, i.e. everything the ports tree has held recently), 174 absent."),
            "confirmed_by": "per-entry HEAD with redirects disabled over http, Content-Length == vendor size on all 63; bogus path ruby/NOPE-9.9.9.tar.xz 404s",
            "hash_verified_sample": "ruby-2.7.7.tar.xz (12,101,804 bytes) downloaded in full over http and sha256-verified (b38dff2e...3e4c); deleted after",
            "entries_covered": n.get("distcache.freebsd.org", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass; 1 entry had already been added by the round-2 os-distro-caches pass)",
        },
        {
            "host": "cdn.netbsd.org",
            "url_template": "http://cdn.netbsd.org/pub/pkgsrc/distfiles/<file>   (ftp.netbsd.org serves the same tree; https works too)",
            "applies_to": "source tarballs only",
            "region": "global (NetBSD CDN)",
            "operator": "The NetBSD Foundation (pkgsrc distfiles)",
            "protocols": {"https": "works", "http": "works -- same path, same bytes (hash-verified)"},
            "full_or_partial": ("partial -- flat directory holding only what current pkgsrc lang/ruby* fetch. All 237 source entries "
                                "HEAD-checked individually: 7 present and size-matched (3.2.11, 3.3.11, 3.3.12, 3.4.9, 3.4.10, 4.0.5, "
                                "4.0.6), 230 absent."),
            "confirmed_by": "per-entry HEAD with redirects disabled, Content-Length == vendor size on all 7; bogus path NOPE-9.9.9.tar.xz 404s",
            "hash_verified_sample": "ruby-3.2.11.tar.xz (14,695,828 bytes) downloaded in full over PLAIN HTTP and sha256-verified (c13aec0c...63d2); deleted after",
            "entries_covered": n.get("cdn.netbsd.org", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass)",
        },
        {
            "host": "tarballs.nixos.org",
            "url_template": "https://tarballs.nixos.org/sha256/<the file's own sha256 hex>  (301s, same host, to /sha512/<hex>)",
            "applies_to": "source tarballs only",
            "region": "global (Fastly/Varnish-fronted)",
            "operator": "NixOS Hydra fallback tarball cache",
            "protocols": {"https": "works", "http": "301s to https -- no plain-http bytes"},
            "full_or_partial": ("partial -- content-addressed fallback cache holding whatever Hydra happened to build a fetchurl "
                                "derivation for. All 237 source entries probed by their own sha256: 34 present (1.8.4 through the "
                                "2.x line), 203 absent. Holds NONE of the 580 sha256-checksummed binary entries (see rejects)."),
            "confirmed_by": ("hash-addressed by construction -- the lookup key IS the file's sha256, so a hit is byte-identical by "
                             "definition; still HEAD-confirmed (Content-Length == vendor size on all 34) plus a full hash-verify. "
                             "Bogus all-zero sha256 404s."),
            "hash_verified_sample": "ruby-1.8.4.tar.gz (4,312,965 bytes) downloaded in full and sha256-verified (71432841...2930); deleted after",
            "entries_covered": n.get("tarballs.nixos.org", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass)",
        },
        {
            "host": "distfiles.gentoo.org",
            "url_template": "https://distfiles.gentoo.org/distfiles/<blake2b(filename)hex[:2]>/<filename>  (http works on the identical path)",
            "applies_to": "source tarballs only",
            "region": "global (CDN-backed)",
            "operator": "Gentoo Linux distfiles mirror",
            "protocols": {"https": "works", "http": "works"},
            "full_or_partial": ("partial -- only versions currently in the Gentoo tree (portage prunes distfiles for removed "
                                "ebuilds). All 237 source entries probed at their computed blake2b path: 9 present and size-matched "
                                "(3.2.10, 3.2.11, 3.3.11, 3.3.12, 3.4.9, 3.4.10, 4.0.3, 4.0.4, 4.0.6), 228 absent."),
            "confirmed_by": "per-entry HEAD with redirects disabled, Content-Length == vendor size on all 9; bogus filename's blake2b path 404s",
            "hash_verified_sample": "not re-verified this pass -- distfiles.gentoo.org was already a confirmed host in this catalogue (see nim/mirrors.json, sha256-verified sample) and 5 of these 9 Ruby entries were added by the round-2 os-distro-caches pass; this pass added the other 4",
            "entries_covered": n.get("distfiles.gentoo.org", 0),
            "date_checked": D,
            "found_in": "round 2b (hash-search pass; host first confirmed in round 2's os-distro-caches pass)",
        },
    ]


def swh_record(n, hits, probed, total):
    return {
        "host": "archive.softwareheritage.org",
        "url_template": "https://archive.softwareheritage.org/api/1/content/sha256:<the file's own sha256 hex>/raw/",
        "applies_to": "source tarballs only",
        "region": "France / global (Inria, under a UNESCO agreement)",
        "operator": "Software Heritage",
        "protocols": {"https": "works", "http": "302s to https -- no plain-http bytes"},
        "full_or_partial": (f"partial -- genuinely hash-indexed institutional archive. {probed} of the {total} source entries have "
                            f"been probed by their own sha256 so far ({hits} present, all with length == the catalogue's size); "
                            "coverage is concentrated in the OLD tarballs (the whole 1.8 line, most of 1.9, parts of 2.x), which is "
                            "exactly the range the catalogue records gaps for. Holds NONE of the binary entries (see rejects). "
                            "The remaining entries are unprobed only because the anonymous API allows 120 requests/hour; "
                            "package-managers/round2/ruby-hash-hunt/swh_probe.py is resumable and will finish them."),
        "confirmed_by": ("hash-addressed by construction (the lookup key is the file's sha256); the API's own 'length' field was "
                         "checked against the catalogue's size for every hit, and /raw/ was HEAD-checked for Content-Length. "
                         "A bogus all-zero sha256 returns NotFoundExc."),
        "hash_verified_sample": ("ruby-1.8.7-p374.tar.gz (4,903,749 bytes) downloaded in full from the /raw/ endpoint and "
                                 "sha256-verified against the vendor checksum (876eeeaa...5276c); deleted after"),
        "ua_note": ("archive.softwareheritage.org sits behind an Anubis bot check that challenges 'Mozilla/...' user agents and "
                    "lets plain automated clients straight through, so this host needs the plain UA too. No challenge was solved."),
        "entries_covered": n.get("archive.softwareheritage.org", 0),
        "date_checked": D,
        "found_in": "round 2b (hash-search pass)",
    }


REJECTED = [
    {"host": "tarballs.nixos.org (for the BINARY entries)",
     "candidate_url": "https://tarballs.nixos.org/sha256/<sha256 of a ruby-builder / RubyInstaller / rv-ruby / portable-ruby file>",
     "reason": "the headline hash search, and a clean negative: all 580 offerable entries that carry a sha256 were probed by hash, and every one 404s. The 17 files we hold locally were additionally probed by sha1 and md5 (34 more lookups, all 404). Nixpkgs builds Ruby from source, so Hydra never fetched any of these binaries.",
     "date_checked": D},
    {"host": "archive.softwareheritage.org (for the BINARY entries)",
     "candidate_url": "https://archive.softwareheritage.org/api/1/content/sha256:<hex>/",
     "reason": "28 stratified probes spanning oneclick/rubyinstaller2 (oldest and newest, x86/x64/arm), spinel-coop/rv-ruby, Homebrew/homebrew-portable-ruby, ruby/ruby-builder (linux and darwin, oldest and newest): 0 hits. SWH ingests source, not release binaries.",
     "date_checked": D},
    {"host": "mirrors.tuna.tsinghua.edu.cn, mirrors.bfsu.edu.cn, mirrors.ustc.edu.cn (github-release trees)",
     "candidate_url": "https://<host>/github-release/oneclick/rubyinstaller2/... and .../ruby/ruby-builder/...",
     "reason": "settles round 1's and round 2's inconclusive 403s: with a plain UA all three return a plain 404 for these paths. They genuinely do not carry either repo. (Their homebrew-bottles trees DO carry portable-ruby and are now confirmed mirrors -- see confirmed.)",
     "date_checked": D},
    {"host": "mirrors.pku.edu.cn, mirrors.zju.edu.cn, mirrors.hit.edu.cn, mirrors.xjtu.edu.cn, mirrors.nwafu.edu.cn, mirrors.jlu.edu.cn, mirrors.shanghaitech.edu.cn, mirror.lzu.edu.cn, mirrors.cqu.edu.cn, mirrors.cqupt.edu.cn / mirror.redrock.team, mirror.iscas.ac.cn, mirrors.hust.edu.cn, mirror.nyist.edu.cn, mirrors.nju.edu.cn, mirrors.aliyun.com, mirrors.163.com, mirrors.cloud.tencent.com",
     "candidate_url": "https://<host>/github-release/oneclick/rubyinstaller2/releases/download/<tag>/<file>",
     "reason": "swept for a github-release tree carrying rubyinstaller2; all 404 (or time out / 503). Re-checked with a plain UA where a bot gate was in the way (mirror.lzu.edu.cn's /testpow/ gate disappears with a plain UA and the file is simply not there). mirrors.nju.edu.cn still holds only the single newest release, as round 1 found.",
     "date_checked": D},
    {"host": "mirrors.sustech.edu.cn, mirrors.cernet.edu.cn",
     "candidate_url": "https://<host>/github-release/oneclick/rubyinstaller2/...",
     "reason": "redirect-only aggregators -- they 302 to mirrors.tuna.tsinghua.edu.cn and mirrors.bfsu.edu.cn respectively. Not independent copies.",
     "date_checked": D},
    {"host": "www.xs4all.nl / hipster.home.xs4all.nl",
     "candidate_url": "http://www.xs4all.nl/~hipster/lib/mirror/ruby/<major>/<file>",
     "reason": "the last untested host on ruby-lang.org's own mirror list. Dead: http 301s to https, https 302s to hipster.home.xs4all.nl, and that host 302s every path -- real files and bogus ones alike -- to a 'notxs4all' landing page. Nothing is served.",
     "date_checked": D},
    {"host": "ftp.jaist.ac.jp",
     "candidate_url": "https://ftp.jaist.ac.jp/pub/lang/ruby/<major>/<file>",
     "reason": "404 on both the /pub/lang/ruby/ and /pub/Ruby/ paths; JAIST no longer carries a Ruby tree (it is not on ruby-lang.org's mirror list either).",
     "date_checked": D},
    {"host": "sources.buildroot.net, downloads.yoctoproject.org/mirror/sources, sources.archlinux.org, sources.voidlinux.org, ftp.openbsd.org/cdn.openbsd.org distfiles",
     "candidate_url": "<host>/<flat or per-package path>/ruby-<version>.tar.xz",
     "reason": "flat upstream-source mirrors that were worth trying for the source tree; all 404 for Ruby (Buildroot has no ruby package in its source cache, Yocto's mirror does not carry these filenames, Arch and Void store Ruby under different names/paths, OpenBSD's ports do not mirror the Ruby tarball).",
     "date_checked": D},
    {"host": "gitcode.com / raw.gitcode.com",
     "candidate_url": "https://gitcode.com/ruby/ruby-builder/releases/download/toolcache/<file>",
     "reason": "401 on gitcode.com and a 302 to /404 on raw.gitcode.com; it does not carry this repo's release assets. (It would also have been a commercial GitHub-mirroring site rather than an institutional mirror.)",
     "date_checked": D},
    {"host": "mirror.sjtu.edu.cn (for ruby-builder, rubyinstaller v1, rv-ruby, portable-ruby)",
     "candidate_url": "https://mirror.sjtu.edu.cn/github-release/<owner>/<repo>/releases/download/<tag>/<file>",
     "reason": "all 886 entries for these four repos were HEAD-checked individually: every one is proxied on demand to release-assets.githubusercontent.com, i.e. GitHub's own bytes behind SJTU's hostname, not an independent copy. Same for the 128 rubyinstaller2 files SJTU does not hold. Only the 213 that 301 to SJTU's own s3.jcloud.sjtu.edu.cn were added.",
     "date_checked": D},
]

NOT_ADDED_OPERATOR_CALL = [
    {"host": "ghcr.io (GitHub Container Registry)",
     "candidate_url": "https://ghcr.io/v2/homebrew/portable-ruby/portable-ruby/blobs/sha256:<the file's own sha256>",
     "what_works": ("genuinely hash-addressed, and it serves the right bytes: with Homebrew's own static anonymous token "
                    "(`Authorization: Bearer QQ==`) a HEAD returns 200 with Content-Length 11,730,364, exactly the vendor size for "
                    "portable-ruby-3.4.5.el_capitan.bottle.tar.gz. Without the header it is a 401."),
     "why_not_added": ("two reasons, either of which seems disqualifying, so this is the operator's call. (1) It is not a plain URL: "
                       "a downloader must send an Authorization header, which fails SCHEMA.md's 'mirrors: URLs confirmed to serve "
                       "this file'. (2) ghcr.io is GitHub's own infrastructure, so it adds no independence from the vendor host the "
                       "entry already points at -- it would not help if GitHub were unreachable, which is the main thing a mirror is for."),
     "date_checked": D},
]


NOTES = """{mark}

Followed MIRROR-HUNT.md and MIRROR-HUNT-2.md, with the operator's specific
brief: **search by hash**. Scripts and raw evidence are under
`catalog/package-managers/round2/ruby-hash-hunt/` (see its README).

### The finding that mattered most is not about hashes

Three separate hosts that earlier rounds recorded as blocked, challenged or
broken are, in fact, working mirrors. All three were being defeated by
**MIRROR-HUNT.md's instruction to use a browser-like User-Agent**:

- `mirror.sjtu.edu.cn` -- round 2 recorded it as unreachable behind SJTUG's
  "Cerberus" WASM proof-of-work. With a plain `installer-builder-catalog/1.0`
  UA the response header is `cerberus-sec: DISABLED` and there is no challenge
  at all.
- `mirrors.tuna.tsinghua.edu.cn` and `mirrors.bfsu.edu.cn` -- rounds 1 and 2
  recorded an "access denied" / network-reputation block. With a browser UA,
  HEAD succeeds but *every* GET (even a directory listing) returns their 403
  "your subnet has sent abnormal requests" page. With a plain UA, GET works.
- `mirrors.ustc.edu.cn` -- with a browser UA it answers 200 + an HTML SPA page
  for every path including bogus ones (a soft-200 catch-all the bogus-path
  control correctly rejects). With a plain UA it serves the real file and 404s
  the bogus path.
- Same pattern on `archive.softwareheritage.org`, which sits behind an Anubis
  bot check that challenges "Mozilla/..." and waves plain clients through.

Nothing was solved or circumvented: these gates are configured to let honest,
self-identifying automated clients through and to challenge things pretending
to be browsers. **Suggest amending MIRROR-HUNT.md**: try the honest
`installer-builder-catalog` UA first and fall back to a browser UA only for
hosts that 403 it, not the other way round.

### The hash search itself: a clean negative for the binaries

The catalogue's binary entries are all GitHub Releases assets. Probing them by
hash gives an unambiguous answer:

- `tarballs.nixos.org/sha256/<hex>`: all **580** offerable entries that carry a
  sha256 probed -- 580/580 404. The 17 files we hold locally
  (`installer-builder-runtimes/ruby/...`) were additionally hashed with sha1 and
  md5 and probed at `/sha1/` and `/md5/` -- 34 more lookups, all 404.
- Software Heritage by sha256: 28 stratified probes across rubyinstaller2 (old
  and new, x86/x64/arm), rv-ruby, portable-ruby and ruby-builder (linux and
  darwin) -- 0 hits.

Neither cache ingests release binaries; nixpkgs builds Ruby from source and SWH
archives source. That is now recorded rather than assumed.

Where hash search *did* pay off is the **source tree**: `tarballs.nixos.org`
holds 34 of the 237 source tarballs and Software Heritage holds the old ones
(the whole 1.8 line, most of 1.9) that the frozen `ftp.fu-berlin.de` mirror is
otherwise the only second copy of.

### New confirmed mirrors

| host | tree | http | entries |
|---|---|---|---|
| `mirror.sjtu.edu.cn` | RubyInstaller2 Windows assets | no (308 to https) | {sjtu} |
| `mirrors.ustc.edu.cn` | homebrew portable-ruby bottles | **yes** | {ustc} |
| `mirrors.tuna.tsinghua.edu.cn` | homebrew portable-ruby bottles | **yes** | {tuna} |
| `mirrors.bfsu.edu.cn` | homebrew portable-ruby bottles | **yes** | {bfsu} |
| `distcache.freebsd.org` | source tarballs | **yes** (https fails) | {freebsd} |
| `cdn.netbsd.org` | source tarballs | **yes** | {netbsd} |
| `tarballs.nixos.org` | source tarballs (by sha256) | no (301 to https) | {nixos} |
| `distfiles.gentoo.org` | source tarballs (by blake2b path) | yes | {gentoo} |
| `archive.softwareheritage.org` | source tarballs (by sha256) | no (302 to https) | {swh} |

Per-host evidence, sample lists and hash-verified samples are in
`mirrors.json`. Every host above passed: plain-UA request, redirects disabled
(or followed with a final-host check, for SJTU), Content-Length == the
catalogue's vendor size on every entry it was applied to, a bogus-path control
that 404s, and at least one full download whose sha256 matched the vendor
checksum. All samples were deleted.

**SJTU is the first real mirror of RubyInstaller2 binaries in this catalogue.**
It holds 213 of the 677 rubyinstaller2 entries on its own object storage
(`s3.jcloud.sjtu.edu.cn`), covering 29 Ruby versions from RubyInstaller-3.1.7-1
upward. The 128 rubyinstaller2 files it does *not* hold are proxied on demand to
`release-assets.githubusercontent.com` -- GitHub's bytes behind SJTU's hostname,
not a copy -- and were excluded; so were all 886 entries of
`oneclick/rubyinstaller` (v1), `ruby/ruby-builder`, `spinel-coop/rv-ruby` and
`Homebrew/homebrew-portable-ruby`, every one of which proxies through.

### Still unmirrored, and now well evidenced

`ruby/ruby-builder`'s Linux tarballs (446 offerable entries) and
`spinel-coop/rv-ruby`'s macOS tarballs (84) have **no mirror anywhere** that
this pass could find, by hash or by name: not Nix, not Software Heritage, not
SJTU, not any of the ~20 other university/CDN github-release trees swept, not
Gentoo/FreeBSD/NetBSD/Buildroot/Yocto/Arch/Void, not gitcode. Same for
RubyInstaller 1 (1.8.7-2.3.3) and for every RubyInstaller2 release before
3.1.7-1. GitHub Releases remains the only distribution point for those.

### Not added, for the operator to decide

`ghcr.io`'s hash-addressed blob store *does* serve Homebrew's portable-ruby
bottles at `https://ghcr.io/v2/homebrew/portable-ruby/portable-ruby/blobs/sha256:<hex>`
with the correct size, using Homebrew's own static anonymous token
(`Authorization: Bearer QQ==`). It was not added because it needs a request
header rather than being a plain URL, and because ghcr.io is GitHub's own
infrastructure, so it adds no independence from the host the entry already
points at. See `mirrors.json` -> `hash_hunt_not_added`.

### Budget

3 of 4 permitted web searches unused (1 search; two direct WebFetches of known
URLs: rubyinstaller2 issue #209 and ruby-lang.org's mirror list). No bulk
Wayback lookups -- none at all, the background `wayback_retry.py` job owns that.
Downloads: 11 hash-verification samples between 4.3 MB and 17.7 MB (SJTU x1;
TUNA x2, BFSU x2, USTC x2 -- one over https and one over plain http each, so the
http claim is bytes, not an assumption; NetBSD x1 over http, FreeBSD x1 over
http, Nix x1, SWH x1), 137 MB in total, every one sha256-matched and deleted
after verification. Nothing over 60 MB; no runtime binaries downloaded for any
other purpose.

`extra_mirrors.py` still has to be re-run after every `scrape.py` run; these new
mirrors were written through `tools/add_mirrors.py` into `releases.json` and the
`download_plan*.json` files, which `scrape.py` rebuilds from scratch.
"""


def main():
    with open(LOCK, "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)
        n = counts()
        swh = json.loads((HERE / "swh_cache.json").read_text())
        src_total = 237
        src = {k: v for k, v in swh.items() if "cache.ruby-lang.org" in v["url"]}
        hits = sum(1 for v in src.values() if v.get("found"))

        m = json.loads((RUBY / "mirrors.json").read_text())
        keep = [c for c in m["confirmed"] if c.get("found_in", "").startswith("round 2b") is False]
        add = new_confirmed(n)
        if n.get("archive.softwareheritage.org"):
            add.append(swh_record(n, hits, len(src), src_total))
        m["confirmed"] = keep + add
        m["hash_hunt_rejected"] = REJECTED
        m["hash_hunt_not_added"] = NOT_ADDED_OPERATOR_CALL
        m["hash_hunt_ua_warning"] = (
            "Round 2b (2026-09-20): four hosts that earlier rounds recorded as blocked/challenged/soft-200 "
            "(mirror.sjtu.edu.cn, mirrors.tuna.tsinghua.edu.cn, mirrors.bfsu.edu.cn, mirrors.ustc.edu.cn, plus "
            "archive.softwareheritage.org) are reachable with a plain 'installer-builder-catalog/1.0' User-Agent "
            "and only blocked when sending a browser-like 'Mozilla/...' UA. MIRROR-HUNT.md's browser-UA advice "
            "costs real mirrors; try the honest UA first.")
        atomic_write_json(RUBY / "mirrors.json", m)

        notes = (RUBY / "NOTES.md").read_text()
        body = NOTES.format(
            mark=MARK,
            sjtu=n.get("mirror.sjtu.edu.cn", 0), ustc=n.get("mirrors.ustc.edu.cn", 0),
            tuna=n.get("mirrors.tuna.tsinghua.edu.cn", 0), bfsu=n.get("mirrors.bfsu.edu.cn", 0),
            freebsd=n.get("distcache.freebsd.org", 0), netbsd=n.get("cdn.netbsd.org", 0),
            nixos=n.get("tarballs.nixos.org", 0), gentoo=n.get("distfiles.gentoo.org", 0),
            swh=n.get("archive.softwareheritage.org", 0))
        if MARK in notes:
            notes = notes[:notes.index(MARK)].rstrip("\n") + "\n\n"
        else:
            notes = notes.rstrip("\n") + "\n\n\n"
        atomic_write_text(RUBY / "NOTES.md", notes + body)
        print("mirrors.json + NOTES.md written; per-host entry counts:",
              {k: v for k, v in sorted(n.items())})


if __name__ == "__main__":
    main()
