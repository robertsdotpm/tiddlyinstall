// The runtime catalogue for the server: js/resolve.js loaded from the
// catalogue folder and the policy file (Go's catalog.Load), with a
// LocalIndex of our own copies of catalogue files, as the Go server's was
// (server/internal/catalog/local.go, retired): it finds them by name and size, and
// hashes the ones the catalogue has no checksum for, remembering hashes in
// sha-cache.json across restarts (the same file and format as Go's).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadCatalogFiles } from '../../js/resolve.js';

export class LocalIndex {
  constructor(root, cachePath) {
    this.root = root;
    this.cachePath = cachePath;
    this.loaded = false;
  }

  load() {
    if (this.loaded) return;
    this.loaded = true;
    this.byName = new Map();
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) || {}; } catch (e) { /* none yet */ }
    // filepath.WalkDir: lexical order, symlinks not followed; skip the
    // catalogue, reference material and dot folders.
    const walk = (dir, rel) => {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const d of ents) {
        const r = rel ? rel + '/' + d.name : d.name;
        if (d.isDirectory()) {
          if (d.name === 'catalog' || d.name === 'reference' || d.name.startsWith('.')) continue;
          walk(path.join(dir, d.name), r);
        } else {
          this.add(d.name, r);
          // Our copies keep the name the vendor's URL has, escapes and
          // all (tools/download.py takes the URL's last segment), but the
          // catalogue's own name for a file un-escapes `%2B` (resolve.js
          // fileName), so python-build-standalone's
          // cpython-3.14.7%2B20260901-… is stored under one name and
          // looked for under the other. 73 files were invisible to this
          // index because of it, and their plans had no mirror URL at
          // all. Index both spellings.
          const plus = d.name.split('%2B').join('+');
          if (plus !== d.name) this.add(plus, r);
        }
      }
    };
    walk(this.root, '');
  }

  add(name, rel) {
    if (!this.byName.has(name)) this.byName.set(name, []);
    this.byName.get(name).push(rel);
  }

  // The relative path of our copy of a file with this name and size (size
  // 0 = any), or "". When several copies share the name and the SHA-256 is
  // known, only a copy with that SHA-256 (python's component MSIs are all
  // core.msi, lib.msi..., and their sizes, multiples of 4 KiB, repeat).
  find(name, size, sha256) {
    this.load();
    const all = this.byName.get(name) || [];
    for (const rel of all) {
      if (size > 0) {
        try { if (fs.statSync(path.join(this.root, rel)).size !== size) continue; } catch (e) { continue; }
      }
      if (sha256 && all.length > 1) {
        const h = this.sha256(rel);
        if (!h || h.sha256 !== sha256) continue;
      }
      return rel;
    }
    return '';
  }

  // Hashes our copy (synchronously: the resolver is synchronous), cached by
  // size and modification time. Returns {sha256, size} or null.
  sha256(rel) {
    const p = path.join(this.root, rel);
    let st;
    try { st = fs.statSync(p); } catch (e) { return null; }
    this.load();
    const mtime = Math.floor(st.mtimeMs / 1000);
    const c = this.cache[rel];
    if (c && c.size === st.size && c.mtime === mtime) return { sha256: c.sha256, size: c.size };
    const h = crypto.createHash('sha256');
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (!n) break;
        h.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    const sum = h.digest('hex');
    this.cache[rel] = { size: st.size, mtime, sha256: sum };
    const sortedCache = {};
    for (const k of Object.keys(this.cache).sort()) sortedCache[k] = this.cache[k];
    try {
      fs.writeFileSync(this.cachePath + '.tmp', JSON.stringify(sortedCache));
      fs.renameSync(this.cachePath + '.tmp', this.cachePath);
    } catch (e) { /* the cache is only a cache */ }
    return { sha256: sum, size: st.size };
  }
}

function readJSONFile(p, optional) {
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (optional && e.code === 'ENOENT') return undefined;
    throw new Error('open ' + p + ': ' + (e.code === 'ENOENT' ? 'no such file or directory' : e.message));
  }
  try { return JSON.parse(text); } catch (e) { throw new Error(p + ': ' + e.message); }
}

// loadCatalog: {dir, policyPath, localRoot, cachePath}. The catalogue's
// `localRoot` is set so file references can be made absolute.
export function loadCatalog({ dir, policyPath, localRoot, cachePath }) {
  const policy = readJSONFile(policyPath);
  const files = {
    'policy.json': policy,
    'os_versions.json': readJSONFile(path.join(dir, 'os_versions.json')),
  };
  const comp = readJSONFile(path.join(dir, 'compilers_min_os.json'), true);
  if (comp !== undefined) files['compilers_min_os.json'] = comp;
  for (const id of Object.keys(policy.runtimes || {})) {
    const pol = policy.runtimes[id] || {};
    const folder = (typeof pol.folder === 'string' && pol.folder) || id;
    if (files[folder + '/releases.json'] !== undefined) continue;
    files[folder + '/releases.json'] = readJSONFile(path.join(dir, folder, 'releases.json'));
    files[folder + '/install.json'] = readJSONFile(path.join(dir, folder, 'install.json'));
    const sup = readJSONFile(path.join(dir, folder, 'os_support.json'), true);
    if (sup !== undefined) files[folder + '/os_support.json'] = sup;
  }
  const local = localRoot ? new LocalIndex(localRoot, cachePath) : null;
  const opts = {};
  if (local) {
    opts.sha = (e, name) => {
      const rel = local.find(name, e.size, e.sha256);
      if (!rel) return null;
      if (e.sha256) return { local: rel };
      const h = local.sha256(rel);
      return h ? { local: rel, sha256: h.sha256, size: h.size } : { local: rel };
    };
  }
  const cat = loadCatalogFiles(files, opts);
  cat.localRoot = localRoot || '';
  cat.localIndex = local;
  return cat;
}

// A resolver file reference's `local` (relative to the local root) as an
// absolute path of a copy that exists, or "".
export function localPath(cat, rel) {
  if (!rel || !cat.localRoot) return '';
  const p = path.join(cat.localRoot, rel);
  return fs.existsSync(p) ? p : '';
}
