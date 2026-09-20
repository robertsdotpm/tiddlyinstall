// What "mirror every version we offer" actually costs, and the two files
// needed to do it.
//
//   node tools/mirror_scope.mjs [-scope every|minor|newest] [-runtime a,b]
//                               [-platforms windows,macos,linux] [-out DIR]
//                               [-catalog DIR] [-local DIR] [-policy FILE] [-cache FILE]
//
// Background. Our mirror is filled from each runtime's download_plan.json,
// which is one release per (runtime, major, os, arch) -- in practice the
// newest patch. But the form lets a publisher pin a version (`select`
// range or exact), and the resolver will happily choose a release nobody
// mirrored; that plan then carries vendor URLs only, which on a machine
// too old for modern TLS can mean the download simply fails (the Ruby 3.2
// on Windows 7 cell in docs/test-results.md). Closing that means knowing
// what "every version" is, and it is not a small number: this prints it
// rather than leaving it to be discovered halfway through a fetch.
//
// What counts as "offered". Every version the resolver can be made to
// choose: for each runtime, every release that survives the policy's
// `kinds`, `variants`/`only`, `exclude_variants` and `formats` filters and
// is for an os and arch we build for, asked for by exact version, on all
// three platforms, across the whole OS scale -- plus `newest` and the
// asyncio pick. Where a runtime reaches another through policy `via` (C
// and C++ go to zig on Linux and macOS), that runtime's versions are
// offered for it too and are included. A version the catalogue lists but
// no os_support rule lets run anywhere resolves to nothing and costs
// nothing; it is counted in `offered` and not in `files`.
//
//   -scope every    every offered version (the full answer)
//   -scope minor    the newest patch of each major.minor line
//   -scope newest   what the mirror already holds: `select: newest` alone
//
// With -out, writes what a fetch needs, and both halves of it, because a
// file must reach the mirror host *and* this machine's local store or the
// pull achieves nothing (tools/mirror_check.py says why):
//
//   <DIR>/<folder>/download_plan_all.json   for runtime-metadata/tools/download.py
//                                           (--plan-name download_plan_all.json),
//                                           which fills the local store
//   <DIR>/mirror-manifest-all.json          for tools/mirror_fetch.py, run on
//                                           the mirror host
//
// The two are generated together from one enumeration, so they cannot
// disagree about which files are in scope. A release made of several files
// (python's msi-layout: core.msi, exe.msi, lib.msi...) is flattened into
// one plan entry per file, because download.py fetches an entry's `url`
// and knows nothing about `parts`.
//
// Sizes are the catalogue's. Node's releases.json records no size, so
// those entries count as 0 bytes here and the total is a floor; `-sizes
// FILE` takes a {sha256: bytes} JSON to fill them in (HEAD requests, done
// once).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../server/lib/catalog.js';
import { resolveFiles } from '../shared/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = path.join(os.homedir(), 'projects/installer-builder-runtimes');
const o = {
  catalog: path.join(RUNTIMES, 'catalog'), local: RUNTIMES, policy: path.join(REPO, 'server/policy.json'),
  cache: path.join(REPO, 'server/data/sha-cache.json'), scope: 'every', runtime: '',
  platforms: 'windows,macos,linux', out: '', sizes: '',
  excluded: path.join(REPO, 'runtime-metadata/store/mirror-excluded.json'),
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--?([a-z]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m || !Object.hasOwn(o, m[1])) {
    console.error('usage: node tools/mirror_scope.mjs [-' + Object.keys(o).join(' V] [-') + ' V]');
    process.exit(2);
  }
  o[m[1]] = m[2] !== undefined ? m[2] : argv[++i] ?? '';
}
if (!['every', 'minor', 'newest'].includes(o.scope)) {
  console.error('-scope must be every, minor or newest');
  process.exit(2);
}
const platforms = o.platforms.split(',').filter(Boolean);
const only = o.runtime ? new Set(o.runtime.split(',').filter(Boolean)) : null;
const extraSizes = o.sizes ? JSON.parse(fs.readFileSync(o.sizes, 'utf8')) : {};

// Files we are not permitted to mirror at all (runtime-metadata/store/
// mirror-excluded.json: Anaconda's terms, today). They are counted and
// named, and left out of the plan and the manifest, because "not fetched
// yet" and "may never be fetched" are different states and only one of
// them is a gap to close.
const arr = (v) => (Array.isArray(v) ? v : []);
const EXCLUDED = (() => {
  let d;
  try { d = JSON.parse(fs.readFileSync(o.excluded, 'utf8')); } catch (e) { return []; }
  return arr(d.excluded).map((x) => ({ prefixes: arr(x.prefixes).map(String), why: String(x.why || '') }));
})();
const excludedBy = (urls) => EXCLUDED.find((x) => arr(urls).some((u) => x.prefixes.some((p) => String(u).startsWith(p)))) || null;

const cat = loadCatalog({ dir: o.catalog, policyPath: o.policy, localRoot: o.local, cachePath: o.cache });
const POL = cat.policy.runtimes || {};

/* ---------- which releases a version choice can reach ---------- */

// shared/resolve.js `usable`, which is not exported: a release the policy
// lets a plan name at all. Kept in step with it by the plan check at the
// bottom, which re-resolves and compares.
const own = (x, k) => (x != null && typeof x === 'object' && Object.hasOwn(x, k) ? x[k] : undefined);
const list = (v) => (Array.isArray(v) ? v : []);
const has = (l, s) => list(l).includes(s);
const idx = (l, s) => list(l).indexOf(s);
const variant = (r) => (r.variant != null ? r.variant : '');
function usable(pol, e) {
  if (e.kind === 'source' || e.v.pre) return false;
  if (!pol) return true;
  if (list(pol.kinds).length > 0 && !has(pol.kinds, e.kind)) return false;
  if (has(pol.exclude_variants, variant(e)) || has(own(pol.exclude_variants_on, e.os), variant(e))) return false;
  if (pol.only === true && idx(pol.variants, variant(e)) < 0) return false;
  const f = own(pol.formats, e.os);
  return f == null || idx(f, e.format) >= 0;
}
// The architectures a plan can ever name (shared/resolve.js resolveFiles).
const ARCHES = new Set(['amd64', 'arm64', 'x86', 'any', 'universal']);
const cmpV = (a, b) => {
  for (let i = 0; i < Math.max(a.parts.length, b.parts.length); i++) {
    const d = (a.parts[i] || 0) - (b.parts[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
};

// The versions to ask for, for one runtime.
function versionsFor(id, rt) {
  const p = POL[id] || {};
  const ids = new Set([id]);
  // policy `via`: C/C++ is zig on Linux and macOS, so zig's versions are
  // offered for `cc` there and a pinned one must be mirrored too.
  for (const fam of platforms) {
    const v = own(own(p, 'via'), fam);
    if (typeof v === 'string' && v !== '' && cat.runtimes.get(v)) ids.add(v);
  }
  const seen = new Set(), out = [], line = new Map();
  for (const sub of ids) {
    const srt = cat.runtimes.get(sub), spol = POL[sub] || (sub === id ? p : {});
    for (const e of srt.releases) {
      if (!usable(spol, e) || !ARCHES.has(e.arch) || !platforms.includes(e.os)) continue;
      if (o.scope === 'minor') {
        const k = (e.v.parts[0] || 0) + '.' + (e.v.parts[1] || 0);
        const cur = line.get(k);
        if (!cur || cmpV(e.v, cur) > 0) line.set(k, e.v);
      } else if (!seen.has(e.v.raw)) {
        seen.add(e.v.raw);
        out.push(e.v.raw);
      }
    }
  }
  if (o.scope === 'minor') for (const v of new Set([...line.values()].map((v) => v.raw))) out.push(v);
  return out;
}

/* ---------- the enumeration ---------- */

const app = (id, select, range) => ({
  recordHash: 'testtesttesttesttesttestte', name: 'Hello', project: 'hello', runtime: id,
  select, range, launch: (POL[id] || {}).launch || '', console: true, menu: true, platforms,
});

const files = new Map();          // sha256 (or name:size) -> file
const report = [];
for (const [id, rt] of cat.runtimes) {
  if (only && !only.has(id)) continue;
  const asked = o.scope === 'newest' ? [] : versionsFor(id, rt);
  const mine = new Map();
  let reached = 0;
  const take = (a) => {
    let r;
    try { r = resolveFiles(cat, a); } catch (e) { return false; }
    for (const f of r.files) {
      const key = f.sha256 || f.name + ':' + f.size;
      if (!files.has(key)) files.set(key, { ...f, runtimes: new Set() });
      files.get(key).runtimes.add(id);
      mine.set(key, files.get(key));
    }
    return r.files.length > 0;
  };
  for (const v of asked) if (take(app(id, 'exact', v))) reached++;
  // `newest` and the asyncio pick are choices of their own; they should
  // add nothing over every exact version, and the report says if they do.
  const before = mine.size;
  take(app(id, 'newest', ''));
  take(app(id, 'asyncio', ''));
  const fl = [...mine.values()];
  report.push({ id, offered: asked.length, reached, files: fl.length, extraFromNewest: mine.size - before, list: fl });
}

const sizeOf = (f) => f.size || extraSizes[f.sha256] || 0;
const human = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : (n / 1e6).toFixed(1) + ' MB');

console.log(`scope: ${o.scope}   platforms: ${platforms.join(',')}`);
console.log('runtime    offered  resolve   files          bytes   not in local store');
for (const r of report.sort((a, b) => a.id < b.id ? -1 : 1)) {
  const mine = r.list.filter((f) => !excludedBy(f.urls));
  const no = r.list.length - mine.length;
  const miss = mine.filter((f) => f.local === '');
  const b = mine.reduce((a, f) => a + sizeOf(f), 0), mb = miss.reduce((a, f) => a + sizeOf(f), 0);
  console.log(`${r.id.padEnd(10)} ${String(r.offered).padStart(7)} ${String(r.reached).padStart(8)} ${String(mine.length).padStart(7)} ${human(b).padStart(14)}   ${String(miss.length).padStart(5)} / ${human(mb)}`
    + (r.extraFromNewest ? `   (+${r.extraFromNewest} only from newest/asyncio)` : '')
    + (no ? `   (${no} we may not mirror)` : ''));
}
const all = [...files.values()].filter((f) => !excludedBy(f.urls));
const banned = files.size - all.length;
const miss = all.filter((f) => f.local === '');
const unknown = all.filter((f) => sizeOf(f) === 0).length;
console.log('---');
console.log(`union: ${all.length} files, ${human(all.reduce((a, f) => a + sizeOf(f), 0))}`
  + (unknown ? `  (${unknown} of unrecorded size, counted as 0)` : ''));
console.log(`to fetch: ${miss.length} files, ${human(miss.reduce((a, f) => a + sizeOf(f), 0))}`
  + `  -- into the mirror host AND this machine's local store, or the pull changes no plan`);
if (banned) console.log(`left out: ${banned} file(s) we are not permitted to mirror (runtime-metadata/store/mirror-excluded.json)`);

/* ---------- what a fetch needs ---------- */

if (o.out) {
  // Every release entry, by the SHA-256 of the file it names, so a
  // resolved file can be traced back to the catalogue entry that has its
  // url, mirrors, checksum and where it belongs in the store. `parts` are
  // indexed as entries of their own: download.py fetches an entry's `url`
  // and knows nothing about parts, so each becomes its own plan line.
  const byHash = new Map(), byURL = new Map();
  const folders = new Set();
  for (const id of Object.keys(POL)) folders.add((POL[id] || {}).folder || id);
  for (const folder of folders) {
    let rels;
    try { rels = JSON.parse(fs.readFileSync(path.join(o.catalog, folder, 'releases.json'), 'utf8')); } catch (e) { continue; }
    for (const e of rels) {
      const hit = { folder, e, part: null };
      // The URL is the reliable key: the catalogue's checksum is
      // sometimes MD5 (python.org's old MSIs), in which case the entry
      // has no SHA-256 to match on -- the resolver got the file's SHA-256
      // from our own copy. Hash first anyway, because a part and its
      // release share neither url nor name in every runtime.
      const sha = String(e.ti_sha256 || (e.checksum && e.checksum.algo === 'sha256' ? e.checksum.value : '') || '').toLowerCase();
      if (sha && !byHash.has(sha)) byHash.set(sha, hit);
      if (e.url && !byURL.has(e.url)) byURL.set(e.url, hit);
      for (const p of list(e.parts)) {
        const ph = { folder, e, part: p };
        const ps = String(p.ti_sha256 || p.sha256 || '').toLowerCase();
        if (ps && !byHash.has(ps)) byHash.set(ps, ph);
        if (p.url && !byURL.has(p.url)) byURL.set(p.url, ph);
      }
    }
  }
  const find = (f) => byHash.get(String(f.sha256).toLowerCase()) || list(f.urls).map((u) => byURL.get(u)).find(Boolean) || null;
  // runtime-metadata/tools/download.py target_path: the store path a file
  // gets. Repeated here so the manifest and the plan name the same path.
  const storePath = (e, url) => {
    const name = decodeURI(new URL(url).pathname).split('/').filter(Boolean).pop() || 'download';
    const vdir = e.version + (e.variant ? '-' + e.variant : '');
    return [e.runtime, e.os, e.arch, vdir, name].join('/');
  };
  const plans = new Map();        // folder -> entries
  const manifest = [];
  const orphans = [];
  for (const f of all) {
    const hit = find(f);
    if (!hit) {
      // A prerequisite or a policy extra file (get-pip.py, composer.phar,
      // the CA bundle): not a release, so not download.py's business. It
      // goes in the manifest under the path it already has, when we have
      // it; otherwise it is named here rather than silently dropped.
      if (f.local !== '') manifest.push({ path: f.local, size: f.size, sha256: f.sha256 || null, urls: f.urls });
      else orphans.push({ name: f.name, sha256: f.sha256, urls: f.urls });
      continue;
    }
    const { folder, e, part } = hit;
    const url = part ? part.url : e.url;
    const entry = part
      ? { ...e, url: part.url, mirrors: part.mirrors || [], size: part.size || 0,
          checksum: { algo: 'sha256', value: part.ti_sha256 || part.sha256, source: 'catalogue release part' },
          parts: undefined, notes: 'part of ' + e.version + ' (' + (e.variant || 'default') + ')' }
      : { ...e, parts: undefined };
    // One path for both halves. Where we already have the file, that is
    // where it already is: the store's layout is not always
    // <runtime>/<os>/<arch>/<version>/ (ruby's newest Windows builds live
    // under ruby/windows/fetched/), and a second copy at the computed
    // path would shadow the first -- LocalIndex walks lexically -- and
    // move the mirror URL of every plan that names it.
    const p = f.local || storePath(e, url);
    if (!plans.has(folder)) plans.set(folder, []);
    plans.get(folder).push({ ...entry, path: p });
    manifest.push({ path: p, size: sizeOf(f), sha256: f.sha256 || null, urls: [url, ...list(entry.mirrors)] });
  }
  fs.mkdirSync(o.out, { recursive: true });
  const combined = [];
  for (const [folder, entries] of plans) {
    const dir = path.join(o.out, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'download_plan_all.json'), JSON.stringify(entries, null, 1) + '\n');
    for (const e of entries) combined.push(e);
  }
  // One file for download.py --plan, which groups by each entry's own
  // `runtime`: the scope is a set computed across the catalogue, and
  // splitting it per folder only makes it easier to fetch half of it.
  fs.writeFileSync(path.join(o.out, 'download-plan-all.json'), JSON.stringify(combined, null, 1) + '\n');
  fs.writeFileSync(path.join(o.out, 'mirror-manifest-all.json'), JSON.stringify({
    notes: `Every file a plan can download at scope "${o.scope}" (tools/mirror_scope.mjs, ${new Date().toISOString().slice(0, 10)}). `
      + 'For tools/mirror_fetch.py on the mirror host; the matching download_plan_all.json files fill this machine\'s local store, '
      + 'and both halves are needed or the pull changes no plan (tools/mirror_check.py).',
    files: manifest.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  }, null, 1) + '\n');
  console.log(`wrote ${plans.size} download_plan_all.json and mirror-manifest-all.json (${manifest.length} files) under ${o.out}`);
  if (orphans.length) {
    console.log(`${orphans.length} file(s) matched no catalogue release and have no local copy, so they are in neither file:`);
    for (const x of orphans.slice(0, 20)) console.log('  ' + x.name + '  ' + x.sha256);
  }
}
