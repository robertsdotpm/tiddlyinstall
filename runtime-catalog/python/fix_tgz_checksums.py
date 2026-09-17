#!/usr/bin/env python3
"""Post-process python.org source .tgz entries whose API checksum describes the
decompressed tarball.

python.org's downloads API records md5_sum and filesize of the *uncompressed*
tar for many old `.tgz` source files (e.g. Python-2.5.6.tgz: API says 50,155,520
bytes and md5 e835cfc2…, which match `gunzip -c`; the served file is 11,608,002
bytes). For every .tgz entry, HEAD the URL; if the served size differs from the
API's filesize, keep the vendor checksum but mark it `applies_to: decompressed`
and store the served size. Run after scrape.py.
"""
import concurrent.futures as cf
import json
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent


def head_size(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "installer-builder-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return int(r.headers.get("Content-Length") or 0)


API = "https://www.python.org/api/v2/downloads/release_file/"


def api_sizes():
    req = urllib.request.Request(API, headers={"User-Agent": "installer-builder-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return {f["url"].replace("http://", "https://"): f.get("filesize") for f in json.load(r)}


def fix(name, api):
    path = HERE / name
    entries = json.loads(path.read_text())
    targets = [e for e in entries if e["url"].endswith(".tgz") and e.get("checksum")
               and e["checksum"].get("applies_to") != "decompressed"]
    with cf.ThreadPoolExecutor(10) as ex:
        served = dict(zip([e["url"] for e in targets], ex.map(lambda e: head_size(e["url"]), targets)))
    changed = 0
    for e in targets:
        api_size = api.get(e["url"].replace("http://", "https://"))
        real = served[e["url"]]
        if api_size and real and api_size != real:
            e["checksum"]["applies_to"] = "decompressed"
            e["notes"] = ((e.get("notes") or "") + f" python.org API size {api_size} and checksum describe the decompressed tar; served file is {real} bytes.").strip()
            e["size"] = real
            changed += 1
    path.write_text(json.dumps(entries, indent=1))
    print(f"{name}: {len(targets)} .tgz entries checked, {changed} marked decompressed")


api = api_sizes()
for n in ("releases.json", "download_plan.json"):
    fix(n, api)
