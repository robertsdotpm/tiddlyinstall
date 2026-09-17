#!/usr/bin/env python3
"""Safely append confirmed mirrors and checksum corroborations to catalog entries.

usage: add_mirrors.py <updates.jsonl> [<updates.jsonl> ...]
       add_mirrors.py --flush-pending         # apply queued updates for folders no longer busy

Each line of an updates file is one JSON object:

  {"folder": "java", "url": "<entry's primary url>", "mirror": "<confirmed mirror url>",
   "evidence": "HEAD size match 2026-09-17; sha256 sample verified"}

  {"folder": "cc", "url": "<entry's primary url>",
   "checksum_corroboration": {"algo": "sha256", "value": "…", "source": "winget-pkgs manifest LLVM.LLVM 18.1.8"}}

- Matches entries by exact primary `url` in releases.json and every download_plan*.json.
- Appends (no duplicates); never changes url, checksum or any other field.
- Writes atomically under an exclusive lock (catalog/.write.lock), so several
  agents and background jobs can use it at once.
- Folders listed in catalog/.busy (one name per line) are being edited by another
  process: their updates are queued in catalog/pending_updates/<folder>.jsonl
  and applied later with --flush-pending.
- Evidence for mirrors is recorded in <folder>/mirror_evidence.jsonl.
"""
import fcntl
import json
import os
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
LOCK = CATALOG / ".write.lock"
BUSY = CATALOG / ".busy"
PENDING = CATALOG / "pending_updates"


def busy_folders():
    return {l.strip() for l in BUSY.read_text().splitlines() if l.strip()} if BUSY.exists() else set()


def atomic_write(path, data):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def apply(folder, updates):
    files = [CATALOG / folder / "releases.json"] + sorted((CATALOG / folder).glob("download_plan*.json"))
    counts = defaultdict(int)
    for path in files:
        if not path.exists():
            continue
        entries = json.loads(path.read_text())
        by_url = defaultdict(list)
        for e in entries:
            by_url[e["url"]].append(e)
        changed = False
        for u in updates:
            for e in by_url.get(u["url"], []):
                if "mirror" in u:
                    mirrors = e.setdefault("mirrors", [])
                    if u["mirror"] != e["url"] and u["mirror"] not in mirrors:
                        mirrors.append(u["mirror"])
                        changed = True
                        if path.name == "releases.json":
                            counts["mirrors"] += 1
                if "checksum_corroboration" in u:
                    cc = e.setdefault("checksum_corroboration", [])
                    if u["checksum_corroboration"] not in cc:
                        cc.append(u["checksum_corroboration"])
                        changed = True
                        if path.name == "releases.json":
                            counts["corroborations"] += 1
        if changed:
            atomic_write(path, entries)
    with open(CATALOG / folder / "mirror_evidence.jsonl", "a") as f:
        for u in updates:
            f.write(json.dumps(u) + "\n")
    return dict(counts)


def main():
    args = sys.argv[1:]
    PENDING.mkdir(exist_ok=True)
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        busy = busy_folders()
        grouped = defaultdict(list)
        if args == ["--flush-pending"]:
            for p in PENDING.glob("*.jsonl"):
                if p.stem in busy:
                    continue
                grouped[p.stem] += [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
                p.unlink()
        else:
            for a in args:
                for line in Path(a).read_text().splitlines():
                    if line.strip():
                        u = json.loads(line)
                        grouped[u["folder"]].append(u)
        for folder, updates in grouped.items():
            if folder in busy:
                with open(PENDING / f"{folder}.jsonl", "a") as f:
                    for u in updates:
                        f.write(json.dumps(u) + "\n")
                print(f"{folder}: busy, queued {len(updates)} updates")
            else:
                print(f"{folder}: {apply(folder, updates)}")


if __name__ == "__main__":
    main()
