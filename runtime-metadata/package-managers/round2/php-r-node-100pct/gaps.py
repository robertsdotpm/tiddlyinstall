import json, sys
from pathlib import Path
CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
for rt in ["php", "r", "node"]:
    entries = json.loads((CAT/rt/"releases.json").read_text())
    unmirrored = [e for e in entries if not e.get("mirrors")]
    print(f"=== {rt}: {len(unmirrored)}/{len(entries)} unmirrored ===")
    from collections import Counter
    c = Counter((e.get("os"), e.get("kind"), e.get("variant")) for e in unmirrored)
    for k,v in sorted(c.items(), key=lambda x:-x[1]):
        print(" ", k, v)
