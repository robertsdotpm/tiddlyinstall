// The job builder shared by the build server (server/, Node) and the
// offline page (plan.md section 1.11): a POST /api/jobs request
// (docs/api.md) to its record, plans and installer files, following
// docs/format.md. Everything that differs between the two lives in `env`:
//
//   env.catalog        a Catalog from shared/resolve.js: all loaded (loadCatalogFiles),
//                      or loaded a folder at a time (openCatalog; runJob loads
//                      what the job needs)
//   env.base(plat)     the unsigned base for "windows" | "linux" | "macos" (bytes);
//                      may throw its own "missing" error
//   env.signedBase(plat)  mode A: {data, signedBy} for our signed base, or
//                      null (the unsigned base is used, and says so)
//   env.backend        written into records
//   env.product        the name in messages (default "TiddlyInstall"; the
//                      server says "Installer Builder" until the bases are
//                      renamed, plan.md "Open work")
//   env.modes          the modes this builder makes (default ["B", "C"])
//   env.packRuntimes   true: offline installers (every download packed) are
//                      allowed; they need env.packPlan
//   env.fetch          fetch() for package registries (the browser's)
//   env.registryJSON(tmpl, name, version)  the server's registry lookups:
//                      cached, public addresses only, Go's messages; throws
//                      an error with .noPackage for a 404 or 410
//   env.fetchSource(r) GitHub and URL sources -> {sha256, size, names,
//                      project}, plus {origin, commit} for GitHub; absent:
//                      those sources are refused
//   env.storeSource(sha256, data)  keeps a written (inline) source
//   env.storeRecord(hash, record)  publishes the record (the server refuses
//                      a truncated-hash collision)
//   env.takenDown(entry)  true if the takedown list has this entry
//   env.revoked()      the SHA-256s the revocation list names (design.md
//                      7.1): the resolver skips those builds, here as on
//                      the build server. A page with no backend has no
//                      list and doesn't call it; the installer's own
//                      check is the backstop there
//   env.iconPng(icon)  the icon's PNG bytes, or null (the server loads its
//                      stored upload by icon.sha256); default: icon.data
//   env.packPlan(hash, plat, progress)  offline: {plan (signed), files:
//                      [{name: sha256, size, data | path, read()}]}
//   env.save(hash, name, spec)  the server writes the file itself and
//                      returns {size, sha256}. spec is {data} or, for .exe
//                      and .run, {layout: {base, record, plan, pack,
//                      fixChecksum}} so large packs can be streamed
//   env.embedPlan      true: each installer carries its plan and packs the
//                      app's source, so it needs no build server (offline page)
//   env.signPlan(plan) signs an embedded plan (optional)
//   env.now()          the record's `created` time, and the plan's `signed`
//                      (default: now)
import { toBytes, sha256Hex, recordHash, readInstaller, writeInstaller, tarWrite, installerExt, zipWrite, peInfo, zipRead, zipEntryData, zipUnixMode, zipIsDir, zipIsSymlink } from './tifile.js';
import { resolve, resolveFiles, loadRuntimes, hasRuntime, validPackage, packagePolicyFor, packageProject, packageModule, pickBin, jsonField, goQuote, replacer, setRevoked } from './resolve.js';
import { rasterSource, buildIco, buildIcns, setExeIcon, setMacIcon, checkIconPng } from './icon.js';
import { inflate, deflate } from '../web/lib/zlib.js';

const enc = new TextEncoder();

// A request the builder refuses: the server answers 400 with it.
export class RequestError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
    this.code = 'invalid';
  }
}

/* ---------- checks: build.Request.Validate ---------- */

const versionRe = /^[A-Za-z0-9.*+!_-]{1,64}$/;
const projectRe = /^[A-Za-z0-9_.-]{1,64}$/;
const safeName = /[^a-z0-9_.-]+/g;
export const githubRe = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const PLATFORMS = ['windows', 'linux', 'macos'];
const EXT = { windows: '.exe', linux: '.run', macos: '.zip' };

// Pack limits: NSIS reads the block with 32-bit arithmetic (format.md 4),
// and the macOS zip is built in memory.
export const MAX_PACK = 2000 * 1024 * 1024;
export const MAX_MAC_PACK = 1000 * 1024 * 1024;

export function hasControl(s) {
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c < 0xa0) || (c >= 0x200e && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

const bad = (msg) => new RequestError(msg);
const own = (o, k) => (o != null && typeof o === 'object' && Object.hasOwn(o, k) ? o[k] : undefined);
const blen = (x) => enc.encode(x || '').length;   // bytes, as Go counts

// validate checks a request before it is queued (the server) or built (the
// page), in Go's order, so the first error is Go's. Normalises it as Go
// does: default platforms, the package name as stored. Returns the job's
// class: "record" (mode A), "build" (B, C) or "pack" (offline).
export function validate(r, env) {
  const cat = env.catalog;
  const product = env.product || 'TiddlyInstall';
  if (!hasRuntime(cat, String(r.runtime)) || !own(cat.policy.runtimes, r.runtime)) throw bad('unknown runtime ' + goQuote(String((r.runtime != null ? r.runtime : ''))));
  if (!['A', 'B', 'C'].includes(r.mode)) throw bad('mode must be A, B or C');
  if (!(env.modes || ['B', 'C']).includes(r.mode)) {
    throw bad('Installers signed by ' + product + ' come from the build server. Without one, choose "Signed by you" or "Unsigned".');
  }
  if (r.offline && r.mode === 'A') {
    throw bad('offline installers can\'t be signed by ' + product + ' (design.md section 3); choose mode B or C');
  }
  if (r.offline && !env.packRuntimes) {
    throw bad('Packing the runtimes into the installer needs the build server. Without one, untick it: the installer downloads them when it runs.');
  }
  if (!Array.isArray(r.platforms) || !r.platforms.length) r.platforms = PLATFORMS.slice();
  for (const p of r.platforms) if (!PLATFORMS.includes(p)) throw bad('unknown platform ' + goQuote(String((p != null ? p : ''))));
  const sel = r.select || '';
  if (sel === 'range' || sel === 'exact') {
    if (!String(r.range || '').trim()) throw bad('a version range is needed');
  } else if (!['', 'newest', 'asyncio'].includes(sel)) throw bad('unknown version choice ' + goQuote(sel));
  if (blen(r.name) > 80 || blen(r.launch) > 400 || blen(r.install) > 400 || blen(r.range) > 100) {
    throw bad('a field is too long');
  }
  // Control and bidi characters could disguise what the installer's review
  // screen shows (ESC[8m hides the rest of a terminal summary, U+202E
  // reverses text).
  const src = r.source || (r.source = {});
  for (const f of [r.name, r.project, r.launch, r.install, r.range, r.root, r.rootname, src.value, src.ref, src.version]) {
    if (hasControl(f)) throw bad('fields can\'t contain control or text-direction characters');
  }
  if (src.version && !versionRe.test(src.version)) throw bad('bad package version');
  // System prerequisites the app's own code needs (a written template's):
  // ids from the policy's prerequisites table.
  if (r.prerequisites != null) {
    const known = (env.catalog && env.catalog.policy && env.catalog.policy.prerequisites) || {};
    if (!Array.isArray(r.prerequisites) || r.prerequisites.length > 8) throw bad('prerequisites must be a list of at most 8 names');
    for (const id of r.prerequisites) {
      if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(known, id)) throw bad('unknown prerequisite ' + goQuote(String(id)));
    }
  }
  // Tool switches the publisher ticks (record `tools`, docs/format.md): the
  // ids in the policy's tools table, each only for the runtimes it lists.
  // `tools` also carries older settings the record doesn't keep
  // (`cc_win`), so an id the table doesn't know is left alone, as every
  // other unknown field in an optional block is (docs/api.md).
  if (r.tools != null) {
    const known = (env.catalog && env.catalog.policy && env.catalog.policy.tools) || {};
    if (typeof r.tools !== 'object' || Array.isArray(r.tools)) throw bad('tools must be a set of switches');
    for (const id of Object.keys(known)) {
      if (!Object.prototype.hasOwnProperty.call(r.tools, id) || r.tools[id] == null) continue;
      if (typeof r.tools[id] !== 'boolean') throw bad('tool switch ' + goQuote(String(id)) + ' must be true or false');
      const rts = Array.isArray(known[id].runtimes) ? known[id].runtimes : [];
      if (r.tools[id] && rts.length && !rts.includes(r.runtime)) {
        throw bad('the ' + goQuote(String(id)) + ' switch is only for ' + rts.join(', ') + ' apps');
      }
    }
  }
  if (r.rootname && !projectRe.test(r.rootname)) throw bad('bad install folder name');
  switch (src.kind) {
    case 'inline': {
      const names = Object.keys(r.files || {});
      if (!names.length || names.length > 200) throw bad('inline source needs 1 to 200 files');
      let total = 0;
      for (const p of names) {
        total += blen(r.files[p]);
        if (!p || p.startsWith('/') || p.includes('..') || /[\\:\0]/.test(p) || hasControl(p) || blen(p) > 200) {
          throw bad('bad file name ' + goQuote(p));
        }
      }
      if (total > 1 << 20) throw bad('inline source is limited to 1 MB');
      break;
    }
    case 'github':
      if (!githubRe.test(String(src.value || '').trim())) throw bad('GitHub source must be owner/repo or a github.com URL');
      if (!env.fetchSource) throw offlineSource(src);
      break;
    case 'url':
      if (!/^https?:\/\//.test(String(src.value || ''))) throw bad('source URL must be http(s)');
      if (!env.fetchSource) throw offlineSource(src);
      break;
    case 'upload': {
      // An archive or folder from the user's computer (the page packs a
      // folder into a tar). Only the page's own builder takes these; the
      // server has no upload yet.
      if (!env.embedPlan) throw bad('Files from your computer are built in the page itself, not on the build server.');
      if (r.mode === 'A') throw bad('Installers signed by TiddlyInstall need the source on the build server. For files from your computer, choose "Signed by you" or "Unsigned".');
      const b64 = String(r.archive || '');
      if (!b64) throw bad('Pick an archive or a folder from your computer.');
      if (b64.length > Math.ceil(UPLOAD_MAX / 3) * 4) throw bad('The archive is over ' + MB(UPLOAD_MAX) + ' MB.');
      break;
    }
    case 'package':
      try {
        src.value = validPackage(cat, r.runtime, String(src.value || '').trim(), String(src.version || '').trim());
      } catch (e) { throw bad(e.message); }
      src.version = String(src.version || '').trim();
      break;
    default:
      throw bad('source kind must be github, package, url or inline');
  }
  if (r.icon) {
    if (blen(r.icon.choice) > 64 || hasControl(r.icon.choice)) throw bad('bad icon choice');
    delete r.icon.filename;   // not used, and not worth storing
    delete r.icon.type;
    if (!r.icon.data) {
      if (r.icon.sha256 && !/^[0-9a-f]{64}$/.test(r.icon.sha256)) throw bad('bad icon sha256');
    } else {
      iconBytes(r.icon);
    }
  }
  if (r.offline) return 'pack';
  return r.mode === 'A' ? 'record' : 'build';
}

function offlineSource(src) {
  return bad('Without a build server, the code has to be written on this page or be a package name: a browser can\'t download ' +
    (src.kind === 'github' ? 'GitHub repositories' : 'other sites\' files') + ' itself, so that needs the build server.');
}

// Go's base64.StdEncoding.DecodeString: padding required, and \r and \n
// skipped.
function goBase64(s) {
  s = s.replace(/[\r\n]/g, '');
  if (s.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw bad('the icon isn\'t valid base64');
  let bin;
  try { bin = atob(s); } catch (e) { throw bad('the icon isn\'t valid base64'); }
  const u8 = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) u8[k] = bin.charCodeAt(k);
  return u8;
}

// The uploaded icon's bytes (build.validateIcon): checked, not yet decoded.
export function iconBytes(icon) {
  if (!icon || !icon.data) return null;
  let d = String(icon.data).trim();
  const i = d.indexOf(';base64,');
  if (d.startsWith('data:') && i >= 0) d = d.slice(i + 8);
  // base64.StdEncoding.EncodedLen(icon.MaxBytes) + 4
  if (d.length > Math.ceil((1 << 20) / 3) * 4 + 4) throw bad('the icon is over 1024 KB');
  const u8 = goBase64(d);
  try { checkIconPng(u8); } catch (e) { throw bad(e.message); }
  return u8;
}

/* ---------- source, record, plan ---------- */

// path.Base
function pathBase(p) {
  if (p === '') return '.';
  p = p.replace(/\/+$/, '');
  if (p === '') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

// build.projectName
export function projectName(r) {
  if (projectRe.test(r.project || '')) return r.project;
  let p = String(r.name || '').toLowerCase().replace(safeName, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  if (r.source && r.source.kind === 'url' && p === '') {
    const base = pathBase(String(r.source.value || '')).replace(/\.gz$/, '').replace(/\.tar$/, '');
    p = base.toLowerCase().replace(safeName, '_');
  }
  if (r.source && r.source.kind === 'upload' && p === '') {
    const base = pathBase(String(r.source.value || '')).replace(/\.(zip|tgz|tar\.gz|tar)$/i, '');
    p = base.toLowerCase().replace(safeName, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  }
  if (!p) p = 'app';
  return p.length > 40 ? p.slice(0, 40) : p;
}

const gzip = (u8) => deflate(u8, 'gzip');

// build.inlineTarball: the files under project/, sorted, with folders. The
// tar is byte for byte Go's; the gzip around it is not (Go's deflate).
export function inlineTar(project, files) {
  const names = Object.keys(files).sort();
  const members = [];
  const dirs = new Set();
  for (const n of names) {
    const parts = n.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) { dirs.add(d); members.push({ name: project + '/' + d + '/', data: new Uint8Array(0), mode: 0o755, dir: true }); }
    }
    members.push({ name: project + '/' + n, data: enc.encode(files[n]), mode: files[n].startsWith('#!') ? 0o755 : 0o644 });
  }
  return { tar: tarWrite(members), names };
}

/* ---------- sources from the user's computer ---------- */

const UPLOAD_MAX = 200 * 1024 * 1024;   // as the server's source downloads

const gunzip = (u8) => inflate(u8, 'gzip');

function isUstar(u8) {
  return u8.length >= 512 && String.fromCharCode(...u8.subarray(257, 262)) === 'ustar';
}

// The member names of a tar (ustar, pax and GNU long names), folders
// included, without the contents.
function tarNamesOf(u8) {
  const dec = new TextDecoder();
  const str = (b) => { const i = b.indexOf(0); return dec.decode(i < 0 ? b : b.subarray(0, i)); };
  const out = [];
  let o = 0, longName = null, paxPath = null;
  while (o + 512 <= u8.length) {
    const h = u8.subarray(o, o + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(str(h.subarray(124, 136)).trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156] || 0x30);
    const body = u8.subarray(o + 512, o + 512 + size);
    o += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = str(body); continue; }
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(dec.decode(body));
      if (m) paxPath = m[1];
      continue;
    }
    if (type === 'g') continue;
    let name = str(h.subarray(0, 100));
    const prefix = str(h.subarray(345, 500));
    if (prefix && str(h.subarray(257, 263)).startsWith('ustar')) name = prefix + '/' + name;
    out.push(paxPath || longName || name);
    longName = paxPath = null;
  }
  return out;
}

// build.topFolder: 1 when every entry is under one folder.
function topFolderOfNames(names) {
  let top = '';
  for (const n of names) {
    const t = n.replace(/^\.\//, '').split('/')[0];
    if (!t) continue;
    if (!top) top = t;
    else if (t !== top) return 0;
  }
  return top ? 1 : 0;
}

function safeEntry(n) {
  const parts = n.replace(/^\.\//, '').split('/');
  return !n.startsWith('/') && !/[\\:\0]/.test(n) && !parts.includes('..') && !hasControl(n);
}

// An archive from the user's computer as the .tar.gz the engines unpack:
// a .tar.gz is kept as it is, a .tar gzipped, a .zip rewritten as a tar
// (keeping Unix permissions where the zip has them). Returns {data, strip,
// names}: names are those at the top of the source, as for GitHub sources.
export async function uploadTarball(u8) {
  let data, tar;
  if (u8[0] === 0x1f && u8[1] === 0x8b) {
    tar = await gunzip(u8);
    if (!isUstar(tar)) throw bad('That .gz file doesn\'t hold a tar archive.');
    data = u8;
  } else if (isUstar(u8)) {
    tar = u8;
    data = await gzip(u8);
  } else if (u8[0] === 0x50 && u8[1] === 0x4b) {
    let entries;
    try { entries = zipRead(u8); } catch (e) { throw bad('That zip can\'t be read: ' + e.message); }
    const members = [];
    for (const e of entries) {
      if (zipIsSymlink(e)) continue;
      const mode = zipUnixMode(e) & 0o777;
      if (zipIsDir(e)) members.push({ name: e.name.replace(/\/?$/, '/'), dir: true, mode: mode || 0o755 });
      else members.push({ name: e.name, data: await zipEntryData(e), mode: mode || 0o644 });
    }
    tar = tarWrite(members);
    data = await gzip(tar);
  } else {
    throw bad('That isn\'t a .zip, .tar.gz or .tar archive.');
  }
  const all = tarNamesOf(tar);
  if (!all.length) throw bad('The archive is empty.');
  const badName = all.find((n) => !safeEntry(n));
  if (badName !== undefined) throw bad('The archive has an unsafe path: ' + goQuote(badName.slice(0, 120)));
  const strip = topFolderOfNames(all);
  const names = all.map((n) => n.replace(/^\.\//, '').split('/').slice(strip).join('/')).filter(Boolean);
  return { data, tar, strip, names };
}

async function inlineTarball(project, files) {
  const t = inlineTar(project, files);
  return { data: await gzip(t.tar), tar: t.tar, names: t.names };
}

// build.LookupPackage: check a package in its registry, pin the newest
// version when none is given, and find its program when the policy says
// where. A runtime whose policy has no lookup (Go, .NET) is left to its
// package manager at install time.
export async function lookupPackage(env, runtime, name, version) {
  const cat = env.catalog;
  const p = packagePolicyFor(cat, runtime);
  const info = { name, version, bin: '', binPath: '' };
  if (!p.lookup) return info;
  const reg = (dflt) => (typeof p.registry === 'string' && p.registry) || dflt;
  let get;
  if (env.registryJSON) {
    // The server: Go's messages (build.lookupErr).
    get = async (tmpl, v) => {
      try {
        return await env.registryJSON(tmpl, name, v);
      } catch (e) {
        if (!e.noPackage) throw e;
        const err = new Error(reg('the registry') + ' has no ' + (v ? name + ' ' + v : 'package named ' + name) + ': no such package');
        err.noPackage = true;
        throw err;
      }
    };
  } else {
    // The browser: registries that answer web pages (PyPI, npm, ...) work
    // when online; the rest need a version given.
    get = async (tmpl, v) => {
      const u = tmpl.replace('{name}', encodeURIComponent(name).replace(/%2F/g, '/')).replace('{version}', encodeURIComponent(v));
      let r;
      try {
        r = await (env.fetch || fetch)(u, { headers: { Accept: 'application/json' } });
      } catch (e) {
        throw bad('Couldn\'t ask ' + reg('the registry') + ' about ' + name + ' (offline, or it doesn\'t answer web pages). Give the package\'s version to build without asking.');
      }
      if (r.status === 404 || r.status === 410) throw bad(reg('The registry') + ' has no ' + (v ? name + ' ' + v : 'package named ' + name));
      if (!r.ok) throw bad('package registry: ' + r.status + ' ' + r.statusText);
      return r.json();
    };
  }
  let doc = null;
  if (!version || !p.lookup_version) {
    doc = await get(p.lookup, '');
    if (!version) {
      const v = jsonField(doc, p.version_field || '');
      let ok = typeof v === 'string' && v !== '';
      if (ok) { try { validPackage(cat, runtime, name, v); } catch (e) { ok = false; } }
      if (!ok) throw new Error(reg('The registry') + ' gave no usable version for ' + name);
      info.version = v;
    }
  }
  if (p.lookup_version && (version || p.bin_field)) doc = await get(p.lookup_version, info.version);
  if (p.bin_field) {
    try {
      const b = pickBin(jsonField(doc, p.bin_field), packageProject(p, name));
      info.bin = b.name;
      info.binPath = b.path;
    } catch (e) { throw new Error(name + ' ' + info.version + ': ' + e.message); }
  }
  return info;
}

// build.PackageLaunch: {name}, {module}, and when info is known {bin} and
// {bin_path}. With info null the last two are left for the plan (records
// behind plain file names).
export function packageLaunch(launch, p, name, info) {
  const project = packageProject(p, name);
  const pairs = ['{name}', name, '{module}', packageModule(name)];
  if (info) {
    pairs.push('{bin}', info.bin || project);
    if (launch.includes('{bin_path}')) {
      if (!info.binPath) throw new Error(((typeof p.registry === 'string' && p.registry) || 'The registry') + ' doesn\'t say which program ' + name + ' runs; give a launch command');
      pairs.push('{bin_path}', info.binPath);
    }
  }
  return replacer(...pairs)(launch);
}

// catalog.RuntimePolicy.MatchInstall and build.projectInstall
// Install rules come before a compiled language's own build command: a
// rule names the files it's for (nim's main.nim, C++'s main.cpp), and the
// language's command is the fallback for everything else.
export function projectInstall(pol, given, pkg, names) {
  if (given) return given;
  if (pkg) return 'default';
  const have = new Set(names);
  for (const rule of pol.install_rules || []) {
    if ((rule.files || []).some((f) => have.has(f))) {
      if (rule.unsupported) throw new Error(rule.unsupported);
      return 'default:' + rule.id;
    }
  }
  if (pol.compiled === true) return 'default';
  return (pol.install_files || []).some((f) => have.has(f)) ? 'default' : '';
}

// ibtext.Writer: values can't break the format.
export function kvLine(key, ...vals) {
  return [key, ...vals.map((v) => String(v).replace(/[\t\r\n]/g, ' '))].join('\t') + '\n';
}

function rfc3339(d) {
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

// The record (build.Run, format.md section 2).
function writeRecord(r, fields, backend, now) {
  let out = '';
  const add = (k, ...v) => { out += kvLine(k, ...v); };
  add('ti-record', '1');
  add('name', fields.name);
  add('project', fields.project);
  add('runtime', r.runtime);
  add('select', r.select || 'newest');
  if (r.range) add('range', r.range);
  if (fields.pkg) add('source', 'package', fields.pkg.name, fields.pkg.version);
  else if (r.source.kind === 'github') add('source', 'github', fields.src.origin, fields.src.commit, fields.src.sha256);
  else if (r.source.kind === 'url') add('source', 'url', r.source.value, fields.src.sha256);
  // inline and upload name the *tar*: we compress these ourselves, and the
  // page's deflate and the server's differ, so hashing the gzip made one
  // form give two record hashes and two install folders (design.md 11.2).
  else if (r.source.kind === 'upload') add('source', 'upload', fields.src.tarSha || fields.src.sha256);
  else add('source', 'inline', fields.src.tarSha || fields.src.sha256);
  add('launch', fields.launch);
  if (fields.install) add('install', fields.install);
  if (r.prerequisites && r.prerequisites.length) add('prerequisites', r.prerequisites.join(' '));
  if (fields.tools.length) add('tools', fields.tools.join(' '));
  add('console', r.console === false ? '0' : '1');
  add('menu', r.menu === false ? '0' : '1');
  add('desktop', r.desktop ? '1' : '0');
  // In every mode, so the record's hash covers the icon; the PNG is served
  // at /icons/<sha256>.png (format.md section 2).
  if (fields.iconSha) add('icon', fields.iconSha);
  add('root', r.root || 'user');
  add('rootname', r.rootname || 'ti');
  add('platforms', r.platforms.join(' '));
  add('backend', backend || '');
  add('created', rfc3339(now));
  return out;
}

// tifile.PackSize: the exact length of a pack's tar.
export function packSize(files) {
  let n = 1024;
  for (const f of files) n += 512 + Math.ceil(f.size / 512) * 512;
  return n;
}

// A pack is content-addressed: its members are named by their SHA-256, and
// the embedded plan is the only index that can say which member is which
// file. Two architectures of one runtime often share a file name -- every
// Windows Python build calls its parts core.msi, exe.msi, lib.msi -- so a
// pack carrying more than one of them with no plan cannot be read back.
// Refuse to write one rather than produce that (format.md section 4).
function checkPackIndex(files, plan) {
  if (plan) return;
  const byName = new Map();
  for (const f of files) {
    const k = String(f.name);
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(String(f.sha256));
  }
  for (const [k, shas] of byName) {
    if (shas.size > 1) {
      throw new Error('this offline installer packs ' + shas.size + ' different files called ' + goQuote(k) +
        ' (the same runtime built for more than one architecture) and carries no plan to tell them apart; ' +
        'a pack with more than one architecture of a runtime must embed its plan');
    }
  }
}

function dedupPack(files) {
  const seen = new Set();
  return files.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
}

const MB = (n) => Math.floor(n / (1024 * 1024));

// What these installers will download that our mirror has no copy of
// (design.md 1.3; the words are shared/resolve.js MIRROR_GAP_WHY). A file the
// local store has never seen gets no mirror URL, so its plan names the
// vendor alone -- which is exactly what an old machine often cannot
// reach, the Ruby 3.2 on Windows 7 case in docs/test-results.md. The
// installer's review screen says the same thing from the plan's `note`;
// this is the build-time half, and it matters more, because the publisher
// is the one who can still pick another version. Resolved per platform so
// the page can say which one is short.
function unmirrored(cat, app, platforms) {
  if (!cat || !cat.policy || typeof cat.policy.mirror_base !== 'string' || cat.policy.mirror_base === '') return [];
  const out = [], seen = new Set();
  for (const plat of platforms) {
    let files;
    try { ({ files } = resolveFiles(cat, Object.assign({}, app, { platforms: [plat] }))); } catch (e) { continue; }
    for (const f of files) {
      const key = f.sha256 || f.name;
      if (f.local !== '' || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: f.name, sha256: f.sha256, size: f.size, platform: plat });
    }
  }
  return out;
}

// runJob builds a request (validate()d here too). Returns {record, hash,
// app, stem, src, unmirrored, files: [{platform, name, data?, size,
// sha256, signed, offline}]}: without env.save each file's bytes are in
// `data`.
export async function runJob(r, env, progress = () => {}) {
  const cat = env.catalog;
  validate(r, env);
  // A catalogue loaded a folder at a time (the one-file site's) unpacks
  // this runtime and what its plans need; the server's has them all.
  await loadRuntimes(cat, [r.runtime]);
  const pol = cat.policy.runtimes[r.runtime];
  const png = env.iconPng ? await env.iconPng(r.icon) : iconBytes(r.icon);
  progress('Resolving the source');
  let src = null, pkg = null, project, names = [];
  if (r.source.kind === 'inline') {
    project = projectName(r);
    const t = await inlineTarball(project, r.files);
    names = t.names;
    src = { data: t.data, sha256: await sha256Hex(t.data), tarSha: await sha256Hex(t.tar),
            size: t.data.length, strip: 1, urls: [] };
    // Stored under the tar's hash, because that is what the record names
    // and what the backend has to look a record's source up by.
    if (env.storeSource) await env.storeSource(src.tarSha, src.data);
  } else if (r.source.kind === 'upload') {
    const s = atob(String(r.archive).replace(/\s+/g, ''));
    const u8 = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
    const t = await uploadTarball(u8);
    names = t.names;
    project = projectName(r);
    src = { data: t.data, sha256: await sha256Hex(t.data), tarSha: await sha256Hex(t.tar),
            size: t.data.length, strip: t.strip, urls: [] };
  } else if (r.source.kind === 'package') {
    // Pin the version now (design.md section 4: records name what they
    // install), while the registry can be asked.
    pkg = await lookupPackage(env, r.runtime, r.source.value, r.source.version);
    project = packageProject(pol.package, pkg.name);
  } else {
    src = await env.fetchSource(r);
    names = src.names || [];
    project = r.source.kind === 'github' ? src.project : projectName(r);
  }
  if (src && env.takenDown && await env.takenDown('sha ' + src.sha256)) throw new Error('this source has been taken down');
  let launch = r.launch || (pkg ? pol.package.launch : pol.launch) || '';
  if (pkg) launch = packageLaunch(launch, pol.package, pkg.name, pkg);
  const install = projectInstall(pol, r.install || '', !!pkg, names);

  progress('Writing the record');
  const iconSha = png ? await sha256Hex(png) : '';
  // The tool switches that are on, in the order the policy lists them, so
  // the same settings always give the same record bytes.
  const tools = Object.keys((env.catalog && env.catalog.policy && env.catalog.policy.tools) || {})
    .filter((id) => r.tools && r.tools[id] === true);
  const name = r.name || project;
  const now = env.now ? env.now() : new Date();
  const record = writeRecord(r, { name, project, src, pkg, launch, install, iconSha, tools }, env.backend, now);
  const hash = await recordHash(record);
  if (env.storeRecord) await env.storeRecord(hash, record);

  const app = {
    recordHash: hash, name, project, runtime: r.runtime, select: r.select || 'newest',
    range: r.range || '', launch, install, console: r.console !== false, menu: r.menu !== false,
    desktop: !!r.desktop, root: r.root || 'user', rootName: r.rootname || 'ti', platforms: [],
    source: src ? { name: (src.tarSha || src.sha256) + '.tar.gz', sha256: src.sha256, tarSha: src.tarSha || '',
                    size: src.size, format: 'tar.gz', strip: src.strip, urls: src.urls || [] } : null,
    package: pkg ? pkg.name : '', packageVersion: pkg ? pkg.version : '',
    prerequisites: r.prerequisites || [], tools,
    // A plan this page writes is made now, and says so (design.md 7.1);
    // the build server passes the moment it serves a plan at. The record's
    // `created` is the same instant, so one build gives one time.
    signedAt: now,
  };
  let stem = 'install_' + r.runtime + '_' + project.toLowerCase().replace(safeName, '-');
  if (r.mode === 'A') stem += '_' + hash;
  const job = { r, env, record, hash, app, stem, src, png, iconSha, progress, iconSrc: null };
  const out = { record, hash, app, stem, src, png, iconSha, files: [], unmirrored: unmirrored(cat, app, r.platforms) };
  try {
    if (png && r.mode !== 'A') job.iconSrc = await rasterSource(png);
    for (const plat of r.platforms) {
      progress('Building the ' + plat + ' installer');
      try {
        out.files.push(await (r.mode === 'A' ? modeAFile(job, plat) : buildFile(job, plat)));
      } catch (e) {
        const err = new Error(plat + ': ' + (e && e.message ? e.message : String(e)));
        err.cause = e;
        throw err;
      }
    }
  } finally {
    if (job.iconSrc && typeof job.iconSrc.close === 'function') job.iconSrc.close();
  }
  return out;
}

async function baseFor(env, plat) {
  const base = await env.base(plat);
  if (!base) throw new Error('There is no ' + plat + ' base installer here.');
  return toBytes(base);
}

// Mode A: our signed base, renamed; the file name carries the record hash
// (design.md section 3). The file is never changed (that would break our
// signature), so no icon and no block: the record is only on the backend.
async function modeAFile(job, plat) {
  const { env, stem } = job;
  const name = stem + EXT[plat];
  let data = null, signedBy = '';
  if (plat === 'windows' && env.signedBase) {
    const sb = await env.signedBase(plat);
    if (sb) { data = toBytes(sb.data); signedBy = sb.signedBy || ''; }
  }
  if (!data) data = await baseFor(env, plat);
  if (plat === 'macos') {
    // The .app is renamed after the file; its entries are copied as they
    // are, so its signature stays (tifile.MacZip with nothing added).
    const info = await readInstaller(data, 'base.zip');
    renameApp(info, stem + '.app');
    data = zipWrite(info.entries);
    signedBy = 'ad-hoc (test)';
  }
  return emit(job, plat, name, { data }, signedBy);
}

// Modes B and C: the record (and for offline installers the signed plan and
// every download) in a metadata block, and the icon in the file, all before
// any signature.
async function buildFile(job, plat) {
  const { r, env, record, hash, app, stem, src, png, iconSha, progress, iconSrc } = job;
  const base = await baseFor(env, plat);
  const info = await readInstaller(base, 'base' + EXT[plat]);
  let plan = null;
  let pack = [];
  if (r.offline) {
    const p = await env.packPlan(hash, plat, progress);
    plan = p.plan;
    checkPackIndex(p.files, plan);
    pack = dedupPack(p.files);
    if (info.kind === 'zip' && packSize(pack) > MAX_MAC_PACK) {
      throw new Error('the packed files come to ' + MB(packSize(pack)) + ' MB; macOS offline installers are limited to ' + MB(MAX_MAC_PACK) + ' MB for now');
    }
  } else if (env.embedPlan) {
    // The same rule as the build server's, from the same list where the
    // page has one (design.md 7.1).
    if (env.revoked) setRevoked(env.catalog, await env.revoked());
    plan = resolve(env.catalog, Object.assign({}, app, { platforms: [plat] }));
    if (env.signPlan) plan = await env.signPlan(plan);
    if (src) pack.push({ name: src.sha256, size: src.data.length, data: src.data });
  }
  if (iconSrc) {
    if (info.kind === 'exe') {
      info.base = await setExeIcon(info.base, await buildIco(iconSrc));
      info.pe = peInfo(info.base);
      info.signed = false;
    } else if (info.kind === 'zip') {
      await setMacIcon(info, await buildIcns(iconSrc));
    } else if (!pack.some((m) => m.name === iconSha)) {
      // Linux carries the PNG in the pack, named by the record's `icon`.
      pack.push({ name: iconSha, size: png.length, data: png });
    }
  }
  if (info.kind !== 'zip' && packSize(pack) > MAX_PACK && pack.length) {
    throw new Error('the packed files come to ' + MB(packSize(pack)) + ' MB; the limit is ' + MB(MAX_PACK) + ' MB (installers use 32-bit offsets)');
  }
  if (info.kind === 'zip') renameApp(info, stem + '.app');
  const name = stem + installerExt(info.kind);
  if (env.save && info.kind !== 'zip') {
    // The server writes .exe and .run files straight to disk: offline packs
    // can be large. A checksum the base has is kept up to date (setExeIcon
    // sets one; the plain base has none).
    const pe = info.kind === 'exe' ? info.pe : null;
    const fixChecksum = !!(pe && new DataView(info.base.buffer, info.base.byteOffset, info.base.byteLength).getUint32(pe.checksumOff, true) !== 0);
    return emit(job, plat, name, { layout: { base: info.base, record: enc.encode(record), plan: enc.encode(plan || ''), pack, fixChecksum, checksumOff: pe ? pe.checksumOff : 0 } }, '');
  }
  for (const m of pack) if (!m.data) m.data = await m.read();
  const data = await writeInstaller(info, { record, plan, pack });
  return emit(job, plat, name, { data }, '');
}

async function emit(job, plat, name, spec, signed) {
  const f = { platform: plat, name, size: 0, sha256: '', signed, offline: !!job.r.offline };
  if (job.env.save) {
    const s = await job.env.save(job.hash, name, spec);
    f.size = s.size;
    f.sha256 = s.sha256;
  } else {
    f.data = spec.data;
    f.size = spec.data.length;
    f.sha256 = await sha256Hex(spec.data);
  }
  return f;
}

// The server names the .app after the installer (tifile.MacZip).
function renameApp(info, app) {
  const from = info.app;
  const to = app + '/';
  if (from === to) return;
  for (const e of info.entries) {
    if (e.name.startsWith(from)) {
      e.name = to + e.name.slice(from.length);
      e.nameBytes = enc.encode(e.name);   // what zipWrite writes
    }
  }
  info.app = to;
}
