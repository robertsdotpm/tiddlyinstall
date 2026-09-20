// Regression test for the build server (server/) against saved ("golden")
// answers.
//
//   node tests/backend-golden.mjs [--server http://127.0.0.1:8080] [--data server/data]
//        [--runtimes a,b] [--quick] [--rate-limits]
//   node tests/backend-golden.mjs --record URL --data DIR [--rate-limits]
//
// tests/golden/backend.json.br was recorded on 2026-09-19 from the Go server
// (server/cmd/ibserver, deleted after commit d67744a) while it was the oracle
// the Node server was checked against (1,784 checks, two live servers).
// What was meaningful with one server is kept:
//
//   - fixed answers: /api/pubkey, /api/catalog/runtimes, the headers of the
//     bases and the site, /api/health's fields, CORS, and the status, body,
//     type and Location of paths that must not be served, redirect, or 405
//   - bad requests: status and message (or, for checks made in the job, how
//     the job ends), SSRF targets for sources and the relay, the timestamp
//     relay's refusals, plans by name that are refused
//   - jobs (every runtime in modes A, B and C, icons, versions, settings,
//     packages, GitHub and URL sources, offline packs): status, error, class
//     and fields; the record (`created` masked); the inline source's tar;
//     each file's name, flags, and what is inside (the record, the signed
//     plan with record, appid, source and `signed` masked, the packed
//     files, a macOS .app's entry names, Info.plist and icon types)
//   - plans for fixed record bytes: the golden server's records (and their
//     sources and icons) are put in this server's data folder (--data) and
//     their plans asked for, which must be the same bytes but `signed`
//     (the moment the plan was made), with the signature checked against
//     this server's key; and the `?nonce=` echo (design.md 7.1)
//   - takedown by source, package, record and sha, with a few made-up
//     entries added to --data's takedown.txt and removed afterwards
//   - with --rate-limits (it uses up this address's minute first): which
//     call each limit refuses, and the 429 answer
//
// Dropped, because they only made sense with two servers: byte comparisons
// of whole installers, bases and the site; plans by name that succeed (the
// registries' newest versions move); records of packages at their newest
// version. The checks made against the live catalogue (runtimes summary,
// plans) need the server to load the catalogue tests/golden/catalog.gz was
// made from; if /api/catalog/runtimes differs, that is said first.
//
// Records, sources and icons this test adds to --data are removed at the
// end unless they were there before. The jobs it runs stay, like any
// other build.
//
// --record URL records the goldens again from a running server (use it
// only for an intended change, and read the diff); --data is that
// server's data folder.
//
// Re-recorded 2026-09-19 from the Node server on :8080 for Windows Python's
// msi-layout plans (the full python.org build); only Python's Windows plans
// changed (and the runtimes summary). The jobs rate-limit answer was kept
// from the earlier recording: recording itself had used up the minute.
//
// Re-recorded 2026-09-19 from the Node server on :8080 for the runtime
// fidelity data (tests/fidelity): the runtimes summary (Ruby's macOS
// releases) and the PHP job with a composer.json, which now builds (renamed
// from "... unsupported" to "... Composer"; it was refused). The fixed
// records' plans were recorded again with the new catalogue. The four
// rate-limit answers were carried over from the previous recording
// (recorded without --rate-limits: the recording's own jobs use the minute).
//
// Re-recorded 2026-09-20 for stale plans (design.md 7.1): every plan has
// `signed` and `maxage`, /api/revocations is new, and the inline source's
// hash in a record is no longer masked (it is deterministic now, and
// hiding it is what let an earlier bug through). The four rate-limit
// answers were carried over again.
//
// One run at a time: the lock below refuses a second run against the same
// server and data folder, which used to interleave silently.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readInstaller, zipEntryData, peInfo, peChecksum } from '../shared/tifile.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(HERE, '..');
const RECORD = arg('--record');
const SERVER = RECORD || arg('--server') || 'http://127.0.0.1:8080';
const DATA = path.resolve(arg('--data') || path.join(REPO, 'server/data'));
const QUICK = process.argv.includes('--quick');
const RATE = process.argv.includes('--rate-limits');
const GOLDEN_FILE = path.join(HERE, 'golden', 'backend.json.br');
const projects = JSON.parse(fs.readFileSync(path.join(HERE, 'matrix', 'projects.json'))).projects;
const RUNTIMES = arg('--runtimes') ? arg('--runtimes').split(',') : Object.keys(projects);

const golden = RECORD ? { made: new Date().toISOString().slice(0, 10), server: SERVER, public: null, pubkey: null, obs: {}, fixed: {} }
  : JSON.parse(zlib.brotliDecompressSync(fs.readFileSync(GOLDEN_FILE)));

/* ---------- one run at a time, and no wait without an end ---------- */

// Two runs against one server and one data folder get in each other's way:
// they build the same records, add and remove each other's files, and
// write and restore each other's takedown.txt. It used to show as a run
// that simply stopped, so the second one refuses instead. --force takes a
// lock whose process is gone.
const LOCK = path.join(DATA, '.backend-golden.lock');
let holdingLock = false;
function takeLock() {
  const mine = JSON.stringify({ pid: process.pid, host: os.hostname(), started: new Date().toISOString(), mode: RECORD ? 'record' : 'check' });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK, mine + '\n', { flag: 'wx' });
      holdingLock = true;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let held = {};
    try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch (e) { /* unreadable: treat as stale */ }
    const alive = held.pid && held.host === os.hostname() && (() => { try { process.kill(held.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } })();
    if (alive && !process.argv.includes('--force')) {
      console.log(`Another backend-golden run (${held.mode || '?'}, pid ${held.pid} on ${held.host}, started ${held.started}) holds ${LOCK}.`);
      console.log('Two runs against one server and one data folder interfere: wait for it, or pass --force if it is really gone.');
      process.exit(2);
    }
    console.log(`Taking over a stale lock from pid ${held.pid || '?'} (${LOCK}).`);
    fs.rmSync(LOCK, { force: true });
  }
  throw new Error('could not take ' + LOCK);
}
function dropLock() {
  if (!holdingLock) return;
  holdingLock = false;
  try {
    if (JSON.parse(fs.readFileSync(LOCK, 'utf8')).pid === process.pid) fs.rmSync(LOCK, { force: true });
  } catch (e) { /* someone else's or already gone */ }
}
process.on('exit', dropLock);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { dropLock(); process.exit(130); });

// Nothing here waits for ever. A wait that ends says what it was waiting
// for, which is the whole point: a tool run this rarely must never just
// stop with no output.
const REQ_TIMEOUT = Number(arg('--request-timeout') || 180) * 1000;   // no bytes for this long
const RETRY_LIMIT = Number(arg('--retry-limit') || 600) * 1000;       // rate-limited for this long
const JOB_LIMIT = Number(arg('--job-limit') || 1800) * 1000;          // one job, queue included
class Stuck extends Error {}

let passed = 0, failed = 0, skipped = 0;
const failures = [];
const notes = [];
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); return true; }
  failed++;
  failures.push(name);
  console.log('FAIL ' + name + (extra !== undefined && extra !== '' ? '\n  ' + String(extra).split('\n').join('\n  ') : ''));
  return false;
}
function note(s) { if (!notes.includes(s)) notes.push(s); }

const canon = (x) => JSON.stringify(x, (k, y) => (y && typeof y === 'object' && !Array.isArray(y) ? Object.fromEntries(Object.entries(y).sort()) : y));
function firstDiff(a, b) {
  const x = String(a).split('\n'), y = String(b).split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}:\n  golden: ${JSON.stringify(x[i])}\n  server: ${JSON.stringify(y[i])}`;
  }
  return '';
}

// One observation: recorded, or compared with the golden one.
function obs(name, value) {
  if (RECORD) {
    if (Object.hasOwn(golden.obs, name)) throw new Error('duplicate observation ' + name);
    golden.obs[name] = value;
    console.log('REC  ' + name);
    return;
  }
  if (!Object.hasOwn(golden.obs, name)) { skipped++; console.log('SKIP ' + name + ' (no golden)'); return; }
  const want = golden.obs[name];
  const a = canon(want), b = canon(value);
  let extra = '';
  if (a !== b) extra = typeof want === 'string' && typeof value === 'string' && want.includes('\n') ? firstDiff(want, value) : `golden ${a.slice(0, 600)}\nserver ${b.slice(0, 600)}`;
  ok(a === b, name, extra);
}

/* ---------- HTTP, raw (no URL normalising, no redirects followed) ---------- */

function raw(p, { method = 'GET', body = null, headers = {} } = {}) {
  const u = new URL(SERVER);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers: Object.assign({}, headers, body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: b, text: b.toString('utf8') });
      });
    });
    // An idle socket: the server took the connection and then said nothing.
    req.setTimeout(REQ_TIMEOUT, () => {
      req.destroy(new Stuck(`${method} ${p}: nothing from ${SERVER} for ${REQ_TIMEOUT / 1000} s`));
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST and GET with the server's rate limits waited out.
async function unRateLimited(what, fn) {
  const until = Date.now() + RETRY_LIMIT;
  let said = false;
  for (;;) {
    const r = await fn();
    if (r.status !== 429) return r;
    if (Date.now() > until) throw new Stuck(`${what}: rate-limited by ${SERVER} for ${RETRY_LIMIT / 1000} s. Another run against this server?`);
    if (!said) { console.log(`  (rate-limited on ${what}; waiting)`); said = true; }
    await sleep(5000);
  }
}
const post = (p, body, headers = { 'Content-Type': 'application/json' }) =>
  unRateLimited('POST ' + p, () => raw(p, { method: 'POST', body, headers }));
const get = (p) => unRateLimited('GET ' + p, () => raw(p));

// A job to its end. An answer that is not a job (the server forgot it, or
// Redis lost it) is an error, not something to poll for ever, and a job
// that never runs -- another run's pack ahead of it on the one pack
// worker, say -- gives up with what it was waiting for.
async function waitJob(id) {
  const until = Date.now() + JOB_LIMIT;
  let said = 0;
  for (;;) {
    const r = await get('/api/jobs/' + id);
    let j;
    try { j = JSON.parse(r.text); } catch (e) { throw new Stuck(`job ${id}: ${r.status} ${r.text.slice(0, 200)}`); }
    if (j.status === 'done' || j.status === 'failed') return j;
    if (!j.status) throw new Stuck(`job ${id}: the server doesn't know it any more (${r.status} ${r.text.slice(0, 200)})`);
    if (Date.now() > until) throw new Stuck(`job ${id}: still "${j.status}" (position ${j.position}) after ${JOB_LIMIT / 1000} s`);
    const waited = Math.floor((Date.now() - (until - JOB_LIMIT)) / 30000);
    if (waited > said) { said = waited; console.log(`  (job ${id}: ${j.status}, position ${j.position}, ${waited * 30} s)`); }
    await sleep(400);
  }
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- this server's public URL and key against the golden ones ---------- */

let pub = null, pubRaw = null;
// Texts with this server's public URL written as the golden server's.
const norm = (s) => (RECORD || !pub || pub === golden.public ? String(s) : String(s).split(pub).join(golden.public));
const sameSigner = () => RECORD || (pub === golden.public && pubRaw && pubRaw.toString('base64') === golden.pubkey);

// `created` is a timestamp and is the only thing masked in a record.
//
// The inline source's hash used to be masked too, because it moved with
// whichever deflate made the gzip. That is exactly the bug design.md 11.2
// records -- one form giving two record hashes and two install folders
// depending on where it was built -- and this suite could not see it,
// because it hid it. The record now names the uncompressed tar, so the
// line is deterministic and is compared (2026-09-20, as builder-golden
// already did).
function maskRecord(t) {
  return norm(t).replace(/^created\t.*\n/m, 'created\t<time>\n');
}

function verifyPlan(plan) {
  const m = /\nsig\ted25519\t(\S+)\n$/.exec(plan);
  if (!m || !pubRaw) return false;
  const msg = Buffer.from(plan.slice(0, m.index + 1));
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw.toString('base64url') }, format: 'jwk' });
  return crypto.verify(null, msg, key, Buffer.from(m[1], 'base64'));
}
const stripSig = (p) => p.replace(/sig\ted25519\t\S+\n$/, '');
// `signed` is the moment the plan was made (design.md 7.1), so it differs
// between the recording and every later run, exactly as a record's
// `created` does. It is the only line masked in a plan for that reason,
// and its shape is checked where it is masked.
const maskSigned = (p) => p.replace(/^signed\t.*$/m, 'signed\t<time>');

// The same for another document signed with the plan key: the signature
// covers the bytes before the `sig` line, and those bytes must start with
// the document's own header (docs/format.md section 7), which is what
// keeps a plan's signature from being read as a revocation list.
function verifyDoc(doc, kind) {
  return doc.startsWith(kind + '\t') && verifyPlan(doc);
}

// A plan against a golden one: every byte but the `signed` line and the
// signature, which cannot be the recording's (the plan is made when it is
// asked for). The signature is checked against this server's own key
// instead, over the bytes it actually served.
function samePlan(name, want, got) {
  const shape = /^signed\t\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m.test(got);
  if (!sameSigner()) note('This server\'s public URL or plan key is not the golden one, so plans are compared with its URL written as the golden one, and its signatures checked with its own key.');
  const a = maskSigned(stripSig(want)), b = maskSigned(stripSig(norm(got)));
  return ok(verifyPlan(got) && shape && a === b, name + ' (every byte but `signed`; its signature checked)',
    a === b ? (shape ? 'the signature does not verify' : 'no `signed` line') : firstDiff(a, b));
}

/* ---------- 1. fixed answers ---------- */

async function fixed() {
  console.log('\n# Fixed answers');
  const pk = await get('/api/pubkey');
  pubRaw = Buffer.from(JSON.parse(pk.text).key, 'base64');
  if (RECORD) golden.pubkey = pubRaw.toString('base64');
  if (sameSigner()) obs('/api/pubkey', { status: pk.status, body: pk.text });
  else note('/api/pubkey: this server\'s key is not the golden one; its answer is not compared.');
  const rt = await get('/api/catalog/runtimes');
  obs('/api/catalog/runtimes', { status: rt.status, body: rt.text });
  for (const p of ['/api/pubkey', '/api/catalog/runtimes', '/api/takedown', '/api/revocations', '/bases/windows', '/bases/linux', '/bases/macos', '/']) {
    const r = await get(p);
    obs(`${p}: status and headers`, { status: r.status, type: r.headers['content-type'], cache: r.headers['cache-control'], disposition: r.headers['content-disposition'] });
  }
  const h = JSON.parse((await get('/api/health')).text);
  obs('/api/health: fields and version', { keys: Object.keys(h), queues: Object.keys(h.queues), version: h.version, ok: h.ok, time: /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(h.time) });
  for (const [m, p] of [['OPTIONS', '/api/jobs'], ['OPTIONS', '/anything'], ['GET', '/api/nope'], ['GET', '/api/health']]) {
    const r = await raw(p, { method: m });
    const cors = ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age'].map((x) => r.headers[x]);
    obs(`${m} ${p}: status and CORS headers`, { status: r.status, cors });
  }
  // Paths: no listings, the site only, cleaned paths, 405s, redirects.
  const paths = [
    ['GET', '/index.html'], ['GET', '/css/'], ['GET', '/js/'], ['GET', '/mirror/'], ['GET', '/mirror'], ['GET', '/src/'], ['GET', '/src/nothing.tar.gz'],
    ['GET', '/mirror/python'], ['GET', '/mirror/python/'], ['GET', '/mirror/../server/data/plan-signing-key.pem'],
    ['GET', '/mirror/%2e%2e/server/policy.json'], ['GET', '//api//health'], ['GET', '/server/policy.json'], ['GET', '/.git/config'],
    ['GET', '/README.md'], ['GET', '/api/nope'], ['GET', '/api/jobs'], ['GET', '/api/jobs/'], ['GET', '/api/jobs/j_nope'],
    ['POST', '/api/health'], ['PUT', '/api/jobs'], ['DELETE', '/'], ['GET', '/api/tsa'], ['POST', '/api/relay'],
    ['GET', '/api/records/short'], ['GET', '/api/records/aaaaaaaaaaaaaaaaaaaaaaaaaa'], ['GET', '/api/records/AAAAAAAAAAAAAAAAAAAAAAAAAA'],
    ['GET', '/api/plan/short'], ['GET', '/api/plan/aaaaaaaaaaaaaaaaaaaaaaaaaa'], ['GET', '/api/plan/name'],
    ['GET', '/api/plan/aaaaaaaaaaaaaaaaaaaaaaaaaa?nonce=abc'], ['GET', '/api/plan/aaaaaaaaaaaaaaaaaaaaaaaaaa?nonce=' + 'g'.repeat(32)],
    ['GET', '/api/plan/name/python/requests?nonce=abc'], ['GET', '/api/revocations?nonce=abc'],
    ['GET', '/dl/x/y'], ['GET', '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaa/nothing.exe'], ['GET', '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaa/.hidden'],
    ['GET', '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaa/a%2Fb'], ['GET', '/icons/abc.png'], ['GET', '/icons/' + 'a'.repeat(64) + '.png'],
    ['GET', '/icons/' + 'a'.repeat(64)], ['GET', '/bases/nope'], ['HEAD', '/bases/linux'], ['HEAD', '/api/pubkey'],
  ];
  for (const [m, p] of paths) {
    const r = await raw(p, { method: m });
    // A 200's body is the site, a base or health: not fixed.
    obs(`${m} ${p}`, { status: r.status, type: r.headers['content-type'] || '', location: r.headers.location || '', allow: r.headers.allow || '', body: r.status === 200 ? null : r.text });
  }
}

/* ---------- 2. bad requests ---------- */

async function badRequests() {
  console.log('\n# Bad requests');
  const p = projects.python;
  const good = { name: 'Hello python', project: p.project, source: { kind: 'inline' }, files: p.files, runtime: 'python', mode: 'C', launch: p.launch };
  const tiny = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='; // 1x1
  const w = (o) => JSON.stringify(Object.assign({}, good, o));
  const cases = [
    ['bad mode', w({ mode: 'D' })],
    ['no mode', w({ mode: '' })],
    ['unknown runtime', w({ runtime: 'cobol' })],
    ['runtime "constructor"', w({ runtime: 'constructor' })],
    ['runtime with a quote', w({ runtime: 'py"thon\u0007' })],
    ['offline mode A', w({ mode: 'A', offline: true })],
    ['unknown platform', w({ platforms: ['windows', 'beos'] })],
    ['unknown select', w({ select: 'oldest' })],
    ['range without a range', w({ select: 'range', range: '  ' })],
    ['name too long', w({ name: 'x'.repeat(81) })],
    ['name 80 bytes of UTF-8 over', w({ name: 'é'.repeat(41) })],
    ['launch too long', w({ launch: 'x'.repeat(401) })],
    ['ESC in the name', w({ name: 'Hello \u001b[8m hidden' })],
    ['RLO in the name', w({ name: 'Hello \u202e txt.exe' })],
    ['C1 in the launch', w({ launch: 'run \u0085' })],
    ['LRI in the source ref', w({ source: { kind: 'github', value: 'a/b', ref: 'main\u2066' } })],
    ['bidi in rootname', w({ rootname: 'ti\u200f' })],
    ['bad rootname', w({ rootname: 'a b' })],
    ['bad package version', w({ source: { kind: 'package', value: 'requests', version: '1 0' } })],
    ['package name refused', w({ source: { kind: 'package', value: 'requests; rm -rf /' } })],
    ['package for a runtime without a registry', w({ runtime: 'zig', source: { kind: 'package', value: 'foo' } })],
    ['no source kind', w({ source: {} })],
    ['unknown source kind', w({ source: { kind: 'ftp', value: 'x' } })],
    ['github not owner/repo', w({ source: { kind: 'github', value: 'https://gitlab.com/a/b' } })],
    ['url not http', w({ source: { kind: 'url', value: 'file:///etc/passwd' } })],
    ['inline with no files', w({ files: {} })],
    ['inline file name ..', w({ files: { '../x.py': 'print(1)' } })],
    ['inline absolute file name', w({ files: { '/etc/x': 'x' } })],
    ['inline file name with a colon', w({ files: { 'c:x': 'x' } })],
    ['inline file name with a backslash', w({ files: { 'a\\b': 'x' } })],
    ['inline file name with a control character', w({ files: { 'a\u0001b': 'x' } })],
    ['inline over 1 MB', w({ files: { 'a.py': 'x'.repeat((1 << 20) + 1) } })],
    ['201 files', w({ files: Object.fromEntries(Array.from({ length: 201 }, (_, i) => ['f' + i, 'x'])) })],
    ['icon choice too long', w({ icon: { choice: 'x'.repeat(65) } })],
    ['icon bad sha256', w({ icon: { sha256: 'abc' } })],
    ['icon not base64', w({ icon: { data: '!!!!' } })],
    ['icon base64 without padding', w({ icon: { data: tiny.replace(/=+$/, '') } })],
    ['icon not a PNG', w({ icon: { data: Buffer.from('GIF89a' + 'x'.repeat(40)).toString('base64') } })],
    ['icon too small', w({ icon: { data: tiny } })],
    ['icon over 1 MB of base64', w({ icon: { data: 'A'.repeat(1398109) } })],
    ['icon data: URL, not a PNG', w({ icon: { data: 'data:image/png;base64,' + Buffer.from('hello').toString('base64') } })],
    ['not JSON', '{"name": '],
    ['a JSON array', '[1, 2]'],
    ['a JSON string', '"hello"'],
    ['null', 'null'],
    ['a number for the name', w({ name: 5 })],
    ['a string for console', w({ console: 'yes' })],
    ['a number in platforms', w({ platforms: ['windows', 3] })],
    ['a number in files', w({ files: { 'a.py': 1 } })],
    ['keys in another case', JSON.stringify({ NAME: 'Hello', Runtime: 'python', MODE: 'Q' })],
    ['over 4 MB of body', JSON.stringify(Object.assign({}, good, { files: { 'a.py': 'x'.repeat(5 << 20) } }))],
    ['trailing garbage', w({}) + 'x'],
  ];
  for (const [name, body] of cases) {
    const r = await post('/api/jobs', body);
    if (r.status === 202) {
      // Accepted (a check that happens in the job): how the job ends.
      const j = await waitJob(JSON.parse(r.text).id);
      obs('bad request: ' + name, { status: r.status, job: j.status, error: j.error || '', class: j.class });
    } else {
      obs('bad request: ' + name, { status: r.status, body: r.text });
    }
  }
  // The server fetches nothing but public addresses: sources, and every
  // redirect from one.
  console.log('\n# SSRF');
  for (const u of ['http://127.0.0.1/x.tar.gz', 'http://10.0.0.1/x.tar.gz', 'http://localhost:8080/api/health', 'http://[::1]/x.tar.gz',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/x.tar.gz', 'http://2130706433/x.tar.gz',
    'http://10.0.1.76:8080/src/x.tar.gz', 'https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8080%2Fapi%2Fhealth']) {
    const r = await post('/api/jobs', JSON.stringify(Object.assign({}, good, { name: 'ssrf', source: { kind: 'url', value: u }, platforms: ['linux'] })));
    const j = r.status === 202 ? await waitJob(JSON.parse(r.text).id) : null;
    obs('url source ' + u, { status: r.status, job: j && j.status, error: j && j.error });
  }
  // (http://0.0.0.0:8080/ is left out: Node refuses 0.0.0.0/8 by design and
  // Go did not, so there is no golden answer for it.)
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://localhost:8080/api/pubkey', 'file:///etc/passwd', '']) {
    const r = await get('/api/relay?url=' + encodeURIComponent(u));
    obs('relay ' + JSON.stringify(u), { status: r.status, body: r.text });
  }
  {
    const r = await get('/api/relay?url=' + encodeURIComponent('https://ziglang.org/download/0.1.1/zig-0.1.1.tar.xz'));   // in the catalogue, 1.6 MB
    obs('relay of a catalogue file', { status: r.status, size: r.body.length, sha256: sha(r.body), type: r.headers['content-type'] });
  }
  // The timestamp relay: a fixed list, a DER body of at most 4 KB.
  console.log('\n# Timestamp relay');
  const tsReq = Buffer.from('3039020101303130' + '0d060960864801650304020105000420' + '00'.repeat(32) + '0101ff', 'hex');
  tsReq[1] = tsReq.length - 2;
  const hdr = { 'Content-Type': 'application/timestamp-query' };
  for (const [name, q, body] of [['unknown name', 'nope', tsReq], ['no name', '', tsReq], ['__proto__', '__proto__', tsReq],
    ['not DER', 'digicert', Buffer.from('hello')], ['one byte', 'digicert', Buffer.from([0x30])], ['over 4 KB', 'digicert', Buffer.concat([Buffer.from([0x30]), Buffer.alloc(4096)])]]) {
    const r = await post('/api/tsa?name=' + q, body, hdr);
    obs('tsa ' + name, { status: r.status, body: r.text });
  }
  {
    const r = await post('/api/tsa?name=digicert', tsReq, hdr);
    obs('tsa digicert, a real request (the answer carries its own time)', { status: r.status, type: r.headers['content-type'], der: r.status !== 200 || r.body[0] === 0x30 });
  }
  console.log('\n# Plans by name');
  for (const [rt, name] of [['python', 'requests'], ['python', 'Requests'], ['node', 'cowsay'], ['rust', 'ripgrep'], ['ruby', 'rake'],
    ['go', 'golang.org%2Fx%2Fexample%2Fhello'], ['dotnet', 'dotnet-script'],
    ['zig', 'foo'], ['cobol', 'foo'], ['node', '%40types%2Fnode'], ['node', '@scope'], ['python', 'a%20b'], ['python', 'x'.repeat(101)],
    ['python' + 'x'.repeat(20), 'a'], ['python', 'this-package-does-not-exist-ti-oracle-4711'], ['python', 'requests?os=linux']]) {
    const r = await get(`/api/plan/name/${rt}/${name}`);
    // A plan's versions are the registry's newest: only that it is signed
    // and names a record.
    if (r.status === 200) obs(`plan by name ${rt}/${name}`, { status: 200, signed: verifyPlan(r.text), record: /^[a-z2-7]{26}$/.test(r.headers['x-ti-record'] || '') });
    else obs(`plan by name ${rt}/${name}`, { status: r.status, body: r.text });
  }
}

/* ---------- 3. jobs ---------- */

const dl = async (url) => (await get(url)).body;

async function tarOf(shaHex) {
  const r = await get('/src/' + shaHex + '.tar.gz');
  return r.status === 200 ? zlib.gunzipSync(r.body) : null;
}

// Files added to --data, removed at the end.
const added = [];
function putData(rel, bytes) {
  const f = path.join(DATA, rel);
  if (fs.existsSync(f)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, bytes);
  added.push(f);
}

// The plans for a golden record's bytes: recorded with its source and
// icon, or (checking) put in this server's data folder and asked for.
async function fixedRecordPlans(label, hash, rec, oses) {
  if (RECORD) {
    const f = { hash, record: rec, src: null, icon: null, plans: {} };
    const m = /^source\t(?:inline\t([0-9a-f]{64})|github\t\S+\t\S+\t([0-9a-f]{64})|url\t\S+\t([0-9a-f]{64}))$/m.exec(rec);
    const s = m && (m[1] || m[2] || m[3]);
    if (s) f.src = { sha: s, b64: (await dl('/src/' + s + '.tar.gz')).toString('base64') };
    const ic = /^icon\t([0-9a-f]{64})$/m.exec(rec);
    if (ic) f.icon = { sha: ic[1], b64: (await dl('/icons/' + ic[1] + '.png')).toString('base64') };
    for (const os of oses) {
      const r = await get('/api/plan/' + hash + (os ? '?os=' + os : ''));
      f.plans[os] = { status: r.status, text: r.text };
    }
    golden.fixed[label] = f;
    console.log(`REC  ${label}: the plan for the record's bytes (${oses.length})`);
    return;
  }
  const f = golden.fixed[label];
  if (!f) { skipped++; console.log(`SKIP ${label}: the plan for the golden record (no golden)`); return; }
  putData(path.join('records', f.hash + '.txt'), f.record);
  if (f.src) putData(path.join('src', f.src.sha + '.tar.gz'), Buffer.from(f.src.b64, 'base64'));
  if (f.icon) putData(path.join('icons', f.icon.sha + '.png'), Buffer.from(f.icon.b64, 'base64'));
  for (const [os, want] of Object.entries(f.plans)) {
    const r = await get('/api/plan/' + f.hash + (os ? '?os=' + os : ''));
    const name = `${label}: the plan for the golden record${os ? ', ?os=' + os : ''}`;
    if (want.status === 200 && r.status === 200) samePlan(name, want.text, r.text);
    else ok(want.status === r.status && want.text === r.text, `${name}: ${want.status}`, `golden ${want.status} ${want.text}\nserver ${r.status} ${r.text}`);
  }
  // The nonce (design.md 7.1) is the plan with one line more, inside the
  // signature: what the engine sent, echoed. Checked against this run's
  // own plan rather than the golden, since it is this run's nonce.
  const plain = await get('/api/plan/' + f.hash);
  if (plain.status === 200) {
    const n = crypto.randomBytes(16).toString('hex');
    const withNonce = await get('/api/plan/' + f.hash + '?nonce=' + n);
    const line = 'request\tnonce\t' + n + '\n';
    ok(withNonce.status === 200 && withNonce.text.includes(line) && verifyPlan(withNonce.text),
      `${label}: ?nonce= is echoed into the signed plan`, withNonce.text.slice(0, 200));
    const a = maskSigned(stripSig(plain.text)), b = maskSigned(stripSig(withNonce.text)).replace(line, '');
    ok(withNonce.status === 200 && a === b, `${label}: the nonce is the only difference`, firstDiff(a, b));
  }
}

function zipView(info, hash, src) {
  // File entries by name (the record hash in a mode A .app's name masked,
  // and an inline source's archive hash in a pack's), with their Unix
  // modes. Directory entries are left out (Node's zips have them for
  // Contents/Resources/ti/, Go's did not).
  const out = [];
  for (const e of info.entries) {
    let n = e.name.split(hash).join('<hash>');
    if (src) n = n.split(src).join('<src>');
    if (n.endsWith('/')) continue;
    out.push([n, (e.madeBy >>> 8) === 3 ? (e.extAttr >>> 16) : 0]);
  }
  return out.sort();
}

async function fileObs(label, mode, job, rec) {
  const files = job.result.files, h = job.result.record;
  obs(`${label}: platforms`, files.map((f) => f.platform));
  for (const f of files) {
    const plat = f.platform, L = `${label} ${plat}`;
    const d = await dl(f.url);
    obs(`${L}: name, flags`, { name: f.name.split(h).join('<hash>'), url: f.url === '/dl/' + h + '/' + f.name, signed: f.signed, offline: f.offline,
      sizeAndSha: d.length === f.size && sha(d) === f.sha256, hashInName: f.name.includes('_' + h + '.') });
    const info = await readInstaller(new Uint8Array(d), f.name);
    const src = /^source\tinline\t(\S+)/m.exec(rec);
    if (info.kind === 'zip') {
      obs(`${L}: the .app's files`, zipView(info, h, src && src[1]));
      const entry = (suffix) => info.entries.find((x) => x.name.endsWith(suffix));
      const pl = entry('.app/Contents/Info.plist');
      obs(`${L}: Info.plist`, pl ? Buffer.from(await zipEntryData(pl)).toString('utf8').split(h).join('<hash>') : null);
      const ic = entry('.app/Contents/Resources/AppIcon.icns');
      let types = null;
      if (ic) {
        const b = Buffer.from(await zipEntryData(ic));
        types = [];
        for (let o = 8; o + 8 <= b.length; o += b.readUInt32BE(o + 4)) types.push(b.toString('latin1', o, o + 4));
      }
      obs(`${L}: AppIcon.icns types`, types);
    } else if (info.kind === 'exe' && rec.includes('\nicon\t') && mode !== 'A') {
      const u8 = new Uint8Array(d), p = peInfo(u8);
      obs(`${L}: the PE checksum is right (an icon was written)`, !!p && new DataView(u8.buffer, u8.byteOffset).getUint32(p.checksumOff, true) === peChecksum(u8, p.checksumOff));
    }
    if (mode === 'A') {
      obs(`${L}: nothing inside (mode A: the record is only on the server)`, info.record === null && !info.plan && !info.pack.length);
      continue;
    }
    obs(`${L}: the record inside is the server's`, (info.record || '') === rec);
    const plan = info.plan || '';
    const m = maskSigned(norm(plan)).replace(/^record\t\S+$/m, 'record\t<hash>').replace(/^appid\t\S+$/mg, 'appid\t<appid>')
      .replace(/^(source\t)[0-9a-f]{64}(\.tar\.gz\t)[0-9a-f]{64}\t\d+/m, '$1<src>$2<src>').replace(/\/src\/[0-9a-f]{64}\.tar\.gz/g, '/src/<src>.tar.gz');
    obs(`${L}: the embedded plan (record, appid and source masked)`, { signed: plan ? verifyPlan(plan) : null, plan: stripSig(m) });
    obs(`${L}: the packed files, each named by its SHA-256`, info.pack.map((x) => (src ? x.name.split(src[1]).join('<src>') : x.name) + ' ' + (x.name === sha(Buffer.from(x.data)) ? 'ok' : 'BAD')));
  }
}

// A job, observed. opts: planOnly (no files), quickPlans (no ?os= plans),
// volatile (a registry's newest version: only how it ends).
async function job(label, body, opts = {}) {
  const r = await post('/api/jobs', JSON.stringify(body));
  if (r.status !== 202) { obs(`${label}: refused`, { status: r.status, body: r.text }); return null; }
  const a = JSON.parse(r.text);
  obs(`${label}: accepted`, { status: r.status, keys: Object.keys(a).sort(), class: a.class, queued: a.status === 'queued', id: /^j_[0-9a-f]{18}$/.test(a.id), ticket: Number.isInteger(a.ticket) });
  const j = await waitJob(a.id);
  obs(`${label}: ends`, { status: j.status, error: j.error || '', progress: j.progress });
  if (j.status !== 'done' || opts.volatile) return null;
  obs(`${label}: the job's fields`, { job: Object.keys(j).sort(), result: Object.keys(j.result).sort() });
  const rec = (await get('/api/records/' + j.result.record)).text;
  obs(`${label}: the record (created masked)`, maskRecord(rec));
  const s = /^source\tinline\t(\S+)/m.exec(rec);
  if (s) {
    const t = await tarOf(s[1]);
    obs(`${label}: the inline source's tar (the gzip around it may differ)`, t && sha(t));
  }
  const oses = opts.planOnly || opts.quickPlans ? [''] : ['', 'windows', 'linux', 'macos'];
  await fixedRecordPlans(label, j.result.record, rec, oses);
  if (!opts.planOnly) {
    const own = await get('/api/plan/' + j.result.record);
    obs(`${label}: the plan for its own record is signed and names it`, { status: own.status, ok: own.status !== 200 || (verifyPlan(own.text) && own.text.includes('\nrecord\t' + j.result.record + '\n')) });
    await fileObs(label, body.mode, j, rec);
  }
  return { job: j, rec };
}

async function jobs() {
  console.log('\n# Jobs: every runtime, modes A, B and C');
  for (const rt of RUNTIMES) {
    const p = projects[rt];
    for (const mode of QUICK ? ['A', 'C'] : ['A', 'B', 'C']) {
      const body = { name: 'Hello ' + rt, project: p.project, source: { kind: 'inline' }, files: p.files, runtime: rt, mode,
        platforms: ['windows', 'linux', 'macos'], launch: p.launch, console: true, menu: true };
      if (p.install) body.install = p.install;
      await job(`${rt} ${mode}`, body, { quickPlans: mode !== 'C' });
    }
  }
}

function pngOf(size, height = size) {
  // An RGBA PNG with a gradient, made here (no decoder needed).
  const rowLen = size * 4 + 1;
  const rawImg = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    rawImg[y * rowLen] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * rowLen + 1 + x * 4;
      rawImg[o] = (x * 255 / size) | 0; rawImg[o + 1] = (y * 255 / size) | 0; rawImg[o + 2] = 128; rawImg[o + 3] = x < size / 8 ? 0 : 255;
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rawImg)), chunk('IEND', Buffer.alloc(0))]);
}

async function moreJobs() {
  console.log('\n# Sources, icons, versions, offline');
  const p = projects.python;
  const base = { name: 'Hello python', project: p.project, source: { kind: 'inline' }, files: p.files, runtime: 'python', launch: p.launch };
  const png = pngOf(64).toString('base64');
  // An icon: every mode has it in the record; B and C put it in the files,
  // mode A's files are never changed (the lock rules, design.md 3).
  await job('icon, mode C', Object.assign({}, base, { mode: 'C', icon: { choice: 'custom', data: 'data:image/png;base64,' + png, filename: 'x.png', type: 'image/png' } }));
  const a = await job('icon, mode A', Object.assign({}, base, { mode: 'A', icon: { data: png } }), { quickPlans: true });
  const plain = await job('no icon, mode A', Object.assign({}, base, { mode: 'A', name: 'Hello python (plain)' }), { quickPlans: true });
  obs('icon, mode A: the Windows file is our base untouched; the icon is only in the record',
    !!(a && plain) && a.job.result.files[0].sha256 === plain.job.result.files[0].sha256 && /\nicon\t[0-9a-f]{64}\n/.test(a.rec));
  const pngSha = sha(Buffer.from(png, 'base64'));
  const ic = await get('/icons/' + pngSha + '.png');
  obs('/icons/<sha256>.png: the stored upload', { status: ic.status, sha256: sha(ic.body), type: ic.headers['content-type'], cache: ic.headers['cache-control'] });
  await job('icon by sha256 alone', Object.assign({}, base, { mode: 'C', platforms: ['linux'], icon: { sha256: pngSha } }), { quickPlans: true });
  await job('icon by an unknown sha256', Object.assign({}, base, { mode: 'C', platforms: ['linux'], icon: { sha256: 'b'.repeat(64) } }), { quickPlans: true });
  await job('icon not square', Object.assign({}, base, { mode: 'C', icon: { data: pngOf(64, 32).toString('base64') } }), { planOnly: true });
  // Versions.
  await job('a version range', Object.assign({}, base, { mode: 'C', select: 'range', range: '>=3.8,<3.12', platforms: ['windows', 'linux'] }));
  await job('a range matching nothing', Object.assign({}, base, { mode: 'C', select: 'range', range: '>=99' }));
  await job('an exact version', Object.assign({}, base, { mode: 'B', select: 'exact', range: '3.8.10' }));
  await job('asyncio', Object.assign({}, base, { mode: 'C', select: 'asyncio', platforms: ['windows'] }));
  await job('a range matching nothing, offline', Object.assign({}, base, { mode: 'C', offline: true, select: 'range', range: '>=99', platforms: ['linux'] }));
  // Settings.
  await job('settings', Object.assign({}, base, { mode: 'C', console: false, menu: false, desktop: true, root: 'all', rootname: 'myapps',
    platforms: ['macos', 'windows'], name: 'Settings test', install: 'pip install .', launch: '{runtime} -m hello --flag' }));
  await job('empty install: the policy picks', Object.assign({}, base, { mode: 'C', files: { 'hello/__main__.py': 'print(1)\n', 'requirements.txt': 'six\n' }, platforms: ['linux'] }));
  // Composer comes with PHP for projects with a composer.json since 2026-09-19 (it was refused).
  await job('PHP composer.json: Composer', Object.assign({}, base, { runtime: 'php', mode: 'C', files: { 'composer.json': '{}', 'index.php': '<?php echo 1;' }, platforms: ['linux'] }), { planOnly: true });
  // Packages: at a given version the same answers; at the newest, only
  // how the job ends.
  await job('package, version given', Object.assign({}, base, { mode: 'C', source: { kind: 'package', value: 'requests', version: '2.32.3' }, files: null, platforms: ['linux'], launch: '' }));
  await job('package, newest', Object.assign({}, base, { mode: 'A', source: { kind: 'package', value: 'Requests' }, files: null, launch: '' }), { volatile: true });
  await job('npm package with a program', { name: '', source: { kind: 'package', value: 'cowsay' }, runtime: 'node', mode: 'C', platforms: ['linux'] }, { volatile: true });
  await job('npm scoped package', { name: '', source: { kind: 'package', value: '@angular/cli', version: '17.3.8' }, runtime: 'node', mode: 'C', platforms: ['windows'] });
  await job('crates.io package', { name: '', source: { kind: 'package', value: 'ripgrep' }, runtime: 'rust', mode: 'C', platforms: ['linux'] }, { volatile: true });
  await job('Go module', { name: '', source: { kind: 'package', value: 'golang.org/x/example/hello' }, runtime: 'go', mode: 'C', platforms: ['linux'] }, { volatile: true });
  await job('package the registry doesn\'t know', { name: '', source: { kind: 'package', value: 'this-package-does-not-exist-ti-oracle-4711' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  await job('package version the registry doesn\'t know', { name: '', source: { kind: 'package', value: 'requests', version: '0.0.0.0.1' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  // GitHub and URL sources.
  await job('GitHub source', { name: 'GitHub test', source: { kind: 'github', value: 'https://github.com/octocat/Hello-World.git' }, runtime: 'python', mode: 'C', platforms: ['linux', 'macos'], launch: '{runtime} -c "print(1)"' });
  await job('GitHub source at a ref', { name: 'GitHub ref', source: { kind: 'github', value: 'octocat/Hello-World', ref: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' }, runtime: 'python', mode: 'A', launch: '{runtime} -c "print(1)"' }, { quickPlans: true });
  await job('GitHub repo that doesn\'t exist', { name: 'x', source: { kind: 'github', value: 'octocat/this-repo-does-not-exist-4711' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  await job('URL source', { name: '', source: { kind: 'url', value: 'https://codeload.github.com/octocat/Hello-World/tar.gz/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' }, runtime: 'python', mode: 'C', platforms: ['linux'], launch: '{runtime} -c "print(1)"' });
  await job('URL source that isn\'t a .tar.gz', { name: 'x', source: { kind: 'url', value: 'https://raw.githubusercontent.com/octocat/Hello-World/master/README' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  await job('URL source that answers 404', { name: 'x', source: { kind: 'url', value: 'https://codeload.github.com/octocat/this-repo-does-not-exist-4711/tar.gz/main' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  // Offline: the signed plan and every download packed.
  if (!QUICK) {
    await job('offline, mode C', Object.assign({}, base, { mode: 'C', offline: true, select: 'exact', range: '3.8.10', platforms: ['windows', 'linux', 'macos'] }));
    await job('offline with an icon, mode B', Object.assign({}, base, { mode: 'B', offline: true, select: 'exact', range: '3.8.10', platforms: ['windows', 'linux'], icon: { data: png } }));
  }
}

/* ---------- 4. takedown ---------- */

async function takedown() {
  console.log('\n# Takedown');
  const p = projects.python;
  const body = { name: 'Hello python', project: p.project, source: { kind: 'inline' }, files: p.files, runtime: 'python', mode: 'C', platforms: ['linux'], launch: p.launch };
  const sample = await job('sample for the takedown checks', body, { planOnly: true });
  const file = path.join(DATA, 'takedown.txt');
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const before = (await get('/api/takedown')).text;
  // A record the server stores: a plan by name.
  const rec = (await get('/api/plan/name/python/six')).headers['x-ti-record'];
  const srcSha = /^source\tinline\t(\S+)/m.exec(sample.rec)[1];
  const ours = ['source github oracle-owner/oracle-repo', 'source package attrs', 'record ' + rec, 'sha ' + srcSha, 'sha ' + 'd'.repeat(64), 'file ' + 'e'.repeat(64)];
  const mask = (s) => s.split(rec).join('<record>').split(srcSha).join('<src>');
  try {
    fs.writeFileSync(file, (saved ? saved.toString('utf8') : '') + ['# golden test entries', ...ours].join('\n') + '\n');
    const list = JSON.parse((await get('/api/takedown')).text).entries || [];
    obs('/api/takedown: the entries added', list.filter((e) => ours.includes(e)).map(mask));
    for (const v of ['oracle-owner/oracle-repo', 'Oracle-Owner/Oracle-Repo', 'https://github.com/oracle-owner/oracle-repo.git', 'http://github.com/Oracle-Owner/oracle-repo/', ' oracle-owner/oracle-repo ']) {
      const r = await post('/api/jobs', JSON.stringify({ name: 'x', source: { kind: 'github', value: v }, runtime: 'python', mode: 'C' }));
      obs(`takedown: source github ${JSON.stringify(v)}`, { status: r.status, body: r.text });
    }
    {
      const r = await post('/api/jobs', JSON.stringify({ name: 'x', source: { kind: 'package', value: 'Attrs' }, runtime: 'python', mode: 'C' }));
      obs('takedown: source package Attrs (normalised)', { status: r.status, body: r.text });
      const x = await get('/api/plan/name/python/attrs');
      obs('takedown: the plan by name for a taken-down package', { status: x.status, body: x.text });
    }
    for (const u of ['/api/records/', '/api/plan/', '/dl/']) {
      const x = await get(u + rec + (u === '/dl/' ? '/f.exe' : ''));
      obs(`takedown: ${u}<record>`, { status: x.status, body: x.text });
    }
    {
      const x = await get('/api/plan/name/python/six');
      obs('takedown: the plan by name for a taken-down record', { status: x.status, body: x.text });
    }
    {
      const x = await get('/src/' + srcSha + '.tar.gz');
      obs('takedown: sha <sha256> refuses the stored source', { status: x.status, body: x.text });
      const y = await get('/icons/' + 'd'.repeat(64) + '.png');
      obs('takedown: sha <sha256> refuses the icon', { status: y.status, body: y.text });
    }
    {
      // The same job again: its source hashes to a listed sha.
      const r = await post('/api/jobs', JSON.stringify(body));
      const j = r.status === 202 ? await waitJob(JSON.parse(r.text).id) : null;
      obs('takedown: a job whose source hash is listed', { status: r.status, job: j && j.status, error: j && j.error });
    }
    {
      // The signed revocation list (design.md 7.1): the same entries, one
      // `revoke` line each, signed with the plan key. `issued`, `expires`
      // and `serial` are times, so only their shape is observed.
      const r = await get('/api/revocations');
      const doc = r.text;
      const head = doc.split('\n').slice(0, 4);
      obs('revocations: the header', {
        status: r.status, cache: r.headers['cache-control'], type: r.headers['content-type'],
        kind: head[0],
        issued: /^issued\t\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(head[1] || ''),
        expires: /^expires\t\d{4}-\d\d-\d\dT\d\d:00:00Z$/.test(head[2] || ''),
        serial: /^serial\t\d+$/.test(head[3] || ''),
        signed: verifyDoc(doc, 'ti-revocations'),
        notAPlan: !verifyDoc(doc, 'ti-plan'),
      });
      const wanted = new Set(ours.map((e) => 'revoke\t' + e.split(' ').join('\t')).map(mask));
      obs('revocations: the entries added', doc.split('\n').filter((l) => l.startsWith('revoke\t')).map(mask).filter((l) => wanted.has(l)));
      // Stable for the hour, so it can be cached and signed once.
      const again = await get('/api/revocations');
      ok(again.text === doc, 'revocations: two requests in one hour are the same bytes');
      // The `file <sha256>` kind (new here) refuses a stored file too.
      const y = await get('/src/' + 'e'.repeat(64) + '.tar.gz');
      obs('takedown: file <sha256> refuses a stored file', { status: y.status, body: y.text });
    }
  } finally {
    if (saved === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, saved);
  }
  ok((await get('/api/takedown')).text === before, 'takedown: the list is back as it was');
}

/* ---------- 5. rate limits ---------- */

async function rateLimits() {
  console.log('\n# Rate limits (they use up this address\'s minute)');
  await sleep(61000);   // the window empty
  for (const [label, n, fn] of [
    ['plans by name: 30 a minute', 31, () => raw('/api/plan/name/zig/x')],
    ['relay and tsa: 30 a minute', 31, () => raw('/api/relay?url=x')],
    ['jobs: 20 a minute', 21, () => raw('/api/jobs', { method: 'POST', body: '{' })],
  ]) {
    const codes = [];
    for (let i = 0; i < n + 1; i++) codes.push((await fn()).status);
    obs('rate limit, ' + label, codes);
  }
  const a = await raw('/api/jobs', { method: 'POST', body: '{' });
  obs('the 429 answer', { status: a.status, body: a.text });
}

/* ---------- run ---------- */

takeLock();
{
  const pn = await get('/api/plan/name/python/requests');
  pub = /^backend\t(.*)$/m.exec((await get('/api/records/' + pn.headers['x-ti-record'])).text)[1];
  if (RECORD) golden.public = pub;
  console.log(`${SERVER} (public ${pub}; data ${DATA})` + (RECORD ? ': recording' : pub === golden.public ? '' : `: not the golden public URL ${golden.public}, normalised to it`));
}
if (!RECORD && !fs.existsSync(path.join(DATA, 'plan-signing-key.pub'))) {
  console.log(`--data ${DATA} has no plan-signing-key.pub: is it this server's data folder?`);
  process.exit(2);
}
try {
  await fixed();
  if (!RECORD) {
    const want = JSON.parse(golden.obs['/api/catalog/runtimes'].body);
    const got = JSON.parse((await get('/api/catalog/runtimes')).text);
    if (canon(want) !== canon(got)) console.log('\nNOTE: this server\'s catalogue is not the one the goldens were made from (its runtimes summary differs), so plans will differ too.');
  }
  await badRequests();
  await jobs();
  await moreJobs();
  await takedown();
  if (RATE) await rateLimits();
} finally {
  for (const f of added) fs.rmSync(f, { force: true });
}

if (RECORD) {
  const b = Buffer.from(JSON.stringify(golden, null, 1));
  fs.writeFileSync(GOLDEN_FILE, zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }));
  console.log(`\nrecorded ${Object.keys(golden.obs).length} answers and ${Object.keys(golden.fixed).length} records' plans to ${GOLDEN_FILE}; review before committing`);
  process.exit(0);
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failures.length) console.log('Failed:\n  ' + failures.join('\n  '));
if (notes.length) console.log('\nNotes:\n- ' + notes.join('\n- '));
process.exit(failed ? 1 : 0);
