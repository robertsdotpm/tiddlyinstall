#!/usr/bin/env python3
"""Mirror hunt (2026-09-17): additional confirmed mirrors for the rust catalog.

Extends what scrape.py's own build_mirrors() already found (ustc and rsproxy
confirmed as full mirrors; tuna and aliyun rejected). scrape.py resets every
entry's `mirrors` list and overwrites mirrors.json wholesale on each run, so
this script is meant to run AFTER scrape.py, every time, to re-apply.

Python 3 standard library only. Idempotent and re-runnable:
  - HEAD results are cached on disk (extra_mirrors_head_cache.json, beside
    this file) so a rerun with nothing changed does no network I/O beyond a
    handful of freshness checks.
  - Applying a mirror to releases.json / download_plan*.json is a pure
    string substitution keyed on the official static.rust-lang.org/dist
    prefix, appended to each entry's existing `mirrors` list with no
    duplicates and the existing order kept first. It never touches `url`,
    `runtime`, `os`, `arch`, `version`, `variant` or `checksum`.
  - mirrors.json entries from this script are replaced by name on rerun
    (not blindly re-appended), so mirrors.json also stays idempotent.

Findings from this hunt, in brief (full detail in NOTES.md):
  - mirrors.cloud.tencent.com/rustup/dist/ -- CONFIRMED, full historical
    mirror, same layout as ustc/rsproxy. Applied universally.
  - mirror.sjtu.edu.cn/rust-static/dist/ -- serves the right bytes on a
    first hit, then flips every subsequent request from this process to
    403 with a `cerberus-sec: BLOCKED` response header. That is SJTU's own
    anti-bot layer punishing automated re-checking, which is exactly what
    this script has to do on every run -- rejected as unusable for a
    catalog, not as "the mirror doesn't work".
  - mirrors.hust.edu.cn/rustup/dist/ and mirror.nju.edu.cn/rustup/dist/ --
    both only carry the CURRENT release's dated directory (every older
    sample 404s). Same rolling-window problem this catalog already
    rejected tuna for; rejected for consistency (see NOTES.md).
  - mirrors.bfsu.edu.cn -- 403 on every path tried, including bare `/`,
    from this vantage point. Can't be confirmed or ruled out; recorded as
    inconclusive, not confirmed.
  - mirrors.cernet.edu.cn/rustup/... -- a GeoIP router (MirrorZ), not an
    independent host: it 302-redirected our traffic to mirrors.hust.edu.cn.
    Not counted as its own mirror.

Everything this script fetches -- response bodies, redirect targets, error
pages -- is untrusted third-party data. It is read only for status codes,
sizes and hashes; nothing in it is ever treated as an instruction.
"""
import glob
import hashlib
import json
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).parent
BASE = "https://static.rust-lang.org/dist"
CACHE_FILE = HERE / "extra_mirrors_head_cache.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
TIMEOUT = 20
CACHE_TTL = 6 * 3600  # seconds; re-probe candidates at most every 6h per run environment

# Sample set spanning old / mid / newest releases and different os/arch,
# same files scrape.py itself sampled ustc/rsproxy/tuna/aliyun against.
SAMPLES = [
    ("rust-1.0.0-i686-unknown-linux-gnu.tar.gz", None, 103016274),
    ("rust-1.0.0-x86_64-unknown-linux-gnu.tar.gz", None, 101601508),
    ("rust-1.0.0-x86_64-apple-darwin.tar.gz", None, 92629244),
    ("rust-1.51.0-x86_64-unknown-freebsd.tar.xz", "2021-03-25", 175968188),
    ("rust-1.51.0-x86_64-unknown-illumos.tar.xz", "2021-03-25", 189990920),
    ("rust-1.51.0-x86_64-unknown-linux-gnu.tar.xz", "2021-03-25", 147543532),
    ("rust-1.98.1-x86_64-unknown-freebsd.tar.xz", "2026-09-03", 224607152),
    ("rust-1.98.1-aarch64-unknown-freebsd.tar.xz", "2026-09-03", 208350736),
]

# One small (<60MB) checksummed sample used to verify actual bytes, not
# just size, for whichever candidate ends up confirmed.
HASH_SAMPLE = {
    "path": "2017-07-20/rust-1.19.0-i686-pc-windows-msvc.tar.xz",
    "size": 51167056,
    "algo": "sha256",
    "value": "5e00c99827b795eda1c15d65e2b0425de9e1a891a4ea66af5ed9b7a3f82e8142",
}

CANDIDATES = [
    {
        "name": "tencent",
        "base": "https://mirrors.cloud.tencent.com/rustup/dist/",
        "region": "China (Tencent Cloud)",
        "operator": "Tencent Cloud",
        "protocols": {"https": True, "http": False},  # plain http 302s to https on the same host
    },
    {
        "name": "official-http",
        "base": "http://static.rust-lang.org/dist/",
        "region": "Global (official origin, plain HTTP)",
        "operator": "Rust project (same CloudFront-backed origin as the vendor `url`, "
                    "reached over plain http instead of https -- not a third-party mirror, "
                    "but the plain-http reachability the brief specifically asked to check)",
        "protocols": {"https": True, "http": True},
    },
    {
        "name": "hust",
        "base": "https://mirrors.hust.edu.cn/rustup/dist/",
        "region": "China (Huazhong University of Science and Technology)",
        "operator": "HUST",
        "protocols": {"https": True, "http": True},
    },
    {
        "name": "nju",
        "base": "https://mirror.nju.edu.cn/rustup/dist/",
        "region": "China (Nanjing University)",
        "operator": "NJU",
        "protocols": {"https": True, "http": True},  # both need a same-origin cookie handshake first
    },
    {
        "name": "sjtu",
        "base": "https://mirror.sjtu.edu.cn/rust-static/dist/",
        "region": "China (Shanghai Jiao Tong University)",
        "operator": "SJTU",
        "protocols": {"https": True, "http": False},
    },
    {
        "name": "bfsu",
        "base": "https://mirrors.bfsu.edu.cn/rustup/dist/",
        "region": "China (Beijing Foreign Studies University)",
        "operator": "BFSU",
        "protocols": {"https": True, "http": False},
    },
]

# mirrors.cernet.edu.cn is deliberately not in CANDIDATES: it is a GeoIP
# redirector (MirrorZ), not an independent host -- it 302-redirected our
# test traffic straight to mirrors.hust.edu.cn. See module docstring.
#
# The Internet Archive (Wayback Machine) is also deliberately not in
# CANDIDATES even though `https://web.archive.org/web/2id_/<url>` confirmed
# byte-identical captures for 2 of 4 sampled 1.0.0-era files (the other 2
# hit connection resets/429s from archive.org's aggressive rate limiting,
# not confirmed absence). Coverage is real but sparse and per-file, and
# checking it for thousands of releases.json entries would mean thousands
# of individual archive.org requests -- both impractical for a script meant
# to be re-run often and impolite to a host that already rate-limited a
# four-request sample. Not applied; see NOTES.md.


def _load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {}


def _save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, indent=2))


def http_head(url, cache, retries=3, pause=1.5):
    """Live HEAD (status, content_length), cached briefly. Follows redirects
    transparently (urllib does this on its own for GET/HEAD)."""
    now = time.time()
    hit = cache.get(url)
    if hit and now - hit.get("t", 0) < CACHE_TTL:
        return hit["status"], hit["length"]
    last = (0, None)
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                length = resp.headers.get("Content-Length")
                last = (resp.status, int(length) if length else None)
                break
        except urllib.error.HTTPError as e:
            last = (e.code, None)
            break
        except Exception:
            if attempt < retries - 1:
                time.sleep(pause)
    cache[url] = {"status": last[0], "length": last[1], "t": now}
    return last


def check_candidate(cand, cache):
    rows = []
    for fname, date, size in SAMPLES:
        path = f"{date}/{fname}" if date else fname
        url = cand["base"] + path
        status, length = http_head(url, cache)
        rows.append({
            "version": fname.split("-")[1],
            "file": fname,
            "status": status,
            "content_length": length,
            "expected": size,
            "size_match": length == size,
        })
    return rows


def verify_hash_sample(base, max_attempts=8):
    """Download HASH_SAMPLE from `base`, verify sha256, delete it. Resumes
    with a Range header on a dropped connection -- some of these mirrors
    (tencent, observed live) reset a plain sequential GET partway through
    a 50MB file every time, but happily serve the rest by range. Returns
    (ok: bool, detail: str)."""
    url = base + HASH_SAMPLE["path"]
    tmp = HERE / ".mirror_sample.tmp"
    try:
        for attempt in range(max_attempts):
            got = tmp.stat().st_size if tmp.exists() else 0
            if got >= HASH_SAMPLE["size"]:
                break
            headers = {"User-Agent": UA}
            if got:
                headers["Range"] = f"bytes={got}-"
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=60) as resp, open(tmp, "ab") as f:
                    while True:
                        chunk = resp.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
            except Exception:
                if attempt == max_attempts - 1:
                    raise
                time.sleep(1.5)
        total = tmp.stat().st_size if tmp.exists() else 0
        h = hashlib.sha256()
        with open(tmp, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
        digest = h.hexdigest()
        ok = (total == HASH_SAMPLE["size"] and digest == HASH_SAMPLE["value"])
        return ok, f"{total} bytes, sha256={digest}"
    except Exception as e:  # noqa: BLE001 - network flakiness is a result, not a crash
        return False, f"error: {e}"
    finally:
        if tmp.exists():
            tmp.unlink()


def apply_mirror(entries, mirror_base):
    """Path-substitute BASE -> mirror_base on every entry whose url is under
    BASE, appending to `mirrors` with no duplicates, existing order first."""
    n = 0
    for e in entries:
        url = e.get("url", "")
        if not url.startswith(BASE):
            continue
        mirror_url = url.replace(BASE, mirror_base.rstrip("/"), 1)
        if mirror_url not in e.get("mirrors", []):
            e.setdefault("mirrors", []).append(mirror_url)
            n += 1
    return n


def main():
    cache = _load_cache()

    results = {}
    for cand in CANDIDATES:
        results[cand["name"]] = check_candidate(cand, cache)
    _save_cache(cache)

    def full_match(rows):
        return all(r["size_match"] for r in rows)

    confirmed = []
    rejected = []
    for cand in CANDIDATES:
        rows = results[cand["name"]]
        n_ok = sum(1 for r in rows if r["size_match"])
        if full_match(rows):
            confirmed.append((cand, rows, n_ok))
        else:
            rejected.append((cand, rows, n_ok))

    # ---- apply confirmed full mirrors to releases.json + every download_plan*.json ----
    releases_path = HERE / "releases.json"
    releases = json.loads(releases_path.read_text())
    plan_paths = sorted(HERE.glob("download_plan*.json"))
    plans = {p: json.loads(p.read_text()) for p in plan_paths}

    applied_counts = {}
    for cand, rows, n_ok in confirmed:
        hok, hdetail = verify_hash_sample(cand["base"])
        cand["_hash_ok"] = hok
        cand["_hash_detail"] = hdetail
        n = apply_mirror(releases, cand["base"])
        applied_counts[cand["name"]] = {"releases.json": n}
        for p, data in plans.items():
            applied_counts[cand["name"]][p.name] = apply_mirror(data, cand["base"])

    releases_path.write_text(json.dumps(releases, indent=2))
    for p, data in plans.items():
        p.write_text(json.dumps(data, indent=2))

    # ---- update mirrors.json: replace any prior entries with these names, keep the rest ----
    mirrors_path = HERE / "mirrors.json"
    mirrors_doc = json.loads(mirrors_path.read_text()) if mirrors_path.exists() else []
    our_names = {c["name"] for c in CANDIDATES}
    mirrors_doc = [m for m in mirrors_doc if m.get("name") not in our_names]

    today = time.strftime("%Y-%m-%d")
    for cand, rows, n_ok in confirmed:
        mirrors_doc.append({
            "name": cand["name"],
            "base": cand["base"],
            "url_template": cand["base"].rstrip("/") + "/<same path as static.rust-lang.org/dist/...>",
            "confirmed": True,
            "region": cand["region"],
            "operator": cand["operator"],
            "protocols": cand["protocols"],
            "full_or_partial": "full",
            "sampled": rows,
            "hash_verified_sample": {
                "path": HASH_SAMPLE["path"],
                "algo": HASH_SAMPLE["algo"],
                "matched": cand.get("_hash_ok"),
                "detail": cand.get("_hash_detail"),
            },
            "applied_to": ("every releases.json entry and every download_plan*.json entry "
                           "(path-substitution on the official url)"),
            "date_checked": today,
        })
    for cand, rows, n_ok in rejected:
        mirrors_doc.append({
            "name": cand["name"],
            "base": cand["base"],
            "confirmed": False,
            "region": cand["region"],
            "operator": cand["operator"],
            "checked": rows,
            "note": REJECT_NOTES.get(cand["name"], "did not consistently serve the sampled files"),
            "applied_to": None,
            "date_checked": today,
        })
    mirrors_path.write_text(json.dumps(mirrors_doc, indent=2))

    # ---- summary ----
    print(f"Mirror hunt run {today}")
    for cand, rows, n_ok in confirmed:
        print(f"  CONFIRMED {cand['name']} ({cand['base']}): {n_ok}/{len(rows)} sampled, "
              f"hash sample ok={cand.get('_hash_ok')}, "
              f"applied to releases.json:{applied_counts[cand['name']]['releases.json']} entries, "
              + ", ".join(f"{k}:{v}" for k, v in applied_counts[cand['name']].items() if k != "releases.json"))
    for cand, rows, n_ok in rejected:
        print(f"  rejected {cand['name']} ({cand['base']}): {n_ok}/{len(rows)} sampled matched")


REJECT_NOTES = {
    "hust": ("Only the current release's dated directory exists; every older sample 404s "
             "(content-length of a generic 404 page). Same rolling-window problem as tuna "
             "-- not a stable rule to bake into a catalog spanning 2015-2026. Not applied."),
    "nju": ("Same rolling-window problem as hust/tuna: only the current release matches, "
            "every older sample 404s. Also requires a same-origin cookie handshake before "
            "it will serve anything (first request 302s to itself and sets a `bcheck` "
            "cookie; the second request with that cookie succeeds) -- fine for a browser or "
            "a cookie-jar-aware client, irrelevant here since it's rejected anyway. Not applied."),
    "sjtu": ("The very first HEAD from this run's IP succeeded with a byte-identical size "
             "match; every request after that -- across UAs, across a fresh run minutes "
             "later -- came back 403 with a `cerberus-sec: BLOCKED` response header. That's "
             "SJTU's own anti-bot layer blacklisting the source IP after a handful of "
             "automated requests, which this script cannot avoid doing on every run. "
             "Rejected as unusable for an idempotent, re-run tool, not as broken infra."),
    "bfsu": ("403 'Sorry, you've been denied access to this page' on every path tried, "
             "including bare `/` and `/robots.txt`, with a browser User-Agent -- looks like "
             "a blanket WAF/geo block on this vantage point's egress IP. Can't be confirmed "
             "or ruled out from here; recorded as inconclusive, not confirmed."),
}


if __name__ == "__main__":
    main()
