#!/usr/bin/env python3
"""mirror.bazel.build/openjdk/ -- Bazel project's Azul Zulu mirror.

Reads the mirror's own index.html, maps every listed Zulu binary onto a
catalogue entry by exact file name, then:
  * fetches the mirror's per-directory SHA256SUM and compares it with the
    catalogue's vendor sha256 (hash-level proof, no download),
  * HEADs each file over https AND http with redirects disabled and compares
    Content-Length with the vendor size,
  * runs bogus-path controls.

Writes bazel_results.json. Re-runnable.
"""
import json, re, sys, time, urllib.request, urllib.error
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
BASE = "mirror.bazel.build/openjdk"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/140.0.0.0 Safari/537.36 installer-builder-catalog")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def req(url, method="GET", follow=False, timeout=60):
    op = urllib.request.build_opener(*([] if follow else [NoRedirect]))
    r = urllib.request.Request(url, method=method, headers={"User-Agent": UA})
    try:
        with op.open(r, timeout=timeout) as resp:
            return {"code": resp.status, "len": resp.headers.get("Content-Length"),
                    "loc": resp.headers.get("Location"), "final": resp.geturl(),
                    "body": resp.read().decode("utf-8", "replace") if method == "GET" else None}
    except urllib.error.HTTPError as e:
        return {"code": e.code, "loc": e.headers.get("Location"),
                "body": e.read(500).decode("utf-8", "replace") if method == "GET" else None}
    except Exception as e:
        return {"code": None, "error": repr(e)}


def main():
    rel = json.loads((CATALOG / "java" / "releases.json").read_text())
    by_name = {}
    for e in rel:
        by_name.setdefault(e["url"].rsplit("/", 1)[-1], e)

    idx = req(f"https://{BASE}/index.html", follow=True)
    paths = sorted(set(re.findall(r'href="((?:azul-)[^"]+)"', idx["body"])))
    dirs = sorted({p.split("/")[0] for p in paths})
    print(f"{len(paths)} listed paths in {len(dirs)} version directories")

    # per-directory SHA256SUM
    sums = {}
    for d in dirs:
        r = req(f"https://{BASE}/{d}/SHA256SUM", follow=True)
        if r["code"] == 200:
            for line in r["body"].splitlines():
                m = re.match(r"([0-9a-f]{64})\s+\*?(\S+)", line.strip())
                if m:
                    sums[(d, m.group(2).lstrip("./"))] = m.group(1)
        time.sleep(0.2)
    print(f"{len(sums)} SHA256SUM lines parsed")

    rows = []
    for p in paths:
        d, name = p.split("/", 1)
        if name == "SHA256SUM":
            continue
        e = by_name.get(name)
        if not e:
            continue
        https_u = f"https://{BASE}/{p}"
        http_u = f"http://{BASE}/{p}"
        hs = req(https_u, method="HEAD")
        time.sleep(0.2)
        hp = req(http_u, method="HEAD")
        time.sleep(0.2)
        vend = (e.get("checksum") or {}).get("value")
        mirror_hash = sums.get((d, name))
        rows.append({
            "url": e["url"], "mirror": https_u, "mirror_http": http_u,
            "vendor_size": e["size"], "vendor_sha256": vend,
            "mirror_sha256sum": mirror_hash,
            "sha256_agrees": bool(mirror_hash and vend and mirror_hash == vend),
            "https_code": hs.get("code"), "https_len": hs.get("len"),
            "https_match": hs.get("code") == 200 and hs.get("len") == str(e["size"]),
            "http_code": hp.get("code"), "http_len": hp.get("len"),
            "http_loc": hp.get("loc"),
            "http_match": hp.get("code") == 200 and hp.get("len") == str(e["size"]),
        })
        print(rows[-1]["https_match"], rows[-1]["http_match"], rows[-1]["sha256_agrees"], name)

    controls = []
    for u in [f"https://{BASE}/azul-zulu-no-such-dir-9999/zulu1.tar.gz",
              f"https://{BASE}/azul-zulu12.2.3-ca-jdk12.0.1/no-such-file-9999.tar.gz",
              f"http://{BASE}/azul-zulu12.2.3-ca-jdk12.0.1/no-such-file-9999.tar.gz"]:
        r = req(u, follow=True)
        controls.append({"url": u, "code": r.get("code"), "len": len(r.get("body") or "")})
        print("control", controls[-1])

    out = {"rows": rows, "controls": controls,
           "index": f"https://{BASE}/index.html", "checked": time.strftime("%Y-%m-%d")}
    (HERE / "bazel_results.json").write_text(json.dumps(out, indent=1))
    print("matched entries:", len(rows),
          "| https size-match:", sum(r["https_match"] for r in rows),
          "| http size-match:", sum(r["http_match"] for r in rows),
          "| sha256 agrees:", sum(r["sha256_agrees"] for r in rows))


if __name__ == "__main__":
    main()
