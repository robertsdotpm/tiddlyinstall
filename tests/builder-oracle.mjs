// Checks js/builder.js against the Go build server while both exist: the
// same POST /api/jobs body goes to a running ibserver and to runJob, and
// the records and plans must match. Two differences are expected and
// masked: `created` (a timestamp), and the inline source's archive (Go and
// JS gzip differently, so its SHA-256 and size differ; the plan's source
// URL is the server's, and the JS plan has none because it packs the
// source).
//
//   node tests/builder-oracle.mjs --server http://127.0.0.1:8080 --catalog DIR/catalog.gz [--runtimes a,b]
import fs from 'node:fs';
import path from 'node:path';
import { loadSnapshot, resolve } from '../js/resolve.js';
import { runJob } from '../js/builder.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const SERVER = arg('--server');
const CAT = arg('--catalog');
if (!SERVER || !CAT) {
  console.log('usage: node tests/builder-oracle.mjs --server URL --catalog catalog.gz [--runtimes a,b]');
  process.exit(2);
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const projects = JSON.parse(fs.readFileSync(path.join(HERE, 'matrix', 'projects.json'))).projects;
const only = arg('--runtimes') ? arg('--runtimes').split(',') : Object.keys(projects);
const cat = await loadSnapshot(new Uint8Array(fs.readFileSync(CAT)));
const BASES = { windows: 'bases/windows/out/base.exe', linux: 'bases/unix/out/ib-base.run', macos: 'bases/unix/out/ib-base-macos.zip' };
const base = (plat) => new Uint8Array(fs.readFileSync(path.join(HERE, '..', BASES[plat])));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '\n' + extra : '')); }
}

async function api(p, body) {
  let r;
  for (;;) {
    r = await fetch(SERVER + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 5000));   // the server's rate limit
  }
  if (!r.ok) throw new Error(p + ': ' + r.status + ' ' + await r.text());
  return p.startsWith('/api/records/') || p.startsWith('/api/plan/') ? r.text() : r.json();
}

async function goJob(body) {
  let j = await api('/api/jobs', body);
  while (j.status !== 'done' && j.status !== 'failed') {
    await new Promise((r) => setTimeout(r, 500));
    j = await api('/api/jobs/' + j.id);
  }
  if (j.status === 'failed') throw new Error('Go job failed: ' + j.error);
  return j.result;
}

// Mask what may differ (see the header).
function maskRecord(t, src) {
  let s = t.replace(/^created\t.*\n/m, '');
  if (src) s = s.replace(/^(source\tinline\t)[0-9a-f]{64}$/m, '$1<src>');
  return s;
}
function maskPlan(t) {
  return t.replace(/\nsig\ted25519\t\S+\n?$/, '\n')
    .replace(/^(source\t)[0-9a-f]{64}\.tar\.gz\t[0-9a-f]{64}\t\d+/m, '$1<src>')
    .replace(/^url\t\S+\/src\/[0-9a-f]{64}\.tar\.gz\n/m, '')
    .replace(/^record\t\S+$/m, 'record\t<hash>')
    .replace(/^appid\t\S+$/m, 'appid\t<appid>');
}
function firstDiff(a, b) {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}:\n  go: ${JSON.stringify(x[i])}\n  js: ${JSON.stringify(y[i])}`;
  }
  return '';
}

for (const rt of only) {
  const p = projects[rt];
  const body = {
    name: 'Hello ' + rt, project: p.project, source: { kind: 'inline' }, files: p.files, runtime: rt, mode: 'C',
    platforms: ['windows', 'linux', 'macos'], launch: p.launch, console: true, menu: true,
  };
  if (p.install) body.install = p.install;
  try {
    const res = await goJob(JSON.parse(JSON.stringify(body)));
    const goRec = await api('/api/records/' + res.record);
    const goPlan = await api('/api/plan/' + res.record);
    const backend = /^backend\t(.*)$/m.exec(goRec)[1];
    const out = await runJob(JSON.parse(JSON.stringify(body)), { catalog: cat, backend, base, modes: ['B', 'C'] });
    const a = maskRecord(goRec, true), b = maskRecord(out.record, true);
    ok(a === b, rt + ': record', firstDiff(a, b));
    // The Go plan names the server's copy of the source; the JS app packs it.
    const app = Object.assign({}, out.app, { platforms: ['windows', 'linux', 'macos'] });
    const jsPlan = await resolve(cat, app);
    const pa = maskPlan(goPlan), pb = maskPlan(jsPlan);
    ok(pa === pb, rt + ': plan', firstDiff(pa, pb));
  } catch (e) {
    ok(false, rt, e.stack || e);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
