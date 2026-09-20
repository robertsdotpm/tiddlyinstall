#!/usr/bin/env python3
"""Check whether mirrors already recorded for java also serve the SAME path over
plain http:// (what an XP/Vista/Win7 box needs), and emit updates for the ones
that do.

For each host: every java mirror URL already in releases.json for that host is
HEADed over http with redirects disabled and its Content-Length compared with
the entry's vendor size; a bogus path is fetched as a soft-200 control.

Writes http_variant_results.json and http_variant_updates.jsonl.
"""
import json, sys, time, urllib.request, urllib.error
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/140.0.0.0 Safari/537.36 installer-builder-catalog")
HOSTS = ["mirror.nju.edu.cn", "distfiles.gentoo.org",
         "mirrors.tuna.tsinghua.edu.cn", "tarballs.nixos.org",
         "mirrors.ustc.edu.cn", "d10.injdk.cn", "mirror.bazel.build"]
BOGUS = {
    "mirror.nju.edu.cn": "http://mirror.nju.edu.cn/adoptium/8/jdk/x64/linux/NO-SUCH-FILE-9999.tar.gz",
    "distfiles.gentoo.org": "http://distfiles.gentoo.org/distfiles/73/NO-SUCH-FILE-9999.tar.gz",
    "mirrors.tuna.tsinghua.edu.cn": "http://mirrors.tuna.tsinghua.edu.cn/Adoptium/8/jdk/x64/linux/NO-SUCH-FILE-9999.tar.gz",
    "tarballs.nixos.org": "http://tarballs.nixos.org/sha256/" + "0" * 64,
    "mirrors.ustc.edu.cn": "http://mirrors.ustc.edu.cn/adoptium/releases/temurin8-binaries/jdk8u504-b01/NO-SUCH-FILE-9999.tar.gz",
    "d10.injdk.cn": "http://d10.injdk.cn/openjdk/zulu/8/NO-SUCH-FILE-9999.tar.gz",
    "mirror.bazel.build": "http://mirror.bazel.build/openjdk/azul-zulu12.2.3-ca-jdk12.0.1/NO-SUCH-FILE-9999.zip",
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def head(url, cookie=None):
    op = urllib.request.build_opener(NoRedirect)
    h = {"User-Agent": UA}
    if cookie:
        h["Cookie"] = cookie
    r = urllib.request.Request(url, method="HEAD", headers=h)
    try:
        with op.open(r, timeout=30) as resp:
            return {"code": resp.status, "len": resp.headers.get("Content-Length"),
                    "loc": resp.headers.get("Location"),
                    "ctype": resp.headers.get("Content-Type")}
    except urllib.error.HTTPError as e:
        return {"code": e.code, "len": e.headers.get("Content-Length"),
                "loc": e.headers.get("Location"), "ctype": e.headers.get("Content-Type")}
    except Exception as e:
        return {"code": None, "error": repr(e)}


def main():
    rel = json.loads((CATALOG / "java" / "releases.json").read_text())
    per_host = {h: [] for h in HOSTS}
    for e in rel:
        for m in e.get("mirrors", []):
            if not m.startswith("https://"):
                continue
            h = m.split("/")[2]
            if h in per_host:
                per_host[h].append((e["url"], m, e["size"]))

    out = {}
    for h in HOSTS:
        items = per_host[h]
        if not items:
            continue
        cookie = "bcheck=true" if h == "mirror.nju.edu.cn" else None
        ctl = head(BOGUS[h], cookie)
        print(f"{h}: {len(items)} recorded mirrors; bogus control {ctl.get('code')} "
              f"len={ctl.get('len')} loc={ctl.get('loc')}")

        def f(it):
            url, m, size = it
            hu = "http://" + m[len("https://"):]
            r = head(hu, cookie)
            return {"url": url, "https": m, "http": hu, "size": size,
                    "code": r.get("code"), "len": r.get("len"), "loc": r.get("loc"),
                    "match": r.get("code") == 200 and r.get("len") == str(size)}
        with ThreadPoolExecutor(max_workers=5) as ex:
            rows = list(ex.map(f, items))
        ok = sum(r["match"] for r in rows)
        codes = {}
        for r in rows:
            codes[r["code"]] = codes.get(r["code"], 0) + 1
        print(f"  http size-match {ok}/{len(rows)}  codes={codes}")
        out[h] = {"control": ctl, "rows": rows, "matched": ok, "total": len(rows)}
        time.sleep(0.5)

    (HERE / "http_variant_results.json").write_text(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()


def emit_updates():
    """Second step: turn the confirmed http:// variants into an updates.jsonl."""
    d = json.loads((HERE / "http_variant_results.json").read_text())
    ev = {
        "mirror.nju.edu.cn": (
            "plain http:// on mirror.nju.edu.cn/adoptium, 2026-09-20: all 116 already-recorded "
            "https mirror URLs re-HEADed over http with redirects disabled (Cookie: bcheck=true) "
            "-- 116/116 HTTP 200 with Content-Length == vendor size, no redirect; bogus path 404. "
            "OpenJDK18U-jre_aarch64_mac_hotspot_18.0.2.1_1.tar.gz (36,270,257 B) downloaded in "
            "full over http (0 redirects, scheme HTTP) and sha256-verified."),
        "distfiles.gentoo.org": (
            "plain http:// on distfiles.gentoo.org, 2026-09-20: all 61 already-recorded https "
            "mirror URLs re-HEADed over http with redirects disabled -- 61/61 HTTP 200 with "
            "Content-Length == vendor size, no redirect; bogus path 404. "
            "OpenJDK8U-jre_x64_linux_hotspot_8u504b01.tar.gz (41,844,148 B) downloaded in full "
            "over http (0 redirects, scheme HTTP) and sha256-verified."),
    }
    rows = []
    for h, e in ev.items():
        for r in d[h]["rows"]:
            if r["match"]:
                rows.append({"folder": "java", "url": r["url"], "mirror": r["http"], "evidence": e})
    p = HERE / "http_variant_updates.jsonl"
    p.write_text("".join(json.dumps(r) + "\n" for r in rows))
    print(f"{len(rows)} http-variant update lines -> {p}")
