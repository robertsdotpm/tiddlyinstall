// Files: serving them as Go's http.FileServer / ServeFile do (Range,
// Last-Modified, no directory listings), writing them atomically, streaming
// installers with large packs to disk, and reading tar names as Go's
// archive/tar does.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { makeFooter, parseFooter } from '../../shared/tifile.js';

/* ---------- answers ---------- */

// http.Error: text/plain, the message and a newline.
export function httpError(res, msg, status) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
  res.end(msg + '\n');
}

// http.NotFound
export function notFound(res) {
  httpError(res, '404 page not found', 404);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/vnd.microsoft.icon', '.gif': 'image/gif',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8', '.pdf': 'application/pdf', '.wasm': 'application/wasm',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed', '.xz': 'application/x-xz', '.bz2': 'application/x-bzip2',
  '.exe': 'application/x-msdos-program', '.msi': 'application/x-msi', '.deb': 'application/vnd.debian.binary-package',
  '.rpm': 'application/x-redhat-package-manager', '.dmg': 'application/x-apple-diskimage', '.pkg': 'application/octet-stream',
  '.sh': 'text/x-sh; charset=utf-8', '.run': 'application/octet-stream',
};

function contentType(p, fd) {
  const t = TYPES[path.extname(p).toLowerCase()];
  if (t) return t;
  // http.DetectContentType, simplified: text or binary.
  const buf = Buffer.alloc(512);
  let n = 0;
  try { n = fs.readSync(fd, buf, 0, 512, 0); } catch (e) { /* unreadable: binary */ }
  const head = buf.subarray(0, n);
  if (head.subarray(0, 5).toString('latin1').toLowerCase() === '<html' || head.subarray(0, 14).toString('latin1').toLowerCase() === '<!doctype html') return 'text/html; charset=utf-8';
  for (const b of head) if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) return 'application/octet-stream';
  return 'text/plain; charset=utf-8';
}

function parseRange(h, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m) return h && /^bytes=/.test(h) && !h.includes(',') ? 'bad' : null;
  let start, end;
  if (m[1] === '') {
    if (m[2] === '') return 'bad';
    const n = Number(m[2]);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return 'bad';
    if (start >= size) return 'bad';
  }
  return { start, end };
}

// serveFile sends a file with Content-Length, Last-Modified, Accept-Ranges
// and one byte range (ServeContent's single-range case; a multi-range
// request gets the whole file). `headers` are set first; a Content-Type
// among them is kept. Answers 404 when the file is missing or a folder.
export async function serveFile(req, res, p, headers = {}) {
  let fd;
  try {
    fd = fs.openSync(p, 'r');
  } catch (e) {
    return notFound(res);
  }
  let st;
  try {
    st = fs.fstatSync(fd);
    if (!st.isFile()) { fs.closeSync(fd); return notFound(res); }
  } catch (e) {
    fs.closeSync(fd);
    return notFound(res);
  }
  const h = Object.assign({}, headers);
  if (!h['Content-Type']) h['Content-Type'] = contentType(p, fd);
  const mtime = new Date(Math.floor(st.mtimeMs / 1000) * 1000);
  h['Last-Modified'] = mtime.toUTCString();
  h['Accept-Ranges'] = 'bytes';
  const ims = req.headers['if-modified-since'];
  if (ims && !req.headers['if-none-match'] && (req.method === 'GET' || req.method === 'HEAD')) {
    const t = Date.parse(ims);
    if (!Number.isNaN(t) && mtime.getTime() <= t) {
      fs.closeSync(fd);
      delete h['Content-Type'];
      res.writeHead(304, h);
      return res.end();
    }
  }
  let start = 0, end = st.size - 1, status = 200;
  const r = st.size > 0 ? parseRange(req.headers.range, st.size) : null;
  if (r === 'bad') {
    fs.closeSync(fd);
    res.writeHead(416, { 'Content-Range': 'bytes */' + st.size, 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    return res.end('invalid range: failed to overlap\n');
  }
  if (r) {
    ({ start, end } = r);
    status = 206;
    h['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
  }
  h['Content-Length'] = String(st.size === 0 ? 0 : end - start + 1);
  res.writeHead(status, h);
  if (req.method === 'HEAD' || st.size === 0) {
    fs.closeSync(fd);
    return res.end();
  }
  try {
    await pipeline(fs.createReadStream(null, { fd, start, end, autoClose: true }), res);
  } catch (e) { /* the client went away */ }
}

// A folder served as Go's http.FileServer(http.Dir(root)) behind noDirs:
// `rel` is the request path under the folder, already cleaned and
// decoded. Folders are never listed: a folder without its trailing slash
// is redirected to one (as FileServer does), which noDirs then refuses.
export async function serveDir(req, res, root, rel, { index = false, headers = {} } = {}) {
  if (rel === '' || (rel.endsWith('/') && !(index && rel === '/'))) return notFound(res);
  if (rel.includes('\0')) return notFound(res);
  if (rel.endsWith('/index.html')) {
    // FileServer sends .../index.html to ./
    res.writeHead(301, { Location: './' });
    return res.end();
  }
  // http.Dir: path.Clean("/" + name) under the root, so ".." can't leave it.
  const base = path.resolve(root);
  let p = path.join(base, path.posix.normalize('/' + rel));
  if (p !== base && !p.startsWith(base + path.sep)) return notFound(res);
  let st;
  try { st = fs.statSync(p); } catch (e) { return notFound(res); }
  if (st.isDirectory()) {
    if (!rel.endsWith('/')) {
      const q = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      res.writeHead(301, { Location: path.posix.basename(rel) + '/' + q });
      return res.end();
    }
    p = path.join(p, 'index.html');   // only the site's root gets here
  }
  return serveFile(req, res, p, headers);
}

// http.Redirect: the Location, and for GET a small HTML body.
export function redirect(req, res, url, status = 301) {
  const loc = url.replace(/[^\x00-\x7f]/g, (c) => encodeURIComponent(c));
  const h = { Location: loc };
  if (req.method === 'GET' || req.method === 'HEAD') h['Content-Type'] = 'text/html; charset=utf-8';
  res.writeHead(status, h);
  if (req.method !== 'GET') return res.end();
  const esc = url.replace(/[&'<>"]/g, (c) => ({ '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '"': '&#34;' }[c]));
  res.end('<a href="' + esc + '">' + (status === 301 ? 'Moved Permanently' : 'Found') + '</a>.\n\n');
}

/* ---------- writing ---------- */

// WriteAtomic: via a temporary name.
export async function writeAtomic(p, data) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, p);
}

export async function sha256File(p) {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const c of fs.createReadStream(p)) { h.update(c); size += c.length; }
  return { sha256: h.digest('hex'), size };
}

const enc = new TextEncoder();

function octal(n, width) {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

// One ustar header as Go's archive/tar writes it (src/shared/tifile.js tarWrite).
export function ustarHeader(name, size, mode = 0o644) {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 'latin1');
  h.write(octal(0, 8), 108, 'latin1');
  h.write(octal(0, 8), 116, 'latin1');
  h.write(octal(size, 12), 124, 'latin1');
  h.write(octal(0, 12), 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h[156] = 0x30;
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  h.write(octal(0, 8), 329, 'latin1');
  h.write(octal(0, 8), 337, 'latin1');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return h;
}

// The PE optional header checksum over a whole file (imagehlp's
// CheckSumMappedFile, as src/shared/tifile.js peChecksum), streamed.
async function peChecksumFile(p, checksumOff) {
  let sum = 0, pos = 0, carry = null;
  const add = (w, at) => {
    if (at === checksumOff || at === checksumOff + 2) return;
    sum += w;
    sum = (sum & 0xffff) + (sum >>> 16);
  };
  for await (let c of fs.createReadStream(p, { highWaterMark: 1 << 20 })) {
    let i = 0;
    if (carry !== null) {
      add(carry | (c[0] << 8), pos - 1);
      carry = null;
      i = 1;
    }
    for (; i + 1 < c.length; i += 2) add(c[i] | (c[i + 1] << 8), pos + i);
    if (i < c.length) carry = c[i];
    pos += c.length;
  }
  if (carry !== null) {
    sum += carry;
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + pos) >>> 0;
}

// writeInstallerFile streams base, record, plan, a pack of files (a ustar
// tar named by SHA-256, from `path` or `data`) and the footer to `out`
// (docs/format.md section 4), via a temporary file, then sets the PE
// checksum when asked. Returns {sha256, size}.
export async function writeInstallerFile(out, layout) {
  const { base, record, plan, pack, fixChecksum, checksumOff } = layout;
  if (parseFooter(base)) throw new Error('base already has a metadata block');
  await fsp.mkdir(path.dirname(out), { recursive: true });
  const tmp = path.join(path.dirname(out), '.build-' + crypto.randomBytes(6).toString('hex'));
  const h = crypto.createHash('sha256');
  const fh = await fsp.open(tmp, 'w');
  let size = 0;
  const write = async (b) => {
    if (!b.length) return;
    await fh.write(b);
    if (!fixChecksum) h.update(b);
    size += b.length;
  };
  try {
    await write(base);
    await write(record);
    await write(plan);
    let packLen = 0;
    if (pack.length) {
      for (const m of pack) {
        let n = 0;
        await write(ustarHeader(m.name, m.size));
        if (m.data) {
          await write(m.data);
          n = m.data.length;
        } else {
          for await (const c of fs.createReadStream(m.path, { highWaterMark: 1 << 20 })) {
            n += c.length;
            if (n > m.size) throw new Error('pack: ' + m.name + ' is larger than its size');
            await write(c);
          }
        }
        if (n !== m.size) throw new Error(`pack: wrote ${n} of ${m.size} bytes of ${m.name}`);
        const pad = (512 - (m.size % 512)) % 512;
        if (pad) await write(Buffer.alloc(pad));
        packLen += 512 + m.size + pad;
      }
      await write(Buffer.alloc(1024));
      packLen += 1024;
    }
    await write(makeFooter(record.length, plan.length, packLen));
    await fh.close();
    if (fixChecksum) {
      // The block changed the file, so the checksum is made over all of it.
      const sum = await peChecksumFile(tmp, checksumOff);
      const f = await fsp.open(tmp, 'r+');
      const b = Buffer.alloc(4);
      b.writeUInt32LE(sum);
      await f.write(b, 0, 4, checksumOff);
      await f.close();
      const s = await sha256File(tmp);
      await fsp.rename(tmp, out);
      return s;
    }
    await fsp.rename(tmp, out);
    return { sha256: h.digest('hex'), size };
  } catch (e) {
    try { await fh.close(); } catch (e2) { /* closed */ }
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/* ---------- reading tar names, as Go's archive/tar ---------- */

function cstr(b, off, len) {
  let end = off;
  while (end < off + len && b[end] !== 0) end++;
  return b.subarray(off, end).toString('utf8');
}

function parseNum(b, off, len) {
  if (b[off] & 0x80) {   // base-256
    let n = 0;
    for (let i = off; i < off + len; i++) n = n * 256 + (i === off ? b[i] & 0x7f : b[i]);
    return n;
  }
  const s = cstr(b, off, len).trim();
  if (s === '') return 0;
  if (!/^[0-7]+$/.test(s)) return NaN;
  return parseInt(s, 8);
}

function paxRecords(data) {
  const out = {};
  let s = data.toString('utf8');
  while (s.length) {
    const sp = s.indexOf(' ');
    if (sp < 0) break;
    const n = parseInt(s.slice(0, sp), 10);
    if (!(n > 0)) break;
    const rec = Buffer.from(s, 'utf8').subarray(0, n).toString('utf8');
    const kv = rec.slice(sp + 1, rec.length - 1);
    const eq = kv.indexOf('=');
    if (eq > 0) out[kv.slice(0, eq)] = kv.slice(eq + 1);
    s = Buffer.from(s, 'utf8').subarray(n).toString('utf8');
  }
  return out;
}

// The headers tar.Reader.Next returns for a gzipped tar, stopping at the
// first error as build.tarNames does: PAX ('x') and GNU long-name ('L',
// 'K') headers apply to the next entry; a PAX global header ('g') is
// returned itself, as Go does.
export function gzTarNames(gz) {
  let b;
  try {
    b = zlib.gunzipSync(gz);
  } catch (e) {
    return null;
  }
  const out = [];
  let o = 0, pax = {}, longName = null;
  for (;;) {
    if (o + 512 > b.length) break;
    const h = b.subarray(o, o + 512);
    if (h.every((x) => x === 0)) break;
    let sum = 0, ssum = 0;
    for (let i = 0; i < 512; i++) {
      const v = i >= 148 && i < 156 ? 32 : h[i];
      sum += v;
      ssum += v > 127 ? v - 256 : v;
    }
    const want = parseNum(h, 148, 8);
    if (want !== sum && want !== ssum) break;
    const type = String.fromCharCode(h[156]);
    let size = parseNum(h, 124, 12);
    // A PAX size applies to the entry after the PAX header.
    if (!'xgLK'.includes(type) && pax.size !== undefined) size = Number(pax.size);
    if (!Number.isFinite(size) || size < 0) break;
    const dataStart = o + 512;
    const data = b.subarray(dataStart, dataStart + size);
    if (data.length < size && type !== '5') break;
    o = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') { pax = Object.assign(pax, paxRecords(data)); continue; }
    if (type === 'L') { longName = cstr(data, 0, data.length); continue; }
    if (type === 'K') continue;
    const magic = h.subarray(257, 263).toString('latin1');
    let name = cstr(h, 0, 100);
    if (magic === 'ustar\0') {
      const prefix = cstr(h, 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    if (longName !== null) name = longName;
    if (pax.path !== undefined) name = pax.path;
    out.push(name);
    pax = {};
    longName = null;
  }
  return out;
}

// build.tarNames: the names under the top folder.
export function tarNamesUnderTop(gz) {
  return (gzTarNames(gz) || []).map((n) => { const i = n.indexOf('/'); return i >= 0 ? n.slice(i + 1) : n; });
}

// build.topFolder: 1 when every entry is under one top folder, else 0.
export function topFolder(gz) {
  const names = gzTarNames(gz);
  if (!names) return 0;
  let top = '';
  for (const n of names) {
    const t = n.replace(/^\.\//, '').split('/')[0];
    if (top === '') top = t;
    else if (t !== top) return 0;
  }
  return top === '' ? 0 : 1;
}
