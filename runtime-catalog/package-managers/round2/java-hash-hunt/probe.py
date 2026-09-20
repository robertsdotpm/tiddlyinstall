#!/usr/bin/env python3
"""Round-3 Java mirror probes (hash-search pass).

Sub-commands (all re-runnable; results cached in probe_cache.json):

  azul-embedded   HEAD every cdn.azul.com/zulu-embedded/bin/ entry against
                  static.azul.com/zulu-embedded/bin/ (Content-Length == vendor size)
  azul-http       HEAD a spread sample of zulu entries over plain http:// on
                  cdn.azul.com and static.azul.com (no redirect allowed)
  nix-zulu        HEAD https://tarballs.nixos.org/sha256/<vendor sha256> for
                  every zulu entry (hash-addressed Nix fetchurl fallback cache)
  swh             GET  https://archive.softwareheritage.org/api/1/content/
                  sha256:<hex>/ for a sample (needs Accept: application/json;
                  the HTML site is behind an Anubis bot challenge)
  control         bogus-path controls for every host used

Usage: probe.py <sub-command> [--limit N]
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
REL = CATALOG / "java" / "releases.json"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/140.0.0.0 Safari/537.36 installer-builder-catalog")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def head(url, follow=False, timeout=30, method="HEAD", headers=None):
    op = urllib.request.build_opener(*([] if follow else [NoRedirect]))
    req = urllib.request.Request(url, method=method,
                                 headers={"User-Agent": UA, **(headers or {})})
    try:
        with op.open(req, timeout=timeout) as r:
            return {"code": r.status, "len": r.headers.get("Content-Length"),
                    "etag": r.headers.get("ETag"), "loc": r.headers.get("Location"),
                    "ctype": r.headers.get("Content-Type"), "final": r.geturl(),
                    "body": r.read(2000).decode("utf-8", "replace") if method == "GET" else None}
    except urllib.error.HTTPError as e:
        return {"code": e.code, "len": e.headers.get("Content-Length"),
                "loc": e.headers.get("Location"), "ctype": e.headers.get("Content-Type"),
                "body": e.read(2000).decode("utf-8", "replace") if method == "GET" else None}
    except Exception as e:
        return {"code": None, "error": repr(e)}


def releases():
    return json.loads(REL.read_text())


def zulu(entries):
    return [e for e in entries if (e.get("variant") or "").startswith("zulu")]


def run(fn, items, workers=10, stagger=0.0):
    out = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for r in ex.map(fn, items):
            out.append(r)
            if len(out) % 250 == 0:
                print(f"  ... {len(out)}/{len(items)}", file=sys.stderr)
    return out


def save(name, data):
    p = HERE / f"{name}.json"
    p.write_text(json.dumps(data, indent=1))
    print(f"wrote {p} ({len(data)} rows)")


def cmd_azul_embedded(limit=None):
    es = [e for e in zulu(releases()) if "/zulu-embedded/bin/" in e["url"]]
    if limit:
        es = es[:limit]
    print(f"{len(es)} zulu-embedded entries")

    def f(e):
        u = e["url"].replace("https://cdn.azul.com/", "https://static.azul.com/")
        r = head(u)
        return {"url": e["url"], "mirror": u, "size": e["size"],
                "code": r.get("code"), "len": r.get("len"),
                "match": r.get("code") == 200 and r.get("len") == str(e["size"]),
                "error": r.get("error"), "loc": r.get("loc")}
    res = run(f, es)
    save("azul_embedded_results", res)
    print("matched", sum(1 for r in res if r["match"]), "of", len(res))


def spread_sample(es, n=12):
    """A deterministic spread over major / os / arch / kind / variant + extremes."""
    es = sorted(es, key=lambda e: (int(e["major"]), e["os"], e["arch"], e["variant"] or "",
                                   e["kind"], e["format"], e["version"]))
    seen, out = set(), []
    for e in es:
        k = (e["major"], e["os"], e["variant"], e["kind"])
        if k in seen:
            continue
        seen.add(k)
        out.append(e)
    step = max(1, len(out) // n)
    picked = out[::step][:n]
    by_size = sorted(es, key=lambda e: e["size"] or 0)
    return picked + [by_size[0], by_size[-1]]


def cmd_azul_http(limit=None):
    es = spread_sample(zulu(releases()), 14)
    rows = []
    for e in es:
        for host in ("cdn.azul.com", "static.azul.com"):
            u = e["url"].replace("https://cdn.azul.com/", f"http://{host}/")
            r = head(u)
            rows.append({"url": e["url"], "mirror": u, "size": e["size"],
                         "code": r.get("code"), "len": r.get("len"), "loc": r.get("loc"),
                         "match": r.get("code") == 200 and r.get("len") == str(e["size"])})
            time.sleep(0.15)
    save("azul_http_results", rows)
    for r in rows:
        print(r["match"], r["code"], r["len"], r["size"], r["mirror"])


def cmd_nix_zulu(limit=None):
    es = [e for e in zulu(releases())
          if (e.get("checksum") or {}).get("algo") == "sha256"]
    if limit:
        es = es[:limit]
    print(f"{len(es)} zulu entries with sha256")

    def f(e):
        h = e["checksum"]["value"]
        u = f"https://tarballs.nixos.org/sha256/{h}"
        r = head(u, follow=True)
        return {"url": e["url"], "mirror": u, "size": e["size"], "sha256": h,
                "code": r.get("code"), "len": r.get("len"), "final": r.get("final"),
                "match": r.get("code") == 200 and r.get("len") == str(e["size"])}
    res = run(f, es)
    save("nix_zulu_results", res)
    print("found", sum(1 for r in res if r["code"] == 200), "size-matched",
          sum(1 for r in res if r["match"]))


def cmd_swh(limit=None):
    es = spread_sample(zulu(releases()), 16)
    rows = []
    for e in es:
        h = (e.get("checksum") or {}).get("value")
        u = f"https://archive.softwareheritage.org/api/1/content/sha256:{h}/"
        r = head(u, follow=True, method="GET", headers={"Accept": "application/json"})
        rows.append({"url": e["url"], "query": u, "code": r.get("code"),
                     "body": (r.get("body") or "")[:200]})
        print(r.get("code"), e["url"].rsplit("/", 1)[-1])
        time.sleep(1.5)
    save("swh_results", rows)


def cmd_control(limit=None):
    tests = [
        ("static.azul.com zulu-embedded bogus file",
         "https://static.azul.com/zulu-embedded/bin/zulu-no-such-file-9999.tar.gz"),
        ("static.azul.com bogus dir",
         "https://static.azul.com/no-such-dir-9999/bin/zulu8.31.1.122-jdk1.8.0_181-linux_aarch64.tar.gz"),
        ("http static.azul.com bogus file",
         "http://static.azul.com/zulu/bin/zulu-no-such-file-9999.tar.gz"),
        ("http cdn.azul.com bogus file",
         "http://cdn.azul.com/zulu/bin/zulu-no-such-file-9999.tar.gz"),
        ("tarballs.nixos.org bogus hash",
         "https://tarballs.nixos.org/sha256/" + "0" * 64),
    ]
    rows = []
    for name, u in tests:
        r = head(u, follow=True, method="GET")
        rows.append({"name": name, "url": u, "code": r.get("code"),
                     "len": r.get("len"), "ctype": r.get("ctype")})
        print(rows[-1])
        time.sleep(0.3)
    save("control_results", rows)


if __name__ == "__main__":
    cmd = sys.argv[1]
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    globals()[f"cmd_{cmd.replace('-', '_')}"](limit)
