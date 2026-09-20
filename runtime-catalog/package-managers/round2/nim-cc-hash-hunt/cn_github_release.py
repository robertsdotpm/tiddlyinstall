#!/usr/bin/env python3
"""Enumerate the three newly-found CN `github-release` mirrors and match their
listings to cc/releases.json by exact file name, then HEAD-verify each hit.

These are curated rsync mirrors of a fixed project list (the same family as the
already-confirmed mirror.nju.edu.cn), NOT ghproxy-style on-demand proxies.
Rolling window: they hold only the newest LLVM tag and the last ~9 WinLibs tags,
so nothing is ever applied by template -- every candidate is HEAD-checked.
"""
import json, re, sys, urllib.parse, urllib.request
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe import probe, HEADERS  # noqa: E402

CAT = Path("/home/x/projects/installer-builder/runtime-catalog")
HOSTS = {
    "mirrors.bfsu.edu.cn": "https://mirrors.bfsu.edu.cn/github-release/",
    "mirror.lzu.edu.cn": "https://mirror.lzu.edu.cn/github-release/",
    "mirrors.nyist.edu.cn": "https://mirrors.nyist.edu.cn/github-release/",
}
PROJECTS = ["llvm/llvm-project/", "brechtsanders/winlibs_mingw/", "skeeto/w64devkit/"]


def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=30) as r:
            return r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return f"<!--ERROR {e!r}-->"


def links(html):
    return [m for m in re.findall(r'href="([^"]+)"', html)
            if not m.startswith(("/", "http", "?", "#", "../"))]


rel = json.loads((CAT / "cc" / "releases.json").read_text())
by_name = {}
for e in rel:
    by_name.setdefault(urllib.parse.unquote(e["url"].rsplit("/", 1)[-1]), []).append(e)

pairs, meta = [], []
listing = {}
for host, base in HOSTS.items():
    for proj in PROJECTS:
        root = base + proj
        html = get(root)
        subdirs = [d for d in links(html) if d.endswith("/")]
        listing[root] = subdirs
        if not subdirs:
            print(f"{root}: no subdirectories ({'ERROR' if 'ERROR' in html else 'absent/empty'})")
            continue
        for sd in subdirs:
            sub = root + sd
            for f in links(get(sub)):
                if f.endswith("/"):
                    continue
                name = urllib.parse.unquote(f)
                for e in by_name.get(name, []):
                    pairs.append((e["size"], sub + f))
                    meta.append((host, e["url"], sub + f))
    # bogus-path control, one per host
    pairs.append((None, base + "llvm/llvm-project/NoSuchRelease-xyz123/bogus.tar.xz"))
    meta.append((host, None, base + "llvm/llvm-project/NoSuchRelease-xyz123/bogus.tar.xz"))

print(f"{len(pairs)} candidate URLs")
res = probe(pairs, "cn-github-release")
out = []
for (host, entry_url, murl), r in zip(meta, res):
    print(f"{host:22} {r.get('status')} {r.get('length')} exp={r['expected']} "
          f"{'MATCH' if r['match'] else ''} {murl.rsplit('/',1)[-1][:70]}")
    if r["match"] and entry_url:
        out.append({"folder": "cc", "url": entry_url, "mirror": murl, "host": host})
Path("cn_github_release_hits.json").write_text(json.dumps(out, indent=1))
print(f"\n{len(out)} confirmed mirror links")
