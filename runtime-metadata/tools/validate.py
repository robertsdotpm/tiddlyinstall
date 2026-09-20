#!/usr/bin/env python3
"""Validate a runtime catalog folder against catalog/SCHEMA.md.

usage: validate.py <catalog/runtime-folder>
"""
import json
import re
import sys
from collections import Counter
from pathlib import Path

OS = {"windows", "linux", "macos", "freebsd", "openbsd", "netbsd", "solaris", "aix",
      "android", "illumos", "dragonfly", "plan9"}
ARCH = {"x86", "amd64", "arm64", "armv7", "armv6", "ppc64le", "ppc64", "s390x", "riscv64",
        "loong64", "mips64le", "ia64", "universal", "any"}
KIND = {"installer", "archive", "source"}
ALGO = {"sha256", "sha512", "sha1", "md5"}
HEXLEN = {"sha256": 64, "sha512": 128, "sha1": 40, "md5": 32}
REQUIRED = ["runtime", "languages", "major", "version", "os", "arch", "kind", "format",
            "url", "mirrors", "checksum", "size", "metadata_source"]


def check_release(e, i, errors):
    where = f"releases[{i}] {e.get('version')} {e.get('os')}/{e.get('arch')}"
    for k in REQUIRED:
        if k not in e:
            errors.append(f"{where}: missing {k}")
    if e.get("os") not in OS:
        errors.append(f"{where}: bad os {e.get('os')!r}")
    if e.get("arch") not in ARCH:
        errors.append(f"{where}: bad arch {e.get('arch')!r}")
    if e.get("kind") not in KIND:
        errors.append(f"{where}: bad kind {e.get('kind')!r}")
    if not isinstance(e.get("major"), str) or not isinstance(e.get("version"), str):
        errors.append(f"{where}: major/version must be strings")
    if not str(e.get("url", "")).startswith(("https://", "http://", "ftp://")):
        errors.append(f"{where}: bad url")
    if not isinstance(e.get("mirrors"), list):
        errors.append(f"{where}: mirrors must be a list")
    c = e.get("checksum")
    if c is not None:
        if c.get("algo") not in ALGO:
            errors.append(f"{where}: bad checksum algo")
        elif not re.fullmatch(r"[0-9a-fA-F]{%d}" % HEXLEN[c["algo"]], str(c.get("value", ""))):
            errors.append(f"{where}: checksum value doesn't look like {c['algo']}")
    if e.get("size") is not None and not isinstance(e.get("size"), int):
        errors.append(f"{where}: size must be int or null")


def main():
    folder = Path(sys.argv[1])
    errors = []
    releases = json.loads((folder / "releases.json").read_text())
    for i, e in enumerate(releases):
        check_release(e, i, errors)
    gaps = json.loads((folder / "gaps.json").read_text()) if (folder / "gaps.json").exists() else []
    for i, g in enumerate(gaps):
        for k in ("runtime", "major", "os", "arch", "reason", "looked_at"):
            if k not in g:
                errors.append(f"gaps[{i}]: missing {k}")
    plan = json.loads((folder / "download_plan.json").read_text()) if (folder / "download_plan.json").exists() else []
    seen = Counter((p["runtime"], p["major"], p["os"], p["arch"], p.get("variant")) for p in plan)
    for k, n in seen.items():
        if n > 1:
            errors.append(f"download_plan: duplicate {k}")
    for i, e in enumerate(plan):
        check_release(e, i, errors)

    print(f"{folder.name}: {len(releases)} releases, {len(gaps)} gaps, {len(plan)} planned downloads, "
          f"{sum((p.get('size') or 0) for p in plan) / 1e9:.1f} GB planned")
    by_os = Counter(e["os"] for e in releases if "os" in e)
    print("  by os:", dict(by_os))
    print("  majors:", len({e.get('major') for e in releases}),
          " with checksum:", sum(1 for e in releases if e.get("checksum")), "/", len(releases))
    if errors:
        print(f"  {len(errors)} ERRORS, first 20:")
        for e in errors[:20]:
            print("   -", e)
        sys.exit(1)
    print("  OK")


if __name__ == "__main__":
    main()
