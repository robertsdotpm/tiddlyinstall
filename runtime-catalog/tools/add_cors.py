#!/usr/bin/env python3
"""Record whether download hosts allow cross-origin browser downloads (CORS).

usage: add_cors.py <records.jsonl> [<records.jsonl> ...]

Each line is one host record (see SCHEMA.md, "cors.json"):

  {"host": "nodejs.org", "status": "yes", "allow_origin": "*",
   "redirects_to": [], "path_rules": [], "browser_confirmed": true,
   "tested": "2026-09-18", "samples": ["https://nodejs.org/dist/..."],
   "notes": "..."}

- Merges into catalog/cors.json keyed by host; fields in a new record replace
  the old ones for that host, other fields are kept.
- Every record is also appended to catalog/cors_evidence.jsonl.
- Writes atomically under the shared catalog/.write.lock, so several agents can
  use it at once, alongside add_mirrors.py.
"""
import fcntl
import json
import os
import sys
import tempfile
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
LOCK = CATALOG / ".write.lock"
OUT = CATALOG / "cors.json"
EVIDENCE = CATALOG / "cors_evidence.jsonl"
STATUSES = {"yes", "no", "partial", "unreachable"}


def main():
    records = []
    for a in sys.argv[1:]:
        for line in Path(a).read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                if not r.get("host") or r.get("status") not in STATUSES:
                    sys.exit(f"bad record (needs host and status in {sorted(STATUSES)}): {line}")
                records.append(r)
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = json.loads(OUT.read_text()) if OUT.exists() else {"hosts": {}}
        for r in records:
            data["hosts"].setdefault(r["host"], {}).update(r)
        data["hosts"] = dict(sorted(data["hosts"].items()))
        fd, tmp = tempfile.mkstemp(dir=CATALOG, prefix="cors.json", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=1, ensure_ascii=False)
        os.replace(tmp, OUT)
        with open(EVIDENCE, "a") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
    print(f"recorded {len(records)} host(s); cors.json now has {len(data['hosts'])}")


if __name__ == "__main__":
    main()
