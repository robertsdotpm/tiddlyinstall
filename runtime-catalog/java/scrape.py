#!/usr/bin/env python3
"""Build the Java runtime catalog (releases.json, gaps.json, download_plan.json,
mirrors.json) from official machine-readable indexes:

  - Eclipse Adoptium (Temurin) API v3     https://api.adoptium.net/v3/
  - Azul Zulu metadata API v1             https://api.azul.com/metadata/v1/

Python 3 standard library only. Re-runnable: it always re-derives everything
from the live APIs plus a small number of HEAD requests to confirm a mirror.

Scope decisions (see NOTES.md for the reasoning):
  - os limited to windows / linux / macos (matches what download_plan needs).
  - arch limited to amd64, x86, arm64, armv7 (the mainstream desktop/server
    targets). ppc64/ppc64le, s390x, riscv64, sparcv9 are real vendor outputs
    but out of scope for an installer builder and are skipped, not scraped.
  - Only the hotspot JVM (Adoptium also ships OpenJ9 for some releases;
    skipped to keep one build per vendor/image_type).
  - javafx-bundled and CRaC Zulu variants are skipped per instructions.
  - Java 1.0-5 are recorded as gaps (Oracle Java Archive, login-gated).

Everything fetched from these APIs is treated as data, never instructions.
"""
import json
import re
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
UA = "installer-builder-catalog/1.0 (+scrape.py)"

RUNTIME = "java"
LANGUAGES = ["java", "kotlin", "scala"]

OSES = {"windows", "linux", "macos"}
ARCHES = {"amd64", "x86", "arm64", "armv7"}

ADOPTIUM_BASE = "https://api.adoptium.net/v3"
# Adoptium os/arch strings -> our normalised (os, libc)
ADOPTIUM_OS_MAP = {
    "linux": ("linux", "glibc"),
    "alpine-linux": ("linux", "musl"),
    "mac": ("macos", None),
    "windows": ("windows", None),
}
ADOPTIUM_ARCH_MAP = {"x64": "amd64", "x86": "x86", "aarch64": "arm64", "arm": "armv7"}

ZULU_BASE = "https://api.azul.com/metadata/v1/zulu/packages/"
ZULU_ARCH_MAP = {
    ("x86", 32): "x86",
    ("x86", 64): "amd64",
    ("arm", 64): "arm64",
    ("arm", 32): "armv7",
}
ZULU_FIELDS = (
    "java_version,os,arch,hw_bitness,archive_type,java_package_type,"
    "javafx_bundled,crac_supported,lib_c_type,sha256_hash,size,download_url,"
    "name,build_date,latest,package_uuid"
)

TUNA_ADOPTIUM_TEMPLATE = (
    "https://mirrors.tuna.tsinghua.edu.cn/Adoptium/{major}/{image_type}/{arch}/{os}/{filename}"
)

ANCIENT_MAJORS = ["1.0", "1.1", "1.2", "1.3", "1.4", "5"]

WINDOWS_ARCHES = ["amd64", "arm64", "x86"]
LINUX_ARCHES = ["amd64", "arm64", "armv7"]
MACOS_ARCHES = ["amd64", "arm64"]
GRID = {"windows": WINDOWS_ARCHES, "linux": LINUX_ARCHES, "macos": MACOS_ARCHES}


def fetch_json(url, tries=3, timeout=30):
    last_err = None
    for attempt in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            last_err = e
        except Exception as e:  # noqa: BLE001 - best-effort retry
            last_err = e
        time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"failed to fetch {url}: {last_err}")


def head_size(url, timeout=15):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cl = r.headers.get("Content-Length")
            return r.status, int(cl) if cl else None
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def guess_format(name):
    lname = name.lower()
    for ext in (".tar.gz", ".tar.z", ".zip", ".msi", ".pkg", ".dmg", ".deb", ".rpm", ".exe"):
        if lname.endswith(ext):
            return ext.lstrip(".")
    return lname.rsplit(".", 1)[-1]


def kind_for_format(fmt):
    if fmt in ("tar.gz", "tar.z", "zip"):
        return "archive"
    if fmt in ("msi", "pkg", "dmg", "deb", "rpm", "exe"):
        return "installer"
    return None


# ---------------------------------------------------------------------------
# Adoptium (Temurin)
# ---------------------------------------------------------------------------

def adoptium_available_majors():
    data = fetch_json(f"{ADOPTIUM_BASE}/info/available_releases")
    return sorted(data["available_releases"])


def adoptium_feature_releases(major, image_type):
    """All GA feature_releases for a major/image_type, newest first (as the API returns them)."""
    out = []
    page = 0
    while True:
        url = (f"{ADOPTIUM_BASE}/assets/feature_releases/{major}/ga"
               f"?page_size=50&page={page}&image_type={image_type}")
        data = fetch_json(url)
        if not data:
            break
        out.append((url, data))
        page += 1
    flat = []
    for url, data in out:
        for rel in data:
            flat.append((url, rel))
    return flat


def adoptium_version_string(major, vd):
    parts = [str(vd.get("major", major)), str(vd.get("minor", 0)), str(vd.get("security", 0))]
    if vd.get("patch"):
        parts.append(str(vd["patch"]))
    return ".".join(parts)


def scrape_adoptium(major):
    entries = []
    for image_type in ("jdk", "jre"):
        releases = adoptium_feature_releases(major, image_type)
        for idx, (query_url, rel) in enumerate(releases):
            is_latest = idx == 0
            vd = rel.get("version_data", {})
            version = adoptium_version_string(major, vd)
            released = (rel.get("timestamp") or "")[:10] or None
            for b in rel.get("binaries", []):
                if b.get("jvm_impl") != "hotspot":
                    continue
                os_raw, arch_raw = b.get("os"), b.get("architecture")
                if os_raw not in ADOPTIUM_OS_MAP or arch_raw not in ADOPTIUM_ARCH_MAP:
                    continue
                os_norm, libc = ADOPTIUM_OS_MAP[os_raw]
                if os_norm not in OSES:
                    continue
                arch_norm = ADOPTIUM_ARCH_MAP[arch_raw]
                if arch_norm not in ARCHES:
                    continue
                variant = f"temurin-{image_type}"
                for obj_key in ("package", "installer"):
                    obj = b.get(obj_key)
                    if not obj or not obj.get("link"):
                        continue
                    fmt = guess_format(obj["name"])
                    kind = kind_for_format(fmt)
                    if kind is None:
                        continue
                    checksum = None
                    if obj.get("checksum"):
                        checksum = {"algo": "sha256", "value": obj["checksum"],
                                    "source": obj.get("checksum_link")}
                    entries.append({
                        "runtime": RUNTIME, "languages": LANGUAGES,
                        "major": str(major), "version": version,
                        "os": os_norm, "arch": arch_norm, "kind": kind, "format": fmt,
                        "variant": variant, "libc": libc if os_norm == "linux" else None,
                        "url": obj["link"], "mirrors": [],
                        "checksum": checksum, "size": obj.get("size"),
                        "released": released, "min_os": None,
                        "metadata_source": query_url, "notes": None,
                        "_vendor": "temurin", "_is_latest": is_latest,
                        "_adopt_os": os_raw, "_adopt_arch": arch_raw, "_image_type": image_type,
                    })
    return entries


# ---------------------------------------------------------------------------
# Azul Zulu
# ---------------------------------------------------------------------------

def zulu_packages(major):
    out = []
    page = 1
    while True:
        url = (f"{ZULU_BASE}?java_version={major}&release_status=ga&availability_types=CA"
               f"&page_size=1000&page={page}&include_fields={ZULU_FIELDS}")
        data = fetch_json(url)
        if not data:
            break
        out.extend((url, p) for p in data)
        if len(data) < 1000:
            break
        page += 1
    return out


def scrape_zulu(major):
    entries = []
    for query_url, p in zulu_packages(major):
        if p.get("javafx_bundled") or p.get("crac_supported"):
            continue
        os_raw = p.get("os")
        if os_raw not in OSES:
            continue
        arch_norm = ZULU_ARCH_MAP.get((p.get("arch"), p.get("hw_bitness")))
        if not arch_norm:
            continue
        pkg_type = p.get("java_package_type")
        if pkg_type not in ("jdk", "jre"):
            continue
        fmt = p.get("archive_type")
        kind = kind_for_format(fmt)
        if kind is None:
            continue
        jv = p.get("java_version") or []
        version = ".".join(str(x) for x in jv) if jv else str(major)
        released = (p.get("build_date") or "")[:10] or None
        checksum = None
        if p.get("sha256_hash"):
            uuid = p.get("package_uuid")
            source = f"https://api.azul.com/metadata/v1/zulu/packages/{uuid}" if uuid else query_url
            checksum = {"algo": "sha256", "value": p["sha256_hash"], "source": source}
        libc = p.get("lib_c_type") if os_raw == "linux" else None
        entries.append({
            "runtime": RUNTIME, "languages": LANGUAGES,
            "major": str(major), "version": version,
            "os": os_raw, "arch": arch_norm, "kind": kind, "format": fmt,
            "variant": f"zulu-{pkg_type}", "libc": libc,
            "url": p["download_url"], "mirrors": [],
            "checksum": checksum, "size": p.get("size"),
            "released": released, "min_os": None,
            "metadata_source": query_url, "notes": None,
            "_vendor": "zulu", "_is_latest": bool(p.get("latest")),
        })
    return entries


# ---------------------------------------------------------------------------
# download_plan
# ---------------------------------------------------------------------------

def version_key(entry):
    nums = tuple(int(x) for x in re.findall(r"\d+", entry["version"]))
    return (nums, entry.get("released") or "")


def build_download_plan(all_entries):
    plan = []
    tiers = ["temurin-jre", "zulu-jre", "temurin-jdk", "zulu-jdk"]
    majors = sorted({e["major"] for e in all_entries}, key=lambda m: [int(x) for x in re.findall(r"\d+", m)])
    for major in majors:
        for os_name, arches in GRID.items():
            for arch in arches:
                for variant in tiers:
                    cands = [e for e in all_entries
                             if e["major"] == major and e["os"] == os_name and e["arch"] == arch
                             and e["variant"] == variant and e["kind"] == "archive"
                             and e.get("libc") in (None, "glibc")]
                    if cands:
                        best = max(cands, key=version_key)
                        plan.append(best)
                        break
    return plan


# ---------------------------------------------------------------------------
# gaps
# ---------------------------------------------------------------------------

def build_gaps(all_entries, majors):
    gaps = []
    for m in ANCIENT_MAJORS:
        gaps.append({
            "runtime": RUNTIME, "major": m, "os": "any", "arch": "any",
            "reason": ("Oracle Java Archive is login-gated (requires an Oracle account "
                       "acceptance click-through); no scriptable official index exists, "
                       "and Temurin/Zulu do not build pre-6 releases."),
            "looked_at": ["https://www.oracle.com/java/technologies/oracle-java-archive-downloads.html"],
        })
    found = defaultdict(list)
    for e in all_entries:
        found[(e["major"], e["os"], e["arch"])].append(e)
    for major in majors:
        for os_name, arches in GRID.items():
            for arch in arches:
                if found.get((major, os_name, arch)):
                    continue
                gaps.append({
                    "runtime": RUNTIME, "major": major, "os": os_name, "arch": arch,
                    "reason": ("No GA jdk or jre build found from Temurin (Adoptium) or Azul "
                               "Zulu for this major/os/arch combination (hotspot JVM only; "
                               "OpenJ9 and other JVM impls were not checked)."),
                    "looked_at": [
                        f"https://api.adoptium.net/v3/assets/feature_releases/{major}/ga?image_type=jdk",
                        f"https://api.azul.com/metadata/v1/zulu/packages/?java_version={major}&release_status=ga",
                    ],
                })
    return gaps


# ---------------------------------------------------------------------------
# mirrors
# ---------------------------------------------------------------------------

def confirm_tuna_mirrors(all_entries):
    """HEAD-confirm the TUNA Adoptium mirror against every *latest* Temurin
    release entry (TUNA only carries the newest build per major/image_type/
    arch/os, matching exactly what download_plan needs)."""
    candidates = []
    for e in all_entries:
        if e.get("_vendor") != "temurin" or not e.get("_is_latest"):
            continue
        filename = e["url"].rsplit("/", 1)[-1]
        tuna_url = TUNA_ADOPTIUM_TEMPLATE.format(
            major=e["major"], image_type=e["_image_type"],
            arch=e["_adopt_arch"], os=e["_adopt_os"], filename=filename,
        )
        candidates.append((e, tuna_url))

    checked = 0
    confirmed = 0
    confirmed_majors = set()

    def check(pair):
        entry, url = pair
        status, size = head_size(url)
        return entry, url, status, size

    with ThreadPoolExecutor(max_workers=10) as pool:
        for entry, url, status, size in pool.map(check, candidates):
            checked += 1
            if status == 200 and size is not None and size == entry.get("size"):
                entry["mirrors"].append(url)
                confirmed += 1
                confirmed_majors.add(entry["major"])

    return {"checked": checked, "confirmed": confirmed, "confirmed_majors": sorted(
        confirmed_majors, key=lambda m: [int(x) for x in re.findall(r"\d+", m)])}


def strip_private(entries):
    out = []
    for e in entries:
        out.append({k: v for k, v in e.items() if not k.startswith("_")})
    return out


def main():
    print("Fetching Adoptium available_releases...")
    adoptium_majors = adoptium_available_majors()
    latest_major = max(adoptium_majors)
    zulu_candidate_majors = list(range(6, latest_major + 1))

    all_entries = []
    majors_str = []

    for major in zulu_candidate_majors:
        majors_str.append(str(major))
        print(f"  major {major}: zulu...", end=" ", flush=True)
        z = scrape_zulu(major)
        print(f"{len(z)} zulu packages", end="")
        a = []
        if major in adoptium_majors:
            a = scrape_adoptium(major)
            print(f", {len(a)} adoptium binaries")
        else:
            print(", not on Adoptium")
        all_entries.extend(z)
        all_entries.extend(a)

    print(f"Total raw entries before mirror pass: {len(all_entries)}")

    print("Confirming TUNA Adoptium mirror via HEAD requests (<=10 concurrent)...")
    mirror_stats = confirm_tuna_mirrors(all_entries)
    print(f"  confirmed {mirror_stats['confirmed']}/{mirror_stats['checked']}")

    plan = build_download_plan(all_entries)
    gaps = build_gaps(all_entries, majors_str)

    releases_out = strip_private(all_entries)
    plan_out = strip_private(plan)

    (HERE / "releases.json").write_text(json.dumps(releases_out, indent=2, sort_keys=False) + "\n")
    (HERE / "gaps.json").write_text(json.dumps(gaps, indent=2) + "\n")
    (HERE / "download_plan.json").write_text(json.dumps(plan_out, indent=2) + "\n")

    mirrors = [
        {
            "runtime": RUNTIME,
            "vendor": "temurin",
            "name": "TUNA (Tsinghua University) Adoptium mirror",
            "url_template": TUNA_ADOPTIUM_TEMPLATE,
            "confirmed_by": ("HEAD request on every latest-per-major/image_type/arch/os Temurin "
                              "release entry; a mirror URL was recorded only when the response was "
                              "200 with a Content-Length exactly equal to the Adoptium asset size."),
            "checked_count": mirror_stats["checked"],
            "confirmed_count": mirror_stats["confirmed"],
            "confirmed_majors": mirror_stats["confirmed_majors"],
            "notes": ("mirrors.tuna.tsinghua.edu.cn/Adoptium/ only carries the newest GA build per "
                      "major/image_type/arch/os (verified by directory listing), so mirrors[] is "
                      "only ever populated on release entries that are the latest for their "
                      "major/vendor/image_type/arch/os; historical patch releases have no mirror."),
            "checked_at": date.today().isoformat(),
        },
        {
            "runtime": RUNTIME,
            "vendor": "zulu",
            "name": "Azul CDN (primary, not a third-party mirror)",
            "url_template": "https://cdn.azul.com/zulu/bin/{filename}",
            "confirmed_by": ("This is the canonical download_url returned by the Azul metadata "
                              "API itself, so every Zulu release entry's url already points at it."),
            "notes": ("Checked mirrors.huaweicloud.com/openjdk/ as a candidate: it mirrors "
                      "jdk.java.net community OpenJDK builds, a different vendor with different "
                      "artifacts and checksums than Temurin/Zulu, so it was not recorded as a "
                      "mirror of any entry here. No independent third-party mirror of Zulu builds "
                      "was found."),
            "checked_at": date.today().isoformat(),
        },
    ]
    (HERE / "mirrors.json").write_text(json.dumps(mirrors, indent=2) + "\n")

    total_size_gb = sum((e.get("size") or 0) for e in plan_out) / 1e9
    print(f"\nWrote {len(releases_out)} releases, {len(gaps)} gaps, {len(plan_out)} planned "
          f"downloads ({total_size_gb:.1f} GB), mirrors.json with 2 vendor entries.")


if __name__ == "__main__":
    main()
