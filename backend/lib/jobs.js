// The server's side of a build (the Go server's build package): what
// js/builder.js needs from a server (stored records, sources and icons,
// registry lookups, signed plans, packed downloads, files on disk), and the
// plans served for stored records and plain file names.
//
// Data folder (the Go server's layout, so either can use it):
//   records/<hash>.txt   records, immutable, named by their hash
//   src/<sha256>.tar.gz  sources: written on the site, from GitHub, from URLs
//   icons/<sha256>.png   uploaded icons
//   dl/<hash>/<name>     built installers, under their record's hash
//   cache/<sha256>       downloads for offline packs
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { runJob, lookupPackage as lookupPackageJS, packageLaunch, githubRe, projectName, kvLine } from '../../js/builder.js';
import { resolveFiles, validPackage, packagePolicyFor, packageProject, replacer } from '../../js/resolve.js';
import { recordHash } from '../../js/ibfile.js';
import { decodeIconPng } from '../../js/icon.js';
import { safeFetch } from './netsafe.js';
import { addRequestLine } from './plansig.js';
import { localPath } from './catalog.js';
import { writeAtomic, writeInstallerFile, sha256File, tarNamesUnderTop, topFolder } from './files.js';

const SIGNED_BY = 'TiddlyInstall TEST';   // our test certificate (bases/windows)

export const isSHA256 = (s) => /^[0-9a-f]{64}$/.test(s);
export const isHash26 = (s) => /^[a-z2-7]{26}$/.test(s);
const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const exists = (p) => { try { fs.statSync(p); return true; } catch (e) { return false; } };

// url.PathEscape
function pathEscape(s) {
  let out = '';
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b);
    out += /[A-Za-z0-9\-_.~$&+:=@]/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// ibtext.Parse
function parseLines(doc) {
  const out = [];
  for (let raw of doc.split('\n')) {
    raw = raw.replace(/\r$/, '');
    if (raw === '' || raw.startsWith('#')) continue;
    const parts = raw.split('\t');
    out.push({ key: parts[0], vals: parts.slice(1), val(i) { return i < this.vals.length ? this.vals[i] : ''; } });
  }
  return out;
}

class NotFoundError extends Error {
  constructor(msg) { super(msg); this.code = 'ENOENT'; }
}

export class Builder {
  // {cat, data, bases, public, signer, takenDown(entry)}
  constructor(o) {
    this.cat = o.cat;
    this.data = o.data;
    this.bases = o.bases;
    this.public = o.public;
    this.backend = o.backend ?? o.public;
    this.signer = o.signer;
    this.takenDown = o.takenDown || (() => false);
    // Every fetch goes through the public-only client (tests pass their own).
    this.fetch = o.fetch || safeFetch;
    this.lookupCache = new Map();
  }

  recordPath(h) { return path.join(this.data, 'records', h + '.txt'); }
  srcPath(sha) { return path.join(this.data, 'src', sha + '.tar.gz'); }
  iconPath(sha) { return path.join(this.data, 'icons', sha + '.png'); }

  // A truncated-hash collision is refused (design.md section 4).
  async storeRecord(hash, rec) {
    const p = this.recordPath(hash);
    let old = null;
    try { old = await fsp.readFile(p); } catch (e) { /* new */ }
    if (old !== null) {
      if (!old.equals(Buffer.from(rec))) throw new Error('record hash collision; change any field and try again');
      return;
    }
    await writeAtomic(p, rec);
  }

  /* ---------- icons ---------- */

  // StoreIcon: an upload checked by validate() (and decoded) is stored under
  // its SHA-256, and the request carries the hash instead, so the queued
  // job stays small.
  async storeIcon(r, png) {
    if (!png) return;
    const sha = sha256hex(png);
    if (!exists(this.iconPath(sha))) await writeAtomic(this.iconPath(sha), png);
    r.icon.sha256 = sha;
    r.icon.data = '';
  }

  // loadIcon: the job's stored icon, checked.
  async iconPng(icon) {
    if (!icon || !icon.sha256) return null;
    let data;
    try { data = await fsp.readFile(this.iconPath(icon.sha256)); } catch (e) { throw new Error('the icon wasn\'t found; upload it again'); }
    if (sha256hex(data) !== icon.sha256) throw new Error('the stored icon is damaged; upload it again');
    await decodeIconPng(data);
    return new Uint8Array(data);
  }

  /* ---------- records and plans ---------- */

  // srcFile describes a stored source archive (strip -1: work it out).
  srcFile(sha, strip) {
    const p = this.srcPath(sha);
    let st;
    try { st = fs.statSync(p); } catch (e) { return null; }
    if (strip < 0) strip = topFolder(fs.readFileSync(p));
    return { name: sha + '.tar.gz', sha256: sha, size: st.size, format: 'tar.gz', strip,
      urls: [this.public.replace(/\/+$/, '') + '/src/' + sha + '.tar.gz'] };
  }

  // LoadApp: a stored record as the resolver's app.
  async loadApp(hash) {
    let rec;
    try {
      rec = await fsp.readFile(this.recordPath(hash), 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new NotFoundError('no such record');
      throw e;
    }
    const lines = parseLines(rec);
    const g = (k) => { const l = lines.find((x) => x.key === k); return l ? l.val(0) : ''; };
    const app = {
      recordHash: hash, name: g('name'), project: g('project'), runtime: g('runtime'), select: g('select'),
      range: g('range'), launch: g('launch'), install: g('install'), console: g('console') === '1',
      menu: g('menu') === '1', desktop: g('desktop') === '1', root: g('root'), rootName: g('rootname'),
      platforms: g('platforms').trim().split(/\s+/).filter(Boolean), source: null, package: '', packageVersion: '',
    };
    for (const l of lines) {
      if (l.key !== 'source') continue;
      switch (l.val(0)) {
        case 'inline':
          app.source = this.srcFile(l.val(1), 1);
          break;
        case 'github':
          app.source = this.srcFile(l.val(3), 1);
          if (app.source) app.source.urls.push('https://codeload.github.com/' + l.val(1) + '/tar.gz/' + l.val(2));
          break;
        case 'url':
          app.source = this.srcFile(l.val(2), -1);
          if (app.source) app.source.urls.push(l.val(1));
          break;
        case 'package': {
          let name;
          try { name = validPackage(this.cat, app.runtime, l.val(1), l.val(2)); } catch (e) { throw new Error('record ' + hash + ': ' + e.message); }
          app.package = name;
          app.packageVersion = l.val(2);
          break;
        }
        default:
          break;
      }
    }
    return { app, rec };
  }

  // preparePackage: a record without a pinned version (plain names) gets
  // today's newest, and launch tokens the record left open are filled in.
  async preparePackage(app) {
    const p = packagePolicyFor(this.cat, app.runtime);
    if (app.packageVersion !== '' && !app.launch.includes('{bin')) return;
    const info = await this.lookupPackage(app.runtime, app.package, app.packageVersion);
    app.packageVersion = info.version;
    app.launch = packageLaunch(app.launch, p, app.package, info);
  }

  // Plan: the current plan for a stored record, and the files it downloads
  // (with absolute `local` paths of our copies), the app's own source last.
  async plan(hash, platforms) {
    const { app } = await this.loadApp(hash);
    if (platforms) app.platforms = platforms;
    if (app.package) await this.preparePackage(app);
    const { plan, files } = resolveFiles(this.cat, app);
    const out = files.map((f) => Object.assign({}, f, { local: localPath(this.cat, f.local) }));
    if (app.source) {
      const s = app.source;
      out.push({ name: s.name, sha256: s.sha256, size: s.size, local: this.srcPath(s.sha256), urls: s.urls });
    }
    return { plan, files: out };
  }

  // What GET /api/plan/{hash} serves and offline installers embed.
  async signedPlan(hash, platforms) {
    const { plan, files } = await this.plan(hash, platforms);
    if (!this.signer) throw new Error('no plan signing key');
    return { plan: this.signer.signString(plan), files };
  }

  // GET /api/plan/name/{runtime}/{name}: the plan also says, inside the
  // signature, which name it answers (format.md "Plan signature").
  async signedNamePlan(hash, platforms, runtime, name) {
    const { plan, files } = await this.plan(hash, platforms);
    if (!this.signer) throw new Error('no plan signing key');
    return { plan: this.signer.signString(addRequestLine(plan, 'name', runtime, name)), files };
  }

  /* ---------- packages ---------- */

  // registryJSON: registry metadata, cached for ten minutes so plain names
  // can't be used to hammer a registry through us. The answer is untrusted
  // data: only a version and a program name are taken from it, and both
  // are checked before use.
  async registryJSON(tmpl, name, version) {
    const u = replacer('{name}', pathEscape(name), '{version}', pathEscape(version))(tmpl).split('%2F').join('/');
    const hit = this.lookupCache.get(u);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) {
      if (hit.err) throw hit.err;
      return hit.doc;
    }
    let res;
    try {
      res = await this.fetch(u, { timeout: 30000, headers: { Accept: 'application/json', 'User-Agent': 'installer-builder/0.1 (+' + this.public + ')' } });
    } catch (e) {
      throw new Error('Get "' + u + '": ' + e.message);
    }
    let doc = null, err = null;
    if (res.status === 404 || res.status === 410) {
      res.discard();
      err = new Error('no such package');
      err.noPackage = true;
    } else if (res.status !== 200) {
      res.discard();
      throw new Error('package registry: ' + res.statusLine);
    } else {
      try {
        doc = JSON.parse((await res.upTo(64 << 20)).toString('utf8'));
      } catch (e) {
        err = new Error('package registry: unreadable answer: ' + e.message);
      }
    }
    this.lookupCache.set(u, { at: Date.now(), doc, err });
    if (this.lookupCache.size > 5000) {
      for (const [k, v] of this.lookupCache) if (Date.now() - v.at >= 10 * 60 * 1000) this.lookupCache.delete(k);
    }
    if (err) throw err;
    return doc;
  }

  lookupPackage(runtime, name, version) {
    return lookupPackageJS({ catalog: this.cat, registryJSON: (t, n, v) => this.registryJSON(t, n, v) }, runtime, name, version);
  }

  // NameRecord: the record behind a plain file name, install_<runtime>_<package>:
  // the package from the runtime's registry with every setting at its
  // default. Its bytes depend only on the runtime, the name and this server's
  // URL, so the same name always gives the same record hash.
  async nameRecord(runtime, name) {
    if (name.startsWith('@')) {
      throw new Error(`scoped package names (${name}) can't be used in a plain file name; make an installer for it with the form instead`);
    }
    name = validPackage(this.cat, runtime, name, '');
    const p = packagePolicyFor(this.cat, runtime);
    const project = packageProject(p, name);
    const launch = packageLaunch(typeof p.launch === 'string' ? p.launch : '', p, name, null);
    const rec = kvLine('ib-record', '1') + kvLine('name', project) + kvLine('project', project) + kvLine('runtime', runtime) +
      kvLine('select', 'newest') + kvLine('source', 'package', name) + kvLine('launch', launch) + kvLine('install', 'default') +
      kvLine('console', '1') + kvLine('menu', '1') + kvLine('desktop', '0') + kvLine('root', 'user') + kvLine('rootname', 'ib') +
      kvLine('platforms', 'windows linux macos') + kvLine('backend', this.backend) + kvLine('origin', 'name');
    const hash = await recordHash(rec);
    await this.storeRecord(hash, rec);
    return hash;
  }

  /* ---------- sources ---------- */

  async fetchLimited(url, limit) {
    let res;
    try {
      res = await this.fetch(url);
    } catch (e) {
      throw new Error('couldn\'t download the source (only public internet addresses are allowed)');
    }
    if (res.status !== 200) {
      res.discard();
      throw new Error('couldn\'t download the source: the server answered ' + res.statusLine);
    }
    return res.bytes(limit);
  }

  async githubCommit(owner, repo, ref) {
    const u = 'https://api.github.com/repos/' + owner + '/' + repo + '/commits/' + ref;
    let res;
    try {
      res = await this.fetch(u, { headers: { Accept: 'application/vnd.github.sha' } });
    } catch (e) {
      throw new Error('Get "' + u + '": ' + e.message);
    }
    const body = (await res.upTo(4096)).toString('utf8');
    if (res.status !== 200) throw new Error(`GitHub: ${owner}/${repo} at ${ref}: ${res.statusLine}`);
    const sha = body.trim();
    if (sha.length !== 40) throw new Error('GitHub returned an unexpected commit id');
    return sha;
  }

  // GitHub and URL sources, fetched through the public-only client and kept.
  async fetchSource(r) {
    if (r.source.kind === 'github') {
      const m = githubRe.exec(r.source.value.trim());
      const owner = m[1], repo = m[2];
      const commit = await this.githubCommit(owner, repo, r.source.ref || 'HEAD');
      const data = await this.fetchLimited('https://codeload.github.com/' + owner + '/' + repo + '/tar.gz/' + commit, 200 << 20);
      const sha = sha256hex(data);
      await writeAtomic(this.srcPath(sha), data);
      return { sha256: sha, size: data.length, names: tarNamesUnderTop(data), project: repo.toLowerCase(),
        origin: owner + '/' + repo, commit, strip: 1, urls: [] };
    }
    const data = await this.fetchLimited(r.source.value, 200 << 20);
    if (!(data[0] === 0x1f && data[1] === 0x8b)) throw new Error('source URL must be a .tar.gz for now');
    const sha = sha256hex(data);
    await writeAtomic(this.srcPath(sha), data);
    return { sha256: sha, size: data.length, names: tarNamesUnderTop(data), project: projectName(r), strip: topFolder(data), urls: [] };
  }

  /* ---------- bases and outputs ---------- */

  basePath(plat, signed) {
    switch (plat) {
      case 'windows':
        return path.join(this.bases, 'windows', 'out', signed ? 'base-signed.exe' : 'base.exe');
      case 'linux':
        for (const n of ['ib-base.run', 'ib.run']) {
          const p = path.join(this.bases, 'unix', 'out', n);
          if (exists(p)) return p;
        }
        return path.join(this.bases, 'unix', 'out', 'ib-base.run');
      default:
        return path.join(this.bases, 'unix', 'out', 'ib-base-macos.zip');
    }
  }

  async base(plat) {
    const p = this.basePath(plat, false);
    try {
      return new Uint8Array(await fsp.readFile(p));
    } catch (e) {
      throw new Error('base installer missing: open ' + p + ': ' + (e.code === 'ENOENT' ? 'no such file or directory' : e.message));
    }
  }

  async signedBase(plat) {
    const p = this.basePath(plat, true);
    if (!exists(p)) return null;
    return { data: new Uint8Array(await fsp.readFile(p)), signedBy: SIGNED_BY };
  }

  // packFiles: a local copy of every file a plan needs, downloading (and
  // checking) any we don't have.
  async packFiles(files, progress) {
    const out = [], seen = new Set();
    for (const f of files) {
      if (seen.has(f.sha256)) continue;
      seen.add(f.sha256);
      let p = f.local;
      if (!p) {
        p = path.join(this.data, 'cache', f.sha256);
        if (!exists(p)) {
          progress('Downloading ' + f.name);
          await this.download(f, p);
        }
      }
      const size = fs.statSync(p).size;
      out.push({ name: f.sha256, size, path: p, read: async () => new Uint8Array(await fsp.readFile(p)) });
    }
    return out;
  }

  async download(f, dst) {
    let last = null;
    for (const u of f.urls || []) {
      let res;
      try {
        res = await this.fetch(u);
      } catch (e) {
        last = e.message;
        continue;
      }
      if (res.status !== 200) {
        res.discard();
        last = u + ': ' + res.statusLine;
        continue;
      }
      await fsp.mkdir(path.dirname(dst), { recursive: true });
      const tmp = dst + '.tmp';
      const h = crypto.createHash('sha256');
      let ok = true;
      try {
        const out = fs.createWriteStream(tmp);
        for await (const c of res.body) {
          h.update(c);
          if (!out.write(c)) await new Promise((r) => out.once('drain', r));
        }
        await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
      } catch (e) {
        ok = false;
      }
      if (ok && h.digest('hex') === f.sha256) {
        await fsp.rename(tmp, dst);
        return;
      }
      await fsp.rm(tmp, { force: true });
      last = u + ': checksum mismatch or read error';
    }
    throw new Error('couldn\'t download ' + f.name + ': ' + (last === null ? '<nil>' : last));
  }

  // save: a built file, under its record's hash so two jobs with the same
  // project name can never replace each other's download.
  async save(hash, name, spec) {
    const out = path.join(this.data, 'dl', hash, name);
    if (spec.layout) return writeInstallerFile(out, spec.layout);
    await writeAtomic(out, spec.data);
    return sha256File(out);
  }

  // The env js/builder.js runs a job with on the server.
  env() {
    return {
      catalog: this.cat,
      backend: this.backend,
      product: 'Installer Builder',
      modes: ['A', 'B', 'C'],
      packRuntimes: true,
      base: (plat) => this.base(plat),
      signedBase: (plat) => this.signedBase(plat),
      registryJSON: (t, n, v) => this.registryJSON(t, n, v),
      fetchSource: (r) => this.fetchSource(r),
      storeSource: (sha, data) => writeAtomic(this.srcPath(sha), data),
      storeRecord: (hash, rec) => this.storeRecord(hash, rec),
      takenDown: (entry) => this.takenDown(entry),
      iconPng: (icon) => this.iconPng(icon),
      packPlan: async (hash, plat, progress) => {
        const { plan, files } = await this.signedPlan(hash, [plat]);
        return { plan, files: await this.packFiles(files, progress) };
      },
      save: (hash, name, spec) => this.save(hash, name, spec),
    };
  }

  // Run is the queue's handler: a queued request to its result (api.md).
  async run(request, progress) {
    const r = JSON.parse(JSON.stringify(request));
    const out = await runJob(r, this.env(), progress);
    return {
      record: out.hash,
      files: out.files.map((f) => ({ platform: f.platform, name: f.name, url: '/dl/' + out.hash + '/' + f.name,
        size: f.size, sha256: f.sha256, signed: f.signed, offline: f.offline })),
    };
  }
}
