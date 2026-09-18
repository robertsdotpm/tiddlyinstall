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
// on the site pages, and inlined into the one-file site by
// tools/build_site.py), falling back to cdn.jsdelivr.net/npm. So the
// standalone page never reaches the network.
//
// PNG encoding is done here in JS (a canvas encoder is skipped) so the output
// is byte-for-byte deterministic and the tests are reliable.
import { toBytes, peInfo, peChecksum, sha256Hex, kvSet, crc32, deflateRaw, zipEntryData, zipNewEntry } from './ibfile.js';

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
// source without needing the browser's image decoder. PNGs are decoded and
// scaled here in JS (pngDecode, resizeRGBA), so the build server and the
// browser make the same bytes; anything else (SVG) needs the browser.
export async function rasterSource(bytes) {
  const u8 = toBytes(bytes);
  if (isPng(u8)) {
    const img = await pngDecode(u8);
    return { raster: (size) => resizeRGBA(img, size), close() {} };
  }
  if (typeof createImageBitmap !== 'function') throw new Error('The icon must be a PNG.');
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
// pixels and at most 1 MB. The header is read before anything is decoded.
export function checkIconPng(bytes) {
  const u8 = toBytes(bytes);
  if (!u8.length) throw new Error('the icon is empty');
  if (u8.length > ICON_MAX_BYTES) throw new Error('the icon is over ' + (ICON_MAX_BYTES >> 10) + ' KB');
  if (!isPng(u8) || u8.length < 33) throw new Error('the icon must be a PNG');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const w = dv.getUint32(16), h = dv.getUint32(20);
  if (w !== h) throw new Error('the icon must be square (it is ' + w + 'x' + h + ')');
  if (w < ICON_MIN || w > ICON_MAX) throw new Error('the icon must be ' + ICON_MIN + ' to ' + ICON_MAX + ' pixels across (it is ' + w + ')');
}

async function inflateZlib(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

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
    if (data.length !== len) throw new Error('the icon isn\'t a valid PNG');
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
