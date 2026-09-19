// Reading and writing installer metadata in the browser (docs/format.md).
//
//   Windows .exe  [base][record][plan][pack][64-byte footer]  (ends before a
//                 certificate table if the PE has one, after up to 7 NULs)
//   Linux .run    the same block at the end of the file
//   macOS .zip    <X>.app/Contents/Resources/ib/{record.txt,plan.txt,pack/<sha256>}
//
// Pack: ustar tar whose members are named by the lowercase hex SHA-256 of
// their content. Zip (de)compression and SHA-256 go through js/zlib.js and
// js/cryptox.js: the browser's own where it has them, else plain JavaScript.
import { inflate as zInflate, deflate as zDeflate } from './zlib.js';
import { digest } from './cryptox.js';

const ibEnc = new TextEncoder();
const ibDec = new TextDecoder();

export const FOOTER_LEN = 64;
const FOOTER_MAGIC = 'IBMETA1 ';
const MAX12 = 999999999999;

/* ---------- small helpers ---------- */

export function toBytes(x) {
  if (x == null) return new Uint8Array(0);
  if (typeof x === 'string') return ibEnc.encode(x);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (ArrayBuffer.isView(x)) return new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  throw new TypeError('not bytes');
}

export function concatBytes(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function bytesToHex(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
  return s;
}

export function sha256(data) {
  return digest('SHA-256', toBytes(data));
}
export async function sha256Hex(data) {
  return bytesToHex(await sha256(data));
}

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
// RFC 4648 base32, lowercase, no padding.
export function base32(u8) {
  let out = '', bits = 0, val = 0;
  for (let i = 0; i < u8.length; i++) {
    val = (val << 8) | u8[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
    val &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

// The record's name: SHA-256 of its exact bytes, base32, 26 characters.
export async function recordHash(record) {
  return base32(await sha256(record)).slice(0, 26);
}

// Plans are signed by the backend (docs/format.md "Plan signature"): the signature is
// the last line, `sig<TAB>ed25519<TAB>...`, over every byte before it,
// and the plan's `record` line must name the record it installs.
export function stripPlanSig(plan) {
  const body = plan.replace(/\r?\n$/, '');
  const i = body.lastIndexOf('\n');
  const last = body.slice(i + 1);
  if (i < 0 || !(last === 'sig' || last.startsWith('sig\t'))) return plan;
  return body.slice(0, i + 1);
}

// Make an embedded plan fit an edited record: its header `record` line is
// set to the record's hash, and the signature, which no longer matches, is
// dropped. `edited` says the plan text itself was changed (its signature
// is then wrong too). An untouched plan for an untouched record keeps its
// exact bytes and its signature. Returns {plan, changed}.
export async function bindPlan(plan, record, edited = false) {
  if (!plan) return { plan, changed: false };
  const h = await recordHash(record);
  const lines = plan.split('\n');
  let changed = false, found = false;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (l === '[target]') break;
    if (l.startsWith('record\t')) {
      found = true;
      if (l !== 'record\t' + h) { lines[i] = 'record\t' + h; changed = true; }
      break;
    }
  }
  if (!found) { lines.splice(1, 0, 'record\t' + h); changed = true; }
  let out = lines.join('\n');
  if (changed || edited) {
    const stripped = stripPlanSig(out);
    changed = changed || stripped !== out;
    out = stripped;
  }
  return { plan: out, changed };
}

/* ---------- footer ---------- */

function pad12(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX12) throw new RangeError('length out of range: ' + n);
  return String(n).padStart(12, '0');
}

export function makeFooter(recordLen, planLen, packLen) {
  const s = (FOOTER_MAGIC + pad12(recordLen) + ' ' + pad12(planLen) + ' ' + pad12(packLen) + ' ')
    .padEnd(FOOTER_LEN - 1, ' ') + '\n';
  return ibEnc.encode(s);
}

// Looks for a footer ending at `end`. Returns {start, record, plan, pack}
// (lengths, and where the block starts) or null.
export function parseFooter(u8, end = u8.length) {
  if (end < FOOTER_LEN) return null;
  const f = u8.subarray(end - FOOTER_LEN, end);
  for (let i = 0; i < FOOTER_MAGIC.length; i++) if (f[i] !== FOOTER_MAGIC.charCodeAt(i)) return null;
  if (f[63] !== 10) return null;
  const nums = [];
  for (const off of [8, 21, 34]) {
    let n = 0;
    for (let i = 0; i < 12; i++) {
      const c = f[off + i];
      if (c < 48 || c > 57) return null;
      n = n * 10 + (c - 48);
    }
    if (f[off + 12] !== 32) return null;
    nums.push(n);
  }
  const [record, plan, pack] = nums;
  const start = end - FOOTER_LEN - record - plan - pack;
  if (start < 0) return null;
  return { start, end, record, plan, pack };
}

/* ---------- PE ---------- */

// Offsets we need in a PE header, or null if it isn't one.
export function peInfo(u8) {
  if (u8.length < 0x40 || u8[0] !== 0x4d || u8[1] !== 0x5a) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const pe = dv.getUint32(0x3c, true);
  if (pe + 24 > u8.length || dv.getUint32(pe, true) !== 0x00004550) return null;
  const opt = pe + 24;
  const magic = dv.getUint16(opt, true);
  let nDirsOff, dirs;
  if (magic === 0x10b) { nDirsOff = opt + 92; dirs = opt + 96; }
  else if (magic === 0x20b) { nDirsOff = opt + 108; dirs = opt + 112; }
  else return null;
  const info = { checksumOff: opt + 64, certDirOff: null, certOffset: 0, certSize: 0 };
  if (nDirsOff + 4 > u8.length) return info;
  const nDirs = dv.getUint32(nDirsOff, true);
  if (nDirs > 4 && dirs + 5 * 8 <= u8.length) {
    info.certDirOff = dirs + 4 * 8;
    info.certOffset = dv.getUint32(info.certDirOff, true);   // a file offset, not an RVA
    info.certSize = dv.getUint32(info.certDirOff + 4, true);
  }
  return info;
}

// The PE optional header checksum, as imagehlp's CheckSumMappedFile does it.
export function peChecksum(u8, checksumOff) {
  let sum = 0;
  const n = u8.length;
  const even = n & ~1;
  for (let i = 0; i < even; i += 2) {
    if (i === checksumOff || i === checksumOff + 2) continue;
    sum += u8[i] | (u8[i + 1] << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (n & 1) {
    sum += u8[n - 1];
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + n) >>> 0;
}

/* ---------- tar (ustar) ---------- */

function tarField(h, off, len, str) {
  for (let i = 0; i < len && i < str.length; i++) h[off + i] = str.charCodeAt(i);
}
function octal(n, width) {   // width includes the trailing NUL
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

// members: [{name, data: Uint8Array, mode?, dir?}] -> ustar bytes. A name
// over 100 bytes is split into ustar's prefix and name at a '/'.
export function tarWrite(members) {
  const parts = [];
  for (const m of members) {
    const data = m.dir ? new Uint8Array(0) : toBytes(m.data);
    if (data.length > 0o77777777777) throw new RangeError('tar member too large');
    let nameBytes = ibEnc.encode(m.name);
    let prefixBytes = null;
    if (nameBytes.length > 100) {
      const n = m.name;
      let cut = -1;
      for (let i = n.indexOf('/'); i >= 0; i = n.indexOf('/', i + 1)) {
        if (ibEnc.encode(n.slice(0, i)).length <= 155 && ibEnc.encode(n.slice(i + 1)).length <= 100) { cut = i; break; }
      }
      if (cut < 0) throw new RangeError('tar name too long: ' + m.name);
      prefixBytes = ibEnc.encode(n.slice(0, cut));
      nameBytes = ibEnc.encode(n.slice(cut + 1));
    }
    const h = new Uint8Array(512);
    h.set(nameBytes, 0);
    if (prefixBytes) h.set(prefixBytes, 345);
    tarField(h, 100, 8, octal(m.mode || 0o644, 8));
    tarField(h, 108, 8, octal(0, 8));
    tarField(h, 116, 8, octal(0, 8));
    tarField(h, 124, 12, octal(data.length, 12));
    tarField(h, 136, 12, octal(m.mtime || 0, 12));
    tarField(h, 148, 8, '        ');
    h[156] = m.dir ? 0x35 : 0x30;        // '5' folder, '0' regular file
    tarField(h, 257, 6, 'ustar\0');
    tarField(h, 263, 2, '00');
    tarField(h, 329, 8, octal(0, 8));    // devmajor, devminor: as Go's archive/tar
    tarField(h, 337, 8, octal(0, 8));    // writes them, so packs match byte for byte
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    tarField(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    parts.push(h, data);
    const padLen = (512 - (data.length % 512)) % 512;
    if (padLen) parts.push(new Uint8Array(padLen));
  }
  parts.push(new Uint8Array(1024));
  return concatBytes(parts);
}

function readStr(u8, off, len) {
  let end = off;
  while (end < off + len && u8[end] !== 0) end++;
  return ibDec.decode(u8.subarray(off, end));
}

// ustar bytes -> [{name, data}] (regular files only; data are views)
export function tarRead(u8) {
  const out = [];
  let o = 0;
  while (o + 512 <= u8.length) {
    const h = u8.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 32 : h[i];
    const want = parseInt(readStr(h, 148, 8).trim(), 8);
    if (sum !== want) throw new Error('tar header checksum mismatch at ' + o);
    let name = readStr(h, 0, 100);
    const prefix = readStr(h, 345, 155);
    if (prefix && readStr(h, 257, 6).startsWith('ustar')) name = prefix + '/' + name;
    const size = parseInt(readStr(h, 124, 12).trim() || '0', 8);
    const type = h[156];
    o += 512;
    if (o + size > u8.length) throw new Error('tar member runs past the end');
    if (type === 0x30 || type === 0) {
      // Pack members are named by the lowercase hex SHA-256 of their content
      // (docs/format.md section 4). Refuse anything else: a crafted name is
      // untrusted attacker text that must never be treated as markup or a path.
      if (!/^[0-9a-f]{64}$/.test(name)) throw new Error('pack member has a non-hash name: ' + JSON.stringify(name.slice(0, 80)));
      out.push({ name, data: u8.subarray(o, o + size) });
    }
    o += Math.ceil(size / 512) * 512;
  }
  return out;
}

// A pack member for some bytes: named by their SHA-256.
export async function packMember(data) {
  data = toBytes(data);
  return { name: await sha256Hex(data), data };
}

/* ---------- records ---------- */

// Parses `key<TAB>value...` text. Keeps comments and unknown keys so a
// round trip only changes what was edited.
export function parseKv(text) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.map((raw) => {
    const line = raw.replace(/\r$/, '');
    if (line === '' || line.startsWith('#')) return { raw: line };
    const f = line.split('\t');
    return { key: f[0], values: f.slice(1) };
  });
}

export function serializeKv(entries) {
  return entries.map((e) => (e.key === undefined ? e.raw : [e.key, ...e.values].join('\t'))).join('\n') + '\n';
}

export function kvGet(entries, key) {
  const e = entries.find((x) => x.key === key);
  return e ? e.values : null;
}

// Sets (or, with values null, removes) the first line with this key.
// Values lose any tab or newline, which the format can't carry.
export function kvSet(entries, key, values) {
  const i = entries.findIndex((x) => x.key === key);
  if (values == null) {
    if (i >= 0) entries.splice(i, 1);
    return entries;
  }
  values = values.map((v) => String(v).replace(/[\t\r\n]+/g, ' '));
  if (i >= 0) entries[i].values = values;
  else entries.push({ key, values });
  return entries;
}

export function newRecordText(fields = {}) {
  const e = [{ key: 'ib-record', values: ['1'] }];
  for (const [k, v] of Object.entries(fields)) kvSet(e, k, Array.isArray(v) ? v : [v]);
  return serializeKv(e);
}

/* ---------- zip ---------- */

let crcTable = null;
export function crc32(u8) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = crcTable[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function inflateRaw(u8) { return zInflate(u8, 'deflate-raw'); }
export function deflateRaw(u8) { return zDeflate(u8, 'deflate-raw'); }

const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFLNK = 0o120000, S_IFREG = 0o100000;

// Entries: {name, method, flags, crc, csize, usize, time, date,
//   madeBy, extAttr, localExtra, centralExtra, comment, raw (compressed bytes)}
// plus helpers: entry.unixMode, isDir, isSymlink.
export function zipRead(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  let p = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || p === 0xffffffff || cdSize === 0xffffffff) throw new Error('zip64 is not supported');
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory entry');
    const e = {
      madeBy: dv.getUint16(p + 4, true),
      needed: dv.getUint16(p + 6, true),
      flags: dv.getUint16(p + 8, true),
      method: dv.getUint16(p + 10, true),
      time: dv.getUint16(p + 12, true),
      date: dv.getUint16(p + 14, true),
      crc: dv.getUint32(p + 16, true),
      csize: dv.getUint32(p + 20, true),
      usize: dv.getUint32(p + 24, true),
      intAttr: dv.getUint16(p + 36, true),
      extAttr: dv.getUint32(p + 38, true),
    };
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    e.nameBytes = u8.slice(p + 46, p + 46 + nl);
    e.name = ibDec.decode(e.nameBytes);
    e.centralExtra = u8.slice(p + 46 + nl, p + 46 + nl + xl);
    e.comment = u8.slice(p + 46 + nl + xl, p + 46 + nl + xl + cl);
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('bad local header for ' + e.name);
    const lnl = dv.getUint16(lho + 26, true), lxl = dv.getUint16(lho + 28, true);
    e.localExtra = u8.slice(lho + 30 + lnl, lho + 30 + lnl + lxl);
    const dataStart = lho + 30 + lnl + lxl;
    e.raw = u8.subarray(dataStart, dataStart + e.csize);
    entries.push(e);
    p += 46 + nl + xl + cl;
  }
  return entries;
}

export function zipUnixMode(e) {
  return (e.madeBy >>> 8) === 3 ? (e.extAttr >>> 16) : 0;
}
export function zipIsDir(e) {
  return e.name.endsWith('/') || (zipUnixMode(e) & S_IFMT) === S_IFDIR;
}
export function zipIsSymlink(e) {
  return (zipUnixMode(e) & S_IFMT) === S_IFLNK;
}

export async function zipEntryData(e) {
  if (e.flags & 1) throw new Error('encrypted zip entries are not supported');
  if (e.method === 0) return e.raw;
  if (e.method === 8) return inflateRaw(e.raw);
  throw new Error('unsupported zip method ' + e.method + ' for ' + e.name);
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// A new entry. kind: 'file' | 'dir' | 'symlink' (data = link target).
export async function zipNewEntry(name, data, { mode, kind = 'file', compress = true } = {}) {
  const t = dosTime(new Date());
  let type = S_IFREG, perm = mode == null ? 0o644 : mode;
  if (kind === 'dir') { type = S_IFDIR; perm = mode == null ? 0o755 : mode; if (!name.endsWith('/')) name += '/'; data = new Uint8Array(0); }
  if (kind === 'symlink') { type = S_IFLNK; perm = 0o755; compress = false; }
  data = toBytes(data);
  let raw = data, method = 0;
  if (compress && data.length > 64) {
    const d = await deflateRaw(data);
    if (d.length < data.length) { raw = d; method = 8; }
  }
  const nameBytes = ibEnc.encode(name);
  const utf8 = /[^\x20-\x7e]/.test(name);
  return {
    madeBy: (3 << 8) | 20, needed: 20, flags: utf8 ? 0x800 : 0, method, time: t.time, date: t.date,
    crc: crc32(data), csize: raw.length, usize: data.length, intAttr: 0,
    extAttr: (((type | perm) << 16) | (kind === 'dir' ? 0x10 : 0)) >>> 0,
    nameBytes, name, centralExtra: new Uint8Array(0), localExtra: new Uint8Array(0),
    comment: new Uint8Array(0), raw,
  };
}

// Writes entries as a zip. Existing entries' compressed bytes are copied as
// they are, so permissions, symlinks and timestamps survive untouched.
export function zipWrite(entries, comment = new Uint8Array(0)) {
  const parts = [];
  const central = [];
  let off = 0;
  for (const e of entries) {
    const flags = e.flags & ~0x0008;    // sizes are known: no data descriptor
    const lh = new Uint8Array(30 + e.nameBytes.length + e.localExtra.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, e.needed, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, e.method, true);
    lv.setUint16(10, e.time, true);
    lv.setUint16(12, e.date, true);
    lv.setUint32(14, e.crc, true);
    lv.setUint32(18, e.csize, true);
    lv.setUint32(22, e.usize, true);
    lv.setUint16(26, e.nameBytes.length, true);
    lv.setUint16(28, e.localExtra.length, true);
    lh.set(e.nameBytes, 30);
    lh.set(e.localExtra, 30 + e.nameBytes.length);
    if (off + lh.length + e.raw.length > 0xffffffff) throw new Error('zip larger than 4 GB is not supported');
    parts.push(lh, e.raw);

    const ch = new Uint8Array(46 + e.nameBytes.length + e.centralExtra.length + e.comment.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, e.madeBy, true);
    cv.setUint16(6, e.needed, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, e.method, true);
    cv.setUint16(12, e.time, true);
    cv.setUint16(14, e.date, true);
    cv.setUint32(16, e.crc, true);
    cv.setUint32(20, e.csize, true);
    cv.setUint32(24, e.usize, true);
    cv.setUint16(28, e.nameBytes.length, true);
    cv.setUint16(30, e.centralExtra.length, true);
    cv.setUint16(32, e.comment.length, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, e.intAttr, true);
    cv.setUint32(38, e.extAttr, true);
    cv.setUint32(42, off, true);
    ch.set(e.nameBytes, 46);
    ch.set(e.centralExtra, 46 + e.nameBytes.length);
    ch.set(e.comment, 46 + e.nameBytes.length + e.centralExtra.length);
    central.push(ch);
    off += lh.length + e.raw.length;
  }
  const cd = concatBytes(central);
  const end = new Uint8Array(22 + comment.length);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, off, true);
  ev.setUint16(20, comment.length, true);
  end.set(comment, 22);
  return concatBytes([...parts, cd, end]);
}

/* ---------- installers ---------- */

export function detectKind(u8, name = '') {
  const n = name.toLowerCase();
  if (u8.length >= 2 && u8[0] === 0x4d && u8[1] === 0x5a) return 'exe';
  if (u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5)) return 'zip';
  if (n.endsWith('.exe')) return 'exe';
  if (n.endsWith('.zip')) return 'zip';
  return 'run';
}

// Opens an installer. Returns an object for writeInstaller():
//   {kind, name, record (string|null), plan (string|null),
//    pack: [{name, data}], signed (bool), signedWhy (text), base / zip data}
export async function readInstaller(input, name = '') {
  const u8 = toBytes(input);
  const kind = detectKind(u8, name);
  if (kind === 'zip') return readMacZip(u8, name);

  const info = { kind, name, record: null, plan: null, pack: [], signed: false, signedWhy: '', pe: null, hadBlock: false };
  let end = u8.length;
  if (kind === 'exe') {
    const pe = peInfo(u8);
    info.pe = pe;
    if (pe && pe.certOffset && pe.certSize && pe.certOffset <= u8.length) {
      info.signed = true;
      info.signedWhy = 'This file has an Authenticode signature. Saving it removes the signature; sign it again afterwards (mode B) or ship it unsigned.';
      end = pe.certOffset;
    }
  }
  // Signing tools pad to 8 bytes before the certificate table.
  let f = null;
  for (let k = 0; k <= 7 && end - k >= FOOTER_LEN; k++) {
    f = parseFooter(u8, end - k);
    if (f) break;
    if (u8[end - k - 1] !== 0) break;
  }
  if (f) {
    info.hadBlock = true;
    let o = f.start;
    info.base = u8.subarray(0, f.start);
    info.record = ibDec.decode(u8.subarray(o, o += f.record));
    info.plan = f.plan ? ibDec.decode(u8.subarray(o, o += f.plan)) : null;
    info.pack = f.pack ? tarRead(u8.subarray(o, o + f.pack)) : [];
  } else {
    info.base = u8.subarray(0, end);
  }
  return info;
}

// Finds `<X>.app/` in a zip's names.
function appPrefix(entries) {
  for (const e of entries) {
    const m = /^(.*?[^/]+\.app\/)Contents\//.exec(e.name);
    if (m) return m[1];
  }
  return null;
}

async function readMacZip(u8, name) {
  const entries = zipRead(u8);
  const app = appPrefix(entries);
  if (!app) throw new Error('This zip has no .app inside, so it is not a macOS installer from this site.');
  const ib = app + 'Contents/Resources/ib/';
  const info = { kind: 'zip', name, entries, app, record: null, plan: null, pack: [], signed: false, signedWhy: '', hadBlock: false };
  if (entries.some((e) => e.name.startsWith(app + 'Contents/_CodeSignature/'))) {
    info.signed = true;
    info.signedWhy = 'The app in this zip is code-signed. Saving removes that signature (macOS treats a broken signature as damaged, which is worse than unsigned); sign it again if you publish it.';
  }
  for (const e of entries) {
    if (!e.name.startsWith(ib) || zipIsDir(e)) continue;
    const rel = e.name.slice(ib.length);
    if (rel === 'record.txt') { info.record = ibDec.decode(await zipEntryData(e)); info.hadBlock = true; }
    else if (rel === 'plan.txt') info.plan = ibDec.decode(await zipEntryData(e));
    else if (/^pack\/[0-9a-f]{64}$/.test(rel)) info.pack.push({ name: rel.slice(5), data: await zipEntryData(e) });
  }
  return info;
}

// Builds the edited installer. `edits` = {record, plan, pack}; anything left
// out keeps the value read from the file. Returns a Uint8Array.
export async function writeInstaller(info, edits = {}) {
  const record = toBytes(edits.record !== undefined ? edits.record : info.record);
  const planText = edits.plan !== undefined ? edits.plan : info.plan;
  const plan = toBytes(planText || '');
  const pack = edits.pack !== undefined ? edits.pack : info.pack;
  if (!record.length) throw new Error('The installer needs a record.');

  if (info.kind === 'zip') return writeMacZip(info, record, plan, pack);

  let base = info.base;
  if (info.kind === 'exe' && info.signed && info.pe && info.pe.certDirOff != null) {
    base = base.slice();
    base.fill(0, info.pe.certDirOff, info.pe.certDirOff + 8);   // drop the certificate entry
  }
  const packBytes = pack.length ? tarWrite(pack) : new Uint8Array(0);
  const out = concatBytes([base, record, plan, packBytes, makeFooter(record.length, plan.length, packBytes.length)]);
  if (info.kind === 'exe' && info.pe) {
    const dv = new DataView(out.buffer);
    // Only keep a checksum up to date if the base had one; 0 means "none".
    if (dv.getUint32(info.pe.checksumOff, true) !== 0) {
      dv.setUint32(info.pe.checksumOff, peChecksum(out, info.pe.checksumOff), true);
    }
  }
  return out;
}

async function writeMacZip(info, record, plan, pack) {
  const ib = info.app + 'Contents/Resources/ib/';
  // Changing the app breaks its signature, and macOS calls an app with a
  // broken signature "damaged" (worse than unsigned), so drop the old one.
  const sig = info.app + 'Contents/_CodeSignature/';
  const kept = info.entries.filter((e) => !e.name.startsWith(ib) && !e.name.startsWith(sig));
  const add = [];
  add.push(await zipNewEntry(ib, null, { kind: 'dir' }));
  add.push(await zipNewEntry(ib + 'record.txt', record));
  if (plan.length) add.push(await zipNewEntry(ib + 'plan.txt', plan));
  if (pack.length) {
    add.push(await zipNewEntry(ib + 'pack/', null, { kind: 'dir' }));
    for (const m of pack) add.push(await zipNewEntry(ib + 'pack/' + m.name, m.data));
  }
  return zipWrite(kept.concat(add));
}

export function installerExt(kind) {
  return kind === 'exe' ? '.exe' : kind === 'zip' ? '.zip' : '.run';
}
