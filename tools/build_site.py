#!/usr/bin/env python3
"""Build the site: one HTML file, TiddlyWiki-style (plan.md section 1.11).

    python3 tools/build_site.py [-o dist] [--catalog DIR] [--backend URL] [--multi]

Writes dist/index.html: every page as a section (#new, #edit, ...), the JS
modules joined into one inline module, the CSS inlined, and as data blocks the
three unsigned bases, the catalogue snapshot and the runtimes summary. The
build server serves it at /, and it uses that server; saved and opened from
disk ("Save this page" saves it exactly as loaded), or with "No server" chosen,
js/local-api.js answers its API calls inside the page instead.

The pages in the repo (index.html, new.html, ...) and js/, css/ are its
sources. --multi also writes them as a site of separate files to dist/site/
(not used for now; kept so it can be again).

The catalogue snapshot comes from `go run ./cmd/ibsnapshot` in server/ unless
--catalog names a folder that already has catalog.gz and runtimes.json.
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (section name, page file). The first is the default section.
PAGES = [("home", "index.html"), ("new", "new.html"), ("build", "build.html"),
         ("edit", "edit.html"), ("bases", "bases.html")]
# Other pages' links in the offline copy.
LINK_ALIASES = {"create.html": "#new&write", "builds.html": "#home"}
# Copied to the regular site as they are.
SITE_FILES = ["index.html", "new.html", "build.html", "builds.html", "edit.html", "bases.html",
              "create.html", "css", "js", "vendor"]
# Dependency order: each module comes after everything it imports. The
# library modules run first; then the local API is installed, and then the
# page modules run (they call the API as they start).
LIB_MODULES = ["js/api.js", "js/ibfile.js", "js/icon.js", "js/der.js", "js/x509.js", "js/legacy.js",
               "js/pkcs12.js", "js/authenticode.js", "js/pgp.js", "js/sign-ui.js", "js/resolve.js",
               "js/builder.js", "js/local-api.js", "js/router.js"]
PAGE_MODULES = ["js/new.js", "js/build.js", "js/edit.js"]
# The resedit-js/pe-library bundle (icon editing) is a classic script.
RESEDIT_BUNDLE = "vendor/resedit-bundle.js"
# First existing path wins.
BASES = [
    ("windows", ["bases/windows/out/base.exe"]),
    ("linux", ["bases/unix/out/ib-base.run", "bases/unix/out/ib.run"]),
    ("macos", ["bases/unix/out/ib-base-macos.zip"]),
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
            b"echo 'installer-builder placeholder base: the real ib-base.run was not built "
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

IMPORT_RE = re.compile(r"^import\s+([\s\S]*?)\s+from\s+['\"](\./[^'\"]+)['\"];[ \t]*\n", re.M)
EXPORT_DECL_RE = re.compile(r"^export\s+((?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*))", re.M)
EXPORT_LIST_RE = re.compile(r"^export\s*\{([^}]*)\};?[ \t]*\n", re.M)


def ns_name(rel):
    return "__ib_" + re.sub(r"\W", "_", os.path.splitext(os.path.basename(rel))[0])


def import_to_const(m, rel, done):
    what, src = m.group(1).strip(), m.group(2)
    dep = os.path.normpath(os.path.join(os.path.dirname(rel), src))
    if dep not in done:
        sys.exit(f"{rel} imports {src}, which is not earlier in MODULES")
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
    Top-level await is not supported."""
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
        if re.search(r"^\s*(?:import|export)\b", src, re.M):
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


# ---------- pages ----------

PAGE_NAMES = {f: n for n, f in PAGES}


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
    index = read("index.html")
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
        sections.append(f'  <div class="ib-page" data-page="{name}" data-title="{html.escape(title)}"{hidden}>'
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
    snap = open(os.path.join(catalog_dir, "catalog.gz"), "rb").read()
    blocks.append(data_block("ib-catalog", b64_block(snap)))
    report.append(f"  catalogue snapshot ({len(snap):,} bytes)")
    runtimes = open(os.path.join(catalog_dir, "runtimes.json")).read()
    blocks.append(data_block("ib-runtimes", no_close_script(runtimes), "application/json"))
    info = {"built": today, "rev": rev, "backend": backend}
    blocks.append(data_block("ib-offline", json.dumps(info), "application/json"))

    resedit = no_close_script(read(RESEDIT_BUNDLE))
    done = set()
    js = ("// The page exactly as loaded, for \"Save this page\". Must run before\n"
          "// anything changes the DOM.\n"
          "globalThis.IB_PRISTINE = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;\n"
          "globalThis.IB_HAS_LOCAL = true;\n"
          "globalThis.IB_ONE_FILE = true;\n\n"
          + join_modules(LIB_MODULES, done)
          + "\n__ib_local_api.installLocalApi();\n"
          + join_modules(PAGE_MODULES, done)
          + "\n__ib_router.startRouter();\n")

    css = read("css/style.css")
    out = ("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n"
           "  <meta charset=\"utf-8\">\n"
           "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
           "  <title>TiddlyInstall</title>\n"
           f"  <meta name=\"generator\" content=\"tools/build_site.py, {rev}, {today}\">\n"
           "  <style>\n" + css + "\n  </style>\n</head>\n<body>\n  " + header + "\n"
           + "\n".join(sections) +
           "\n  <footer class=\"site-footer\">\n    Designed by <a href=\"https://robertsdotpm.github.io/\">Matthew Roberts</a> and implemented by Claude.\n  </footer>\n"
           + "\n".join(blocks) +
           "\n  <script>\n" + resedit + "\n  </script>\n"
           "  <script type=\"module\">\n" + js + "\n  </script>\n</body>\n</html>\n")
    return out, report


def make_snapshot(tmp):
    print("making the catalogue snapshot (about a minute)…", flush=True)
    subprocess.run(["go", "run", "./cmd/ibsnapshot", "-o", tmp], cwd=os.path.join(ROOT, "server"), check=True)
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
