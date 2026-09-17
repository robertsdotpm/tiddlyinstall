import json, urllib.request, concurrent.futures, sys

CAT = "/home/x/projects/installer-builder-runtimes/catalog"
e = json.loads(open(f"{CAT}/php/releases.json").read())
sp = [x for x in e if x.get("variant")=="static-php-cli"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) installer-builder-catalog"

def head(url, expected_size):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            cl = r.headers.get("Content-Length")
            return (url, r.status, int(cl) if cl else None, expected_size)
    except Exception as ex:
        return (url, "ERR", str(ex), expected_size)

mismatches = []
oks = 0
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
    futs = []
    for x in sp:
        mirror = x["url"].replace(
            "https://dl.static-php.dev/static-php-cli/common/",
            "https://static-php-cli.fra1.digitaloceanspaces.com/static-php-cli/common/",
        )
        futs.append(ex.submit(head, mirror, x.get("size")))
    for f in concurrent.futures.as_completed(futs):
        url, status, cl, expected = f.result()
        if status == 200 and cl == expected:
            oks += 1
        else:
            mismatches.append((url, status, cl, expected))

print("OK:", oks, "of", len(sp))
print("Mismatches:", len(mismatches))
for m in mismatches[:20]:
    print(m)
