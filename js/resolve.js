// The plan resolver (docs/format.md section 3, design.md sections 1.2-1.7):
// a port of the Go server's catalog package (catalog.go, policy.go,
// support.go, version.go, prereq.go, package.go, resolve.go, summary.go,
// snapshot.go; retired 2026-09-19) and the parts of its ibtext it used.
// Plain ES module; runs in browsers and in Node 20+. Gzip and SHA-256 go
// through js/zlib.js and js/cryptox.js (native, else plain JavaScript).
//
// Plans are byte-identical to the Go resolver's (tests/resolve-test.mjs
// checks the 3,095 cases it answered, saved in tests/golden/). Everything
// is synchronous except what needs (de)compression or a digest: loadSnapshot,
// writeSnapshot, splitSnapshot, loading a lazy catalogue's runtimes
// (openCatalog, loadRuntimes), hash26 and hash12. resolve() needs Hash12 for
// the appid, so it has its own small SHA-256 (sha256 below) and stays
// synchronous; on a lazy catalogue, callers load what it needs first.
//
// Go semantics kept on purpose: map output sorted by UTF-8 byte order
// (cmpStr), strings.TrimSpace's space set, strconv.Atoi's strictness,
// fmt's %v and %q, strings.Replacer's argument-order matching, and RE2
// patterns from the policy and catalogue translated by goRegExp.

import { inflate, deflate } from './zlib.js';
import { digest } from './cryptox.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- Go helpers ---------- */

// Map lookups on parsed JSON: own properties only, so "constructor" or
// "__proto__" as a runtime id is just unknown.
function own(o, k) {
  return o != null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined;
}
const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : '');
const list = (v) => (Array.isArray(v) ? v : []);
const nz = (v, d) => (v != null ? v : d);        // v ?? d (d is evaluated either way)
const contains = (l, s) => list(l).includes(s);
const indexOf = (l, s) => list(l).indexOf(s);
const splitJoin = (s, a, b) => s.split(a).join(b); // strings.ReplaceAll

// The Go resolver recomputes everything per plan; these are pure functions
// of the loaded catalogue, so they are remembered per catalogue (treat one
// as read-only once loaded, except for its mirror settings).
function memo(cat, key, f) {
  let v = cat.memo.get(key);
  if (v === undefined) cat.memo.set(key, (v = f()));
  return v;
}

// sort.Strings / Go's < on strings: UTF-8 byte order, i.e. code point order.
function cmpStr(a, b) {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i), y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800) x += x <= 0xdfff ? 0x2000 : -0x800;
    if (y >= 0xd800) y += y <= 0xdfff ? 0x2000 : -0x800;
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

// unicode.IsSpace, for strings.TrimSpace and strings.Fields.
const SP = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const trimRe = new RegExp(`^[${SP}]+|[${SP}]+$`, 'g');
const fieldsRe = new RegExp(`[${SP}]+`);
const trimSpace = (s) => s.replace(trimRe, '');
const fields = (s) => trimSpace(s).split(fieldsRe).filter((x) => x !== '');

// strconv.Atoi, errors as 0 (the Go code ignores them); out of range clamps.
function atoi(s) {
  if (!/^[+-]?[0-9]+$/.test(s)) return 0;
  const n = Number(s);
  return Math.max(-9223372036854775808, Math.min(9223372036854775807, n));
}

// strings.ToLower (simple per-rune mapping, not JS's context-sensitive one).
function goLower(s) {
  if (/^[\x00-\x7f]*$/.test(s)) return s.toLowerCase();
  let out = '';
  for (const ch of s) {
    const l = ch === 'İ' ? 'i' : ch.toLowerCase();
    out += [...l].length === 1 ? l : ch;
  }
  return out;
}

// fmt.Sprint of a decoded JSON value.
function goSprint(v) {
  if (v == null) return '<nil>';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return goFloat(v);
  if (Array.isArray(v)) return '[' + v.map(goSprint).join(' ') + ']';
  return 'map[' + Object.keys(v).sort(cmpStr).map((k) => k + ':' + goSprint(v[k])).join(' ') + ']';
}


// unicode.IsGraphic without the space: letters, marks, numbers, punctuation
// and symbols. Engines without \p{...} in regular expressions (Firefox
// before 78, EdgeHTML) get a close approximation: everything but controls,
// format and separator characters, private use and noncharacters.
let GRAPHIC_RE = null;
try { GRAPHIC_RE = new RegExp('[\\p{L}\\p{M}\\p{N}\\p{P}\\p{S}]', 'u'); } catch (e) { /* approximated below */ }
function isGraphic(ch, r) {
  if (GRAPHIC_RE) return GRAPHIC_RE.test(ch);
  return r > 0x20 && !(r >= 0x7f && r <= 0xa0) && r !== 0xad && !(r >= 0x2000 && r <= 0x200f) &&
    !(r >= 0x2028 && r <= 0x202f) && !(r >= 0x205f && r <= 0x206f) && r !== 0x3000 && r !== 0xfeff &&
    !(r >= 0xe000 && r <= 0xf8ff) && !(r >= 0xfff0 && r <= 0xffff) && r < 0xf0000 && (r & 0xfffe) !== 0xfffe;
}

// strconv.FormatFloat(f, 'g', -1, 64), which is what %v does.
function goFloat(f) {
  if (Object.is(f, -0)) return '-0';
  const [m, e] = f.toExponential().split('e');
  const exp = Number(e);
  if (exp < -4 || exp >= 6) return m + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
  return String(f);
}

// fmt's %q (strconv.Quote).
export function goQuote(s) {
  let out = '"';
  for (let ch of s) {
    const r = ch.codePointAt(0);
    if (r >= 0xd800 && r <= 0xdfff) ch = '�';
    if (ch === '"' || ch === '\\') out += '\\' + ch;
    else if (r === 0x20 || isGraphic(ch, r)) out += ch;
    else {
      const esc = { 7: '\\a', 8: '\\b', 12: '\\f', 10: '\\n', 13: '\\r', 9: '\\t', 11: '\\v' }[r];
      const hex = (n, w) => n.toString(16).padStart(w, '0');
      out += esc || (r < 0x20 || r === 0x7f ? '\\x' + hex(r, 2) : r < 0x10000 ? '\\u' + hex(r, 4) : '\\U' + hex(r, 8));
    }
  }
  return out + '"';
}

// strings.NewReplacer(old1, new1, ...).Replace: at each position the first
// old string (in argument order) that matches wins.
export function replacer(...pairs) {
  const olds = [], news = [];
  for (let i = 0; i < pairs.length; i += 2) { olds.push(pairs[i]); news.push(pairs[i + 1]); }
  return (s) => {
    let out = '', i = 0;
    while (i < s.length) {
      const k = olds.findIndex((o) => o !== '' && s.startsWith(o, i));
      if (k < 0) { out += s[i++]; continue; }
      out += news[k];
      i += olds[k].length;
    }
    return out;
  };
}

// An RE2 pattern (Go regexp) as a JS RegExp. Covers the syntax RE2 and JS
// share, plus RE2's leading flags, (?P<name>, \A, \z, \Q..\E, [[:class:]],
// ASCII \s, and a . that stops only at \n. RE2 errors (lookaround,
// backreferences, unknown escapes) throw, as regexp.Compile fails.
const POSIX = {
  alnum: '0-9A-Za-z', alpha: 'A-Za-z', ascii: '\\x00-\\x7f', blank: '\\t ', cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9', graph: '!-~', lower: 'a-z', print: ' -~', punct: '!-/:-@[-`{-~', space: '\\t\\n\\v\\f\\r ',
  upper: 'A-Z', word: '0-9A-Za-z_', xdigit: '0-9A-Fa-f',
};
const reCache = new Map();
function goRegExp(src) {
  if (reCache.has(src)) {
    const r = reCache.get(src);
    if (r instanceof Error) throw r;
    return r;
  }
  try {
    const re = translateRE2(src);
    reCache.set(src, re);
    return re;
  } catch (e) {
    reCache.set(src, e);
    throw e;
  }
}
function translateRE2(src) {
  let flags = '', i = 0, out = '', inClass = false;
  const lead = /^\(\?([imsU]+)\)/.exec(src);
  if (lead) {
    if (lead[1].includes('U')) throw new Error('regexp: (?U) is not supported');
    flags = lead[1];
    i = lead[0].length;
  }
  const bad = (what) => { throw new Error('error parsing regexp: ' + what + ': `' + src + '`'); };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === undefined) bad('trailing backslash at end of expression');
      if (d === 'Q') {
        const end = src.indexOf('\\E', i + 2);
        const lit = end < 0 ? src.slice(i + 2) : src.slice(i + 2, end);
        out += lit.replace(/[\\^$.*+?()[\]{}|\/-]/g, '\\$&');
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      if (d === 's') out += inClass ? '\\t\\n\\f\\r ' : '[\\t\\n\\f\\r ]';
      else if (d === 'S' && !inClass) out += '[^\\t\\n\\f\\r ]';
      else if (d === 'A' && !inClass) out += '(?<![\\s\\S])';
      else if (d === 'z' && !inClass) out += '(?![\\s\\S])';
      else if (d === 'a') out += '\\x07';
      else if (/[dDwWtnfrv]/.test(d) || (/[bB]/.test(d) && !inClass)) out += '\\' + d;
      else if (d === 'x' && /^[0-9A-Fa-f]{2}/.test(src.slice(i + 2))) { out += src.slice(i, i + 4); i += 4; continue; }
      else if (/[0-9A-Za-z]/.test(d)) bad('invalid escape sequence: `\\' + d + '`');
      else out += '\\' + d;
      i += 2;
      continue;
    }
    if (inClass) {
      if (c === '[' && src[i + 1] === ':') {
        const end = src.indexOf(':]', i + 2);
        const cls = end < 0 ? undefined : POSIX[src.slice(i + 2, end)];
        if (cls === undefined) bad('invalid character class range');
        out += cls;
        i = end + 2;
        continue;
      }
      if (c === ']') inClass = false;
      out += c === '[' ? '\\[' : c;
      i++;
      continue;
    }
    if (c === '[') {
      inClass = true;
      out += '[';
      i++;
      if (src[i] === '^') { out += '^'; i++; }
      if (src[i] === ']') { out += '\\]'; i++; }
      continue;
    }
    if (c === '.') out += flags.includes('s') ? '[\\s\\S]' : '[^\\n]';
    else if (c === '(' && src[i + 1] === '?') {
      if (src.startsWith('(?:', i)) { out += '(?:'; i += 3; continue; }
      if (src.startsWith('(?P<', i)) { out += '(?<'; i += 4; continue; }
      bad('invalid or unsupported Perl syntax');
    } else out += c;
    i++;
  }
  if (inClass) bad('missing closing ]');
  return new RegExp(out, (flags.includes('i') ? 'i' : '') + (flags.includes('m') ? 'm' : ''));
}

/* ---------- hashes (ibtext.Hash26, Hash12) ---------- */

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';
function base32(bytes) {
  let out = '', bits = 0, acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(acc >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(acc << (5 - bits)) & 31];
  return out;
}

async function subtleSHA256(text) {
  const data = typeof text === 'string' ? enc.encode(text) : text;
  return digest('SHA-256', data);
}
// Hash26 names a record: SHA-256 of its exact bytes (a string is UTF-8).
export async function hash26(text) { return base32(await subtleSHA256(text)).slice(0, 26); }
// Hash12 names a folder (design.md 1.1).
export async function hash12(text) { return base32(await subtleSHA256(text)).slice(0, 12); }

// A synchronous SHA-256, so resolve() can write the appid without awaiting.
const K = [], H0 = [];
for (let n = 2; K.length < 64; n++) {
  let prime = true;
  for (let d = 2; d * d <= n; d++) if (n % d === 0) { prime = false; break; }
  if (!prime) continue;
  const frac = (x) => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
  if (H0.length < 8) H0.push(frac(Math.sqrt(n)));
  K.push(frac(Math.cbrt(n)));
}
function sha256(data) {
  const len = data.length, total = ((len + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, Math.floor(len / 2 ** 29));
  dv.setUint32(total - 4, (len << 3) >>> 0);
  const h = H0.slice(), w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(off + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15], b = w[t - 2];
      w[t] = w[t - 16] + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[t - 7] + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10));
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] = (h[i] + x) >>> 0; });
  }
  const out = new Uint8Array(32);
  h.forEach((x, i) => new DataView(out.buffer).setUint32(i * 4, x));
  return out;
}
const hash12Sync = (s) => base32(sha256(enc.encode(s))).slice(0, 12);

/* ---------- ibtext ---------- */

// ibtext.Writer
class Writer {
  constructor() { this.parts = []; }
  add(key, ...vals) {
    let line = key;
    for (const v of vals) line += '\t' + v.replace(/[\t\r\n]/g, ' ');
    this.parts.push(line + '\n');
  }
  raw(s) { this.parts.push(s); }
  toString() { return this.parts.join(''); }
}

// ibtext.Parse
function parseLines(doc) {
  const out = [];
  for (let raw of doc.split('\n')) {
    if (raw.endsWith('\r')) raw = raw.slice(0, -1);
    if (raw === '' || raw.startsWith('#')) continue;
    const parts = raw.split('\t');
    out.push({ key: parts[0], vals: parts.slice(1), val(i) { return (this.vals[i] != null ? this.vals[i] : ''); } });
  }
  return out;
}

/* ---------- versions (version.go) ---------- */

const preRe = /^[-_.~]?(a|b|c|rc|alpha|beta|pre|preview|dev)([-_.]?[0-9]|$)/;

// ParseVersion
function parseVersion(s) {
  const v = { parts: [], pre: false, raw: s };
  if (s.startsWith('v')) s = s.slice(1);
  if (s.startsWith('go')) s = s.slice(2);
  const ps = s.split('.');
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    let j = 0;
    while (j < p.length && p.charCodeAt(j) >= 48 && p.charCodeAt(j) <= 57) j++;
    const n = j > 0 ? atoi(p.slice(0, j)) : 0;
    if (j < p.length) {
      if (preRe.test(p.slice(j))) v.pre = true;
      if (j === 0 && i > 0) break;
    }
    v.parts.push(n);
    if (j < p.length) break;
  }
  return v;
}

// Cmp
function cmpVersion(a, b) {
  const n = Math.max(a.parts.length, b.parts.length);
  for (let i = 0; i < n; i++) {
    const x = (a.parts[i] != null ? a.parts[i] : 0), y = (b.parts[i] != null ? b.parts[i] : 0);
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre !== b.pre) return a.pre ? -1 : 1;
  return 0;
}

// Matches, with each spec parsed once.
const specCache = new Map();
function matches(v, spec) {
  let cs = specCache.get(spec);
  if (!cs) {
    if (specCache.size > 10000) specCache.clear();
    specCache.set(spec, (cs = compileSpec((spec != null ? spec : ''))));
  }
  return cs.every(([op, t, prefix]) => matchOne(v, op, t, prefix));
}

function compileSpec(spec) {
  const out = [];
  spec = trimSpace(spec);
  if (spec === '') return out;
  for (let c of spec.split(',')) {
    c = trimSpace(c);
    if (c === '') continue;
    let op = ['~=', '==', '!=', '>=', '<=', '>', '<'].find((o) => c.startsWith(o)) || '';
    if (op === '') op = '==';
    else c = trimSpace(c.slice(op.length));
    out.push(c.endsWith('.*') ? [op, null, parseVersion(c.slice(0, -2))] : [op, parseVersion(c), null]);
  }
  return out;
}

// matchOne; prefix is set for a target ending in .*
function matchOne(v, op, t, prefix) {
  if (prefix) {
    let inp = v.parts.length >= prefix.parts.length;
    for (let i = 0; i < prefix.parts.length && inp; i++) if (v.parts[i] !== prefix.parts[i]) inp = false;
    return op === '!=' ? !inp : inp;
  }
  const c = cmpVersion(v, t);
  switch (op) {
    case '==': return c === 0;
    case '!=': return c !== 0;
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '~=':
      if (c < 0 || t.parts.length < 2) return c >= 0;
      for (let i = 0; i < t.parts.length - 1; i++) if (i >= v.parts.length || v.parts[i] !== t.parts[i]) return false;
      return true;
  }
  return false;
}

/* ---------- loading (catalog.go, snapshot.go) ---------- */

// Release.FileName
export function fileName(r) {
  let u = r.url;
  const i = u.lastIndexOf('/');
  if (i >= 0) u = u.slice(i + 1);
  u = splitJoin(u, '%2B', '+');
  const j = u.search(/[?#]/);
  return j >= 0 ? u.slice(0, j) : u;
}
const variantStr = (r) => (r.variant != null ? r.variant : '');

// strings.EqualFold(s, "sha256"): ſ folds to s.
const isSHA256Name = (s) => typeof s === 'string' && s.replace(/ſ/g, 's').toLowerCase() === 'sha256';

// checksumSHA256: {"algo","value"} or a list of them.
function checksumSHA256(raw) {
  const ok = (o) => o === null || (isMap(o) && ['algo', 'value'].every((k) => o[k] == null || typeof o[k] === 'string'));
  if (isMap(raw) && ok(raw) && isSHA256Name(raw.algo)) return goLower(str(raw.value));
  if (Array.isArray(raw) && raw.every(ok)) {
    for (const c of raw) if (c && isSHA256Name(c.algo)) return goLower(str(c.value));
  }
  return '';
}

// strList: a JSON string, list of strings (null as "\0null"), or nothing.
function strList(raw) {
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw) || !raw.every((x) => x === null || typeof x === 'string')) return null;
  return raw.length ? raw.map((x) => (x === null ? '\0null' : x)) : null;
}

// anyList
function anyList(v) {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v) || v.length === 0) return null;
  return v.map((x) => (x === null ? '\0null' : goSprint(x)));
}

function verInt(s) {
  const p = s.split('.');
  return atoi(p[0]) * 100 + (p.length > 1 ? atoi(p[1]) : 0);
}

const WIN_LABEL = {
  xp: 'Windows XP', 'xp-x64': 'Windows XP x64', vista: 'Windows Vista', 7: 'Windows 7', 8: 'Windows 8',
  8.1: 'Windows 8.1', 10: 'Windows 10', 11: 'Windows 11', 2000: 'Windows 2000',
};

// loadOSScale
function loadOSScale(raw) {
  const s = { byFamily: {}, byID: new Map() };
  const push = (f, o) => ((s.byFamily[f] || (s.byFamily[f] = []))).push(o);
  for (const w of list(raw.windows)) {
    const id = str(w.id), label = nz(own(WIN_LABEL, id), '');
    const nt = str(w.nt).split('.');
    if (nt.length < 2) throw new Error('os_versions.json: windows ' + id + ': bad nt');
    const o = { family: 'windows', id, int: verInt(nt[0] + '.' + nt[1]), build: nt.length > 2 ? atoi(nt[2]) : 0, label };
    o.arches = id === 'xp' || id === '2000' ? ['x86'] : id === 'xp-x64' ? ['amd64'] : id === '10' || id === '11' ? ['amd64', 'x86', 'arm64'] : ['amd64', 'x86'];
    s.byID.set('windows/' + id, o);
    if (label !== '' && id !== '2000') push('windows', o);
  }
  for (const m of list(raw.macos)) {
    const id = str(m.id), int = verInt(id);
    const o = { family: 'macos', id, int, build: 0, label: 'macOS ' + id + ' ' + str(m.name), arches: int >= 1100 ? ['arm64', 'amd64'] : ['amd64'] };
    s.byID.set('macos/' + id, o);
    if (int >= 1006) push('macos', o);
  }
  for (const l of list(raw.linux_glibc)) {
    const id = str(l.id), int = verInt(id.startsWith('glibc-') ? id.slice(6) : id);
    const o = { family: 'linux', id, int, build: 0, label: 'Linux, ' + id + ' (' + list(l.distros).join(', ') + ')', arches: int >= 217 ? ['amd64', 'arm64'] : ['amd64'] };
    s.byID.set('linux/' + id, o);
    push('linux', o);
  }
  // musl systems report glibc 0, below every glibc version.
  for (const m of list(raw.linux_musl)) {
    const o = { family: 'linux', id: str(m.id), int: 0, build: 0, label: 'Linux, musl (' + list(m.distros).join(', ') + ')', arches: ['amd64', 'arm64'] };
    s.byID.set('linux/' + o.id, o);
    push('linux', o);
  }
  for (const f of Object.keys(s.byFamily)) s.byFamily[f].sort((a, b) => b.int - a.int || b.build - a.build);
  return s;
}
const osFamily = (cat, f) => own(cat.os.byFamily, f) || [];
const osLookup = (cat, f, id) => cat.os.byID.get(f + '/' + id);

// loadCompilerMin
function loadCompilerMin(raw) {
  const out = [];
  if (raw === undefined) return out;
  for (const c of list(raw.compilers)) {
    const range = (name, r) => out.push({ compiler: name, versions: str(r.versions), os: str(r.os), arch: strList(r.arch), min: r.min });
    for (const r of list(c.ranges)) range(str(c.compiler), r);
    if (isMap(c.toolchains)) for (const tc of Object.keys(c.toolchains)) for (const r of list(c.toolchains[tc])) range(str(c.compiler) + ':' + tc, r);
  }
  return out;
}

function parseFile(files, name, optional) {
  const v = own(files, name);
  if (v === undefined) {
    if (optional) return undefined;
    throw new Error('open ' + name + ': file does not exist');
  }
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch (e) { throw new Error(name + ': ' + e.message); }
}

let nRelease = 0;
function release(raw, folder) {
  const r = {
    version: str(raw.version), os: str(raw.os), arch: str(raw.arch), kind: str(raw.kind), format: str(raw.format),
    variant: typeof raw.variant === 'string' ? raw.variant : null, libc: typeof raw.libc === 'string' ? raw.libc : null,
    url: str(raw.url), mirrors: Array.isArray(raw.mirrors) ? raw.mirrors : null, checksum: raw.checksum,
    size: typeof raw.size === 'number' ? raw.size : 0, min_os: (raw.min_os != null ? raw.min_os : null),
    sha256: str(raw.ib_sha256), local: str(raw.ib_local), folder,
  };
  r.v = parseVersion(r.version);
  r.n = nRelease++;
  if (r.sha256 === '') r.sha256 = checksumSHA256(r.checksum);
  // A release made of several files (python's msi-layout: core.msi, then
  // exe.msi, lib.msi, tcltk.msi): the rest, each pinned like the release,
  // named as the recipe's {tmp}\<name> steps name them.
  if (Array.isArray(raw.parts)) {
    r.parts = raw.parts.filter(isMap).map((p) => ({
      name: str(p.name), url: str(p.url), mirrors: Array.isArray(p.mirrors) ? p.mirrors : null,
      sha256: goLower(str(p.ib_sha256) || str(p.sha256)), size: typeof p.size === 'number' ? p.size : 0,
      local: str(p.ib_local), looked: str(p.ib_local) !== '',
    })).filter((p) => /^[A-Za-z0-9_.-]+$/.test(p.name) && p.sha256 !== '');
  }
  return r;
}

// load: files is {name: parsed JSON or JSON text}, named as in the
// catalogue folder (and a snapshot). opts.sha(release, fileName) stands in
// for Go's LocalIndex: it returns {sha256, local, size} for our copy of a
// release, or null; `local` is the copy's path relative to the local root,
// which is also its path on the mirror (policy mirror_base). It is asked
// whenever a release without a local copy is considered, as Go asks its
// index, so it should be cheap.
//
// This loads every runtime at once (the server, the tools and the tests);
// openCatalog below loads them one catalogue folder at a time.
export function loadCatalogFiles(files, opts = {}) {
  const cat = newCatalog(files, opts);
  for (const folder of cat.folders.keys()) addFolder(cat, folder, files);
  return cat;
}

// The shared part: the policy, the OS versions and the compilers' floors.
// cat.folders maps each catalogue folder to the runtimes whose files it
// holds (python2's are in python/); cat.runtimes has the loaded runtimes.
function newCatalog(files, opts) {
  const policy = parseFile(files, 'policy.json');
  if (!isMap(policy)) throw new Error('policy.json: not an object');
  const cat = {
    policy, os: loadOSScale(parseFile(files, 'os_versions.json')), runtimes: new Map(),
    shaHook: typeof opts.sha === 'function' ? opts.sha : null, raw: {}, memo: new Map(),
    folders: new Map(), loaded: new Set(), lazy: null,
  };
  cat.raw['os_versions.json'] = parseFile(files, 'os_versions.json');
  cat.raw['compilers_min_os.json'] = parseFile(files, 'compilers_min_os.json', true);
  cat.compMin = loadCompilerMin(cat.raw['compilers_min_os.json']);
  for (const id of runtimeIDs(policy)) {
    const folder = folderOf(cat, id);
    if (!cat.folders.has(folder)) cat.folders.set(folder, []);
    cat.folders.get(folder).push(id);
  }
  return cat;
}

// The folder a runtime's files are in (policy "folder", else its id).
function folderOf(cat, id) {
  const pol = runtimePolicy(cat, id);
  return (pol && str(pol.folder)) || id;
}

// One folder's files: its runtimes join cat.runtimes.
function addFolder(cat, folder, files) {
  const rels = parseFile(files, folder + '/releases.json');
  const inst = parseFile(files, folder + '/install.json');
  const sup = parseFile(files, folder + '/os_support.json', true);
  cat.raw[folder + '/install.json'] = inst;
  if (sup !== undefined) cat.raw[folder + '/os_support.json'] = sup;
  for (const id of cat.folders.get(folder) || []) {
    const pol = runtimePolicy(cat, id);
    const rt = {
      id,
      recipes: list(own(inst, 'recipes')).filter((r) => r !== null).map((r) => ({
        match: isMap(r.match) ? r.match : null, method: str(r.method), steps: list(r.steps).map((s) => (isMap(s) ? s : {})),
        executable: str(r.executable), isolation: str(r.isolation),
        launch: isMap(r.launch) ? r.launch : null, projectInstall: isMap(r.project_install) ? r.project_install : null,
      })),
      rules: list(own(sup, 'rules')).filter((r) => r !== null),
      releases: [],
    };
    for (const raw of list(rels)) {
      if (raw === null) continue;
      const r = release(raw, folder);
      if (matches(r.v, str(pol.versions))) rt.releases.push(r);
    }
    cat.runtimes.set(id, rt);
  }
  cat.loaded.add(folder);
}

/* ---------- a catalogue loaded one folder at a time ---------- */

// openCatalog: a catalogue whose runtimes are loaded when asked for. `files`
// holds the shared files (policy.json, os_versions.json and, if any,
// compilers_min_os.json); load(folder) returns (or promises) that folder's
// files, named as in a snapshot ("python/releases.json", ...).
//
// Everything that reads runtimes stays synchronous: callers first await
// loadRuntimes(cat, ids), which loads the runtimes, everything their plans
// can reach through the policy's "via" and "requires" (cc needs zig on
// Linux and macOS; nim needs cc on Windows), and every runtime sharing their
// folders. A runtime in the policy whose folder isn't loaded yet is an
// error (runtimeOf), never taken as absent, so a missing loadRuntimes can't
// quietly change a plan. On a catalogue from loadCatalogFiles (the server's)
// everything is loaded and loadRuntimes does nothing.
export function openCatalog(files, load, opts = {}) {
  const cat = newCatalog(files, opts);
  cat.lazy = { load, pending: new Map() };
  return cat;
}

// The runtime ids of the policy, in order.
export function catalogRuntimeIDs(cat) {
  return runtimeIDs(cat.policy);
}

// Whether the policy has this runtime (loaded or not).
export function hasRuntime(cat, id) {
  return runtimePolicy(cat, id) !== null;
}

// Whether a runtime's folder is loaded.
export function runtimeLoaded(cat, id) {
  return !hasRuntime(cat, id) || cat.loaded.has(folderOf(cat, id));
}

// The runtimes a plan for `ids` can reach: the ids, and through "via" and
// "requires" (on every OS) whatever those reach. Unknown ids are left out.
export function runtimeNeeds(cat, ids) {
  const out = new Set();
  const visit = (id) => {
    if (out.has(id) || !hasRuntime(cat, id)) return;
    out.add(id);
    const pol = runtimePolicy(cat, id);
    if (isMap(pol.via)) for (const f of Object.keys(pol.via)) visit(str(pol.via[f]));
    if (isMap(pol.requires)) for (const f of Object.keys(pol.requires)) for (const req of list(pol.requires[f])) visit(str(own(req, 'runtime')));
  };
  for (const id of ids) visit(id);
  return [...out].sort(cmpStr);
}

// The catalogue folders holding those runtimes' files.
export function runtimeFolders(cat, ids) {
  return [...new Set(runtimeNeeds(cat, ids).map((id) => folderOf(cat, id)))].sort(cmpStr);
}

// Loads what plans for `ids` need (runtimeNeeds). Resolves to cat.
export async function loadRuntimes(cat, ids) {
  if (cat.lazy) await Promise.all(runtimeFolders(cat, ids).map((f) => loadFolder(cat, f)));
  return cat;
}

// Loads every runtime (a whole snapshot's worth).
export function loadAllRuntimes(cat) {
  return loadRuntimes(cat, runtimeIDs(cat.policy));
}

function loadFolder(cat, folder) {
  if (cat.loaded.has(folder)) return Promise.resolve();
  let p = cat.lazy.pending.get(folder);
  if (!p) {
    p = Promise.resolve().then(() => cat.lazy.load(folder)).then((files) => {
      if (!cat.loaded.has(folder)) addFolder(cat, folder, files || {});
    });
    cat.lazy.pending.set(folder, p);
    p.catch(() => cat.lazy.pending.delete(folder));
  }
  return p;
}

// A runtime by id: undefined if the policy doesn't have it; an error if it
// does but its folder isn't loaded (see openCatalog).
function runtimeOf(cat, id) {
  const rt = cat.runtimes.get(id);
  if (rt || !hasRuntime(cat, id)) return rt;
  const e = new Error('catalogue: runtime ' + goQuote(id) + ' is not loaded yet (its folder ' + goQuote(folderOf(cat, id)) + '); loadRuntimes first');
  e.notLoaded = true;
  throw e;
}

/* ---------- snapshots ---------- */

// LoadSnapshot: what Snapshot (or writeSnapshot) wrote, gzipped or not.
export async function loadSnapshot(bytes, opts = {}) {
  return loadCatalogFiles(await snapshotFiles(bytes), opts);
}

// A whole snapshot's files, from its bytes (gzipped or not).
async function snapshotFiles(bytes) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await inflate(bytes, 'gzip');
  let snap;
  try { snap = JSON.parse(dec.decode(bytes)); } catch (e) { throw new Error('catalogue snapshot: ' + e.message); }
  const ver = own(snap, 'ib-catalog-snapshot');
  if (ver !== 1) throw new Error('catalogue snapshot version ' + (typeof ver === 'number' ? ver : 0));
  return own(snap, 'files') || {};
}

// Snapshot: the catalogue as one gzipped file, with only the releases the
// resolver can pick, each with its SHA-256 and our copy's path.
export async function writeSnapshot(cat) {
  const text = JSON.stringify({ 'ib-catalog-snapshot': 1, files: await writeSnapshotFiles(cat) }) + '\n';
  return deflate(enc.encode(text), 'gzip');
}

// The files writeSnapshot writes, sorted by name.
async function writeSnapshotFiles(cat) {
  await loadAllRuntimes(cat);
  const files = { 'policy.json': cat.policy, 'os_versions.json': cat.raw['os_versions.json'] };
  if (cat.raw['compilers_min_os.json'] !== undefined) files['compilers_min_os.json'] = cat.raw['compilers_min_os.json'];
  const kept = new Map(), seen = new Set();
  for (const id of runtimeIDs(cat.policy)) {
    const rt = runtimeOf(cat, id), pol = runtimePolicy(cat, id);
    const folder = folderOf(cat, id);
    if (!kept.has(folder)) {
      files[folder + '/install.json'] = cat.raw[folder + '/install.json'];
      if (cat.raw[folder + '/os_support.json'] !== undefined) files[folder + '/os_support.json'] = cat.raw[folder + '/os_support.json'];
      kept.set(folder, []);
    }
    for (const e of rt.releases) {
      if (seen.has(e) || !usable(pol, e)) continue;
      seen.add(e);
      sha(cat, e);
      // Release's JSON, in Go's field order; the SHA-256 replaces checksum.
      const o = {
        version: e.version, os: e.os, arch: e.arch, kind: e.kind, format: e.format, variant: e.variant, libc: e.libc,
        url: e.url, mirrors: e.mirrors, size: e.size, min_os: e.min_os,
      };
      if (e.sha256) o.ib_sha256 = e.sha256;
      if (e.local) o.ib_local = e.local;
      if (e.parts) {
        o.parts = e.parts.map((p) => {
          partLocal(cat, p);
          const q = { name: p.name, url: p.url, mirrors: p.mirrors, size: p.size, ib_sha256: p.sha256 };
          if (p.local) q.ib_local = p.local;
          return q;
        });
      }
      kept.get(folder).push(o);
    }
  }
  for (const [folder, rels] of kept) files[folder + '/releases.json'] = rels;
  const sorted = {};
  for (const k of Object.keys(files).sort(cmpStr)) sorted[k] = files[k];
  return sorted;
}

/* ---------- the split snapshot (docs/format.md section 6) ---------- */

export const SPLIT_FORMAT = 'ib-catalog-split';
export const CHUNK_FORMAT = 'ib-catalog-folder';
const FOLDER_RE = /^[A-Za-z0-9_-]{1,64}$/;

// splitSnapshot: a snapshot (its bytes, or a catalogue, written as
// writeSnapshot writes it) as an index and one gzipped chunk per catalogue
// folder. The index: {"ib-catalog-split": 1, "files": {the files outside
// any folder}, "folders": {folder: {"releases": count, "size": the chunk's
// bytes}}}. A chunk, gunzipped: {"ib-catalog-folder": 1, "folder": name,
// "files": {"name/install.json": ..., "name/os_support.json": ...,
// "name/releases.json": [...]}}. Resolves to {index, chunks: [{folder, bytes}]}.
export async function splitSnapshot(src) {
  const files = src instanceof Uint8Array || src instanceof ArrayBuffer ? await snapshotFiles(src) : await writeSnapshotFiles(src);
  const shared = {}, byFolder = new Map();
  for (const name of Object.keys(files).sort(cmpStr)) {
    const i = name.indexOf('/');
    if (i < 0) { shared[name] = files[name]; continue; }
    const folder = name.slice(0, i);
    if (!FOLDER_RE.test(folder) || name.indexOf('/', i + 1) >= 0) throw new Error('catalogue snapshot: a file name this format can\'t split: ' + goQuote(name));
    if (!byFolder.has(folder)) byFolder.set(folder, {});
    byFolder.get(folder)[name] = files[name];
  }
  const index = { [SPLIT_FORMAT]: 1, files: shared, folders: {} };
  const chunks = [];
  for (const [folder, f] of byFolder) {
    const bytes = await deflate(enc.encode(JSON.stringify({ [CHUNK_FORMAT]: 1, folder, files: f }) + '\n'), 'gzip');
    index.folders[folder] = { releases: list(own(f, folder + '/releases.json')).length, size: bytes.length };
    chunks.push({ folder, bytes });
  }
  return { index, chunks };
}

// readChunk: one folder's files from its chunk (gzipped or not).
export async function readChunk(bytes, folder) {
  bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = await inflate(bytes, 'gzip');
  let c;
  try { c = JSON.parse(dec.decode(bytes)); } catch (e) { throw new Error('catalogue folder ' + folder + ': ' + e.message); }
  const ver = own(c, CHUNK_FORMAT);
  if (ver !== 1) throw new Error('catalogue folder ' + folder + ': format version ' + (typeof ver === 'number' ? ver : 0));
  if (own(c, 'folder') !== folder) throw new Error('catalogue folder ' + folder + ': the chunk is for ' + goQuote(str(own(c, 'folder'))));
  const files = own(c, 'files');
  if (!isMap(files) || Object.keys(files).some((k) => !k.startsWith(folder + '/'))) throw new Error('catalogue folder ' + folder + ': files outside the folder');
  return files;
}

// openSplitSnapshot: a catalogue (openCatalog) over a split snapshot's
// index; chunk(folder) returns (or promises) that folder's chunk bytes.
export function openSplitSnapshot(index, chunk, opts = {}) {
  const ver = own(index, SPLIT_FORMAT);
  if (ver !== 1) throw new Error('catalogue index version ' + (typeof ver === 'number' ? ver : 0));
  const folders = isMap(own(index, 'folders')) ? index.folders : {};
  return openCatalog(own(index, 'files') || {}, async (folder) => {
    if (!Object.hasOwn(folders, folder)) throw new Error('catalogue folder ' + goQuote(folder) + ' is not in this snapshot');
    return readChunk(await chunk(folder), folder);
  }, opts);
}

/* ---------- policy (policy.go) ---------- */

// Policy.RuntimeIDs
function runtimeIDs(policy) {
  const r = own(policy, 'runtimes');
  return isMap(r) ? Object.keys(r).filter((k) => isMap(r[k])).sort(cmpStr) : [];
}
const runtimePolicy = (cat, id) => {
  const p = own(own(cat.policy, 'runtimes'), id);
  return isMap(p) ? p : null;
};
// label
const runtimeLabel = (pol, id) => (pol && str(pol.label) !== '' ? pol.label : id);

// RuntimePolicy.Rule
function installRule(pol, id) {
  if (!pol) return null;
  return list(pol.install_rules).find((r) => isMap(r) && r.id === id) || null;
}

// A policy command: a map of OS family -> command, or a list of such maps
// each with a "versions" range, the first matching the chosen release's
// version winning (docs/format.md section 2). Python 3.4's pip, the newest
// on Windows XP, knows neither --no-warn-script-location nor
// --disable-pip-version-check, so its install rule needs another command.
function osCommand(raw, v, family) {
  if (Array.isArray(raw)) {
    for (const c of raw) {
      if (!isMap(c) || !matches(v, str(c.versions))) continue;
      const s = str(own(c, family));
      if (s !== '') return s;
    }
    return '';
  }
  return str(own(raw, family));
}

// ExtraFile.source
// The first source for this runtime version and, when it says, this OS
// version (min_os/max_os, the OS integers: MSYS2 for Ruby's DevKit needs
// Windows 8.1).
const extraSource = (ef, v, o) => list(ef.sources).find((s) => isMap(s) && matches(v, str(s.versions)) &&
  !(o && ((s.min_os > 0 && o.int < s.min_os) || (s.max_os > 0 && o.int > s.max_os)))) || null;

/* ---------- OS support (support.go) ---------- */

// A compilers_min_os floor that says the toolchain is a static binary
// ("static": true with no glibc version): no C library version keeps it
// from running, so the catalogue's default floor (policy unknown_floor,
// glibc 2.28) must not be used in its place. Go's toolchain is the case
// ("statically linked (no NEEDED)" in its evidence), and without this no
// Go release was offered on Ubuntu 18.04 and older or CentOS 7. A rule
// that merely has nothing to say (both kernel and glibc null, as Nim's)
// is still unknown, and keeps the default.
const noLibcFloor = (family, raw) => family === 'linux' && isMap(raw) &&
  raw.static === true && raw.glibc == null;

// minInt
function minInt(family, arch, raw) {
  if (raw == null) return 0;
  if (typeof raw === 'string') return verInt(raw);
  if (isMap(raw) && Object.values(raw).every((x) => x === null || typeof x === 'string')) {
    if (family === 'linux') return typeof own(raw, 'glibc') === 'string' ? verInt(raw.glibc) : 0;
    const v = own(raw, arch);
    if (typeof v === 'string') return verInt(v);
  }
  return 0;
}

// variantOK: "\0null" stands for no variant; entries may end in * as a glob.
function variantOK(l, v) {
  if (!l || l.length === 0) return true;
  for (const x of l) {
    if (x === '\0null') {
      if (v === null) return true;
      continue;
    }
    if (v === null) continue;
    if (x === v || (x.endsWith('*') && v.startsWith(x.slice(0, -1)))) return true;
  }
  return false;
}

// SupportRule.applies
function ruleApplies(r, e) {
  if (str(r.os) !== e.os) return false;
  const a = strList(r.arch);
  if (a && a.length > 0 && !a.includes(e.arch)) return false;
  let variants = strList(r.variant), formats = strList(r.format), kinds = strList(r.kind);
  let fileMatch = str(r.file_match);
  const m = isMap(r.match) ? r.match : null;
  if (m) {
    if (variants === null) variants = anyList(own(m, 'variant'));
    if (formats === null) formats = anyList(own(m, 'format'));
    if (kinds === null) kinds = anyList(own(m, 'kind'));
    if (fileMatch === '' && typeof own(m, 'file_match') === 'string') fileMatch = m.file_match;
  }
  if (!variantOK(variants, e.variant)) return false;
  if (formats && formats.length > 0 && !formats.includes(e.format)) return false;
  if (fileMatch !== '') {
    let re;
    try { re = goRegExp(fileMatch); } catch (e_) { return false; }
    if (!re.test(fileName(e))) return false;
  }
  if (kinds && kinds.length > 0 && !kinds.includes(e.kind)) return false;
  if ((!kinds || kinds.length === 0) && e.kind === 'source') return false;
  return matches(e.v, str(r.versions));
}

const osKey = (o) => `${o.family}/${o.id}/${o.int}/${o.build}`;

// Catalog.runsOn: {ok, minBuild, known}
function runsOn(cat, rt, e, o) {
  return memo(cat, `runsOn ${e.n} ${osKey(o)}`, () => runsOnUncached(cat, rt, e, o));
}
function runsOnUncached(cat, rt, e, o) {
  const hits = [];
  for (const r of rt.rules) {
    if (typeof r.min_os !== 'string' || !ruleApplies(r, e)) continue;
    if (!osLookup(cat, o.family, r.min_os)) continue;
    if ((r.min_os === 'musl') !== (o.id === 'musl')) continue;
    hits.push(r);
  }
  if (hits.length > 0) {
    let minBuild = 0;
    for (const r of hits) {
      if (r.plan_floor === false) continue;
      const lo = osLookup(cat, o.family, r.min_os);
      if (o.int < lo.int || (o.int === lo.int && o.build < lo.build)) return { ok: false, minBuild: 0, known: true };
      if (typeof r.max_os === 'string') {
        const hi = osLookup(cat, o.family, r.max_os);
        if (hi && (o.int > hi.int || (o.int === hi.int && o.build > hi.build))) return { ok: false, minBuild: 0, known: true };
      }
      // A Windows build number; other shapes are ignored.
      const mb = r.min_build;
      if (Number.isInteger(mb) && o.family === 'windows' && mb > minBuild) minBuild = mb;
    }
    return { ok: true, minBuild, known: true };
  }
  const pol = runtimePolicy(cat, rt.id);
  let name = rt.id;
  const tcs = pol && isMap(pol.toolchains) ? pol.toolchains : null;
  if (tcs && Object.hasOwn(tcs, variantStr(e))) name = rt.id + ':' + goSprint(tcs[variantStr(e)]);
  for (const r of cat.compMin) {
    if (r.compiler !== name || r.os !== e.os || !matches(e.v, r.versions)) continue;
    if (r.arch && r.arch.length > 0 && !r.arch.includes(e.arch)) continue;
    const m = minInt(o.family, e.arch, r.min);
    if (m === 0 && !noLibcFloor(o.family, r.min)) break;
    return { ok: o.int >= m, minBuild: 0, known: true };
  }
  if (o.id === 'musl') return { ok: false, minBuild: 0, known: false };
  const floor = own(own(cat.policy, 'unknown_floor'), o.family);
  return { ok: o.int >= (typeof floor === 'number' ? floor : 0), minBuild: 0, known: false };
}

/* ---------- prerequisites (prereq.go) ---------- */

const PKG_MGRS = ['apt-get', 'dnf', 'yum', 'zypper', 'apk', 'pacman'];

// A policy rule's "for" (extra_files, needs, requires) says which apps it
// applies to: `install` only to apps that install something (a package, or
// a project whose files an install rule names), `tool:<id>` only to apps
// whose record sets that tool switch (docs/format.md "Prerequisites" and
// `tools`). Several conditions are separated by `|` and any one is enough:
// Ruby's DevKit is `install|tool:ruby_devkit`. Anything else means
// "always", as it always has.
function forApp(x, install, tools) {
  if (!isMap(x)) return true;
  const f = str(x.for);
  if (f === '') return true;
  for (const part of f.split('|')) {
    if (part === 'install') { if (install) return true; } else if (part.slice(0, 5) === 'tool:') {
      if (tools && tools.has(part.slice(5))) return true;
    } else return true;
  }
  return false;
}

// The record's tool switches as a Set, for forApp.
const toolsOf = (app) => new Set(list(app && app.tools).map(str));
// The same, for a memo key.
const toolsKey = (tools) => [...tools].sort(cmpStr).join(' ');

// Catalog.prereqsFor
function prereqsFor(cat, rt, e, o, install, tools) {
  return memo(cat, `prereqs ${e.n} ${osKey(o)} ${!!install} ${toolsKey(tools)}`,
    () => prereqsForUncached(cat, rt, e, o, !!install, tools));
}
function prereqsForUncached(cat, rt, e, o, install, tools) {
  const pol = runtimePolicy(cat, rt.id);
  if (!pol) return [];
  const out = [], seen = new Set();
  for (const n of list(pol.needs)) {
    if (!isMap(n) || !forApp(n, install, tools)) continue;
    if (list(n.variants).length > 0 && indexOf(n.variants, variantStr(e)) < 0) continue;
    if (str(n.versions) !== '' && !matches(e.v, n.versions)) continue;
    const lo = n.min_os || 0, hi = n.max_os || 0;
    if ((lo > 0 && o.int < lo) || (hi > 0 && o.int > hi)) continue;
    for (const id of list(n.prerequisites)) {
      const q = own(own(cat.policy, 'prerequisites'), id);
      if (!isMap(q) || q.os !== o.family || seen.has(id)) continue;
      if (str(q.arch) !== '' && q.arch !== e.arch) continue;
      seen.add(id);
      out.push({ id, p: q, why: str(n.why) });
    }
  }
  return out;
}

// pick.allPrereqs
function allPrereqs(pk) {
  const out = [], seen = new Set();
  const add = (l) => { for (const u of l) if (!seen.has(u.id)) { seen.add(u.id); out.push(u); } };
  add(pk.prereqs);
  for (const n of pk.needs) add(n.p.prereqs);
  return out;
}

// The app's own prerequisites for one OS family: a record's `prerequisites`
// (the site's written templates name what their code needs from the
// system, js/templates.js), after the runtime's, without repeats.
function targetPrereqs(cat, app, b) {
  const out = allPrereqs(b.p), seen = new Set(out.map((u) => u.id));
  for (const id of list(app.prerequisites)) {
    const q = own(own(cat.policy, 'prerequisites'), str(id));
    if (!isMap(q) || q.os !== b.family || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, p: q, why: 'The app\'s own code needs it.' });
  }
  return out;
}

function samePrereqs(a, b) {
  const x = allPrereqs(a), y = allPrereqs(b);
  return x.length === y.length && x.every((u, i) => u.id === y[i].id && u.why === y[i].why);
}

const mirrorURL = (cat, local) => {
  const base = str(own(cat.policy, 'mirror_base'));
  return local !== '' && base !== '' ? base.replace(/\/+$/, '') + '/' + splitJoin(local, '\\', '/') : '';
};

// Catalog.prereqURLs
function prereqURLs(cat, f) {
  const mirror = mirrorURL(cat, str(f.local));
  const out = [], seen = new Set();
  const add = (u) => { if (u !== '' && !seen.has(u)) { seen.add(u); out.push(u); } };
  if (own(cat.policy, 'mirror_first') === true) add(mirror);
  for (const u of list(f.urls)) add(str(u));
  add(mirror);
  return out;
}

// Catalog.writeNeeds
function writeNeeds(cat, w, uses) {
  for (const u of uses) {
    const q = u.p;
    w.add('need', u.id, str(q.label));
    if (u.why !== '') w.add('nwhy', u.why);
    for (const ch of list(q.checks)) w.add('ncheck', ...list(ch).map(str));
    const f = isMap(q.file) ? q.file : null;
    if (f) {
      w.add('nfile', str(f.name), str(f.sha256), String(f.size || 0));
      for (const url of prereqURLs(cat, f)) w.add('nurl', url);
    }
    if (str(q.run) !== '') {
      w.add('nrun', q.run);
      if (list(q.ok_codes).length > 0) w.add('nok', q.ok_codes.map(String).join(' '));
    }
    for (const m of PKG_MGRS) {
      const pk = str(own(q.packages, m));
      if (pk !== '') w.add('npkg', m, pk);
    }
    if (str(q.start) !== '') w.add('nstart', q.start);
    if (str(q.how) !== '') w.add('nhow', q.how);
  }
}

/* ---------- recipes and candidates (resolve.go) ---------- */

const tmpRefRe = () => /\{tmp\}[\\/]+([A-Za-z0-9_.-]+)/g;
const STEP_KEYS = new Set(['unpack', 'to', 'strip_components', 'exclude', 'run', 'shell', 'write', 'text', 'mkdir']);

// Catalog.supported: {ok, extras, prefer}
function supported(cat, rt, r, e, install, o, tools) {
  const no = { ok: false, extras: [], prefer: false };
  const methods = list(own(cat.policy, 'method_order'));
  if (!methods.includes(r.method) || r.isolation === 'impossible') return no;
  const pol = runtimePolicy(cat, rt.id);
  const seen = new Set(), extras = [];
  let deferred = false, prefer = false;
  for (const st of r.steps) {
    for (const k of Object.keys(st)) if (!STEP_KEYS.has(k)) return no;
    const s = str(st.run);
    for (const m of s.matchAll(tmpRefRe())) {
      // One of the release's own parts: an extra file pinned by the release.
      const part = e.parts ? e.parts.find((p) => p.name === m[1]) : undefined;
      if (part) {
        deferred = true;
        if (!seen.has(m[1])) { seen.add(m[1]); extras.push({ name: m[1], src: part, part: true }); }
        continue;
      }
      if (!contains(own(cat.policy, 'external_tmp_files'), m[1])) continue;
      const ef = pol ? own(pol.extra_files, m[1]) : undefined;
      if (!isMap(ef)) return no;
      const src = extraSource(ef, e.v, o);
      if (!src || str(src.sha256) === '' || list(src.urls).length === 0) return no;
      if (str(ef.for) !== '') {
        if (!forApp(ef, install, tools)) return no;
        prefer = true;
      }
      deferred = true;
      if (!seen.has(m[1])) { seen.add(m[1]); extras.push({ name: m[1], src }); }
    }
    if (deferred && (st.unpack != null || s.includes('{file}'))) return no;
  }
  return { ok: true, extras, prefer };
}

// Our copy of a release part (opts.sha, as for releases), looked for once.
function partLocal(cat, p) {
  if (!p.looked && cat.shaHook) {
    p.looked = true;
    const got = cat.shaHook({ size: p.size, sha256: p.sha256, url: p.url }, p.name);
    if (got && str(got.local) !== '' && (str(got.sha256) === '' || got.sha256 === p.sha256)) p.local = got.local;
  }
  return p.local;
}

// Our mirror's copy of an extra file: a release part's is looked for
// (opts.sha); a policy file's is its `local` path, as a prerequisite's is.
const extraLocal = (cat, x) => (x.part ? partLocal(cat, x.src) : str(x.src.local));

// An extra file's download locations: its own, with our mirror first or
// last as the policy says (for a policy file, when it names a `local` copy).
function extraURLs(cat, x) {
  const out = [], seen = new Set();
  const add = (u) => { if (u !== '' && !seen.has(u)) { seen.add(u); out.push(u); } };
  const mirror = mirrorURL(cat, extraLocal(cat, x));
  if (own(cat.policy, 'mirror_first') === true) add(mirror);
  if (x.part) {
    add(x.src.url);
    for (const m of x.src.mirrors || []) add(str(m));
  } else {
    for (const u of list(x.src.urls)) add(str(u));
  }
  add(mirror);
  return out;
}

// usesExtra
function usesExtra(st, extras) {
  for (const m of str(st.run).matchAll(tmpRefRe())) if (extras.some((x) => x.name === m[1])) return true;
  return false;
}

// matchField: {ok, specific}
function matchField(m, key, val) {
  const v = own(m, key);
  if (v == null) return { ok: true, specific: false };
  for (const x of anyList(v) || []) {
    for (const alt of x.split('|')) {
      if (alt === val || (alt.endsWith('*') && val.startsWith(alt.slice(0, -1)))) return { ok: true, specific: true };
    }
  }
  return { ok: false, specific: true };
}

// Catalog.recipeFor: {recipe, extras}
function recipeFor(cat, rt, e, install, o, tools) {
  return memo(cat, `recipe ${e.n} ${install} ${o ? o.int : ''} ${toolsKey(tools)}`,
    () => recipeForUncached(cat, rt, e, install, o, tools));
}
function recipeForUncached(cat, rt, e, install, o, tools) {
  let best = null, bestExtras = [], bestScore = -1;
  const methods = list(own(cat.policy, 'method_order'));
  for (const r of rt.recipes) {
    let score = 0, ok = true;
    for (const [k, val] of [['os', e.os], ['kind', e.kind], ['format', e.format], ['arch', e.arch], ['libc', (e.libc != null ? e.libc : '')]]) {
      const f = matchField(r.match, k, val);
      if (!f.ok) { ok = false; break; }
      if (f.specific) score++;
    }
    if (!ok) continue;
    if (r.match && Object.hasOwn(r.match, 'variant')) {
      const v = r.match.variant;
      if (!variantOK(anyList(v), e.variant)) continue;
      if (v != null) score++;
    }
    const vs = own(r.match, 'versions');
    if (typeof vs === 'string' && vs !== '') {
      if (!matches(e.v, vs)) continue;
      score++;
    }
    const sup = supported(cat, rt, r, e, install, o, tools);
    if (!sup.ok) continue;
    score = score * 100 + (10 - methods.indexOf(r.method)) * 5;
    if (r.isolation === 'full') score += 2;
    if (sup.prefer) score++;
    if (score > bestScore) { best = r; bestExtras = sup.extras; bestScore = score; }
  }
  return { recipe: best, extras: bestExtras };
}

// archOK: {ok, native}
function archOK(family, machine, rel) {
  if (rel === machine || rel === 'any') return { ok: true, native: true };
  if (family === 'macos' && rel === 'universal') return { ok: true, native: true };
  if (family === 'windows' && machine === 'amd64' && rel === 'x86') return { ok: true, native: false };
  return { ok: false, native: false };
}

// Catalog.selectFor
function selectFor(cat, app, osid) {
  switch (app.select) {
    case 'range': case 'exact': return app.range;
    case 'asyncio': {
      const s = own(own(runtimePolicy(cat, app.runtime), 'asyncio'), osid);
      return typeof s === 'string' ? s : '';
    }
  }
  return '';
}

// Catalog.sha: the checksum, from our copy (opts.sha) when the catalogue has none.
function sha(cat, e) {
  if (cat.shaHook && e.local === '') {
    const got = cat.shaHook(e, fileName(e));
    if (got && str(got.local) !== '') {
      e.local = got.local;
      if (e.sha256 === '' && str(got.sha256) !== '') {
        e.sha256 = got.sha256;
        if (e.size === 0 && typeof got.size === 'number') e.size = got.size;
      }
    }
  }
  return e.sha256;
}

// usable
function usable(pol, e) {
  if (e.kind === 'source' || e.v.pre) return false;
  if (!pol) return true;
  if (list(pol.kinds).length > 0 && !contains(pol.kinds, e.kind)) return false;
  if (contains(pol.exclude_variants, variantStr(e)) || contains(own(pol.exclude_variants_on, e.os), variantStr(e))) return false;
  if (pol.only === true && indexOf(pol.variants, variantStr(e)) < 0) return false;
  const forms = own(pol.formats, e.os);
  return forms == null || indexOf(forms, e.format) >= 0;
}

// Catalog.candidates
function candidates(cat, rt, family, machine) {
  return memo(cat, `cands ${rt.id} ${family} ${machine}`, () => candidatesUncached(cat, rt, family, machine));
}
function candidatesUncached(cat, rt, family, machine) {
  const pol = runtimePolicy(cat, rt.id);
  const ranked = [];
  for (const e of rt.releases) {
    if (e.os !== family || !usable(pol, e)) continue;
    const a = archOK(family, machine, e.arch);
    if (!a.ok) continue;
    let vi = list((pol == null ? undefined : pol.variants)).length, fi = 0;
    if (pol) {
      const i = indexOf(pol.variants, variantStr(e));
      if (i >= 0) vi = i;
      if (own(pol.formats, family) != null) fi = indexOf(pol.formats[family], e.format);
    }
    ranked.push({ e, native: a.native, variant: vi, forms: fi });
  }
  ranked.sort((a, b) => {
    if (a.native !== b.native) return a.native ? -1 : 1;
    const d = cmpVersion(a.e.v, b.e.v);
    if (d !== 0) return -d;
    if (a.variant !== b.variant) return a.variant - b.variant;
    return a.forms - b.forms;
  });
  return ranked.map((r) => r.e);
}

// Catalog.best: {p, cond}
function best(cat, rt, cands, o, app) {
  const spec = selectFor(cat, app, o.id);
  const tools = toolsOf(app);
  let cond = null;
  for (const e of cands) {
    if (!matches(e.v, spec)) continue;
    const ro = runsOn(cat, rt, e, o);
    if (!ro.ok) continue;
    const install = app.package !== '' || app.install !== '';
    const { recipe, extras } = recipeFor(cat, rt, e, install, o, tools);
    if (!recipe || sha(cat, e) === '') continue;
    const pk = { rel: e, recipe, minBuild: ro.minBuild, known: ro.known, needs: [], extras, prereqs: prereqsFor(cat, rt, e, o, install, tools) };
    if (!attachNeeds(cat, rt, pk, o, install, tools)) continue;
    if (ro.minBuild > o.build && ro.minBuild > 0) {
      if (!cond) cond = pk;
      continue;
    }
    return { p: pk, cond };
  }
  return { p: null, cond };
}

// Catalog.attachNeeds
function attachNeeds(cat, rt, pk, o, install, tools) {
  const needs = memo(cat, `needs ${rt.id} ${pk.rel.arch} ${osKey(o)} ${!!install} ${toolsKey(tools)}`,
    () => companions(cat, rt, pk.rel.arch, o, !!install, tools));
  if (!needs) return false;
  pk.needs.push(...needs);
  return true;
}
// A requires entry's optional "variants" limits the companion to those
// builds (an ABI match: a UCRT runtime with a UCRT compiler).
function companions(cat, rt, arch, o, install, tools) {
  const pol = runtimePolicy(cat, rt.id);
  const out = [];
  if (!pol) return out;
  for (const req of list(own(pol.requires, o.family))) {
    if (!forApp(req, install, tools)) continue;
    const crt = runtimeOf(cat, str((req == null ? undefined : req.runtime)));
    if (!crt) return false;
    const vs = list(own(req, 'variants'));
    const native = candidates(cat, crt, o.family, arch).filter((e) => (e.arch === arch || e.arch === 'any' || e.arch === 'universal') &&
      (vs.length === 0 || indexOf(vs, variantStr(e)) >= 0));
    const { p } = best(cat, crt, native, o, normApp({ runtime: req.runtime }));
    if (!p) return false;
    out.push({ req: { runtime: str(req.runtime), bin: str(req.bin) }, p });
  }
  return out;
}

function samePick(a, b) {
  if (!a || !b) return !a && !b;
  if (a.rel !== b.rel || a.recipe !== b.recipe || a.needs.length !== b.needs.length) return false;
  for (let i = 0; i < a.needs.length; i++) if (a.needs[i].p.rel !== b.needs[i].p.rel) return false;
  return samePrereqs(a, b);
}

/* ---------- plans (resolve.go) ---------- */

// App, from lowerCamelCase fields.
function normApp(a) {
  const s = a.source;
  return {
    recordHash: str(a.recordHash), name: str(a.name), project: str(a.project), runtime: str(a.runtime),
    select: str(a.select), range: str(a.range), launch: str(a.launch), install: str(a.install),
    console: !!a.console, menu: !!a.menu, desktop: !!a.desktop, root: str(a.root), rootName: str(a.rootName),
    platforms: list(a.platforms),
    source: s ? { name: str(s.name), sha256: str(s.sha256), size: s.size || 0, format: str(s.format), strip: s.strip || 0, urls: list(s.urls) } : null,
    package: str(a.package), packageVersion: str(a.packageVersion),
    prerequisites: list(a.prerequisites).map(str),
    tools: list(a.tools).map(str),
  };
}

// Catalog.Resolve: the plan text. Throws on error.
export function resolve(cat, app) {
  return resolveFiles(cat, app).plan;
}

// Catalog.ResolveFiles: the plan and the files it downloads. A file's
// `local` is our copy's path relative to the local root ("" if none);
// Go's is absolute, and "" for a snapshot.
export function resolveFiles(cat, app) {
  app = normApp(app);
  const rt = runtimeOf(cat, app.runtime);
  if (!rt) throw new Error('unknown runtime ' + goQuote(app.runtime));
  const pol = runtimePolicy(cat, app.runtime);
  const blocks = [];
  for (const family of ['windows', 'macos', 'linux']) {
    if (app.platforms.length > 0 && !app.platforms.includes(family)) continue;
    let frt = rt;
    const via = str(own(own(pol, 'via'), family));
    if (via !== '' && runtimeOf(cat, via)) frt = runtimeOf(cat, via);
    const scale = osFamily(cat, family);
    // A block reaches up to just below the next newer OS version.
    const top = (o) => {
      let hi = 9999;
      for (const n of scale) if (n.int > o.int && n.int - 1 < hi) hi = n.int - 1;
      return hi;
    };
    for (const machine of ['amd64', 'arm64', 'x86']) {
      const cands = candidates(cat, frt, family, machine);
      let cur = null;
      const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
      for (const o of scale) {
        if (!o.arches.includes(machine)) { flush(); continue; }
        const { p, cond } = best(cat, frt, cands, o, app);
        if (cond && (!p || cond.rel !== p.rel)) {
          // Needs a newer build than this OS version starts at: a block of
          // its own, checked before the fallback.
          const lbl = o.label + ' (build ' + cond.minBuild + '+)';
          if (cur && samePick(cur.p, cond) && cur.minBuild <= cond.minBuild) {
            cur.min = o.int;
            cur.labels.push(lbl);
            if (cur.minBuild < cond.minBuild) cur.minBuild = cond.minBuild;
          } else {
            flush();
            cur = { family, min: o.int, max: top(o), minBuild: cond.minBuild, arches: [machine], p: cond, labels: [lbl] };
          }
          flush();
        }
        if (cur && samePick(cur.p, p)) {
          cur.min = o.int;
          cur.labels.push(o.label);
          if (o.id === '10' && cur.minBuild >= 22000) cur.minBuild = 0;
          continue;
        }
        flush();
        cur = { family, min: o.int, max: top(o), minBuild: o.id === '11' ? o.build : 0, arches: [machine], p, labels: [o.label] };
      }
      flush();
    }
  }
  const files = [], seen = new Set();
  const add = (e) => {
    if (seen.has(e.sha256)) return;
    seen.add(e.sha256);
    files.push({ name: fileName(e), sha256: e.sha256, size: e.size, urls: [e.url, ...(e.mirrors || [])], local: e.local });
  };
  for (const b of blocks) {
    if (!b.p) continue;
    add(b.p.rel);
    for (const x of b.p.extras) {
      if (seen.has(str(x.src.sha256))) continue;
      seen.add(x.src.sha256);
      files.push({ name: x.name, sha256: x.src.sha256, size: x.src.size || 0, urls: extraURLs(cat, x), local: extraLocal(cat, x) });
    }
    for (const n of b.p.needs) add(n.p.rel);
    for (const u of targetPrereqs(cat, app, b)) {
      const f = isMap(u.p.file) ? u.p.file : null;
      if (f && !seen.has(str(f.sha256))) {
        seen.add(str(f.sha256));
        files.push({ name: str(f.name), sha256: str(f.sha256), size: f.size || 0, urls: prereqURLs(cat, f), local: str(f.local) });
      }
    }
  }
  return { plan: writePlan(cat, app, blocks), files };
}

// versionTokens
function versionTokens(v) {
  const get = (i) => (i < v.parts.length ? String(v.parts[i]) : '0');
  return replacer('{version}', v.raw, '{vmajor}', get(0), '{vminor}', get(1), '{vmm}', get(0) + get(1), get(0) + 'XX', get(0) + get(1));
}

const envRefRe = /\{env:[A-Za-z_][A-Za-z0-9_]*\}/g;
const appDirRe = /\{app_dir\}[^ "]*/g;

// quoteAppPaths: quote bare {app_dir}/... paths in an app's own commands.
function quoteAppPaths(s) {
  return s.replace(appDirRe, (m, at) => (at > 0 && s[at - 1] === '"' ? m : '"' + m + '"'));
}

const b01 = (b) => (b ? '1' : '0');
const orDefault = (s, d) => (s === '' ? d : s);

// Catalog.write
function writePlan(cat, app, blocks) {
  const w = new Writer();
  w.add('ib-plan', '1');
  w.add('record', app.recordHash);
  w.add('name', app.name);
  w.add('project', app.project);
  w.add('appid', hash12Sync(app.recordHash + '/app'));
  w.add('runtime', app.runtime);
  w.add('console', b01(app.console));
  w.add('menu', b01(app.menu));
  w.add('desktop', b01(app.desktop));
  w.add('root', orDefault(app.root, 'user'));
  w.add('rootname', orDefault(app.rootName, 'ib'));
  const s = app.source;
  if (s) {
    w.add('source', s.name, s.sha256, String(s.size), s.format, String(s.strip));
    for (const u of s.urls) w.add('url', str(u));
  }
  const pol = runtimePolicy(cat, app.runtime);
  const label = runtimeLabel(pol, app.runtime);
  for (const b of blocks) {
    w.raw('\n[target]\n');
    w.add('when', b.family, String(b.min), String(b.max), b.arches.join(' '));
    if (b.minBuild > 0) w.add('minbuild', String(b.minBuild));
    w.add('covers', b.labels.join(', '));
    if (!b.p) {
      w.add('fail', `No ${label} release in the catalogue runs on ${b.labels.join(', ')} (${b.arches[0]}).`);
      continue;
    }
    writeTarget(cat, w, app, pol, b);
  }
  return w.toString();
}

// mergeEnv (a null value means unset)
function mergeEnv(dst, src) {
  if (isMap(src)) for (const k of Object.keys(src)) dst.set(k, typeof src[k] === 'string' ? src[k] : null);
}

const unpackKind = (st) => {
  const f = goSprint(st.unpack);
  return f === '7z-sfx' ? '7z' : f;
};
const stripOf = (st) => (typeof st.strip_components === 'number' ? Math.trunc(st.strip_components) : 0);
// unpack's 4th field (format.md, "Steps"): paths inside the archive not
// to unpack, joined with "|". A pattern that could break the plan's own
// framing -- a tab, a newline, a "|" of its own -- is dropped, and an
// empty list leaves the field off, so every other plan is unchanged.
const excludeOf = (st) =>
  list(st.exclude)
    .map(str)
    .filter((p) => p !== '' && !/[\t\r\n|]/.test(p))
    .join('|');
// Write an `unpack` step, with the 4th field only where there is one.
const addUnpack = (w, st, dest) => {
  const ex = excludeOf(st);
  if (ex === '') w.add('step', 'unpack', unpackKind(st), dest, String(stripOf(st)));
  else w.add('step', 'unpack', unpackKind(st), dest, String(stripOf(st)), ex);
};

// Catalog.writeTarget
function writeTarget(cat, w, app, pol, b) {
  const e = b.p.rel, r = b.p.recipe;
  const win = b.family === 'windows';
  const exeExt = win ? '.exe' : '';
  const vt = versionTokens(e.v);
  const fix = (s) => {
    s = splitJoin(vt(s), '{exe}', exeExt);
    if (win) s = s.replace(appDirRe, (p) => splitJoin(p, '/', '\\'));
    return s;
  };
  w.add('runtime', app.runtime, e.version);
  if (!b.p.known) w.add('note', 'Not confirmed to run on every OS version in this range; chosen by the catalogue\'s default floor.');
  writeNeeds(cat, w, targetPrereqs(cat, app, b));
  w.add('file', app.runtime, fileName(e), e.sha256, String(e.size));
  const seen = new Set();
  const addURL = (u) => { if (u !== '' && !seen.has(u)) { seen.add(u); w.add('url', u); } };
  const mirror = mirrorURL(cat, e.local);
  if (own(cat.policy, 'mirror_first') === true) addURL(mirror);
  addURL(e.url);
  for (const m of e.mirrors || []) addURL(str(m));
  addURL(mirror);
  // Recipe steps; from the first that needs an extra file on, they wait
  // for the extra files (Go's comment in writeTarget says why).
  const step = (st, fix) => {
    if (st.unpack != null) addUnpack(w, st, fix(orDefault(str(st.to), '{dir}')));
    else if (st.run != null) w.add('step', 'run', fix(goSprint(st.run)));
    else if (st.write != null) w.add('step', 'write', fix(goSprint(st.write)), fix(goSprint(st.text)));
    else if (st.mkdir != null) w.add('step', 'mkdir', fix(goSprint(st.mkdir)));
  };
  let split = r.steps.findIndex((st) => usesExtra(st, b.p.extras));
  if (split < 0) split = r.steps.length;
  for (const st of r.steps.slice(0, split)) step(st, fix);
  if (b.p.extras.length > 0) {
    for (const x of b.p.extras) {
      const dot = x.name.lastIndexOf('.');
      w.add('file', dot >= 0 ? x.name.slice(0, dot) : x.name, x.name, str(x.src.sha256), String(x.src.size || 0));
      for (const u of extraURLs(cat, x)) w.add('url', u);
      w.add('step', 'run', win ? `copy /y "{file}" "{tmp}\\${x.name}" >nul` : `cp "{file}" "{tmp}/${x.name}"`);
    }
    const later = (s) => fix(splitJoin(s, '{dir}', '{runtime_dir}'));
    for (const st of r.steps.slice(split)) step(st, later);
  }
  // Companion runtimes (policy "requires").
  const compPath = [];
  for (const n of b.p.needs) {
    const ce = n.p.rel;
    const cvt = versionTokens(ce.v);
    const cfix = (s) => fix(cvt(splitJoin(s, '{runtime_dir}', '{dir}')));
    w.add('file', n.req.runtime, fileName(ce), ce.sha256, String(ce.size));
    const cm = mirrorURL(cat, ce.local);
    const cseen = new Set();
    for (const u of [cm, ce.url, ...(ce.mirrors || []).map(str), cm]) {
      if (u !== '' && !cseen.has(u)) { cseen.add(u); w.add('url', u); }
    }
    for (const st of n.p.recipe.steps) {
      if (st.unpack != null) addUnpack(w, st, cfix(orDefault(str(st.to), '{dir}')));
      else if (st.run != null) w.add('step', 'run', cfix(goSprint(st.run)));
    }
    compPath.push('{dir:' + n.req.runtime + '}' + (n.req.bin !== '' ? (win ? '\\' : '/') + n.req.bin : ''));
  }
  if (r.executable !== '') w.add('exe', fix(r.executable));
  for (const p of compPath) w.add('path', p);
  // Package sources: the package policy adds to the recipe's environment
  // and replaces its project install command.
  const pkg = app.package !== '' && pol && isMap(pol.package) ? pol.package : null;
  // The install rule the record names, when it names one: it can carry both
  // a command and an environment for the install (policy install_rules).
  const ruleID = app.install.startsWith('default:') ? app.install.slice(8) : '';
  const rule = ruleID !== '' ? installRule(pol, ruleID) : null;
  const launchEnv = new Map(), installEnv = new Map();
  if (r.launch) mergeEnv(launchEnv, r.launch.env);
  if (r.projectInstall) mergeEnv(installEnv, r.projectInstall.env);
  if (rule) {
    mergeEnv(launchEnv, own(rule.env, b.family));
    mergeEnv(installEnv, own(rule.env, b.family));
    mergeEnv(installEnv, own(rule.ienv, b.family));
  }
  if (pkg) {
    mergeEnv(launchEnv, own(pkg.env, b.family));
    mergeEnv(installEnv, own(pkg.env, b.family));
    mergeEnv(installEnv, own(pkg.ienv, b.family));
  }
  const path = new Set();
  for (const k of [...launchEnv.keys()].sort(cmpStr)) {
    const v = launchEnv.get(k);
    if (v === null) w.add('unset', k);
    else w.add('env', k, fix(v));
  }
  if (r.launch) {
    for (const p of list(r.launch.path_prepend)) {
      path.add(fix(str(p)));
      w.add('path', fix(str(p)));
    }
  }
  // {env:NAME} in the app's own commands takes the value the plan gives NAME.
  const envVals = new Map();
  for (const m of [launchEnv, installEnv]) for (const [k, v] of m) if (v !== null) envVals.set(k, fix(v));
  const expandEnv = (s) => s.replace(envRefRe, (m) => nz(envVals.get(m.slice(5, -1)), ''));
  // Project install.
  let install = '';
  const lbl = runtimeLabel(pol, app.runtime);
  const pi = r.projectInstall;
  if (pkg && (app.install === '' || app.install === 'default')) {
    install = osCommand(pkg.install, e.v, b.family);
    if (install === '') w.add('fail', `Installing ${lbl} packages isn't supported on ${b.family} yet.`);
  } else if (app.install.startsWith('default:')) {
    const cmd = rule ? osCommand(rule.command, e.v, b.family) : '';
    if (!rule) w.add('fail', `This installer asks for a ${lbl} project install (${goQuote(ruleID)}) that Installer Builder doesn't know.`);
    else if (str(rule.unsupported) !== '') w.add('fail', rule.unsupported);
    else if (cmd !== '') install = cmd;
    else if (pi) install = str(pi.command);
  } else if (pol && osCommand(pol.install_command, e.v, b.family) !== '' && (app.install === 'default' || pol.compiled === true)) {
    install = osCommand(pol.install_command, e.v, b.family);
  } else if (app.install === 'default' || (pol && pol.compiled === true)) {
    if (pi) install = str(pi.command);
  } else if (app.install !== '') {
    install = quoteAppPaths(app.install);
  }
  if (install !== '') {
    for (const k of [...installEnv.keys()].sort(cmpStr)) {
      const v = installEnv.get(k);
      if (v === null) w.add('iunset', k);
      else w.add('ienv', k, fix(v));
    }
    if (pi) for (const p of list(pi.path_prepend)) if (!path.has(fix(str(p)))) w.add('path', fix(str(p)));
    if (pkg) install = packageTokens(pkg, app.package, app.packageVersion)(install);
    w.add('install', fix(expandEnv(install)));
  }
  // Launch: {runtime} is the runtime's program and its own flags.
  let launch = quoteAppPaths(app.launch);
  if (r.launch && typeof r.launch.program === 'string') {
    // An app without a console (record `console 0`) starts through the
    // runtime's windowed program where the recipe names one (pythonw.exe).
    const prog = !app.console && typeof r.launch.gui_program === 'string' && r.launch.gui_program !== '' ? r.launch.gui_program : r.launch.program;
    let rc = '"' + fix(prog) + '"';
    for (let a of list(r.launch.args)) {
      a = str(a);
      if (/[ \\/]/.test(a)) a = '"' + a + '"';
      rc += ' ' + fix(a);
    }
    launch = splitJoin(launch, '{runtime}', rc);
  }
  w.add('launch', fix(expandEnv(launch)));
}

/* ---------- runtimes summary (summary.go) ---------- */

// RuntimesSummary, as the object GET /api/catalog/runtimes answers; with
// `ids`, only those runtimes' entries (all must be loaded: loadRuntimes).
export function runtimesSummary(cat, ids) {
  const out = [];
  const want = ids ? new Set(ids) : null;
  for (const id of runtimeIDs(cat.policy)) {
    if (want && !want.has(id)) continue;
    const pol = runtimePolicy(cat, id);
    let plan;
    try { plan = resolve(cat, { recordHash: 'preview', runtime: id, launch: str(pol.launch) }); } catch (e_) {
      if (e_ && e_.notLoaded) throw e_;
      continue;
    }
    const e = { id, label: str(pol.label), compiled: pol.compiled === true, launch: str(pol.launch), newest: null };
    let cur = null;
    const push = () => { if (cur) ((e.newest || (e.newest = []))).push(cur); };
    for (const l of parseLines(plan)) {
      switch (l.key) {
        case 'when':
          push();
          cur = { family: l.val(0), arch: fields(l.val(3))[0], covers: '', version: null, file: null };
          break;
        case 'covers': if (cur) cur.covers = l.val(0); break;
        case 'runtime': if (cur) cur.version = l.val(1); break;
        case 'file': if (cur && cur.file === null) cur.file = l.val(1); break;
      }
    }
    push();
    out.push(e);
  }
  return { runtimes: out.length ? out : null };
}

/* ---------- packages (package.go) ---------- */

const pkgNameFloor = /^@?[A-Za-z0-9][A-Za-z0-9/._~-]{0,199}$/;
const pkgVersionRe = /^[A-Za-z0-9][A-Za-z0-9.*+!_-]{0,63}$/;
const defaultName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// Catalog.PackagePolicyFor
export function packagePolicyFor(cat, runtime) {
  const pol = runtimePolicy(cat, runtime);
  if (!pol) throw new Error('unknown runtime ' + goQuote(runtime));
  if (!isMap(pol.package)) throw new Error(`${runtimeLabel(pol, runtime)} has no package registry in Installer Builder yet; use a GitHub repo, a URL or code written here`);
  return pol.package;
}

// Catalog.ValidPackage: the name as it should be stored.
export function validPackage(cat, runtime, name, version = '') {
  const p = packagePolicyFor(cat, runtime);
  if (p.lower === true) name = goLower(name);
  let re = defaultName;
  if (str(p.name) !== '') {
    try { re = goRegExp(p.name); } catch (e) { throw new Error(`policy: bad package name pattern for ${runtime}: ${e.message}`); }
  }
  if (!pkgNameFloor.test(name) || !re.test(name) || name.includes('..')) {
    throw new Error(`${goQuote(name)} isn't a valid ${orDefault(str(p.registry), runtime)} package name`);
  }
  if (version !== '' && !pkgVersionRe.test(version)) throw new Error(`${goQuote(version)} isn't a valid package version`);
  return name;
}

// PackageTokens: a function replacing {package}, {name} and {version}.
export function packageTokens(p, name, version = '') {
  let spec = str((p == null ? undefined : p.spec_any));
  if (version !== '' && str((p == null ? undefined : p.spec)) !== '') spec = p.spec;
  if (spec === '') spec = '"{name}"';
  spec = replacer('{name}', name, '{version}', version)(spec);
  return replacer('{package}', spec, '{name}', name, '{version}', version);
}

// PackageProject
export function packageProject(p, name) {
  if (p && p.project_from === 'unscoped' && name.startsWith('@')) {
    const i = name.indexOf('/');
    if (i > 0) return name.slice(i + 1);
  }
  if (!p || p.project_from !== 'last') return name;
  const parts = name.replace(/^\/+|\/+$/g, '').split('/');
  let last = parts[parts.length - 1];
  if (parts.length > 1 && /^v[0-9]+$/.test(last)) last = parts[parts.length - 2];
  return last;
}

// PackageModule: {module}.
export function packageModule(name) {
  return goLower(name).replace(/[-.]/g, '_');
}

const binNameRe = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const binPathRe = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/;

// PickBin: {name, path} from a registry's bin field (a string, a list of
// names, or a map of name to path). Throws on unsafe names or paths.
export function pickBin(v, project) {
  const bins = [];
  if (typeof v === 'string') bins.push({ name: project, path: v });
  else if (Array.isArray(v)) { for (const x of v) if (typeof x === 'string') bins.push({ name: x, path: x }); }
  else if (isMap(v)) { for (const k of Object.keys(v)) if (typeof v[k] === 'string') bins.push({ name: k, path: v[k] }); }
  if (bins.length === 0) return { name: '', path: '' };
  let bi = -1;
  for (let i = 0; i < bins.length; i++) {
    if (bins[i].name === project) { bi = i; break; }
    if (bi < 0 || cmpStr(bins[i].name, bins[bi].name) < 0) bi = i;
  }
  const b = Object.assign({}, bins[bi]);
  if (b.path.startsWith('./')) b.path = b.path.slice(2);
  if (!binNameRe.test(b.name) || !binPathRe.test(b.path) || b.path.includes('..')) {
    throw new Error("the registry's program name or path has characters Installer Builder won't put in a command");
  }
  return b;
}

// JSONField: follow a dotted path ("info.version") into decoded JSON.
export function jsonField(v, path) {
  if (path === '') return null;
  for (const k of path.split('.')) {
    if (!isMap(v)) return null;
    v = own(v, k);
  }
  return (v != null ? v : null);
}
