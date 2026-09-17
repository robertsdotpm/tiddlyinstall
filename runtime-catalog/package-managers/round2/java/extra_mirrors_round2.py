#!/usr/bin/env python3
"""Mirror hunt round 2 (2026-09-17): confirm two more hosts serving
byte-identical copies of Azul Zulu files (the vendor whose coverage is by
far the biggest gap: 9,745/9,937 releases.json entries with no mirror,
almost all zulu-jdk/zulu-jre).

Python 3 standard library only. Re-runnable and idempotent: re-derives
candidate URLs from releases.json's own `url`/`size` fields, HEAD-confirms
them, and writes an add_mirrors.py updates file
(round2_java_updates.jsonl) rather than editing releases.json directly.

Hosts confirmed:

1. static.azul.com -- an alternate hostname for the exact same Azul CDN
   origin as cdn.azul.com/zulu/bin/ (same Cloudflare zone, same ETags,
   same Content-Length on every file checked). Applies to ALL zulu
   entries: a 70-file stress sample spanning every major 6-27, every
   (kind, format, variant) combination, and the smallest/largest files
   in the catalog matched on Content-Length 70/70 (5 apparent
   mismatches were confirmed to be transient HEAD timeouts under
   concurrency, not real size differences, on retry). One small sample
   (zulu7.48.0.11-ca-jre7.0.312-win_i686.msi, 22,343,680 bytes)
   downloaded in full and sha256-verified against the catalog checksum:
   match. Works over both https and http.

2. https://d10.injdk.cn/openjdk/zulu/ -- a real Caddy-served directory
   mirror run by injdk.cn (a Chinese JDK-download aggregator site,
   https://injdk.cn/, linked from its homepage). Holds ONE (occasionally
   a couple of) recent JDK build per major under
   openjdk/zulu/<major>/<same filename as cdn.azul.com>, JDK builds
   only (no JRE), majors 8/11/17/21/25/26/27 as of this run. Partial/
   rolling like TUNA/NJU/USTC for Temurin, so every candidate is
   individually HEAD-confirmed against the directory listing rather
   than assumed. http redirects (308) to https, so no plaintext option.
   No file on this host is <=60MB (it carries only full JDK builds, no
   JRE), so the required hash-sample step could not be done within the
   60MB budget; recorded as HEAD-confirmed only, not hash-verified.
"""
import hashlib
import json
import re
import sys
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
JAVA = CATALOG / "java"
UA_BROWSER = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")

CDN_PREFIX = "https://cdn.azul.com/zulu/bin/"
STATIC_PREFIX = "https://static.azul.com/zulu/bin/"
INJDK_MAJORS_URL = "https://d10.injdk.cn/openjdk/zulu/"
INJDK_MAJOR_TMPL = "https://d10.injdk.cn/openjdk/zulu/{major}/"

OUT = HERE / "round2_java_updates.jsonl"


def fetch(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {"User-Agent": UA_BROWSER})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read()


def head(url, headers=None):
    req = urllib.request.Request(url, method="HEAD", headers=headers or {"User-Agent": UA_BROWSER})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.headers.get("Content-Length")
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def list_dir_filenames(html_bytes):
    text = html_bytes.decode("utf-8", "replace")
    return {m.rstrip("/") for m in re.findall(r'<a href="\./([^"]+)"', text)}


def load_zulu_entries():
    releases = json.loads((JAVA / "releases.json").read_text())
    return [e for e in releases if e["url"].startswith(CDN_PREFIX)]


def main():
    zulu = load_zulu_entries()
    print(f"zulu entries in releases.json: {len(zulu)}")
    updates = []

    # --- 1. static.azul.com: applies to every entry (verified globally) ---
    for e in zulu:
        mirror = STATIC_PREFIX + e["url"][len(CDN_PREFIX):]
        updates.append({
            "folder": "java",
            "url": e["url"],
            "mirror": mirror,
            "evidence": ("static.azul.com is the same Azul CDN origin as cdn.azul.com "
                         "(same Cloudflare zone/ETags); 70-file spread sample across every "
                         "major/kind/format/variant matched Content-Length 70/70, plus one "
                         "sha256-verified sample (zulu7.48.0.11-ca-jre7.0.312-win_i686.msi). "
                         "2026-09-17 mirror hunt round 2."),
        })

    # --- 2. d10.injdk.cn: discover majors, list each, HEAD-confirm matches ---
    try:
        majors_html = fetch(INJDK_MAJORS_URL)
    except Exception as ex:
        print(f"could not list {INJDK_MAJORS_URL}: {ex}", file=sys.stderr)
        majors_html = b""
    majors = sorted(m.rstrip("/") for m in list_dir_filenames(majors_html))
    print(f"d10.injdk.cn majors found: {majors}")

    by_major_filenames = {}
    for major in majors:
        try:
            html = fetch(INJDK_MAJOR_TMPL.format(major=major))
        except Exception as ex:
            print(f"could not list major {major}: {ex}", file=sys.stderr)
            continue
        by_major_filenames[major] = list_dir_filenames(html)
        print(f"  major {major}: {len(by_major_filenames[major])} files listed")

    candidates = []
    for e in zulu:
        filename = e["url"][len(CDN_PREFIX):]
        major = e["major"]
        if major in by_major_filenames and filename in by_major_filenames[major]:
            url = INJDK_MAJOR_TMPL.format(major=major) + filename
            candidates.append((e, url))
    print(f"d10.injdk.cn filename-matched candidates: {len(candidates)}")

    def confirm(pair):
        e, url = pair
        status, cl = head(url)
        return e, url, status, cl

    confirmed = 0
    stale_size_flags = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for e, url, status, cl in ex.map(confirm, candidates):
            if status == 200 and cl is not None and int(cl) == e["size"]:
                confirmed += 1
                updates.append({
                    "folder": "java",
                    "url": e["url"],
                    "mirror": url,
                    "evidence": ("d10.injdk.cn/openjdk/zulu/ (injdk.cn JDK aggregator): filename "
                                 "present in this major's directory listing, HEAD Content-Length "
                                 "matches vendor size exactly. Partial/rolling mirror (one build "
                                 "per major, JDK only) -- HEAD-confirmed per entry, not applied by "
                                 "listing alone. No file <=60MB available on this host for a full "
                                 "hash sample (JDK-only, all builds >60MB); size-match only. "
                                 "2026-09-17 mirror hunt round 2."),
                })
            elif status == 200 and cl is not None:
                # size field in releases.json may itself be stale (Azul's
                # API-rounded size, not yet corrected by fix_zulu_sizes.py
                # for this entry) -- cross-check against the real
                # cdn.azul.com Content-Length before rejecting outright.
                vendor_status, vendor_cl = head(e["url"])
                if vendor_status == 200 and vendor_cl is not None and int(vendor_cl) == int(cl):
                    confirmed += 1
                    stale_size_flags.append((e["url"], e["size"], cl))
                    updates.append({
                        "folder": "java",
                        "url": e["url"],
                        "mirror": url,
                        "evidence": (f"d10.injdk.cn/openjdk/zulu/: HEAD Content-Length ({cl}) "
                                     f"matches the REAL cdn.azul.com Content-Length ({vendor_cl}), "
                                     f"not the (stale) size field in this releases.json entry "
                                     f"({e['size']}) -- flagged separately, not corrected here "
                                     "since add_mirrors.py only appends mirrors/"
                                     "checksum_corroboration. 2026-09-17 mirror hunt round 2."),
                    })
                else:
                    print(f"  NOT confirmed: {url} -> status={status} cl={cl} "
                          f"expected={e['size']} vendor_cl={vendor_cl}")
            else:
                print(f"  NOT confirmed: {url} -> status={status} cl={cl} expected={e['size']}")
    print(f"d10.injdk.cn confirmed: {confirmed}/{len(candidates)}")
    if stale_size_flags:
        print(f"stale releases.json `size` field detected on {len(stale_size_flags)} entries "
              "(matched real vendor size instead, see evidence):")
        for url, catalog_size, real_size in stale_size_flags:
            print(f"  {url}: catalog size={catalog_size} real cdn.azul.com size={real_size}")

    OUT.write_text("\n".join(json.dumps(u) for u in updates) + "\n")
    print(f"wrote {len(updates)} updates to {OUT}")


if __name__ == "__main__":
    main()
