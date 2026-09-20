#!/usr/bin/env python3
"""Compute sha256/sha1/md5 for every locally downloaded Java runtime file and
match it to a catalogue entry in java/releases.json (by exact file name).

Output: local_hashes.json  [{"file","name","size","sha256","sha1","md5","url"|null,
                             "sha256_matches_catalog": bool}]
Re-runnable; skips nothing, just recomputes (takes a couple of minutes).
"""
import hashlib, json, os, sys
from pathlib import Path

ROOT = Path("/home/x/projects/installer-builder-runtimes/java")
CATALOG = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / "local_hashes.json"


def hashes(p):
    h = {"sha256": hashlib.sha256(), "sha1": hashlib.sha1(), "md5": hashlib.md5()}
    with open(p, "rb") as f:
        while True:
            b = f.read(4 << 20)
            if not b:
                break
            for x in h.values():
                x.update(b)
    return {k: v.hexdigest() for k, v in h.items()}


def main():
    rel = json.loads((CATALOG / "java" / "releases.json").read_text())
    by_name = {}
    for e in rel:
        by_name.setdefault(e["url"].rsplit("/", 1)[-1], e)
    out = []
    for p in sorted(ROOT.rglob("*")):
        if not p.is_file():
            continue
        e = by_name.get(p.name)
        h = hashes(p)
        out.append({
            "file": str(p), "name": p.name, "size": p.stat().st_size,
            **h,
            "url": e["url"] if e else None,
            "catalog_sha256": (e.get("checksum") or {}).get("value") if e else None,
            "sha256_matches_catalog": bool(e and (e.get("checksum") or {}).get("value") == h["sha256"]),
        })
    OUT.write_text(json.dumps(out, indent=1))
    ok = sum(1 for o in out if o["sha256_matches_catalog"])
    print(f"{len(out)} files, {ok} sha256-matched to a catalogue entry")


if __name__ == "__main__":
    main()
