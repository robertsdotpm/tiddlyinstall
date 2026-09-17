#!/usr/bin/env python3
"""Mirror hunt pass for the cc (C/C++ toolchain) runtime, 2026-09-17.

Extends the mirrors already recorded for this runtime (three GNU mirrors for
GCC source) with:

  - 13 more GNU mirrors (globally spread: Americas, Asia, Oceania, Africa,
    more Europe), applied to every gcc/source releases.json entry.
  - The NJU "github-release" mirror (mirror.nju.edu.cn/github-release/...),
    which carries only the *newest* release of a handful of GitHub projects.
    It has llvm/llvm-project (latest tag only) and brechtsanders/winlibs_mingw
    (a short rolling window of recent tags), but NOT skeeto/w64devkit.
  - Wayback Machine snapshots for the pre-GitHub LLVM releases
    (releases.llvm.org, majors 3.4-6), which is a partial archive: every
    candidate is HEAD-checked individually, never assumed.

Rejected (see NOTES.md "Mirror hunt (2026-09-17)" for detail): TUNA's
github-release path (403, bot-mitigation WAF blocks this network entirely,
independent of URL), USTC's github-release path (mirrors a curated project
list that does not include llvm-project or winlibs_mingw), the old
mirrors.tuna.tsinghua.edu.cn/llvm-releases and mirror.nju.edu.cn/llvm-releases
paths (404 / not found), w64devkit on any of the three CN mirrors (none
carry it), and the winlibs-mingw SourceForge project (Cloudflare bot
challenge blocks every request from this network, so it could not be
confirmed one way or the other).

Re-runnable and idempotent: HEAD-check results are cached in
extra_mirrors_cache.json beside this script, keyed by the exact candidate
URL, so re-running only does network work for entries that are new or not
yet resolved. Only ever appends to a `mirrors` list; never touches `url`,
`runtime`, `os`, `arch`, `version`, `variant` or `checksum`. Every JSON file
is written atomically (temp file + os.replace).
"""
import glob
import http.cookiejar
import json
import os
import re
import time
import urllib.error
import urllib.request
from html import unescape
from urllib.parse import quote, unquote

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE_PATH = os.path.join(HERE, "extra_mirrors_cache.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# Wayback checking is slow and rate-limited from this network; cap how long
# we spend on it per run so a re-run never hangs indefinitely.
WAYBACK_TIME_BUDGET_SECONDS = 90


def atomic_write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def load_cache():
    if os.path.exists(CACHE_PATH):
        try:
            with open(CACHE_PATH) as f:
                return json.load(f)
        except Exception:
            pass
    return {"head": {}, "listings": {}}


def save_cache(cache):
    atomic_write_json(CACHE_PATH, cache)


_cookiejar = http.cookiejar.CookieJar()
_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cookiejar))


def http_request(url, method="GET", timeout=20):
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    try:
        with _opener.open(req, timeout=timeout) as resp:
            body = resp.read() if method == "GET" else b""
            return resp.status, dict(resp.headers), body
    except urllib.error.HTTPError as e:
        try:
            body = e.read() if method == "GET" else b""
        except Exception:
            body = b""
        return e.code, dict(e.headers or {}), body
    except Exception:
        return None, {}, b""


_nju_warmed = False


def warm_nju():
    """NJU's mirror sets a bot-check cookie on the first hit and 302s back
    to the same URL; a plain GET on the root does the warm-up once per run."""
    global _nju_warmed
    if _nju_warmed:
        return
    http_request("https://mirror.nju.edu.cn/github-release/", method="GET")
    _nju_warmed = True


def head_size(url, cache, retries=3):
    if url in cache["head"]:
        return cache["head"][url]
    if "mirror.nju.edu.cn" in url:
        warm_nju()
    status, headers = None, {}
    for attempt in range(retries):
        status, headers, _ = http_request(url, method="HEAD")
        if status is not None:
            break
        time.sleep(1.5 * (attempt + 1))  # transient network hiccup: back off and retry
    if status is None:
        # Never got a real HTTP response after retries -- don't cache a
        # negative result, so a later run (once the network/host recovers)
        # tries again instead of treating a timeout as "mirror lacks this".
        return {"status": None, "length": None}
    length = headers.get("Content-Length")
    result = {"status": status, "length": int(length) if length else None}
    cache["head"][url] = result
    return result


def confirmed(url, cache, expected_size):
    r = head_size(url, cache)
    return r["status"] == 200 and r["length"] == expected_size


def load_json(path):
    with open(path) as f:
        return json.load(f)


def entry_files(cc_dir):
    files = [os.path.join(cc_dir, "releases.json")]
    files += sorted(glob.glob(os.path.join(cc_dir, "download_plan*.json")))
    return files


def add_mirror(entry, mirror_url):
    if mirror_url not in entry["mirrors"]:
        entry["mirrors"].append(mirror_url)
        return True
    return False


# ---------------------------------------------------------------------------
# Category 1: GNU mirror list, applied to every gcc/source entry.
# All 13 confirmed 13/13 (every gcc source version, HEAD size match) on both
# https and http as of 2026-09-17. mirror.twds.com.tw enforces a low
# concurrent-connection limit (rejects concurrent HEADs with a connection
# reset) but works fine one request at a time -- kept sequential here.
# ---------------------------------------------------------------------------
GNU_MIRROR_TEMPLATES = [
    ("uwaterloo (Canada)", "https://mirror.csclub.uwaterloo.ca/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("OCF Berkeley (USA)", "https://mirrors.ocf.berkeley.edu/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("UFPR (Brazil)", "https://gnu.c3sl.ufpr.br/ftp/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("JAIST (Japan)", "https://ftp.jaist.ac.jp/pub/GNU/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("KAIST (South Korea)", "https://ftp.kaist.ac.kr/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("TWDS (Taiwan)", "https://mirror.twds.com.tw/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("Lagoon (New Caledonia)", "https://mirror.lagoon.nc/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("University of the Free State (South Africa)", "https://mirror.ufs.ac.za/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("MARWAN (Morocco)", "https://mirror.marwan.ma/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("NLUUG (Netherlands)", "https://ftp.nluug.nl/pub/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("RedIRIS (Spain)", "https://ftp.rediris.es/mirror/GNU/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("ICM University of Warsaw (Poland)", "https://sunsite.icm.edu.pl/pub/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
    ("TrueNetwork (Russia)", "https://mirror.truenetwork.ru/gnu/gcc/gcc-{v}/gcc-{v}.{f}"),
]


def apply_gnu_mirrors(entries_by_file, cache):
    added = 0
    for path, entries in entries_by_file.items():
        for e in entries:
            if not (e["runtime"] == "gcc" and e["kind"] == "source"):
                continue
            for _name, tmpl in GNU_MIRROR_TEMPLATES:
                url = tmpl.format(v=e["version"], f=e["format"])
                if url in e["mirrors"]:
                    continue
                if confirmed(url, cache, e["size"]):
                    if add_mirror(e, url):
                        added += 1
    return added


# ---------------------------------------------------------------------------
# Category 2: NJU github-release mirror -- llvm/llvm-project and
# brechtsanders/winlibs_mingw. Only carries a rolling window of recent
# releases, so directories are listed live and every candidate file is
# HEAD-checked; nothing is assumed from a version-substitution template.
# ---------------------------------------------------------------------------
NJU_BASE = "https://mirror.nju.edu.cn/github-release"

_DIR_RE = re.compile(r'<td colspan="2" class="link"><a href="([^"]+)"')


def list_nju_dir(path, cache):
    """Return {href: absolute_url} for subentries of an NJU directory,
    excluding the parent-directory link and the aggregate LatestRelease/ link
    (which duplicates whichever versioned directory is newest)."""
    cache_key = f"listing:{path}"
    if cache_key in cache["listings"]:
        return cache["listings"][cache_key]
    warm_nju()
    url = f"{NJU_BASE}/{path}"
    status, _headers, body = http_request(url, method="GET")
    result = {}
    if status == 200:
        html = body.decode("utf-8", "replace")
        for href in _DIR_RE.findall(html):
            if href in ("../", "LatestRelease/"):
                continue
            result[unquote(href)] = url + href
    cache["listings"][cache_key] = result
    return result


_FILE_RE = re.compile(r'<tr><td colspan="2" class="link"><a href="([^"]+)"')


def list_nju_files(dir_url, cache):
    cache_key = f"files:{dir_url}"
    if cache_key in cache["listings"]:
        return cache["listings"][cache_key]
    warm_nju()
    status, _headers, body = http_request(dir_url, method="GET")
    result = {}
    if status == 200:
        html = body.decode("utf-8", "replace")
        for href in _FILE_RE.findall(html):
            if href.startswith("?") or href == "../":
                continue
            fname = unquote(href)
            result[fname] = dir_url + href
    cache["listings"][cache_key] = result
    return result


def apply_nju_mirrors(entries_by_file, cache):
    added = 0

    # llvm/llvm-project: versioned subdirectories, e.g. "LLVM 23.1.1/"
    llvm_dirs = list_nju_dir("llvm/llvm-project/", cache)
    llvm_file_map = {}
    for _name, dir_url in llvm_dirs.items():
        llvm_file_map.update(list_nju_files(dir_url, cache))

    # brechtsanders/winlibs_mingw: subdirectories are the human-readable
    # release title, not the GitHub tag, so match purely by filename.
    winlibs_dirs = list_nju_dir("brechtsanders/winlibs_mingw/", cache)
    winlibs_file_map = {}
    for _name, dir_url in winlibs_dirs.items():
        winlibs_file_map.update(list_nju_files(dir_url, cache))

    combined = {}
    combined.update(llvm_file_map)
    combined.update(winlibs_file_map)

    for path, entries in entries_by_file.items():
        for e in entries:
            if e["runtime"] not in ("llvm", "gcc"):
                continue
            fname = e["url"].rsplit("/", 1)[-1]
            fname_decoded = unquote(fname)
            candidate = combined.get(fname_decoded) or combined.get(fname)
            if not candidate or candidate in e["mirrors"]:
                continue
            if confirmed(candidate, cache, e["size"]):
                if add_mirror(e, candidate):
                    added += 1
    return added


# ---------------------------------------------------------------------------
# Category 3: Wayback Machine for releases.llvm.org (LLVM majors 3.4-6).
# Confirmed partial: the CDX index is queried once for the whole domain,
# then every releases.json entry under releases.llvm.org is individually
# HEAD-checked against its most recent snapshot before being trusted -- per
# the brief, a rolling/partial mirror is never applied by template alone.
# Time-boxed and gently paced (archive.org rate-limits this network hard).
# ---------------------------------------------------------------------------
CDX_URL = ("https://web.archive.org/cdx/search/cdx?url=releases.llvm.org"
           "&matchType=domain&output=json&fl=original,timestamp,statuscode,length"
           r"&filter=statuscode:200&filter=original:.*\.(tar\.(xz|gz|bz2)|exe|zip)$"
           "&collapse=urlkey&limit=5000")


def load_cdx(cache):
    if "cdx" in cache["listings"]:
        return cache["listings"]["cdx"]
    rows = {}
    got_data = False
    for attempt in range(3):
        status, _headers, body = http_request(CDX_URL, method="GET", timeout=30)
        if status == 200:
            try:
                data = json.loads(body.decode("utf-8", "replace"))
                for orig, ts, _code, _length in data[1:]:
                    path = orig.split("://", 1)[1]
                    rows.setdefault(path, []).append(ts)
                got_data = True
                break
            except Exception:
                pass
        time.sleep(2.0 * (attempt + 1))
    if not got_data:
        # archive.org didn't answer (rate limit / network hiccup): don't cache
        # an empty result, or every entry would be wrongly recorded as "not
        # archived" and never re-checked on a later run.
        return {}
    cache["listings"]["cdx"] = rows
    return rows


def apply_wayback_mirrors(entries_by_file, cache):
    added = 0
    cdx = load_cdx(cache)
    if not cdx:
        # CDX fetch failed even after retries -- skip this category for this
        # run rather than caching every entry as "not archived".
        print("  wayback: CDX index unavailable this run, skipping (will retry next run)")
        return added
    deadline = time.monotonic() + WAYBACK_TIME_BUDGET_SECONDS
    for path, entries in entries_by_file.items():
        for e in entries:
            if e["runtime"] != "llvm" or not e["url"].startswith("https://releases.llvm.org/"):
                continue
            wb_key = f"wb:{e['url']}"
            if wb_key in cache["head"]:
                cached = cache["head"][wb_key]
                if cached.get("mirror_url") and cached["mirror_url"] not in e["mirrors"]:
                    if cached["status"] == 200 and cached["length"] == e["size"]:
                        if add_mirror(e, cached["mirror_url"]):
                            added += 1
                continue
            if time.monotonic() > deadline:
                continue  # out of time budget this run; try again next run
            url_path = e["url"].split("://", 1)[1]
            ts_list = cdx.get(url_path)
            if not ts_list:
                cache["head"][wb_key] = {"status": None, "length": None, "mirror_url": None}
                continue
            ts = sorted(ts_list)[-1]
            mirror_url = f"https://web.archive.org/web/{ts}id_/{e['url']}"
            status, headers = None, {}
            for attempt in range(3):
                status, headers, _ = http_request(mirror_url, method="HEAD", timeout=25)
                if status is not None:
                    break
                time.sleep(1.5 * (attempt + 1))
            if status is None:
                # Never got a real response after retries: don't cache, so a
                # later run retries instead of recording a false gap.
                continue
            length = headers.get("Content-Length")
            length = int(length) if length else None
            cache["head"][wb_key] = {"status": status, "length": length, "mirror_url": mirror_url}
            if status == 200 and length == e["size"]:
                if add_mirror(e, mirror_url):
                    added += 1
            time.sleep(1.0)  # be polite to archive.org
    return added


def main():
    cc_dir = HERE
    cache = load_cache()

    files = entry_files(cc_dir)
    entries_by_file = {}
    for path in files:
        entries_by_file[path] = load_json(path)

    total_added = 0
    total_added += apply_gnu_mirrors(entries_by_file, cache)
    save_cache(cache)  # checkpoint after each category: expensive to redo
    total_added += apply_nju_mirrors(entries_by_file, cache)
    save_cache(cache)
    total_added += apply_wayback_mirrors(entries_by_file, cache)
    save_cache(cache)

    for path, entries in entries_by_file.items():
        atomic_write_json(path, entries)

    print(f"extra_mirrors.py: appended {total_added} mirror URLs across {len(files)} files")
    for path, entries in entries_by_file.items():
        with_mirrors = sum(1 for e in entries if e["mirrors"])
        print(f"  {os.path.basename(path)}: {with_mirrors}/{len(entries)} entries have >=1 mirror")


if __name__ == "__main__":
    main()
