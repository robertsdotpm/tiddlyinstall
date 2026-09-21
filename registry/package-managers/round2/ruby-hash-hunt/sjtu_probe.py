#!/usr/bin/env python3
"""Per-entry check of SJTU's github-release mirror for every Ruby GitHub asset.

    python3 sjtu_probe.py ri2     # oneclick/rubyinstaller2 entries
    python3 sjtu_probe.py rest    # rubyinstaller (v1), ruby-builder, rv-ruby,
                                  # homebrew-portable-ruby

mirror.sjtu.edu.cn rewrites https://github.com/<owner>/<repo>/releases/...
to https://mirror.sjtu.edu.cn/github-release/<owner>/<repo>/releases/... .
Three outcomes, only the first of which is a mirror:

  301 -> s3.jcloud.sjtu.edu.cn   SJTU's own object storage holds the file
  200 <- release-assets.githubusercontent.com   on-demand proxy of GitHub
  301 -> github.com / 404        not carried at all

IMPORTANT: use a NON-browser User-Agent. SJTUG's "Cerberus" bot check
challenges (or flat 403s) any "Mozilla/..." UA -- which is why round 2, following
MIRROR-HUNT.md's browser-UA advice, concluded this mirror was unreachable. With
a plain UA the response header is `cerberus-sec: DISABLED` and requests sail
through.

Results are written to sjtu_<set>_hits.json (entries whose final Content-Length
on SJTU's own S3 equals the catalogue's vendor size).
"""
import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from probe import run, PLAIN_UA  # noqa: E402

CATALOG = Path(__file__).resolve().parents[3]


def sj(u):
    return u.replace("https://github.com/", "https://mirror.sjtu.edu.cn/github-release/")


def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "ri2"
    e = json.loads((CATALOG / "ruby" / "releases.json").read_text())
    gh = [x for x in e if x["url"].startswith("https://github.com/")]
    if which == "ri2":
        sel = [x for x in gh if "/oneclick/rubyinstaller2/" in x["url"]]
    else:
        sel = [x for x in gh if "/oneclick/rubyinstaller2/" not in x["url"]]
    print(which, len(sel), Counter("/".join(x["url"].split("/")[3:5]) for x in sel))
    res = run([sj(x["url"]) for x in sel], follow=True, workers=8, ua=PLAIN_UA)
    print(Counter((r[0], r[2]) for r in res))
    hits = [(x, r) for x, r in zip(sel, res)
            if r[0] == 200 and r[2] == "s3.jcloud.sjtu.edu.cn" and str(r[1]) == str(x["size"])]
    mism = [(x, r) for x, r in zip(sel, res)
            if r[0] == 200 and r[2] == "s3.jcloud.sjtu.edu.cn" and str(r[1]) != str(x["size"])]
    print("size-matched on SJTU S3:", len(hits), "| size mismatches:", len(mism))
    for x, r in mism[:10]:
        print("  MISMATCH", x["url"].rsplit("/", 1)[1], x["size"], r[1])
    out = Path(__file__).resolve().parent / f"sjtu_{which}_hits.json"
    out.write_text(json.dumps(
        [{"url": x["url"], "mirror": sj(x["url"]), "size": x["size"], "final_cl": r[1]}
         for x, r in hits], indent=1))
    print("wrote", out.name)


if __name__ == "__main__":
    main()
