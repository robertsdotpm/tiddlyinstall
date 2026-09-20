#!/usr/bin/env python3
"""Curated institutional subset of the Gentoo distfiles mirror network.

gentoo_network.py found 194 of 273 probed mirror roots serving both nim
tarballs with an exact size match and a real 404 control.  Adding all of them
would put ~200 URLs on two entries, so this picks nine university / NREN /
research-network mirrors, one or two per region, all of which serve the
identical path over PLAIN HTTP -- the property the catalogue was missing.
Each is then downloaded in full and sha256-checked against the vendor checksum.
"""
import hashlib, json, urllib.request
from pathlib import Path

CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog"}
FILES = ["nim-2.2.10.tar.xz", "nim-2.2.12.tar.xz"]
HOSTS = [
    ("mirror.ufs.ac.za", "Africa", "South Africa", "University of the Free State",
     "http://mirror.ufs.ac.za/gentoo/"),
    ("ftp.jaist.ac.jp", "Asia", "Japan", "JAIST (Japan Advanced Institute of Science and Technology)",
     "http://ftp.jaist.ac.jp/pub/Linux/Gentoo/"),
    ("mirror.aarnet.edu.au", "Australia and Oceania", "Australia", "AARNet (Australian Academic and Research Network)",
     "http://mirror.aarnet.edu.au/pub/gentoo/"),
    ("gentoo.c3sl.ufpr.br", "South America", "Brazil", "C3SL, Federal University of Parana",
     "http://gentoo.c3sl.ufpr.br/"),
    ("mirrors.mit.edu", "North America", "United States", "Massachusetts Institute of Technology",
     "http://mirrors.mit.edu/gentoo-distfiles/"),
    ("mirror.csclub.uwaterloo.ca", "North America", "Canada", "University of Waterloo Computer Science Club",
     "http://mirror.csclub.uwaterloo.ca/gentoo-distfiles/"),
    ("ftp.lysator.liu.se", "Europe", "Sweden", "Lysator, Linkoping University",
     "http://ftp.lysator.liu.se/gentoo/"),
    ("www.mirrorservice.org", "Europe", "United Kingdom", "The UK Mirror Service (University of Kent)",
     "http://www.mirrorservice.org/sites/distfiles.gentoo.org/"),
    ("ftp.snt.utwente.nl", "Europe", "Netherlands", "SNT, Universiteit Twente",
     "http://ftp.snt.utwente.nl/pub/os/linux/gentoo/"),
]


def pfx(name):
    return hashlib.blake2b(name.encode()).hexdigest()[:2]


def url_for(base, name):
    return f"{base}distfiles/{pfx(name)}/{name}"


if __name__ == "__main__":
    rel = {e["url"].rsplit("/", 1)[-1]: e for e in json.loads((CAT / "nim" / "releases.json").read_text())}
    want = rel["nim-2.2.10.tar.xz"]["checksum"]["value"]
    out, updates = {}, []
    for host, region, country, operator, base in HOSTS:
        u = url_for(base, "nim-2.2.10.tar.xz")
        h = hashlib.sha256()
        n = 0
        with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=300) as r:
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                h.update(b)
                n += len(b)
        ok = h.hexdigest() == want and n == rel["nim-2.2.10.tar.xz"]["size"]
        out[host] = {"url": u, "bytes": n, "sha256": h.hexdigest(), "match": ok,
                     "region": region, "country": country, "operator": operator, "base": base}
        print(f"{host:30} {n:>9} {'MATCH' if ok else 'MISMATCH'}")
        if ok:
            for f in FILES:
                updates.append({"folder": "nim", "url": rel[f]["url"], "mirror": url_for(base, f),
                                "evidence": f"Gentoo distfiles mirror network ({operator}, {country}); "
                                            f"layout distfiles/<blake2b(filename)[:2]>/<filename>; HEAD exact "
                                            f"Content-Length match on both nim tarballs over PLAIN HTTP with a "
                                            f"real 404 on a bogus filename-hash path, 2026-09-20; "
                                            f"nim-2.2.10.tar.xz downloaded in full over http from this host and "
                                            f"its sha256 matched the vendor checksum exactly"})
    Path("gentoo_curated.json").write_text(json.dumps(out, indent=1))
    Path("gentoo_updates.jsonl").write_text("".join(json.dumps(x) + "\n" for x in updates))
    print(len(updates), "update lines")
