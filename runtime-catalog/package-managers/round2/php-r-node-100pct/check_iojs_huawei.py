import json, urllib.request, concurrent.futures

CAT = "/home/x/projects/installer-builder-runtimes/catalog"
e = json.loads(open(f"{CAT}/node/releases.json").read())
io = [x for x in e if x.get("variant")=="iojs" and not x.get("mirrors")]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) installer-builder-catalog"

def head(url):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            cl = r.headers.get("Content-Length")
            return (r.status, int(cl) if cl else None)
    except Exception as ex:
        code = getattr(ex, "code", None)
        return (code or "ERR", str(ex)[:80])

def check(x):
    mirror = x["url"].replace("https://iojs.org/dist", "https://mirrors.huaweicloud.com/iojs")
    mstatus, msize = head(mirror)
    expected = x.get("size")
    if expected is None:
        vstatus, vsize = head(x["url"])
        expected = vsize if vstatus == 200 else None
    ok = (mstatus == 200 and expected is not None and msize == expected)
    return (x["url"], mirror, mstatus, msize, expected, ok)

results = []
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
    for r in ex.map(check, io):
        results.append(r)

oks = [r for r in results if r[5]]
bad = [r for r in results if not r[5]]
print("OK:", len(oks), "of", len(results))
print("Bad sample:")
for r in bad[:20]:
    print(r)
