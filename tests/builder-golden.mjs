// Regression test for js/builder.js against saved ("golden") answers: for
// each runtime's hello world (tests/matrix/projects.json), the record and
// plan a build server made for the same POST /api/jobs body (mode C, every
// platform), compared with what runJob makes in the page. Two differences
// are expected and masked: `created` (a timestamp), and the inline source's
// archive (the server stores it and names it in the plan; the page packs it
// into the installer).
//
//   node tests/builder-golden.mjs [--runtimes a,b]
//   node tests/builder-golden.mjs --record URL [--runtimes a,b]
//
// tests/golden/builder.json.br was recorded on 2026-09-19 from the Go
// server (server/cmd/ibserver, deleted after commit d67744a) while it was the
// oracle, with -public http://10.0.1.76:8080 and the catalogue folder that
// tests/golden/catalog.gz was made from, the snapshot the test loads here.
// --record URL records the goldens again from a running build server; use
// it only for an intended change, with a snapshot of the catalogue that
// server loads in tests/golden/catalog.gz (tools/snapshot.mjs), and read
// the diff.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { loadSnapshot, resolve } from '../js/resolve.js';
import { runJob } from '../js/builder.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const RECORD = arg('--record');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const GOLDEN_FILE = path.join(HERE, 'golden', 'builder.json.br');
const CAT_FILE = path.join(HERE, 'golden', 'catalog.gz');
const projects = JSON.parse(fs.readFileSync(path.join(HERE, 'matrix', 'projects.json'))).projects;
const only = arg('--runtimes') ? arg('--runtimes').split(',') : Object.keys(projects);
const catBytes = fs.readFileSync(CAT_FILE);
const catSha = crypto.createHash('sha256').update(catBytes).digest('hex');
const BASES = { windows: 'bases/windows/out/base.exe', linux: 'bases/unix/out/ib-base.run', macos: 'bases/unix/out/ib-base-macos.zip' };
const base = (plat) => new Uint8Array(fs.readFileSync(path.join(HERE, '..', BASES[plat])));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '\n' + extra : '')); }
}

function bodyFor(rt) {
  const p = projects[rt];
  const body = {
    name: 'Hello ' + rt, project: p.project, source: { kind: 'inline' }, files: p.files, runtime: rt, mode: 'C',
    platforms: ['windows', 'linux', 'macos'], launch: p.launch, console: true, menu: true,
  };
  if (p.install) body.install = p.install;
  return body;
}

// Mask what may differ (see the header).
function maskRecord(t) {
  return t.replace(/^created\t.*\n/m, '').replace(/^(source\tinline\t)[0-9a-f]{64}$/m, '$1<src>');
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
    if (x[i] !== y[i]) return `line ${i + 1}:\n  golden: ${JSON.stringify(x[i])}\n  js:     ${JSON.stringify(y[i])}`;
  }
  return '';
}

/* ---------- --record: the goldens from a running build server ---------- */

async function api(p, body) {
  let r;
  for (;;) {
    r = await fetch(RECORD + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 5000));   // the server's rate limit
  }
  if (!r.ok) throw new Error(p + ': ' + r.status + ' ' + await r.text());
  return p.startsWith('/api/records/') || p.startsWith('/api/plan/') ? r.text() : r.json();
}

async function serverJob(body) {
  let j = await api('/api/jobs', body);
  while (j.status !== 'done' && j.status !== 'failed') {
    await new Promise((r) => setTimeout(r, 500));
    j = await api('/api/jobs/' + j.id);
  }
  if (j.status === 'failed') throw new Error('job failed: ' + j.error);
  return j.result;
}

if (RECORD) {
  const golden = { made: new Date().toISOString().slice(0, 10), server: RECORD, catalogSha256: catSha, backend: null, runtimes: {} };
  for (const rt of only) {
    const res = await serverJob(bodyFor(rt));
    const rec = await api('/api/records/' + res.record);
    const plan = await api('/api/plan/' + res.record);
    golden.backend = /^backend\t(.*)$/m.exec(rec)[1];
    golden.runtimes[rt] = { record: maskRecord(rec), plan: maskPlan(plan) };
    console.log('recorded ' + rt);
  }
  fs.writeFileSync(GOLDEN_FILE, zlib.brotliCompressSync(Buffer.from(JSON.stringify(golden, null, 1))));
  console.log(`wrote ${GOLDEN_FILE}; review it before committing`);
  process.exit(0);
}

/* ---------- the check ---------- */

const golden = JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(GOLDEN_FILE)));
ok(golden.catalogSha256 === catSha, 'tests/golden/catalog.gz is the snapshot the goldens were made with', `golden ${golden.catalogSha256}, file ${catSha}`);
const cat = await loadSnapshot(new Uint8Array(catBytes));
for (const rt of only) {
  const g = golden.runtimes[rt];
  if (!g) { ok(false, rt + ': no golden for this runtime'); continue; }
  const body = bodyFor(rt);
  try {
    const out = await runJob(JSON.parse(JSON.stringify(body)), { catalog: cat, backend: golden.backend, base, modes: ['B', 'C'] });
    const b = maskRecord(out.record);
    ok(g.record === b, rt + ': record', firstDiff(g.record, b));
    // The server's plan names its copy of the source; the page's app packs it.
    const app = Object.assign({}, out.app, { platforms: ['windows', 'linux', 'macos'] });
    const pb = maskPlan(await resolve(cat, app));
    ok(g.plan === pb, rt + ': plan', firstDiff(g.plan, pb));
  } catch (e) {
    ok(false, rt, e.stack || e);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
