#!/usr/bin/env python3
"""Write tests/fixtures.js: small files made by Python's own tarfile and
zipfile (and pefile for the PE checksum, if installed), so the browser code
in shared/ibfile.js is checked against independent implementations.

    python3 tests/make_fixtures.py
"""
import base64
import hashlib
import io
import json
import os
import stat
import struct
import tarfile
import time
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def b64(b):
    return base64.b64encode(b).decode()


def make_pe(checksum_nonzero=True):
    """A minimal PE32 header plus some bytes. Not runnable; enough to parse."""
    buf = bytearray(1536)
    buf[0:2] = b"MZ"
    struct.pack_into("<I", buf, 0x3C, 0x40)
    buf[0x40:0x44] = b"PE\0\0"
    coff = 0x44
    struct.pack_into("<HHIIIHH", buf, coff, 0x14C, 0, 0, 0, 0, 224, 0x0102)
    opt = coff + 20
    struct.pack_into("<H", buf, opt, 0x10B)
    struct.pack_into("<I", buf, opt + 92, 16)   # NumberOfRvaAndSizes
    for i in range(512, len(buf)):
        buf[i] = (i * 7 + 3) & 0xFF
    if checksum_nonzero:
        struct.pack_into("<I", buf, opt + 64, 1)
    return bytes(buf), opt + 64


def _icon_image(size=16):
    """One 32bpp bottom-up DIB icon image (BITMAPINFOHEADER + BGRA + AND mask)."""
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    xor = bytes([0x10, 0x80, 0xF0, 0xFF]) * (size * size)  # BGRA
    andmask = b"\0" * ((((size + 31) >> 5) << 2) * size)
    return header + xor + andmask


def make_pe_with_icon(overlay=b"NSIS-FAKE-OVERLAY-DATA-" * 4):
    """A synthetic PE32 with a .rsrc holding one RT_GROUP_ICON (id 1) and its
    RT_ICON (id 1), plus a trailing overlay standing in for NSIS's data. Enough
    for resedit-js to parse and for shared/icon.js setExeIcon to edit. Returns
    (bytes, group_id, overlay_len)."""
    RVA = 0x1000
    icon = _icon_image(16)
    ilen = len(icon)
    grp = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHIH", 16, 16, 0, 0, 1, 32, ilen, 1)

    rs = bytearray()

    def resdir(nid):
        return struct.pack("<IIHHHH", 0, 0, 0, 0, 0, nid)

    def diren(idv, off, sub):
        return struct.pack("<II", idv, (0x80000000 | off) if sub else off)

    # Offsets within the section, matching the layout below.
    rs += resdir(2) + diren(3, 32, True) + diren(14, 56, True)      # root  0..32
    rs += resdir(1) + diren(1, 80, True)                            # type 3   32..56
    rs += resdir(1) + diren(1, 104, True)                           # type 14  56..80
    rs += resdir(1) + diren(1033, 128, False)                       # icon lang 80..104
    rs += resdir(1) + diren(1033, 144, False)                       # group lang 104..128
    rs += struct.pack("<IIII", RVA + 160, ilen, 0, 0)               # icon data entry 128..144
    rs += struct.pack("<IIII", RVA + 160 + ilen, len(grp), 0, 0)    # group data entry 144..160
    assert len(rs) == 160, len(rs)
    rs += icon + grp
    rsrc = bytes(rs)

    file_align, sect_align = 0x200, 0x1000
    e_lfanew = 0x80
    headers_end = e_lfanew + 4 + 20 + 224 + 40
    size_of_headers = (headers_end + file_align - 1) // file_align * file_align
    raw_size = (len(rsrc) + file_align - 1) // file_align * file_align

    buf = bytearray(size_of_headers + raw_size)
    buf[0:2] = b"MZ"
    struct.pack_into("<I", buf, 0x3C, e_lfanew)
    buf[e_lfanew:e_lfanew + 4] = b"PE\0\0"
    coff = e_lfanew + 4
    struct.pack_into("<HHIIIHH", buf, coff, 0x14C, 1, 0, 0, 0, 224, 0x0102)
    opt = coff + 20
    struct.pack_into("<H", buf, opt, 0x10B)                       # PE32
    struct.pack_into("<I", buf, opt + 28, 0x400000)              # ImageBase
    struct.pack_into("<I", buf, opt + 32, sect_align)            # SectionAlignment
    struct.pack_into("<I", buf, opt + 36, file_align)            # FileAlignment
    struct.pack_into("<I", buf, opt + 56, RVA + raw_size)        # SizeOfImage (aligned)
    struct.pack_into("<I", buf, opt + 60, size_of_headers)       # SizeOfHeaders
    struct.pack_into("<I", buf, opt + 92, 16)                    # NumberOfRvaAndSizes
    dd = opt + 96
    struct.pack_into("<II", buf, dd + 2 * 8, RVA, len(rsrc))     # resource directory
    # Section header
    sh = opt + 224
    buf[sh:sh + 8] = b".rsrc\0\0\0"
    struct.pack_into("<IIII", buf, sh + 8, len(rsrc), RVA, raw_size, size_of_headers)
    struct.pack_into("<I", buf, sh + 36, 0x40000040)             # INITIALIZED_DATA|READ
    buf[size_of_headers:size_of_headers + len(rsrc)] = rsrc
    return bytes(buf) + overlay, 1, len(overlay)


def pe_checksum(data, off):
    try:
        import pefile  # noqa: F401
        pe = pefile.PE(data=data, fast_load=True)
        return pe.generate_checksum(), "pefile"
    except Exception:
        pass
    s = 0
    n = len(data)
    padded = data + (b"\0" if n % 2 else b"")
    for i in range(0, len(padded), 2):
        if i in (off, off + 2):
            continue
        s += padded[i] | (padded[i + 1] << 8)
        s = (s & 0xFFFF) + (s >> 16)
    s = (s & 0xFFFF) + (s >> 16)
    return (s + n) & 0xFFFFFFFF, "own"


def make_tar():
    bio = io.BytesIO()
    with tarfile.open(fileobj=bio, mode="w", format=tarfile.USTAR_FORMAT) as t:
        for data in (b"hello pack\n", bytes(range(256)) * 3):
            ti = tarfile.TarInfo(hashlib.sha256(data).hexdigest())
            ti.size = len(data)
            ti.mtime = 1758196800
            t.addfile(ti, io.BytesIO(data))
    return bio.getvalue()


def make_zip():
    bio = io.BytesIO()
    date = time.localtime(1758196800)[:6]
    with zipfile.ZipFile(bio, "w") as z:
        def add(name, data, mode, compress=zipfile.ZIP_DEFLATED):
            zi = zipfile.ZipInfo(name, date)
            zi.create_system = 3
            zi.external_attr = (mode << 16) | (0x10 if name.endswith("/") else 0)
            zi.compress_type = compress
            z.writestr(zi, data)
        add("Install.app/", b"", stat.S_IFDIR | 0o755, zipfile.ZIP_STORED)
        add("Install.app/Contents/", b"", stat.S_IFDIR | 0o755, zipfile.ZIP_STORED)
        add("Install.app/Contents/Info.plist", b"<plist>" + b"x" * 400 + b"</plist>\n", stat.S_IFREG | 0o644)
        add("Install.app/Contents/MacOS/", b"", stat.S_IFDIR | 0o755, zipfile.ZIP_STORED)
        add("Install.app/Contents/MacOS/install", b"#!/bin/sh\necho hi\n", stat.S_IFREG | 0o755, zipfile.ZIP_STORED)
        add("Install.app/Contents/Resources/current", b"../MacOS/install", stat.S_IFLNK | 0o755, zipfile.ZIP_STORED)
    return bio.getvalue()


def main():
    pe, off = make_pe()
    csum, how = pe_checksum(pe, off)
    pe_icon, grp_id, ov_len = make_pe_with_icon()
    rec = "ib-record\t1\nname\tHello\n"
    fx = {
        "pe": b64(pe),
        "peChecksumOff": off,
        "peChecksum": csum,
        "peChecksumFrom": how,
        "peIcon": b64(pe_icon),
        "peIconGroupId": grp_id,
        "peIconOverlayLen": ov_len,
        "tar": b64(make_tar()),
        "tarNames": [hashlib.sha256(d).hexdigest() for d in (b"hello pack\n", bytes(range(256)) * 3)],
        "zip": b64(make_zip()),
        "recordText": rec,
        "recordHash": base64.b32encode(hashlib.sha256(rec.encode()).digest()).decode().lower()[:26],
        "emptyB32": base64.b32encode(hashlib.sha256(b"").digest()).decode().lower().rstrip("="),
    }
    out = os.path.join(HERE, "fixtures.js")
    with open(out, "w") as f:
        f.write("// Generated by tests/make_fixtures.py. Do not edit.\n")
        f.write("export const FX = " + json.dumps(fx, indent=1) + ";\n")
    print("wrote", out, "(PE checksum from", how + ")")


if __name__ == "__main__":
    main()
