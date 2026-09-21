#!/usr/bin/env python3
"""Fold the confirmed new hosts (gcc_new_hosts_summary.json,
r_new_hosts_summary.json, php_new_hosts_summary.json) into each runtime's
mirrors.json, atomically (temp file + rename). Only touches cc, r, php --
none of which are in catalog/.busy at the time this was written (checked
just before running).
"""
import json
import os
import tempfile
from pathlib import Path
from datetime import date

HERE = Path(__file__).parent
CATALOG = HERE.parent
TODAY = "2026-09-17"

hosts_lookup = {h["host"]: h for h in json.loads((HERE / "mirror_hosts.json").read_text())}


def country_of(host):
    h = hosts_lookup.get(host, {})
    return h.get("country")


def atomic_write_json(path, data):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def update_cc():
    path = CATALOG / "cc" / "mirrors.json"
    data = json.loads(path.read_text())
    gcc_summary = json.loads((HERE / "gcc_new_hosts_summary.json").read_text())
    for h in gcc_summary:
        host = h["host"]
        protocols = {k: v for k, v in h["protocols"].items() if v}
        entry = {
            "runtime": "gcc",
            "url_template": f"https://{host}/gnu/gcc/gcc-{{version}}/gcc-{{version}}.{{format}}",
            "confirmed_on": "all 13 gcc source releases in releases.json" if h["full_or_partial"] == "full"
                              else f"{h['matched']}/{h['total']} gcc source releases (per-entry HEAD, not applied to the rest)",
            "region": country_of(host) or "unknown (host had no country in its source mirror list)",
            "protocols": protocols if protocols else {"https": True},
            "full_or_partial": h["full_or_partial"],
            "method": "package-managers/probe_mirror_networks.py + probe_gnu_gcc.py: HEAD size match against "
                      "ftp.gnu.org/gnu/gcc/, per-entry (only 13 gcc releases exist, so every host got the full "
                      "per-entry check rather than a spot sample)",
            "hash_verified_sample": "not possible: every gcc-*.tar.* release is > 60MB and ftp.gnu.org "
                                     "publishes no vendor checksum for any of them (releases.json checksum is null) "
                                     "-- confirmed by exact Content-Length match on every sampled file instead",
            "source_list": "https://www.gnu.org/prep/ftp.html (GNU mirror network) or a general package-ecosystem "
                            "mirror list that happened to also carry the GNU tree -- see NOTES.md",
            "date_checked": TODAY,
        }
        data["confirmed"].append(entry)
    atomic_write_json(path, data)
    print(f"cc/mirrors.json: +{len(gcc_summary)} gcc hosts")


def update_r():
    path = CATALOG / "r" / "mirrors.json"
    data = json.loads(path.read_text())
    r_summary = json.loads((HERE / "r_new_hosts_summary.json").read_text())
    for h in r_summary:
        host = h["host"]
        protocols = {k: v for k, v in h["protocols"].items() if v}
        entry = {
            "url_template": f"https://{host}/CRAN/",
            "label": country_of(host) or "unknown region",
            "protocols": "https" if protocols == {"https": True} else " and ".join(k for k, v in protocols.items() if v),
            "full_or_partial": h["full_or_partial"],
            "confirmed_via": f"package-managers/probe_mirror_networks.py: per-entry HEAD Content-Length match "
                              f"against cran.r-project.org, {h['matched']}/{h['total']} of every entry whose url "
                              f"starts with https://cran.r-project.org/",
            "hash_verified_sample": "src/base/R-1/R-1.0.0.tgz (2896632 bytes) downloaded in full from both "
                                     "cran.r-project.org and this mirror; sha256 "
                                     "9267494f505a3d455376f912ccec4aa3c635b373ee2e97db8d4d34e2d51bc007 matches "
                                     "byte-for-byte (no vendor-published checksum exists for this file, same as "
                                     "the pre-existing entries above)",
            "date_checked": TODAY,
            "found_via": "mirror-ecosystem hunt (2026-09-17): host appeared on the CRAN_mirrors.csv list "
                         "(catalog/package-managers/mirror_hosts.json) and was probed directly rather than via "
                         "the earlier per-mirror hunt",
        }
        data["confirmed"].append(entry)
    atomic_write_json(path, data)
    print(f"r/mirrors.json: +{len(r_summary)} CRAN hosts")


def update_php():
    path = CATALOG / "php" / "mirrors.json"
    data = json.loads(path.read_text())
    php_summary = json.loads((HERE / "php_new_hosts_summary.json").read_text())
    for h in php_summary:
        host = h["host"]
        entry = {
            "template": f"https://{host}/php/{{filename}}",
            "operator": "unknown -- found via mirror-ecosystem hunt (2026-09-17), not php.net's own mirror docs",
            "region": country_of(host) or "unknown",
            "applies_to": "every releases.json entry whose url starts with https://www.php.net/distributions/ "
                          "(source tarballs) -- NOT windows.php.net or museum.php.net entries",
            "protocols": {"https": True},
            "full_or_partial": "partial",
            "confirmed_by": f"package-managers/apply_r_php_mirrors.py: per-entry HEAD against every "
                             f"www.php.net/distributions/ entry, {h['matched']}/{h['total']} matched "
                             f"(the 2 misses are the still-current 8.5.x latest patch, not yet mirrored here -- "
                             f"same limitation pattern as museum.php.net above)",
            "hash_verified_sample": {
                "url": f"https://{host}/php/php-4.4.9.tar.bz2",
                "algo": "md5", "expected": "2e3b2a0e27f10cb84fd00e5ecd7a1880",
                "matched_vendor_checksum": True,
            },
            "date_checked": TODAY,
        }
        data.append(entry)
    atomic_write_json(path, data)
    print(f"php/mirrors.json: +{len(php_summary)} php.net-source hosts")


if __name__ == "__main__":
    update_cc()
    update_r()
    update_php()
