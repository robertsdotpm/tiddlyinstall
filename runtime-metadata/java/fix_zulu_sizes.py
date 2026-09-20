#!/usr/bin/env python3
"""Replace Azul Zulu sizes with the real file sizes.

Azul's metadata API reports `size` rounded to the nearest 100 bytes (e.g.
64,378,700 for a 64,378,729-byte file), which breaks size-based mirror checks.
Checksums (sha256) are exact and unaffected. This HEADs every Zulu entry's
primary URL on cdn.azul.com and stores the served Content-Length.
Run after scrape.py (and before extra_mirrors.py / wayback lookups).
"""
import concurrent.futures as cf
import fcntl
import json
import os
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
LOCK = HERE.parent / ".write.lock"
UA = "Mozilla/5.0 installer-builder-catalog/1.0"


def head(url):
    try:
        req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            return int(r.headers.get("Content-Length") or 0) or None
    except Exception:
        return None


def main():
    rel = json.loads((HERE / "releases.json").read_text())
    urls = sorted({e["url"] for e in rel if (e.get("variant") or "").startswith("zulu")})
    with cf.ThreadPoolExecutor(12) as ex:
        real = dict(zip(urls, ex.map(head, urls)))
    ok = sum(1 for v in real.values() if v)
    print(f"{len(urls)} zulu urls, {ok} sizes fetched")
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        for path in [HERE / "releases.json"] + sorted(HERE.glob("download_plan*.json")):
            entries = json.loads(path.read_text())
            changed = 0
            for e in entries:
                size = real.get(e["url"])
                if size and e.get("size") != size:
                    e["size"] = size
                    changed += 1
            fd, tmp = tempfile.mkstemp(dir=HERE, suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                json.dump(entries, f, indent=1, ensure_ascii=False)
            os.replace(tmp, path)
            print(f"{path.name}: {changed} sizes corrected")


if __name__ == "__main__":
    main()
