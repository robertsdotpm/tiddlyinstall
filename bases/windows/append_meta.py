#!/usr/bin/env python3
"""Append a metadata block (docs/format.md section 4) to a base installer.

    [base][record][plan][pack][footer: 64 bytes]

For testing the Windows base; the Go server has its own implementation.

    append_meta.py base.exe out.exe --record record.txt [--plan plan.txt]
                   [--pack FILE ...] [--pack-dir DIR]

Packed files are stored in a ustar tar under the lowercase hex SHA-256 of
their content, whatever their names on disk. Also:

    append_meta.py --hash record.txt     print the record's 26-char hash
    append_meta.py --folder APPID NAME   print a file's 12-char folder name
    append_meta.py --show out.exe        print the footer an exe carries
"""
import argparse
import base64
import hashlib
import io
import os
import struct
import sys
import tarfile


def b32(data: bytes, n: int) -> str:
    """First n characters of lowercase, unpadded base32 of SHA-256(data)."""
    return base64.b32encode(hashlib.sha256(data).digest()).decode().lower()[:n]


def make_pack(paths):
    buf = io.BytesIO()
    seen = set()
    with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for p in paths:
            data = open(p, "rb").read()
            name = hashlib.sha256(data).hexdigest()
            if name in seen:
                continue
            seen.add(name)
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def footer(rlen, plen, klen):
    f = "IBMETA1 %012d %012d %012d " % (rlen, plen, klen)
    f = f.ljust(63) + "\n"
    assert len(f) == 64
    return f.encode("ascii")


def block_end(data: bytes) -> int:
    """Where the block ends: the certificate table if signed, else EOF,
    then back over up to 7 NUL bytes of signing padding."""
    end = len(data)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    dd = opt + (112 if magic == 0x20B else 96)
    off, size = struct.unpack_from("<II", data, dd + 4 * 8)
    if off and size and off < end:
        end = off
    for _ in range(7):
        if end > 0 and data[end - 1] == 0:
            end -= 1
    return end


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("base", nargs="?")
    ap.add_argument("out", nargs="?")
    ap.add_argument("--record")
    ap.add_argument("--plan")
    ap.add_argument("--pack", nargs="*", default=[])
    ap.add_argument("--pack-dir")
    ap.add_argument("--hash")
    ap.add_argument("--folder", nargs=2, metavar=("APPID", "NAME"))
    ap.add_argument("--show")
    a = ap.parse_args()

    if a.hash:
        print(b32(open(a.hash, "rb").read(), 26))
        return
    if a.folder:
        print(b32((a.folder[0] + a.folder[1]).encode("utf-8"), 12))
        return
    if a.show:
        data = open(a.show, "rb").read()
        end = block_end(data)
        print(repr(data[end - 64:end]))
        return
    if not (a.base and a.out and a.record):
        ap.error("base, out and --record are required")

    base = open(a.base, "rb").read()
    record = open(a.record, "rb").read()
    plan = open(a.plan, "rb").read() if a.plan else b""
    files = list(a.pack)
    if a.pack_dir:
        files += [os.path.join(a.pack_dir, f) for f in sorted(os.listdir(a.pack_dir))
                  if os.path.isfile(os.path.join(a.pack_dir, f))]
    pack = make_pack(files) if files else b""
    with open(a.out, "wb") as f:
        f.write(base + record + plan + pack + footer(len(record), len(plan), len(pack)))
    print("%s: record %d, plan %d, pack %d (%d files), record hash %s"
          % (a.out, len(record), len(plan), len(pack), len(files), b32(record, 26)))


if __name__ == "__main__":
    sys.exit(main())
