// Icon editing in the browser (docs/design.md section 4, section 5).
//
// From one square PNG (or SVG) the editor makes the per-platform icon:
//   Windows .exe   a .ico (16/24/32/48 BMP for XP + 64/128/256 PNG) written into
//                  the file's icon group resource with resedit-js, keeping the
//                  NSIS overlay and any appended metadata block, and fixing the
//                  PE checksum.
//   macOS .zip     an .icns (ic07-ic10 PNG) put in the .app's Resources, with
//                  CFBundleIconFile set in Info.plist.
//   Linux .run     the PNG is kept in the pack; the record gets an `icon` key
//                  naming its SHA-256, for the engine's .desktop Icon= (an
//                  engine TODO, docs/format.md section 2).
//
// resedit-js and pe-library (both MIT, (c) 2018 jet) do the PE resource edit.
// They are loaded from globalThis.__IB_RESEDIT (set by vendor/resedit-bundle.js
// on the site pages, and inlined into the self-contained editor page by
// tools/make_standalone.py), falling back to cdn.jsdelivr.net/npm. So the
// standalone page never reaches the network.
//
// PNG encoding is done here in JS (a canvas encoder is skipped) so the output
// is byte-for-byte deterministic and the tests are reliable.
import { toBytes, peInfo, peChecksum, sha256Hex, kvSet, crc32, deflateRaw } from './ibfile.js';

const RESEDIT_URL = 'https://cdn.jsdelivr.net/npm/resedit@2.0.3/+esm';

// resedit, from the inlined/vendored global or (fallback) the CDN.
export async function loadResEdit() {
  if (globalThis.__IB_RESEDIT) return globalThis.__IB_RESEDIT;
  const mod = await import(RESEDIT_URL);
  globalThis.__IB_RESEDIT = mod;
  return mod;
}

/* ---------- a resamplable source image ---------- */

// Decode PNG/SVG bytes into a source that can produce a square RGBA raster at
// any size. Kept separate from the icon builders so tests can pass a synthetic
// source without needing the browser's image decoder.
export async function rasterSource(bytes) {
  const bmp = await createImageBitmap(new Blob([toBytes(bytes)]));
  return {
    raster(size) {
      const cv = new OffscreenCanvas(size, size);
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(bmp, 0, 0, size, size);   // source images are meant to be square
      return ctx.getImageData(0, 0, size, size);
    },
    close() { if (typeof bmp.close === 'function') bmp.close(); },
  };
}

/* ---------- a small PNG encoder (RGBA, no filtering) ---------- */

function adler32(u8) {
  let a = 1, b = 0;
  for (let i = 0; i < u8.length; i++) {
    a = (a + u8[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function pngChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  dv.setUint32(8 + data.length, crc32(crcInput), false);
  return out;
}

// Encode ImageData as a 8-bit RGBA PNG.
export async function pngEncode(imageData) {
  const { width, height, data } = imageData;
  // Scanlines: a 0 filter byte then the row's RGBA bytes.
  const raw = new Uint8Array(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), o);
    o += width * 4;
  }
  const deflated = await deflateRaw(raw);
  // zlib wrapper: header (0x78 0x01, valid FCHECK), deflate-raw body, adler32.
  const zlib = new Uint8Array(2 + deflated.length + 4);
  zlib[0] = 0x78; zlib[1] = 0x01;
  zlib.set(deflated, 2);
  new DataView(zlib.buffer).setUint32(2 + deflated.length, adler32(raw), false);

  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width, false);
  hv.setUint32(4, height, false);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // 10,11,12 = compression/filter/interlace = 0

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib), pngChunk('IEND', new Uint8Array(0))];
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

/* ---------- .ico ---------- */

// A 32bpp bottom-up BMP (DIB) icon image with an all-opaque AND mask, the
// format XP understands (it can't read PNG-compressed icon entries).
function bmpIcon(imageData, size) {
  const HEADER = 40;
  const xor = size * size * 4;
  const andRow = (((size + 31) >> 5) << 2); // 1bpp rows padded to 4 bytes
  const and = andRow * size;
  const out = new Uint8Array(HEADER + xor + and);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, HEADER, true);       // biSize
  dv.setInt32(4, size, true);          // biWidth
  dv.setInt32(8, size * 2, true);      // biHeight (image + mask)
  dv.setUint16(12, 1, true);           // biPlanes
  dv.setUint16(14, 32, true);          // biBitCount
  dv.setUint32(16, 0, true);           // BI_RGB
  dv.setUint32(20, xor + and, true);   // biSizeImage
  const src = imageData.data;
  let o = HEADER;
  for (let y = size - 1; y >= 0; y--) { // bottom-up
    let s = y * size * 4;
    for (let x = 0; x < size; x++) {
      out[o++] = src[s + 2]; out[o++] = src[s + 1]; out[o++] = src[s]; out[o++] = src[s + 3]; // BGRA
      s += 4;
    }
  }
  // AND mask left all zero: opacity comes from the alpha channel.
  return out;
}

const ICO_BMP_SIZES = [16, 24, 32, 48];
const ICO_PNG_SIZES = [64, 128, 256];

// Build a .ico from a source: small sizes as BMP (for XP), large as PNG.
export async function buildIco(source) {
  const entries = [];
  for (const s of ICO_BMP_SIZES) entries.push({ size: s, data: bmpIcon(source.raster(s), s) });
  for (const s of ICO_PNG_SIZES) entries.push({ size: s, data: await pngEncode(source.raster(s)) });

  const n = entries.length;
  const dirLen = 6 + n * 16;
  let total = dirLen;
  for (const e of entries) total += e.data.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true);   // reserved
  dv.setUint16(2, 1, true);   // type: icon
  dv.setUint16(4, n, true);   // count
  let off = dirLen;
  for (let i = 0; i < n; i++) {
    const e = entries[i];
    const d = 6 + i * 16;
    out[d] = e.size >= 256 ? 0 : e.size;      // width (0 == 256)
    out[d + 1] = e.size >= 256 ? 0 : e.size;  // height
    out[d + 2] = 0;                            // colours in palette
    out[d + 3] = 0;                            // reserved
    dv.setUint16(d + 4, 1, true);              // planes
    dv.setUint16(d + 6, 32, true);             // bit count
    dv.setUint32(d + 8, e.data.length, true);  // bytes in resource
    dv.setUint32(d + 12, off, true);           // offset from file start
    out.set(e.data, off);
    off += e.data.length;
  }
  return out;
}

/* ---------- .icns ---------- */

const ICNS_TYPES = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]];

// Build an .icns from a source: PNG-based OSTypes ic07-ic10 (design.md 4).
export async function buildIcns(source) {
  const chunks = [];
  let total = 8; // magic + length
  for (const [type, size] of ICNS_TYPES) {
    const png = await pngEncode(source.raster(size));
    const c = new Uint8Array(8 + png.length);
    for (let i = 0; i < 4; i++) c[i] = type.charCodeAt(i);
    new DataView(c.buffer).setUint32(4, c.length, false); // big-endian, incl. header
    c.set(png, 8);
    chunks.push(c);
    total += c.length;
  }
  const out = new Uint8Array(total);
  out[0] = 0x69; out[1] = 0x63; out[2] = 0x6e; out[3] = 0x73; // 'icns'
  new DataView(out.buffer).setUint32(4, total, false);
  let o = 8;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ---------- Windows PE icon ---------- */

// Replace the icon group resource of an unsigned PE with `icoBytes`, keeping
// the NSIS overlay (the installer's own data) and fixing the PE checksum.
// `peBytes` is the base only, with no appended metadata block.
export async function setExeIcon(peBytes, icoBytes) {
  const ResEdit = await loadResEdit();
  const src = toBytes(peBytes);
  const exe = ResEdit.NtExecutable.from(src, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(icoBytes.buffer ? icoBytes.slice().buffer : icoBytes);
  const icons = iconFile.icons.map((it) => it.data);

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (!groups.length) throw new Error('This installer has no icon to replace.');
  // NSIS keeps the app icon in one group; replace every group so the icon is
  // consistent wherever Windows shows it.
  for (const g of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons);
  }
  res.outputResource(exe);
  const out = new Uint8Array(exe.generate());

  // Set a correct optional-header checksum (a wrong value raises antivirus
  // heuristic scores, design.md section 5).
  const pe = peInfo(out);
  if (pe) new DataView(out.buffer).setUint32(pe.checksumOff, peChecksum(out, pe.checksumOff), true);
  return out;
}

/* ---------- macOS Info.plist ---------- */

// Set CFBundleIconFile to `name` in an Info.plist's XML text.
export function setPlistIcon(xml, name) {
  const keyRe = /(<key>\s*CFBundleIconFile\s*<\/key>\s*)<string>[^<]*<\/string>/;
  if (keyRe.test(xml)) return xml.replace(keyRe, '$1<string>' + name + '</string>');
  const entry = '\t<key>CFBundleIconFile</key>\n\t<string>' + name + '</string>\n';
  if (/<dict>/.test(xml)) return xml.replace('<dict>', '<dict>\n' + entry);
  throw new Error('Info.plist has no <dict> to add the icon to.');
}

/* ---------- linux record key ---------- */

// Keep the PNG in the pack and point the record's `icon` key at its hash.
// `pack` is the edit page's [{name, data, label}] list, mutated in place.
export async function setLinuxIcon(recEntries, pack, pngBytes) {
  const data = toBytes(pngBytes);
  const name = await sha256Hex(data);
  if (!pack.some((m) => m.name === name)) pack.push({ name, data, label: 'app icon (PNG)' });
  kvSet(recEntries, 'icon', [name]);
  return name;
}
