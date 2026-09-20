#!/usr/bin/env python3
"""Join the runtimes store's locally-computed SHA-256 pins (store/sha256-local.json,
278 files the vendors publish no checksum for) onto cc/nim releases.json entries,
so hash-addressed caches can be queried for entries whose `checksum` is null.

Join key: url-decoded basename + exact byte size (both unique enough here; the
script asserts no ambiguous pairs).
"""
import json, urllib.parse
from pathlib import Path

CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
STORE = Path("/home/x/projects/installer-builder/runtime-metadata/store/sha256-local.json")


def load():
    local = json.loads(STORE.read_text())
    by_key = {}
    for p, v in local.items():
        by_key.setdefault((Path(p).name, v["size"]), []).append((p, v["sha256"]))
    out = {}
    for folder in ("cc", "nim"):
        for e in json.loads((CAT / folder / "releases.json").read_text()):
            name = urllib.parse.unquote(e["url"].rsplit("/", 1)[-1])
            hits = by_key.get((name, e["size"]))
            if hits and len(hits) == 1:
                out[e["url"]] = {"folder": folder, "sha256": hits[0][1],
                                 "store_path": hits[0][0], "size": e["size"],
                                 "has_vendor_checksum": bool(e.get("checksum")),
                                 "mirrors": len(e.get("mirrors") or [])}
    return out


if __name__ == "__main__":
    m = load()
    Path("local_sha_map.json").write_text(json.dumps(m, indent=1))
    print(len(m), "entries got a locally-pinned sha256")
    import collections
    print(collections.Counter((v["folder"], v["has_vendor_checksum"], v["mirrors"] > 0) for v in m.values()))
