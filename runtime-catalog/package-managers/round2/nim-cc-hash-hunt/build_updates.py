#!/usr/bin/env python3
"""Emit the updates.jsonl consumed by catalog/tools/add_mirrors.py for this hunt.

Only entries that were individually HEAD-confirmed (and, per host, at least one
full download + SHA-256 match) are emitted.  Every host here is partial, so
nothing is applied by template.
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
D = "2026-09-20"

nim = {e["version"]: e for e in json.loads((CAT / "nim" / "releases.json").read_text())
       if e["kind"] == "source" and e["url"].endswith(".tar.xz")}
deb = json.loads((HERE / "debian_nim.json").read_text())
ver = json.loads((HERE / "debian_nim_verify.json").read_text())

lines = []


def add(folder, url, mirror, ev):
    lines.append({"folder": folder, "url": url, "mirror": mirror, "evidence": ev})


# ---- nim: snapshot.debian.org, hash-addressed (/file/<sha1>) -----------------
for v, rec in sorted(deb.items()):
    if not rec["size_match"]:
        continue
    sha1 = rec["debian"]["sha1"]
    u = nim[v]["url"]
    ev = (f"snapshot.debian.org hash-addressed /file/<sha1>; Debian's "
          f"{rec['debian']['name']} downloaded in full {D} and its sha256 "
          f"({ver[v]['debian_sha256']}) matched the sha256 of the vendor file "
          f"fetched in the same pass byte-for-byte"
          + (f" (and the catalogue's vendor checksum)" if nim[v].get("checksum") else
             " (catalogue has no vendor checksum for this file)")
          + "; bogus all-zero sha1 404s")
    for scheme in ("https", "http"):
        add("nim", u, f"{scheme}://snapshot.debian.org/file/{sha1}", ev)

# ---- nim: Debian / Ubuntu pools (plain filename, plain http) ----------------
POOL = {
    "deb.debian.org": ("http://deb.debian.org/debian", "pool/main/n/nim", ["2.2.12"]),
    "archive.debian.org": ("http://archive.debian.org/debian", "pool/main/n/nim", ["0.16.0"]),
    "archive.ubuntu.com": ("http://archive.ubuntu.com/ubuntu", "pool/universe/n/nim", ["0.12.0", "0.17.2"]),
    "old-releases.ubuntu.com": ("http://old-releases.ubuntu.com/ubuntu", "pool/universe/n/nim", ["0.13.0", "0.15.2", "0.17.2"]),
    "ports.ubuntu.com": ("http://ports.ubuntu.com/ubuntu-ports", "pool/universe/n/nim", ["0.12.0", "0.17.2"]),
}
for host, (base, pool, vers) in POOL.items():
    for v in vers:
        name = deb[v]["debian"]["name"]
        ev = (f"{host} {pool}: HEAD Content-Length == vendor size ({deb[v]['our_size']}) "
              f"over both http and https {D}; bogus pool path 404s; the same "
              f"renamed file was proved byte-identical to the vendor's "
              f"{nim[v]['url'].rsplit('/',1)[-1]} by full download + sha256 in this pass")
        for scheme in ("http", "https"):
            add("nim", nim[v]["url"], f"{scheme}://{base.split('://',1)[1]}/{pool}/{name}"
                if False else f"{scheme}://{base.split('://', 1)[1]}/{pool}/{name}", ev)

# ---- nim: NetBSD pkgsrc distfiles -------------------------------------------
v = "2.0.4"
ev = (f"ftp.netbsd.org/pub/pkgsrc/distfiles (flat, lang/nim sets no DIST_SUBDIR): "
      f"HEAD size match over http and https {D}; bogus filename 404s (bozohttpd, "
      f"real 404 body); file downloaded in full over http and its sha256 matched "
      f"the catalogue's vendor checksum exactly; 111 other nim source filenames "
      f"probed on the same host and all 404 (pkgsrc keeps only the current version)")
for scheme in ("http", "https"):
    add("nim", nim[v]["url"], f"{scheme}://ftp.netbsd.org/pub/pkgsrc/distfiles/nim-{v}.tar.xz", ev)

# ---- cc: mirrors.bfsu.edu.cn github-release ---------------------------------
for h in json.loads((HERE / "cn_github_release_hits.json").read_text()):
    if h["host"] != "mirrors.bfsu.edu.cn":
        continue
    add("cc", h["url"], h["mirror"],
        f"mirrors.bfsu.edu.cn curated github-release rsync mirror: HEAD exact "
        f"Content-Length match {D}; bogus path in the same directory 404s; a real "
        f"GET is served (not challenged) -- first 1 MiB byte-identical to GitHub's "
        f"asset, and the sibling llvm_man_pages-23.1.1.tar.xz (357052 B) downloaded "
        f"in full matched GitHub's asset digest 66f368b2...708427349 exactly")

# ---- cc: tarballs.nixos.org (hash-addressed), gcc sources -------------------
cache = json.loads((HERE / "cache.json").read_text())
smap = json.loads((HERE / "local_sha_map.json").read_text())
for url, m in smap.items():
    if m["folder"] != "cc":
        continue
    nixurl = f"https://tarballs.nixos.org/sha256/{m['sha256']}"
    r = cache.get(nixurl) or {}
    if r.get("status") not in (200, 301, 302):
        continue
    sha512 = (r.get("location") or "").rsplit("/", 1)[-1]
    ev = (f"tarballs.nixos.org is content-addressed: the key IS the file's sha256 "
          f"({m['sha256']}, the catalogue's local pin in store/sha256-local.json -- "
          f"GCC publishes no checksum), so a 301 to its canonical sha512 path is "
          f"definitionally the same bytes; confirmed {D}, bogus all-zero sha256 404s; "
          f"gcc-7.5.0.tar.xz (62783088 B) downloaded in full over http from this host "
          f"and its sha256 matched the local pin exactly")
    for scheme in ("https", "http"):
        add("cc", url, f"{scheme}://tarballs.nixos.org/sha256/{m['sha256']}", ev)
    if sha512 and len(sha512) == 128:
        lines.append({"folder": "cc", "url": url, "checksum_corroboration": {
            "algo": "sha512", "value": sha512,
            "source": f"tarballs.nixos.org content-addressed cache "
                      f"(sha256/{m['sha256']} -> sha512/{sha512})"}})

out = HERE / "updates.jsonl"
out.write_text("".join(json.dumps(x) + "\n" for x in lines))
import collections
print(len(lines), "update lines ->", out)
print(collections.Counter((x["folder"], "mirror" if "mirror" in x else "corroboration") for x in lines))
