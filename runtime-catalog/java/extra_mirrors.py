#!/usr/bin/env python3
"""Mirror hunt (2026-09-17): apply two more confirmed Temurin (Adoptium)
mirrors on top of the existing TUNA one, to releases.json and every
download_plan*.json in this folder.

Python 3 standard library only. Re-runnable and idempotent: it re-derives
candidate URLs from the public fields of each release entry (url, major,
os, arch, libc, variant, size), HEAD-confirms them (caching results in
extra_mirrors_cache.json beside this script so reruns are cheap), and only
appends a URL to an entry's `mirrors` list if it isn't already there. It
never touches `url`, `runtime`, `os`, `arch`, `major`, `version`, `variant`
or `checksum`.

Mirrors added:

- NJU (Nanjing University), https://mirror.nju.edu.cn/adoptium/ -- an exact
  layout clone of the existing TUNA mirror
  (<major>/<jdk|jre>/<arch>/<os>/<filename>), also latest-build-only per
  major/image_type/arch/os (confirmed by directory browsing: each leaf
  directory holds exactly one file). Needs a `bcheck=true` cookie -- the
  first request without it 302s to the same URL and sets that cookie;
  every request here sends it up front.
- USTC (University of Science and Technology of China),
  https://mirrors.ustc.edu.cn/adoptium/releases/ -- a GitHub-release-layout
  clone (temurin<N>-binaries/<tag>/<filename>, same filenames and tag
  strings as github.com/adoptium/temurin<N>-binaries/releases/download/...),
  but only one tag per major (whichever it last synced -- observed stale
  for some majors, e.g. major 21 sitting on 21.0.9 while upstream is
  already on 21.0.12.1). Its directory *listings* work with no fuss; an
  actual file GET/HEAD returns a small "Verifying your browser" HTML page
  that sets a cookie `addr=<your IP as it saw it>` and reloads -- no JS
  engine needed, just read the IP out of that page once and resend it.

Both are treated as partial/rolling like the existing TUNA entry, so every
candidate this script builds is individually HEAD-checked; nothing is
applied on the strength of a directory listing alone.
"""
import hashlib
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
CACHE_FILE = HERE / "extra_mirrors_cache.json"

NJU_TEMPLATE = "https://mirror.nju.edu.cn/adoptium/{major}/{image_type}/{arch}/{os}/{filename}"
NJU_HEADERS = {"User-Agent": UA, "Cookie": "bcheck=true"}

USTC_RELEASES_INDEX = "https://mirrors.ustc.edu.cn/adoptium/releases/"

# Same reverse mapping scrape.py uses going the other way (see
# ADOPTIUM_ARCH_MAP / ADOPTIUM_OS_MAP there).
ARCH_TO_ADOPTIUM = {"amd64": "x64", "x86": "x86", "arm64": "aarch64", "armv7": "arm"}
OS_LIBC_TO_ADOPTIUM = {
    ("linux", "glibc"): "linux",
    ("linux", "musl"): "alpine-linux",
    ("macos", None): "mac",
    ("windows", None): "windows",
}
IMAGE_TYPE_FROM_VARIANT = {"temurin-jdk": "jdk", "temurin-jre": "jre"}

GITHUB_ADOPTIUM_PREFIX = "https://github.com/adoptium/"


def is_temurin(entry):
    return entry.get("url", "").startswith(GITHUB_ADOPTIUM_PREFIX)


def fetch_text(url, headers=None, timeout=20, tries=3):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    last_err = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 - best-effort retry
            last_err = e
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_err}")


def head_size(url, headers=None, timeout=15):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cl = r.headers.get("Content-Length")
            ctype = r.headers.get("Content-Type", "")
            return r.status, (int(cl) if cl else None), ctype
    except urllib.error.HTTPError as e:
        return e.code, None, None
    except Exception:
        return None, None, None


# ---------------------------------------------------------------------------
# NJU candidates: same shape as the existing TUNA mirror confirmation.
# ---------------------------------------------------------------------------

def nju_candidate(entry):
    variant = entry.get("variant")
    image_type = IMAGE_TYPE_FROM_VARIANT.get(variant)
    arch = ARCH_TO_ADOPTIUM.get(entry.get("arch"))
    os_key = (entry.get("os"), entry.get("libc"))
    adopt_os = OS_LIBC_TO_ADOPTIUM.get(os_key)
    if image_type is None or arch is None or adopt_os is None:
        return None
    filename = entry["url"].rsplit("/", 1)[-1]
    return NJU_TEMPLATE.format(major=entry["major"], image_type=image_type, arch=arch, os=adopt_os, filename=filename)


def latest_temurin_group_key(entry):
    return (entry["major"], entry.get("variant"), entry.get("os"), entry.get("arch"), entry.get("libc"))


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v))


def pick_latest_temurin(entries):
    """One entry per (major, variant, os, arch, libc): the highest version.
    Mirrors what confirm_tuna_mirrors() in scrape.py relies on (the private
    _is_latest flag it computed before stripping); we don't have that flag
    here since it's not written to releases.json, so we recompute it from
    the public version string."""
    best = {}
    for e in entries:
        if not is_temurin(e):
            continue
        key = latest_temurin_group_key(e)
        if key not in best or version_tuple(e["version"]) > version_tuple(best[key]["version"]):
            best[key] = e
    return list(best.values())


# ---------------------------------------------------------------------------
# USTC candidates: discover the one tag per major it actually has, then
# match entries whose GitHub release URL uses that same tag.
# ---------------------------------------------------------------------------

DIR_RE = re.compile(r'href="([^"]+/)"')


def ustc_discover_tags():
    """Returns {major_str: set-of-url-encoded-tag-strings-as-seen-in-hrefs}."""
    index_html = fetch_text(USTC_RELEASES_INDEX)
    major_dirs = re.findall(r'href="(/adoptium/releases/temurin(\d+)-binaries/)"', index_html)
    tags = {}
    for path, major in major_dirs:
        sub_html = fetch_text("https://mirrors.ustc.edu.cn" + path)
        for href in DIR_RE.findall(sub_html):
            if not href.startswith("/adoptium/releases/temurin"):
                continue
            name = href.rstrip("/").rsplit("/", 1)[-1]
            if name in ("LatestRelease", "deb", "rpm") or name == path.rstrip("/").rsplit("/", 1)[-1]:
                continue
            tags.setdefault(major, set()).add(name)
    return tags


def ustc_candidate(entry, tags_by_major):
    if not is_temurin(entry):
        return None
    major = entry["major"]
    if major not in tags_by_major:
        return None
    # tag as it appears (URL-encoded) inside this entry's own GitHub URL,
    # e.g. .../releases/download/jdk-21.0.9%2B10/OpenJDK...
    m = re.search(r"/releases/download/([^/]+)/", entry["url"])
    if not m:
        return None
    tag = m.group(1)
    if tag not in tags_by_major[major]:
        return None
    return entry["url"].replace(
        "https://github.com/adoptium/", "https://mirrors.ustc.edu.cn/adoptium/releases/"
    ).replace("/releases/download/", "/")


_ustc_ip = None


def ustc_headers(probe_file_url):
    """USTC gates actual file GET/HEAD (not directory listings, which work
    with no fuss) behind a one-time 'Verifying your browser' page that just
    wants its own view of your IP echoed back as a cookie. Hit any real file
    URL once without the cookie, read the IP out of the challenge page's
    body, and reuse it for every subsequent request this run."""
    global _ustc_ip
    if _ustc_ip is not None:
        return {"Cookie": f"addr={_ustc_ip}"}
    body = fetch_text(probe_file_url)
    m = re.search(r"Your IP address is ([0-9a-fA-F:.]+)", body)
    _ustc_ip = m.group(1) if m else ""
    return {"Cookie": f"addr={_ustc_ip}"}


# ---------------------------------------------------------------------------
# generic HEAD-confirm + cache
# ---------------------------------------------------------------------------

def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {}


def save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


def confirm_candidates(name, pairs, headers, cache, max_workers=10, delay=0.0):
    """pairs: list of (entry_url, entry_size, candidate_url). Returns dict
    entry_url -> confirmed candidate_url, using/populating cache[name]."""
    bucket = cache.setdefault(name, {})
    confirmed = {}
    to_check = []
    for entry_url, entry_size, cand in pairs:
        cached = bucket.get(cand)
        if cached is not None:
            if cached.get("confirmed"):
                confirmed[entry_url] = cand
            continue
        to_check.append((entry_url, entry_size, cand))

    def check(item):
        entry_url, entry_size, cand = item
        if delay:
            time.sleep(delay)
        status, size, ctype = head_size(cand, headers=headers)
        ok = status == 200 and size is not None and size == entry_size
        return entry_url, entry_size, cand, ok

    checked = 0
    newly_confirmed = 0
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for entry_url, entry_size, cand, ok in pool.map(check, to_check):
            checked += 1
            bucket[cand] = {"confirmed": ok, "checked_at": "2026-09-17"}
            if ok:
                confirmed[entry_url] = cand
                newly_confirmed += 1
    return confirmed, checked, newly_confirmed


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_one_sample(name, candidate_url, entry, headers):
    """Download ONE small confirmed file completely and check its sha256
    against the entry's own checksum, then delete it. Returns True/False/None
    (None = no checksum to check against, or download failed)."""
    checksum = entry.get("checksum")
    if not checksum or checksum.get("algo") != "sha256":
        return None
    tmp = HERE / f"_mirror_sample_{name}.tmp"
    req = urllib.request.Request(candidate_url, headers={"User-Agent": UA, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=120) as r, open(tmp, "wb") as out:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                out.write(chunk)
        got = sha256_of(tmp)
        return got.lower() == checksum["value"].lower()
    finally:
        if tmp.exists():
            tmp.unlink()


def apply_mirrors(entries, confirmed_map):
    """confirmed_map: entry_url -> [new mirror urls in priority order].
    Appends only URLs not already present, keeping existing order first."""
    applied = 0
    for e in entries:
        new_urls = confirmed_map.get(e.get("url"))
        if not new_urls:
            continue
        existing = e.setdefault("mirrors", [])
        for u in new_urls:
            if u not in existing:
                existing.append(u)
                applied += 1
    return applied


def main():
    releases_path = HERE / "releases.json"
    releases = json.loads(releases_path.read_text())
    cache = load_cache()

    print(f"Total release entries: {len(releases)}")
    temurin = [e for e in releases if is_temurin(e)]
    print(f"Temurin entries: {len(temurin)}")

    # --- NJU: latest-per-group only, same restriction as the TUNA mirror ---
    latest = pick_latest_temurin(temurin)
    print(f"Latest-per-(major,variant,os,arch,libc) group: {len(latest)} entries")
    nju_pairs = []
    for e in latest:
        cand = nju_candidate(e)
        if cand:
            nju_pairs.append((e["url"], e["size"], cand))
    nju_confirmed, nju_checked, nju_new = confirm_candidates("nju", nju_pairs, NJU_HEADERS, cache)
    print(f"NJU: {nju_checked} checked this run, {len(nju_confirmed)} confirmed total")

    # --- USTC: discover the one tag per major it actually mirrors ---
    print("Discovering USTC's mirrored tags per major...")
    tags_by_major = ustc_discover_tags()
    for major, tagset in sorted(tags_by_major.items(), key=lambda kv: int(kv[0])):
        print(f"  major {major}: {sorted(tagset)}")
    ustc_pairs = []
    for e in temurin:
        cand = ustc_candidate(e, tags_by_major)
        if cand:
            ustc_pairs.append((e["url"], e["size"], cand))
    print(f"USTC candidate entries (matching a mirrored tag): {len(ustc_pairs)}")
    headers = ustc_headers(ustc_pairs[0][2]) if ustc_pairs else {}
    print(f"USTC verification cookie IP: {_ustc_ip!r}")
    ustc_confirmed, ustc_checked, ustc_new = confirm_candidates(
        "ustc", ustc_pairs, headers, cache, max_workers=3, delay=0.3
    )
    print(f"USTC: {ustc_checked} checked this run, {len(ustc_confirmed)} confirmed total")

    save_cache(cache)

    # --- build entry_url -> [new mirrors] map, both vendors ---
    confirmed_map = {}
    for entry_url, cand in nju_confirmed.items():
        confirmed_map.setdefault(entry_url, []).append(cand)
    for entry_url, cand in ustc_confirmed.items():
        confirmed_map.setdefault(entry_url, []).append(cand)

    # --- apply to releases.json and every download_plan*.json here ---
    applied_total = 0
    target_files = [releases_path] + sorted(HERE.glob("download_plan*.json"))
    for path in target_files:
        data = json.loads(path.read_text())
        n = apply_mirrors(data, confirmed_map)
        if n:
            path.write_text(json.dumps(data, indent=2, sort_keys=False) + "\n")
        applied_total += n
        print(f"{path.name}: {n} mirror URLs appended")

    print(f"Total mirror URLs appended across all files: {applied_total}")

    # --- one hash-verified sample per new mirror ---
    by_url = {e["url"]: e for e in releases}
    if nju_confirmed:
        sample_entry_url = min(nju_confirmed, key=lambda u: by_url[u]["size"])
        entry = by_url[sample_entry_url]
        cand = nju_confirmed[sample_entry_url]
        print(f"NJU sample: {entry['version']} {entry['os']}/{entry['arch']} ({entry['size']} bytes) -> {cand}")
        ok = verify_one_sample("nju", cand, entry, NJU_HEADERS)
        print(f"NJU sample sha256 match: {ok}")
    if ustc_confirmed:
        sample_entry_url = min(ustc_confirmed, key=lambda u: by_url[u]["size"])
        entry = by_url[sample_entry_url]
        cand = ustc_confirmed[sample_entry_url]
        print(f"USTC sample: {entry['version']} {entry['os']}/{entry['arch']} ({entry['size']} bytes) -> {cand}")
        ok = verify_one_sample("ustc", cand, entry, headers)
        print(f"USTC sample sha256 match: {ok}")


if __name__ == "__main__":
    sys.exit(main())
