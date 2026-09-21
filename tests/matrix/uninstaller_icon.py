"""The icon half of behaviour.py's `icon` variant: an icon to upload, and a
check of the `uninstall.exe` a real install left behind.

Why it exists: NSIS's WriteUninstaller copies the installer's own PE header
out to uninstall.exe and patches the uninstaller's icon images over the
installer's, at absolute file offsets makensis fixed at build time. From
2026-09-18 to 2026-09-20 src/shared/icon.js rebuilt and reordered `.rsrc`, so the
patch landed on the dialogs, the group icon and RT_MANIFEST instead, and
Windows refused to start uninstall.exe at all ("side-by-side configuration
is incorrect"): every installer with a custom icon installed an app that
could not be removed (docs/spikes/uninstaller-icon/RESULTS.md).

`uninstall.exe` is now the installer's exehead with the patch landing on the
original, unreferenced icon images, so every resource in it must still be
byte for byte what the installer has. That is what check() reads off the
file the VM sent back. No resource bytes are printed, only sizes and ids.
"""
import struct
import zlib


def icon_png(size=256):
    """A deterministic square RGBA PNG to upload as the app's icon."""
    raw = bytearray()
    for y in range(size):
        raw.append(0)                       # filter: none
        for x in range(size):
            raw += bytes((x * 255 // size, y * 255 // size, (x ^ y) & 255, 255))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


# A PE resource walker, from the specification: {(type, id, lang): bytes}.
def _resources(data):
    if data[:2] != b"MZ":
        raise ValueError("not a PE file")
    u16 = lambda o: struct.unpack_from("<H", data, o)[0]
    u32 = lambda o: struct.unpack_from("<I", data, o)[0]
    nt = u32(0x3C)
    if u32(nt) != 0x00004550:
        raise ValueError("no PE signature")
    opt = nt + 24
    dirs = opt + (96 if u16(opt) == 0x10B else 112)
    secs, nsec = opt + u16(nt + 20), u16(nt + 6)
    sections = []
    for i in range(nsec):
        o = secs + 40 * i
        sections.append((u32(o + 12), u32(o + 8), u32(o + 20), u32(o + 16)))  # va, vsize, raw, rawsize

    def off(rva):
        for va, vsize, raw, rawsize in sections:
            n = vsize if vsize and vsize < rawsize else rawsize
            if n and va <= rva < va + n:
                return raw + (rva - va)
        return -1

    base = off(u32(dirs + 16))
    if base < 0:
        raise ValueError("the resource directory is outside the file")

    def entries(at):
        n = u16(at + 12) + u16(at + 14)
        return [(u32(at + 16 + 8 * i), u32(at + 20 + 8 * i)) for i in range(n)]

    out = {}
    for tid, toff in entries(base):
        if not toff & 0x80000000:
            continue
        for nid, noff in entries(base + (toff & 0x7FFFFFFF)):
            if not noff & 0x80000000:
                continue
            for lid, loff in entries(base + (noff & 0x7FFFFFFF)):
                if loff & 0x80000000:
                    continue
                de = base + loff
                o, size = off(u32(de)), u32(de + 4)
                if o < 0 or o + size > len(data):
                    raise ValueError("a resource points outside the file")
                out[(tid & 0x7FFFFFFF, nid & 0x7FFFFFFF, lid & 0x7FFFFFFF)] = data[o:o + size]
    return out


RT_ICON, RT_DIALOG, RT_GROUP_ICON, RT_MANIFEST = 3, 5, 14, 24


def check(uninstaller, installer):
    """Problems with the uninstaller a real install wrote, against the
    installer it came from. Empty means it is intact."""
    bad = []
    try:
        un = _resources(uninstaller)
    except ValueError as e:
        return ["uninstall.exe's resources are unreadable: %s" % e]
    try:
        inst = _resources(installer)
    except ValueError as e:
        return ["the installer's resources are unreadable: %s" % e]

    man = [v for (t, _, _), v in un.items() if t == RT_MANIFEST]
    if not man:
        bad.append("uninstall.exe has no RT_MANIFEST")
    elif not (man[0].lstrip().startswith(b"<") and b"</assembly>" in man[0]):
        bad.append("uninstall.exe's RT_MANIFEST is not XML any more (%d bytes) -- "
                   "Windows will not start it" % len(man[0]))

    for t, what in ((RT_DIALOG, "dialog"), (RT_GROUP_ICON, "icon group"), (RT_MANIFEST, "manifest")):
        for key, want in sorted((k, v) for k, v in inst.items() if k[0] == t):
            got = un.get(key)
            if got is None:
                bad.append("uninstall.exe lost %s %s" % (what, key[1]))
            elif got != want:
                bad.append("uninstall.exe's %s %s was overwritten (%d bytes)" % (what, key[1], len(want)))

    icons = sorted((k, v) for k, v in inst.items() if k[0] == RT_ICON)
    if not icons:
        bad.append("the installer has no RT_ICON to compare")
    for key, want in icons:
        got = un.get(key)
        if got is None:
            bad.append("uninstall.exe lost icon image %s" % (key[1],))
        elif got != want:
            bad.append("uninstall.exe's icon image %s is not the custom one (%d bytes)" % (key[1], len(want)))
    return bad
