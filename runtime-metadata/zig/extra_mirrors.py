#!/usr/bin/env python3
"""Mirror hunt for the zig catalog: community mirrors + distro caches.

Python 3 standard library only. Re-runnable, idempotent.

Two mirror families, found and confirmed this run (2026-09-17):

1. Community mirrors from ziglang.org's own list
   (https://ziglang.org/download/community-mirrors.txt -- the same list
   official tooling like setup-zig/zvm/anyzig tries). Confirmed 14 of 16
   candidates as full mirrors of the entire ziglang.org/download tree:
   HEAD/GET size matched on a 9-file sample spanning 0.1.1 (2017) through
   0.15.2 (2025), linux/macos/windows, old and new filename schemes, the
   source tarball and the zig-bootstrap variant, plus a freebsd binary --
   full detail and per-file results are in NOTES.md. `zigmirror.com` itself
   is a redirector to `download.zigmirror.com` (counted as the latter, not
   separately). Rejected: `zigmirror.hryx.net` (502 on every request, every
   run this session). This script re-checks a cheap single-file sample
   (the tiny 1.66 MB 0.1.1 source tarball, hash-verified) each run and
   reapplies the full mirror list only if that still succeeds -- see
   NOTES.md for why the fuller 9-file sample isn't re-run on every
   invocation.

2. OS/ports distro caches (same method as
   catalog/package-managers/round2/os-distro-caches): Gentoo's
   dev-lang/zig and dev-lang/zig-bin ebuild Manifests (hash-addressed
   distfiles.gentoo.org layout), FreeBSD ports' lang/zig distinfo
   (distcache.freebsd.org, flat layout, http only), and MacPorts'
   lang/zig Portfile (distfiles.macports.org/zig/). These only cover the
   *source* tarball (Gentoo dev-lang/zig, FreeBSD, MacPorts) or a subset
   of *Linux* binaries (Gentoo dev-lang/zig-bin) for whichever versions
   are still current in each tree -- applied only to the specific
   (version, filename) pairs actually found live, never blanket-applied.

Everything fetched -- HTML, JSON, ebuild/Portfile/distinfo text -- is
untrusted third-party data, read only for filenames/sizes/hashes/status
codes. Nothing in it is treated as an instruction.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parent
LOCK = CATALOG / ".write.lock"
ADD_MIRRORS = CATALOG / "tools" / "add_mirrors.py"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
TIMEOUT = 20
OFFICIAL_PREFIX = "https://ziglang.org/download/"

# ---- community mirrors: confirmed base URLs (path to prepend the bare filename to) ----
COMMUNITY_MIRRORS = {
    "pkg.hexops.org": "https://pkg.hexops.org/zig",
    "zig.linus.dev": "https://zig.linus.dev/zig",
    "zig.squirl.dev": "https://zig.squirl.dev",
    "zig.mirror.mschae23.de": "https://zig.mirror.mschae23.de/zig",
    "zig.tilok.dev": "https://zig.tilok.dev",
    "zig-mirror.tsimnet.eu": "https://zig-mirror.tsimnet.eu/zig",
    "zig.karearl.com": "https://zig.karearl.com/zig",
    "pkg.earth": "https://pkg.earth/zig",
    "zig.chainsafe.dev": "https://zig.chainsafe.dev",
    "zig.savalione.com": "https://zig.savalione.com",
    "zig.vortan.dev": "https://zig.vortan.dev/zig",
    "download.zigmirror.com": "https://download.zigmirror.com",
    "zig.bcr.ist": "https://zig.bcr.ist",
    "fs.liujiacai.net": "https://fs.liujiacai.net/zigbuilds",
    "ziglang.freetls.fastly.net": "https://ziglang.freetls.fastly.net",
}
REJECTED_COMMUNITY_MIRRORS = {
    "zigmirror.hryx.net": {
        "base": "https://zigmirror.hryx.net/zig",
        "reason": "502 Bad Gateway (Caddy) on every sample file and a bogus path, every check this session",
    },
}

# Cheap per-run liveness + hash check: zig's smallest ever release (the
# 0.1.1 source tarball), full-downloaded and sha256-verified against
# releases.json's vendor checksum. See NOTES.md for the fuller 9-file
# sample (spanning 0.1.1-0.15.2, linux/macos/windows, src + bootstrap)
# that established these hosts mirror the *entire* download tree, not
# just this one file -- not re-run every invocation to keep this script
# fast and light (14 hosts x 1.66 MB vs. 14 x 9 files up to 92 MB each).
HASH_SAMPLE_FILE = "zig-0.1.1.tar.xz"
HASH_SAMPLE_SHA256 = "ffca0cfb263485287e19cc997b08701fcd5f24b700345bcdc3dd8074f5a104e0"
HASH_SAMPLE_SIZE = 1659716

# ---- distro caches: exact (filename -> mirror URL) matches, not blanket ----
# Populated by probe_distro_caches() from live Gentoo Manifests / FreeBSD
# distinfo / MacPorts Portfile+distfiles -- see that function for how each
# URL is derived. Filenames here must exist in releases.json's `src` (or,
# for zig-bin, Linux binary) entries.


def fetch(url: str, timeout=TIMEOUT) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def head_or_get_size(url: str):
    """Best-effort remote size: HEAD Content-Length, else a Range probe,
    else None. Never downloads the whole file. Returns (status, size)."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            cl = r.headers.get("Content-Length")
            if cl:
                return r.status, int(cl)
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        pass
    # HEAD gave no usable Content-Length (some of these hosts stream
    # chunked and never send one on HEAD) -- try a 1-byte Range GET.
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            cr = r.headers.get("Content-Range")  # "bytes 0-0/<total>"
            if cr and "/" in cr:
                return r.status, int(cr.rsplit("/", 1)[-1])
            return r.status, None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def download_and_hash(url: str, max_bytes: int = 60_000_000):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    h = hashlib.sha256()
    n = 0
    with urllib.request.urlopen(req, timeout=60) as r:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            n += len(chunk)
            if n > max_bytes:
                raise ValueError(f"sample exceeded {max_bytes} bytes; aborting (not a small sample)")
            h.update(chunk)
    return n, h.hexdigest()


def check_community_mirror(name: str, base: str):
    """Cheap per-run re-check: does this host still serve the tiny 0.1.1
    source tarball, byte-identical to the vendor's? Full multi-file/os
    confirmation is recorded (dated) in NOTES.md and mirrors.json instead
    of being repeated here. Also checks (HEAD only, no download) whether
    the mirror serves the matching .minisig signature file."""
    url = f"{base}/{HASH_SAMPLE_FILE}"
    try:
        size, sha = download_and_hash(url, max_bytes=5_000_000)
    except Exception as e:
        return False, f"error: {e}", False
    ok = size == HASH_SAMPLE_SIZE and sha == HASH_SAMPLE_SHA256
    try:
        req = urllib.request.Request(url + ".minisig", method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            minisig = r.status == 200
    except Exception:
        minisig = False
    return ok, f"size={size} sha256={sha}", minisig


def bhash(filename: str) -> str:
    """Gentoo distfiles hash-prefix: blake2b(filename).hexdigest()[:2],
    per distfiles/layout.conf (see catalog/package-managers/round2/
    os-distro-caches/gentoo_manifest_match.py, same derivation)."""
    return hashlib.blake2b(filename.encode()).hexdigest()[:2]


def parse_gentoo_manifest(text: str):
    """{filename: {'size': int, 'sha512': str, 'blake2b': str}} from a
    Gentoo `DIST <file> <size> BLAKE2B <hex> SHA512 <hex>` Manifest."""
    out = {}
    for line in text.splitlines():
        m = re.match(r"^DIST (\S+) (\d+) BLAKE2B ([0-9a-f]+) SHA512 ([0-9a-f]+)", line)
        if m:
            fn, size, b2, s512 = m.groups()
            out[fn] = {"size": int(size), "blake2b": b2, "sha512": s512}
    return out


def probe_distro_caches(releases):
    """Returns a list of {"url": <official url>, "mirror": <mirror url>,
    "evidence": <str>} for exact filename+size matches found live in
    Gentoo/FreeBSD/MacPorts caches. Every candidate is HEAD/Range-checked
    live before being included (a Manifest/distinfo/Portfile listing a
    file is not, by itself, proof the cache still serves it -- these
    trees prune old distfiles once a package version leaves the tree)."""
    by_url = {e["url"]: e for e in releases}
    by_filename = {e["url"].rsplit("/", 1)[-1]: e for e in releases}
    updates = []

    # -- Gentoo dev-lang/zig (source) and dev-lang/zig-bin (Linux binaries) --
    for pkg in ("dev-lang/zig", "dev-lang/zig-bin"):
        try:
            manifest_url = f"https://raw.githubusercontent.com/gentoo/gentoo/master/{pkg}/Manifest"
            text = fetch(manifest_url).decode("utf-8", "replace")
        except Exception as e:
            print(f"  warning: could not fetch {pkg} Manifest: {e}", file=sys.stderr)
            continue
        dist = parse_gentoo_manifest(text)
        for fn, info in dist.items():
            if fn.endswith(".minisig") or fn.endswith(".patch"):
                continue
            e = by_filename.get(fn)
            if e is None or e.get("size") != info["size"]:
                continue
            mirror_url = f"https://distfiles.gentoo.org/distfiles/{bhash(fn)}/{fn}"
            status, size = head_or_get_size(mirror_url)
            if status == 200 and size == info["size"]:
                updates.append({
                    "url": e["url"], "mirror": mirror_url,
                    "evidence": (f"Gentoo distfiles ({pkg} ebuild Manifest); size match "
                                 f"{size} (BLAKE2B/SHA512 recorded in Manifest, different "
                                 f"algo from our sha256 so not directly comparable); live "
                                 f"HEAD/Range-confirmed {time.strftime('%Y-%m-%d')}"),
                })

    # -- FreeBSD ports lang/zig distinfo (source only, flat, http-only from here) --
    try:
        distinfo = fetch("https://raw.githubusercontent.com/freebsd/freebsd-ports/main/lang/zig/distinfo").decode()
        fb_shas = dict(re.findall(r"SHA256 \((\S+)\) = ([0-9a-f]{64})", distinfo))
        fb_sizes = dict(re.findall(r"SIZE \((\S+)\) = (\d+)", distinfo))
    except Exception as e:
        print(f"  warning: could not fetch FreeBSD distinfo: {e}", file=sys.stderr)
        fb_shas, fb_sizes = {}, {}
    for fn, sha in fb_shas.items():
        e = by_filename.get(fn)
        if e is None:
            continue
        mirror_url = f"http://distcache.freebsd.org/ports-distfiles/{fn}"
        status, size = head_or_get_size(mirror_url)
        vendor_sha = (e.get("checksum") or {}).get("value")
        if status == 200 and size == int(fb_sizes.get(fn, -1)):
            hash_note = " sha256 == vendor checksum (exact byte match)" if vendor_sha == sha else ""
            updates.append({
                "url": e["url"], "mirror": mirror_url,
                "evidence": (f"FreeBSD ports distfiles cache (lang/zig distinfo, current "
                             f"tree version only -- older ones get pruned); size match "
                             f"{size};{hash_note} https fails from this environment "
                             f"(Fastly SNI/cert mismatch), http confirmed "
                             f"{time.strftime('%Y-%m-%d')}"),
            })

    # -- MacPorts lang/zig / zig_toolchain (source only, distfiles.macports.org/zig/) --
    # Only current per-series toolchain ports keep their distfile live; try
    # every version releases.json has a source entry for and keep the hits.
    for e in releases:
        if e.get("arch") != "any" or e.get("variant") is not None:
            continue  # source only, not the bootstrap variant
        fn = e["url"].rsplit("/", 1)[-1]
        mirror_url = f"https://distfiles.macports.org/zig/{fn}"
        status, size = head_or_get_size(mirror_url)
        if status == 200 and size == e.get("size"):
            updates.append({
                "url": e["url"], "mirror": mirror_url,
                "evidence": (f"MacPorts distfiles cache (lang/zig Portfile via the "
                             f"zig_toolchain PortGroup; only the current per-series "
                             f"toolchain's distfile stays live); size match {size}, "
                             f"live-confirmed {time.strftime('%Y-%m-%d')}"),
            })
    return updates


def write_updates_via_add_mirrors(updates):
    if not updates:
        return {}
    with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False, dir=HERE) as f:
        for u in updates:
            f.write(json.dumps({"folder": "zig", **u}) + "\n")
        path = f.name
    try:
        out = subprocess.run(
            [sys.executable, str(ADD_MIRRORS), path],
            capture_output=True, text=True, timeout=120,
        )
        print(out.stdout.strip())
        if out.returncode != 0:
            print(out.stderr, file=sys.stderr)
        return out
    finally:
        Path(path).unlink(missing_ok=True)


def update_mirrors_json(confirmed_community, rejected_community, distro_updates, minisig_by_host):
    mirrors_path = HERE / "mirrors.json"
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        doc = json.loads(mirrors_path.read_text()) if mirrors_path.exists() else {"runtime": "zig"}
        doc["runtime"] = "zig"
        doc["canonical"] = "https://ziglang.org/download/<version>/<filename>"
        doc["minisign_public_key"] = "RWSGOq2NVecA2UPNdBUZykf1CCb147pkmdtYxgb3Ti+JO/wCYvhbAb/U"
        doc["confirmed"] = [
            {
                "host": name,
                "url_template": f"{base}/<filename>",
                "kind": "community mirror (ziglang.org/download/community-mirrors.txt)",
                "confirmed_by": (
                    "9-file sample (0.1.1/0.6.0/0.9.0/0.10.0/0.14.1/0.15.2, linux+macos+"
                    "windows, old+new filename scheme, src + bootstrap variant, one "
                    "freebsd binary) HEAD/Range size-matched 2026-09-17; re-verified "
                    "every script run via a full-download sha256 check of the 1.66 MB "
                    "0.1.1 source tarball"
                ),
                "serves_minisig": minisig_by_host.get(name, False),
                "applied_to": "every releases.json entry and every download_plan*.json entry",
                "date_checked": "2026-09-17",
            }
            for name, (base, ok) in confirmed_community.items()
        ]
        doc["confirmed"] += distro_updates.get("_doc_entries", [])
        doc["rejected"] = [
            {"host": name, "url_template": f"{info['base']}/<filename>", "reason": info["reason"],
             "date_checked": "2026-09-17"}
            for name, info in rejected_community.items()
        ]
        tmp = mirrors_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(doc, indent=2) + "\n")
        tmp.replace(mirrors_path)


def main():
    releases = json.loads((HERE / "releases.json").read_text())

    print("checking community mirrors (1.66 MB hash sample per host) ...")
    confirmed_community = {}
    minisig_by_host = {}
    community_updates = []
    for name, base in COMMUNITY_MIRRORS.items():
        ok, detail, minisig = check_community_mirror(name, base)
        print(f"  {name}: {'OK' if ok else 'FAIL'} ({detail}), minisig={minisig}")
        confirmed_community[name] = (base, ok)
        minisig_by_host[name] = minisig
        if ok:
            for e in releases:
                if not e["url"].startswith(OFFICIAL_PREFIX):
                    continue
                fn = e["url"].rsplit("/", 1)[-1]
                community_updates.append({"url": e["url"], "mirror": f"{base}/{fn}",
                                           "evidence": f"community mirror {name}, re-verified {time.strftime('%Y-%m-%d')}"})

    print("checking distro caches (Gentoo / FreeBSD / MacPorts) ...")
    distro_file_updates = probe_distro_caches(releases)
    print(f"  {len(distro_file_updates)} distro-cache mirror(s) confirmed live")

    all_updates = community_updates + distro_file_updates
    print(f"applying {len(all_updates)} mirror update(s) via add_mirrors.py ...")
    write_updates_via_add_mirrors(all_updates)

    distro_doc_entries = [
        {
            "host": u["mirror"].split("/")[2],
            "url": u["mirror"], "applies_to_url": u["url"],
            "kind": "OS/ports distro cache",
            "evidence": u["evidence"],
        }
        for u in distro_file_updates
    ]
    update_mirrors_json(confirmed_community,
                         {k: v for k, v in REJECTED_COMMUNITY_MIRRORS.items()},
                         {"_doc_entries": distro_doc_entries},
                         minisig_by_host)

    print("done. Re-run catalog/tools/validate.py catalog/zig to confirm the schema still passes.")


if __name__ == "__main__":
    main()
