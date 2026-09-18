#!/usr/bin/env python3
"""Add Installer Builder metadata to a Unix base, for testing.

The Go server has its own implementation; this follows docs/format.md
section 4 so the two can be checked against each other.

  append_meta.py run BASE.run -o OUT.run --record R [--plan P] [--pack DIR]
      Appends [record][plan][pack][64-byte footer] to a copy of the .run.
      A block already on BASE is replaced.

  append_meta.py app BASE.zip -o OUT.zip [--record R] [--plan P] [--pack DIR]
                     [--rename NAME] [--strip-signature]
      Copies the zipped Install.app, writing record.txt, plan.txt and
      pack/<sha256> into <app>/Contents/Resources/ib/. --rename renames
      the .app inside the zip (mode A: install_node_hello_<hash>).
      --strip-signature drops _CodeSignature and AppleDouble entries,
      because adding files breaks the base's signature anyway (mode C).

  append_meta.py hash RECORD
      Prints the record's 26-character name (base32 of its SHA-256).

--pack DIR: every regular file in DIR is packed, named by the lowercase
hex SHA-256 of its content (format.md "Pack").
"""
import argparse
import base64
import hashlib
import io
import os
import re
import stat
import sys
import tarfile
import zipfile

FOOTER_LEN = 64


def record_hash(data: bytes) -> str:
    return base64.b32encode(hashlib.sha256(data).digest()).decode().lower().rstrip("=")[:26]


def pack_files(pack_dir):
    """[(sha256_hex, bytes)] for every regular file under pack_dir."""
    out = {}
    for root, _dirs, files in os.walk(pack_dir):
        for f in sorted(files):
            p = os.path.join(root, f)
            if os.path.isfile(p):
                data = open(p, "rb").read()
                out[hashlib.sha256(data).hexdigest()] = data
    return sorted(out.items())


def make_pack_tar(pack_dir) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for sha, data in pack_files(pack_dir):
            ti = tarfile.TarInfo(sha)
            ti.size = len(data)
            ti.mode = 0o644
            ti.mtime = 0
            ti.uname = ti.gname = ""
            t.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def footer(r, p, k) -> bytes:
    s = "IBMETA1 %012d %012d %012d " % (r, p, k)
    s = s.ljust(FOOTER_LEN - 1) + "\n"
    assert len(s) == FOOTER_LEN
    return s.encode("ascii")


def strip_block(data: bytes) -> bytes:
    if len(data) >= FOOTER_LEN and data[-FOOTER_LEN:].startswith(b"IBMETA1 "):
        parts = data[-FOOTER_LEN:].split()
        r, p, k = int(parts[1]), int(parts[2]), int(parts[3])
        return data[: len(data) - FOOTER_LEN - r - p - k]
    return data


def cmd_run(a):
    base = strip_block(open(a.base, "rb").read())
    # The script ends with `exit $?`; the verifier binaries make_run.sh puts
    # after it (IB_VERIFY_BLOBS) are part of the base.
    script = base
    m = re.search(rb"^IB_VERIFY_BLOBS='([^'\n]*)'$", base, re.M)
    if m and m.group(1):
        ents = [e.split(b":") for e in m.group(1).split()]
        start = min(int(e[1]) for e in ents)
        if max(int(e[1]) + int(e[2]) for e in ents) != len(base):
            sys.exit("base: the verifier table doesn't match the file; refusing to append")
        script = base[:start]
    if not script.endswith(b"\nexit $?\n"):
        sys.exit("base does not end with an 'exit $?' line; refusing to append")
    rec = open(a.record, "rb").read() if a.record else b""
    plan = open(a.plan, "rb").read() if a.plan else b""
    pack = make_pack_tar(a.pack) if a.pack else b""
    with open(a.output, "wb") as f:
        f.write(base + rec + plan + pack + footer(len(rec), len(plan), len(pack)))
    os.chmod(a.output, 0o755)
    print("%s: record %d, plan %d, pack %d bytes" % (a.output, len(rec), len(plan), len(pack)))
    if rec:
        print("record hash", record_hash(rec))


def zinfo(name, mode, date=(2026, 1, 1, 0, 0, 0)):
    zi = zipfile.ZipInfo(name, date_time=date)
    zi.create_system = 3  # Unix, so external_attr's high word is st_mode
    zi.external_attr = (mode & 0xFFFF) << 16
    if stat.S_ISDIR(mode):
        zi.external_attr |= 0x10
    zi.compress_type = zipfile.ZIP_DEFLATED
    return zi


def cmd_app(a):
    zin = zipfile.ZipFile(a.base)
    names = zin.namelist()
    tops = {n.split("/")[0] for n in names if not n.startswith("__MACOSX/")}
    apps = [t for t in tops if t.endswith(".app")]
    if len(apps) != 1:
        sys.exit("expected one .app at the top of the zip, found %r" % apps)
    old = apps[0][:-4]
    new = a.rename or old
    ib = "%s.app/Contents/Resources/ib/" % new
    added = {}
    if a.record:
        added[ib + "record.txt"] = open(a.record, "rb").read()
    if a.plan:
        added[ib + "plan.txt"] = open(a.plan, "rb").read()
    if a.pack:
        for sha, data in pack_files(a.pack):
            added[ib + "pack/" + sha] = data
    zout = zipfile.ZipFile(a.output, "w", zipfile.ZIP_DEFLATED)
    for zi in zin.infolist():
        n = zi.filename
        if a.strip_signature and ("/_CodeSignature/" in n or n.startswith("__MACOSX/")
                                  or os.path.basename(n.rstrip("/")).startswith("._")):
            continue
        for pre in (old + ".app/", "__MACOSX/" + old + ".app/", "__MACOSX/._" + old + ".app"):
            if n.startswith(pre):
                n = pre.replace(old + ".app", new + ".app") + n[len(pre):]
                break
        if n in added:
            continue
        nz = zipfile.ZipInfo(n, date_time=zi.date_time)
        nz.create_system = zi.create_system
        nz.external_attr = zi.external_attr
        nz.extra = zi.extra
        nz.compress_type = zi.compress_type
        zout.writestr(nz, zin.read(zi.filename))
    if a.pack and added:
        zout.writestr(zinfo(ib + "pack/", 0o40755), b"")
    for n, data in added.items():
        zout.writestr(zinfo(n, 0o100644), data)
    zout.close()
    print("%s: %s.app, %d file(s) added" % (a.output, new, len(added)))
    if a.record:
        print("record hash", record_hash(open(a.record, "rb").read()))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("run", "app"):
        p = sub.add_parser(name)
        p.add_argument("base")
        p.add_argument("-o", "--output", required=True)
        p.add_argument("--record")
        p.add_argument("--plan")
        p.add_argument("--pack")
        if name == "app":
            p.add_argument("--rename")
            p.add_argument("--strip-signature", action="store_true")
    p = sub.add_parser("hash")
    p.add_argument("record")
    a = ap.parse_args()
    if a.cmd == "run":
        if not a.record and not a.plan:
            sys.exit("need --record and/or --plan")
        cmd_run(a)
    elif a.cmd == "app":
        cmd_app(a)
    else:
        print(record_hash(open(a.record, "rb").read()))


if __name__ == "__main__":
    main()
