#!/usr/bin/env python3
"""Probe the official Gentoo distfiles mirror network (api.gentoo.org/mirrors/
distfiles.xml) for the two nim source tarballs Gentoo currently carries.

Only `distfiles.gentoo.org` (the CDN) was recorded in round 2; this pass looks
for real university/NREN mirrors of the same tree, and in particular for ones
that serve the identical path over PLAIN HTTP, which the catalogue had none of
for nim.  Gentoo's layout is `distfiles/<blake2b(filename)[:2]>/<filename>`
(distfiles/layout.conf: `filename-hash BLAKE2B 8`).
"""
import hashlib, json, sys, xml.etree.ElementTree as ET
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe import probe

CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
FILES = {"nim-2.2.10.tar.xz": None, "nim-2.2.12.tar.xz": None}


def pfx(name):
    return hashlib.blake2b(name.encode()).hexdigest()[:2]


rel = json.loads((CAT / "nim" / "releases.json").read_text())
by_name = {e["url"].rsplit("/", 1)[-1]: e for e in rel}
for n in FILES:
    FILES[n] = by_name[n]["size"]

roots = []
for mg in ET.parse(Path(__file__).parent / "gentoo_mirrors.xml").getroot():
    for m in mg:
        for u in m.findall("uri"):
            if u.get("protocol") in ("http", "https"):
                roots.append({"region": mg.get("region"), "country": mg.get("countryname"),
                              "operator": m.findtext("name"), "proto": u.get("protocol"),
                              "base": u.text.rstrip("/") + "/"})

pairs, meta = [], []
for r in roots:
    for n, size in FILES.items():
        url = f"{r['base']}distfiles/{pfx(n)}/{n}"
        pairs.append((size, url))
        meta.append((r, n, url))
    pairs.append((None, f"{r['base']}distfiles/{pfx('bogus')}/nim-9.9.9-bogus-control.tar.xz"))
    meta.append((r, "__control__", pairs[-1][1]))

print(f"{len(roots)} mirror roots, {len(pairs)} probes", file=sys.stderr)
res = probe(pairs, "gentoo-network", workers=2)
out = {}
for (r, n, url), x in zip(meta, res):
    k = r["base"]
    d = out.setdefault(k, {**r, "files": {}, "control": None})
    if n == "__control__":
        d["control"] = x.get("status")
    else:
        d["files"][n] = {"status": x.get("status"), "length": x.get("length"), "match": x["match"], "url": url}
Path("gentoo_network.json").write_text(json.dumps(out, indent=1))
good = {k: v for k, v in out.items()
        if all(f["match"] for f in v["files"].values()) and v["control"] == 404}
print(f"\n{len(good)} mirrors serve BOTH files with an exact size match and a real 404 control:")
for k, v in sorted(good.items(), key=lambda kv: (kv[1]["region"] or "", kv[1]["country"] or "")):
    print(f"  {v['proto']:5} {v['region']:>15} {v['country']:>18}  {v['operator'][:34]:34} {k}")
