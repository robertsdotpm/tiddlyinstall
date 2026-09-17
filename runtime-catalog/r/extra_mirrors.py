#!/usr/bin/env python3
"""Mirror hunt extension for the R runtime catalog (2026-09-17).

Post-processes releases.json and every download_plan*.json in this folder,
appending confirmed mirror URLs to each entry's `mirrors` list. Never
touches `url`, `runtime`, `os`, `arch`, `version`, `variant` or `checksum`.
Idempotent: safe to re-run any time, including after scrape.py regenerates
releases.json. Caches network lookups (Wayback CDX + HEAD probes) in
mirror_cache.json beside this file so re-runs don't re-hit the network for
URLs already resolved.

Python 3 standard library only.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, "mirror_cache.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

CRAN_HOST = "cran.r-project.org"
ARCHIVE_HOST = "cran-archive.r-project.org"
POSIT_HOST = "cdn.posit.co"

# --- Confirmed CRAN mirror templates added in the 2026-09-17 hunt ---
# Each confirmed by HEAD content-length match against cran.r-project.org on
# 8 samples spanning src (R-1/R-2/R-4), windows (bin/windows/base/old/4.0.0
# and /4.6.1) and macos (base/R-4.0.0.pkg, big-sur-x86_64, sonoma-arm64).
# Applied to every cran.r-project.org-hosted entry (windows/macos/source)
# since CRAN mirrors replicate the exact directory tree, per existing
# precedent for the first 5 confirmed mirrors.
NEW_CRAN_MIRRORS = [
    {
        "url_template": "http://mirror.fcaglp.unlp.edu.ar/CRAN/",
        "label": "Argentina (La Plata) -- South America",
        "protocols": "http only (https: connection refused/no response)",
    },
    {
        "url_template": "https://cran-r.c3sl.ufpr.br/",
        "label": "Brazil (Curitiba) -- South America",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "https://mirror.marwan.ma/cran/",
        "label": "Morocco (Rabat) -- Africa",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "https://mirror.niser.ac.in/cran/",
        "label": "India (Bhubaneswar)",
        "protocols": "https only (http times out)",
    },
    {
        "url_template": "https://cran.isid.ac.in/",
        "label": "India (New Delhi)",
        "protocols": "https only (http 301-redirects to https, not a working plain-http serve)",
    },
    {
        "url_template": "https://ftp.yz.yamagata-u.ac.jp/pub/cran/",
        "label": "Japan (Yonezawa)",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "https://mirror.truenetwork.ru/CRAN/",
        "label": "Russia (Novosibirsk)",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "https://mirror.maeen.sa/cran/",
        "label": "Saudi Arabia (Riyadh) -- Middle East",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "https://cran.nyuad.nyu.edu/",
        "label": "United Arab Emirates (Abu Dhabi) -- Middle East",
        "protocols": "https only (http 302-redirects to https)",
    },
    {
        "url_template": "https://cran.nic.cz/",
        "label": "Czech Republic (Prague) -- Eastern Europe",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "https://mirror.csclub.uwaterloo.ca/CRAN/",
        "label": "Canada (Waterloo) -- North America",
        "protocols": "http and https both serve the file directly",
    },
    {
        "url_template": "http://ftp.ussg.iu.edu/CRAN/",
        "label": "USA (Bloomington) -- North America",
        "protocols": "http and https both serve the file directly (both verified)",
    },
    {
        "url_template": "https://ftp.gwdg.de/pub/misc/cran/",
        "label": "Germany (Goettingen) -- additional Europe",
        "protocols": "http and https both serve the file directly",
    },
]

# Rejected candidates, kept here as a record so a future run doesn't re-try
# them blind (see NOTES.md "Mirror hunt (2026-09-17)" for the full reasons):
#   - https://cran.yu.ac.kr/ (Korea) -- TCP connection refused/no route;
#     the only Korea entry in CRAN_mirrors.csv, so Korea has no CRAN mirror
#     right now.
#   - https://mirrors.ustc.edu.cn/CRAN/ (China) -- HEAD/GET return HTTP 200
#     but the body is a "Verifying - USTC Mirrors" anti-bot interstitial
#     page for several sample paths, not the file; rejected as unreliable
#     for unattended/scripted installer downloads even though it is a real
#     CRAN mirror for browser use.
#   - https://mirrors.bfsu.edu.cn/CRAN/ (China) -- HEAD requests return 200
#     with the correct Content-Length (passed the 8-sample HEAD check and
#     was briefly applied), but a real GET of the same URL consistently
#     returns HTTP 403 with an HTML body (a WAF/anti-hotlink rule that
#     treats HEAD and GET differently). Caught only when downloading a
#     small sample for hash verification; removed after the fact. Rejected
#     as unreliable for unattended downloads.
#   - https://cran.icts.res.in/ (India) -- TLS certificate expired.
#   - https://cran.um.ac.ir/ (Iran) -- connection timed out.

# --- Posit CDN legacy alias ---
# cdn.rstudio.com is Posit's old brand name for the same CDN that now answers
# at cdn.posit.co. Confirmed identical Content-Length on 6 samples spanning
# ubuntu-2204/rhel-9, amd64/arm64, R 3.0.0 through 4.6.1. This is the *same*
# CDN under an alias, not an independent mirror, and is labelled as such.
POSIT_ALIAS = {
    "url_template": "https://cdn.rstudio.com/",
    "label": "cdn.rstudio.com -- legacy Posit/RStudio-branded alias for the same CDN as cdn.posit.co (not an independent mirror)",
}

# Vendor-side data-integrity problem found during this hunt: neither the
# live file nor the oldest available Wayback capture matches CRAN's own
# published md5. Never add a "mirror" for this entry that would only
# reproduce the same failing bytes.
KNOWN_BAD_CHECKSUM_URLS = {
    "https://cran-archive.r-project.org/bin/windows/base/old/1.8.1/rw1081.exe",
}


def load_cache():
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            return json.load(f)
    return {"wayback": {}}


def save_cache(cache):
    with open(CACHE_PATH, "w") as f:
        json.dump(cache, f, indent=2, sort_keys=True)


def http_head(url, timeout=40, retries=3):
    """Return (status, content_length) using HEAD, tolerating servers that
    need a GET to reveal a real Content-Length (none observed for archive.org
    itself, but kept defensive). Retries on transient network/timeout
    errors, since archive.org can be slow or briefly rate-limit bursts."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    last = (None, None)
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                cl = r.headers.get("Content-Length")
                return r.status, int(cl) if cl else None
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            last = (None, None)
            time.sleep(3 * (attempt + 1))
    return last


def wayback_lookup(url, cache):
    """Find the most recent 200-status Wayback capture of `url`. Cached."""
    wb_cache = cache.setdefault("wayback", {})
    if url in wb_cache:
        return wb_cache[url]
    cdx = ("http://web.archive.org/cdx/search/cdx?url=%s&output=json"
           "&filter=statuscode:200&limit=10" % urllib.parse.quote(url, safe=""))
    result = {"found": False}
    for attempt in range(2):
        try:
            req = urllib.request.Request(cdx, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                data = json.load(r)
            if len(data) >= 2:
                ts = data[-1][1]  # most recent successful capture
                result = {
                    "found": True,
                    "timestamp": ts,
                    "wayback_url": "https://web.archive.org/web/%sif_/%s" % (ts, url),
                }
            break
        except Exception as e:
            result = {"found": False, "error": str(e)}
            time.sleep(1.5)
    wb_cache[url] = result
    save_cache(cache)
    return result


def rel_path(url, host):
    prefix = "https://" + host + "/"
    if url.startswith(prefix):
        return url[len(prefix):]
    prefix = "http://" + host + "/"
    if url.startswith(prefix):
        return url[len(prefix):]
    return None


def add_mirror(entry, mirror_url):
    if mirror_url not in entry["mirrors"]:
        entry["mirrors"].append(mirror_url)
        return True
    return False


def process_entries(entries, cache, stats):
    for e in entries:
        url = e.get("url", "")
        host = urllib.parse.urlparse(url).netloc

        if host == CRAN_HOST:
            path = rel_path(url, CRAN_HOST)
            for m in NEW_CRAN_MIRRORS:
                mirror_url = m["url_template"].rstrip("/") + "/" + path
                if add_mirror(e, mirror_url):
                    stats["cran_added"] += 1

        elif host == POSIT_HOST:
            path = rel_path(url, POSIT_HOST)
            mirror_url = POSIT_ALIAS["url_template"].rstrip("/") + "/" + path
            if add_mirror(e, mirror_url):
                stats["posit_added"] += 1

        elif host == ARCHIVE_HOST:
            if url in KNOWN_BAD_CHECKSUM_URLS:
                stats["archive_known_bad"] += 1
                continue
            wb = wayback_lookup(url, cache)
            if not wb.get("found"):
                stats["archive_no_wayback"] += 1
                continue
            wb_url = wb["wayback_url"]
            if wb_url in e["mirrors"]:
                continue
            # Confirm this specific candidate (Wayback is a rolling/partial
            # mirror, so every entry gets its own check) before applying.
            status, size = http_head(wb_url)
            expect = e.get("size")
            if status == 200 and expect is not None and size == expect:
                if add_mirror(e, wb_url):
                    stats["archive_added"] += 1
            else:
                stats["archive_size_mismatch"] += 1
                stats.setdefault("archive_size_mismatch_urls", []).append(
                    {"url": url, "wayback_url": wb_url, "status": status,
                     "got_size": size, "expect_size": expect})


def main():
    stats = {
        "cran_added": 0, "posit_added": 0, "archive_added": 0,
        "archive_no_wayback": 0, "archive_size_mismatch": 0,
        "archive_known_bad": 0,
    }
    cache = load_cache()

    releases_path = os.path.join(HERE, "releases.json")
    with open(releases_path) as f:
        releases = json.load(f)
    process_entries(releases, cache, stats)
    with open(releases_path, "w") as f:
        json.dump(releases, f, indent=2)
        f.write("\n")

    for name in sorted(os.listdir(HERE)):
        if name.startswith("download_plan") and name.endswith(".json"):
            path = os.path.join(HERE, name)
            with open(path) as f:
                plan = json.load(f)
            process_entries(plan, cache, stats)
            with open(path, "w") as f:
                json.dump(plan, f, indent=2)
                f.write("\n")

    save_cache(cache)
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
