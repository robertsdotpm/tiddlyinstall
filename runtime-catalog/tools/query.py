#!/usr/bin/env python3
"""Answer: "was <runtime> available on <os>? If so, what versions and limitations applied?"

usage:
  query.py <runtime-or-language> <os> [--arch amd64] [--major 3.5]
  query.py --build-report          # writes catalog/AVAILABILITY.md for every runtime and OS

Runtime or language names: python, node/javascript/typescript, java/kotlin, dotnet/csharp,
go, rust, php, r, ruby, nim, zig, c/cpp/llvm/gcc.
"""
import argparse
import json
import re
from collections import defaultdict
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
FOLDERS = ["python", "node", "java", "dotnet", "go", "rust", "php", "r", "ruby", "nim", "zig", "cc"]
ALIASES = {"javascript": "node", "typescript": "node", "js": "node", "ts": "node", "nodejs": "node",
           "kotlin": "java", "scala": "java", "jvm": "java",
           "csharp": "dotnet", "c#": "dotnet", "fsharp": "dotnet", "vb": "dotnet", "visualbasic": "dotnet", ".net": "dotnet",
           "golang": "go", "c": "cc", "cpp": "cc", "c++": "cc", "llvm": "cc", "clang": "cc", "gcc": "cc",
           "python2": "python", "python3": "python", "rb": "ruby"}
OS_ALIASES = {"win": "windows", "mac": "macos", "osx": "macos", "darwin": "macos"}


def load(folder, name, default):
    p = CATALOG / folder / name
    return json.loads(p.read_text()) if p.exists() else default


def vkey(v):
    return [(0, int(x), "") if x.isdigit() else (1, 0, x) for x in re.split(r"[.\-+]", str(v))]


def downloaded_paths():
    log = CATALOG / "download-log.jsonl"
    done = set()
    if log.exists():
        for line in log.read_text().splitlines():
            r = json.loads(line)
            if r.get("status") in ("downloaded", "present"):
                done.add(r["path"])
    return done


def is_download_of(path, e):
    parts = path.split("/")
    if len(parts) < 5 or parts[:3] != [e["runtime"], e["os"], e["arch"]]:
        return False
    return parts[3] == e["version"] or parts[3].startswith(e["version"] + "-")


def answer(folder, os_name, arch=None, major=None):
    releases = [e for e in load(folder, "releases.json", []) if e["os"] == os_name and e["kind"] != "source"]
    if arch:
        releases = [e for e in releases if e["arch"] == arch]
    if major:
        releases = [e for e in releases if e["major"] == major]
    gaps = [g for g in load(folder, "gaps.json", []) if g["os"] == os_name and (not major or g["major"] == major)]
    lim = load(folder, "limitations.json", {})
    majors = lim.get("majors", [])
    if isinstance(majors, dict):  # some research files key majors by name
        majors = [{"major": k, **v} for k, v in majors.items()]
    lim_by_major = {m["major"]: m for m in majors}
    done = downloaded_paths()

    out = []
    title = f"{folder} on {os_name}" + (f" ({arch})" if arch else "")
    if not releases:
        out.append(f"## {title}: no binary builds found")
        for g in gaps[:10]:
            out.append(f"- gap {g['major']} {g['arch']}: {g['reason']}")
        return "\n".join(out)

    by_major = defaultdict(list)
    for e in releases:
        by_major[(e["runtime"], e["major"])].append(e)
    out.append(f"## {title}: available")
    out.append("")
    out.append("| Runtime | Major | Versions | Architectures | Downloaded here | OS support at the time | Limitations |")
    out.append("| --- | --- | --- | --- | --- | --- | --- |")
    for (runtime, m) in sorted(by_major, key=lambda k: (k[0], vkey(k[1]))):
        es = by_major[(runtime, m)]
        versions = sorted({e["version"] for e in es}, key=vkey)
        arches = ", ".join(sorted({e["arch"] for e in es}))
        have = sorted({e["version"] for e in es if any(is_download_of(p, e) for p in done)}, key=vkey)
        if folder == "cc":
            info = lim_by_major.get(f"{runtime}-{m}", {})
        elif runtime == "dotnet-framework":
            info = lim_by_major.get(f"framework-{m}", {})
        else:
            info = lim_by_major.get(m, {})
        os_support = (info.get("os_support") or {}).get(os_name, "")
        limits = "; ".join(info.get("limitations", [])[:4])
        vrange = versions[0] if len(versions) == 1 else f"{versions[0]} – {versions[-1]} ({len(versions)})"
        out.append(f"| {runtime} | {m} | {vrange} | {arches} | {', '.join(have) or '—'} | {os_support} | {limits} |")
    if lim.get("milestones"):
        out.append("")
        out.append("Milestones: " + "; ".join(f"{x['capability']} since {x['since']}" for x in lim["milestones"]))
    if gaps:
        out.append("")
        out.append(f"{len(gaps)} recorded gaps, e.g.: " + "; ".join(f"{g['major']} {g['arch']}: {g['reason']}" for g in gaps[:3]))
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("runtime", nargs="?")
    ap.add_argument("os", nargs="?")
    ap.add_argument("--arch")
    ap.add_argument("--major")
    ap.add_argument("--build-report", action="store_true")
    a = ap.parse_args()

    if a.build_report:
        parts = ["# Runtime availability", "",
                 "Generated by `catalog/tools/query.py --build-report` from each runtime's "
                 "`releases.json`, `gaps.json`, `limitations.json` and `download-log.jsonl`.", ""]
        for folder in FOLDERS:
            oses = sorted({e["os"] for e in load(folder, "releases.json", [])})
            for os_name in oses:
                parts.append(answer(folder, os_name))
                parts.append("")
        (CATALOG / "AVAILABILITY.md").write_text("\n".join(parts))
        print(f"wrote {CATALOG / 'AVAILABILITY.md'}")
        return

    if not a.runtime or not a.os:
        ap.error("give a runtime and an os, or --build-report")
    folder = ALIASES.get(a.runtime.lower(), a.runtime.lower())
    os_name = OS_ALIASES.get(a.os.lower(), a.os.lower())
    print(answer(folder, os_name, a.arch, a.major))


if __name__ == "__main__":
    main()
