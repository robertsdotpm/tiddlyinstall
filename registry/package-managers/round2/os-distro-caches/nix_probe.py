import json, urllib.request, time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

CATALOG = Path("/home/x/projects/installer-builder-runtimes/catalog")
UA = "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog"

runtimes = ["ruby","java","cc"]
candidates = []
for rt in runtimes:
    d = json.loads((CATALOG/rt/"releases.json").read_text())
    for e in d:
        if not e.get("mirrors") and e.get("checksum") and e["checksum"].get("algo")=="sha256":
            candidates.append({"runtime": rt, "url": e["url"], "sha256": e["checksum"]["value"], "size": e.get("size")})

print("candidates:", len(candidates))

def check(c):
    url = f"https://tarballs.nixos.org/sha256/{c['sha256']}"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            cl = resp.headers.get("Content-Length")
            final_url = resp.geturl()
            return {**c, "found": True, "content_length": cl, "final_url": final_url}
    except Exception as ex:
        return {**c, "found": False, "error": str(ex)}

t0=time.time()
results=[]
with ThreadPoolExecutor(max_workers=10) as ex:
    for r in ex.map(check, candidates):
        results.append(r)
print("elapsed", time.time()-t0)
found = [r for r in results if r["found"]]
print("found:", len(found))
Path("nix_results.json").write_text(json.dumps(results))
from collections import Counter
print(Counter(r["runtime"] for r in found))
for r in found[:20]:
    print(r["runtime"], r["url"], r["content_length"], r.get("size"))
