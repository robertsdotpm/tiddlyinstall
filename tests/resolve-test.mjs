// Regression test for src/shared/resolve.js against saved ("golden") answers.
//
//   node tests/resolve-test.mjs [--catalog FILE] [--no-roundtrip] [--no-lazy] [--show N] [--update]
//
// tests/golden/resolve-cases.json.br holds 3,095 cases: apps covering every
// runtime, select mode, install kind, package source, platform subset and
// flag, each with its plan and files (or its error); the package helpers;
// the hashes; and the runtimes summary. tests/golden/catalog.gz is the
// catalogue snapshot they were resolved from. Both were written on
// 2026-09-19 by the Go resolver (`ibsnapshot -cases`: src/build_server/cmd/ibsnapshot,
// deleted after commit d67744a; git history has it), while it was the
// oracle the JS port was checked against byte for byte. The test loads that
// snapshot and requires identical results from src/shared/resolve.js.
//
// Updated on purpose later (--update), each diff read before committing:
//   2026-09-19  Windows Python's msi-layout releases (the full python.org build
//               from its component MSIs, with release `parts`) and the recipes'
//               launch.gui_program (pythonw, javaw, rubyw, php-win for console 0
//               apps). 152 of the 3,095 answers changed, all Python 3 and 2,
//               Java, PHP and Ruby plans; every other runtime's are the Go
//               resolver's, byte for byte.
//   2026-09-19  Runtime fidelity (tests/fidelity): Ruby's DevKit on Windows and
//               relocatable macOS builds, PHP's extensions, CA bundle and
//               Composer, R's fixed Windows executable and macOS Rscript
//               wrapper, Rust's WinLibs companion on Windows, Nim's DLLs on
//               Windows, and compiler needs for apps that install something.
//               571 of the 3,096 answers changed: nim 105, php 117, r 118,
//               ruby 109, rust 121, and the runtimes summary (Ruby now has
//               macOS releases). Every other runtime's plans are unchanged.
//   2026-09-20  The fixes the template tests found on the German Windows 11
//               VM and the older machines (docs/test-results.md): Python and
//               Python 2 clear TCL_LIBRARY and TK_LIBRARY; Python's
//               requirements rule and package install have a command without
//               --no-warn-script-location for 3.4 and older; the Windows PHP
//               recipes write php.ini with `write` steps, a relative
//               extension_dir and the CA bundle on the command line; WinLibs
//               GCC deletes default-manifest.o when its path has a space
//               (C/C++ directly, Rust and Nim as a companion); R deletes its
//               HKLM uninstall key in the 64-bit registry view; npm's install
//               rule puts Electron's download cache in the app; and Go, whose
//               toolchain is statically linked, is offered on Linux with any
//               glibc. 942 of the 3,096 answers changed: python 154, go 134,
//               rust 121, php 117, nim 116, r 99, python2 99, cc 95, node 6,
//               and the runtimes summary (Go's Linux coverage).
//   2026-09-20  The mirror-gap note (design.md 1.3): a target block whose
//               downloads our mirror has no copy of now carries a `note`
//               saying so, which the engines print on the review screen.
//               344 of the 3,095 answers changed — python2 109, java 50,
//               ruby 36, python 32, rust 26, go 24, node 22, nim 18, zig
//               13, cc 8, php 6 — and **every one of them differs only by
//               added `note` lines**: nothing else in any plan moved, and
//               no record, error or summary changed. Checked by diffing
//               every case against the previous goldens with the note
//               lines removed. The gaps are the golden snapshot's
//               (tests/golden/catalog.gz, 2026-09-19), not today's mirror.
//
// --catalog FILE runs the cases against another snapshot instead (for
// example one tools/snapshot.mjs wrote from the same catalogue folder: the
// plans must be the same). Unless --no-roundtrip, the cases also run
// against the snapshot writeSnapshot writes back from the loaded one.
//
// The cases also run through the lazy catalogue the one-file site uses
// (openSplitSnapshot over splitSnapshot's chunks, docs/format.md section 6),
// unless --no-lazy: once on one catalogue that loads runtimes as the cases
// ask for them (loadRuntimes before each resolve), and once with a fresh
// catalogue per case, loaded with only what loadRuntimes picks for that
// case's runtime, so a dependency it missed ("via", "requires") fails that
// case instead of being there from an earlier one.
//
// --update rewrites the golden answers from the current src/shared/resolve.js and
// the snapshot in use (the inputs are kept); with --catalog FILE, that
// snapshot is copied to tests/golden/catalog.gz too. Use it only for an
// intended change, and read the diff.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as R from '../src/shared/resolve.js';

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

// What src/shared/resolve.js answers for a case's inputs, in the golden file's shape.
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
// catFor(c): the catalogue for case c (a promise), ready for it; summary():
// the runtimes summary. Both default to the one catalogue `cat`.
async function run(title, cat, data, { catFor = async () => cat, summary = async () => R.runtimesSummary(cat) } = {}) {
  const t0 = performance.now();
  let bad = 0;
  const kinds = {};
  for (const c of data.cases) {
    kinds[c.kind] = (kinds[c.kind] || 0) + 1;
    const d = await check(await catFor(c), c);
    if (d === null) continue;
    if (++bad <= SHOW) console.log(`MISMATCH ${c.kind} ${c.app ? c.app.runtime + ' / ' + c.note : JSON.stringify(c)}\n${d}\n`);
  }
  let sum;
  try { sum = await summary(); } catch (e) { sum = { error: e.message }; }
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
freshness();
revocations();

// A withdrawn download is a build that does not exist (design.md 7.1):
// the resolver picks the next one, and only when there is nothing left
// does the target fail -- saying that it was withdrawn, not that the
// catalogue never had it. The rule lives here so the page and the build
// server make the same choice from the same list.
function revocations() {
  let bad = 0;
  const expect = (cond, what) => { if (!cond) { bad++; console.log('MISMATCH revocations: ' + what); } };
  const app = { recordHash: 'y'.repeat(26), name: 'A', project: 'a', runtime: 'python', select: 'newest', platforms: ['windows'], root: 'user', rootName: 'ti' };
  const shasOf = (plan) => plan.split('\n').filter((l) => l.startsWith('file\t')).map((l) => l.split('\t')[3]);
  const versions = (plan) => plan.split('\n').filter((l) => l.startsWith('runtime\t')).map((l) => l.split('\t')[2]);
  const plain = R.resolve(cat, app);
  expect(shasOf(plain).length > 0, 'the python plan downloads nothing to revoke');
  // A plan can already have targets nothing runs on (Windows on ARM64);
  // only fails this test causes count.
  const failsOf = (plan) => plan.split('\n').filter((l) => l.startsWith('fail\t'));
  const before = new Set(failsOf(plain));
  const newFails = (plan) => failsOf(plan).filter((l) => !before.has(l));

  // One build withdrawn: another is chosen, and nothing new fails.
  const first = shasOf(plain)[0];
  R.setRevoked(cat, [first]);
  const next = R.resolve(cat, app);
  expect(!shasOf(next).includes(first), 'the withdrawn build is still in the plan');
  expect(newFails(next).length === 0, 'one withdrawn build made a target fail:\n  ' + newFails(next).join('\n  '));
  expect(next !== plain, 'the plan did not move to another build');
  expect(versions(next).join(',') !== versions(plain).join(',') || shasOf(next).join(',') !== shasOf(plain).join(','),
    'the plan changed but not the builds it installs');

  // Keep withdrawing everything the plan downloads: it steps down until
  // there is nothing left, and then says so.
  const all = new Set([first]);
  let plan = next, rounds = 0;
  while (newFails(plan).length === 0 && rounds < 40) {
    for (const h of shasOf(plan)) all.add(h);
    R.setRevoked(cat, all);
    plan = R.resolve(cat, app);
    rounds++;
  }
  const fails = newFails(plan);
  expect(fails.length > 0, `nothing failed after ${rounds} rounds and ${all.size} withdrawn builds`);
  for (const l of fails) {
    expect(l.includes('has been withdrawn'), 'the message does not say why: ' + l);
    expect(/file\t?[0-9a-f]{64}|file [0-9a-f]{64}/.test(l), 'the message names no file: ' + l);
    expect(/The Python [^ ]+ [0-9][^ ]* build for /.test(l), 'the message names no version: ' + l);
  }

  // And nothing sticks: with the list cleared, the bytes are the ones
  // from before, memo keys and all.
  R.setRevoked(cat, []);
  expect(R.resolve(cat, app) === plain, 'clearing the list did not give the original plan back');
  // An entry that is not a SHA-256 is not a revocation.
  R.setRevoked(cat, ['', 'nonsense', first.toUpperCase()]);
  expect(!shasOf(R.resolve(cat, app)).includes(first), 'an upper-case hash was not matched');
  R.setRevoked(cat, ['nonsense']);
  expect(R.resolve(cat, app) === plain, 'junk in the list changed the plan');
  R.setRevoked(cat, []);
  failures += bad;
  console.log(`revoked builds: ${bad} mismatches`);
}

// `signed` and `maxage` (design.md 7.1, format.md section 3). The saved
// cases pass no moment and so have neither line, which is the point: a
// plan resolved without one is the plan it always was. Here is what the
// two lines are when a caller does pass one.
function freshness() {
  let bad = 0;
  const expect = (cond, what) => { if (!cond) { bad++; console.log('MISMATCH freshness: ' + what); } };
  const app = { recordHash: 'x'.repeat(26), name: 'A', project: 'a', runtime: 'python', select: 'newest', platforms: ['linux'], root: 'user', rootName: 'ti' };
  const plain = R.resolve(cat, app);
  expect(!/^(signed|maxage)\t/m.test(plain), 'a plan resolved with no moment has signed/maxage');
  const at = new Date(Date.UTC(2026, 8, 20, 11, 2, 7));
  const two = 'signed\t2026-09-20T11:02:07Z\nmaxage\t7776000\n';
  // A Date, the same moment in milliseconds and the same text all give
  // the same bytes: the page and the server agree whichever they pass.
  for (const [what, v] of [['a Date', at], ['milliseconds', at.getTime()], ['the text', '2026-09-20T11:02:07Z']]) {
    const got = R.resolve(cat, Object.assign({}, app, { signedAt: v }));
    expect(got === plain.replace('rootname\tti\n', 'rootname\tti\n' + two), 'signedAt as ' + what + ' gives other bytes');
  }
  // Nothing else is a moment, and the lines come as a pair.
  for (const v of ['', 'yesterday', 0 / 0, {}, '2026-09-20 11:02:07']) {
    expect(R.resolve(cat, Object.assign({}, app, { signedAt: v })) === plain, 'signedAt ' + JSON.stringify(String(v)) + ' wrote a time');
  }
  // maxage: the default, and never past the hard limit of 365 days.
  const age = (v) => (/^maxage\t(\S+)$/m.exec(R.resolve(cat, Object.assign({}, app, { signedAt: at, maxage: v }))) || [])[1];
  expect(age(undefined) === String(R.PLAN_MAXAGE), 'the default maxage is ' + age(undefined));
  expect(age(3600) === '3600', 'maxage 3600 came out ' + age(3600));
  expect(age(99 * 365 * 86400) === String(R.PLAN_MAXAGE_LIMIT), 'maxage past the limit came out ' + age(99 * 365 * 86400));
  expect(age(-5) === '1' && age(0) === '1', 'a maxage of nothing came out ' + age(0));
  failures += bad;
  console.log(`signed/maxage: ${bad} mismatches`);
}
if (!process.argv.includes('--no-roundtrip')) {
  // writeSnapshot, read back: the same answers.
  await run('snapshot written back by writeSnapshot', await R.loadSnapshot(await R.writeSnapshot(cat)), data);
}
if (!process.argv.includes('--no-lazy')) await lazyRuns();

// The split snapshot and the lazy catalogue over it.
async function lazyRuns() {
  t0 = performance.now();
  const { index, chunks } = await R.splitSnapshot(bytes);
  const chunkOf = new Map(chunks.map((c) => [c.folder, c.bytes]));
  const packed = chunks.reduce((n, c) => n + c.bytes.length, 0);
  console.log(`split snapshot: index ${(JSON.stringify(index).length / 1024).toFixed(0)} KB, ${chunks.length} folder chunks ${(packed / 1024).toFixed(0)} KB (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  let bad = 0;
  const expect = (cond, what) => { if (!cond) { bad++; console.log('MISMATCH lazy: ' + what); } };
  // The same split from the loaded catalogue as from the snapshot's bytes.
  const again = await R.splitSnapshot(cat);
  expect(same(again.index, index), 'splitSnapshot(catalogue) and splitSnapshot(bytes) give different indexes');
  for (const c of again.chunks) {
    expect(same(await R.readChunk(c.bytes, c.folder), await R.readChunk(chunkOf.get(c.folder), c.folder)), 'chunk ' + c.folder + ' differs between the two splits');
  }
  // Every folder of the policy has a chunk; every chunk is a folder.
  const folders = R.runtimeFolders(cat, R.catalogRuntimeIDs(cat));
  expect(same(folders, [...chunkOf.keys()].sort()), 'folders ' + folders.join(',') + ' vs chunks ' + [...chunkOf.keys()].join(','));
  const loads = new Map();
  const open = () => R.openSplitSnapshot(index, (f) => { loads.set(f, (loads.get(f) || 0) + 1); return chunkOf.get(f); });

  // Nothing is unpacked until asked for, and asking for a runtime that isn't
  // loaded is an error, not an unknown runtime.
  const lazy = open();
  expect(loads.size === 0 && lazy.runtimes.size === 0, 'opening the catalogue unpacked something');
  let err = '';
  try { R.resolve(lazy, { recordHash: 'x', runtime: 'python' }); } catch (e) { err = e.notLoaded ? 'notLoaded' : e.message; }
  expect(err === 'notLoaded', 'resolving an unloaded runtime: ' + err);
  try { R.runtimesSummary(lazy); err = ''; } catch (e) { err = e.notLoaded ? 'notLoaded' : e.message; }
  expect(err === 'notLoaded', 'the summary of an unloaded catalogue: ' + err);
  // What a runtime brings with it.
  expect(same(R.runtimeNeeds(cat, ['cc']), ['cc', 'zig']), 'cc needs ' + R.runtimeNeeds(cat, ['cc']));
  expect(same(R.runtimeNeeds(cat, ['nim']), ['cc', 'nim', 'zig']), 'nim needs ' + R.runtimeNeeds(cat, ['nim']));
  expect(same(R.runtimeFolders(cat, ['python2']), ['python']), 'python2 is in ' + R.runtimeFolders(cat, ['python2']));
  await R.loadRuntimes(lazy, ['python2']);
  expect(same([...loads.keys()], ['python']) && lazy.runtimes.has('python') && lazy.runtimes.has('python2'), 'python2 loads the python folder (python and python2): ' + [...loads.keys()]);
  failures += bad;

  // One catalogue, loaded as the cases go.
  const shared = open();
  loads.clear();
  const needs = async (c) => { if (c.kind === 'resolve') await R.loadRuntimes(shared, [String(c.app.runtime || '')]); return shared; };
  await run('lazy catalogue, loaded as needed', shared, data, {
    catFor: needs, summary: async () => R.runtimesSummary(await R.loadAllRuntimes(shared)),
  });
  const once = [...loads.values()].every((n) => n === 1);
  if (!once) { failures++; console.log('MISMATCH lazy: a folder was unpacked twice ' + JSON.stringify([...loads])); }

  // A fresh catalogue for every case, loaded with only what that case's
  // runtime needs. The chunks are read once here (readChunk) and handed
  // out parsed, so only the loading order is fresh.
  const parsed = new Map();
  for (const [f, b] of chunkOf) parsed.set(f, await R.readChunk(b, f));
  const fresh = () => R.openCatalog(index.files, (f) => parsed.get(f));
  await run('fresh lazy catalogue per case', null, data, {
    catFor: async (c) => {
      const f = fresh();
      if (c.kind === 'resolve') await R.loadRuntimes(f, [String(c.app.runtime || '')]);
      return f;
    },
    summary: async () => {
      const out = [];
      for (const id of R.catalogRuntimeIDs(cat)) out.push(...(R.runtimesSummary(await R.loadRuntimes(fresh(), [id]), [id]).runtimes || []));
      return { runtimes: out.length ? out : null };
    },
  });
}
console.log(failures ? `FAIL: ${failures} mismatches` : 'PASS');
process.exit(failures ? 1 : 0);
