#!/usr/bin/env python3
"""Append this hunt's findings to nim/mirrors.json, cc/mirrors.json and both
NOTES.md, under catalog/.write.lock, atomically (temp file + rename).
Idempotent: re-running replaces this hunt's own records rather than duplicating.
"""
import fcntl, json, os, tempfile
from pathlib import Path

CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
LOCK = CAT / ".write.lock"
D = "2026-09-20"
TAG = "Mirror hunt round 3 (2026-09-20, hash-addressed / distro-archive pass)"

NIM_CONFIRMED = [
 {"host": "snapshot.debian.org", "region": "global (Debian Project, hosted in the EU)",
  "operator": "Debian Project",
  "url_template": "https://snapshot.debian.org/file/<sha1-of-file>  (http:// works identically)",
  "protocols": {"https": "works", "http": "works (same bytes, verified by full download)"},
  "full_or_partial": "partial -- Debian's permanent archive of every source file it has ever shipped, so unlike a distro distfiles cache it is never pruned; but it only helps where Debian shipped the PRISTINE upstream tarball. For nim that is 0.12.0, 0.13.0, 0.15.0, 0.15.2, 0.16.0, 0.17.2 and 2.2.12. From 0.18.0 to 2.2.10 Debian's nim_X.orig.tar.xz is a repacked git export (30-130 MB vs. upstream's 3-10 MB) and was rejected on size, not assumed equivalent.",
  "confirmed_by": "snapshot.debian.org's /mr/package/nim/<version>/srcfiles?fileinfo=1 API was read for all 37 upstream versions present in both Debian and the catalogue; the 7 whose .orig.tar.xz size equalled our vendor size were then ALL downloaded in full and their sha256 compared with the sha256 of the same file downloaded from nim-lang.org in the same pass -- 7/7 byte-identical. For the 3 that carry a vendor checksum (0.16.0, 0.17.2, 2.2.12) the vendor download also matched the catalogue's recorded sha256 exactly. The file name differs from the vendor's, which is why only a hash match was accepted (MIRROR-HUNT-2 rule). Bogus all-zero sha1 404s.",
  "sample_files": ["nim_0.12.0.orig.tar.xz", "nim_0.13.0.orig.tar.xz", "nim_0.15.0.orig.tar.xz",
                   "nim_0.15.2.orig.tar.xz", "nim_0.16.0.orig.tar.xz", "nim_0.17.2.orig.tar.xz",
                   "nim_2.2.12.orig.tar.xz"],
  "hash_verified_sample": "all 7 (2.9-10.3 MB each) downloaded in full and sha256-matched against the vendor's own file; nim_0.15.0.orig.tar.xz additionally re-downloaded over plain http and matched; deleted after",
  "entries_covered": 7, "date_checked": D,
  "note": "The only mirror found anywhere for nim 0.12.0, 0.13.0, 0.15.0 and 0.15.2, and the only one at all for 0.15.0."},

 {"host": "deb.debian.org", "region": "global (Fastly/CloudFront-fronted Debian CDN)",
  "operator": "Debian Project",
  "url_template": "http://deb.debian.org/debian/pool/main/n/nim/nim_<version>.orig.tar.xz (https also works)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial -- the live Debian pool holds only the currently-packaged version (2.2.12)",
  "confirmed_by": "HEAD Content-Length == vendor size over http and https; bogus pool filename 404s; the file was downloaded in full over plain http and its sha256 matched the catalogue's vendor checksum exactly",
  "sample_files": ["nim_2.2.12.orig.tar.xz"],
  "hash_verified_sample": "nim_2.2.12.orig.tar.xz (10,259,940 B, http) -- sha256 2639a06a...1e5a56a, exact match; deleted after",
  "entries_covered": 1, "date_checked": D,
  "note": "This path is carried by the whole worldwide Debian mirror network (ftp.<cc>.debian.org and hundreds of university mirrors), nearly all of which serve it over plain http; only the CDN hostname was recorded here to keep the per-entry mirror list short."},

 {"host": "archive.debian.org", "region": "global (Debian historical archive)",
  "operator": "Debian Project",
  "url_template": "http://archive.debian.org/debian/pool/main/n/nim/nim_<version>.orig.tar.xz (https also works)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial -- only versions still referenced by an end-of-life Debian suite (nim 0.16.0 from stretch)",
  "confirmed_by": "HEAD size match over http and https; bogus pool filename 404s; full download, sha256 matched the catalogue's vendor checksum",
  "sample_files": ["nim_0.16.0.orig.tar.xz"],
  "hash_verified_sample": "nim_0.16.0.orig.tar.xz (2,907,076 B, http) -- sha256 9e199823...65c5167, exact match; deleted after",
  "entries_covered": 1, "date_checked": D},

 {"host": "archive.ubuntu.com", "region": "global (Canonical, UK)", "operator": "Canonical Ltd",
  "url_template": "http://archive.ubuntu.com/ubuntu/pool/universe/n/nim/nim_<version>.orig.tar.xz (https also works)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial -- only versions still referenced by a supported Ubuntu release",
  "confirmed_by": "HEAD size match over http and https on both candidates; bogus pool filename 404s; one full download over http, sha256 matched the vendor file byte-for-byte",
  "sample_files": ["nim_0.12.0.orig.tar.xz", "nim_0.17.2.orig.tar.xz"],
  "hash_verified_sample": "nim_0.12.0.orig.tar.xz (3,091,564 B, http) -- sha256 0fb86013...c875235, equal to the vendor file's; deleted after",
  "entries_covered": 2, "date_checked": D},

 {"host": "old-releases.ubuntu.com", "region": "global (Canonical, UK)", "operator": "Canonical Ltd",
  "url_template": "http://old-releases.ubuntu.com/ubuntu/pool/universe/n/nim/nim_<version>.orig.tar.xz (https also works)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial -- the archive of end-of-life Ubuntu releases; deeper historically than archive.ubuntu.com",
  "confirmed_by": "HEAD size match over http and https on all 3 candidates; bogus pool filename 404s; one full download over http, sha256 matched the vendor file byte-for-byte",
  "sample_files": ["nim_0.13.0.orig.tar.xz", "nim_0.15.2.orig.tar.xz", "nim_0.17.2.orig.tar.xz"],
  "hash_verified_sample": "nim_0.13.0.orig.tar.xz (3,145,360 B, http) -- sha256 cd61f5e5...48cb1a9, equal to the vendor file's; deleted after",
  "entries_covered": 3, "date_checked": D},

 {"host": "ports.ubuntu.com", "region": "global (Canonical, UK)", "operator": "Canonical Ltd",
  "url_template": "http://ports.ubuntu.com/ubuntu-ports/pool/universe/n/nim/nim_<version>.orig.tar.xz (https also works)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial -- Ubuntu's non-x86 port archive; carries the same source pool, sometimes for longer than archive.ubuntu.com",
  "confirmed_by": "HEAD size match over http and https on both candidates; bogus pool filename 404s; one full download over http, sha256 matched the catalogue's vendor checksum",
  "sample_files": ["nim_0.12.0.orig.tar.xz", "nim_0.17.2.orig.tar.xz"],
  "hash_verified_sample": "nim_0.17.2.orig.tar.xz (4,083,084 B, http) -- sha256 aaff1b50...7ec82bd, exact match against the vendor checksum; deleted after",
  "entries_covered": 2, "date_checked": D},

 {"host": "ftp.netbsd.org", "region": "global (The NetBSD Foundation, US)",
  "operator": "The NetBSD Foundation (pkgsrc distfiles)",
  "url_template": "http://ftp.netbsd.org/pub/pkgsrc/distfiles/<filename> (https also works)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial -- flat layout (pkgsrc lang/nim sets no DIST_SUBDIR) and pruned to the currently-packaged version only: all 112 nim source filenames were probed and exactly one (nim-2.0.4.tar.xz) is present",
  "confirmed_by": "pkgsrc lang/nim's distinfo (BLAKE2s + SHA512 + Size) read from NetBSD/pkgsrc; HEAD size match live over http and https; bogus filename 404s with a real bozohttpd 404 body; full download over http, sha256 matched the catalogue's vendor checksum exactly",
  "sample_files": ["nim-2.0.4.tar.xz"],
  "hash_verified_sample": "nim-2.0.4.tar.xz (7,620,508 B, http) -- sha256 71526bd0...cbe3f09, exact match; deleted after",
  "entries_covered": 1, "date_checked": D},
{"host": "Gentoo distfiles mirror network (9 curated institutional hosts)",
  "region": "Africa, Asia, Oceania, South America, North America, Europe",
  "operator": "University of the Free State (ZA), JAIST (JP), AARNet (AU), C3SL/UFPR (BR), MIT (US), University of Waterloo CSC (CA), Lysator/Linkoping University (SE), The UK Mirror Service/University of Kent (GB), SNT/Universiteit Twente (NL)",
  "url_template": "http://<mirror-root>/distfiles/<blake2b(filename)[:2]>/<filename>  -- roots: http://mirror.ufs.ac.za/gentoo/, http://ftp.jaist.ac.jp/pub/Linux/Gentoo/, http://mirror.aarnet.edu.au/pub/gentoo/, http://gentoo.c3sl.ufpr.br/, http://mirrors.mit.edu/gentoo-distfiles/, http://mirror.csclub.uwaterloo.ca/gentoo-distfiles/, http://ftp.lysator.liu.se/gentoo/, http://www.mirrorservice.org/sites/distfiles.gentoo.org/, http://ftp.snt.utwente.nl/pub/os/linux/gentoo/",
  "protocols": {"https": "works on all nine (same path)", "http": "works on all nine -- this is why they were added; only the http URLs were applied, since distfiles.gentoo.org already covers these two files over https"},
  "full_or_partial": "partial -- same content as distfiles.gentoo.org, i.e. only the versions currently in the Gentoo tree (nim 2.2.10 and 2.2.12)",
  "confirmed_by": "All 273 reachable http/https roots on api.gentoo.org/mirrors/distfiles.xml were probed for both nim tarballs plus a bogus filename-hash control; 194 served both with an exact Content-Length match and a real 404 control. Adding all of them would put ~200 URLs on two entries, so nine university / NREN / research-network hosts, one or two per region, were selected (gentoo_curated.py). Each of the nine then had nim-2.2.10.tar.xz downloaded IN FULL over plain http and its sha256 checked.",
  "sample_files": ["nim-2.2.10.tar.xz", "nim-2.2.12.tar.xz"],
  "hash_verified_sample": "nim-2.2.10.tar.xz (8,287,652 B) downloaded in full over http from all nine hosts; sha256 matched the vendor checksum on 9/9; deleted after",
  "entries_covered": 2, "date_checked": D,
  "note": "Adds no new entries (both were already mirrored by distfiles.gentoo.org over https); its value is geographic spread and, for nim 2.2.10, the only plain-http source that exists. The full 194-host result is in package-managers/round2/nim-cc-hash-hunt/gentoo_network.json if more are ever wanted."},
]

NIM_REJECTED = [
 {"host": "archive.softwareheritage.org",
  "url_template": "https://archive.softwareheritage.org/api/1/content/sha256:<hex>/",
  "reason": "Soft-200 catch-all from this environment: every request, including a bogus all-zero sha256 control, returns HTTP 200 with an 'Anubis' JavaScript bot challenge page ('Making sure you're not a bot!') instead of the API's JSON. No scripted client gets past it, so nothing about SWH's actual holdings could be established. Rejected on the same grounds as round 2's Fedora lookaside and Huawei Cloud cases -- blocked, not proven absent.",
  "date_checked": D},
 {"host": "ci.guix.gnu.org",
  "url_template": "https://ci.guix.gnu.org/file/<filename>/sha256/<nix-base32(sha256)>",
  "reason": "Guix's content-addressed file endpoint returns a clean 404 for every nim source tarball tried (nix-base32 keys computed locally from the catalogue's sha256). Guix's nim package builds from a git checkout, not from nim-lang.org's release tarball, so there is nothing for this cache to hold.",
  "date_checked": D},
 {"host": "distfiles.alpinelinux.org",
  "url_template": "https://distfiles.alpinelinux.org/distfiles/edge/<filename>",
  "reason": "All 112 nim source filenames probed, all clean 404 (the host itself is a confirmed mirror for other runtimes in round 2, so this is a real negative).",
  "date_checked": D},
 {"host": "sources.voidlinux.org",
  "url_template": "https://sources.voidlinux.org/nim-<version>/<filename>",
  "reason": "All 112 probed, all 404. Void's srcpkgs/nim template fetches github.com/nim-lang/Nim/archive/v<version>.tar.gz -- a GitHub-generated source archive, not nim-lang.org's release tarball, so different bytes; not a mirror of our files even where it has the version.",
  "date_checked": D},
 {"host": "snapshot.debian.org (nim 0.18.0 - 2.2.10)",
  "reason": "Debian's nim_<version>.orig.tar.xz for every release from 0.18.0 to 2.2.10 is a repack (a git export bundling csources/nimble, 30-130 MB against upstream's 3-10 MB). Rejected on size rather than assumed equivalent; only the 7 size-matching versions were carried forward and each of those was then hash-verified.",
  "date_checked": D},
 {"host": "nim-lang.org (alternate/mirror download list)",
  "reason": "The task asked whether nim-lang.org publishes one. It does not: install.html, download.html, install_unix.html and install_windows.html were all fetched and every download link points at nim-lang.org itself or github.com, with no occurrence of the word 'mirror'. The vendor also offers no plain-http path -- http://nim-lang.org/download/... 301s to https (Cloudflare).",
  "date_checked": D},
]

CC_CONFIRMED = [
 {"runtime": "gcc", "name": "Nix hash-addressed fallback tarball cache", "host": "tarballs.nixos.org",
  "region": "global (Fastly/Varnish-fronted)", "operator": "NixOS Foundation (Hydra)",
  "url_template": "https://tarballs.nixos.org/sha256/<sha256-hex>  (http:// works; both 301 to the canonical sha512/<hex> path)",
  "protocols": {"https": "works", "http": "works"},
  "full_or_partial": "partial fallback cache -- 5 of the 13 gcc source tarballs are present (4.9.4, 5.5.0, 6.5.0, 7.5.0, 15.3.0)",
  "confirmed_on": ["gcc-4.9.4.tar.bz2", "gcc-5.5.0.tar.xz", "gcc-6.5.0.tar.xz", "gcc-7.5.0.tar.xz", "gcc-15.3.0.tar.xz"],
  "method": "GCC publishes no checksum, so the lookup key came from the runtimes store's own locally-computed pins (store/sha256-local.json). tarballs.nixos.org is content-addressed -- the key IS the file's sha256 -- so a 301 is definitionally the same bytes; a bogus all-zero sha256 404s. All 84 cc/nim entries that have such a local pin were swept; 5 resolved.",
  "hash_verified_sample": "gcc-7.5.0.tar.xz (62,783,088 B = 59.9 MiB, just under the 60 MB cap) downloaded in full over PLAIN HTTP from this host; sha256 b81946e7...89ee661, exact match against the store's pin. Deleted after.",
  "entries_covered": 5, "date_checked": D,
  "note": "Fills exactly the hole Gentoo distfiles could not: 4.9.4/5.5.0/6.5.0/7.5.0 had been pruned from the Gentoo tree, so they had no corroborating hash at all. Nix's canonical sha512 path for each is now recorded as checksum_corroboration."},

 {"runtime": "llvm", "name": "BFSU (Beijing Foreign Studies University) github-release mirror",
  "host": "mirrors.bfsu.edu.cn", "region": "China", "operator": "Beijing Foreign Studies University",
  "base": "https://mirrors.bfsu.edu.cn/github-release/",
  "covers": ["llvm/llvm-project (only the newest tagged release, currently llvmorg-23.1.1, under both 'LLVM 23.1.1/' and 'LatestRelease/')"],
  "does_not_cover": "brechtsanders/winlibs_mingw and skeeto/w64devkit -- both 404 at the github-release root",
  "protocols": {"https": "works", "http": "301s to https, so effectively https only"},
  "full_or_partial": "partial -- a rolling one-release window, applied per entry only, never by template",
  "method": "Directory listing fetched live and matched to releases.json by exact file name, then each candidate HEAD-checked for an exact Content-Length match (4/4). Unlike the two sibling hosts tested in the same pass (see rejected), a real GET is served rather than challenged: the first 1 MiB of LLVM-23.1.1-Linux-X64.tar.xz fetched by Range request is byte-identical to GitHub's own asset.",
  "hash_verified_sample": "llvm_man_pages-23.1.1.tar.xz (357,052 B) downloaded in full and sha256-verified against GitHub's asset digest 66f368b2...708427349 -- exact match. The four catalogued 23.1.1 archives are 0.9-2.0 GB, over the sample cap, so the same stand-in used for the NJU entry applies.",
  "confirmed_count": "4/4 llvm-23.1.1 releases.json entries (windows/amd64 msvc, linux/amd64, linux/arm64, macos/arm64)",
  "entries_covered": 4, "date_checked": D,
  "note": "Redundancy only: all 4 entries were already mirrored by mirror.nju.edu.cn. Added as a second independent institution for the same files."},
]

CC_REJECTED = [
 {"candidate": "https://mirrors.nyist.edu.cn/github-release/ (llvm/llvm-project)",
  "reason": "LOOKS confirmable and is not -- worth recording as a method note. HEAD returns 200 with the exact vendor Content-Length over both https and plain http, and a bogus path in the same directory 404s, so a HEAD-only check would have wrongly confirmed it. A real GET 302s to /testpow/?url=... , an nginx proof-of-work bot challenge that no plain HTTP client passes. Not added. (Same for the directory listings, which do enumerate llvm/llvm-project correctly.)",
  "checked_at": D},
 {"candidate": "https://mirror.lzu.edu.cn/github-release/ (llvm/llvm-project, brechtsanders/winlibs_mingw)",
  "reason": "The only host found anywhere that lists BOTH llvm/llvm-project and brechtsanders/winlibs_mingw (the last ~9 WinLibs tags, GCC 16.1.0/16.2.0), but every file request -- HEAD included -- 302s to the same /testpow/ proof-of-work challenge. 0 of 58 candidates retrievable. Blocked, not proven absent; worth retrying from a client that can solve the challenge.",
  "checked_at": D},
 {"candidate": "https://mirrors.huaweicloud.com/github-release/llvm/llvm-project/",
  "reason": "Soft-200 catch-all: the directory 200s, but so does a bogus release directory AND a bogus file name, and a HEAD on a real .tar.xz returns Content-Type: text/html (the Angular portal shell) rather than the archive. Same verdict as the /nim/ path in round 2.",
  "checked_at": D},
 {"candidate": "CN mirrors probed for a github-release tree and found not to have one",
  "reason": "mirrors.cloud.tencent.com 404, mirrors.aliyun.com 404, mirrors.zju.edu.cn 404, mirrors.pku.edu.cn 404, mirrors.hit.edu.cn 404, mirrors.xjtu.edu.cn 404, mirrors.jlu.edu.cn 302-loops to itself, mirrors.sustech.edu.cn 302s to mirrors.tuna.tsinghua.edu.cn (no independent copy), mirrors.cqupt.edu.cn 503, mirror.redrock.team 301s to cqupt, mirror.sjtu.edu.cn answers 'No route for github-release' (its mirror-intel backend is S3-like and not browsable), mirrors.chzu.edu.cn does not resolve.",
  "checked_at": D},
 {"candidate": "skeeto/w64devkit and brechtsanders/winlibs_mingw on the newly-found hosts",
  "reason": "404 at github-release/skeeto/ and github-release/brechtsanders/ on mirrors.bfsu.edu.cn and mirrors.nyist.edu.cn (and, re-checked, mirror.iscas.ac.cn). Only mirror.lzu.edu.cn has winlibs at all and it is challenge-blocked. After three rounds, w64devkit still has no mirror anywhere outside its canonical GitHub release.",
  "checked_at": D},
 {"candidate": "Gentoo distfiles for any cc BINARY entry",
  "reason": "llvm-core/llvm's Manifest holds only llvm-project-<ver>.src.tar.xz source tarballs (plus manpage and patchset archives) -- Gentoo builds LLVM from source and carries none of the clang+llvm / LLVM-*.exe prebuilt release assets the catalogue records. The 147-host Gentoo distfiles mirror network therefore cannot help any unmirrored cc entry.",
  "checked_at": D},
 {"candidate": "archive.softwareheritage.org (hash-indexed content lookup)",
  "reason": "Same Anubis soft-200 bot challenge as recorded under nim: every request including a bogus all-zero sha256 control returns an HTML challenge with HTTP 200. Unreachable from this environment.",
  "checked_at": D},
]


def atomic_write_text(path, text):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def merge(lst, new, keyfields):
    def key(x):
        return tuple(x.get(k) for k in keyfields)
    have = {key(x) for x in new}
    return [x for x in lst if key(x) not in have] + new


def main(nim_notes, cc_notes):
    with open(LOCK, "a+") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            p = CAT / "nim" / "mirrors.json"
            d = json.loads(p.read_text())
            d["confirmed"] = merge(d.get("confirmed", []), NIM_CONFIRMED, ("host",))
            d["rejected"] = merge(d.get("rejected", []), NIM_REJECTED, ("host",))
            atomic_write_text(p, json.dumps(d, indent=1, ensure_ascii=False) + "\n")

            p = CAT / "cc" / "mirrors.json"
            d = json.loads(p.read_text())
            d["confirmed"] = merge(d.get("confirmed", []), CC_CONFIRMED, ("host", "name"))
            d["rejected"] = merge(d.get("rejected", []), CC_REJECTED, ("candidate",))
            atomic_write_text(p, json.dumps(d, indent=1, ensure_ascii=False) + "\n")

            for folder, body in (("nim", nim_notes), ("cc", cc_notes)):
                p = CAT / folder / "NOTES.md"
                t = p.read_text()
                marker = "\n## " + TAG + "\n"
                if marker in t:
                    t = t[:t.index(marker)]
                atomic_write_text(p, t.rstrip("\n") + "\n\n" + marker + body)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)
    print("mirrors.json and NOTES.md updated for nim and cc")
