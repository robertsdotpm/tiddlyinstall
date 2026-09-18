// Checks the Node build server (backend/) against the Go one while both
// exist: the same requests go to both and the answers are compared.
//
//   node tests/backend-oracle.mjs --go http://127.0.0.1:8080 --node http://127.0.0.1:8090 \
//        --node-data server/data-node [--go-data server/data] [--runtimes a,b] [--quick]
//
// What must match, and how:
//   - byte for byte: /api/pubkey, /api/catalog/runtimes, /bases/*, the site,
//     error answers (status, code and message) for bad requests, plans by
//     name, and plans by hash for the same record bytes. A record made by
//     each server differs in `created` (a timestamp), so the plan for Go's
//     record is also asked of Node: Go's record and source are copied into
//     Node's data folder (--node-data), and both plans for that hash, signed,
//     must be the same bytes. Ed25519 is deterministic, so equal bytes mean
//     the signature matched too.
//   - records: equal with `created` masked. An inline source's archive is a
//     gzip, and Go's deflate is not zlib's, so its SHA-256 differs; the tar
//     inside is compared byte for byte instead, and the hash is masked.
//   - jobs: status, class, errors; file names (mode A's record hash masked),
//     sizes, signed, offline. Mode A's Windows and Linux files are the same
//     bytes; every other file is read back with js/ibfile.js and compared
//     part by part (base, record, plan, pack; for macOS the zip's entries).
//
// If the two servers have different -public URLs, Node's is replaced by
// Go's before comparing, and signatures are checked with the public key
// instead of compared. Run both with the same -public for the byte-for-byte
// signature check.
//
// --go-data names the Go server's data folder: with it, the takedown checks
// add a few made-up entries to both takedown.txt files and put them back
// afterwards (Go's file is removed if it didn't exist). Without it they are
// skipped.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { readInstaller, zipEntryData, peInfo, peChecksum } from '../js/ibfile.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const GO = arg('--go') || 'http://127.0.0.1:8080';
const NODE = arg('--node') || 'http://127.0.0.1:8090';
const NODE_DATA = arg('--node-data');
const GO_DATA = arg('--go-data');
const QUICK = process.argv.includes('--quick');
if (!NODE_DATA) {
  console.log('usage: node tests/backend-oracle.mjs --go URL --node URL --node-data DIR [--go-data DIR] [--runtimes a,b] [--quick]');
  process.exit(2);
}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const projects = JSON.parse(fs.readFileSync(path.join(HERE, 'matrix', 'projects.json'))).projects;
const RUNTIMES = arg('--runtimes') ? arg('--runtimes').split(',') : Object.keys(projects);

let passed = 0, failed = 0;
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

/* ---------- HTTP, raw (no URL normalising, no redirects followed) ---------- */

function raw(base, p, { method = 'GET', body = null, headers = {} } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: p, method, headers: Object.assign({}, headers, body ? { 'Content-Length': Buffer.byteLength(body) } : {}) }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const b = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: b, text: b.toString('utf8') });
      });
    });
    req.on('error', reject);
    if (body) req.end(body); else req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST with the servers' rate limits waited out.
async function post(base, p, body, headers = { 'Content-Type': 'application/json' }) {
  for (;;) {
    const r = await raw(base, p, { method: 'POST', body, headers });
    if (r.status !== 429) return r;
    await sleep(5000);
  }
}

async function get(base, p) {
  for (;;) {
    const r = await raw(base, p);
    if (r.status !== 429) return r;
    await sleep(5000);
  }
}

async function waitJob(base, id) {
  for (;;) {
    const r = await get(base, '/api/jobs/' + id);
    const j = JSON.parse(r.text);
    if (j.status === 'done' || j.status === 'failed') return j;
    await sleep(400);
  }
}

// A job on both servers, one after the other: {go, node} as {accept, job}.
async function both(body) {
  const out = {};
  for (const [k, base] of [['go', GO], ['node', NODE]]) {
    const r = await post(base, '/api/jobs', JSON.stringify(body));
    const accept = { status: r.status, json: safeJSON(r.text), text: r.text };
    out[k] = { accept, job: r.status === 202 ? await waitJob(base, accept.json.id) : null };
  }
  return out;
}

function safeJSON(t) { try { return JSON.parse(t); } catch (e) { return null; } }

function firstDiff(a, b) {
  const x = String(a).split('\n'), y = String(b).split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}:\n  go:   ${JSON.stringify(x[i])}\n  node: ${JSON.stringify(y[i])}`;
  }
  return '';
}

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- the two servers' public URLs ---------- */

let pubGo = null, pubNode = null;
const normNode = (s) => (pubGo && pubNode && pubGo !== pubNode ? String(s).split(pubNode).join(pubGo) : String(s));
const samePublic = () => pubGo === pubNode;

function maskRecord(t, { inline = true } = {}) {
  let s = t.replace(/^created\t.*\n/m, 'created\t<time>\n');
  if (inline) s = s.replace(/^(source\tinline\t)[0-9a-f]{64}$/m, '$1<src>');
  return s;
}

let pubRaw = null;
function verifyPlan(plan) {
  const m = /\nsig\ted25519\t(\S+)\n$/.exec(plan);
  if (!m || !pubRaw) return false;
  const msg = Buffer.from(plan.slice(0, m.index + 1));
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pubRaw.toString('base64url') }, format: 'jwk' });
  return crypto.verify(null, msg, key, Buffer.from(m[1], 'base64'));
}

// Compare plans: bytes when the servers share a public URL, else Node's
// normalised and both signatures checked.
function samePlan(name, go, node) {
  if (samePublic()) return ok(go === node, name + ' (byte for byte, signature included)', firstDiff(go, node));
  const strip = (p) => p.replace(/sig\ted25519\t\S+\n$/, '');
  return ok(verifyPlan(node) && strip(go) === strip(normNode(node)), name + ' (Node\'s public URL normalised; its signature checked)', firstDiff(strip(go), strip(normNode(node))));
}

/* ---------- 1. fixed answers ---------- */

async function fixed() {
  console.log('\n# Fixed answers');
  for (const p of ['/api/pubkey', '/api/catalog/runtimes', '/api/takedown', '/bases/windows', '/bases/linux', '/bases/macos', '/']) {
    const [a, b] = [await get(GO, p), await get(NODE, p)];
    ok(a.status === b.status && a.body.equals(b.body), `${p}: same status and bytes (${a.status}, ${a.body.length} bytes)`,
      `go ${a.status} ${a.body.length} bytes, node ${b.status} ${b.body.length} bytes`);
    for (const h of ['content-type', 'cache-control', 'content-disposition']) {
      ok(a.headers[h] === b.headers[h], `${p}: header ${h}`, `go ${a.headers[h]}, node ${b.headers[h]}`);
    }
  }
  const pk = JSON.parse((await get(GO, '/api/pubkey')).text);
  pubRaw = Buffer.from(pk.key, 'base64');
  // Health: the same fields; the values are each server's own.
  const [hg, hn] = [JSON.parse((await get(GO, '/api/health')).text), JSON.parse((await get(NODE, '/api/health')).text)];
  ok(JSON.stringify(Object.keys(hg)) === JSON.stringify(Object.keys(hn)) && JSON.stringify(Object.keys(hg.queues)) === JSON.stringify(Object.keys(hn.queues)) &&
    hg.version === hn.version && hn.ok === true && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(hn.time), '/api/health: same fields, version and time format', JSON.stringify([hg, hn]));
  // CORS on every route, OPTIONS answered.
  for (const [m, p] of [['OPTIONS', '/api/jobs'], ['OPTIONS', '/anything'], ['GET', '/api/nope'], ['GET', '/api/health']]) {
    const [a, b] = [await raw(GO, p, { method: m }), await raw(NODE, p, { method: m })];
    const cors = (r) => ['access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age'].map((h) => r.headers[h]).join('|');
    ok(a.status === b.status && cors(a) === cors(b) && cors(a).startsWith('*|'), `${m} ${p}: status ${a.status} and CORS headers`, `go ${a.status} ${cors(a)}\nnode ${b.status} ${cors(b)}`);
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
    ['GET', '/dl/x/y'], ['GET', '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaa/nothing.exe'], ['GET', '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaa/.hidden'],
    ['GET', '/dl/aaaaaaaaaaaaaaaaaaaaaaaaaa/a%2Fb'], ['GET', '/icons/abc.png'], ['GET', '/icons/' + 'a'.repeat(64) + '.png'],
    ['GET', '/icons/' + 'a'.repeat(64)], ['GET', '/bases/nope'], ['HEAD', '/bases/linux'], ['HEAD', '/api/pubkey'],
  ];
  for (const [m, p] of paths) {
    const [a, b] = [await raw(GO, p, { method: m }), await raw(NODE, p, { method: m })];
    const same = a.status === b.status && a.body.equals(b.body) && (a.headers.location || '') === (b.headers.location || '') &&
      (a.headers['content-type'] || '') === (b.headers['content-type'] || '');
    ok(same, `${m} ${p}: ${a.status}${a.headers.location ? ' -> ' + a.headers.location : ''}`,
      `go   ${a.status} ${a.headers['content-type']} ${a.headers.location || ''} ${JSON.stringify(a.text.slice(0, 120))}\nnode ${b.status} ${b.headers['content-type']} ${b.headers.location || ''} ${JSON.stringify(b.text.slice(0, 120))}`);
    if (a.status === 405) ok(a.headers.allow === b.headers.allow, `${m} ${p}: Allow header`, `go ${a.headers.allow}, node ${b.headers.allow}`);
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
    ['bidi in rootname', w({ rootname: 'ib\u200f' })],
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
    const [a, b] = [await post(GO, '/api/jobs', body), await post(NODE, '/api/jobs', body)];
    if (a.status === 202 || b.status === 202) {
      // Accepted (a check that happens in the job): compare how the job ends.
      const ja = a.status === 202 ? await waitJob(GO, JSON.parse(a.text).id) : null;
      const jb = b.status === 202 ? await waitJob(NODE, JSON.parse(b.text).id) : null;
      ok(a.status === b.status && ja && jb && ja.status === jb.status && ja.error === jb.error && ja.class === jb.class,
        `${name}: accepted by both; the job ${ja && ja.status}${ja && ja.error ? ': ' + ja.error : ''}`, `go ${a.status} ${JSON.stringify(ja)}\nnode ${b.status} ${JSON.stringify(jb)}`);
      continue;
    }
    ok(a.status === b.status && a.text === b.text, `${name}: ${a.status} ${a.text.trim()}`, `go   ${a.status} ${a.text}node ${b.status} ${b.text}`);
  }
  // The server fetches nothing but public addresses: sources, and every
  // redirect from one.
  console.log('\n# SSRF');
  for (const u of ['http://127.0.0.1/x.tar.gz', 'http://10.0.0.1/x.tar.gz', 'http://localhost:8080/api/health', 'http://[::1]/x.tar.gz',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/x.tar.gz', 'http://0.0.0.0:8080/', 'http://2130706433/x.tar.gz',
    'http://10.0.1.76:8080/src/x.tar.gz', 'https://httpbin.org/redirect-to?url=http%3A%2F%2F127.0.0.1%3A8080%2Fapi%2Fhealth']) {
    const r = await both(Object.assign({}, good, { name: 'ssrf', source: { kind: 'url', value: u }, platforms: ['linux'] }));
    ok(r.go.job && r.node.job && r.go.job.status === 'failed' && r.node.job.status === 'failed' && r.go.job.error === r.node.job.error,
      `url source ${u}: both refuse ("${r.node.job && r.node.job.error}")`, `go ${JSON.stringify(r.go.job && r.go.job.error)}\nnode ${JSON.stringify(r.node.job && r.node.job.error)}`);
  }
  for (const u of ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://localhost:8080/api/pubkey', 'file:///etc/passwd', '']) {
    const q = '/api/relay?url=' + encodeURIComponent(u);
    const [a, b] = [await get(GO, q), await get(NODE, q)];
    ok(a.status === b.status && a.text === b.text, `relay ${JSON.stringify(u)}: ${a.status} ${a.text.trim()}`, `go ${a.status} ${a.text}node ${b.status} ${b.text}`);
  }
  const relayURL = 'https://ziglang.org/download/0.1.1/zig-0.1.1.tar.xz';   // in the catalogue, 1.6 MB
  {
    const q = '/api/relay?url=' + encodeURIComponent(relayURL);
    const [a, b] = [await get(GO, q), await get(NODE, q)];
    ok(a.status === 200 && b.status === 200 && a.body.equals(b.body) && a.headers['content-type'] === b.headers['content-type'],
      `relay of a catalogue file: both 200, same ${a.body.length} bytes`, `go ${a.status} ${a.body.length}, node ${b.status} ${b.body.length}`);
  }
  // The timestamp relay: a fixed list, a DER body of at most 4 KB.
  console.log('\n# Timestamp relay');
  const tsReq = Buffer.from('3039020101303130' + '0d060960864801650304020105000420' + '00'.repeat(32) + '0101ff', 'hex');
  tsReq[1] = tsReq.length - 2;
  for (const [name, q, body] of [['unknown name', 'nope', tsReq], ['no name', '', tsReq], ['__proto__', '__proto__', tsReq],
    ['not DER', 'digicert', Buffer.from('hello')], ['one byte', 'digicert', Buffer.from([0x30])], ['over 4 KB', 'digicert', Buffer.concat([Buffer.from([0x30]), Buffer.alloc(4096)])]]) {
    const hdr = { 'Content-Type': 'application/timestamp-query' };
    const [a, b] = [await post(GO, '/api/tsa?name=' + q, body, hdr), await post(NODE, '/api/tsa?name=' + q, body, hdr)];
    ok(a.status === b.status && a.text === b.text, `tsa ${name}: ${a.status} ${a.text.trim()}`, `go ${a.status} ${a.text}node ${b.status} ${b.text}`);
  }
  {
    const hdr = { 'Content-Type': 'application/timestamp-query' };
    const [a, b] = [await post(GO, '/api/tsa?name=digicert', tsReq, hdr), await post(NODE, '/api/tsa?name=digicert', tsReq, hdr)];
    ok(a.status === b.status && a.headers['content-type'] === b.headers['content-type'] && (a.status !== 200 || (a.body[0] === 0x30 && b.body[0] === 0x30)),
      `tsa digicert, a real request: both ${a.status} ${a.headers['content-type']} (the answers carry their own times)`, `go ${a.status} ${a.text.slice(0, 80)}\nnode ${b.status} ${b.text.slice(0, 80)}`);
  }
  // Plans by name.
  console.log('\n# Plans by name');
  for (const [rt, name] of [['python', 'requests'], ['python', 'Requests'], ['node', 'cowsay'], ['rust', 'ripgrep'], ['ruby', 'rake'],
    ['go', 'golang.org%2Fx%2Fexample%2Fhello'], ['dotnet', 'dotnet-script'],
    ['zig', 'foo'], ['cobol', 'foo'], ['node', '%40types%2Fnode'], ['node', '@scope'], ['python', 'a%20b'], ['python', 'x'.repeat(101)],
    ['python' + 'x'.repeat(20), 'a'], ['python', 'this-package-does-not-exist-ib-oracle-4711'], ['python', 'requests?os=linux']]) {
    const p = `/api/plan/name/${rt}/${name}`;
    const [a, b] = [await get(GO, p), await get(NODE, p)];
    if (a.status === 200 && b.status === 200) {
      samePlan(`plan by name ${rt}/${name}`, a.text, b.text);
      const recA = (await get(GO, '/api/records/' + a.headers['x-ib-record'])).text;
      const recB = (await get(NODE, '/api/records/' + b.headers['x-ib-record'])).text;
      ok(recA === normNode(recB) && (!samePublic() || a.headers['x-ib-record'] === b.headers['x-ib-record']), `plan by name ${rt}/${name}: the same record ${a.headers['x-ib-record']}`, firstDiff(recA, normNode(recB)));
    } else {
      ok(a.status === b.status && a.text === b.text, `plan by name ${rt}/${name}: ${a.status} ${a.text.trim().slice(0, 150)}`, `go ${a.status} ${a.text}node ${b.status} ${b.text}`);
    }
  }
}

/* ---------- 3. jobs ---------- */

const dl = async (base, url) => (await get(base, url)).body;

async function tarOf(base, shaHex) {
  const r = await get(base, '/src/' + shaHex + '.tar.gz');
  return r.status === 200 ? zlib.gunzipSync(r.body) : null;
}

// Go's record and source, copied into Node's data folder: the same bytes.
async function adoptGoRecord(hash, rec) {
  fs.mkdirSync(path.join(NODE_DATA, 'records'), { recursive: true });
  fs.writeFileSync(path.join(NODE_DATA, 'records', hash + '.txt'), rec);
  const m = /^source\t(?:inline\t([0-9a-f]{64})|github\t\S+\t\S+\t([0-9a-f]{64})|url\t\S+\t([0-9a-f]{64}))$/m.exec(rec);
  const s = m && (m[1] || m[2] || m[3]);
  if (s) {
    fs.mkdirSync(path.join(NODE_DATA, 'src'), { recursive: true });
    fs.writeFileSync(path.join(NODE_DATA, 'src', s + '.tar.gz'), await dl(GO, '/src/' + s + '.tar.gz'));
  }
  const ic = /^icon\t([0-9a-f]{64})$/m.exec(rec);
  if (ic) {
    fs.mkdirSync(path.join(NODE_DATA, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(NODE_DATA, 'icons', ic[1] + '.png'), await dl(GO, '/icons/' + ic[1] + '.png'));
  }
}

function zipView(info, hashes) {
  // Entries by name (the record hash in a mode A .app's name masked), with
  // their compressed bytes' hash; directory entries apart.
  const out = new Map();
  for (const e of info.entries) {
    let n = e.name;
    for (const h of hashes) n = n.split(h).join('<hash>');
    out.set(n, { raw: sha(Buffer.from(e.raw)), dir: n.endsWith('/'), mode: (e.madeBy >>> 8) === 3 ? (e.extAttr >>> 16) : 0 });
  }
  return out;
}

async function compareFiles(label, rt, mode, go, node, recGo, recNode) {
  const fa = go.result.files, fb = node.result.files;
  ok(fa.length === fb.length && fa.every((f, i) => f.platform === fb[i].platform), `${label}: the same platforms`, JSON.stringify([fa.map((f) => f.platform), fb.map((f) => f.platform)]));
  const ha = go.result.record, hb = node.result.record;
  for (let i = 0; i < Math.min(fa.length, fb.length); i++) {
    const a = fa[i], b = fb[i], plat = a.platform;
    const na = a.name.split(ha).join('<hash>'), nb = b.name.split(hb).join('<hash>');
    ok(na === nb && a.url === '/dl/' + ha + '/' + a.name && b.url === '/dl/' + hb + '/' + b.name && a.signed === b.signed && a.offline === b.offline,
      `${label} ${plat}: name ${na}, url, signed "${a.signed}", offline ${a.offline}`, JSON.stringify([a, b]));
    if (mode === 'A') ok(b.name.includes('_' + hb + '.'), `${label} ${plat}: the file name carries the record hash`, b.name);
    const [da, db] = [await dl(GO, a.url), await dl(NODE, b.url)];
    ok(da.length === a.size && db.length === b.size && sha(db) === b.sha256 && sha(da) === a.sha256, `${label} ${plat}: size and sha256 as the job says`, JSON.stringify([a, b, da.length, db.length]));
    if (mode === 'A' && plat !== 'macos') {
      ok(da.equals(db), `${label} ${plat}: the same bytes (our base, renamed)`, `go ${a.sha256}\nnode ${b.sha256}`);
      continue;
    }
    const [ia, ib] = [await readInstaller(new Uint8Array(da), a.name), await readInstaller(new Uint8Array(db), b.name)];
    if (ia.kind === 'zip') {
      const [za, zb] = [zipView(ia, [ha]), zipView(ib, [hb])];
      const names = new Set([...za.keys(), ...zb.keys()]);
      const diff = [];
      for (const n of names) {
        const x = za.get(n), y = zb.get(n);
        if (n.includes('/Contents/Resources/ib/') && !n.endsWith('/')) continue;   // compared below, uncompressed
        if (n.endsWith('Info.plist') || n.endsWith('AppIcon.icns')) continue;
        if (!x || !y) { if (!(y && y.dir) && !(x && x.dir)) diff.push(n + (x ? ' only in go' : ' only in node')); else if (y && y.dir && !x) note('macOS zips from Node carry directory entries for Contents/Resources/ib/ (and pack/), which Go\'s zips leave out; unzip and ditto make the folders either way'); continue; }
        if (x.raw !== y.raw) diff.push(n + ' differs');
      }
      ok(diff.length === 0, `${label} ${plat}: the .app's entries are the same (names, bytes)`, diff.slice(0, 10).join('\n'));
      const sig = (z) => [...z.keys()].some((n) => n.includes('/Contents/_CodeSignature/'));
      ok(sig(za) === sig(zb), `${label} ${plat}: code signature ${sig(za) ? 'kept' : 'dropped'} in both`);
      const pl = async (info) => {
        const e = info.entries.find((x) => x.name.endsWith('.app/Contents/Info.plist'));
        return e ? Buffer.from(await zipEntryData(e)).toString('utf8') : '';
      };
      ok(await pl(ia) === await pl(ib), `${label} ${plat}: the same Info.plist`);
      const icns = async (info) => {
        const e = info.entries.find((x) => x.name.endsWith('.app/Contents/Resources/AppIcon.icns'));
        return e ? Buffer.from(await zipEntryData(e)) : null;
      };
      const [ca, cb] = [await icns(ia), await icns(ib)];
      ok(!!ca === !!cb, `${label} ${plat}: AppIcon.icns ${ca ? 'in both' : 'in neither'}`);
      if (ca && cb) {
        const types = (b) => { const t = []; for (let o = 8; o + 8 <= b.length; o += b.readUInt32BE(o + 4)) t.push(b.toString('latin1', o, o + 4)); return t.join(','); };
        ok(types(ca) === types(cb), `${label} ${plat}: .icns with ${types(ca)}`, types(cb));
        if (!ca.equals(cb)) note('Icons: Go scales with x/image/draw and encodes PNG with Go\'s deflate; Node uses js/icon.js (the browser\'s code), so the pixels and PNG bytes of icons differ slightly. The same sizes and formats are written.');
      }
    } else {
      ok(Buffer.from(ia.base).equals(Buffer.from(ib.base)) || (recGo.includes('\nicon\t') && ia.kind === 'exe'),
        `${label} ${plat}: the same base bytes before the block`, `go ${ia.base.length}, node ${ib.base.length}`);
      if (ia.kind === 'exe' && recGo.includes('\nicon\t')) {
        const sums = (u8) => { const p = peInfo(u8); return p ? [new DataView(u8.buffer, u8.byteOffset).getUint32(p.checksumOff, true), peChecksum(u8, p.checksumOff)] : []; };
        const [sa, sb] = [sums(new Uint8Array(da)), sums(new Uint8Array(db))];
        ok(sa[0] === sa[1] && sb[0] === sb[1] && sb[0] !== 0, `${label} ${plat}: the PE checksum is right in both (over the whole file)`, JSON.stringify([sa, sb]));
        note('Windows icons: Go writes the icon resource with its own PE code (server/internal/icon/pe.go), Node with resedit-js (js/icon.js, as the browser editor does), so the .exe bytes differ; both keep the NSIS data and set a correct checksum.');
      }
    }
    if (mode === 'A') {
      ok(ia.record === null && ib.record === null && !ia.plan && !ib.plan && !ia.pack.length && !ib.pack.length, `${label} ${plat}: nothing inside (mode A: the record is only on the server)`);
      continue;
    }
    ok(maskRecord(ia.record || '') === maskRecord(normNode(ib.record || '')) && (ib.record || '') === recNode, `${label} ${plat}: the record inside (created masked)`, firstDiff(maskRecord(ia.record || ''), maskRecord(normNode(ib.record || ''))));
    const pa = ia.plan || '', pb = ib.plan || '';
    if (pa || pb) {
      const m = (p) => normNode(p).replace(/^record\t\S+$/m, 'record\t<hash>').replace(/^appid\t\S+$/mg, 'appid\t<appid>').replace(/^(source\t)[0-9a-f]{64}(\.tar\.gz\t)[0-9a-f]{64}\t\d+/m, '$1<src>$2<src>').replace(/\/src\/[0-9a-f]{64}\.tar\.gz/g, '/src/<src>.tar.gz').replace(/sig\ted25519\t\S+\n$/, '');
      ok(verifyPlan(pa) && verifyPlan(pb) && m(pa) === m(pb), `${label} ${plat}: the embedded plan (signed; record, appid and source masked)`, firstDiff(m(pa), m(pb)));
    }
    const packs = (info) => info.pack.map((x) => x.name + ' ' + (x.name === sha(Buffer.from(x.data)) ? 'ok' : 'BAD')).join('\n');
    const pka = packs(ia), pkb = packs(ib);
    const srcGo = /^source\tinline\t(\S+)/m.exec(recGo), srcNode = /^source\tinline\t(\S+)/m.exec(recNode);
    const mp = (s, src) => (src ? s.split(src[1]).join('<src>') : s);
    ok(mp(pka, srcGo) === mp(pkb, srcNode) && !pkb.includes('BAD'), `${label} ${plat}: the same packed files, each named by its SHA-256 (${ia.pack.length})`, pka + '\n--\n' + pkb);
  }
}

async function jobPair(label, body, opts = {}) {
  const r = await both(body);
  const [a, b] = [r.go, r.node];
  ok(a.accept.status === b.accept.status, `${label}: accepted ${a.accept.status}`, a.accept.text + '\n' + b.accept.text);
  if (a.accept.status !== 202) {
    ok(a.accept.text === b.accept.text, `${label}: the same refusal`, a.accept.text + b.accept.text);
    return null;
  }
  const keys = (o) => Object.keys(o).sort().join(',');
  ok(keys(a.accept.json) === keys(b.accept.json) && a.accept.json.class === b.accept.json.class && b.accept.json.status === 'queued' &&
    /^j_[0-9a-f]{18}$/.test(b.accept.json.id) && Number.isInteger(b.accept.json.ticket), `${label}: 202 ${a.accept.json.class}, ticket, id and fields`, JSON.stringify([a.accept.json, b.accept.json]));
  ok(a.job.status === b.job.status && a.job.error === b.job.error && a.job.progress === b.job.progress, `${label}: ${a.job.status}${a.job.error ? ' (' + a.job.error + ')' : ''}`,
    `go   ${a.job.status} ${a.job.error}\nnode ${b.job.status} ${b.job.error}`);
  if (a.job.status !== 'done' || b.job.status !== 'done') return null;
  ok(keys(a.job) === keys(b.job) && keys(a.job.result) === keys(b.job.result), `${label}: the job's fields`, keys(a.job) + '\n' + keys(b.job));
  const [recA, recB] = [(await get(GO, '/api/records/' + a.job.result.record)).text, (await get(NODE, '/api/records/' + b.job.result.record)).text];
  const inline = body.source.kind === 'inline';
  ok(maskRecord(recA, { inline }) === maskRecord(normNode(recB), { inline }), `${label}: the record${inline ? ' (created and the inline archive\'s hash masked)' : ' (created masked)'}`, firstDiff(maskRecord(recA, { inline }), maskRecord(normNode(recB), { inline })));
  if (!inline && samePublic()) {
    // Same bytes but for `created`: the same hash once the time is the same.
    const t = /^created\t(.*)$/m.exec(recA)[1];
    const fixed = recB.replace(/^created\t.*$/m, 'created\t' + t);
    ok(fixed === recA, `${label}: with Go's created time, Node's record is Go's, byte for byte`, firstDiff(recA, fixed));
  }
  const s1 = /^source\tinline\t(\S+)/m.exec(recA), s2 = /^source\tinline\t(\S+)/m.exec(recB);
  if (s1 && s2) {
    const [ta, tb] = [await tarOf(GO, s1[1]), await tarOf(NODE, s2[1])];
    ok(ta && tb && ta.equals(tb), `${label}: the inline source's tar is the same bytes (only the gzip around it differs)`, `go ${ta && ta.length}, node ${tb && tb.length}`);
    if (s1[1] !== s2[1]) note('Inline sources: the tar inside is byte for byte Go\'s, but the gzip around it is zlib\'s, not Go\'s compress/flate, so the archive\'s SHA-256, and so the record\'s hash, differs between the servers for the same job.');
  }
  // The plan for Go's record, from both.
  await adoptGoRecord(a.job.result.record, recA);
  const [pa, pb] = [await get(GO, '/api/plan/' + a.job.result.record), await get(NODE, '/api/plan/' + a.job.result.record)];
  if (pa.status === 200 && pb.status === 200) samePlan(`${label}: the plan for Go's record`, pa.text, pb.text);
  else ok(pa.status === pb.status && pa.text === pb.text, `${label}: the plan for Go's record: ${pa.status} ${pa.text.trim().slice(0, 120)}`, `go ${pa.status} ${pa.text}node ${pb.status} ${pb.text}`);
  if (!opts.planOnly) {
    for (const os of ['windows', 'linux', 'macos']) {
      if (opts.quickPlans) break;
      const [x, y] = [await get(GO, `/api/plan/${a.job.result.record}?os=${os}`), await get(NODE, `/api/plan/${a.job.result.record}?os=${os}`)];
      if (x.status === 200 && y.status === 200) samePlan(`${label}: the plan for Go's record, ?os=${os}`, x.text, y.text);
      else ok(x.status === y.status && x.text === y.text, `${label}: ?os=${os}: ${x.status}`, x.text + y.text);
    }
    // Node's own record's plan is signed with the same key and names Node's record.
    const own = await get(NODE, '/api/plan/' + b.job.result.record);
    ok(own.status === pb.status && (own.status !== 200 || (verifyPlan(own.text) && own.text.includes('\nrecord\t' + b.job.result.record + '\n'))),
      `${label}: the plan for Node's own record is signed and names it`, own.text.slice(0, 200));
    await compareFiles(label, body.runtime, body.mode, a.job, b.job, recA, recB);
  }
  return { go: a.job, node: b.job, recGo: recA, recNode: recB };
}

async function jobs() {
  console.log('\n# Jobs: every runtime, modes A, B and C');
  for (const rt of RUNTIMES) {
    const p = projects[rt];
    for (const mode of QUICK ? ['A', 'C'] : ['A', 'B', 'C']) {
      const body = { name: 'Hello ' + rt, project: p.project, source: { kind: 'inline' }, files: p.files, runtime: rt, mode,
        platforms: ['windows', 'linux', 'macos'], launch: p.launch, console: true, menu: true };
      if (p.install) body.install = p.install;
      await jobPair(`${rt} ${mode}`, body, { quickPlans: mode !== 'C' });
    }
  }
}

function pngOf(size, height = size) {
  // A square RGBA PNG with a gradient, made here (no decoder needed).
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
  await jobPair('icon, mode C', Object.assign({}, base, { mode: 'C', icon: { choice: 'custom', data: 'data:image/png;base64,' + png, filename: 'x.png', type: 'image/png' } }));
  const a = await jobPair('icon, mode A', Object.assign({}, base, { mode: 'A', icon: { data: png } }), { quickPlans: true });
  const plain = await jobPair('no icon, mode A', Object.assign({}, base, { mode: 'A', name: 'Hello python (plain)' }), { quickPlans: true });
  if (a && plain) {
    ok(a.node.result.files[0].sha256 === plain.node.result.files[0].sha256 && /\nicon\t[0-9a-f]{64}\n/.test(a.recNode),
      'icon, mode A: the Windows file is our base untouched; the icon is only in the record');
  }
  const pngSha = sha(Buffer.from(png, 'base64'));
  const [ig, inode] = [await get(GO, '/icons/' + pngSha + '.png'), await get(NODE, '/icons/' + pngSha + '.png')];
  ok(ig.status === 200 && inode.status === 200 && ig.body.equals(inode.body) && ig.headers['content-type'] === inode.headers['content-type'] &&
    ig.headers['cache-control'] === inode.headers['cache-control'], '/icons/<sha256>.png: the stored upload, the same bytes and headers');
  await jobPair('icon by sha256 alone', Object.assign({}, base, { mode: 'C', platforms: ['linux'], icon: { sha256: pngSha } }), { quickPlans: true });
  await jobPair('icon by an unknown sha256', Object.assign({}, base, { mode: 'C', platforms: ['linux'], icon: { sha256: 'b'.repeat(64) } }), { quickPlans: true });
  await jobPair('icon not square', Object.assign({}, base, { mode: 'C', icon: { data: pngOf(64, 32).toString('base64') } }), { planOnly: true });
  // Versions.
  await jobPair('a version range', Object.assign({}, base, { mode: 'C', select: 'range', range: '>=3.8,<3.12', platforms: ['windows', 'linux'] }));
  await jobPair('a range matching nothing', Object.assign({}, base, { mode: 'C', select: 'range', range: '>=99' }));
  await jobPair('an exact version', Object.assign({}, base, { mode: 'B', select: 'exact', range: '3.8.10' }));
  await jobPair('asyncio', Object.assign({}, base, { mode: 'C', select: 'asyncio', platforms: ['windows'] }));
  await jobPair('a range matching nothing, offline', Object.assign({}, base, { mode: 'C', offline: true, select: 'range', range: '>=99', platforms: ['linux'] }));
  // Settings.
  await jobPair('settings', Object.assign({}, base, { mode: 'C', console: false, menu: false, desktop: true, root: 'all', rootname: 'myapps',
    platforms: ['macos', 'windows'], name: 'Settings test', install: 'pip install .', launch: '{runtime} -m hello --flag' }));
  await jobPair('empty install: the policy picks', Object.assign({}, base, { mode: 'C', files: { 'hello/__main__.py': 'print(1)\n', 'requirements.txt': 'six\n' }, platforms: ['linux'] }));
  await jobPair('PHP composer.json: unsupported', Object.assign({}, base, { runtime: 'php', mode: 'C', files: { 'composer.json': '{}', 'index.php': '<?php echo 1;' }, platforms: ['linux'] }), { planOnly: true });
  // Packages.
  await jobPair('package, version given', Object.assign({}, base, { mode: 'C', source: { kind: 'package', value: 'requests', version: '2.32.3' }, files: null, platforms: ['linux'], launch: '' }));
  await jobPair('package, newest', Object.assign({}, base, { mode: 'A', source: { kind: 'package', value: 'Requests' }, files: null, launch: '' }), { quickPlans: true });
  await jobPair('npm package with a program', { name: '', source: { kind: 'package', value: 'cowsay' }, runtime: 'node', mode: 'C', platforms: ['linux'] });
  await jobPair('npm scoped package', { name: '', source: { kind: 'package', value: '@angular/cli', version: '17.3.8' }, runtime: 'node', mode: 'C', platforms: ['windows'] });
  await jobPair('crates.io package', { name: '', source: { kind: 'package', value: 'ripgrep' }, runtime: 'rust', mode: 'C', platforms: ['linux'] });
  await jobPair('Go module', { name: '', source: { kind: 'package', value: 'golang.org/x/example/hello' }, runtime: 'go', mode: 'C', platforms: ['linux'] });
  await jobPair('package the registry doesn\'t know', { name: '', source: { kind: 'package', value: 'this-package-does-not-exist-ib-oracle-4711' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  await jobPair('package version the registry doesn\'t know', { name: '', source: { kind: 'package', value: 'requests', version: '0.0.0.0.1' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  // GitHub and URL sources.
  await jobPair('GitHub source', { name: 'GitHub test', source: { kind: 'github', value: 'https://github.com/octocat/Hello-World.git' }, runtime: 'python', mode: 'C', platforms: ['linux', 'macos'], launch: '{runtime} -c "print(1)"' });
  await jobPair('GitHub source at a ref', { name: 'GitHub ref', source: { kind: 'github', value: 'octocat/Hello-World', ref: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' }, runtime: 'python', mode: 'A', launch: '{runtime} -c "print(1)"' }, { quickPlans: true });
  await jobPair('GitHub repo that doesn\'t exist', { name: 'x', source: { kind: 'github', value: 'octocat/this-repo-does-not-exist-4711' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  await jobPair('URL source', { name: '', source: { kind: 'url', value: 'https://codeload.github.com/octocat/Hello-World/tar.gz/7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' }, runtime: 'python', mode: 'C', platforms: ['linux'], launch: '{runtime} -c "print(1)"' });
  await jobPair('URL source that isn\'t a .tar.gz', { name: 'x', source: { kind: 'url', value: 'https://raw.githubusercontent.com/octocat/Hello-World/master/README' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  await jobPair('URL source that answers 404', { name: 'x', source: { kind: 'url', value: 'https://codeload.github.com/octocat/this-repo-does-not-exist-4711/tar.gz/main' }, runtime: 'python', mode: 'C', platforms: ['linux'] });
  // Offline: the signed plan and every download packed.
  if (!QUICK) {
    await jobPair('offline, mode C', Object.assign({}, base, { mode: 'C', offline: true, select: 'exact', range: '3.8.10', platforms: ['windows', 'linux', 'macos'] }));
    await jobPair('offline with an icon, mode B', Object.assign({}, base, { mode: 'B', offline: true, select: 'exact', range: '3.8.10', platforms: ['windows', 'linux'], icon: { data: png } }));
  }
}

/* ---------- 4. takedown ---------- */

async function takedown(sample) {
  console.log('\n# Takedown');
  if (!GO_DATA) { console.log('(skipped: no --go-data)'); return; }
  const files = [path.join(GO_DATA, 'takedown.txt'), path.join(NODE_DATA, 'takedown.txt')];
  const saved = files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
  const p = projects.python;
  // A record both servers store: a plan by name (the same bytes on both when
  // the public URLs match).
  const name = await get(GO, '/api/plan/name/python/six');
  const nameNode = await get(NODE, '/api/plan/name/python/six');
  const rec = name.headers['x-ib-record'];
  const recNode = nameNode.headers['x-ib-record'];
  const srcSha = sample ? /^source\tinline\t(\S+)/m.exec(sample.recGo)[1] : 'c'.repeat(64);
  const entries = ['# oracle test entries', 'source github oracle-owner/oracle-repo', 'source package attrs', 'record ' + rec, 'record ' + recNode, 'sha ' + srcSha, 'sha ' + 'd'.repeat(64)];
  try {
    for (const f of files) fs.writeFileSync(f, (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '') + entries.join('\n') + '\n');
    const [ta, tb] = [await get(GO, '/api/takedown'), await get(NODE, '/api/takedown')];
    ok(ta.text === tb.text.split(recNode).join(rec), '/api/takedown: the same list', ta.text + tb.text);
    for (const v of ['oracle-owner/oracle-repo', 'Oracle-Owner/Oracle-Repo', 'https://github.com/oracle-owner/oracle-repo.git', 'http://github.com/Oracle-Owner/oracle-repo/', ' oracle-owner/oracle-repo ']) {
      const body = JSON.stringify({ name: 'x', source: { kind: 'github', value: v }, runtime: 'python', mode: 'C' });
      const [a, b] = [await post(GO, '/api/jobs', body), await post(NODE, '/api/jobs', body)];
      ok(a.status === 451 && a.status === b.status && a.text === b.text, `takedown: source github ${JSON.stringify(v)}: 451`, a.text + b.text);
    }
    {
      const body = JSON.stringify({ name: 'x', source: { kind: 'package', value: 'Attrs' }, runtime: 'python', mode: 'C' });
      const [a, b] = [await post(GO, '/api/jobs', body), await post(NODE, '/api/jobs', body)];
      ok(a.status === 451 && a.status === b.status && a.text === b.text, 'takedown: source package Attrs (normalised): 451', a.text + b.text);
      const [x, y] = [await get(GO, '/api/plan/name/python/attrs'), await get(NODE, '/api/plan/name/python/attrs')];
      ok(x.status === 451 && x.status === y.status && x.text === y.text, 'takedown: the plan by name for a taken-down package: 451', x.text + y.text);
    }
    for (const u of ['/api/records/', '/api/plan/', '/dl/']) {
      const [x, y] = [await get(GO, u + rec + (u === '/dl/' ? '/f.exe' : '')), await get(NODE, u + recNode + (u === '/dl/' ? '/f.exe' : ''))];
      ok(x.status === 451 && x.status === y.status && x.text === y.text, `takedown: ${u}<record>: 451`, x.text + y.text);
    }
    {
      const [x, y] = [await get(GO, '/api/plan/name/python/six'), await get(NODE, '/api/plan/name/python/six')];
      ok(x.status === 451 && x.status === y.status && x.text === y.text, 'takedown: the plan by name for a taken-down record: 451', x.text + y.text);
    }
    if (sample) {
      const [x, y] = [await get(GO, '/src/' + srcSha + '.tar.gz'), await get(NODE, '/src/' + srcSha + '.tar.gz')];
      ok(x.status === 451 && x.status === y.status && x.text === y.text, 'takedown: sha <sha256> refuses the stored source: 451', x.text + y.text);
    }
    {
      const [x, y] = [await get(GO, '/icons/' + 'd'.repeat(64) + '.png'), await get(NODE, '/icons/' + 'd'.repeat(64) + '.png')];
      ok(x.status === 451 && x.status === y.status && x.text === y.text, 'takedown: sha <sha256> refuses the icon: 451', x.text + y.text);
    }
    if (sample) {
      // A job whose written source hashes to a taken-down sha fails.
      const body = { name: 'Hello python', project: p.project, source: { kind: 'inline' }, files: p.files, runtime: 'python', mode: 'C', platforms: ['linux'], launch: p.launch };
      const r = await both(body);
      ok(r.go.job.status === 'failed' && r.go.job.error === 'this source has been taken down', 'takedown: Go refuses a job whose source hash is listed', JSON.stringify(r.go.job.error));
      note('Takedown by `sha` of an inline source can only be checked on each server with its own archive hash (the gzip differs): Go\'s is listed, so Go refuses the job and Node builds it.');
    }
  } finally {
    files.forEach((f, i) => { if (saved[i] === null) fs.rmSync(f, { force: true }); else fs.writeFileSync(f, saved[i]); });
  }
  const after = await get(GO, '/api/takedown');
  ok(after.text === (saved[0] === null ? '{"entries":null}\n' : after.text), 'takedown: Go\'s list is back as it was');
}

/* ---------- 5. rate limits ---------- */

async function rateLimits() {
  console.log('\n# Rate limits (last: they use up this address\'s minute)');
  await sleep(61000);   // both windows empty
  for (const [label, n, fn] of [
    ['plans by name: 30 a minute', 31, (base) => raw(base, '/api/plan/name/zig/x')],
    ['relay and tsa: 30 a minute', 31, (base) => raw(base, '/api/relay?url=x')],
    ['jobs: 20 a minute', 21, (base) => raw(base, '/api/jobs', { method: 'POST', body: '{' })],
  ]) {
    const codes = { go: [], node: [] };
    for (let i = 0; i < n + 1; i++) {
      codes.go.push((await fn(GO)).status);
      codes.node.push((await fn(NODE)).status);
    }
    const g = codes.go.join(','), m = codes.node.join(',');
    ok(g === m && codes.go.indexOf(429) === n - 1, `${label}: call ${n} is refused, on both`, `go   ${g}\nnode ${m}`);
  }
  const [a, b] = [await raw(GO, '/api/jobs', { method: 'POST', body: '{' }), await raw(NODE, '/api/jobs', { method: 'POST', body: '{' })];
  ok(a.text === b.text && a.status === 429, 'the 429 answer', a.text + b.text);
}

/* ---------- run ---------- */

const pg = (await get(GO, '/api/plan/name/python/requests'));
const pn = (await get(NODE, '/api/plan/name/python/requests'));
pubGo = /^backend\t(.*)$/m.exec((await get(GO, '/api/records/' + pg.headers['x-ib-record'])).text)[1];
pubNode = /^backend\t(.*)$/m.exec((await get(NODE, '/api/records/' + pn.headers['x-ib-record'])).text)[1];
console.log(`Go ${GO} (public ${pubGo}), Node ${NODE} (public ${pubNode})` + (samePublic() ? '' : ': different public URLs, Node\'s is normalised to Go\'s'));
await fixed();
await badRequests();
await jobs();
await moreJobs();
const sample = await jobPair('sample for the takedown checks', { name: 'Hello python', project: projects.python.project, source: { kind: 'inline' }, files: projects.python.files, runtime: 'python', mode: 'C', platforms: ['linux'], launch: projects.python.launch }, { planOnly: true });
await takedown(sample);
await rateLimits();

console.log(`\n${passed} passed, ${failed} failed`);
if (failures.length) console.log('Failed:\n  ' + failures.join('\n  '));
if (notes.length) console.log('\nExpected differences (not failures):\n- ' + notes.join('\n- '));
process.exit(failed ? 1 : 0);
