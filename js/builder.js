// The job builder shared by the build server (Node) and the offline page
// (plan.md section 1.11): a POST /api/jobs request (docs/api.md) to its
// record, plans and installer files, following docs/format.md. Everything
// that differs between the two lives in `env`:
//
//   env.catalog        a Catalog from js/resolve.js
//   env.base(plat)     the unsigned base for "windows" | "linux" | "macos" (bytes)
//   env.backend        written into records
//   env.fetch          fetch() for package registries (the server passes one
//                      that only reaches public addresses)
//   env.fetchSource(r) GitHub and URL sources -> {data, sha256, origin, commit,
//                      names}; absent: those sources are refused
//   env.modes          the modes this builder makes (default ["B", "C"])
//   env.embedPlan      true: each installer carries its plan and packs the
//                      app's source, so it needs no build server (offline page)
//
// Mode A and packing runtimes into the installer are the server's, and are
// added there around runJob.
import { toBytes, sha256Hex, recordHash, readInstaller, writeInstaller, tarWrite, installerExt } from './ibfile.js';
import { resolve, validPackage, packagePolicyFor, packageProject, packageModule, pickBin, jsonField } from './resolve.js';
import { rasterSource, buildIco, buildIcns, setExeIcon, setMacIcon, checkIconPng } from './icon.js';

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
const PLATFORMS = ['windows', 'linux', 'macos'];

function hasControl(s) {
  for (const ch of String(s || '')) {
    const c = ch.codePointAt(0);
    if (c < 0x20 || (c >= 0x7f && c < 0xa0) || (c >= 0x200e && c <= 0x200f) ||
        (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069)) return true;
  }
  return false;
}

const bad = (msg) => new RequestError(msg);

export function validate(r, env) {
  const cat = env.catalog;
  const pol = cat.policy.runtimes[r.runtime];
  if (!pol) throw bad('unknown runtime "' + r.runtime + '"');
  if (!['A', 'B', 'C'].includes(r.mode)) throw bad('mode must be A, B or C');
  if (!(env.modes || ['B', 'C']).includes(r.mode)) {
    throw bad('Installers signed by TiddlyInstall come from the build server. Without one, choose "Signed by you" or "Unsigned".');
  }
  if (r.offline && r.mode === 'A') {
    throw bad('offline installers can\'t be signed by TiddlyInstall (design.md section 3); choose mode B or C');
  }
  if (r.offline && !env.packRuntimes) {
    throw bad('Packing the runtimes into the installer needs the build server. Without one, untick it: the installer downloads them when it runs.');
  }
  if (!Array.isArray(r.platforms) || !r.platforms.length) r.platforms = PLATFORMS.slice();
  for (const p of r.platforms) if (!PLATFORMS.includes(p)) throw bad('unknown platform "' + p + '"');
  const sel = r.select || '';
  if (sel === 'range' || sel === 'exact') {
    if (!String(r.range || '').trim()) throw bad('a version range is needed');
  } else if (!['', 'newest', 'asyncio'].includes(sel)) throw bad('unknown version choice "' + sel + '"');
  const len = (x) => enc.encode(x || '').length;   // bytes, as Go counts
  if (len(r.name) > 80 || len(r.launch) > 400 || len(r.install) > 400 || len(r.range) > 100) {
    throw bad('a field is too long');
  }
  const src = r.source || {};
  for (const f of [r.name, r.project, r.launch, r.install, r.range, r.root, r.rootname, src.value, src.ref, src.version]) {
    if (hasControl(f)) throw bad('fields can\'t contain control or text-direction characters');
  }
  if (src.version && !versionRe.test(src.version)) throw bad('bad package version');
  if (r.rootname && !projectRe.test(r.rootname)) throw bad('bad install folder name');
  switch (src.kind) {
    case 'inline': {
      const names = Object.keys(r.files || {});
      if (!names.length || names.length > 200) throw bad('inline source needs 1 to 200 files');
      let total = 0;
      for (const p of names) {
        total += enc.encode(r.files[p]).length;
        if (!p || p.startsWith('/') || p.includes('..') || /[\\:\0]/.test(p) || hasControl(p) || len(p) > 200) {
          throw bad('bad file name "' + p + '"');
        }
      }
      if (total > 1 << 20) throw bad('inline source is limited to 1 MB');
      break;
    }
    case 'package':
      src.value = validPackage(cat, r.runtime, String(src.value || '').trim(), String(src.version || '').trim());
      src.version = String(src.version || '').trim();
      break;
    case 'github':
      if (!/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.test(String(src.value || '').trim())) {
        throw bad('GitHub source must be owner/repo or a github.com URL');
      }
      if (!env.fetchSource) throw offlineSource(src);
      break;
    case 'url':
      if (!/^https?:\/\//.test(String(src.value || ''))) throw bad('source URL must be http(s)');
      if (!env.fetchSource) throw offlineSource(src);
      break;
    default:
      throw bad('source kind must be github, package, url or inline');
  }
  if (r.icon) {
    if (enc.encode(r.icon.choice || '').length > 64 || hasControl(r.icon.choice)) throw bad('bad icon choice');
    iconBytes(r.icon);
  }
}

function offlineSource(src) {
  return bad('Without a build server, the code has to be written on this page or be a package name: a browser can\'t download ' +
    (src.kind === 'github' ? 'GitHub repositories' : 'other sites\' files') + ' itself, so that needs the build server.');
}

/* ---------- source, record, plan ---------- */

// build.projectName
function projectName(r) {
  if (projectRe.test(r.project || '')) return r.project;
  let p = String(r.name || '').toLowerCase().replace(safeName, '_').replace(/^[_.-]+|[_.-]+$/g, '');
  if (!p) p = 'app';
  return p.length > 40 ? p.slice(0, 40) : p;
}

async function gzip(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// build.inlineTarball: the files under project/, sorted, with folders.
async function inlineTarball(project, files) {
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
  return { data: await gzip(tarWrite(members)), names };
}

// build.LookupPackage, from the browser: registries that answer web pages
// (PyPI, npm, ...) work when online; the rest need a version given.
export async function lookupPackage(env, runtime, name, version) {
  const cat = env.catalog;
  const p = packagePolicyFor(cat, runtime);
  const info = { name, version, bin: '', binPath: '' };
  if (!p.lookup) return info;
  const get = async (tmpl, v) => {
    const u = tmpl.replace('{name}', encodeURIComponent(name).replace(/%2F/g, '/')).replace('{version}', encodeURIComponent(v));
    let r;
    try {
      r = await (env.fetch || fetch)(u, { headers: { Accept: 'application/json' } });
    } catch (e) {
      throw bad('Couldn\'t ask ' + (p.registry || 'the registry') + ' about ' + name + ' (offline, or it doesn\'t answer web pages). Give the package\'s version to build without asking.');
    }
    if (r.status === 404 || r.status === 410) {
      throw bad((p.registry || 'The registry') + ' has no ' + (v ? name + ' ' + v : 'package named ' + name));
    }
    if (!r.ok) throw bad('package registry: ' + r.status + ' ' + r.statusText);
    return r.json();
  };
  let doc = null;
  if (!version || !p.lookup_version) {
    doc = await get(p.lookup, '');
    if (!version) {
      const v = jsonField(doc, p.version_field);
      try { validPackage(cat, runtime, name, v); } catch (e) { throw bad((p.registry || 'The registry') + ' gave no usable version for ' + name); }
      if (typeof v !== 'string' || !v) throw bad((p.registry || 'The registry') + ' gave no usable version for ' + name);
      info.version = v;
    }
  }
  if (p.lookup_version && (version || p.bin_field)) doc = await get(p.lookup_version, info.version);
  if (p.bin_field) {
    try {
      const b = pickBin(jsonField(doc, p.bin_field), packageProject(p, name));
      info.bin = b.name;
      info.binPath = b.path;
    } catch (e) { throw bad(name + ' ' + info.version + ': ' + e.message); }
  }
  return info;
}

// build.PackageLaunch
function packageLaunch(launch, p, name, info) {
  const project = packageProject(p, name);
  let out = launch.split('{name}').join(name).split('{module}').join(packageModule(name));
  if (info) {
    out = out.split('{bin}').join(info.bin || project);
    if (out.includes('{bin_path}')) {
      if (!info.binPath) throw bad((p.registry || 'The registry') + ' doesn\'t say which program ' + name + ' runs; give a launch command');
      out = out.split('{bin_path}').join(info.binPath);
    }
  }
  return out;
}

// catalog.RuntimePolicy.MatchInstall and build.projectInstall
function projectInstall(pol, given, pkg, names) {
  if (given) return given;
  if (pkg || pol.compiled) return 'default';
  const have = new Set(names);
  for (const rule of pol.install_rules || []) {
    if ((rule.files || []).some((f) => have.has(f))) {
      if (rule.unsupported) throw bad(rule.unsupported);
      return 'default:' + rule.id;
    }
  }
  return (pol.install_files || []).some((f) => have.has(f)) ? 'default' : '';
}

function clean(s) { return String(s).replace(/[\t\r\n]/g, ' '); }

// build.recordFor
function writeRecord(r, fields, backend) {
  const lines = [];
  const add = (k, ...v) => lines.push([k, ...v.map(clean)].join('\t'));
  add('ib-record', '1');
  add('name', fields.name);
  add('project', fields.project);
  add('runtime', r.runtime);
  add('select', r.select || 'newest');
  if (r.range) add('range', r.range);
  if (fields.pkg) add('source', 'package', fields.pkg.name, fields.pkg.version);
  else if (r.source.kind === 'github') add('source', 'github', fields.src.origin, fields.src.commit, fields.src.sha256);
  else if (r.source.kind === 'url') add('source', 'url', r.source.value, fields.src.sha256);
  else add('source', 'inline', fields.src.sha256);
  add('launch', fields.launch);
  if (fields.install) add('install', fields.install);
  add('console', r.console === false ? '0' : '1');
  add('menu', r.menu === false ? '0' : '1');
  add('desktop', r.desktop ? '1' : '0');
  if (fields.iconSha) add('icon', fields.iconSha);
  add('root', r.root || 'user');
  add('rootname', r.rootname || 'ib');
  add('platforms', r.platforms.join(' '));
  add('backend', backend || '');
  add('created', new Date().toISOString().replace(/\.\d+Z$/, 'Z'));
  return lines.join('\n') + '\n';
}

function iconBytes(icon) {
  if (!icon || !icon.data) return null;
  let d = String(icon.data).trim();
  const i = d.indexOf(';base64,');
  if (d.startsWith('data:') && i >= 0) d = d.slice(i + 8);
  let s;
  try { s = atob(d); } catch (e) { throw bad('the icon isn\'t valid base64'); }
  const u8 = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) u8[k] = s.charCodeAt(k);
  try { checkIconPng(u8); } catch (e) { throw bad(e.message); }
  return u8;
}

// runJob builds a checked request. Returns {record, hash, app, stem, src,
// files: [{platform, name, data, size, sha256}]}: the installers for modes
// B and C (with env.embedPlan, self-contained). The server wraps it for
// mode A and packs.
export async function runJob(r, env, progress = () => {}) {
  const cat = env.catalog;
  validate(r, env);
  const pol = cat.policy.runtimes[r.runtime];
  const png = iconBytes(r.icon);
  progress('Resolving the source');
  let src = null, pkg = null, project, names = [];
  if (r.source.kind === 'inline') {
    project = projectName(r);
    const t = await inlineTarball(project, r.files);
    names = t.names;
    src = { data: t.data, sha256: await sha256Hex(t.data), strip: 1, urls: [] };
  } else if (r.source.kind === 'package') {
    pkg = await lookupPackage(env, r.runtime, r.source.value, r.source.version);
    project = packageProject(pol.package, pkg.name);
  } else {
    src = await env.fetchSource(r);
    names = src.names || [];
    project = r.source.kind === 'github' ? src.project : projectName(r);
  }
  progress('Writing the record');
  let launch = r.launch || (pkg ? pol.package.launch : pol.launch);
  if (pkg) launch = packageLaunch(launch, pol.package, pkg.name, pkg);
  const install = projectInstall(pol, r.install || '', !!pkg, names);
  const iconSha = png ? await sha256Hex(png) : '';
  const record = writeRecord(r, { name: r.name || project, project, src, pkg, launch, install, iconSha }, env.backend);
  const hash = await recordHash(record);

  const app = {
    recordHash: hash, name: r.name || project, project, runtime: r.runtime, select: r.select || 'newest',
    range: r.range || '', launch, install, console: r.console !== false, menu: r.menu !== false,
    desktop: !!r.desktop, root: r.root || 'user', rootName: r.rootname || 'ib', platforms: [],
    source: src ? { name: src.sha256 + '.tar.gz', sha256: src.sha256, size: src.data.length, format: 'tar.gz', strip: src.strip, urls: src.urls } : null,
    package: pkg ? pkg.name : '', packageVersion: pkg ? pkg.version : '',
  };
  let stem = 'install_' + r.runtime + '_' + project.toLowerCase().replace(safeName, '-');
  if (r.mode === 'A') stem += '_' + hash;
  const out = { record, hash, app, stem, src, png, iconSha, files: [] };
  if (r.mode === 'A') return out;       // the server renames its signed bases
  const iconSrc = png ? await rasterSource(png) : null;
  try {
    for (const plat of r.platforms) {
      progress('Building the ' + plat + ' installer');
      const base = env.base(plat);
      if (!base) throw new Error('There is no ' + plat + ' base installer here.');
      const info = await readInstaller(base, 'base' + (plat === 'windows' ? '.exe' : plat === 'macos' ? '.zip' : '.run'));
      let plan = null;
      const pack = [];
      if (env.embedPlan) {
        plan = await resolve(cat, Object.assign({}, app, { platforms: [plat] }));
        if (src) pack.push({ name: src.sha256, data: src.data });
      }
      if (iconSrc) {
        if (info.kind === 'exe') {
          info.base = await setExeIcon(info.base, await buildIco(iconSrc));
          info.pe = (await readInstaller(info.base, 'x.exe')).pe;
          info.signed = false;
        } else if (info.kind === 'zip') {
          await setMacIcon(info, await buildIcns(iconSrc));
        } else if (!pack.some((m) => m.name === iconSha)) {
          pack.push({ name: iconSha, data: png });
        }
      }
      if (info.kind === 'zip') renameApp(info, stem + '.app');
      const data = await writeInstaller(info, { record, plan, pack });
      out.files.push({ platform: plat, name: stem + installerExt(info.kind), data, size: data.length, sha256: await sha256Hex(data) });
    }
  } finally {
    if (iconSrc && typeof iconSrc.close === 'function') iconSrc.close();
  }
  return out;
}

// The server names the .app after the installer (ibfile.MacZip).
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

