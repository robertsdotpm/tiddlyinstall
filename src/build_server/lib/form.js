// Plain HTML form posts (POST /submit, docs/api.md "Plain form posts"):
// application/x-www-form-urlencoded and multipart/form-data bodies, parsed
// to {fields: {name: [values]}, files: {name: {filename, type, data}}}.
// No dependencies. The body is already read (and capped) by the server.
//
// Only the parts a caller names in `keepFiles` keep their bytes; any other
// file part is dropped here (the New installer form sends only the icon,
// but a hand-made post could send anything).

export class BadForm extends Error {}

const MAX_FIELDS = 2000;

function add(fields, name, value) {
  if (!Object.prototype.hasOwnProperty.call(fields, name)) fields[name] = [];
  fields[name].push(value);
}

export function parseUrlencoded(buf) {
  const fields = Object.create(null);
  // URLSearchParams decodes + and %XX as UTF-8 (the page's charset, which
  // the forms ask for with accept-charset), and passes bad escapes through.
  let n = 0;
  for (const [k, v] of new URLSearchParams(buf.toString('utf8'))) {
    if (++n > MAX_FIELDS) throw new BadForm('too many fields');
    add(fields, k, v);
  }
  return { fields, files: Object.create(null) };
}

// The boundary from a Content-Type header, or null.
export function boundaryOf(contentType) {
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;]{1,70}))/i.exec(contentType || '');
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function param(header, name) {
  // name="value" or a bare token. Browsers send backslashes as they are
  // (old IE's whole Windows path) and a quote as %22 or \", so nothing
  // is unescaped: only the icon's bytes are used, never its file name.
  const re = new RegExp('(?:^|;)\\s*' + name + '\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))', 'i');
  const m = re.exec(header);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

export function parseMultipart(buf, boundary, { keepFiles = [] } = {}) {
  if (!boundary) throw new BadForm('no multipart boundary');
  const fields = Object.create(null), files = Object.create(null);
  const delim = Buffer.from('--' + boundary);
  const next = Buffer.from('\r\n--' + boundary);
  let i = buf.indexOf(delim);
  if (i < 0) throw new BadForm('no multipart boundary in the body');
  let n = 0;
  for (;;) {
    i += delim.length;
    if (buf[i] === 0x2d && buf[i + 1] === 0x2d) break;              // "--": the end
    if (buf[i] !== 0x0d || buf[i + 1] !== 0x0a) throw new BadForm('bad multipart body');
    i += 2;
    const he = buf.indexOf('\r\n\r\n', i);
    if (he < 0) throw new BadForm('truncated multipart body');
    const head = buf.toString('utf8', i, he);
    const start = he + 4;
    const end = buf.indexOf(next, start);
    if (end < 0) throw new BadForm('truncated multipart body');
    if (++n > MAX_FIELDS) throw new BadForm('too many fields');
    let disp = '', type = '';
    for (const line of head.split('\r\n')) {
      const c = line.indexOf(':');
      if (c < 0) continue;
      const k = line.slice(0, c).trim().toLowerCase(), v = line.slice(c + 1).trim();
      if (k === 'content-disposition') disp = v;
      else if (k === 'content-type') type = v;
    }
    const name = param(disp, 'name');
    const filename = param(disp, 'filename');
    const data = buf.subarray(start, end);
    if (name !== null) {
      if (filename !== null) {
        if (keepFiles.includes(name) && !files[name]) {
          // Old IE sends the whole path (C:\Documents and Settings\...\icon.png).
          files[name] = { filename: filename.replace(/^.*[\\/]/, ''), type, data: Buffer.from(data) };
        }
      } else {
        add(fields, name, data.toString('utf8'));
      }
    }
    i = end + 2;
  }
  return { fields, files };
}

// The body by its Content-Type; throws BadForm, or {unsupported: true} for
// another type.
export function parseForm(contentType, buf, opts) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/x-www-form-urlencoded') return parseUrlencoded(buf);
  if (ct === 'multipart/form-data') return parseMultipart(buf, boundaryOf(contentType), opts);
  const e = new BadForm('unsupported content type');
  e.unsupported = true;
  throw e;
}
