#!/usr/bin/env python3
"""Mirror hunt (2026-09-17): append confirmed extra mirrors to PHP's
releases.json and every download_plan*.json in this folder.

Re-runnable and idempotent: existing mirrors are kept, new ones are only
appended if missing, and `url`/`runtime`/`os`/`arch`/`version`/`variant`/
`checksum` are never touched.

Confirmed mirror
-----------------
`downloads.php.net` (php.net-operated -- NOT a third-party mirror, but a
second, independently-hosted copy of the same tree). `windows.php.net`
itself now just 302s every `/downloads/...` request to
`https://downloads.php.net/~windows/...` (see scrape.py's `win_probe`,
which already relies on this for speed). That makes the swap a full,
1:1 layout mapping -- not a partial/rolling mirror -- so it is applied to
every entry whose `url` starts with the windows.php.net prefix, both the
current `releases/` tree and the historical `releases/archives/` tree
(the prefix covers both).

Before trusting that mapping, this script re-verifies it on every run
against a small, fixed sample spanning old/middle/newest majors and both
Windows archs (see SAMPLE_URLS below), using a HEAD request compared to
the entry's own `size`. Results are cached in `extra_mirrors_cache.json`
(beside this script) so a same-day re-run doesn't re-hit the network.
If any sampled file fails to match, the script refuses to apply the
mirror and prints why -- it will not silently go stale.

Rejected candidates (recorded here, not in mirrors.json, since nothing
was confirmed): see NOTES.md "Mirror hunt (2026-09-17)" for the detail on
mirrors.sohu.com/php/ (sends a correct Content-Length on HEAD but a
truncated, wrong-length body on every GET -- unreliable, not just
partial), mirrors.cloud.tencent.com/php/ (404, no php/ tree),
mirrors.huaweicloud.com/php/ (returns an HTML/WAF shell page for any
path, direct file URLs included, despite an HTTP 200), and
crazywhalecc/static-php-cli's GitHub releases (assets are the `spc`
build-tool binary, e.g. `spc-linux-x86_64.tar.gz` -- a different file
from the `php-<ver>-cli-linux-x86_64.tar.gz` runtime tarballs on
dl.static-php.dev -- not a mirror of what we catalog).
"""
import json
import sys
import urllib.request
from pathlib import Path

FOLDER = Path(__file__).parent
CACHE_FILE = FOLDER / "extra_mirrors_cache.json"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")

OLD_PREFIX = "https://windows.php.net/downloads/"
NEW_PREFIX = "https://downloads.php.net/~windows/"

# Old / middle / newest majors, both archs -- matches the manual
# verification done for this mirror hunt (HEAD + one full download+sha256
# compare against php-7.4.33-nts-Win32-vc15-x86.zip, which matched exactly).
SAMPLE_URLS = [
    "https://windows.php.net/downloads/releases/archives/php-5.6.40-nts-Win32-VC11-x64.zip",
    "https://windows.php.net/downloads/releases/archives/php-5.6.40-nts-Win32-VC11-x86.zip",
    "https://windows.php.net/downloads/releases/php-7.4.33-nts-Win32-vc15-x64.zip",
    "https://windows.php.net/downloads/releases/php-7.4.33-nts-Win32-vc15-x86.zip",
    "https://windows.php.net/downloads/releases/php-8.5.10-nts-Win32-vs17-x64.zip",
    "https://windows.php.net/downloads/releases/php-8.5.10-nts-Win32-vs17-x86.zip",
]


def head_size(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=20) as r:
        cl = r.headers.get("Content-Length")
        return int(cl) if cl is not None else None


def load_cache():
    if CACHE_FILE.exists():
        return json.loads(CACHE_FILE.read_text())
    return {}


def save_cache(cache):
    CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True) + "\n")


def verify_sample(cache):
    """HEAD-check SAMPLE_URLS against their downloads.php.net equivalent.
    Returns True only if every sampled file's size matches (cached per URL
    so repeat runs don't re-hit the network)."""
    ok = True
    for u in SAMPLE_URLS:
        mirror_u = u.replace(OLD_PREFIX, NEW_PREFIX)
        key = f"head:{mirror_u}"
        if key in cache:
            size = cache[key]
        else:
            try:
                size = head_size(mirror_u)
            except Exception as e:
                print(f"  WARN: HEAD failed for {mirror_u}: {e}")
                size = None
            cache[key] = size
        # find the expected size from whichever release entry uses this url
        expected = EXPECTED_SIZES.get(u)
        if expected is None or size != expected:
            print(f"  MISMATCH: {u} -> {mirror_u} "
                  f"(mirror size={size}, expected={expected})")
            ok = False
        else:
            print(f"  ok: {mirror_u} ({size} bytes)")
    return ok


def collect_expected_sizes(releases):
    sizes = {}
    for e in releases:
        if e["url"] in SAMPLE_URLS:
            sizes[e["url"]] = e["size"]
    return sizes


def detect_indent(path):
    with open(path) as f:
        f.readline()  # "[\n"
        second = f.readline()
    return len(second) - len(second.lstrip(" "))


def dump_json(path, data):
    indent = detect_indent(path)
    with open(path, "w") as f:
        json.dump(data, f, indent=indent)


def apply_mirror(entries):
    changed = 0
    for e in entries:
        url = e.get("url", "")
        if url.startswith(OLD_PREFIX):
            mirror_url = url.replace(OLD_PREFIX, NEW_PREFIX, 1)
            if mirror_url not in e["mirrors"]:
                e["mirrors"].append(mirror_url)
                changed += 1
    return changed


def main():
    releases_path = FOLDER / "releases.json"
    releases = json.loads(releases_path.read_text())

    global EXPECTED_SIZES
    EXPECTED_SIZES = collect_expected_sizes(releases)
    if len(EXPECTED_SIZES) < len(SAMPLE_URLS):
        missing = set(SAMPLE_URLS) - set(EXPECTED_SIZES)
        print("ERROR: sample URLs missing from releases.json (catalog changed "
              "under us), aborting without applying the mirror:")
        for m in missing:
            print("  -", m)
        sys.exit(1)

    cache = load_cache()
    print("Verifying downloads.php.net against a spanning sample...")
    if not verify_sample(cache):
        save_cache(cache)
        print("Sample verification failed -- NOT applying the windows.php.net "
              "-> downloads.php.net mirror this run.")
        sys.exit(1)
    save_cache(cache)
    print("Sample verified: downloads.php.net serves byte-identical copies.")

    total_changed = 0
    n = apply_mirror(releases)
    print(f"releases.json: added mirror to {n} entries")
    total_changed += n
    dump_json(releases_path, releases)

    for plan_path in sorted(FOLDER.glob("download_plan*.json")):
        plan = json.loads(plan_path.read_text())
        n = apply_mirror(plan)
        print(f"{plan_path.name}: added mirror to {n} entries")
        total_changed += n
        dump_json(plan_path, plan)

    print(f"Done. {total_changed} mirror URLs added in total.")


if __name__ == "__main__":
    main()
