#!/usr/bin/env python3
"""Build the site: one HTML file, TiddlyWiki-style (plan.md section 1.11).

    python3 tools/build_site.py [-o dist] [--catalog DIR] [--backend URL] [--multi]

Writes dist/index.html: every page as a section (#new, #edit, ...), the JS
modules joined into one classic script (ES2017, so it runs in Firefox 52 and
Chrome 58 up; tests/es2017-test.mjs checks it), kept in a code block that
web/page-loader.js runs, with an ES5 copy of it for IE 11 and Chrome 49
(tools/es5/, when installed; tests/es5-test.mjs), the CSS inlined (with
fallbacks for browsers without custom properties), and as data blocks the
three unsigned bases and the catalogue, split by folder so the page unpacks
only the runtimes it uses (docs/format.md section 6: an index with the shared
files and the runtimes summary, and one gzipped chunk per catalogue folder).
The build server serves it at /, and it uses that server; saved and opened from
disk ("Save this page" saves it exactly as loaded), or with "No server" chosen,
web/local-api.js answers its API calls inside the page instead.

Its sources are the pages in web/ (web/index.html, web/new.html, ...),
web/css/, and the JavaScript in web/, web/lib/ and shared/. --multi also
writes those folders as a site of separate files under dist/site/, keeping
the repository's own folder names so the pages' relative paths still work
(the entry page is then dist/site/web/index.html). Not used for now; kept
so it can be again.

The catalogue snapshot comes from tools/snapshot.mjs (Node.js) unless
--catalog names a folder that already has catalog.gz and runtimes.json;
tools/snapshot.mjs -from catalog.gz -split splits it for the page.
"""
import argparse
import base64
import datetime
import html
import io
import json
import os
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (section name, page file). The first is the default section.
PAGES = [("home", "web/index.html"), ("new", "web/new.html"), ("build", "web/build.html"),
         ("edit", "web/edit.html"), ("runtimes", "web/runtimes.html")]
# Other pages' links in the offline copy, by the file name a page links to.
LINK_ALIASES = {"create.html": "#new&write", "builds.html": "#home", "bases.html": "#new"}
# Copied to the regular site (--multi) as they are, keeping these names, so
# that the pages' relative paths (./x.js, ./lib/x.js, ../shared/x.js,
# ../vendor/x.js) resolve there exactly as they do in the repository.
SITE_FILES = ["web", "shared", "vendor"]

# ---------- the module load order ----------
#
# These three lists are a **load order**, not a picture of the folders.
# join_modules concatenates each module into one classic script in the
# order given, turning its imports into reads of the modules already
# joined, so the only rule is: every module comes after everything it
# imports. That is why one list mixes web/, web/lib/ and shared/ -- a
# crypto primitive and the API client sit side by side because of when
# they are needed, not because they belong together.
#
# The three lists are three phases, with page code in between:
#   EARLY   before anything else: the built-ins older browsers lack and
#           the :has() stand-in, installed right after the page is
#           captured for "Save this page".
#   CORE    everything the pages call, ending with the in-page API and
#           the router, which the pages expect to exist when they start.
#   PAGES   the four page modules, which run on load.
EARLY_MODULES = ["web/polyfills.js", "web/has-shim.js"]
CORE_MODULES = [
    "web/api.js",
    "web/open-notice.js",
    "shared/mirror-words.js", "shared/templates.js", "shared/form-job.js",
    "web/write-editor.js",
    "web/lib/sha.js", "web/lib/hmac-pbkdf2.js", "web/lib/aes.js",
    "web/lib/bignum.js", "web/lib/der.js", "web/lib/rsa.js", "web/lib/ec.js",
    "web/lib/ed25519.js", "web/lib/cryptox.js",
    "web/lib/inflate.js", "web/lib/deflate.js", "web/lib/zlib.js",
    "shared/tifile.js", "shared/icon.js",
    "web/lib/x509.js", "web/lib/legacy.js", "web/lib/pkcs12.js",
    "web/lib/authenticode.js", "web/lib/pgp.js",
    "web/sign-services.js", "web/sign-ui.js",
    "shared/resolve.js", "shared/builder.js",
    "web/overlay.js", "web/change-list.js", "web/overlay-consent.js",
    "web/local-api.js", "web/router.js",
]
PAGE_MODULES = ["web/new.js", "web/build.js", "web/edit.js", "web/catalog-editor.js"]
# Read on their own, not joined: three classic scripts the page carries
# inline (they must run before the modules, or without them), and the DOM
# shims only the ES5 copy uses (tools/es5/build-es5.mjs).
STANDALONE_SCRIPTS = ["web/browser-check.js", "web/page-loader.js",
                      "web/legacy-dom.js"]


def check_modules_accounted_for():
    """Every .js in web/, web/lib/ and shared/ is in exactly one list.

    The lists are hand-ordered (dependency order cannot be guessed from
    the folder), so a new module is easy to add and easy to forget --
    and a module left out of them is simply missing from the built page,
    which shows up as a runtime error in a browser rather than here.
    """
    listed = EARLY_MODULES + CORE_MODULES + PAGE_MODULES + STANDALONE_SCRIPTS
    twice = sorted(n for n in set(listed) if listed.count(n) > 1)
    if twice:
        sys.exit("build_site.py: listed more than once: " + ", ".join(twice))
    on_disk = set()
    for d in ("web", "web/lib", "shared"):
        for f in os.listdir(os.path.join(ROOT, d)):
            if f.endswith(".js"):
                on_disk.add(d + "/" + f)
    missing = sorted(on_disk - set(listed))
    gone = sorted(set(listed) - on_disk)
    if missing or gone:
        sys.exit("build_site.py: the module lists no longer match the tree"
                 + ("\n  not in any list: " + ", ".join(missing) if missing else "")
                 + ("\n  listed but not on disk: " + ", ".join(gone) if gone else ""))


# The resedit-js/pe-library bundle (icon editing) is a classic script.
RESEDIT_BUNDLE = "vendor/resedit-bundle.js"
# First existing path wins.
BASES = [
    ("windows", ["installer/windows/out/base.exe"]),
    ("linux", ["installer/unix/out/ti-base.run", "installer/unix/out/ti.run"]),
    ("macos", ["installer/unix/out/ti-base-macos.zip"]),
]


def read(rel, mode="r"):
    with open(os.path.join(ROOT, rel), mode) as f:
        return f.read()


def git_rev():
    try:
        return subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


# ---------- placeholders for bases that aren't built yet ----------

def placeholder_windows():
    """A PE header that parses (not runnable), then a note."""
    buf = bytearray(1024)
    buf[0:2] = b"MZ"
    struct.pack_into("<I", buf, 0x3C, 0x40)
    buf[0x40:0x44] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", buf, 0x44, 0x14C, 0, 0, 0, 0, 224, 0x0102)
    struct.pack_into("<H", buf, 0x44 + 20, 0x10B)
    struct.pack_into("<I", buf, 0x44 + 20 + 92, 16)
    note = b"installer-builder placeholder base: the real base.exe was not built when this page was made.\n"
    buf[512:512 + len(note)] = note
    return bytes(buf)


def placeholder_linux():
    return (b"#!/bin/sh\n"
            b"echo 'installer-builder placeholder base: the real ti-base.run was not built "
            b"when this page was made.' >&2\nexit 1\n")


def placeholder_macos():
    bio = io.BytesIO()
    date = (2026, 9, 18, 0, 0, 0)
    with zipfile.ZipFile(bio, "w", zipfile.ZIP_DEFLATED) as z:
        def add(name, data, mode):
            zi = zipfile.ZipInfo(name, date)
            zi.create_system = 3
            zi.external_attr = (mode << 16) | (0x10 if name.endswith("/") else 0)
            zi.compress_type = zipfile.ZIP_STORED if name.endswith("/") else zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
        add("Install.app/", b"", stat.S_IFDIR | 0o755)
        add("Install.app/Contents/", b"", stat.S_IFDIR | 0o755)
        add("Install.app/Contents/Info.plist",
            b'<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>'
            b"<key>CFBundleExecutable</key><string>install</string>"
            b"<key>CFBundleName</key><string>Install</string></dict></plist>\n",
            stat.S_IFREG | 0o644)
        add("Install.app/Contents/MacOS/", b"", stat.S_IFDIR | 0o755)
        add("Install.app/Contents/MacOS/install", placeholder_linux(), stat.S_IFREG | 0o755)
        add("Install.app/Contents/Resources/", b"", stat.S_IFDIR | 0o755)
    return bio.getvalue()


PLACEHOLDERS = {"windows": placeholder_windows, "linux": placeholder_linux, "macos": placeholder_macos}


# ---------- JS: the modules as one inline module ----------

# A relative specifier: "./x.js" within a folder, "../shared/x.js" or
# "../web/lib/x.js" across them. import_to_const resolves it against the
# importing module's folder, so the three folders can import each other.
IMPORT_RE = re.compile(r"^import\s+([\s\S]*?)\s+from\s+['\"](\.\.?/[^'\"]+)['\"];[ \t]*\n", re.M)
EXPORT_DECL_RE = re.compile(r"^export\s+((?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*))", re.M)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\};?[ \t]*\n", re.M)
# A JavaScript import or export left over (a form not bundled). Only module
# syntax: shared/templates.js holds other languages' code, whose lines may
# start with "import" (Python's `import os`, Java's, Go's, Nim's).
LEFTOVER_RE = re.compile(r"""^\s*(?:import\s*(?:[\w$*{][^;\n]*?\sfrom\s*)?['"][^'"\n]+['"]"""
                         r"""|export\s+(?:default\b|[{*]|(?:async\s+)?(?:function|const|let|var|class)\b))""", re.M)


def ns_name(rel):
    return "__ti_" + re.sub(r"\W", "_", os.path.splitext(os.path.basename(rel))[0])


def import_to_const(m, rel, done):
    what, src = m.group(1).strip(), m.group(2)
    dep = os.path.normpath(os.path.join(os.path.dirname(rel), src))
    if dep not in done:
        sys.exit(f"{rel} imports {src}, which is not earlier in the module lists")
    ns = ns_name(dep)
    if what.startswith("* as "):
        return f"const {what[5:].strip()} = {ns};\n"
    if what.startswith("{") and what.endswith("}"):
        names = [n.strip() for n in what[1:-1].split(",") if n.strip()]
        parts = [(a.strip() + ": " + b.strip()) if " as " in n else n for n in names for a, _, b in [n.partition(" as ")]]
        return "const { " + ", ".join(parts) + " } = " + ns + ";\n"
    sys.exit(f"{rel}: an import form this script can't bundle: {what}")


def join_modules(modules, done):
    """Each module in its own scope (a function returning its exports);
    imports become reads from those (`done`: modules already joined).
    Top-level await is not supported. The result is plain script code (no
    import/export), to go inside offline_page's function wrapper."""
    out = []
    for rel in modules:
        src = read(rel)
        src = IMPORT_RE.sub(lambda m: import_to_const(m, rel, done), src)
        exports = [m.group(2) for m in EXPORT_DECL_RE.finditer(src)]
        src = EXPORT_DECL_RE.sub(r"\1", src)
        for m in EXPORT_LIST_RE.finditer(src):
            for n in m.group(1).split(","):
                n = n.strip()
                if n:
                    a, _, b = n.partition(" as ")
                    exports.append(f"{b.strip()}: {a.strip()}" if b else a)
        src = EXPORT_LIST_RE.sub("", src)
        if LEFTOVER_RE.search(src):
            sys.exit(f"{rel}: an import/export form this script can't bundle")
        out.append(f"/* ---- {rel} ---- */\nconst {ns_name(rel)} = (() => {{\n{src}\nreturn {{ {', '.join(exports)} }};\n}})();")
        done.add(rel)
    return no_close_script("\n".join(out))


def no_close_script(js):
    # Must not end the <script> early.
    return re.sub(r"</(script)", r"<\\/\1", js, flags=re.I)


def b64_block(data):
    s = base64.b64encode(data).decode()
    return "\n".join(s[i:i + 100] for i in range(0, len(s), 100))


def data_block(id_, data, typ="application/octet-stream", extra=""):
    return f'  <script type="{typ}" id="{id_}"{extra}>\n{data}\n  </script>'


# ---------- older browsers: the ES5 copy and the CSS fallbacks ----------

MOTW = "<!-- saved from url=(0014)about:internet -->\r\n"
ES5_DIR = os.path.join(ROOT, "tools", "es5")
# IE 11 has no typed-array fill() or copyWithin(), which web/lib/inflate.js uses;
# this runs before the ES5 inflate (core-js adds the rest later).
TA_FILL = ("(function(){var T=[Int8Array,Uint8Array,Int16Array,Uint16Array,Int32Array,Uint32Array];"
           "function ix(v,n,d){return v===undefined?d:v<0?Math.max(n+v,0):Math.min(v,n);}"
           "function def(p,k,f){if(!p[k])Object.defineProperty(p,k,{configurable:true,writable:true,value:f});}"
           "for(var i=0;i<T.length;i++){var p=T[i]&&T[i].prototype;if(!p)continue;"
           "def(p,'fill',function(v,s,e){var n=this.length;s=ix(s,n,0);e=ix(e,n,n);for(var k=s;k<e;k++)this[k]=v;return this;});"
           "def(p,'copyWithin',function(t,s,e){var n=this.length;t=ix(t,n,0);s=ix(s,n,0);e=ix(e,n,n);var c=Math.min(e-s,n-t),k;"
           "if(s<t&&t<s+c)for(k=c-1;k>=0;k--)this[t+k]=this[s+k];else for(k=0;k<c;k++)this[t+k]=this[s+k];return this;});}})();\n")


def ascii_js(code):
    """Non-ASCII and control characters as \\uXXXX: valid in strings, regular expressions
    and identifiers, and the loader can then read the bytes as text."""
    def esc(m):
        units = m.group(0).encode("utf-16-le")
        return "".join("\\u%04x" % int.from_bytes(units[i:i + 2], "little") for i in range(0, len(units), 2))
    # And control characters: Babel writes "\\0" as a raw NUL, which ends a
    # string in IE's parser.
    return re.sub(r"[^\x09\x0a\x0d\x20-\x7e]", esc, code)


def build_es5(resedit, js):
    """The ES5 copy (tools/es5/build-es5.mjs), or None when its build tools
    aren't installed (the page then runs in ES2017 browsers only)."""
    if not os.path.isdir(os.path.join(ES5_DIR, "node_modules", "@babel", "core")):
        print("warning: no ES5 copy (IE 11, Chrome 49): run `npm install` in tools/es5", file=sys.stderr)
        return None
    node = shutil.which("node") or os.path.expanduser("~/.local/node/bin/node")
    with tempfile.TemporaryDirectory() as tmp:
        paths = {}
        for name, code in [("resedit.js", resedit), ("page.js", js),
                           ("inflate.js", join_modules(["web/lib/inflate.js"], set()))]:
            paths[name] = os.path.join(tmp, name)
            with open(paths[name], "w") as f:
                f.write(code)
        out, inf = os.path.join(tmp, "es5.js"), os.path.join(tmp, "inflate-es5.js")
        r = subprocess.run([node, os.path.join(ES5_DIR, "build-es5.mjs"), "--out", out,
                            "--inflate", paths["inflate.js"], "--inflate-out", inf,
                            paths["resedit.js"], paths["page.js"]], capture_output=True, text=True)
        if r.returncode:
            sys.exit("tools/es5/build-es5.mjs failed:\n" + r.stderr[:2000])
        with open(out) as f:
            code = ascii_js(f.read())
        with open(inf) as f:
            inflate = TA_FILL + f.read()
    return code, inflate, r.stdout.strip()


def code_blocks_for(resedit, js):
    """The page's code as data blocks, for web/page-loader.js to run."""
    blocks = [data_block("ti-js-resedit", resedit + "\n//# sourceURL=resedit.js", "text/x-ti-js"),
              data_block("ti-js", js + "//# sourceURL=tiddlyinstall.js", "text/x-ti-js")]
    report = []
    es5 = build_es5(resedit, js)
    if es5:
        code, inflate, log = es5
        raw = code.encode("ascii")
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        packed = c.compress(raw) + c.flush()
        blocks.append(data_block("ti-js-es5-inflate", no_close_script(inflate), "text/x-ti-js"))
        blocks.append(data_block("ti-js-es5", b64_block(packed), extra=' data-encoding="deflate-raw base64"'))
        report.append(f"  ES5 copy ({log}): {len(raw):,} bytes, {len(packed):,} deflated, "
                      f"inflate {len(inflate):,} bytes")
    else:
        report.append("  ES5 copy: none (tools/es5 not installed)")
    return blocks, report


# Where scripts don't run at all (turned off; Internet Explorer on Windows
# Server, whose Enhanced Security Configuration turns them off for the
# Internet zone), web/browser-check.js can't say anything: this does.
NOSCRIPT = ('  <noscript><div class="ti-compat-bar ti-too-old" role="alert" style="margin:0;padding:8px 16px;'
            'border-bottom:2px solid #b3261e;background:#fdecea;color:#410e0b;font:14px/1.4 sans-serif">'
            "JavaScript is off in this browser, so TiddlyInstall can't build or sign installers here; the pages still read. "
            "Turn JavaScript on for this page, or open it in a current browser. (Internet Explorer on Windows Server "
            "keeps JavaScript off while its Enhanced Security Configuration is on.) Without JavaScript, "
            "<a href=\"{classic}\">the build server's simple form</a> builds installers.</div></noscript>\n")


CSS_VAR_RE = re.compile(r"var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*?))?\s*\)")
CSS_DECL_RE = re.compile(r"(?<=[{;\s])([a-z-]+)(\s*:\s*)([^;{}]*var\(--[^;{}]*?)(\s*(?:!important)?\s*)(?=[;}])")


def legacy_css(css):
    """For browsers without custom properties (IE): before each declaration
    using var(), the same with the light theme's values, which browsers with
    them then override; and the display of HTML5 elements and [hidden], which
    IE 9-11 lack. The text stays readable dark-on-light without the rest."""
    root = re.search(r":root\s*\{([^}]*)\}", css)
    values = dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", root.group(1))) if root else {}

    def resolve(v):
        for _ in range(5):
            n = CSS_VAR_RE.sub(lambda m: values.get(m.group(1), m.group(2) or m.group(0)).strip(), v)
            if n == v:
                break
            v = n
        return None if "var(" in v else v

    def fix(m):
        prop, colon, val, imp = m.groups()
        plain = resolve(val)
        if plain is None:
            return m.group(0)
        return f"{prop}{colon}{plain}{imp}; {m.group(0)}"
    head = ("/* For browsers without custom properties or HTML5 elements (IE): tools/build_site.py legacy_css. */\n"
            "main, header, footer, nav, section, article, aside { display: block; }\n"
            "[hidden] { display: none; }\n")
    return head + CSS_DECL_RE.sub(fix, css)


# ---------- pages ----------

# By the file name the pages link to each other with: they are siblings in
# web/, so a link says "new.html", not "web/new.html".
PAGE_NAMES = {os.path.basename(f): n for n, f in PAGES}


def rewrite_links(fragment):
    def fix(m):
        attr, target = m.group(1), m.group(2)
        page, _, frag = target.partition("#")
        if page in LINK_ALIASES:
            return f'{attr}="{LINK_ALIASES[page]}"'
        if page in PAGE_NAMES:
            return f'{attr}="#{PAGE_NAMES[page]}' + (f"&{frag}" if frag else "") + '"'
        return m.group(0)
    return re.sub(r'(href)="([\w.-]+\.html(?:#[^"]*)?)"', fix, fragment)


def page_parts(rel):
    """title, body between the header and the footer, and the module tags."""
    page = read(rel)
    title = html.unescape(re.search(r"<title>(.*?)</title>", page, re.S).group(1).strip())
    m = re.search(r"</header>(.*?)<footer", page, re.S)
    if not m:
        sys.exit(f"{rel}: no </header> ... <footer> to take the page from")
    return title, m.group(1)


def offline_page(catalog_dir, backend):
    check_modules_accounted_for()
    index = read("web/index.html")
    header = re.search(r'<header class="site-header">.*?</header>', index, re.S).group(0)
    header = re.sub(r'\s*aria-current="page"', "", rewrite_links(header))
    sections, ids = [], {}
    for name, rel in PAGES:
        title, body = page_parts(rel)
        for i in set(re.findall(r'\sid="([^"]+)"', body)):
            if i in ids:
                sys.exit(f'id "{i}" is in both {ids[i]} and {rel}; the offline copy needs unique ids')
            ids[i] = rel
        hidden = "" if name == PAGES[0][0] else " hidden"
        sections.append(f'  <div class="ti-page" data-page="{name}" data-title="{html.escape(title)}"{hidden}>'
                        f"{rewrite_links(body)}</div>")

    rev, today = git_rev(), datetime.date.today().isoformat()
    report, blocks = [], []
    for os_name, rels in BASES:
        rel = next((r for r in rels if os.path.isfile(os.path.join(ROOT, r))), None)
        if rel:
            data, extra = read(rel, "rb"), ""
            report.append(f"  base {os_name:8} {rel} ({len(data):,} bytes)")
        else:
            data, extra = PLACEHOLDERS[os_name](), ' data-placeholder="1"'
            report.append(f"  base {os_name:8} PLACEHOLDER ({' or '.join(rels)} not found)")
        blocks.append(data_block(f"base-{os_name}", b64_block(data), extra=extra))
    # The catalogue, split (web/overlay.js reads it): #ti-catalog, the index
    # with the runtimes summary; #ti-cat-FOLDER, each folder's chunk.
    index, chunks = split_catalog(os.path.join(catalog_dir, "catalog.gz"))
    with open(os.path.join(catalog_dir, "runtimes.json")) as f:
        index["summary"] = json.load(f)
    index_json = json_block(index)
    blocks.append(data_block("ti-catalog", index_json, "application/json"))
    for folder, data in chunks:
        blocks.append(data_block("ti-cat-" + folder, b64_block(data), extra=f' data-folder="{folder}"'))
    packed = sum(len(d) for _, d in chunks)
    report.append(f"  catalogue: index {len(index_json.encode()):,} bytes (with the runtimes summary), "
                  f"{len(chunks)} folders {packed:,} bytes gzipped (largest {max(chunks, key=lambda c: len(c[1]))[0]} "
                  f"{max(len(d) for _, d in chunks):,})")
    # Catalogue changes "Save this page" can put inside the page (web/overlay.js
    # bakeOverlay); none in a freshly built page.
    blocks.append(data_block("ti-overlay", "null", "application/json", ' data-placeholder="1"'))
    info = {"built": today, "rev": rev, "backend": backend}
    blocks.append(data_block("ti-offline", json.dumps(info), "application/json"))
    # Where the page was tested, for web/browser-check.js (tests/browsers/compat.mjs).
    compat = os.path.join(ROOT, "tests", "browsers", "compat.json")
    blocks.append(data_block("ti-compat", no_close_script(read(compat).strip()) if os.path.isfile(compat) else "null", "application/json"))

    resedit = no_close_script(read(RESEDIT_BUNDLE))
    done = set()
    # One classic script, not a module (Firefox 52 has no modules), its
    # code in a strict function so that it behaves as the modules do.
    js = ("(function () {\n'use strict';\n"
          + join_modules(EARLY_MODULES, done)
          + "\n// The page exactly as loaded, for \"Save this page\": web/page-loader.js\n"
          "// takes it before it runs this; this is for a copy of the code run otherwise.\n"
          "if (typeof TI_PRISTINE === 'undefined') globalThis.TI_PRISTINE = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;\n"
          "globalThis.TI_HAS_LOCAL = true;\n"
          "globalThis.TI_ONE_FILE = true;\n"
          "__ti_has_shim.installHasShim();   // only where the browser has no :has()\n\n"
          + join_modules(CORE_MODULES, done)
          + "\n__ti_local_api.installLocalApi();\n"
          + join_modules(PAGE_MODULES, done)
          + "\n__ti_router.startRouter();\n})();\n")
    code_blocks, es5_report = code_blocks_for(resedit, js)
    report += es5_report

    css = legacy_css(read("web/css/style.css"))
    # The Mark of the Web (with its CRLF) lets Internet Explorer run the page
    # from disk: without it, IE's Local Machine Lockdown blocks its scripts.
    # It puts the file in IE's Internet zone, the stricter one; other browsers
    # ignore it. X-UA-Compatible keeps IE out of an older document mode.
    # Says what this file is to anyone who opens it in an editor. It goes
    # *after* the doctype on purpose: anything before a doctype, comments
    # included, drops older Internet Explorer into quirks mode, and this
    # page is meant to work there.
    banner = (
        "<!--\n"
        "  TiddlyInstall, built as one file. DO NOT EDIT THIS FILE.\n"
        "\n"
        "  Everything here is generated by tools/build_site.py: the pages, the\n"
        "  stylesheet, the JavaScript, the base installers and the runtime\n"
        "  metadata are all packed in, which is why it works with no server.\n"
        "  Edit the sources in the repository and build it again; an edit made\n"
        "  here is lost the next time anyone does.\n"
        "\n"
        f"  Built from {rev} on {today}.\n"
        "  https://github.com/robertsdotpm/installer-builder\n"
        "-->\n")
    out = ("<!DOCTYPE html>\n" + MOTW + banner + "<html lang=\"en\">\n<head>\n"
           "  <meta charset=\"utf-8\">\n"
           "  <meta http-equiv=\"X-UA-Compatible\" content=\"IE=edge\">\n"
           "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
           "  <title>TiddlyInstall</title>\n"
           f"  <meta name=\"generator\" content=\"tools/build_site.py, {rev}, {today}\">\n"
           # Too-old browsers get a message naming what's missing (a classic
           # script, so it runs where the module can't).
           "  <script>\n" + no_close_script(read("web/browser-check.js")) + "\n  </script>\n"
           "  <style>\n" + css + "\n  </style>\n</head>\n<body>\n  " + header + "\n"
           + NOSCRIPT.replace("{classic}", html.escape(backend.rstrip("/") + "/classic"))
           + "\n".join(sections) +
           "\n  <footer class=\"site-footer\">\n    Designed by <a href=\"https://robertsdotpm.github.io/\">Matthew Roberts</a> and implemented by Claude.\n  </footer>\n"
           + "\n".join(blocks + code_blocks) +
           "\n  <script>\n" + no_close_script(read("web/page-loader.js")) + "\n  </script>\n</body>\n</html>\n")
    return out, report


def json_block(v):
    """JSON for a data block: compact, and no "<" (so no "</script" or "<!--")."""
    return json.dumps(v, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")


def split_catalog(snapshot):
    """The snapshot split by folder (tools/snapshot.mjs -split; docs/format.md
    section 7): (index, [(folder, gzipped chunk)]) in the index's order."""
    node = shutil.which("node") or os.path.expanduser("~/.local/node/bin/node")
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run([node, os.path.join(ROOT, "tools", "snapshot.mjs"), "-from", snapshot, "-split", tmp],
                       check=True, stdout=subprocess.DEVNULL)
        with open(os.path.join(tmp, "index.json")) as f:
            index = json.load(f)
        chunks = []
        for folder in index["folders"]:
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", folder):
                sys.exit(f"catalogue folder name {folder!r} can't name a block")
            with open(os.path.join(tmp, folder + ".gz"), "rb") as f:
                chunks.append((folder, f.read()))
    return index, chunks


def make_snapshot(tmp):
    print("making the catalogue snapshot…", flush=True)
    node = shutil.which("node") or os.path.expanduser("~/.local/node/bin/node")
    subprocess.run([node, os.path.join(ROOT, "tools", "snapshot.mjs"), "-o", tmp], check=True)
    return tmp


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", default=os.path.join(ROOT, "dist"))
    ap.add_argument("--catalog", help="folder with catalog.gz and runtimes.json (default: make them)")
    ap.add_argument("--backend", default="http://10.0.1.76:8080",
                    help="build server named in records the page makes itself")
    ap.add_argument("--multi", action="store_true", help="also write the site as separate pages to dist/site/")
    a = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        cat = a.catalog or make_snapshot(tmp)
        page, report = offline_page(cat, a.backend)

    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "index.html"), "w") as f:
        f.write(page)
    print(f"wrote {a.out}/index.html ({len(page.encode()):,} bytes)")
    if a.multi:
        site = os.path.join(a.out, "site")
        if os.path.isdir(site):
            shutil.rmtree(site)
        os.makedirs(site)
        for rel in SITE_FILES:
            src = os.path.join(ROOT, rel)
            if os.path.isdir(src):
                shutil.copytree(src, os.path.join(site, rel), ignore=shutil.ignore_patterns("package.json"))
            else:
                shutil.copy2(src, os.path.join(site, rel))
        print(f"wrote {site}/ (separate pages)")
    print("\n".join(report))


if __name__ == "__main__":
    main()
