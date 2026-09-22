// Icon editing in the browser (docs/design.md section 4, section 5).
//
// From one square PNG (or SVG) the editor makes the per-platform icon:
//   Windows .exe   a .ico (16/24/32/48 BMP for XP + 64/128/256 PNG) written into
//                  the file's icon group resource by appending a section (see
//                  "Windows PE icon" below), keeping the NSIS overlay and any
//                  appended metadata block, and fixing the PE checksum.
//   macOS .zip     an .icns (ic07-ic10 PNG) put in the .app's Resources, with
//                  CFBundleIconFile set in Info.plist.
//   Linux .run     the PNG is kept in the pack; the record gets an `icon` key
//                  naming its SHA-256, for the engine's .desktop Icon= (an
//                  engine TODO, docs/format.md section 2).
//
// The PE resource edit is done here, by hand: resedit-js rebuilt `.rsrc` and
// broke every NSIS uninstaller (see "Windows PE icon" below). resedit-js and
// pe-library (both MIT, (c) 2018 jet) are still vendored and still loaded by
// the pages through loadResEdit(), because tests/icon-test.js reads the
// result back with them -- an independent parser for what this file writes.
// They are loaded from globalThis.__TI_RESEDIT (set by src/vendor/resedit-bundle.js
// on the site pages, and inlined into the one-file site by
// tools/build_site.py), falling back to cdn.jsdelivr.net/npm. So the
// standalone page never reaches the network.
//
// PNG encoding is done here in JS (a canvas encoder is skipped) so the output
// is byte-for-byte deterministic and the tests are reliable.
import { toBytes, peInfo, peChecksum, sha256Hex, kvSet, crc32, deflateRaw, zipEntryData, zipNewEntry } from './tifile.js';
import { inflate } from '../web_client/lib/zlib.js';

const RESEDIT_URL = 'https://cdn.jsdelivr.net/npm/resedit@2.0.3/+esm';

// resedit, from the inlined/vendored global or (fallback) the CDN.
export async function loadResEdit() {
  if (globalThis.__TI_RESEDIT) return globalThis.__TI_RESEDIT;
  // (Built by Function so that the one-file page, which has the global,
  // parses in browsers without dynamic import.)
  const mod = await new Function('u', 'return import(u)')(RESEDIT_URL);
  globalThis.__TI_RESEDIT = mod;
  return mod;
}

/* ---------- a resamplable source image ---------- */

// Decode PNG/SVG bytes into a source that can produce a square RGBA raster at
// any size. Kept separate from the icon builders so tests can pass a synthetic
// source without needing the browser's image decoder. PNGs are decoded and
// scaled here in JS (pngDecode, resizeRGBA), so the server and the
// browser make the same bytes; anything else (SVG) needs the browser.
export async function rasterSource(bytes) {
  const u8 = toBytes(bytes);
  if (isPng(u8)) {
    const img = await pngDecode(u8);
    return { raster: (size) => resizeRGBA(img, size), close() {} };
  }
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    throw new Error('The icon must be a PNG (this browser cannot draw SVG icons).');
  }
  const bmp = await createImageBitmap(new Blob([u8]));
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

/* ---------- a small PNG decoder and resizer ---------- */

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const ICON_MAX_BYTES = 1 << 20;
export const ICON_MIN = 16;
export const ICON_MAX = 1024;

function isPng(u8) {
  return u8.length > 8 && PNG_SIG.every((b, i) => u8[i] === b);
}

// The upload rules (Go's icon.Decode): a real, square PNG of 16 to 1024
// pixels and at most 1 MB. The header is read before anything is decoded,
// with image/png's DecodeConfig checks (IHDR first, its CRC and fields), so
// the messages are the server's.
export function checkIconPng(bytes) {
  const u8 = toBytes(bytes);
  if (!u8.length) throw new Error('the icon is empty');
  if (u8.length > ICON_MAX_BYTES) throw new Error('the icon is over ' + (ICON_MAX_BYTES >> 10) + ' KB');
  if (!isPng(u8)) throw new Error('the icon must be a PNG');
  const invalid = () => new Error('the icon isn\'t a valid PNG');
  if (u8.length < 33) throw invalid();
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(8) !== 13 || String.fromCharCode(u8[12], u8[13], u8[14], u8[15]) !== 'IHDR') throw invalid();
  if (crc32(u8.subarray(12, 29)) !== dv.getUint32(29)) throw invalid();
  const w = dv.getUint32(16), h = dv.getUint32(20), depth = u8[24], ctype = u8[25];
  const depths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }[ctype];
  if (!w || !h || w > 0x7fffffff || h > 0x7fffffff || !depths || !depths.includes(depth) ||
      u8[26] !== 0 || u8[27] !== 0 || u8[28] > 1) throw invalid();
  if (w !== h) throw new Error('the icon must be square (it is ' + w + 'x' + h + ')');
  if (w < ICON_MIN || w > ICON_MAX) throw new Error('the icon must be ' + ICON_MIN + ' to ' + ICON_MAX + ' pixels across (it is ' + w + ')');
}

// checkIconPng, then a full decode (Go's icon.Decode decodes every upload
// before it is stored). Returns the decoded image.
export async function decodeIconPng(bytes) {
  checkIconPng(bytes);
  try {
    return await pngDecode(bytes);
  } catch (e) {
    throw new Error('the icon isn\'t a valid PNG');
  }
}

const inflateZlib = (u8) => inflate(u8, 'deflate');

// PNG bytes -> {width, height, data} with 8-bit RGBA data (not
// premultiplied). Every colour type and bit depth, and Adam7 interlacing.
export async function pngDecode(bytes) {
  const u8 = toBytes(bytes);
  if (!isPng(u8)) throw new Error('not a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 8, ihdr = null, palette = null, trns = null;
  const idat = [];
  while (o + 8 <= u8.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
    const data = u8.subarray(o + 8, o + 8 + len);
    if (data.length !== len || o + 12 + len > u8.length) throw new Error('the icon isn\'t a valid PNG');
    // Every chunk's CRC, as image/png checks them.
    if (crc32(u8.subarray(o + 4, o + 8 + len)) !== dv.getUint32(o + 8 + len)) throw new Error('the icon isn\'t a valid PNG');
    if (type === 'IHDR') {
      ihdr = { w: dv.getUint32(o + 8), h: dv.getUint32(o + 12), depth: u8[o + 16], ctype: u8[o + 17], interlace: u8[o + 20] };
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  if (!ihdr || !idat.length) throw new Error('the icon isn\'t a valid PNG');
  const { w, h, depth, ctype, interlace } = ihdr;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || (ctype === 3 && !palette)) throw new Error('the icon isn\'t a valid PNG');
  let total = 0;
  for (const d of idat) total += d.length;
  const z = new Uint8Array(total);
  total = 0;
  for (const d of idat) { z.set(d, total); total += d.length; }
  const raw = await inflateZlib(z);
  const bpp = Math.max(1, (channels * depth) >> 3);        // bytes per pixel, for filtering
  const out = new Uint8Array(w * h * 4);
  const maxv = (1 << depth) - 1;
  let pos = 0;

  // One (sub)image: unfilter its rows, then write its pixels.
  function pass(x0, y0, dx, dy) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy);
    if (pw <= 0 || ph <= 0) return;
    const stride = Math.ceil(pw * channels * depth / 8);
    let prev = new Uint8Array(stride);
    for (let y = 0; y < ph; y++) {
      const f = raw[pos++];
      const line = raw.slice(pos, pos + stride);
      pos += stride;
      if (line.length !== stride) throw new Error('the icon isn\'t a valid PNG');
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = line[i];
        if (f === 1) v += a;
        else if (f === 2) v += b;
        else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        } else if (f !== 0) throw new Error('the icon isn\'t a valid PNG');
        line[i] = v & 255;
      }
      prev = line;
      for (let x = 0; x < pw; x++) {
        const sample = (k) => {        // channel k of pixel x, scaled to 0..255
          if (depth === 16) return line[(x * channels + k) * 2];
          if (depth === 8) return line[x * channels + k];
          const bit = (x * channels + k) * depth;
          const v = (line[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
          return ctype === 3 ? v : Math.round(v * 255 / maxv);
        };
        const rawAt = (k) => {         // unscaled, for tRNS matching
          if (depth === 16) return (line[(x * channels + k) * 2] << 8) | line[(x * channels + k) * 2 + 1];
          if (depth === 8) return line[x * channels + k];
          const bit = (x * channels + k) * depth;
          return (line[bit >> 3] >> (8 - depth - (bit & 7))) & maxv;
        };
        let r, g, bl, al = 255;
        if (ctype === 3) {
          const i = sample(0);
          r = palette[i * 3]; g = palette[i * 3 + 1]; bl = palette[i * 3 + 2];
          if (trns && i < trns.length) al = trns[i];
        } else if (ctype === 0 || ctype === 4) {
          r = g = bl = sample(0);
          if (ctype === 4) al = sample(1);
          else if (trns && trns.length >= 2 && rawAt(0) === ((trns[0] << 8) | trns[1])) al = 0;
        } else {
          r = sample(0); g = sample(1); bl = sample(2);
          if (ctype === 6) al = sample(3);
          else if (trns && trns.length >= 6 && rawAt(0) === ((trns[0] << 8) | trns[1]) &&
                   rawAt(1) === ((trns[2] << 8) | trns[3]) && rawAt(2) === ((trns[4] << 8) | trns[5])) al = 0;
        }
        const d = ((y0 + y * dy) * w + (x0 + x * dx)) * 4;
        out[d] = r; out[d + 1] = g; out[d + 2] = bl; out[d + 3] = al;
      }
    }
  }
  if (interlace) {
    for (const [x0, y0, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) pass(x0, y0, dx, dy);
  } else pass(0, 0, 1, 1);
  return { width: w, height: h, data: out };
}

// Catmull-Rom, widened when shrinking (as Go's x/image/draw scales).
function catmullRom(t) {
  t = Math.abs(t);
  if (t < 1) return (1.5 * t - 2.5) * t * t + 1;
  if (t < 2) return ((-0.5 * t + 2.5) * t - 4) * t + 2;
  return 0;
}

function resampleAxis(src, sw, sh, dw, horizontal) {
  // Resamples along one axis; src is premultiplied float RGBA, sw x sh.
  const n = horizontal ? sw : sh, m = horizontal ? sh : sw;
  const scale = n / dw, support = 2 * Math.max(1, scale);
  const out = new Float64Array((horizontal ? dw * sh : sw * dw) * 4);
  for (let i = 0; i < dw; i++) {
    const center = (i + 0.5) * scale - 0.5;
    const lo = Math.max(0, Math.floor(center - support)), hi = Math.min(n - 1, Math.ceil(center + support));
    const ws = [];
    let sum = 0;
    for (let k = lo; k <= hi; k++) {
      const wt = catmullRom((k - center) / Math.max(1, scale));
      ws.push(wt);
      sum += wt;
    }
    for (let j = 0; j < m; j++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = lo; k <= hi; k++) {
        const wt = ws[k - lo] / sum;
        const s = (horizontal ? j * sw + k : k * sw + j) * 4;
        r += src[s] * wt; g += src[s + 1] * wt; b += src[s + 2] * wt; a += src[s + 3] * wt;
      }
      const d = (horizontal ? j * dw + i : i * sw + j) * 4;
      out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a;
    }
  }
  return out;
}

// {width, height, data RGBA} -> size x size, as ImageData-like
// {width, height, data: Uint8ClampedArray}. Scaled in premultiplied alpha,
// so transparent pixels don't bleed their colour.
export function resizeRGBA(img, size) {
  const { width: w, height: h, data } = img;
  let f = new Float64Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    f[i * 4] = data[i * 4] * a; f[i * 4 + 1] = data[i * 4 + 1] * a; f[i * 4 + 2] = data[i * 4 + 2] * a; f[i * 4 + 3] = data[i * 4 + 3];
  }
  if (w !== size) f = resampleAxis(f, w, h, size, true);
  if (h !== size) f = resampleAxis(f, size, h, size, false);
  const out = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = Math.min(255, Math.max(0, f[i * 4 + 3]));
    const k = a > 0 ? 255 / a : 0;
    out[i * 4] = Math.round(f[i * 4] * k); out[i * 4 + 1] = Math.round(f[i * 4 + 1] * k);
    out[i * 4 + 2] = Math.round(f[i * 4 + 2] * k); out[i * 4 + 3] = Math.round(a);
  }
  return { width: size, height: size, data: out };
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
//
// The icon is written by *appending* a section, never by rebuilding `.rsrc`.
//
// Why: NSIS's `WriteUninstaller` copies the installer's own PE header (the
// bytes before its overlay) out to `uninstall.exe`, then patches the
// uninstaller's icon images over the installer's, at **absolute file
// offsets fixed when makensis ran** and stored in a patch table inside the
// compressed NSIS header. A resource editor that rewrites `.rsrc` in place
// moves everything after the first changed byte, so those offsets land on
// whatever is there now -- the dialogs, the group icon, `RT_MANIFEST`. The
// clobbered manifest makes Windows refuse to start the uninstaller at all
// ("side-by-side configuration is incorrect"). That is what resedit-js did
// here until 2026-09-20, on every Windows installer with a custom icon
// (docs/spikes/uninstaller-icon/RESULTS.md).
//
// So: `.rsrc` is left byte for byte where it is, and a new `.tirsrc`
// section is added after the last one holding a complete new resource
// directory plus the new icon images; the resource data directory is
// pointed at it. Resources we don't change keep their data entry's RVA into
// the old section. The original icon images stay at their original offsets,
// unreferenced, and NSIS's patch lands on those dead bytes.
//
// This is what the retired Go server did (src/build_server/internal/icon/pe.go, now
// only in git history), ported here so the page and the Node server -- which
// both call setExeIcon -- are fixed together.
//
// The NSIS overlay moves later by the new section's raw size, a multiple of
// FileAlignment (512 for NSIS); NSIS finds its data by scanning 512-byte
// aligned offsets, as it already had to after the old resedit edits
// (design.md section 5), and the base is built with `CRCCheck off`.

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const PE_DIR_RESOURCE = 2;
const PE_DIR_SECURITY = 4;
const TI_SECTION = '.tirsrc';
// IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ
const TI_SECTION_CHARS = 0x40000040;

function peAlign(v, a) { return Math.ceil(v / a) * a; }

function peBad(what) {
  return new Error('This installer\'s icon can\'t be set: ' + what + '.');
}

// The PE headers and section table setExeIcon needs.
function peParse(b) {
  if (b.length < 0x40 || b[0] !== 0x4d || b[1] !== 0x5a) throw peBad('it is not a Windows program');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o) => dv.getUint16(o, true);
  const u32 = (o) => dv.getUint32(o, true);
  const pe = u32(0x3c);
  if (pe < 0x40 || pe + 24 > b.length || u32(pe) !== 0x00004550) throw peBad('it is not a Windows program');
  const nsec = u16(pe + 6);
  const optSize = u16(pe + 20);
  const opt = pe + 24;
  if (optSize < 96 || opt + optSize > b.length) throw peBad('its PE header is truncated');
  const magic = u16(opt);
  let dirs, ndirs;
  if (magic === 0x10b) { dirs = opt + 96; ndirs = u32(opt + 92); }
  else if (magic === 0x20b) { dirs = opt + 112; ndirs = u32(opt + 108); }
  else throw peBad('its PE optional header is not one this editor knows');
  if (ndirs <= PE_DIR_SECURITY || dirs + 8 * ndirs > opt + optSize) throw peBad('it has too few PE data directories');
  const h = {
    dv: dv, pe: pe, opt: opt, dirs: dirs, ndirs: ndirs, nsec: nsec,
    secAlign: u32(opt + 32), fileAlign: u32(opt + 36), sizeOfHeaders: u32(opt + 60),
    secs: opt + optSize, sections: [],
  };
  if (!h.secAlign || !h.fileAlign) throw peBad('its PE alignment values are zero');
  if (h.secs + 40 * nsec > b.length) throw peBad('its PE section table is truncated');
  for (let i = 0; i < nsec; i++) {
    const o = h.secs + 40 * i;
    let name = '';
    for (let k = 0; k < 8 && b[o + k]; k++) name += String.fromCharCode(b[o + k]);
    h.sections.push({ off: o, name: name, vsize: u32(o + 8), va: u32(o + 12), rawSize: u32(o + 16), raw: u32(o + 20) });
  }
  return h;
}

// The file bytes a section holds, as [start, end) file offsets: the raw
// data, cut short if the section's virtual size is smaller.
function peSecRange(b, s) {
  let n = s.rawSize;
  if (s.vsize && s.vsize < n) n = s.vsize;
  if (!n || s.raw + n > b.length) return null;
  return { off: s.raw, end: s.raw + n };
}

// The file bytes from `rva` to the end of the section holding it.
function peRvaRange(h, b, rva) {
  for (let i = 0; i < h.sections.length; i++) {
    const s = h.sections[i];
    const r = peSecRange(b, s);
    if (!r) continue;
    const n = r.end - r.off;
    if (rva >= s.va && rva < s.va + n) return { off: r.off + (rva - s.va), end: r.end };
  }
  return null;
}

/* resource tree: {name: [code units] | null, id, children: [] | null,
   leaf: {rva, size, codepage, data} | null} */

// Read the resource directory whose root is at `rootRVA`.
function resParse(h, b, rootRVA) {
  const r = peRvaRange(h, b, rootRVA);
  if (!r) throw peBad('its resource directory is outside the file');
  const area = b.subarray(r.off, r.end);
  const dv = new DataView(area.buffer, area.byteOffset, area.byteLength);
  let count = 0;

  function walk(off, depth) {
    if (depth > 3 || off + 16 > area.length) throw peBad('its resource directory is damaged');
    const n = dv.getUint16(off + 12, true) + dv.getUint16(off + 14, true);
    count += n;
    if (count > 100000 || off + 16 + 8 * n > area.length) throw peBad('its resource directory is damaged');
    const node = { name: null, id: 0, children: [], leaf: null };
    for (let i = 0; i < n; i++) {
      const e = off + 16 + 8 * i;
      const nameF = dv.getUint32(e, true), dataF = dv.getUint32(e + 4, true);
      const c = { name: null, id: 0, children: null, leaf: null };
      if (nameF & 0x80000000) {
        const so = nameF & 0x7fffffff;
        if (so + 2 > area.length) throw peBad('a resource name is damaged');
        const l = dv.getUint16(so, true);
        if (so + 2 + 2 * l > area.length) throw peBad('a resource name is damaged');
        c.name = [];
        for (let j = 0; j < l; j++) c.name.push(dv.getUint16(so + 2 + 2 * j, true));
      } else {
        c.id = nameF >>> 0;
      }
      if (dataF & 0x80000000) {
        c.children = walk(dataF & 0x7fffffff, depth + 1).children;
      } else {
        if (dataF + 16 > area.length) throw peBad('a resource data entry is damaged');
        c.leaf = {
          rva: dv.getUint32(dataF, true), size: dv.getUint32(dataF + 4, true),
          codepage: dv.getUint32(dataF + 8, true), data: null,
        };
      }
      node.children.push(c);
    }
    return node;
  }
  return walk(0, 1);
}

function resFind(node, id) {
  for (let i = 0; i < node.children.length; i++) {
    const c = node.children[i];
    if (c.name === null && c.id === id) return c;
  }
  return null;
}

// Named entries first (in the order the file's author sorted them), then
// IDs ascending, as the PE format requires.
function resSortChildren(node) {
  const named = [], ids = [];
  for (let i = 0; i < node.children.length; i++) {
    (node.children[i].name !== null ? named : ids).push(node.children[i]);
  }
  ids.sort((a, b) => a.id - b.id);
  node.children = named.concat(ids);
}

// Every leaf in the tree, in walk order.
function resLeaves(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (!n.children) continue;
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i];
      if (c.leaf) out.push(c); else stack.push(c);
    }
  }
  return out;
}

// Lay the tree out as a section placed at `rva`: directory tables, then
// data entries, then names, then the new data.
function resSerialize(root, rva) {
  const tables = [], leaves = [], named = [];
  let queue = [root], off = 0;
  while (queue.length) {
    const n = queue.shift();
    tables.push(n);
    n._off = off;
    off += 16 + 8 * n.children.length;
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      if (c.name !== null) named.push(c);
      if (c.leaf) leaves.push(c); else queue.push(c);
    }
  }
  for (let i = 0; i < leaves.length; i++) { leaves[i]._leafOff = off; off += 16; }
  for (let i = 0; i < named.length; i++) { named[i]._nameOff = off; off += 2 + 2 * named[i].name.length; }
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i];
    if (l.leaf.data) { off = peAlign(off, 8); l._dataOff = off; off += l.leaf.data.length; }
  }
  const out = new Uint8Array(off);
  const dv = new DataView(out.buffer);
  for (let t = 0; t < tables.length; t++) {
    const node = tables[t], o = node._off;
    let nNamed = 0;
    for (let i = 0; i < node.children.length; i++) if (node.children[i].name !== null) nNamed++;
    dv.setUint16(o + 12, nNamed, true);
    dv.setUint16(o + 14, node.children.length - nNamed, true);
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i], e = o + 16 + 8 * i;
      dv.setUint32(e, c.name !== null ? (0x80000000 | c._nameOff) >>> 0 : c.id, true);
      dv.setUint32(e + 4, c.leaf ? c._leafOff : (0x80000000 | c._off) >>> 0, true);
    }
  }
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i], d = l._leafOff;
    if (l.leaf.data) {
      dv.setUint32(d, rva + l._dataOff, true);
      dv.setUint32(d + 4, l.leaf.data.length, true);
      out.set(l.leaf.data, l._dataOff);
    } else {
      dv.setUint32(d, l.leaf.rva, true);
      dv.setUint32(d + 4, l.leaf.size, true);
    }
    dv.setUint32(d + 8, l.leaf.codepage, true);
  }
  for (let i = 0; i < named.length; i++) {
    const n = named[i], o = n._nameOff;
    dv.setUint16(o, n.name.length, true);
    for (let j = 0; j < n.name.length; j++) dv.setUint16(o + 2 + 2 * j, n.name[j], true);
  }
  return out;
}

// An .ico's images: the 12 bytes an RT_GROUP_ICON entry copies (width,
// height, colours, reserved, planes, bit count, byte count) and the image.
export function icoImages(icoBytes) {
  const u8 = toBytes(icoBytes);
  const bad = new Error('That icon file can\'t be read.');
  if (u8.length < 6) throw bad;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint16(0, true) !== 0 || dv.getUint16(2, true) !== 1) throw bad;
  const n = dv.getUint16(4, true);
  if (!n || 6 + n * 16 > u8.length) throw bad;
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = 6 + i * 16;
    const size = dv.getUint32(d + 8, true), off = dv.getUint32(d + 12, true);
    if (!size || off + size > u8.length) throw bad;
    out.push({ entry: u8.subarray(d, d + 12), data: u8.subarray(off, off + size) });
  }
  return out;
}

// The RT_GROUP_ICON resource naming images ids[i].
function groupData(images, ids) {
  const out = new Uint8Array(6 + 14 * images.length);
  const dv = new DataView(out.buffer);
  dv.setUint16(2, 1, true);                 // type: icon
  dv.setUint16(4, images.length, true);
  for (let i = 0; i < images.length; i++) {
    const e = 6 + 14 * i;
    out.set(images[i].entry, e);            // 12 bytes, ending in dwBytesInRes
    dv.setUint16(e + 12, ids[i], true);
  }
  return out;
}

// Replace the icon group resource of an unsigned PE with `icoBytes`, keeping
// the NSIS overlay (the installer's own data) and fixing the PE checksum.
// `peBytes` is the base only, with no appended metadata block.
export async function setExeIcon(peBytes, icoBytes) {
  const b = toBytes(peBytes);
  const images = icoImages(icoBytes);
  const h = peParse(b);
  const dvIn = h.dv;

  // A section we appended ourselves last time (the user picked a second
  // icon) is replaced rather than stacked on. It qualifies only if it is
  // last in the table, in the file and in the address space.
  let reuse = h.nsec ? h.sections[h.nsec - 1] : null;
  if (!reuse || reuse.name !== TI_SECTION || !reuse.rawSize) reuse = null;
  if (reuse) {
    for (let i = 0; i + 1 < h.nsec; i++) {
      const o = h.sections[i];
      if (o.va >= reuse.va || (o.rawSize && o.raw + o.rawSize > reuse.raw)) { reuse = null; break; }
    }
  }

  // Where the section data ends: the overlay starts there.
  const kept = reuse ? h.sections.slice(0, h.nsec - 1) : h.sections;
  let dataEnd = 0, virtEnd = 0, firstRaw = b.length;
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const e = s.va + peAlign(s.vsize || s.rawSize, h.secAlign);
    if (e > virtEnd) virtEnd = e;
    if (!s.rawSize) continue;
    if (s.raw + s.rawSize > dataEnd) dataEnd = s.raw + s.rawSize;
    if (s.raw < firstRaw) firstRaw = s.raw;
  }
  if (reuse && reuse.raw !== dataEnd) throw peBad('its sections leave a gap before the overlay');
  if (dataEnd > b.length) throw peBad('its sections run past the end of the file');
  if (dataEnd % h.fileAlign !== 0) throw peBad('its section data doesn\'t end on a file-alignment boundary');

  // Room for one more section header, unless we are reusing ours.
  const hdrEnd = h.secs + 40 * h.nsec;
  const newSecOff = reuse ? reuse.off : hdrEnd;
  if (!reuse) {
    if (hdrEnd + 40 > h.sizeOfHeaders || hdrEnd + 40 > firstRaw) throw peBad('there is no room in it for another section');
    for (let i = hdrEnd; i < hdrEnd + 40; i++) {
      if (b[i]) throw peBad('there is no room in it for another section');
    }
  }

  // The new resource tree: the old one, with every icon group replaced.
  let root;
  const resRva = dvIn.getUint32(h.dirs + 8 * PE_DIR_RESOURCE, true);
  const resSize = dvIn.getUint32(h.dirs + 8 * PE_DIR_RESOURCE + 4, true);
  if (resRva && resSize) root = resParse(h, b, resRva);
  else root = { name: null, id: 0, children: [], leaf: null };

  // Every resource's bytes are copied into the new section, so it is
  // self-contained and nothing points back into `.rsrc` (a cross-section
  // resource RVA is legal, and the Windows loader resolves it, but some
  // resource readers -- pe-library among them -- refuse to follow it). The
  // old section's bytes stay exactly where they were all the same: that is
  // what keeps NSIS's patch offsets harmless. The old icon images are the
  // bulk of it and are dropped below, so this costs very little.
  const leaves = resLeaves(root);
  for (let i = 0; i < leaves.length; i++) {
    const l = leaves[i].leaf;
    const r = peRvaRange(h, b, l.rva);
    if (r && l.size <= r.end - r.off) l.data = b.slice(r.off, r.off + l.size);
  }

  let groups = resFind(root, RT_GROUP_ICON);
  if (!groups || !groups.children.length) {
    groups = { name: null, id: RT_GROUP_ICON, children: [{ name: null, id: 1, children: [], leaf: null }], leaf: null };
    root.children.push(groups);
  }
  const ids = [];
  for (let i = 0; i < images.length; i++) ids.push(i + 1);
  const group = groupData(images, ids);
  // NSIS keeps the app icon in one group; replace every group so the icon is
  // consistent wherever Windows shows it.
  let lang = 0, haveLang = false;
  for (let i = 0; i < groups.children.length; i++) {
    const g = groups.children[i];
    if (g.leaf) { g.leaf = null; g.children = []; }        // malformed: no language level
    if (!g.children.length) g.children = [{ name: null, id: 0, children: null, leaf: null }];
    for (let j = 0; j < g.children.length; j++) {
      const l = g.children[j];
      if (!haveLang && l.name === null) { lang = l.id; haveLang = true; }
      l.children = null;
      l.leaf = { rva: 0, size: 0, codepage: 0, data: group };
    }
  }
  // Every group now names images 1..n, so the old ones are dropped from the
  // directory. Their bytes stay in `.rsrc`, which is the whole point.
  let icons = resFind(root, RT_ICON);
  if (!icons) {
    icons = { name: null, id: RT_ICON, children: [], leaf: null };
    root.children.push(icons);
  }
  icons.children = [];
  for (let i = 0; i < images.length; i++) {
    icons.children.push({
      name: null, id: ids[i], leaf: null,
      children: [{ name: null, id: lang, children: null, leaf: { rva: 0, size: 0, codepage: 0, data: images[i].data } }],
    });
  }
  resSortChildren(root);

  // Lay the new section out after the last one, and move the overlay down.
  const newVA = peAlign(virtEnd, h.secAlign);
  const rsrc = resSerialize(root, newVA);
  const rawSize = peAlign(rsrc.length, h.fileAlign);
  const overlay = b.subarray(reuse ? reuse.raw + reuse.rawSize : dataEnd);
  if (dataEnd + rawSize + overlay.length > 0x7fffffff) throw peBad('it would be too large');

  const out = new Uint8Array(dataEnd + rawSize + overlay.length);
  out.set(b.subarray(0, dataEnd), 0);
  out.set(rsrc, dataEnd);
  out.set(overlay, dataEnd + rawSize);      // the NSIS overlay, byte for byte

  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[newSecOff + i] = i < TI_SECTION.length ? TI_SECTION.charCodeAt(i) : 0;
  dv.setUint32(newSecOff + 8, rsrc.length, true);          // VirtualSize
  dv.setUint32(newSecOff + 12, newVA, true);               // VirtualAddress
  dv.setUint32(newSecOff + 16, rawSize, true);             // SizeOfRawData
  dv.setUint32(newSecOff + 20, dataEnd, true);             // PointerToRawData
  dv.setUint32(newSecOff + 24, 0, true);
  dv.setUint32(newSecOff + 28, 0, true);
  dv.setUint32(newSecOff + 32, 0, true);
  dv.setUint32(newSecOff + 36, TI_SECTION_CHARS, true);
  if (!reuse) dv.setUint16(h.pe + 6, h.nsec + 1, true);    // NumberOfSections
  const grew = rawSize - (reuse ? reuse.rawSize : 0);
  dv.setUint32(h.opt + 8, (dv.getUint32(h.opt + 8, true) + grew) >>> 0, true);      // SizeOfInitializedData
  dv.setUint32(h.opt + 56, newVA + peAlign(rsrc.length, h.secAlign), true);         // SizeOfImage
  dv.setUint32(h.dirs + 8 * PE_DIR_RESOURCE, newVA, true);
  dv.setUint32(h.dirs + 8 * PE_DIR_RESOURCE + 4, rsrc.length, true);
  // The result carries no certificate (an Authenticode signature is applied
  // after the icon, and `peBytes` never includes one).
  dv.setUint32(h.dirs + 8 * PE_DIR_SECURITY, 0, true);
  dv.setUint32(h.dirs + 8 * PE_DIR_SECURITY + 4, 0, true);

  // Set a correct optional-header checksum (a wrong value raises antivirus
  // heuristic scores, design.md section 5).
  const pe = peInfo(out);
  if (pe) dv.setUint32(pe.checksumOff, peChecksum(out, pe.checksumOff), true);
  return out;
}

/* ---------- macOS Info.plist ---------- */

// Set CFBundleIconFile to `name` in an Info.plist's XML text, byte for byte
// as the Go server's icon.SetPlistIcon does it.
export function setPlistIcon(xml, name) {
  const keyRe = /(<key>[\t\n\f\r ]*CFBundleIconFile[\t\n\f\r ]*<\/key>[\t\n\f\r ]*)<string>[^<]*<\/string>/g;
  if (keyRe.test(xml)) {
    keyRe.lastIndex = 0;
    return xml.replace(keyRe, (m, key) => key + '<string>' + name + '</string>');
  }
  const i = xml.indexOf('<dict>');
  if (i < 0) throw new Error('Info.plist has no <dict> to add the icon to.');
  return xml.slice(0, i + 6) + '\n\t<key>CFBundleIconFile</key><string>' + name + '</string>' + xml.slice(i + 6);
}

// Put the .icns into the .app of a readInstaller() zip and point
// Info.plist at it. Mutates info.entries.
export async function setMacIcon(info, icnsBytes) {
  const iconName = 'AppIcon';
  const icnsPath = info.app + 'Contents/Resources/' + iconName + '.icns';
  const plistPath = info.app + 'Contents/Info.plist';
  const plist = info.entries.find((e) => e.name === plistPath);
  if (!plist) throw new Error('This .app has no Info.plist.');
  const xml = new TextDecoder().decode(await zipEntryData(plist));
  const newPlist = await zipNewEntry(plistPath, setPlistIcon(xml, iconName));
  // Rewritten, so recompressed; its mode and time are kept (as Go's MacZip).
  for (const k of ['madeBy', 'extAttr', 'time', 'date']) newPlist[k] = plist[k];
  info.entries = info.entries.filter((e) => e.name !== plistPath && e.name !== icnsPath);
  info.entries.push(newPlist, await zipNewEntry(icnsPath, icnsBytes));
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
