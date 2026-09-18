// Unit tests for js/icon.js. Open tests/icon.html over http, or headless:
//   google-chrome --headless=new --virtual-time-budget=30000 --dump-dom \
//     http://127.0.0.1:8097/tests/icon.html
//
// The tests avoid createImageBitmap and the canvas PNG encoder (both flaky
// under Chrome's virtual time): a synthetic source produces rasters directly,
// and js/icon.js encodes PNG itself. resedit-js is loaded from the vendored
// bundle (vendor/resedit-bundle.js) the page includes, so no network is used.
import * as ib from '../js/ibfile.js';
import * as icon from '../js/icon.js';
import { FX } from './fixtures.js';

const out = document.getElementById('out');
let passed = 0, failed = 0;
function log(line) { out.textContent += line + '\n'; }
function ok(cond, name, extra) {
  if (cond) { passed++; log('PASS ' + name); }
  else { failed++; log('FAIL ' + name + (extra !== undefined ? ' -- ' + extra : '')); }
}
function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function run(name, fn) {
  try { await fn(); } catch (e) { failed++; log('FAIL ' + name + ' threw: ' + (e && e.stack || e)); }
}

// A deterministic square source: a gradient, no createImageBitmap.
function synthSource() {
  return {
    raster(size) {
      const d = new Uint8ClampedArray(size * size * 4);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        d[i] = (x * 255 / size) | 0; d[i + 1] = (y * 255 / size) | 0; d[i + 2] = 128; d[i + 3] = 255;
      }
      return { width: size, height: size, data: d };
    },
    close() {},
  };
}

await run('pngEncode', async () => {
  const png = await icon.pngEncode(synthSource().raster(8));
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  ok(sig.every((b, i) => png[i] === b), 'PNG signature');
  const dv = new DataView(png.buffer);
  ok(dv.getUint32(8, false) === 13 && png[12] === 0x49 && png[13] === 0x48, 'first chunk is IHDR');
  ok(dv.getUint32(16, false) === 8 && dv.getUint32(20, false) === 8, 'IHDR has the size');
  ok(png[24] === 8 && png[25] === 6, '8-bit RGBA');
  const tail = png.subarray(png.length - 8);   // [type 'IEND'][crc]
  ok(tail[0] === 0x49 && tail[1] === 0x45 && tail[2] === 0x4e && tail[3] === 0x44, 'ends with IEND');
});

await run('buildIco', async () => {
  const ico = await icon.buildIco(synthSource());
  const dv = new DataView(ico.buffer);
  ok(dv.getUint16(0, true) === 0 && dv.getUint16(2, true) === 1, 'ICONDIR reserved 0, type 1');
  const n = dv.getUint16(4, true);
  ok(n === 7, 'seven entries (16/24/32/48/64/128/256)', n);
  const sizes = [], kinds = [];
  for (let i = 0; i < n; i++) {
    const d = 6 + i * 16;
    const w = ico[d] === 0 ? 256 : ico[d];
    sizes.push(w);
    ok(dv.getUint16(d + 6, true) === 32, 'entry ' + w + ' is 32bpp');
    const off = dv.getUint32(d + 12, true), len = dv.getUint32(d + 8, true);
    ok(off + len <= ico.length, 'entry ' + w + ' fits in the file');
    // BMP entries start with a 40-byte BITMAPINFOHEADER; PNG entries with 0x89 'P'.
    if (ico[off] === 0x89 && ico[off + 1] === 0x50) kinds.push('png');
    else { ok(new DataView(ico.buffer, off, 4).getUint32(0, true) === 40, 'BMP entry ' + w + ' has a 40-byte header'); kinds.push('bmp'); }
  }
  ok(sizes.join(',') === '16,24,32,48,64,128,256', 'sizes in order', sizes.join(','));
  ok(kinds.slice(0, 4).every((k) => k === 'bmp') && kinds.slice(4).every((k) => k === 'png'), 'small BMP, large PNG', kinds.join(','));
});

await run('buildIcns', async () => {
  const icns = await icon.buildIcns(synthSource());
  const dv = new DataView(icns.buffer);
  ok(icns[0] === 0x69 && icns[1] === 0x63 && icns[2] === 0x6e && icns[3] === 0x73, "'icns' magic");
  ok(dv.getUint32(4, false) === icns.length, 'length field matches the file');
  const types = [];
  let o = 8;
  while (o < icns.length) {
    const type = String.fromCharCode(icns[o], icns[o + 1], icns[o + 2], icns[o + 3]);
    const len = dv.getUint32(o + 4, false);
    types.push(type);
    ok(icns[o + 8] === 0x89 && icns[o + 9] === 0x50, type + ' holds a PNG');
    o += len;
  }
  ok(types.join(',') === 'ic07,ic08,ic09,ic10', 'ic07-ic10 present', types.join(','));
});

await run('setExeIcon on a synthetic PE', async () => {
  ok(!!globalThis.__IB_RESEDIT, 'resedit bundle is loaded');
  const pe = unb64(FX.peIcon);
  const ico = await icon.buildIco(synthSource());
  const edited = await icon.setExeIcon(pe, ico);
  ok(edited.length > pe.length, 'file grew with the bigger icon');

  // The overlay (the fake NSIS data at the end) is preserved byte-for-byte.
  const ov = FX.peIconOverlayLen;
  ok(eqBytes(pe.subarray(pe.length - ov), edited.subarray(edited.length - ov)), 'trailing overlay preserved');

  // The PE checksum is correct.
  const info = ib.peInfo(edited);
  const dv = new DataView(edited.buffer);
  ok(dv.getUint32(info.checksumOff, true) === ib.peChecksum(edited, info.checksumOff), 'PE checksum fixed');

  // resedit re-reads the icon group and its images.
  const R = globalThis.__IB_RESEDIT;
  const res = R.NtExecutableResource.from(R.NtExecutable.from(edited, { ignoreCert: true }));
  const groups = R.Resource.IconGroupEntry.fromEntries(res.entries);
  ok(groups.length === 1 && groups[0].id === FX.peIconGroupId, 'icon group ' + FX.peIconGroupId + ' still there', groups.map((g) => g.id).join(','));
  ok(res.entries.filter((e) => e.type === 3).length === 7, 'seven RT_ICON images after the edit');

  // A metadata block still appends and reads back after the icon edit.
  const opened = await ib.readInstaller(edited, 'x.exe');
  ok(!opened.signed && opened.record === null, 'edited PE opens, unsigned, no block yet');
  const RECORD = 'ib-record\t1\nname\tIcon\nproject\thello\nruntime\tpython\n';
  const withMeta = await ib.writeInstaller(opened, { record: RECORD });
  const back = await ib.readInstaller(withMeta, 'x.exe');
  ok(back.record === RECORD, 'metadata round-trips through an icon-edited PE');
});

await run('setPlistIcon', async () => {
  const base = '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleName</key>\n\t<string>App</string>\n</dict></plist>\n';
  const added = icon.setPlistIcon(base, 'AppIcon');
  ok(/<key>CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/.test(added), 'inserts CFBundleIconFile when absent');
  const changed = icon.setPlistIcon(added, 'Other');
  ok(/<string>Other<\/string>/.test(changed) && !/<string>AppIcon<\/string>/.test(changed), 'replaces an existing value');
  ok((changed.match(/CFBundleIconFile/g) || []).length === 1, 'still only one CFBundleIconFile key');
});

await run('macOS .app icon (icns + Info.plist)', async () => {
  // A minimal .app zip with a real <dict> Info.plist.
  const plist = '<?xml version="1.0"?>\n<plist version="1.0"><dict>\n\t<key>CFBundleName</key>\n\t<string>App</string>\n</dict></plist>\n';
  const entries = [
    await ib.zipNewEntry('App.app/', null, { kind: 'dir' }),
    await ib.zipNewEntry('App.app/Contents/', null, { kind: 'dir' }),
    await ib.zipNewEntry('App.app/Contents/Info.plist', plist),
    await ib.zipNewEntry('App.app/Contents/MacOS/', null, { kind: 'dir' }),
    await ib.zipNewEntry('App.app/Contents/MacOS/install', '#!/bin/sh\n'),
    await ib.zipNewEntry('App.app/Contents/Resources/', null, { kind: 'dir' }),
  ];
  const info = await ib.readInstaller(ib.zipWrite(entries), 'App.zip');
  ok(info.kind === 'zip' && info.app === 'App.app/', 'reads the .app');

  // The same operations edit.js applyIconZip does.
  const icns = await icon.buildIcns(synthSource());
  const plistPath = info.app + 'Contents/Info.plist';
  const icnsPath = info.app + 'Contents/Resources/AppIcon.icns';
  const oldPlist = info.entries.find((e) => e.name === plistPath);
  const newPlist = await ib.zipNewEntry(plistPath, icon.setPlistIcon(new TextDecoder().decode(await ib.zipEntryData(oldPlist)), 'AppIcon'));
  info.entries = info.entries.filter((e) => e.name !== plistPath && e.name !== icnsPath);
  info.entries.push(newPlist, await ib.zipNewEntry(icnsPath, icns));

  const built = await ib.writeInstaller(info, { record: 'ib-record\t1\nname\tApp\nruntime\tnone\n' });
  const byName = Object.fromEntries(ib.zipRead(built).map((e) => [e.name, e]));
  ok(icnsPath in byName, '.icns is in the .app Resources');
  ok(byName[icnsPath].usize === icns.length, '.icns size preserved');
  const xml = new TextDecoder().decode(await ib.zipEntryData(byName[plistPath]));
  ok(/CFBundleIconFile<\/key>\s*<string>AppIcon<\/string>/.test(xml), 'Info.plist points at AppIcon');
  const reread = await ib.readInstaller(built, 'App.zip');
  ok(reread.record.includes('name\tApp'), 'the record still reads back');
});

await run('setLinuxIcon', async () => {
  const rec = ib.parseKv('ib-record\t1\nname\tA\nruntime\tpython\n');
  const pack = [];
  const png = await icon.pngEncode(synthSource().raster(16));
  const hash = await icon.setLinuxIcon(rec, pack, png);
  ok(/^[0-9a-f]{64}$/.test(hash), 'returns the PNG SHA-256');
  ok(ib.kvGet(rec, 'icon')[0] === hash, 'record icon key names the hash');
  ok(pack.length === 1 && pack[0].name === hash && eqBytes(pack[0].data, png), 'PNG added to the pack under its hash');
  await icon.setLinuxIcon(rec, pack, png);
  ok(pack.length === 1, 'the same PNG is not packed twice');
});

const s = document.getElementById('summary');
s.textContent = failed ? `FAIL ${failed} failed, ${passed} passed` : `PASS all ${passed}`;
s.className = failed ? 'status fail' : 'status ok';
document.title = s.textContent;
