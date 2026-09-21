#!/usr/bin/env python3
"""Builds the two packing-measurement pages (docs/browser-packing.md).

    python3 tests/packmem/build.py [--out tests/packmem/out]

Writes:
    packmem.html       the modern page (ES2017), for anything from ~Chrome 58 up
    packmem-es5.html   the same code through Babel and core-js, for the floor
                       (IE 11, Chrome 49, Firefox 52), the way the site's own
                       ES5 copy is made

Both carry the *real* modules -- src/shared/tifile.js and everything it imports --
joined by tools/build_site.py's own `join_modules`, so what is measured is the
shipping assembly path and not a sketch of it. The ES5 page is one file with
no compression, because the point is to measure the browser, not the loader.
"""
import argparse
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import build_site  # noqa: E402

# tifile.js and its import graph, in dependency order (the front of
# build_site.CORE_MODULES, minus what tifile does not need).
# Spelled with build_site's own helpers, so a folder rename moves this
# list with the one it is a prefix of instead of leaving it behind.
MODULES = [
    *build_site.web_lib("sha.js", "hmac-pbkdf2.js", "aes.js"),
    *build_site.web_lib("bignum.js", "der.js", "rsa.js", "ec.js"),
    *build_site.web_lib("ed25519.js", "cryptox.js"),
    *build_site.web_lib("inflate.js", "deflate.js", "zlib.js"),
    *build_site.shared("tifile.js"),
]

# A recorder ahead of everything, as tests/browsers/run.mjs does: a browser
# that cannot parse the bundle at all still says so, from a script that is
# ES3 and needs nothing but XMLHttpRequest.
EARLY = """
var TIQ = {}; (function () { var s = String(location.search || '').replace(/^\\?/, '');
  var p = s ? s.split('&') : []; for (var i = 0; i < p.length; i++) { var kv = p[i].split('=');
  TIQ[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\\+/g, ' ')); } })();
function tiSay(o) { o.run = TIQ.run || 'run'; o.t = (new Date()).getTime();
  try { var x = new XMLHttpRequest(); x.open('POST', TIQ.report, true);
  x.setRequestHeader('Content-Type', 'text/plain'); x.send(tiJson(o)); } catch (e) {} }
function tiJson(o) { var out = [], k; for (k in o) { if (!o.hasOwnProperty(k)) continue;
  var v = o[k]; out.push('"' + k + '":' + (typeof v === 'number' ? v :
    '"' + String(v).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/[\\r\\n\\t]/g, ' ') + '"')); }
  return '{' + out.join(',') + '}'; }
window.onerror = function (msg, src, line, col) {
  tiSay({ what: 'page-error', error: String(msg), where: String(src) + ':' + line + ':' + col }); };
if (window.addEventListener) window.addEventListener('unhandledrejection', function (e) {
  tiSay({ what: 'page-reject', error: String((e.reason && e.reason.message) || e.reason) }); });
tiSay({ what: 'page-loaded', ua: navigator.userAgent });
"""

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>packmem</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font:13px/1.4 monospace;margin:1em;max-width:100%%}
#out div{white-space:pre-wrap;word-break:break-all;border-bottom:1px solid #ddd;padding:2px 0}</style>
</head><body>
<h1>packmem</h1>
<p><button id="go">start</button> <span id="note"></span></p>
<div id="out"></div>
<script>%(early)s</script>
<script>%(code)s</script>
<script>document.getElementById('go').onclick=function(){window.packmemStart&&window.packmemStart();};</script>
</body></html>
"""


def join(mods):
    done = set()
    parts = []
    for m in mods:
        parts.append(build_site.join_modules([m], done))
        done.add(m)
    return "\n".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(HERE, "out"))
    ap.add_argument("--no-es5", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)

    bundle = join(MODULES)
    shim = open(os.path.join(HERE, "shim.js")).read()
    harness = open(os.path.join(HERE, "harness.js")).read()
    code = bundle + "\n" + shim + "\n" + harness

    modern = os.path.join(a.out, "packmem.html")
    with open(modern, "w") as f:
        f.write(PAGE % {"early": EARLY, "code": code})
    print("wrote", modern, os.path.getsize(modern), "bytes")

    if a.no_es5:
        return
    es5dir = os.path.join(ROOT, "tools", "es5")
    if not os.path.isdir(os.path.join(es5dir, "node_modules", "@babel", "core")):
        print("no ES5 page: run `npm install` in tools/es5", file=sys.stderr)
        return
    import shutil
    node = shutil.which("node") or os.path.expanduser("~/.local/node/bin/node")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "page.js")
        with open(src, "w") as f:
            f.write(code)
        dest = os.path.join(tmp, "es5.js")
        r = subprocess.run([node, os.path.join(es5dir, "build-es5.mjs"), "--out", dest, src],
                           capture_output=True, text=True)
        if r.returncode:
            sys.exit("build-es5.mjs failed:\n" + (r.stderr or "")[:3000])
        es5 = open(dest).read()
    # src/web_client/legacy-dom.js is what the site's ES5 copy runs first (dataset and
    # friends on IE); build-es5.mjs already prepends it and core-js.
    p = os.path.join(a.out, "packmem-es5.html")
    with open(p, "w") as f:
        f.write(PAGE % {"early": EARLY, "code": es5})
    print("wrote", p, os.path.getsize(p), "bytes")
    print((r.stdout or "").strip())


if __name__ == "__main__":
    main()
