#!/usr/bin/env python3
"""Delete downloaded runtime files that aren't in any download_plan_majors.json.

usage: prune.py            # dry run: list what would be deleted
       prune.py --apply    # delete

Never touches: catalog/, deps/, reference/, files listed in the root
manifest.json (operator-tested and separately verified builds), or anything
outside the runtime directories written by tools/download.py.
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from download import target_path  # noqa: E402  same path rules as the downloader

CATALOG = Path(__file__).resolve().parents[1]
ROOT = CATALOG.parent
FOLDERS = ["python", "node", "java", "dotnet", "go", "rust", "php", "r", "ruby", "nim", "zig", "cc", "cmake", "meson", "ninja"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    keep = set()
    runtime_dirs = set()
    for f in FOLDERS:
        if not (CATALOG / f / "releases.json").exists():
            continue  # runtime folder not populated yet
        if not (CATALOG / f / "download_plan_majors.json").exists():
            sys.exit(f"{f}/download_plan_majors.json missing: run tools/make_major_plans.py first (refusing to prune)")
        plan = json.loads((CATALOG / f / "download_plan_majors.json").read_text())
        for e in plan:
            keep.add(target_path(e).resolve())
        for e in json.loads((CATALOG / f / "releases.json").read_text()):
            runtime_dirs.add(e["runtime"])
    manifest = json.loads((ROOT / "manifest.json").read_text())
    for e in manifest["files"]:
        p = (ROOT / e["path"]).resolve()
        keep.add(p)
        keep.add(Path(str(p) + ".asc"))  # detached signatures kept beside 3.3.5

    delete, freed = [], 0
    for rd in sorted(runtime_dirs):
        base = ROOT / rd
        if not base.is_dir():
            continue
        for p in base.rglob("*"):
            if p.is_file() and p.resolve() not in keep:
                delete.append(p)
                freed += p.stat().st_size

    by_runtime = {}
    for p in delete:
        rd = p.relative_to(ROOT).parts[0]
        by_runtime[rd] = by_runtime.get(rd, 0) + 1
    print(f"{'Deleting' if a.apply else 'Would delete'} {len(delete)} files, {freed / 1e9:.1f} GB: {by_runtime}")
    if not a.apply:
        for p in delete[:15]:
            print("  ", p.relative_to(ROOT))
        return
    for p in delete:
        p.unlink()
    # remove now-empty directories, deepest first
    for rd in runtime_dirs:
        base = ROOT / rd
        if base.is_dir():
            for d in sorted((d for d in base.rglob("*") if d.is_dir()), key=lambda d: len(d.parts), reverse=True):
                if not any(d.iterdir()):
                    d.rmdir()
    print("done")


if __name__ == "__main__":
    main()
