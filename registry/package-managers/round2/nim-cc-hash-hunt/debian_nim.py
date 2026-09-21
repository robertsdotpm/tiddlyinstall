#!/usr/bin/env python3
"""Check snapshot.debian.org's nim .orig tarballs against our catalogue sizes.

Debian's file store is hash-addressed: https://snapshot.debian.org/file/<sha1>.
Debian renames the upstream tarball (nim-X.Y.Z.tar.xz -> nim_X.Y.Z.orig.tar.xz)
and for most of nim's history also REPACKS it (git checkout + csources), so the
size check below is the filter: only where Debian's orig size equals our
vendor size is the file a plausible byte-identical copy, and even then it is
only accepted after a full download + sha256 match (see verify step).
"""
import json, re, sys, time, urllib.request
from pathlib import Path

CAT = Path("/home/x/projects/installer-builder/registry")
UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog"}
OUT = Path(__file__).resolve().parent / "debian_nim.json"


def get(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001
            if attempt == 2:
                return {"error": repr(e)[:150]}
            time.sleep(3)


rel = json.loads((CAT / "nim" / "releases.json").read_text())
want = {}
for e in rel:
    if e["kind"] == "source" and e["url"].endswith(".tar.xz"):
        want.setdefault(e["version"], e)

vers = get("https://snapshot.debian.org/mr/package/nim/")["result"]
cands = {}
for v in vers:
    up = re.split(r"-(?!.*-)", v["version"])[0]
    if "~" in up or "+really" in up:
        continue
    if up in want:
        cands.setdefault(up, v["version"])
print(f"{len(cands)} upstream versions in both Debian and the catalogue", file=sys.stderr)

res = {}
for up, dv in sorted(cands.items()):
    d = get(f"https://snapshot.debian.org/mr/package/nim/{dv}/srcfiles?fileinfo=1")
    time.sleep(0.4)
    hit = None
    for sha1, infos in (d.get("fileinfo") or {}).items():
        for i in infos:
            if i["name"].endswith(".orig.tar.xz"):
                hit = {"sha1": sha1, "name": i["name"], "size": i["size"]}
    ours = want[up]
    res[up] = {
        "debian_version": dv,
        "our_url": ours["url"],
        "our_size": ours["size"],
        "our_sha256": (ours.get("checksum") or {}).get("value"),
        "debian": hit,
        "size_match": bool(hit and hit["size"] == ours["size"]),
    }
    print(f"{up:10} ours={ours['size']:>10}  debian={hit['size'] if hit else '-':>10}  "
          f"{'SIZE-MATCH' if res[up]['size_match'] else ''}")
OUT.write_text(json.dumps(res, indent=1))
