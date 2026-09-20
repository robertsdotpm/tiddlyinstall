#!/usr/bin/env python3
"""Re-runnable HEAD/GET prober for the Ruby mirror hunt (round 2, hash-search pass).

Usage:
    python3 probe.py head <url> [<url> ...]        # HEAD, redirects disabled
    python3 probe.py follow <url> [<url> ...]      # HEAD, following redirects, print final host
    python3 probe.py file <path-with-one-url-per-line>

Prints one TSV line per URL:  status  content-length  final-host  location  url

Everything fetched is untrusted data; this script only ever records status codes,
sizes and hostnames -- it never executes or interprets response bodies.
"""
import concurrent.futures as cf
import sys
import urllib.error
import urllib.request

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/126.0.0.0 Safari/537.36 installer-builder-catalog")

# Some mirrors do the OPPOSITE of what MIRROR-HUNT.md's browser-UA advice
# expects: SJTU's Cerberus and Software Heritage's Anubis both challenge
# "Mozilla/..." user agents and wave plain automated clients straight
# through. Use PLAIN_UA for those hosts.
PLAIN_UA = "installer-builder-catalog/1.0 (runtime download-mirror survey)"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def probe(url, follow=False, method="HEAD", ua=UA, timeout=30):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, method=method, headers={"User-Agent": ua, "Accept": "*/*"})
    try:
        with opener.open(req, timeout=timeout) as r:
            return (r.status, r.headers.get("Content-Length", ""),
                    urllib.parse.urlsplit(r.url).netloc, r.headers.get("Location", ""), url)
    except urllib.error.HTTPError as e:
        return (e.code, e.headers.get("Content-Length", ""),
                urllib.parse.urlsplit(url).netloc, e.headers.get("Location", ""), url)
    except Exception as e:
        return ("ERR", "", urllib.parse.urlsplit(url).netloc, type(e).__name__ + ":" + str(e)[:60], url)


def run(urls, follow=False, method="HEAD", workers=8, ua=UA):
    out = []
    with cf.ThreadPoolExecutor(workers) as ex:
        for r in ex.map(lambda u: probe(u, follow, method, ua), urls):
            out.append(r)
    return out


if __name__ == "__main__":
    import urllib.parse
    mode = sys.argv[1]
    if mode == "file":
        urls = [l.strip() for l in open(sys.argv[2]) if l.strip()]
    else:
        urls = sys.argv[2:]
    for r in run(urls, follow=(mode == "follow")):
        print("\t".join(str(x) for x in r))
else:
    import urllib.parse
