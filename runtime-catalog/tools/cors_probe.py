#!/usr/bin/env python3
"""Check whether a browser page could download catalogue files cross-origin (CORS).

usage: cors_probe.py <host> [<host> ...]          # sample URLs for these hosts from releases.json
       cors_probe.py --url <url> [--url <url> ...]  # specific URLs
       options: --per-host N (default 4 samples, spread across folders and path prefixes)

Prints one JSON object per URL:
  {"host", "url", "ok", "hops": [{"url", "status", "acao", "location"}], "error"}

`ok` follows the browser's rules for a credential-less fetch() in cors mode:
- every hop, redirects included, must answer with Access-Control-Allow-Origin
  equal to "*" or to the Origin sent;
- after a redirect to a different origin the browser sends `Origin: null`, so
  later hops must allow "*" or "null";
- the final hop must be 2xx.
Only headers are read; the body is never downloaded (Range: bytes=0-0 is sent,
which browsers allow without a preflight).
"""
import json
import random
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urljoin, urlsplit
import http.client
import ssl

CATALOG = Path(__file__).resolve().parents[1]
ORIGIN = "https://installer-builder.example"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"


def origin_of(url):
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"


def one_request(url, origin):
    p = urlsplit(url)
    cls = http.client.HTTPSConnection if p.scheme == "https" else http.client.HTTPConnection
    kw = {"timeout": 20}
    if p.scheme == "https":
        kw["context"] = ssl.create_default_context()
    conn = cls(p.netloc, **kw)
    path = p.path or "/"
    if p.query:
        path += "?" + p.query
    conn.request("GET", path, headers={"Origin": origin, "Range": "bytes=0-0", "User-Agent": UA, "Accept": "*/*"})
    r = conn.getresponse()
    hop = {"url": url, "status": r.status, "acao": r.getheader("Access-Control-Allow-Origin"),
           "location": r.getheader("Location")}
    conn.close()
    return hop


def probe(url):
    hops, origin, cur = [], ORIGIN, url
    try:
        for _ in range(10):
            hop = one_request(cur, origin)
            hops.append(hop)
            if hop["status"] in (301, 302, 303, 307, 308) and hop["location"]:
                nxt = urljoin(cur, hop["location"])
                if origin_of(nxt) != origin_of(cur):
                    origin = "null"
                cur = nxt
                continue
            break
    except Exception as e:  # noqa: BLE001 - report any network failure as data
        return {"host": urlsplit(url).netloc, "url": url, "ok": None, "hops": hops, "error": f"{type(e).__name__}: {e}"}
    # Browser CORS check on every hop.
    ok, origin = True, ORIGIN
    for i, h in enumerate(hops):
        if h["acao"] not in ("*", origin):
            ok = False
        if h["location"] and i + 1 < len(hops) and origin_of(hops[i + 1]["url"]) != origin_of(h["url"]):
            origin = "null"
    if not (200 <= hops[-1]["status"] < 300):
        ok = False
    return {"host": urlsplit(url).netloc, "url": url, "ok": ok, "hops": hops, "error": None}


def sample_urls(hosts, per_host):
    wanted = set(hosts)
    buckets = defaultdict(lambda: defaultdict(list))  # host -> (folder, first path segment) -> urls
    for f in CATALOG.glob("*/releases.json"):
        for e in json.loads(f.read_text()):
            for u in [e["url"]] + (e.get("mirrors") or []):
                p = urlsplit(u)
                if p.netloc in wanted:
                    seg = p.path.strip("/").split("/")[0]
                    buckets[p.netloc][(f.parent.name, seg)].append((e.get("size") or 1 << 40, u))
    out = {}
    rnd = random.Random(0)
    for h in hosts:
        groups = list(buckets.get(h, {}).values())
        rnd.shuffle(groups)
        picks = []
        while len(picks) < per_host and any(groups):
            for g in groups:
                if g and len(picks) < per_host:
                    g.sort()
                    picks.append(g.pop(0)[1])  # smallest file in each group first
        out[h] = picks
    return out


def main():
    args = sys.argv[1:]
    per_host = 4
    if "--per-host" in args:
        i = args.index("--per-host")
        per_host = int(args[i + 1])
        del args[i:i + 2]
    urls = []
    if "--url" in args:
        while "--url" in args:
            i = args.index("--url")
            urls.append(args[i + 1])
            del args[i:i + 2]
    for h, us in sample_urls(args, per_host).items():
        if not us:
            print(json.dumps({"host": h, "url": None, "ok": None, "hops": [], "error": "no catalogue URLs for host"}))
        urls += us
    for u in urls:
        print(json.dumps(probe(u)), flush=True)


if __name__ == "__main__":
    main()
