#!/usr/bin/env python3
"""Build editor-standalone.html: the browser editor (edit.html) as one
self-contained page, TiddlyWiki-style (plan.md section 1.10).

- css/style.css is inlined as <style>.
- The js/ modules edit.js needs are joined into one inline module, each in
  its own scope (a function returning its exports; imports become reads
  from those), so it runs from file:// with no network.
- The three unsigned bases are embedded as base64 in
  <script type="application/octet-stream" id="base-windows|base-linux|base-macos">
  from bases/windows/out/base.exe, bases/unix/out/ib.run (or ib-base.run)
  and bases/unix/out/ib-base-macos.zip. A missing base is replaced by a small
  placeholder (marked data-placeholder="1"; the page says so when used).

    python3 tools/make_standalone.py [-o editor-standalone.html]
"""
import argparse
import base64
import datetime
import io
import os
import re
import stat
import struct
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# Dependency order: each module comes after everything it imports.
MODULES = ["js/api.js", "js/ibfile.js", "js/icon.js", "js/der.js", "js/x509.js", "js/legacy.js",
           "js/pkcs12.js", "js/authenticode.js", "js/pgp.js", "js/sign-ui.js", "js/edit.js"]
# The resedit-js/pe-library bundle (icon editing) is a classic script, inlined
# so the page works from file:// with no network. See tools/build_resedit_bundle.py.
RESEDIT_BUNDLE = "vendor/resedit-bundle.js"
RESEDIT_TAG = '<script src="vendor/resedit-bundle.js"></script>'
# First existing path wins.
BASES = [
    ("windows", ["bases/windows/out/base.exe"]),
    ("linux", ["bases/unix/out/ib.run", "bases/unix/out/ib-base.run"]),
    ("macos", ["bases/unix/out/ib-base-macos.zip", "bases/unix/out/Install.zip"]),
]


def read(rel, mode="r"):
    with open(os.path.join(ROOT, rel), mode) as f:
        return f.read()


# ---------- placeholders for bases that aren't built yet ----------

def placeholder_windows():
    """A PE header that parses (not runnable), then a note."""
    buf = bytearray(1024)
    buf[0:2] = b"MZ"
    struct.pack_into("<I", buf, 0x3C, 0x40)
    buf[0x40:0x44] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", buf, 0x44, 0x14C, 0, 0, 0, 0, 224, 0x0102)
    opt = 0x44 + 20
    struct.pack_into("<H", buf, opt, 0x10B)
    struct.pack_into("<I", buf, opt + 92, 16)
    note = b"installer-builder placeholder base: the real base.exe was not built when this page was made.\n"
    buf[512:512 + len(note)] = note
    return bytes(buf)


def placeholder_linux():
    return (b"#!/bin/sh\n"
            b"echo 'installer-builder placeholder base: the real ib.run was not built "
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


# ---------- JS ----------

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


def join_modules():
    out, done = [], set()
    for rel in MODULES:
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
    js = "\n".join(out)
    # Must not end the <script> early.
    js = re.sub(r"</(script)", r"<\\/\1", js, flags=re.I)
    return js


def b64_block(data):
    s = base64.b64encode(data).decode()
    return "\n".join(s[i:i + 100] for i in range(0, len(s), 100))


def git_rev():
    try:
        return subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("-o", "--out", default=os.path.join(ROOT, "editor-standalone.html"))
    args = ap.parse_args()

    page = read("edit.html")
    css = read("css/style.css")

    link = '<link rel="stylesheet" href="css/style.css">'
    assert link in page, "edit.html no longer links css/style.css the expected way"
    page = page.replace(link, "<style>\n" + css + "\n</style>")

    # No other pages to link to from a saved file.
    page = re.sub(r"\s*<nav>.*?</nav>", "", page, count=1, flags=re.S)
    page = page.replace('<a class="brand" href="index.html">Installer Builder</a>',
                        '<span class="brand">Installer Builder</span>')
    page = page.replace("<title>Edit installer · Installer Builder</title>",
                        "<title>Installer editor · Installer Builder</title>\n"
                        f'  <meta name="generator" content="tools/make_standalone.py, {git_rev()}, '
                        f'{datetime.date.today().isoformat()}">')

    blocks = []
    report = []
    for os_name, rels in BASES:
        rel = next((r for r in rels if os.path.isfile(os.path.join(ROOT, r))), None)
        if rel:
            data = read(rel, "rb")
            attr = ""
            report.append(f"  {os_name:8} {rel} ({len(data):,} bytes)")
        else:
            data = PLACEHOLDERS[os_name]()
            attr = ' data-placeholder="1"'
            report.append(f"  {os_name:8} PLACEHOLDER ({' or '.join(rels)} not found)")
        blocks.append(f'  <script type="application/octet-stream" id="base-{os_name}"{attr}>\n'
                      f"{b64_block(data)}\n  </script>")

    # Inline the resedit-js/pe-library bundle (icon editing) as a classic script,
    # so IB_PRISTINE (captured next) already contains it and "Save this page"
    # keeps it. It runs before the main module and sets globalThis.__IB_RESEDIT.
    assert RESEDIT_TAG in page, "edit.html no longer loads the resedit bundle the expected way"
    resedit = read(RESEDIT_BUNDLE)
    resedit = re.sub(r"</(script)", r"<\\/\1", resedit, flags=re.I)
    page = page.replace(RESEDIT_TAG, "<script>\n" + resedit + "\n  </script>")

    js = ("// The page exactly as loaded, for \"Save this page\". Must run before\n"
          "// anything changes the DOM.\n"
          "const IB_PRISTINE = '<!DOCTYPE html>\\n' + document.documentElement.outerHTML;\n\n"
          + join_modules())

    tag = '<script type="module" src="js/edit.js"></script>'
    assert tag in page, "edit.html no longer loads js/edit.js the expected way"
    page = page.replace(tag, "\n".join(blocks) + '\n  <script type="module">\n' + js + "\n  </script>")

    with open(args.out, "w") as f:
        f.write(page)
    print(f"wrote {args.out} ({len(page.encode()):,} bytes)")
    print("\n".join(report))


if __name__ == "__main__":
    main()
