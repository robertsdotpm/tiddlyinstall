#!/usr/bin/env python3
"""Hash-addressed sweep of distfiles.gentoo.org for every still-unmirrored java file.

Gentoo's distfiles layout (distfiles/layout.conf: "filename-hash BLAKE2B 8") puts
each file at  distfiles/<first 2 hex chars of blake2b(filename)>/<filename>.
That is computable offline, so we can ask the mirror directly for every catalogue
file rather than only for the ones named in a current Manifest -- Gentoo keeps
distfiles from older ebuild revisions for a while after they leave the tree.

Both the hashed path and the legacy flat path are tried, over https and http.
Writes gentoo_sweep_results.json; gentoo_sweep_updates.jsonl is generated from it.
"""
import hashlib, json, sys, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/140.0.0.0 Safari/537.36 installer-builder-catalog")
HOST = "distfiles.gentoo.org"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def head(url):
    op = urllib.request.build_opener(NoRedirect)
    r = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with op.open(r, timeout=30) as resp:
            return resp.status, resp.headers.get("Content-Length")
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception:
        return None, None


def layout_path(name):
    return f"{hashlib.blake2b(name.encode()).hexdigest()[:2]}/{name}"


def main():
    rel = json.loads((CATALOG / "java" / "releases.json").read_text())
    todo = [e for e in rel if not e.get("mirrors")]
    print(f"{len(todo)} unmirrored java entries")

    def f(e):
        name = e["url"].rsplit("/", 1)[-1]
        for path in (layout_path(name), name):
            u = f"https://{HOST}/distfiles/{path}"
            code, ln = head(u)
            if code == 200 and ln == str(e["size"]):
                hu = f"http://{HOST}/distfiles/{path}"
                hcode, hln = head(hu)
                return {"url": e["url"], "mirror": u, "http": hu, "size": e["size"],
                        "http_ok": hcode == 200 and hln == str(e["size"]), "code": code}
        return None

    hits = []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, r in enumerate(ex.map(f, todo), 1):
            if r:
                hits.append(r)
            if i % 250 == 0:
                print(f"  ... {i}/{len(todo)}, {len(hits)} hits", file=sys.stderr)
    # control
    ctl = head(f"https://{HOST}/distfiles/{layout_path('NO-SUCH-FILE-9999.tar.gz')}")
    print("bogus control:", ctl)
    (HERE / "gentoo_sweep_results.json").write_text(
        json.dumps({"hits": hits, "control": ctl, "probed": len(todo)}, indent=1))
    print(f"{len(hits)} hits, {sum(h['http_ok'] for h in hits)} of them also over http")


if __name__ == "__main__":
    main()
