#!/usr/bin/env python3
"""Round 2: check whether static.azul.com/zulu/bin/ serves byte-identical
copies of every cdn.azul.com/zulu/bin/ Zulu file (same filename, path
swap). Standard library only. Samples a spread of zulu entries across
major versions / os / arch / variant from releases.json, HEAD-checks each
against static.azul.com, and reports mismatches (if any).
"""
import json
import random
import sys
import urllib.request
import urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
UA = "installer-builder-catalog"

def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status, r.headers.get("Content-Length")
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:
        return None, str(e)

def main():
    releases = json.loads((CATALOG / "java" / "releases.json").read_text())
    zulu = [e for e in releases if e["url"].startswith("https://cdn.azul.com/zulu/bin/")]
    print(f"total zulu entries: {len(zulu)}")

    # Spread sample: bucket by major, take a few from each bucket, plus
    # variety of os/arch/kind.
    by_major = {}
    for e in zulu:
        by_major.setdefault(e["major"], []).append(e)

    rng = random.Random(20260917)
    sample = []
    for maj, items in sorted(by_major.items(), key=lambda kv: (len(kv[0]), kv[0])):
        rng.shuffle(items)
        sample.extend(items[:2])

    # also make sure every (kind, format) combination and both variants
    # (zulu-jdk / zulu-jre) appear at least twice, and include the very
    # smallest and very largest files.
    by_shape = {}
    for e in zulu:
        by_shape.setdefault((e["kind"], e["format"], e["variant"]), []).append(e)
    for shape, items in by_shape.items():
        rng.shuffle(items)
        sample.extend(items[:2])
    by_size = sorted(zulu, key=lambda e: e["size"])
    sample.extend(by_size[:2])
    sample.extend(by_size[-2:])

    # de-dup by url
    seen = set()
    uniq = []
    for e in sample:
        if e["url"] not in seen:
            seen.add(e["url"])
            uniq.append(e)
    sample = uniq
    print(f"sample size: {len(sample)}")

    def check(e):
        alt = e["url"].replace("https://cdn.azul.com/zulu/bin/", "https://static.azul.com/zulu/bin/")
        status, cl = head(alt)
        ok = (status == 200 and cl is not None and int(cl) == e["size"])
        return e, alt, status, cl, ok

    results = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for r in ex.map(check, sample):
            results.append(r)

    ok_count = sum(1 for r in results if r[4])
    print(f"OK (size match): {ok_count}/{len(results)}")
    for e, alt, status, cl, ok in results:
        if not ok:
            print("MISMATCH:", e["major"], e["os"], e["arch"], e["variant"], e["url"], "->", alt, status, cl, "expected", e["size"])

    # bogus-path control
    bogus = "https://static.azul.com/zulu/bin/zulu-does-not-exist-xyz-9999.tar.gz"
    print("bogus control status:", head(bogus))

if __name__ == "__main__":
    main()
