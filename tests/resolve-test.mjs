// Oracle test for js/resolve.js: every case `ibsnapshot -cases` wrote (the
// Go resolver's plan, files or error for each app, the runtimes summary,
// the package helpers and the hashes) must come out identical in JS.
//
//   node tests/resolve-test.mjs [--dir DIR] [--folder] [--no-go] [--show N]
//
// DIR (default server/data/resolve-test, gitignored) holds catalog.gz and
// cases.json; missing ones are made with `go run ./cmd/ibsnapshot`. Also
// checks writeSnapshot: the JS resolver gives the same results from its
// own snapshot, and (unless --no-go) so does the Go resolver reading it.
// --folder also loads the catalogue folder itself (loadCatalogFiles, as a
// Node server would, with no local copies) against folder-cases.json.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../js/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const DIR = path.resolve(arg('--dir', path.join(REPO, 'server/data/resolve-test')));
const SHOW = Number(arg('--show', 5));
const CATDIR = path.join(process.env.HOME, 'projects/installer-builder-runtimes/catalog');

function ibsnapshot(...args) {
  execFileSync('go', ['run', './cmd/ibsnapshot', ...args], { cwd: path.join(REPO, 'server'), stdio: 'inherit' });
}

fs.mkdirSync(DIR, { recursive: true });
const snapFile = path.join(DIR, 'catalog.gz'), casesFile = path.join(DIR, 'cases.json');
if (!fs.existsSync(snapFile)) ibsnapshot('-o', DIR);
if (!fs.existsSync(casesFile)) ibsnapshot('-from', snapFile, '-cases', casesFile);

function lineDiff(want, got) {
  const a = want.split('\n'), b = got.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const ctx = (l) => l.slice(Math.max(0, i - 2), i + 3).map((x, k) => `    ${Math.max(0, i - 2) + k + 1}: ${JSON.stringify(x)}`).join('\n');
  return `  first difference at line ${i + 1}\n  Go:\n${ctx(a)}\n  JS:\n${ctx(b)}`;
}

const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
const attempt = (f) => { try { return { v: f() }; } catch (e) { return { err: e.message }; } };

// One case: null if JS agrees with Go, else what differs.
async function check(cat, c) {
  const errOK = (r) => (r.err ?? '') === (c.error ?? '') || `error: Go ${JSON.stringify(c.error ?? null)}, JS ${JSON.stringify(r.err ?? null)}`;
  switch (c.kind) {
    case 'resolve': {
      const r = attempt(() => R.resolveFiles(cat, c.app));
      const e = errOK(r);
      if (e !== true) return e;
      if (r.err) return null;
      if (r.v.plan !== c.plan) return lineDiff(c.plan, r.v.plan);
      const files = r.v.files.map(({ name, sha256, size, urls }) => ({ name, sha256, size, urls }));
      if (!same(files, c.files)) return `files: Go ${JSON.stringify(c.files)}\n  JS ${JSON.stringify(files)}`;
      if (!r.v.files.every((f) => typeof f.local === 'string')) return 'files: local not a string';
      const plan = R.resolve(cat, c.app);
      return plan === c.plan ? null : 'resolve() differs from resolveFiles().plan';
    }
    case 'validPackage': {
      const r = attempt(() => R.validPackage(cat, c.runtime, c.name, c.version));
      const e = errOK(r);
      if (e !== true) return e;
      return r.err || r.v === c.result ? null : `result: Go ${JSON.stringify(c.result)}, JS ${JSON.stringify(r.v)}`;
    }
    case 'packagePolicyFor': {
      const r = attempt(() => R.packagePolicyFor(cat, c.runtime));
      const e = errOK(r);
      return e !== true ? e : !!r.v === c.has ? null : 'has differs';
    }
    case 'packageProject': {
      const p = c.runtime === '' ? null : R.packagePolicyFor(cat, c.runtime);
      const v = R.packageProject(p, c.name);
      return v === c.result ? null : `Go ${JSON.stringify(c.result)}, JS ${JSON.stringify(v)}`;
    }
    case 'packageModule': {
      const v = R.packageModule(c.name);
      return v === c.result ? null : `Go ${JSON.stringify(c.result)}, JS ${JSON.stringify(v)}`;
    }
    case 'packageTokens': {
      const v = R.packageTokens(R.packagePolicyFor(cat, c.runtime), c.name, c.version)(c.input);
      return v === c.result ? null : `Go ${JSON.stringify(c.result)}, JS ${JSON.stringify(v)}`;
    }
    case 'pickBin': {
      const r = attempt(() => R.pickBin(c.v, c.project));
      const e = errOK(r);
      if (e !== true) return e;
      return r.err || (r.v.name === c.name && r.v.path === c.path) ? null : `Go ${c.name} ${c.path}, JS ${r.v.name} ${r.v.path}`;
    }
    case 'jsonField': {
      const v = R.jsonField(c.v, c.path);
      // Go writes map keys sorted.
      const canon = (x) => JSON.stringify(x, (k, y) => (y && typeof y === 'object' && !Array.isArray(y) ? Object.fromEntries(Object.entries(y).sort()) : y));
      return canon(v) === canon(c.result ?? null) ? null : `Go ${JSON.stringify(c.result)}, JS ${JSON.stringify(v)}`;
    }
    case 'hash': {
      const [h26, h12] = [await R.hash26(c.text), await R.hash12(c.text)];
      return h26 === c.hash26 && h12 === c.hash12 ? null : `Go ${c.hash26} ${c.hash12}, JS ${h26} ${h12}`;
    }
  }
  return 'unknown case kind ' + c.kind;
}

let failures = 0;
async function run(title, cat, data) {
  let bad = 0;
  const kinds = {};
  for (const c of data.cases) {
    kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    const d = await check(cat, c);
    if (d === null) continue;
    if (++bad <= SHOW) console.log(`MISMATCH ${c.kind} ${c.app ? c.app.runtime + ' / ' + c.note : JSON.stringify(c)}\n${d}\n`);
  }
  const sum = R.runtimesSummary(cat);
  const sumOK = same(sum, data.summary);
  if (!sumOK) {
    bad++;
    console.log('MISMATCH runtimes summary\n' + lineDiff(JSON.stringify(data.summary, null, 1), JSON.stringify(sum, null, 1)));
  }
  failures += bad;
  const counts = Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`${title}: ${data.cases.length + 1} cases (${counts}, summary 1), ${bad} mismatches`);
}

// 1. The Go snapshot.
const cases = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const bytes = new Uint8Array(fs.readFileSync(snapFile));
let t0 = performance.now();
const cat = await R.loadSnapshot(bytes);
const tLoad = performance.now() - t0;
const first = cases.cases.find((c) => c.kind === 'resolve' && !c.error);
t0 = performance.now();
R.resolve(cat, first.app);
const tFirst = performance.now() - t0;
t0 = performance.now();
R.resolve(cat, first.app);
const tAgain = performance.now() - t0;
console.log(`catalog.gz ${(bytes.length / 1024).toFixed(0)} KB: loadSnapshot ${tLoad.toFixed(0)} ms, first resolve (${first.app.runtime}) ${tFirst.toFixed(1)} ms, again ${tAgain.toFixed(1)} ms`);
t0 = performance.now();
await run('Go snapshot', cat, cases);
console.log(`  (all cases in ${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// 2. The JS-written snapshot, read by JS and (unless --no-go) by Go.
const jsSnap = await R.writeSnapshot(cat);
const jsFile = path.join(DIR, 'catalog-js.gz');
fs.writeFileSync(jsFile, jsSnap);
await run('JS snapshot, JS resolver', await R.loadSnapshot(jsSnap), cases);
if (!process.argv.includes('--no-go')) {
  const goCases = path.join(DIR, 'cases-from-js.json');
  ibsnapshot('-from', jsFile, '-cases', goCases);
  const got = JSON.parse(fs.readFileSync(goCases, 'utf8'));
  let bad = 0;
  got.cases.forEach((c, i) => {
    if (same(c, cases.cases[i])) return;
    if (++bad <= SHOW) console.log(`MISMATCH Go on the JS snapshot: ${c.kind} ${c.note || ''}\n` + (c.plan ? lineDiff(cases.cases[i].plan || '', c.plan) : JSON.stringify(c)));
  });
  if (got.cases.length !== cases.cases.length || !same(got.summary, cases.summary)) bad++;
  failures += bad;
  console.log(`JS snapshot, Go resolver: ${got.cases.length + 1} cases, ${bad} mismatches`);
}

// 3. The catalogue folder, as a Node server would load it.
if (process.argv.includes('--folder')) {
  const fcFile = path.join(DIR, 'folder-cases.json');
  if (!fs.existsSync(fcFile)) ibsnapshot('-from', snapFile, '-folder-cases', fcFile);
  const files = { 'policy.json': fs.readFileSync(path.join(REPO, 'server/policy.json'), 'utf8') };
  const read = (name) => {
    const p = path.join(CATDIR, name);
    if (fs.existsSync(p)) files[name] = fs.readFileSync(p, 'utf8');
  };
  read('os_versions.json');
  read('compilers_min_os.json');
  for (const [id, p] of Object.entries(JSON.parse(files['policy.json']).runtimes)) {
    for (const f of ['releases.json', 'install.json', 'os_support.json']) read(`${p.folder || id}/${f}`);
  }
  t0 = performance.now();
  const fcat = R.loadCatalogFiles(files);
  console.log(`catalogue folder: loadCatalogFiles ${(performance.now() - t0).toFixed(0)} ms`);
  await run('catalogue folder', fcat, JSON.parse(fs.readFileSync(fcFile, 'utf8')));
}

console.log(failures ? `FAIL: ${failures} mismatches` : 'PASS');
process.exit(failures ? 1 : 0);
