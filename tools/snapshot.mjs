// Writes what the one-file site (docs/plan.md section 1.11) needs from the
// runtime catalogue: catalog.gz, the catalogue snapshot (src/shared/resolve.js
// writeSnapshot), and runtimes.json, what GET /api/catalog/runtimes answers
// (runtimesSummary, written as the server writes it). tools/build_site.py
// runs it.
//
//   node tools/snapshot.mjs [-o DIR] [-catalog DIR] [-local DIR] [-policy FILE]
//                           [-cache FILE] [-mirror URL] [-split DIR]
//   node tools/snapshot.mjs -from catalog.gz -split DIR
//
// -split DIR also writes the snapshot split by catalogue folder, as the page
// carries it (splitSnapshot; docs/format.md section 6): DIR/index.json and
// DIR/FOLDER.gz for each folder. With -from, only that, from a catalog.gz
// already written (tools/build_site.py does this with the one it is given).
//
// The catalogue is loaded as the build server loads it (src/build_server/lib/
// catalog.js): with the index of our local copies and the hash cache, so
// the snapshot carries our copies' SHA-256 and mirror paths.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../src/build_server/lib/catalog.js';
import { goJSON } from '../src/build_server/lib/gojson.js';
import { writeSnapshot, runtimesSummary, splitSnapshot } from '../src/shared/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = path.join(os.homedir(), 'projects/installer-builder-runtimes');
const defs = {
  o: ['.', 'output folder'],
  catalog: [path.join(RUNTIMES, 'catalog'), 'runtime catalogue'],
  local: [RUNTIMES, 'our copies of catalogue files'],
  policy: [path.join(REPO, 'src/build_server/policy.json'), 'resolver policy'],
  cache: [path.join(REPO, 'src/build_server/data/sha-cache.json'), 'hash cache (the build server\'s)'],
  mirror: ['', "URL of our mirror in plans (default: the policy's mirror_base)"],
  split: ['', 'also write the split snapshot (index.json, FOLDER.gz) to this folder'],
  from: ['', 'split this catalog.gz instead of loading the catalogue (with -split)'],
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

// The split snapshot: index.json (compact JSON) and FOLDER.gz, replacing
// what an earlier split left in DIR. The chunks are gzipped again at level
// 9 (CompressionStream has no level; they go into the page).
async function writeSplit(src, dir) {
  const { index, chunks } = await splitSnapshot(src);
  for (const c of chunks) {
    c.bytes = zlib.gzipSync(zlib.gunzipSync(c.bytes), { level: 9 });
    index.folders[c.folder].size = c.bytes.length;
  }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/\.gz$|^index\.json$/.test(f)) fs.rmSync(path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index) + '\n');
  for (const c of chunks) fs.writeFileSync(path.join(dir, c.folder + '.gz'), c.bytes);
  const size = chunks.reduce((n, c) => n + c.bytes.length, 0);
  console.log(`split snapshot: ${chunks.length} folders, ${size >> 10} KB, written to ${dir}`);
}

const t0 = performance.now();
if (o.from !== '') {
  if (o.split === '') { console.error('-from needs -split DIR'); process.exit(2); }
  await writeSplit(new Uint8Array(fs.readFileSync(o.from)), o.split);
  process.exit(0);
}
const cat = loadCatalog({ dir: o.catalog, policyPath: o.policy, localRoot: o.local, cachePath: o.cache });
if (o.mirror !== '') cat.policy.mirror_base = o.mirror;
const snap = await writeSnapshot(cat);
const summary = goJSON(runtimesSummary(cat));
fs.mkdirSync(o.o, { recursive: true });
fs.writeFileSync(path.join(o.o, 'catalog.gz'), snap);
fs.writeFileSync(path.join(o.o, 'runtimes.json'), summary);
console.log(`catalog.gz ${snap.length >> 10} KB, runtimes.json written to ${o.o} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
if (o.split !== '') await writeSplit(snap, o.split);
