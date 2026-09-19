// Catalogue changes kept in this browser (plan.md section 1.11, "The runtime
// catalogue editor"): an overlay of small changes on top of the catalogue
// catalogue built into the page (#ib-catalog and its folders), never a copy
// of it.
//
// The overlay, as stored and as exported:
//
//   { "ib-catalog-overlay": 1,
//     "changes": [
//       { "op": "replace", "path": ["python/releases.json", {url, version, os, arch, variant, format, kind}],
//         "value": {...the whole release...}, "was": "<hash of the built-in release>" },
//       { "op": "add", "id": "a1b2", "path": ["python/install.json", "recipes", "-"], "value": {...} },
//       { "op": "remove", "path": ["python/os_support.json", "rules", 4], "was": "<hash>" },
//       { "op": "replace", "path": ["policy.json", "runtimes", "python", "variants"], "value": [...], "was": "<hash>" } ] }
//
// A path starts with a file of the snapshot. After it come object keys and,
// last, one array element: an index (recipes and rules, which have no ids),
// a selector object (releases: the element whose fields all equal the
// selector's) or "-" (add at the end). Indexes and selectors always refer to
// the catalogue built into the page, not to the result of earlier changes,
// so changes don't shift each other. "was" guards replace and remove: if the
// page's catalogue has changed underneath (a newer page), the change is
// reported as not matching and skipped rather than applied to something else.
//
// Only the shapes the editor makes are accepted (a release, a recipe, a
// support rule, some runtime policy fields), and every value is checked
// (checkValue) before it is kept or applied: an imported or stored overlay is
// untrusted data.
//
// Storage: localStorage while small, IndexedDB beyond STORE_LS_MAX. Every
// access is wrapped: with storage blocked the overlay lives in memory for
// the tab, and the editor says so.
import { loadCatalogFiles, runtimesSummary, openCatalog, loadRuntimes, readChunk, SPLIT_FORMAT } from './resolve.js';

export const FORMAT = 'ib-catalog-overlay';
const KEY = 'ib.catalog.overlay';
const STORE_LS_MAX = 256 * 1024;       // characters kept in localStorage
const IDB_NAME = 'ib-catalog-overlay';
export const IMPORT_MAX = 8 * 1024 * 1024;
const VALUE_MAX = 256 * 1024;          // one change's value, as JSON
export const MAX_CHANGES = 5000;

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => (o != null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined);

/* ---------- hashes and canonical JSON ---------- */

export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (isMap(v)) return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// A 64-bit hash of a value's canonical JSON (two 32-bit FNV-1a lanes). It
// guards against applying a change to a different item, not against forgery.
export function hashValue(v) {
  const s = canon(v);
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

export const deepEqual = (a, b) => canon(a) === canon(b);
export const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

/* ---------- what a path points at ---------- */

const FILE_RE = /^(policy\.json|[a-z0-9_-]{1,40}\/(releases|install|os_support)\.json)$/;
export const RELEASE_ID = ['url', 'version', 'os', 'arch', 'variant', 'format', 'kind'];
// Runtime policy fields the editor changes.
export const POLICY_FIELDS = ['label', 'launch', 'versions', 'variants', 'only', 'exclude_variants', 'formats', 'kinds'];

// The kind of item a path names: release, recipe, rule, policy; or throws.
export function pathKind(path) {
  if (!Array.isArray(path) || path.length < 2 || path.length > 4) throw new Error('a change\'s path must name one item');
  const [file] = path;
  if (typeof file !== 'string' || !FILE_RE.test(file)) throw new Error('unknown catalogue file ' + JSON.stringify(String(file).slice(0, 60)));
  const last = path[path.length - 1];
  const elem = (x) => x === '-' || (Number.isInteger(x) && x >= 0 && x < 1e6);
  if (file.endsWith('/releases.json') && path.length === 2) {
    if (last === '-') return 'release';
    if (isMap(last) && Object.keys(last).every((k) => RELEASE_ID.includes(k)) && typeof last.url === 'string' &&
        Object.values(last).every((v) => v === null || typeof v === 'string')) return 'release';
    throw new Error('a release is named by its url, version, os, arch, variant, format and kind');
  }
  if (file.endsWith('/install.json') && path.length === 3 && path[1] === 'recipes' && elem(last)) return 'recipe';
  if (file.endsWith('/os_support.json') && path.length === 3 && path[1] === 'rules' && elem(last)) return 'rule';
  if (file === 'policy.json' && path.length === 4 && path[1] === 'runtimes' && typeof path[2] === 'string' &&
      /^[a-z0-9_-]{1,40}$/.test(path[2]) && POLICY_FIELDS.includes(last)) return 'policy';
  throw new Error('this editor doesn\'t make a change at ' + JSON.stringify(path).slice(0, 120));
}

// The runtime folder or id a change belongs to.
export function pathRuntime(path) {
  return path[0] === 'policy.json' ? path[2] : path[0].split('/')[0];
}

const selMatch = (el, sel) => isMap(el) && Object.keys(sel).every((k) => ((el[k] != null ? el[k] : null)) === sel[k]);

export function releaseSelector(r) {
  const s = {};
  for (const k of RELEASE_ID) s[k] = typeof r[k] === 'string' ? r[k] : null;
  return s;
}

// The built-in array a path's element lives in, and the element's index in
// it (-1 for "-"). {arr, index, container, key} or {error}.
function locate(files, path) {
  let container = files, key = path[0];
  let cur = own(files, path[0]);
  for (let i = 1; i < path.length - 1; i++) {
    container = cur;
    key = path[i];
    cur = own(cur, path[i]);
  }
  const last = path[path.length - 1];
  if (path[0] === 'policy.json') {
    if (!isMap(cur)) return { error: 'no runtime ' + JSON.stringify(path[2]) + ' in this catalogue' };
    return { obj: cur, key: last, exists: Object.hasOwn(cur, last) };
  }
  if (cur === undefined) return { arr: null, index: -1 };
  if (!Array.isArray(cur)) return { error: 'not a list in this catalogue' };
  if (last === '-') return { arr: cur, index: -1 };
  if (typeof last === 'number') return last < cur.length && cur[last] != null ? { arr: cur, index: last } : { error: 'not in this catalogue' };
  let found = -1;
  for (let i = 0; i < cur.length; i++) {
    if (selMatch(cur[i], last)) {
      if (found >= 0) return { error: 'matches more than one release' };
      found = i;
    }
  }
  return found < 0 ? { error: 'not in this catalogue' } : { arr: cur, index: found };
}

// The built-in value a path names (undefined for "-" or a missing field).
export function baseValue(files, path) {
  const l = locate(files, path);
  if (l.error) return undefined;
  if (l.obj) return l.obj[l.key];
  return l.index >= 0 ? l.arr[l.index] : undefined;
}

// The built-in index a path names (-1 for "-" or not found).
export function baseIndex(files, path) {
  const l = locate(files, path);
  return l.error || l.obj ? -1 : l.index;
}

/* ---------- checking values ---------- */

// Control and text-direction characters could disguise what an installer's
// review screen shows (builder.js hasControl); plan-bound strings may not
// have them at all, notes may have newlines and tabs.
function badChar(s, notes) {
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (notes && (c === 9 || c === 10 || c === 13)) continue;
    if (c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x200e || c === 0x200f || (c >= 0x202a && c <= 0x202e) ||
        (c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return true;
  }
  return false;
}

const SPEC_CLAUSE = /^(~=|==|!=|>=|<=|>|<)?\s*[A-Za-z0-9]([A-Za-z0-9._+~-]*[A-Za-z0-9])?(\.\*)?$/;
// A version spec as the resolver reads it ("", ">=3.9,<3.13", "==3.5.*").
// The resolver itself never fails on one; this refuses what it would
// misread.
export function specError(spec) {
  if (typeof spec !== 'string') return 'must be text';
  if (spec.trim() === '') return '';
  if (spec.length > 200) return 'too long';
  for (const raw of spec.split(',')) {
    const c = raw.trim();
    if (c === '') return 'an empty part between commas';
    if (!SPEC_CLAUSE.test(c)) return JSON.stringify(c) + ' isn\'t a version or a comparison like >=3.9 or ==3.5.*';
    if (/\.\*$/.test(c) && /^(>|<|>=|<=|~=)/.test(c)) return JSON.stringify(c) + ': .* only works with == or !=';
  }
  return '';
}

export function urlError(u) {
  if (typeof u !== 'string' || u === '') return 'a URL is needed';
  if (u.length > 2048) return 'too long';
  if (/\s/.test(u) || badChar(u)) return 'has spaces or control characters';
  let x;
  try { x = new URL(u); } catch (e) { return 'isn\'t a URL'; }
  if (x.protocol !== 'http:' && x.protocol !== 'https:') return 'must start with https:// or http://';
  if (!x.hostname) return 'has no host';
  return '';
}

export const SHA_RE = /^[0-9a-f]{64}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

// Collects {field, msg} problems; `warn` ones don't stop a save.
class Problems {
  constructor() { this.list = []; }
  err(field, msg) { this.list.push({ field, msg, warn: false }); }
  warn(field, msg) { this.list.push({ field, msg, warn: true }); }
  get errors() { return this.list.filter((p) => !p.warn); }
}

function checkStrings(v, p, field, depth = 0) {
  if (depth > 12) { p.err(field, 'nested too deeply'); return; }
  if (typeof v === 'string') { if (badChar(v, true)) p.err(field, 'has control or text-direction characters'); return; }
  if (typeof v === 'number') { if (!Number.isFinite(v)) p.err(field, 'isn\'t a number'); return; }
  if (v === null || typeof v === 'boolean') return;
  if (Array.isArray(v)) { v.forEach((x) => checkStrings(x, p, field, depth + 1)); return; }
  if (isMap(v)) { for (const k of Object.keys(v)) { if (badChar(k)) p.err(field, 'a key has control characters'); checkStrings(v[k], p, field + '.' + k, depth + 1); } return; }
  p.err(field, 'isn\'t JSON');
}

const strOrList = (v) => v === null || v === undefined || typeof v === 'string' ||
  (Array.isArray(v) && v.every((x) => x === null || typeof x === 'string'));
const listOf = (v, pred) => Array.isArray(v) && v.every(pred);
const planText = (p, field, s) => { if (typeof s === 'string' && badChar(s)) p.err(field, 'has control characters or a line break'); };

const RELEASE_KEYS = new Set(['version', 'os', 'arch', 'kind', 'format', 'variant', 'libc', 'url', 'mirrors', 'size', 'min_os', 'ib_sha256', 'ib_local', 'checksum']);
export const OSES = ['windows', 'macos', 'linux', 'aix', 'dragonfly', 'freebsd', 'illumos', 'netbsd', 'openbsd', 'plan9', 'solaris'];

function checkRelease(r, p) {
  if (!isMap(r)) { p.err('', 'a release is a JSON object'); return; }
  for (const k of Object.keys(r)) if (!RELEASE_KEYS.has(k)) p.err(k, 'isn\'t a release field');
  if (typeof r.version !== 'string' || !WORD.test(r.version)) p.err('version', 'a version like 3.12.4 is needed');
  if (!OSES.includes(r.os)) p.err('os', 'must be one of ' + OSES.slice(0, 3).join(', ') + '…');
  if (typeof r.arch !== 'string' || !/^[a-z0-9_]{1,20}$/.test(r.arch)) p.err('arch', 'an architecture like amd64, x86 or arm64 is needed');
  if (!['archive', 'installer', 'source'].includes(r.kind)) p.err('kind', 'must be archive, installer or source');
  if (typeof r.format !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,15}$/.test(r.format)) p.err('format', 'a format like zip, tar.gz or msi is needed');
  if (r.variant != null && (typeof r.variant !== 'string' || !/^[A-Za-z0-9._+-]{0,64}$/.test(r.variant))) p.err('variant', 'letters, digits and . _ + - only');
  if (r.libc != null && !['', 'glibc', 'musl'].includes(r.libc)) p.err('libc', 'must be glibc, musl or nothing');
  const ue = urlError(r.url);
  if (ue) p.err('url', ue);
  if (r.mirrors != null) {
    if (!Array.isArray(r.mirrors)) p.err('mirrors', 'a list of URLs');
    else r.mirrors.forEach((m, i) => {
      const e = urlError(m);
      if (e) p.err('mirrors.' + i, e);
      // Plans list each URL once, so a repeat changes nothing.
      else if (m === r.url || r.mirrors.indexOf(m) < i) p.warn('mirrors.' + i, m === r.url ? 'the same as the download URL, so plans skip it here' : 'listed already, so plans skip it here');
    });
  }
  if (r.ib_sha256 !== undefined && r.ib_sha256 !== '' && !(typeof r.ib_sha256 === 'string' && SHA_RE.test(r.ib_sha256))) {
    p.err('ib_sha256', 'a SHA-256 is 64 hex characters (0-9, a-f)');
  }
  if (!r.ib_sha256) p.warn('ib_sha256', 'with no SHA-256 the resolver never picks this release');
  if (r.size !== undefined && !(Number.isSafeInteger(r.size) && r.size >= 0)) p.err('size', 'a whole number of bytes');
  if (r.ib_local !== undefined && (typeof r.ib_local !== 'string' || r.ib_local.includes('..') || badChar(r.ib_local))) p.err('ib_local', 'a relative path');
  checkStrings(r, p, '');
}

const STEP_TYPES = ['run', 'unpack', 'write', 'mkdir'];
const STEP_KEYS = new Set(['unpack', 'to', 'strip_components', 'run', 'shell', 'write', 'text', 'mkdir', 'file']);
const MATCH_KEYS = new Set(['os', 'kind', 'format', 'arch', 'libc', 'variant', 'versions', 'runtime']);

export function stepType(st) {
  return STEP_TYPES.find((t) => isMap(st) && st[t] != null) || '';
}

function checkRecipe(r, p, ctx) {
  if (!isMap(r)) { p.err('', 'a recipe is a JSON object'); return; }
  if (r.match != null) {
    if (!isMap(r.match)) p.err('match', 'an object');
    else {
      for (const k of Object.keys(r.match)) {
        if (!MATCH_KEYS.has(k)) p.err('match.' + k, 'isn\'t a match field');
        else if (k === 'versions') { const e = r.match.versions == null ? '' : specError(r.match.versions); if (e) p.err('match.versions', e); }
        else if (!strOrList(r.match[k])) p.err('match.' + k, 'text, a list, or nothing');
      }
    }
  }
  if (typeof r.method !== 'string' || !/^[a-z_]{1,20}$/.test(r.method)) p.err('method', 'a method is needed');
  else if (ctx && Array.isArray(ctx.methods) && !ctx.methods.includes(r.method)) p.warn('method', 'not in the policy\'s method_order (' + ctx.methods.join(', ') + '), so this recipe is never picked');
  if (r.isolation != null && !['', 'full', 'leaks', 'impossible'].includes(r.isolation)) p.err('isolation', 'full, leaks or impossible');
  if (r.executable != null && typeof r.executable !== 'string') p.err('executable', 'text');
  planText(p, 'executable', r.executable);
  if (!Array.isArray(r.steps)) p.err('steps', 'a list of steps');
  else {
    if (r.steps.length === 0) p.warn('steps', 'no steps: nothing is installed');
    r.steps.forEach((st, i) => {
      const f = 'steps.' + i;
      if (!isMap(st)) { p.err(f, 'a step is an object'); return; }
      for (const k of Object.keys(st)) if (!STEP_KEYS.has(k)) p.err(f + '.' + k, 'isn\'t a step field');
      if (Object.hasOwn(st, 'file')) p.warn(f + '.file', 'the resolver skips recipes with a "file" step');
      const types = STEP_TYPES.filter((t) => st[t] != null);
      if (types.length !== 1) { p.err(f, types.length ? 'a step does one thing: ' + types.join(' or ') : 'a step with no command'); return; }
      const t = types[0];
      if (t === 'run') {
        if (typeof st.run !== 'string' || st.run.trim() === '') p.err(f + '.run', 'a step with no command');
        planText(p, f + '.run', st.run);
        if (st.run && st.run.length > 4000) p.err(f + '.run', 'too long');
      } else if (t === 'unpack') {
        if (typeof st.unpack !== 'string' || !/^[a-z0-9][a-z0-9.-]{0,15}$/.test(st.unpack)) p.err(f + '.unpack', 'what to unpack as: zip, tar.gz, 7z, msi…');
        if (st.to != null && typeof st.to !== 'string') p.err(f + '.to', 'a folder');
        planText(p, f + '.to', st.to);
        if (st.strip_components != null && !(Number.isInteger(st.strip_components) && st.strip_components >= 0 && st.strip_components < 20)) p.err(f + '.strip_components', 'a small whole number');
      } else if (t === 'write') {
        if (typeof st.write !== 'string' || st.write.trim() === '') p.err(f + '.write', 'the file to write');
        if (st.text != null && typeof st.text !== 'string') p.err(f + '.text', 'text');
        planText(p, f + '.write', st.write);
        planText(p, f + '.text', st.text);
      } else if (t === 'mkdir') {
        if (typeof st.mkdir !== 'string' || st.mkdir.trim() === '') p.err(f + '.mkdir', 'the folder to make');
        planText(p, f + '.mkdir', st.mkdir);
      }
    });
  }
  if (r.launch != null) {
    const l = r.launch;
    if (!isMap(l)) p.err('launch', 'an object');
    else {
      if (l.program != null && typeof l.program !== 'string') p.err('launch.program', 'text');
      planText(p, 'launch.program', l.program);
      if (l.args != null && !listOf(l.args, (x) => typeof x === 'string')) p.err('launch.args', 'a list of text');
      else (l.args || []).forEach((a, i) => planText(p, 'launch.args.' + i, a));
      if (l.env != null && !(isMap(l.env) && Object.values(l.env).every((x) => x === null || typeof x === 'string'))) p.err('launch.env', 'names to text');
      else for (const [k, v] of Object.entries(l.env || {})) { planText(p, 'launch.env', k); planText(p, 'launch.env.' + k, v); }
      if (l.path_prepend != null && !listOf(l.path_prepend, (x) => typeof x === 'string')) p.err('launch.path_prepend', 'a list of folders');
    }
  }
  if (r.project_install != null && !isMap(r.project_install)) p.err('project_install', 'an object');
  else if (r.project_install) planText(p, 'project_install.command', r.project_install.command);
  checkStrings(r, p, '');
}

function osIds(ctx, family) {
  const raw = ctx && ctx.osVersions;
  if (!isMap(raw)) return null;
  const ids = (l) => (Array.isArray(l) ? l.map((x) => x && x.id).filter((x) => typeof x === 'string') : []);
  if (family === 'windows') return ids(raw.windows);
  if (family === 'macos') return ids(raw.macos);
  if (family === 'linux') return [...ids(raw.linux_glibc), ...ids(raw.linux_musl)];
  return [];
}

function checkRule(r, p, ctx) {
  if (!isMap(r)) { p.err('', 'a support rule is a JSON object'); return; }
  if (!OSES.includes(r.os)) p.err('os', 'must be windows, macos or linux');
  const e = r.versions == null ? '' : specError(r.versions);
  if (e) p.err('versions', e);
  const ids = osIds(ctx, r.os);
  for (const k of ['min_os', 'max_os']) {
    if (r[k] == null) continue;
    if (typeof r[k] !== 'string') p.err(k, 'an OS version id');
    else if (ids && !ids.includes(r[k])) p.err(k, JSON.stringify(r[k]) + ' isn\'t an OS version the catalogue knows for ' + r.os);
  }
  if (r.min_os == null) p.warn('min_os', 'with no lowest OS version the rule is ignored');
  if (r.min_build != null && !(typeof r.min_build === 'number' && r.min_build >= 0)) p.err('min_build', 'a Windows build number');
  else if (r.min_build != null && (!Number.isInteger(r.min_build) || r.os !== 'windows')) p.warn('min_build', 'only a whole Windows build number is used');
  for (const k of ['arch', 'format', 'kind', 'variant']) if (!strOrList(r[k])) p.err(k, 'text, a list, or nothing');
  if (r.match != null && !isMap(r.match)) p.err('match', 'an object');
  if (r.file_match != null) {
    if (typeof r.file_match !== 'string') p.err('file_match', 'a pattern');
    else {
      try { new RegExp(r.file_match.replace(/\(\?P</g, '(?<').replace(/^\(\?[imsU]+\)/, '')); } catch (x) { p.err('file_match', 'isn\'t a valid pattern'); }
    }
  }
  if (r.plan_floor != null && typeof r.plan_floor !== 'boolean') p.err('plan_floor', 'true or false');
  checkStrings(r, p, '');
}

function checkPolicy(field, v, p) {
  const strList = (x) => Array.isArray(x) && x.every((s) => typeof s === 'string' && /^[A-Za-z0-9._+-]{0,64}$/.test(s));
  switch (field) {
    case 'label': if (typeof v !== 'string' || v.trim() === '' || v.length > 80 || badChar(v)) p.err(field, 'a short name'); break;
    case 'launch': if (typeof v !== 'string' || v.length > 400 || badChar(v)) p.err(field, 'a command on one line'); break;
    case 'versions': { const e = specError(v); if (e) p.err(field, e); break; }
    case 'variants': if (!strList(v)) p.err(field, 'a list of variant names'); break;
    case 'only': if (typeof v !== 'boolean') p.err(field, 'true or false'); break;
    case 'exclude_variants': case 'kinds': if (v !== null && !strList(v)) p.err(field, 'a list, or nothing'); break;
    case 'formats':
      if (v !== null && !(isMap(v) && Object.entries(v).every(([k, l]) => OSES.includes(k) && (l === null || strList(l))))) p.err(field, 'formats per OS');
      break;
    default: p.err(field, 'not a field this editor changes');
  }
}

// Problems with a value for a path: [{field, msg, warn}]. ctx: {methods,
// osVersions} from the catalogue, for the checks that need it.
export function checkValue(kind, value, ctx, field) {
  const p = new Problems();
  const size = (() => { try { return JSON.stringify(value).length; } catch (e) { return Infinity; } })();
  if (size > VALUE_MAX) { p.err('', 'too big'); return p.list; }
  if (kind === 'release') checkRelease(value, p);
  else if (kind === 'recipe') checkRecipe(value, p, ctx);
  else if (kind === 'rule') checkRule(value, p, ctx);
  else if (kind === 'policy') checkPolicy(field, value, p);
  else p.err('', 'unknown kind');
  return p.list;
}

export function contextOf(files) {
  const pol = own(files, 'policy.json');
  return { methods: Array.isArray(own(pol, 'method_order')) ? pol.method_order : null, osVersions: own(files, 'os_versions.json') };
}

// Checks one change's shape (not yet against a catalogue). Returns a clean
// copy with only the known fields, or throws.
export function checkChange(c) {
  if (!isMap(c)) throw new Error('a change is an object');
  const op = c.op;
  if (!['add', 'replace', 'remove'].includes(op)) throw new Error('a change\'s op is add, replace or remove');
  const kind = pathKind(c.path);
  const last = c.path[c.path.length - 1];
  const out = { op, path: clone(c.path) };
  if (op === 'add') {
    if (kind !== 'policy' && last !== '-') throw new Error('an added item\'s path ends in "-"');
    if (kind !== 'policy') {
      if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(c.id)) throw new Error('an added item needs an id');
      out.id = c.id;
    }
  } else {
    if (last === '-') throw new Error('only an add ends in "-"');
    if (typeof c.was !== 'string' || !/^[0-9a-f]{16}$/.test(c.was)) throw new Error('a replace or remove needs "was", the hash of what it changes');
    out.was = c.was;
  }
  if (op !== 'remove') {
    if (c.value === undefined) throw new Error('an add or replace needs a value');
    out.value = clone(c.value);
  }
  if (op === 'remove' && kind === 'policy') throw new Error('policy fields are changed, not removed');
  return out;
}

// A key naming the item a change is about: one change per item.
export function changeKey(c) {
  return c.op === 'add' && c.id ? 'add:' + c.path[0] + ':' + c.id : canon(c.path);
}

/* ---------- applying ---------- */

// Status of each change against the built-in files: {ok, why}. A change is
// applied only if its path finds the item it was made for and its value
// passes checkValue.
export function changeStatus(files, c, ctx = contextOf(files)) {
  let kind;
  try { kind = pathKind(c.path); } catch (e) { return { ok: false, why: e.message }; }
  const l = locate(files, c.path);
  if (l.error) return { ok: false, why: l.error, stale: true };
  if (c.op === 'add' && kind === 'policy' && l.exists) return { ok: false, why: 'this catalogue already has this field', stale: true };
  if (c.op !== 'add') {
    const cur = l.obj ? (l.exists ? l.obj[l.key] : undefined) : l.index >= 0 ? l.arr[l.index] : undefined;
    if (cur === undefined && !(kind === 'policy' && c.op === 'replace')) return { ok: false, why: 'not in this catalogue', stale: true };
    if (hashValue(cur) !== c.was) return { ok: false, why: 'this page\'s catalogue has a different version of it', stale: true };
  }
  if (c.op !== 'remove') {
    const errs = checkValue(kind, c.value, ctx, c.path[c.path.length - 1]).filter((p) => !p.warn);
    if (errs.length) return { ok: false, why: (errs[0].field ? errs[0].field + ': ' : '') + errs[0].msg, invalid: true };
  }
  return { ok: true, why: '' };
}

// The files with the changes applied (copy-on-write: the built-in files are
// never modified). Returns {files, status: [{ok, why}] per change}.
export function applyOverlay(files, changes) {
  const ctx = contextOf(files);
  const status = changes.map((c) => changeStatus(files, c, ctx));
  const out = Object.assign({}, files);
  // Per array: replacements and removals by built-in index, then additions.
  const arrays = new Map();
  const cloned = new Set();
  const cow = (parent, key) => {
    const v = parent[key];
    if (cloned.has(v)) return v;
    const c = Array.isArray(v) ? v.slice() : isMap(v) ? Object.assign({}, v) : v === undefined ? {} : v;
    parent[key] = c;
    cloned.add(c);
    return c;
  };
  changes.forEach((c, i) => {
    if (!status[i].ok) return;
    const path = c.path;
    // Walk (and copy) down to the container.
    let parent = out, key = path[0];
    for (let j = 1; j < path.length - 1; j++) {
      const node = cow(parent, key);
      parent = node;
      key = path[j];
    }
    const last = path[path.length - 1];
    if (path[0] === 'policy.json') {
      const node = cow(parent, key);
      node[last] = clone(c.value);
      return;
    }
    const base = parent === out ? files[key] : parent[key];
    const id = path.slice(0, -1).join(' ');
    if (!arrays.has(id)) arrays.set(id, { parent, key, base: Array.isArray(base) ? base : [], repl: new Map(), removed: new Set(), added: [] });
    const a = arrays.get(id);
    a.parent = parent;
    if (c.op === 'add') { a.added.push(clone(c.value)); return; }
    const idx = locate(files, path).index;
    if (c.op === 'remove') a.removed.add(idx);
    else a.repl.set(idx, clone(c.value));
  });
  for (const a of arrays.values()) {
    const arr = [];
    a.base.forEach((x, i) => { if (!a.removed.has(i)) arr.push(a.repl.has(i) ? a.repl.get(i) : x); });
    arr.push(...a.added);
    a.parent[a.key] = arr;
  }
  return { files: out, status };
}

/* ---------- the page's catalogue ---------- */

// The page carries its catalogue split by folder (tools/build_site.py;
// docs/format.md section 6), so only what's used is unpacked:
//   #ib-catalog      the index, JSON: the shared files (policy.json,
//                    os_versions.json, compilers_min_os.json), the folders
//                    with their release counts, and the runtimes summary
//   #ib-cat-FOLDER   one folder's files, gzipped, base64
function block(id) {
  const el = typeof document !== 'undefined' && document.getElementById(id);
  return el && !el.dataset.placeholder ? el.textContent : null;
}

function blockBytes(id) {
  const t = block(id);
  if (t == null) return null;
  const s = atob(t.replace(/\s+/g, ''));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

let index;
// The catalogue's index (#ib-catalog), parsed once; null if the page has
// none. Throws if it is there but unreadable.
export function catalogIndex() {
  if (index === undefined) {
    const t = block('ib-catalog');
    if (t == null) index = null;
    else {
      let ix;
      try { ix = JSON.parse(t); } catch (e) { throw new Error('the catalogue in this page is damaged: ' + e.message); }
      if (own(ix, SPLIT_FORMAT) !== 1) throw new Error('catalogue index version ' + own(ix, SPLIT_FORMAT));
      if (!isMap(ix.files) || !isMap(ix.folders)) throw new Error('the catalogue in this page is damaged');
      index = ix;
    }
  }
  return index;
}

export function hasCatalog() { return block('ib-catalog') != null; }

// The folders the page's catalogue has, and each one's release count.
export function catalogFolders() {
  const ix = catalogIndex();
  const out = {};
  if (ix) for (const f of Object.keys(ix.folders)) out[f] = { releases: Number(ix.folders[f].releases) || 0 };
  return out;
}

let filesPromise = null;
const loadedFolders = new Set();
const pendingFolders = new Map();
// The catalogue files built into the page, named as in a snapshot, shared
// and treated as read-only: the shared files at first, and each folder's
// files once ensureFolders has unpacked it.
export function baseFiles() {
  if (!filesPromise) {
    filesPromise = Promise.resolve().then(() => {
      const ix = catalogIndex();
      if (!ix) throw new Error('This page has no catalogue inside it.');
      return Object.assign({}, ix.files);
    });
    filesPromise.catch(() => { filesPromise = null; });
  }
  return filesPromise;
}

// Unpacks these folders' files into baseFiles() (once each). Names that
// aren't folders of the page's catalogue are skipped. Resolves to the files.
export async function ensureFolders(folders) {
  const files = await baseFiles();
  const ix = catalogIndex();
  await Promise.all([...new Set(folders)].filter((f) => typeof f === 'string' && Object.hasOwn(ix.folders, f) && !loadedFolders.has(f)).map((f) => {
    let p = pendingFolders.get(f);
    if (!p) {
      p = (async () => {
        const bytes = blockBytes('ib-cat-' + f);
        if (!bytes) throw new Error('the catalogue in this page has no ' + f + ' folder');
        Object.assign(files, await readChunk(bytes, f));
        loadedFolders.add(f);
      })();
      pendingFolders.set(f, p);
      p.catch(() => pendingFolders.delete(f));
    }
    return p;
  }));
  return files;
}

export const folderLoaded = (f) => loadedFolders.has(f);
// The folders unpacked so far (tests read it: ibLocalApi.unpacked()).
export const unpackedFolders = () => [...loadedFolders].sort();

// The folder a runtime's files are in (python2's are python's).
export function runtimeFolder(policy, id) {
  const p = own(own(policy, 'runtimes'), id);
  return (isMap(p) && typeof p.folder === 'string' && p.folder) || id;
}

// The folders changes are about (a policy change needs none).
export function changedFolders(changes) {
  const out = new Set();
  for (const c of changes) if (Array.isArray(c.path) && c.path[0] !== 'policy.json' && typeof c.path[0] === 'string') out.add(c.path[0].split('/')[0]);
  return out;
}

// Unpacks what previews of these runtimes need (subsetCatalog below), and
// the folders `changes` are about, so their status can be worked out.
export async function ensureRuntimes(ids, changes = []) {
  const files = await baseFiles();
  const policy = files['policy.json'];
  return ensureFolders([...relatedRuntimes(policy, ids).map((id) => runtimeFolder(policy, id)), ...changedFolders(changes)]);
}

// Runtime ids whose plans can depend on `ids` (and those they depend on):
// "via" and "requires" in the policy.
export function relatedRuntimes(policy, ids) {
  const rts = isMap(own(policy, 'runtimes')) ? policy.runtimes : {};
  const deps = (id) => {
    const p = own(rts, id);
    const out = [];
    if (!isMap(p)) return out;
    if (isMap(p.via)) out.push(...Object.values(p.via).filter((x) => typeof x === 'string'));
    if (isMap(p.requires)) for (const l of Object.values(p.requires)) if (Array.isArray(l)) out.push(...l.map((r) => r && r.runtime).filter((x) => typeof x === 'string'));
    return out;
  };
  const set = new Set(ids);
  // Folders: a runtime whose files are another's (python2 in python/).
  const folder = (id) => (isMap(own(rts, id)) && typeof rts[id].folder === 'string' && rts[id].folder) || id;
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of Object.keys(rts)) {
      if (set.has(id)) { for (const d of deps(id)) if (!set.has(d) && own(rts, d)) { set.add(d); grew = true; } continue; }
      if (deps(id).some((d) => set.has(d)) || [...set].some((s) => folder(s) === folder(id))) { set.add(id); grew = true; }
    }
  }
  return [...set].filter((id) => isMap(own(rts, id))).sort();
}

// A catalogue of just these runtimes (and what they need), for previews.
// Their folders must be in `files` (ensureRuntimes).
export function subsetCatalog(files, ids) {
  const policy = own(files, 'policy.json');
  const keep = relatedRuntimes(policy, ids);
  const rts = {};
  for (const id of keep) rts[id] = policy.runtimes[id];
  const sub = Object.assign({}, files, { 'policy.json': Object.assign({}, policy, { runtimes: rts }) });
  return loadCatalogFiles(sub);
}

/* ---------- the overlay in this browser ---------- */

const state = {
  changes: [],          // checked changes, in order
  loaded: false,
  storage: 'ok',        // ok | memory (storage blocked) | error
  storageWhy: '',
  where: '',            // localStorage | indexeddb
  from: '',             // '' | 'stored' | 'page' (adopted from the page's #ib-overlay)
  version: 0,
};

export function overlayState() {
  return { changes: state.changes.slice(), storage: state.storage, storageWhy: state.storageWhy, where: state.where, from: state.from, version: state.version };
}

// Parses an overlay document (stored, imported or built into the page):
// {changes: [clean changes], rejected: [{index, why}]}. Throws if it isn't
// one at all.
export function parseOverlay(doc) {
  if (typeof doc === 'string') {
    if (doc.length > IMPORT_MAX) throw new Error('That file is too big to be a catalogue overlay.');
    try { doc = JSON.parse(doc); } catch (e) { throw new Error('That file isn\'t JSON.'); }
  }
  if (!isMap(doc) || own(doc, FORMAT) !== 1) throw new Error('That file isn\'t a TiddlyInstall catalogue overlay ("' + FORMAT + '": 1).');
  const list = own(doc, 'changes');
  if (!Array.isArray(list)) throw new Error('The overlay has no list of changes.');
  if (list.length > MAX_CHANGES) throw new Error('The overlay has more than ' + MAX_CHANGES + ' changes.');
  const changes = [], rejected = [];
  const seen = new Map();
  list.forEach((c, i) => {
    try {
      const x = checkChange(c);
      const k = changeKey(x);
      if (seen.has(k)) changes[seen.get(k)] = x;   // the later one wins
      else { seen.set(k, changes.length); changes.push(x); }
    } catch (e) { rejected.push({ index: i, why: e.message }); }
  });
  return { changes, rejected };
}

export function overlayDoc(changes = state.changes) {
  return { [FORMAT]: 1, changes };
}

function lsGet() { return localStorage.getItem(KEY); }

function idb(mode, f) {
  return new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onerror = () => rej(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('kv', mode);
        const r = f(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); res(r && r.result); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      } catch (e) { db.close(); rej(e); }
    };
  });
}

async function readStored() {
  const t = lsGet();
  if (t == null) return null;
  const doc = JSON.parse(t);
  if (isMap(doc) && doc.in === 'indexeddb') {
    const big = await idb('readonly', (s) => s.get(KEY));
    if (typeof big !== 'string') throw new Error('the changes kept in IndexedDB are missing');
    return { doc: big, where: 'indexeddb' };
  }
  return { doc, where: 'localStorage' };
}

async function writeStored(changes) {
  const text = JSON.stringify(overlayDoc(changes));
  if (text.length <= STORE_LS_MAX) {
    localStorage.setItem(KEY, text);
    try { await idb('readwrite', (s) => s.delete(KEY)); } catch (e) { /* nothing there, or no IndexedDB */ }
    return 'localStorage';
  }
  await idb('readwrite', (s) => s.put(text, KEY));
  localStorage.setItem(KEY, JSON.stringify({ [FORMAT]: 1, in: 'indexeddb', changes: [] }));
  return 'indexeddb';
}

function emit() {
  state.version++;
  catalogCache = null;
  try { window.dispatchEvent(new CustomEvent('ib-overlay-change', { detail: { count: state.changes.length } })); } catch (e) { /* not a browser */ }
}

// The overlay built into the page by "Save this page" (#ib-overlay), if any.
export function pageOverlay() {
  const t = block('ib-overlay');
  if (!t || t.trim() === '' || t.trim() === 'null') return null;
  try { return parseOverlay(t); } catch (e) { return { changes: [], rejected: [{ index: -1, why: e.message }] }; }
}

let loadPromise = null;
// Loads the overlay once: this browser's stored one, else the page's own.
export function loadOverlay() {
  if (!loadPromise) {
    loadPromise = (async () => {
      let stored = null;
      try {
        stored = await readStored();
      } catch (e) {
        state.storage = 'memory';
        state.storageWhy = 'This browser won\'t let the page keep data (' + (e && e.message ? e.message : e) + '). Changes last until the tab is closed; export them to keep them.';
      }
      if (stored) {
        try {
          state.changes = parseOverlay(stored.doc).changes;
          state.where = stored.where;
          state.from = 'stored';
        } catch (e) {
          state.storageWhy = 'The changes kept in this browser couldn\'t be read (' + e.message + '). Making a change here replaces them.';
          state.storage = 'error';
        }
      } else {
        const po = pageOverlay();
        if (po && po.changes.length) { state.changes = po.changes; state.from = 'page'; }
      }
      state.loaded = true;
      emit();
      return overlayState();
    })();
  }
  return loadPromise;
}

async function persist() {
  if (state.storage === 'memory') { emit(); return; }
  try {
    state.where = await writeStored(state.changes);
    state.storage = 'ok';
    state.storageWhy = '';
    state.from = 'stored';
  } catch (e) {
    state.storage = 'memory';
    state.storageWhy = 'Couldn\'t keep the changes in this browser (' + (e && e.message ? e.message : e) + '). They last until the tab is closed; export them to keep them.';
  }
  emit();
}

// Replaces the whole list (import "replace", reset all).
export async function setChanges(changes) {
  await loadOverlay();
  state.changes = changes.map(checkChange);
  await persist();
}

// Adds or replaces the change for one item (null value with key: revert).
export async function putChange(c) {
  await loadOverlay();
  const x = checkChange(c);
  const k = changeKey(x);
  const i = state.changes.findIndex((y) => changeKey(y) === k);
  if (i >= 0) state.changes[i] = x;
  else state.changes.push(x);
  await persist();
}

// Several at once, saved once: `puts` are changes to add or replace,
// `reverts` keys of changes to drop.
export async function editChanges(puts, reverts = []) {
  await loadOverlay();
  const drop = new Set(reverts);
  let list = state.changes.filter((c) => !drop.has(changeKey(c)));
  for (const c of puts) {
    const x = checkChange(c);
    const k = changeKey(x);
    const i = list.findIndex((y) => changeKey(y) === k);
    if (i >= 0) list[i] = x;
    else list.push(x);
  }
  state.changes = list;
  await persist();
}

export async function revertChange(key) {
  await loadOverlay();
  state.changes = state.changes.filter((c) => changeKey(c) !== key);
  await persist();
}

// Another tab changed the stored overlay.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY || !state.loaded) return;
    loadPromise = null;
    state.loaded = false;
    loadOverlay();
  });
}

/* ---------- the catalogue with the changes, for building ---------- */

let catalogCache = null;
// {catalog, applied, changes, id, version, files}: the page's catalogue with
// this browser's changes. `applied` counts the changes that took effect.
// `catalog` loads each runtime's folder when asked (js/resolve.js
// openCatalog: loadRuntimes before resolving); the folders the changes are
// about are unpacked here, to apply them, and `files` has only those and the
// shared files.
export function effectiveCatalog() {
  if (!catalogCache) {
    catalogCache = (async () => {
      const [base] = await Promise.all([baseFiles(), loadOverlay()]);
      const version = state.version;
      const changes = state.changes;
      const touched = changedFolders(changes);
      await ensureFolders([...touched]);
      const { files: eff, status } = applyOverlay(base, changes);
      const applied = changes.filter((c, i) => status[i].ok);
      const shared = {};
      for (const k of Object.keys(eff)) if (k.indexOf('/') < 0) shared[k] = eff[k];
      const folderFiles = (from, folder) => {
        const out = {};
        for (const k of Object.keys(from)) if (k.startsWith(folder + '/')) out[k] = from[k];
        return out;
      };
      const catalog = openCatalog(shared, async (folder) => {
        if (touched.has(folder)) return folderFiles(eff, folder);
        return folderFiles(await ensureFolders([folder]), folder);
      });
      return { catalog, applied: applied.length, changes: applied, id: applied.length ? hashValue(applied) : '', version, files: eff };
    })();
    catalogCache.catch(() => { catalogCache = null; });
  }
  return catalogCache;
}

// GET /api/catalog/runtimes for the changed catalogue: the page's summary
// (built in, #ib-catalog) with the entries of the runtimes the changes can
// affect worked out again.
export async function effectiveSummary() {
  const ix = catalogIndex();
  const embedded = (ix && ix.summary) || { runtimes: null };
  const eff = await effectiveCatalog();
  if (!eff.applied) return embedded;
  const policy = eff.files['policy.json'];
  const folders = new Set(eff.changes.map((c) => pathRuntime(c.path)));
  const ids = Object.keys(policy.runtimes || {}).filter((id) => folders.has(id) || folders.has(runtimeFolder(policy, id)));
  const redo = relatedRuntimes(policy, ids);
  await loadRuntimes(eff.catalog, redo);
  const fresh = runtimesSummary(eff.catalog, redo).runtimes || [];
  const out = [];
  for (const e of (embedded && embedded.runtimes) || []) {
    if (!redo.includes(e.id)) { out.push(e); continue; }
    const f = fresh.find((x) => x.id === e.id);
    if (f) out.push(f);
  }
  return { runtimes: out.length ? out : null, changed: eff.applied };
}

/* ---------- "Save this page" with the changes inside ---------- */

const OVERLAY_BLOCK = /(<script type="application\/json" id="ib-overlay"[^>]*>)[\s\S]*?(<\/script>)/;

// The page's HTML with `changes` as its built-in overlay (#ib-overlay).
// The JSON can't end the script early: every < is written as \u003c.
export function bakeOverlay(html, changes) {
  const json = JSON.stringify(overlayDoc(changes)).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (OVERLAY_BLOCK.test(html)) return html.replace(OVERLAY_BLOCK, (m, a, b) => a.replace(/\sdata-placeholder="[^"]*"/, '') + '\n' + json + '\n' + b);
  return html.replace(/<script type="module">/, '<script type="application/json" id="ib-overlay">\n' + json + '\n</script>\n  <script type="module">');
}
