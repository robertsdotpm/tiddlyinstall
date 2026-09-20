#!/usr/bin/env python3
"""Rewrite java/mirrors.json and append to java/NOTES.md under catalog/.write.lock.

Idempotent: re-running replaces the round-3 records/section rather than
duplicating them.
"""
import fcntl, json, os, tempfile
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[3]
LOCK = CATALOG / ".write.lock"
MIRRORS = CATALOG / "java" / "mirrors.json"
NOTES = CATALOG / "java" / "NOTES.md"
DATE = "2026-09-20"
MARK = "## Mirror hunt round 3 -- search by hash (2026-09-20)"


def atomic_write(path, text):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


NEW = [
    {
        "runtime": "java",
        "vendor": "zulu",
        "name": "Azul CDN over plain http (cdn.azul.com / static.azul.com)",
        "region": "global (Cloudflare anycast)",
        "operator": "Azul Systems (the vendor itself; not a third party)",
        "url_template": [
            "http://cdn.azul.com/zulu/bin/{filename}",
            "http://cdn.azul.com/zulu-embedded/bin/{filename}",
            "http://static.azul.com/zulu/bin/{filename}",
            "http://static.azul.com/zulu-embedded/bin/{filename}",
        ],
        "protocols": {
            "https": "confirmed (already recorded for both hostnames)",
            "http": "works -- plain http, HTTP 200 with no redirect at all on both hostnames",
        },
        "coverage": "full -- all 7,720 zulu-jdk/zulu-jre entries, on both hostnames",
        "confirmed_by": (
            "probe.py azul-http: 16-file spread sample (majors 6-24, every os/arch/kind/format/"
            "variant combination, plus the catalogue's smallest and largest zulu files) HEADed on "
            "http://cdn.azul.com and http://static.azul.com with redirects disabled -- 32/32 "
            "returned HTTP 200 with Content-Length equal to the vendor size and no Location "
            "header. Bogus file paths on both hostnames over http returned 404 (not a soft-200 "
            "catch-all). Applied to every zulu entry by scheme/host substitution on the vendor URL."
        ),
        "checked_count": 32,
        "confirmed_count": 32,
        "sample_file_hash_verified": {
            "url": "http://static.azul.com/zulu-embedded/bin/zre8.23.0.3-cp3-wr-jre8.0.144-linux_i686.tar.gz",
            "also": "http://cdn.azul.com/zulu-embedded/bin/zre8.23.0.3-cp3-wr-jre8.0.144-linux_i686.tar.gz",
            "size": 21377456,
            "algo": "sha256",
            "result": "match (both hostnames, curl --proto '=http', 0 redirects, scheme HTTP)",
        },
        "notes": (
            "This is the only plain-http path to any Zulu file and, with the two Temurin hosts "
            "below, the first plain http in the java catalogue at all. It matters because XP/"
            "Vista/Win7 clients frequently cannot complete a modern TLS handshake; every file is "
            "pinned by SHA-256, so http costs no integrity. The http URLs are recorded in each "
            "entry's mirrors[] alongside the https ones -- if the catalogue would rather hold this "
            "as a per-host property (the planned reachability.json 'http_plain' field in "
            "SCHEMA.md), they can be stripped with a one-line filter on the scheme."
        ),
        "checked_at": DATE,
    },
    {
        "runtime": "java",
        "vendor": "zulu",
        "name": "Bazel project OpenJDK mirror (mirror.bazel.build)",
        "region": "global (Google-operated anycast in front of a GCS bucket)",
        "operator": "The Bazel project / Google -- the mirror Bazel's own java_tools rules fetch JDKs from",
        "url_template": "https://mirror.bazel.build/openjdk/azul-zulu{version_dir}/{filename}",
        "protocols": {
            "https": "confirmed",
            "http": "fails -- 301 to https (including for bogus paths), so no plaintext option",
        },
        "coverage": (
            "partial and frozen: 13 Zulu version directories (Java 8, 9, 10, 11, 12) pinned by "
            "Bazel over the years, x64 linux/macos/windows JDK archives only, no JREs and nothing "
            "newer than Zulu 12. 23 of its files are catalogue entries."
        ),
        "confirmed_by": (
            "bazel_mirror.py: parsed the mirror's own index.html, matched by exact file name, then "
            "(a) fetched each version directory's SHA256SUM and compared it with the catalogue's "
            "vendor sha256 -- 23/23 agreed, i.e. hash-level agreement rather than a size match "
            "alone -- and (b) HEADed each file with redirects disabled, 23/23 HTTP 200 with "
            "Content-Length equal to the real cdn.azul.com Content-Length. Bogus file and bogus "
            "directory both returned 404."
        ),
        "checked_count": 23,
        "confirmed_count": 23,
        "confirmed_majors": ["8", "9", "11", "12"],
        "sample_file_hash_verified": {
            "url": "https://mirror.bazel.build/openjdk/azul-zulu-8.21.0.1-jdk8.0.131/zulu8.21.0.1-jdk8.0.131-win_x64.zip",
            "size": 76357880,
            "algo": "sha256",
            "result": "match",
            "note": (
                "Over the pass's <=60 MB sample budget: this host carries no JREs and 76,357,880 B "
                "is the smallest file on it, so the budget could not be met without skipping the "
                "hash check entirely. Downloaded and deleted."
            ),
        },
        "notes": (
            "The first Zulu mirror found that is operated by someone other than Azul, and the only "
            "one outside China. It publishes a SHA256SUM per version directory, which is what made "
            "byte-identity provable without relying on size. One file, "
            "zulu8.21.0.1-jdk8.0.131-macosx_x64.zip, appeared to mismatch on size (78,852,440 vs "
            "the entry's 78,856,200) -- a HEAD against cdn.azul.com showed the vendor itself serves "
            "78,852,440, so the catalogue's `size` is stale, not the mirror. See "
            "package-managers/round2/java-hash-hunt/README.md."
        ),
        "checked_at": DATE,
    },
    {
        "runtime": "java",
        "vendor": ["temurin", "zulu"],
        "name": "Nix fetchurl fallback cache (tarballs.nixos.org)",
        "region": "global (Fastly in front of NixOS infrastructure)",
        "operator": "NixOS Foundation",
        "url_template": "https://tarballs.nixos.org/sha256/{vendor_sha256}",
        "protocols": {
            "https": "confirmed",
            "http": "fails -- 301 to https",
        },
        "coverage": (
            "partial and content-addressed: only what Hydra happened to build. 56 Temurin archives "
            "(added round 2) + 18 Zulu archives (added this round) = 74 java entries."
        ),
        "confirmed_by": (
            "probe.py nix-zulu: HEAD on https://tarballs.nixos.org/sha256/<the entry's vendor "
            "sha256> for all 7,720 zulu entries; 18 returned 200, all with Content-Length equal to "
            "the vendor size. A bogus (all-zero) hash returns 404. The lookup key IS the vendor "
            "sha256 per nixpkgs' maintainers/scripts/copy-tarballs.pl, so a 200 already implies "
            "byte identity; the size check is corroboration."
        ),
        "checked_count": 7720,
        "confirmed_count": 18,
        "sample_file_hash_verified": {
            "result": "match",
            "note": "Hash-verified for java in round 2 (a Temurin sample); not repeated here.",
        },
        "notes": (
            "Round 2 probed this host only for entries that were unmirrored at the time, which by "
            "then excluded every zulu entry; this round probed the zulu set as well."
        ),
        "checked_at": DATE,
    },
    {
        "runtime": "java",
        "vendor": "temurin",
        "name": "Gentoo distfiles (distfiles.gentoo.org)",
        "region": "global (CDN-backed)",
        "operator": "Gentoo Foundation",
        "url_template": [
            "https://distfiles.gentoo.org/distfiles/{blake2b(filename)[:2]}/{filename}",
            "http://distfiles.gentoo.org/distfiles/{blake2b(filename)[:2]}/{filename}",
        ],
        "protocols": {
            "https": "confirmed (round 2)",
            "http": "works -- HTTP 200, same path, same Content-Length, no redirect",
        },
        "coverage": (
            "partial: whatever dev-java/openjdk-bin and openjdk-jre-bin currently reference, plus "
            "distfiles from recently-removed revisions that Gentoo has not pruned yet. 80 java "
            "entries (61 from round 2 by Manifest, 19 more found here by asking the host directly)."
        ),
        "confirmed_by": (
            "http_variants.py: all 61 already-recorded https URLs re-HEADed over http with "
            "redirects disabled -- 61/61 HTTP 200 with Content-Length equal to the vendor size. "
            "Bogus path over http returned 404. gentoo_sweep.py then asked this host for each of "
            "the 1,940 still-unmirrored java files by computing the distfiles layout path offline "
            "(blake2b of the file name, first two hex digits) rather than trusting a Manifest: 19 "
            "were present, all with Content-Length equal to the vendor size over both https and "
            "http, same file name as the vendor's. Bogus layout path 404."
        ),
        "checked_count": 2001,
        "confirmed_count": 80,
        "sample_file_hash_verified": {
            "url": "http://distfiles.gentoo.org/distfiles/3a/OpenJDK8U-jre_x64_linux_hotspot_8u504b01.tar.gz",
            "size": 41844148,
            "algo": "sha256",
            "result": "match (plain http, 0 redirects)",
        },
        "notes": (
            "Recorded in java/mirrors.json for the first time here; the https URLs were added in "
            "round 2 and documented only in package-managers/round2/os-distro-caches/README.md."
        ),
        "checked_at": DATE,
    },
]


def main():
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        mirrors = json.loads(MIRRORS.read_text())
        new_names = {m["name"] for m in NEW}
        mirrors = [m for m in mirrors if m.get("name") not in new_names]

        for m in mirrors:
            if m.get("name") == "static.azul.com (alternate Azul CDN hostname)":
                m["url_template"] = [
                    "https://static.azul.com/zulu/bin/{filename}",
                    "https://static.azul.com/zulu-embedded/bin/{filename}",
                ]
                m["coverage"] = "full -- all 7,720 zulu-jdk/zulu-jre entries (7,420 under /zulu/bin/, 300 under /zulu-embedded/bin/)"
                m["protocols"]["http"] = "works -- plain http, HTTP 200, no redirect (re-confirmed " + DATE + " with a hash-verified full download)"
                m["round3_addition"] = (
                    "2026-09-20: round 2 applied this host by substituting the /zulu/bin/ URL prefix, "
                    "which skipped the 300 entries under cdn.azul.com/zulu-embedded/bin/. All 300 were "
                    "HEAD-checked: 296 matched immediately; of the rest, 2 were HEAD timeouts that "
                    "matched on individual retry and 2 have stale rounded `size` fields in "
                    "releases.json -- static.azul.com returns exactly what cdn.azul.com returns for "
                    "both. Bogus file and bogus directory both 404. Sample "
                    "zre8.23.0.3-cp3-wr-jre8.0.144-linux_i686.tar.gz (21,377,456 B) downloaded in full "
                    "and sha256-verified."
                )
            if m.get("name") == "Azul CDN (primary, not a third-party mirror)":
                m["url_template"] = [
                    "https://cdn.azul.com/zulu/bin/{filename}",
                    "https://cdn.azul.com/zulu-embedded/bin/{filename}",
                ]
                m["protocols"] = {
                    "https": "canonical",
                    "http": "works -- see the 'Azul CDN over plain http' record below (added 2026-09-20)",
                }
            if m.get("name") == "NJU (Nanjing University) Adoptium mirror":
                m["protocols"]["http"] = (
                    "works -- re-confirmed 2026-09-20: all 116 recorded URLs HEADed over http with "
                    "redirects disabled returned 200 with Content-Length equal to the vendor size "
                    "(Cookie: bcheck=true); bogus path 404; "
                    "OpenJDK18U-jre_aarch64_mac_hotspot_18.0.2.1_1.tar.gz (36,270,257 B) downloaded "
                    "in full over http and sha256-verified. http:// URLs are now recorded in "
                    "mirrors[] alongside the https ones."
                )
            if m.get("name") == "TUNA (Tsinghua University) Adoptium mirror":
                m.setdefault("protocols", {})["https"] = "confirmed"
                m["protocols"]["http"] = "fails -- 301 to https on every path (checked 2026-09-20, all 158 recorded URLs)"
            if m.get("name") == "USTC (University of Science and Technology of China) Adoptium mirror":
                m["protocols"]["http"] = (
                    "fails -- 84/84 return 200 over http, but so does a bogus path (the "
                    "'Verifying your browser' challenge page): a soft-200 catch-all, re-checked "
                    "2026-09-20. Unchanged from round 1's verdict."
                )
            if m.get("name") == "injdk.cn Zulu mirror (d10.injdk.cn)":
                m["protocols"]["http"] = "fails -- 308 to https (re-checked 2026-09-20, all 101 recorded URLs)"

        mirrors.extend(NEW)
        atomic_write(MIRRORS, json.dumps(mirrors, indent=1, ensure_ascii=False) + "\n")

        notes = NOTES.read_text()
        if MARK in notes:
            notes = notes[: notes.index(MARK)].rstrip() + "\n"
        atomic_write(NOTES, notes.rstrip() + "\n\n" + (HERE / "notes_section.md").read_text())
    print("mirrors.json and NOTES.md updated")


HERE = Path(__file__).resolve().parent

if __name__ == "__main__":
    main()
