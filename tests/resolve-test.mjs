// Regression test for js/resolve.js against saved ("golden") answers.
//
//   node tests/resolve-test.mjs [--catalog FILE] [--no-roundtrip] [--show N] [--update]
//
// tests/golden/resolve-cases.json.br holds 3,095 cases: apps covering every
// runtime, select mode, install kind, package source, platform subset and
// flag, each with its plan and files (or its error); the package helpers;
// the hashes; and the runtimes summary. tests/golden/catalog.gz is the
// catalogue snapshot they were resolved from. Both were written on
// 2026-09-19 by the Go resolver (`ibsnapshot -cases`, server/cmd/ibsnapshot,
// removed after this commit's parent; see git history), while it was the
// oracle the JS port was checked against byte for byte. The test loads that
// snapshot and requires identical results from js/resolve.js.
//
// --catalog FILE runs the cases against another snapshot instead (for
// example one tools/snapshot.mjs wrote from the same catalogue folder: the
// plans must be the same). Unless --no-roundtrip, the cases also run
// against the snapshot writeSnapshot writes back from the loaded one.
//
// --update rewrites the golden answers from the current js/resolve.js and
// the snapshot in use (the inputs are kept); with --catalog FILE, that
// snapshot is copied to tests/golden/catalog.gz too. Use it only for an
// intended change, and read the diff.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as R from '../js/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN = path.join(REPO, 'tests/golden');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const SHOW = Number(arg('--show', 5));
const snapFile = path.resolve(arg('--catalog', path.join(GOLDEN, 'catalog.gz')));
const casesFile = path.join(GOLDEN, 'resolve-cases.json.br');

function lineDiff(want, got) {
  const a = want.split('\n'), b = got.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (l) => l.slice(Math.max(0, i - 2), i + 3).map((x, k) => `    ${Math.max(0, i - 2) + k + 1}: ${JSON.stringify(x)}`).join('\n');
  return `  first difference at line ${i + 1}\n  golden:\n${ctx(a)}\n  JS:\n${ctx(b)}`;
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const attempt = (f) => { try { return { v: f() }; } catch (e) { return { err: e.message }; } };
// Go wrote map keys sorted.
const canon = (x) => JSON.stringify(x, (k, y) => (y && typeof y === 'object' && !Array.isArray(y) ? Object.fromEntries(Object.entries(y).sort()) : y));

// What js/resolve.js answers for a case's inputs, in the golden file's shape.
async function answer(cat, c) {
  const out = {};
  const put = (r, f) => { if (r.err !== undefined) out.error = r.err; else f(r.v); };
  switch (c.kind) {
    case 'resolve':
      put(attempt(() => R.resolveFiles(cat, c.app)), (v) => {
        out.plan = v.plan;
        out.files = v.files.map(({ name, sha256, size, urls }) => ({ name, sha256, size, urls }));
        out.localOK = v.files.every((f) => typeof f.local === 'string');
        out.resolveSame = R.resolve(cat, c.app) === v.plan;
      });
      break;
    case 'validPackage':
      out.result = '';
      put(attempt(() => R.validPackage(cat, c.runtime, c.name, c.version)), (v) => { out.result = v; });
      break;
    case 'packagePolicyFor':
      out.has = false;
      put(attempt(() => R.packagePolicyFor(cat, c.runtime)), (v) => { out.has = !!v; });
      break;
    case 'packageProject':
      out.result = R.packageProject(c.runtime === '' ? null : R.packagePolicyFor(cat, c.runtime), c.name);
      break;
    case 'packageModule':
      out.result = R.packageModule(c.name);
      break;
    case 'packageTokens':
      out.result = R.packageTokens(R.packagePolicyFor(cat, c.runtime), c.name, c.version)(c.input);
      break;
    case 'pickBin':
      out.name = ''; out.path = '';
      put(attempt(() => R.pickBin(c.v, c.project)), (v) => { out.name = v.name; out.path = v.path; });
      break;
    case 'jsonField':
      out.result = R.jsonField(c.v, c.path) ?? null;
      break;
    case 'hash':
      out.hash26 = await R.hash26(c.text);
      out.hash12 = await R.hash12(c.text);
      break;
    default:
      throw new Error('unknown case kind ' + c.kind);
  }
  return out;
}

// null if JS agrees with the golden case, else what differs.
async function check(cat, c) {
  const a = await answer(cat, c);
  if ((a.error ?? '') !== (c.error ?? '')) return `error: golden ${JSON.stringify(c.error ?? null)}, JS ${JSON.stringify(a.error ?? null)}`;
  switch (c.kind) {
    case 'resolve':
      if (a.error !== undefined) return null;
      if (a.plan !== c.plan) return lineDiff(c.plan, a.plan);
      if (!same(a.files, c.files)) return `files: golden ${JSON.stringify(c.files)}\n  JS ${JSON.stringify(a.files)}`;
      if (!a.localOK) return 'files: local not a string';
      return a.resolveSame ? null : 'resolve() differs from resolveFiles().plan';
    case 'validPackage':
      return a.error !== undefined || a.result === c.result ? null : `result: golden ${JSON.stringify(c.result)}, JS ${JSON.stringify(a.result)}`;
    case 'packagePolicyFor':
      return a.has === c.has ? null : 'has differs';
    case 'pickBin':
      return a.error !== undefined || (a.name === c.name && a.path === c.path) ? null : `golden ${c.name} ${c.path}, JS ${a.name} ${a.path}`;
    case 'jsonField':
      return canon(a.result) === canon(c.result ?? null) ? null : `golden ${JSON.stringify(c.result)}, JS ${JSON.stringify(a.result)}`;
    case 'hash':
      return a.hash26 === c.hash26 && a.hash12 === c.hash12 ? null : `golden ${c.hash26} ${c.hash12}, JS ${a.hash26} ${a.hash12}`;
    default:
      return a.result === c.result ? null : `golden ${JSON.stringify(c.result)}, JS ${JSON.stringify(a.result)}`;
  }
}

let failures = 0;
async function run(title, cat, data) {
  const t0 = performance.now();
  let bad = 0;
  const kinds = {};
  for (const c of data.cases) {
    kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    const d = await check(cat, c);
    if (d === null) continue;
    if (++bad <= SHOW) console.log(`MISMATCH ${c.kind} ${c.app ? c.app.runtime + ' / ' + c.note : JSON.stringify(c)}\n${d}\n`);
  }
  const sum = R.runtimesSummary(cat);
  if (!same(sum, data.summary)) {
    bad++;
    console.log('MISMATCH runtimes summary\n' + lineDiff(JSON.stringify(data.summary, null, 1), JSON.stringify(sum, null, 1)));
  }
  failures += bad;
  const counts = Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`${title}: ${data.cases.length + 1} cases (${counts}, summary 1), ${bad} mismatches, ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

const data = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(casesFile)));
const bytes = new Uint8Array(fs.readFileSync(snapFile));
let t0 = performance.now();
const cat = await R.loadSnapshot(bytes);
console.log(`${path.relative(REPO, snapFile)} ${(bytes.length / 1024).toFixed(0)} KB: loadSnapshot ${(performance.now() - t0).toFixed(0)} ms`);

if (process.argv.includes('--update')) {
  const fields = ['plan', 'files', 'error', 'result', 'has', 'name', 'path', 'hash26', 'hash12'];
  for (const c of data.cases) {
    const a = await answer(cat, c);
    for (const f of fields) if ((f !== 'name' && f !== 'path') || c.kind === 'pickBin') delete c[f];
    delete a.localOK; delete a.resolveSame;
    Object.assign(c, a);
  }
  data.summary = R.runtimesSummary(cat);
  const b = Buffer.from(JSON.stringify(data));
  fs.writeFileSync(casesFile, zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }));
  if (snapFile !== path.join(GOLDEN, 'catalog.gz')) fs.copyFileSync(snapFile, path.join(GOLDEN, 'catalog.gz'));
  console.log(`updated ${path.relative(REPO, casesFile)} (${data.cases.length} cases); review the diff before committing`);
  process.exit(0);
}

await run('golden cases', cat, data);
if (!process.argv.includes('--no-roundtrip')) {
  // writeSnapshot, read back: the same answers.
  await run('snapshot written back by writeSnapshot', await R.loadSnapshot(await R.writeSnapshot(cat)), data);
}
console.log(failures ? `FAIL: ${failures} mismatches` : 'PASS');
process.exit(failures ? 1 : 0);
