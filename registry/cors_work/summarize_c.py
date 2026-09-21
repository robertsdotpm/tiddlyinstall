import json, sys
from collections import defaultdict
from urllib.parse import urlsplit
d = defaultdict(list)
for l in open(sys.argv[1]):
    r = json.loads(l); d[r["host"]].append(r)
for h, rs in d.items():
    oks = [r["ok"] for r in rs]
    print(h, "ok=", oks)
    for r in rs:
        chain = " -> ".join(f'{urlsplit(x["url"]).netloc}{urlsplit(x["url"]).path[:40]}[{x["status"]},{x["acao"]}]' for x in r["hops"])
        print("   ", r["ok"], (r["error"] or "")[:80], chain[:260])
