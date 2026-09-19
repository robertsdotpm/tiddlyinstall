// Writes what the one-file site (docs/plan.md section 1.11) needs from the
// runtime catalogue: catalog.gz, the catalogue snapshot the page's builder
// loads (js/resolve.js writeSnapshot), and runtimes.json, what
// GET /api/catalog/runtimes answers (runtimesSummary, written as the
// server writes it). tools/build_site.py runs it.
//
//   node tools/snapshot.mjs [-o DIR] [-catalog DIR] [-local DIR] [-policy FILE]
//                           [-cache FILE] [-mirror URL]
//
// The catalogue is loaded as the build server loads it (backend/lib/
// catalog.js): with the index of our local copies and the hash cache, so
// the snapshot carries our copies' SHA-256 and mirror paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../backend/lib/catalog.js';
import { goJSON } from '../backend/lib/gojson.js';
import { writeSnapshot, runtimesSummary } from '../js/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = path.join(os.homedir(), 'projects/installer-builder-runtimes');
const defs = {
  o: ['.', 'output folder'],
  catalog: [path.join(RUNTIMES, 'catalog'), 'runtime catalogue'],
  local: [RUNTIMES, 'our copies of catalogue files'],
  policy: [path.join(REPO, 'backend/policy.json'), 'resolver policy'],
  cache: [path.join(REPO, 'backend/data/sha-cache.json'), 'hash cache (the build server\'s)'],
  mirror: ['', "URL of our mirror in plans (default: the policy's mirror_base)"],
};
const o = Object.fromEntries(Object.entries(defs).map(([k, [v]]) => [k, v]));
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--?([a-z]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m || !Object.hasOwn(defs, m[1])) {
    console.error(m && (m[1] === 'h' || m[1] === 'help') ? 'Usage of tools/snapshot.mjs:' : 'unknown argument ' + argv[i]);
    for (const [k, [v, help]] of Object.entries(defs)) console.error(`  -${k}\t${help}${v ? ` (default ${JSON.stringify(v)})` : ''}`);
    process.exit(2);
  }
  o[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  if (o[m[1]] === undefined) { console.error('flag needs an argument: -' + m[1]); process.exit(2); }
}

const t0 = performance.now();
const cat = loadCatalog({ dir: o.catalog, policyPath: o.policy, localRoot: o.local, cachePath: o.cache });
if (o.mirror !== '') cat.policy.mirror_base = o.mirror;
const snap = await writeSnapshot(cat);
const summary = goJSON(runtimesSummary(cat));
fs.mkdirSync(o.o, { recursive: true });
fs.writeFileSync(path.join(o.o, 'catalog.gz'), snap);
fs.writeFileSync(path.join(o.o, 'runtimes.json'), summary);
console.log(`catalog.gz ${snap.length >> 10} KB, runtimes.json written to ${o.o} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
