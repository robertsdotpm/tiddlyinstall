#!/usr/bin/env python3
"""Generic, re-runnable HEAD prober for the nim/cc round-2 mirror hunt.

  probe.py <name> <urls-file>     # urls-file: one "<expected_size> <url>" per line
  probe.py --urls <name> <url>... # ad-hoc

Writes/updates cache.json beside this file, keyed by URL, so re-runs are cheap
and idempotent.  Redirects are NOT followed (a host that 30x's to the vendor is
not a mirror); the Location header is recorded instead.
"""
import json
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog"
HEADERS = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def load_cache():
    if CACHE.exists():
        return json.loads(CACHE.read_text())
    return {}


def save_cache(c):
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(c, indent=1, sort_keys=True))
    tmp.replace(CACHE)


def head(url, timeout=25):
    req = urllib.request.Request(url, method="HEAD", headers=HEADERS)
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return {
                "status": r.status,
                "length": r.headers.get("Content-Length"),
                "location": r.headers.get("Location"),
                "server": r.headers.get("Server"),
                "ctype": r.headers.get("Content-Type"),
            }
    except urllib.error.HTTPError as e:
        return {
            "status": e.code,
            "length": e.headers.get("Content-Length") if e.headers else None,
            "location": e.headers.get("Location") if e.headers else None,
            "server": e.headers.get("Server") if e.headers else None,
            "ctype": e.headers.get("Content-Type") if e.headers else None,
        }
    except Exception as e:  # noqa: BLE001
        return {"status": None, "error": repr(e)[:200]}


def probe(pairs, tag, refresh=False, workers=8):
    """pairs: list of (expected_size_or_None, url).  Returns list of records."""
    cache = load_cache()
    todo = [(s, u) for s, u in pairs if refresh or u not in cache]
    # never more than `workers` in flight, and group per host to stay polite
    by_host = {}
    for s, u in todo:
        by_host.setdefault(urlsplit(u).netloc, []).append((s, u))
    for host, items in by_host.items():
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=min(workers, 10)) as ex:
            for (s, u), res in zip(items, ex.map(lambda p: head(p[1]), items)):
                res["checked"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                res["tag"] = tag
                cache[u] = res
        print(f"  {host}: {len(items)} probed in {time.time()-t0:.1f}s", file=sys.stderr)
        save_cache(cache)
    out = []
    for s, u in pairs:
        r = dict(cache.get(u, {}))
        r["url"] = u
        r["expected"] = s
        r["match"] = (
            r.get("status") == 200
            and s is not None
            and r.get("length") is not None
            and int(r["length"]) == int(s)
        )
        out.append(r)
    return out


if __name__ == "__main__":
    if sys.argv[1] == "--urls":
        tag = sys.argv[2]
        pairs = [(None, u) for u in sys.argv[3:]]
    else:
        tag = sys.argv[1]
        pairs = []
        for line in Path(sys.argv[2]).read_text().split("\n"):
            line = line.strip()
            if not line:
                continue
            size, url = line.split(None, 1)
            pairs.append((None if size == "-" else int(size), url))
    for r in probe(pairs, tag, refresh="--refresh" in sys.argv):
        print(
            f"{r.get('status')}\t{r.get('length')}\t{r.get('expected')}\t"
            f"{'MATCH' if r['match'] else ''}\t{r['url']}"
            + (f"\t-> {r['location']}" if r.get("location") else "")
        )
