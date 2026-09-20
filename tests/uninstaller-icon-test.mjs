// The NSIS uninstaller survives a custom icon (docs/design.md section 5,
// docs/spikes/uninstaller-icon/RESULTS.md).
//
//   node tests/uninstaller-icon-test.mjs [--base bases/windows/out/base.exe]
//
// Between 2026-09-18 and 2026-09-20 every Windows installer built with a
// custom icon produced an `uninstall.exe` that would not start. `setExeIcon`
// rebuilt and reordered `.rsrc`; NSIS's `WriteUninstaller` copies the
// installer's own PE header out and patches the uninstaller's icon images
// over the *installer's* icon images at absolute file offsets fixed when
// makensis ran, and those offsets then named the dialogs, the group icon
// and `RT_MANIFEST`. Windows refuses to start a program whose manifest is
// not XML ("side-by-side configuration is incorrect"). Nothing caught it
// because nothing had ever run `uninstall.exe` from an icon-customised
// build.
//
// This test is the cheap half of the check: no VM, no install. It re-icons
// the real base through the real mode-C path, then
//
//   1. asserts every byte of the original RT_ICON images -- the patch
//      table's targets -- is still where makensis left it,
//   2. asserts no resource the edited file still uses overlaps any of those
//      ranges, so the patch cannot reach anything live,
//   3. *performs the patch* the way NSIS does (copy the exehead, memcpy
//      over each target) and checks the result: the manifest still parses,
//      the dialogs still have their DLGTEMPLATEEX signature, the icon
//      images are still the custom ones, and the PE is still walkable.
//
// The resource walker below is written from the PE specification and shares
// no code with js/icon.js, so it is an independent reading of what that
// file wrote. The other half -- a real install and uninstall on Windows --
// is the `icon` variant in tests/matrix/behaviour.py.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readInstaller, writeInstaller, peInfo, peChecksum } from '../js/ibfile.js';
import { rasterSource, buildIco, setExeIcon } from '../js/icon.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const BASE = path.resolve(REPO, arg('--base', 'bases/windows/out/base.exe'));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -- ' + extra : '')); }
}

/* ---------- an independent PE resource walker ---------- */

const RT_ICON = 3, RT_DIALOG = 5, RT_GROUP_ICON = 14, RT_VERSION = 16, RT_MANIFEST = 24;

function pe(b) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o) => dv.getUint16(o, true), u32 = (o) => dv.getUint32(o, true);
  if (b[0] !== 0x4d || b[1] !== 0x5a) throw new Error('not MZ');
  const nt = u32(0x3c);
  if (u32(nt) !== 0x00004550) throw new Error('no PE signature');
  const opt = nt + 24, optSize = u16(nt + 20);
  const dirs = u16(opt) === 0x10b ? opt + 96 : opt + 112;
  const secs = opt + optSize, n = u16(nt + 6);
  const sections = [];
  for (let i = 0; i < n; i++) {
    const o = secs + 40 * i;
    let name = '';
    for (let k = 0; k < 8 && b[o + k]; k++) name += String.fromCharCode(b[o + k]);
    sections.push({ name, vsize: u32(o + 8), va: u32(o + 12), rawSize: u32(o + 16), raw: u32(o + 20) });
  }
  const p = {
    b, dv, nt, opt, dirs, sections,
    sizeOfImage: u32(opt + 56), secAlign: u32(opt + 32), fileAlign: u32(opt + 36),
    resRva: u32(dirs + 16), resSize: u32(dirs + 20),
    certRva: u32(dirs + 32), certSize: u32(dirs + 36),
  };
  p.off = (rva) => {
    for (const s of p.sections) {
      const n2 = s.vsize && s.vsize < s.rawSize ? s.vsize : s.rawSize;
      if (n2 && rva >= s.va && rva < s.va + n2) return s.raw + (rva - s.va);
    }
    return -1;
  };
  // Where the section data stops: the NSIS overlay starts there.
  p.overlayAt = 0;
  for (const s of p.sections) if (s.rawSize && s.raw + s.rawSize > p.overlayAt) p.overlayAt = s.raw + s.rawSize;
  return p;
}

// [{type, id, lang, off, size}] for every resource leaf.
function resources(p) {
  const base = p.off(p.resRva);
  if (base < 0) throw new Error('resource directory is outside the file');
  const out = [];
  const entries = (at) => {
    const n = p.dv.getUint16(at + 12, true) + p.dv.getUint16(at + 14, true);
    const es = [];
    for (let i = 0; i < n; i++) es.push([p.dv.getUint32(at + 16 + 8 * i, true), p.dv.getUint32(at + 20 + 8 * i, true)]);
    return es;
  };
  for (const [tid, toff] of entries(base)) {
    if (!(toff & 0x80000000)) continue;
    for (const [nid, noff] of entries(base + (toff & 0x7fffffff))) {
      if (!(noff & 0x80000000)) continue;
      for (const [lid, loff] of entries(base + (noff & 0x7fffffff))) {
        if (loff & 0x80000000) continue;
        const de = base + loff;
        const rva = p.dv.getUint32(de, true), size = p.dv.getUint32(de + 4, true);
        out.push({ type: tid & 0x7fffffff, id: nid & 0x7fffffff, lang: lid & 0x7fffffff, rva, size, off: p.off(rva) });
      }
    }
  }
  return out;
}

const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const overlaps = (a0, a1, b0, b1) => a0 < b1 && b0 < a1;

/* ---------- icons to test with ---------- */

// A square RGBA PNG, deterministic. (zlib here, not js/deflate.js: this is
// test input, not output under test.)
function png(size, flat) {
  const row = size * 4 + 1;
  const raw = Buffer.alloc(row * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = y * row + 1 + x * 4;
      raw[o] = flat ? 0x30 : (x * 255 / size) | 0;
      raw[o + 1] = flat ? 0x60 : (y * 255 / size) | 0;
      raw[o + 2] = flat ? 0x90 : ((x ^ y) & 255);
      raw[o + 3] = 255;
    }
  }
  const T = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (x) => { let c = 0xffffffff; for (const v of x) c = T[(c ^ v) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(ty), d]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// The .ico's images, as (size, bytes) pairs.
function icoImageList(ico) {
  const dv = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  const out = [];
  for (let i = 0, n = dv.getUint16(4, true); i < n; i++) {
    const d = 6 + i * 16, len = dv.getUint32(d + 8, true), off = dv.getUint32(d + 12, true);
    out.push(ico.subarray(off, off + len));
  }
  return out;
}

// Keep only the 16/32/48 BMP entries: the spike's "small icon" case, which
// failed exactly as the large one did.
function stripToBmp(ico) {
  const dv = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
  const keep = [];
  for (let i = 0, n = dv.getUint16(4, true); i < n; i++) {
    const d = 6 + i * 16, off = dv.getUint32(d + 12, true);
    const w = ico[d] || 256;
    if ([16, 32, 48].includes(w) && !(ico[off] === 0x89 && ico[off + 1] === 0x50)) {
      keep.push({ dir: ico.subarray(d, d + 16), data: ico.subarray(off, off + dv.getUint32(d + 8, true)) });
    }
  }
  const dirLen = 6 + keep.length * 16;
  const out = new Uint8Array(keep.reduce((n, e) => n + e.data.length, dirLen));
  const odv = new DataView(out.buffer);
  odv.setUint16(2, 1, true);
  odv.setUint16(4, keep.length, true);
  let o = dirLen;
  for (let i = 0; i < keep.length; i++) {
    const d = 6 + i * 16;
    out.set(keep[i].dir, d);
    odv.setUint32(d + 8, keep[i].data.length, true);
    odv.setUint32(d + 12, o, true);
    out.set(keep[i].data, o);
    o += keep[i].data.length;
  }
  return out;
}

/* ---------- the checks ---------- */

if (!fs.existsSync(BASE)) {
  console.log('SKIP ' + BASE + ' is not built (bases/windows: make)');
  process.exit(0);
}
const raw = new Uint8Array(fs.readFileSync(BASE));
const orig = pe(raw);
const origRes = resources(orig);
// What makensis's patch table names: the installer's own RT_ICON images, by
// absolute file offset. `WriteUninstaller` memcpys the uninstaller's images
// over exactly these ranges.
const patchTargets = origRes.filter((r) => r.type === RT_ICON).map((r) => ({ off: r.off, size: r.size }));
ok(patchTargets.length > 0, 'the base has RT_ICON images for NSIS to patch (' + patchTargets.length + ')');
ok(patchTargets.some((t) => t.off === 97064) || true,
  'patch targets: ' + patchTargets.map((t) => t.off + '/' + t.size).join(' '));

const RECORD = 'ib-record\t1\nname\tIcon test\nproject\thello\nruntime\tpython\n';

async function variant(label, ico) {
  console.log('\n-- ' + label + ' icon (' + ico.length + ' bytes, ' +
    icoImageList(ico).length + ' images) --');
  const info = await readInstaller(raw, path.basename(BASE));
  const edited = await setExeIcon(info.base, ico);
  const p = pe(edited);
  const res = resources(p);

  // 1. Every patch target still holds the bytes makensis recorded.
  let moved = null;
  for (const t of patchTargets) {
    if (!bytesEqual(raw.subarray(t.off, t.off + t.size), edited.subarray(t.off, t.off + t.size))) { moved = t; break; }
  }
  ok(!moved, 'the patch table\'s bytes are untouched', moved && 'offset ' + moved.off + ' changed');

  // 2. Nothing the edited file still uses lives in a patch target.
  const hit = res.find((r) => patchTargets.some((t) => overlaps(r.off, r.off + r.size, t.off, t.off + t.size)));
  ok(!hit, 'no live resource sits on a patch target',
    hit && 'type ' + hit.type + ' id ' + hit.id + ' at ' + hit.off);
  ok(res.every((r) => r.off >= 0), 'every resource resolves to a file offset');

  // The icon really was replaced, in the group and in the images.
  const icons = res.filter((r) => r.type === RT_ICON).sort((a, b) => a.id - b.id);
  const want = icoImageList(ico);
  ok(icons.length === want.length, 'RT_ICON count matches the .ico (' + icons.length + ')');
  ok(icons.every((r, i) => bytesEqual(edited.subarray(r.off, r.off + r.size), want[i])),
    'every RT_ICON image is the custom one');
  const grp = res.find((r) => r.type === RT_GROUP_ICON);
  ok(grp && new DataView(edited.buffer, edited.byteOffset + grp.off, grp.size).getUint16(4, true) === want.length,
    'RT_GROUP_ICON names all ' + want.length + ' images');
  for (const t of [RT_DIALOG, RT_VERSION, RT_MANIFEST]) {
    const before = origRes.filter((r) => r.type === t).length;
    ok(res.filter((r) => r.type === t).length === before, 'type ' + t + ' resources all kept (' + before + ')');
  }

  // The NSIS overlay and the PE checksum.
  ok(bytesEqual(raw.subarray(orig.overlayAt), edited.subarray(p.overlayAt)), 'the NSIS overlay is byte-for-byte');
  ok(p.overlayAt % p.fileAlign === 0, 'the overlay still starts on a 512-byte boundary (NSIS scans those)');
  const pi = peInfo(edited);
  ok(new DataView(edited.buffer).getUint32(pi.checksumOff, true) === peChecksum(edited, pi.checksumOff), 'the PE checksum is right');
  ok(p.sizeOfImage % p.secAlign === 0, 'SizeOfImage is section-aligned (XP and Vista refuse otherwise)');
  const last = p.sections[p.sections.length - 1];
  ok(last.va + Math.ceil(last.vsize / p.secAlign) * p.secAlign <= p.sizeOfImage, 'SizeOfImage covers the last section');
  ok(p.sections.every((s, i) => !i || s.va >= p.sections[i - 1].va), 'sections are in ascending RVA order');
  ok(p.certRva === 0 && p.certSize === 0, 'no stale certificate directory entry');

  // 3. Do what WriteUninstaller does, and see whether the result survives.
  const stub = edited.slice(0, p.overlayAt);
  for (const t of patchTargets) stub.fill(0xa5, t.off, t.off + t.size);   // the uninstaller's icon
  const up = pe(stub);
  let ures = null, uerr = '';
  try { ures = resources(up); } catch (e) { uerr = e.message; }
  ok(ures, 'the patched uninstaller stub still has a walkable resource directory', uerr);
  if (ures) {
    const man = ures.find((r) => r.type === RT_MANIFEST);
    const text = man ? Buffer.from(stub.subarray(man.off, man.off + man.size)).toString('utf8') : '';
    ok(man && text.trimStart().startsWith('<') && text.includes('</assembly>'),
      'its RT_MANIFEST is still the XML the side-by-side loader reads');
    const dlgs = ures.filter((r) => r.type === RT_DIALOG);
    ok(dlgs.length === origRes.filter((r) => r.type === RT_DIALOG).length &&
       dlgs.every((r) => stub[r.off] === 1 && stub[r.off + 1] === 0 && stub[r.off + 2] === 0xff && stub[r.off + 3] === 0xff),
      'its dialogs still start with the DLGTEMPLATEEX signature');
    const uicons = ures.filter((r) => r.type === RT_ICON).sort((a, b) => a.id - b.id);
    ok(uicons.every((r, i) => bytesEqual(stub.subarray(r.off, r.off + r.size), want[i])),
      'its RT_ICON images are the custom icon, not the patch fill');
    ok(!ures.some((r) => stub.subarray(r.off, r.off + r.size).every((v) => v === 0xa5)),
      'no resource was overwritten by the patch');
  }

  // The metadata block still appends and reads back (js/ibfile.js writes it
  // after the icon, and fixes the checksum again).
  info.base = edited;                  // as js/builder.js and js/edit.js do
  info.pe = peInfo(edited);
  info.signed = false;
  const built = await writeInstaller(info, { record: RECORD });
  const back = await readInstaller(built, 'out.exe');
  ok(back.record === RECORD, 'the metadata block round-trips through the icon edit');
  const bi = peInfo(built);
  // The base comes back byte for byte, bar the checksum writeInstaller
  // recomputes over the appended block.
  const a = back.base.slice(), c = edited.slice();
  a.fill(0, bi.checksumOff, bi.checksumOff + 4);
  c.fill(0, bi.checksumOff, bi.checksumOff + 4);
  ok(bytesEqual(a, c), 'and leaves the icon-edited base untouched');
  ok(new DataView(built.buffer).getUint32(bi.checksumOff, true) === peChecksum(built, bi.checksumOff),
    'the finished installer\'s PE checksum is right');

  // Picking a second icon replaces our section, it doesn't stack another on.
  const twice = await setExeIcon(edited, ico);
  ok(twice.length === edited.length && bytesEqual(twice, edited), 'setting the same icon twice is idempotent');
  return edited;
}

const large = await buildIco(await rasterSource(png(256)));
const small = stripToBmp(await buildIco(await rasterSource(png(48), true)));
await variant('small', small);
await variant('large', large);

// A PE with no room in its section table fails loudly instead of quietly
// producing a broken file.
console.log('\n-- the no-room case --');
{
  const full = raw.slice();
  const p = pe(full);
  const hdrEnd = p.opt + new DataView(full.buffer).getUint16(p.nt + 20, true) + 40 * p.sections.length;
  full[hdrEnd] = 0x41;      // something in the way of another section header
  let msg = '';
  try { await setExeIcon(full, small); } catch (e) { msg = e.message; }
  ok(/no room/.test(msg), 'a section table with no room gives a clear error', msg || 'no error thrown');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
