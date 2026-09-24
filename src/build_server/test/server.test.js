// The server end to end: routes, errors, CORS, a job through the queue,
// plans, downloads and the takedown list. Needs Redis (127.0.0.1:6390, or
// TI_TEST_REDIS) and takes a database of its own with
// helpers.js claimRedisDb, which claims one that no other run holds and
// removes its ti:* and ti-bull:* keys afterwards. It used to be a fixed
// number, which kept this suite apart from form.test.js but not from a
// second run of itself: two concurrent `npm test`s flushed each other's
// keys and failed in whichever subtest was unlucky. TI_TEST_REDIS_DB
// still pins one. Skipped without Redis or the runtime catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import IORedis from 'ioredis';
import { Server, parseFlags } from '../server.js';
import { verify, verifyFor } from '../lib/plansig.js';
import { resolve, setRevoked } from '../../shared/resolve.js';
import { readInstaller } from '../../shared/tifile.js';
import { haveCatalog, haveBases, tmpDir, claimRedisDb, REPO, RUNTIMES } from './helpers.js';

const REDIS = process.env.TI_TEST_REDIS || '127.0.0.1:6390';
const PINNED = process.env.TI_TEST_REDIS_DB;

function reachable(addr) {
  const i = addr.lastIndexOf(':');
  return new Promise((resolve) => {
    const s = net.connect(Number(addr.slice(i + 1)), addr.slice(0, i), () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

const skip = !haveCatalog ? 'no runtime catalogue' : !haveBases ? 'no bases' : !(await reachable(REDIS)) ? 'no Redis at ' + REDIS : false;

function req(port, p, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { const b = Buffer.concat(c); resolve({ status: res.statusCode, headers: res.headers, body: b, text: b.toString() }); });
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('the server', { skip }, async (t) => {
  const data = tmpDir(t);
  const site = tmpDir(t);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>');
  fs.mkdirSync(path.join(site, 'web', 'css'), { recursive: true });
  fs.writeFileSync(path.join(site, 'web', 'css', 'a.css'), 'body{}');
  const DB = await claimRedisDb(t, IORedis, REDIS, PINNED);
  const o = parseFlags(['-redis', REDIS, '-redis-db', String(DB), '-data', data, '-site', site, '-public', 'http://127.0.0.1:1', '-workers', '1',
    // Its own key. Without this the server falls back to defaultKeyDir(),
    // so this suite signed with whatever real key the machine had, and on a
    // machine with none it made one there and left it behind.
    '-keys', tmpDir(t)]);
  o.log = () => {};
  // This suite signs with a throwaway key on purpose, so the repository's
  // pin cannot apply to it. TI_PIN_FILE= is what turns the pin off for
  // exactly that case, as the engine's own test scripts already do --
  // `-keys` used to imply it, which meant pointing a real server at a
  // different key directory silently switched off the check that says the
  // key is the one every installer in the field expects.
  const pinWas = process.env.TI_PIN_FILE;
  process.env.TI_PIN_FILE = '';
  t.after(() => { if (pinWas === undefined) delete process.env.TI_PIN_FILE; else process.env.TI_PIN_FILE = pinWas; });
  const s = new Server(o);
  await s.init();
  s.serveWorkers();
  const srv = http.createServer(s.handler());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  // The keys go with the claim: claimRedisDb registered the cleanup.
  t.after(async () => {
    srv.close();
    await s.q.close();
  });
  const get = (p, opt) => req(port, p, opt);
  const json = async (p, opt) => { const r = await get(p, opt); return { status: r.status, j: JSON.parse(r.text), r }; };

  await t.test('health, pubkey, runtimes', async () => {
    const h = await json('/api/health');
    assert.equal(h.status, 200);
    assert.deepEqual(Object.keys(h.j), ['ok', 'queues', 'time', 'version', 'workers']);
    assert.deepEqual(h.j.queues, { build: 0, pack: 0, record: 0 });
    const pk = await json('/api/pubkey');
    assert.equal(pk.j.alg, 'ed25519');
    assert.equal(pk.j.key, fs.readFileSync(path.join(data, 'plan-signing-key.pub'), 'utf8').trim());
    assert.equal(pk.r.headers['cache-control'], 'no-store');
    const rt = await json('/api/catalog/runtimes');
    assert.ok(rt.j.runtimes.some((x) => x.id === 'python'));
    assert.equal(rt.r.headers['cache-control'], 'public, max-age=300');
  });

  // The pair a saved copy of the page refreshes its catalogue from: the
  // catalogue as one file, and the signed statement about it. Together
  // they are the only way the page will take a catalogue off the network
  // and then build installers from it, so what matters is that both are
  // served, that the statement is about the file actually served, and
  // that it is signed by this server's plan key. The catalogue here is a
  // few bytes rather than the real one: these two routes serve a file and
  // say nothing about what is in it, and the page's own checks are driven
  // against a real catalogue in tests/catalog-refresh-test.mjs.
  await t.test('catalogue archive and attestation', async () => {
    const arc = Buffer.from('a stand-in for catalog.gz; these routes serve bytes\n');
    fs.writeFileSync(path.join(data, 'catalog.gz'), arc);
    fs.mkdirSync(path.join(data, 'rtscripts'), { recursive: true });
    const hash = crypto.createHash('sha256').update(arc).digest('hex');
    const doc = 'ti-catalog-attest\t1\nissued\t2026-09-23T00:00:00Z\nsha256\t' + hash + '\nbytes\t' + arc.length + '\n';
    fs.writeFileSync(path.join(data, 'rtscripts', 'catalog.txt'), s.signer.signStringAs('ti-catalog-attest', doc));

    const att = await get('/api/catalog/attest');
    const got = await get('/api/catalog/archive');
    assert.equal(att.status, 200);
    assert.equal(got.status, 200);
    assert.equal(att.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(got.headers['content-type'], 'application/gzip');
    assert.ok(got.body.equals(arc), 'the archive is served byte for byte');

    const said = (att.text.split('\n').find((l) => l.startsWith('sha256\t')) || '').split('\t')[1];
    assert.equal(crypto.createHash('sha256').update(got.body).digest('hex'), said,
      'the archive served is the one the statement is about');

    const sig = (att.text.trimEnd().split('\n').pop() || '').split('\t');
    assert.equal(sig[0], 'sig');
    assert.equal(sig[1], 'ed25519');
    const signed = att.text.slice(0, att.text.lastIndexOf('\nsig\t') + 1);
    const pub = Buffer.from(fs.readFileSync(path.join(data, 'plan-signing-key.pub'), 'utf8').trim(), 'base64');
    const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pub]), format: 'der', type: 'spki' });
    assert.ok(crypto.verify(null, Buffer.from(signed, 'utf8'), key, Buffer.from(sig[2], 'base64')),
      "and it is signed by this server's plan key");

    // A server deployed without a catalogue says so, rather than serving
    // something else or failing in a way the page reads as a bad answer.
    fs.rmSync(path.join(data, 'catalog.gz'));
    assert.equal((await get('/api/catalog/archive')).status, 404);
  });

  await t.test('CORS and methods', async () => {
    const o1 = await get('/api/jobs', { method: 'OPTIONS' });
    assert.equal(o1.status, 204);
    assert.equal(o1.headers['access-control-allow-origin'], '*');
    assert.equal(o1.headers['access-control-allow-methods'], 'GET, POST, OPTIONS');
    const e = await get('/nothing');
    assert.equal(e.headers['access-control-allow-origin'], '*');
    const m = await get('/api/health', { method: 'POST' });
    assert.equal(m.status, 405);
    assert.equal(m.headers.allow, 'GET, HEAD');
  });

  await t.test('no listings; the site only; clean paths', async () => {
    assert.equal((await get('/')).text, '<!doctype html><title>t</title>');
    assert.equal((await get('/tiddlyinstall.html')).text, '<!doctype html><title>t</title>',
      '/tiddlyinstall.html is the page itself, under the name it saves as');
    assert.equal((await get('/tiddlyinstall.html')).status, 200, 'served, not redirected');
    assert.equal((await get('/web/css/a.css')).text, 'body{}');
    for (const p of ['/web/css/', '/css/a.css', '/mirror/', '/src/', '/mirror/python/', '/README.md', '/server/policy.json', '/server/data/plan-signing-key.pem']) assert.equal((await get(p)).status, 404, p);
    const r1 = await get('/index.html');
    assert.deepEqual([r1.status, r1.headers.location], [301, './']);
    const r2 = await get('/mirror');
    assert.deepEqual([r2.status, r2.headers.location], [301, '/mirror/']);
    const r3 = await get('/a/../api/health');
    assert.deepEqual([r3.status, r3.headers.location], [301, '/api/health']);
    if (fs.existsSync(path.join(RUNTIMES, 'python'))) {
      const r4 = await get('/mirror/python');
      assert.deepEqual([r4.status, r4.headers.location], [301, 'python/']);
    }
  });

  await t.test('bad requests', async () => {
    const post = (b) => json('/api/jobs', { method: 'POST', body: b });
    assert.deepEqual((await post('{')).j, { code: 'bad_json', error: 'the request isn\'t valid JSON' });
    // Over 4 MB: read up to the limit (so not valid JSON), and the connection closed.
    const big = await get('/api/jobs', { method: 'POST', body: JSON.stringify({ files: { a: 'x'.repeat(5 << 20) } }) });
    assert.deepEqual([big.status, JSON.parse(big.text).code, big.headers.connection], [400, 'bad_json', 'close']);
    assert.deepEqual((await post('{"runtime":"python","mode":"D"}')).j, { code: 'invalid', error: 'mode must be A, B or C' });
    const ctl = await post(JSON.stringify({ runtime: 'python', mode: 'C', name: 'a' + String.fromCharCode(0x202e) + 'b', source: { kind: 'inline' }, files: { a: 'b' } }));
    assert.equal(ctl.j.error, 'fields can\'t contain control or text-direction characters');
    assert.equal((await json('/api/records/xyz')).j.code, 'bad_hash');
    assert.equal((await json('/api/plan/' + 'a'.repeat(26))).status, 404);
    assert.equal((await json('/api/jobs/j_nothing')).status, 404);
    assert.equal((await json('/api/relay?url=' + encodeURIComponent('http://127.0.0.1/'))).j.code, 'not_in_catalogue');
    assert.equal((await json('/api/tsa?name=evil', { method: 'POST', body: '0' })).j.code, 'not_allowed');
    assert.equal((await json('/api/tsa?name=digicert', { method: 'POST', body: 'hello' })).j.code, 'bad_request');
    assert.equal((await json('/api/plan/name/zig/foo')).j.code, 'no_registry');
    assert.equal((await json('/api/plan/name/node/%40a%2Fb')).j.code, 'invalid');
  });

  await t.test('a job: ticket, record, plan, files, takedown', async () => {
    const body = { name: 'Hello', project: 'hello', runtime: 'python', mode: 'C', platforms: ['linux'], source: { kind: 'inline' },
      files: { 'hello/__main__.py': "print('hello from python')\n" }, launch: '{runtime} -m hello' };
    const a = await json('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(a.status, 202);
    assert.deepEqual(Object.keys(a.j), ['class', 'error', 'eta_seconds', 'id', 'position', 'progress', 'status', 'ticket']);
    assert.equal(a.j.class, 'build');
    let j = a.j;
    while (j.status !== 'done' && j.status !== 'failed') {
      await new Promise((r) => setTimeout(r, 200));
      j = (await json('/api/jobs/' + j.id)).j;
    }
    assert.equal(j.status, 'done', j.error);
    const hash = j.result.record;
    const rec = (await get('/api/records/' + hash)).text;
    assert.match(rec, /^ti-record\t1\nname\tHello\n/);
    const plan = (await get('/api/plan/' + hash)).text;
    verifyFor(s.signer.pub, Buffer.from(plan), hash);
    // Every plan says when it was made and how long a carried copy may be
    // used (design.md 7.1), inside the signature.
    assert.match(plan, /^signed\t\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/m);
    assert.match(plan, /^maxage\t7776000$/m);
    // A nonce is echoed into the signed bytes, and is the only change.
    const nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const np = (await get('/api/plan/' + hash + '?nonce=' + nonce)).text;
    verifyFor(s.signer.pub, Buffer.from(np), hash);
    assert.equal(np.split('\n')[1], 'request\tnonce\t' + nonce);
    const line = 'request\tnonce\t' + nonce + '\n';
    const bare = (x) => x.replace(/^signed\t.*\n/m, '').replace(/sig\ted25519\t\S+\n$/, '');
    assert.equal(bare(np.replace(line, '')), bare(plan));
    assert.equal((await json('/api/plan/' + hash + '?nonce=abc')).j.code, 'invalid');
    assert.equal((await json('/api/plan/' + hash + '?nonce=' + 'g'.repeat(32))).status, 400);
    const f = j.result.files[0];
    assert.equal(f.url, '/dl/' + hash + '/install_python_hello.run');
    const d = await get(f.url);
    assert.equal(d.headers['content-disposition'], 'attachment; filename="install_python_hello.run"');
    assert.equal((await readInstaller(new Uint8Array(d.body), f.name)).record, rec);
    const part = await get(f.url, { headers: { Range: 'bytes=0-9' } });
    assert.deepEqual([part.status, part.body.length, part.headers['content-range']], [206, 10, 'bytes 0-9/' + f.size]);
    // The ETA has history now.
    const again = await json('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(typeof again.j.eta_seconds, 'number');
    // A withdrawn build is a build that does not exist (design.md 7.1):
    // the plan names another one rather than one the installer would
    // refuse. And the bytes it serves are exactly what the shared
    // resolver writes from the same list -- the page's rule, the page's
    // data, no server-only step in between.
    {
      const was = /^file\t\S+\t\S+\t([0-9a-f]{64})\t/m.exec(plan)[1];
      fs.writeFileSync(path.join(data, 'takedown.txt'), 'file ' + was + '\n');
      assert.deepEqual(s.revokedFiles(), [was]);
      const p2 = (await get('/api/plan/' + hash)).text;
      verifyFor(s.signer.pub, Buffer.from(p2), hash);
      assert.ok(!p2.includes(was), 'the withdrawn build is still in the plan');
      // A plan can already have targets nothing runs on (old glibc, ARM64
      // Windows); only a fail this withdrawal caused counts.
      const fails = (t) => t.split('\n').filter((l) => l.startsWith('fail\t'));
      assert.deepEqual(fails(p2).filter((l) => !fails(plan).includes(l)), []);
      const { app } = await s.b.loadApp(hash);
      setRevoked(s.cat, s.revokedFiles());
      const mine = resolve(s.cat, Object.assign({}, app, { signedAt: /^signed\t(\S+)$/m.exec(p2)[1] }));
      assert.equal(mine, p2.replace(/sig\ted25519\t\S+\n$/, ''));
      setRevoked(s.cat, []);
      fs.rmSync(path.join(data, 'takedown.txt'));
    }
    // The takedown list, read on every request.
    const src = /^source\tinline\t(\S+)$/m.exec(rec)[1];
    fs.writeFileSync(path.join(data, 'takedown.txt'), '# test\nrecord ' + hash + '\nsha ' + src + '\nsource github a/b\n');
    for (const p of ['/api/records/' + hash, '/api/plan/' + hash, f.url, '/src/' + src + '.tar.gz']) assert.equal((await get(p)).status, 451, p);
    const td = await json('/api/jobs', { method: 'POST', body: JSON.stringify({ runtime: 'python', mode: 'C', source: { kind: 'github', value: 'https://github.com/A/B.git' } }) });
    assert.deepEqual([td.status, td.j.code], [451, 'taken_down']);
    assert.deepEqual((await json('/api/takedown')).j.entries, ['record ' + hash, 'sha ' + src, 'source github a/b']);

    // A source entry on its own, naming this record's actual source, and
    // carrying a reason after the key. Until 2026-09-24 it reached only
    // acceptJob: the installer already built from that source went on
    // being served and fresh plans went on being signed for it, while
    // takedown.mjs printed "ok (added)". The reason made it worse -- the
    // list was matched whole-line, so an entry an operator wrote a note
    // on matched nothing at all.
    fs.writeFileSync(path.join(data, 'takedown.txt'), 'source inline ' + src + '\treported 2026-09-24\n');
    for (const p of ['/api/records/' + hash, '/api/plan/' + hash, f.url]) {
      assert.equal((await get(p)).status, 451, 'source-only takedown should reach ' + p);
    }
    fs.rmSync(path.join(data, 'takedown.txt'));
  });

  await t.test('the signed revocation list', async () => {
    const entries = ['record tjfq5rqwnnrxk3m9q2x7v4p8ab', 'source github a/b', 'file ' + 'c'.repeat(64)];
    fs.writeFileSync(path.join(data, 'takedown.txt'), '# a comment\n\n' + entries.join('\n') + '\n');
    const r = await get('/api/revocations');
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['cache-control'], 'public, max-age=300');
    const doc = r.text;
    // Signed with the plan key, as a ti-revocations and not as a plan.
    const msg = verify(s.signer.pub, Buffer.from(doc), 'ti-revocations').toString('utf8');
    assert.throws(() => verify(s.signer.pub, Buffer.from(doc)), /not a ti-plan/);
    const lines = msg.split('\n');
    assert.equal(lines[0], 'ti-revocations\t1');
    assert.match(lines[1], /^issued\t\d{4}-\d\d-\d\dT\d\d:00:00Z$/);
    assert.match(lines[2], /^expires\t\d{4}-\d\d-\d\dT\d\d:00:00Z$/);
    assert.match(lines[3], /^serial\t\d+$/);
    assert.deepEqual(lines.slice(4).filter(Boolean), entries.map((e) => 'revoke\t' + e.split(' ').join('\t')));
    // The same bytes for the same list within the hour.
    assert.equal((await get('/api/revocations')).text, doc);
    // `file <sha256>` reaches a stored file, as `sha` does.
    assert.equal((await get('/src/' + 'c'.repeat(64) + '.tar.gz')).status, 451);
    fs.rmSync(path.join(data, 'takedown.txt'));
    // No list at all is still a signed document that says nothing.
    const empty = (await get('/api/revocations')).text;
    verify(s.signer.pub, Buffer.from(empty), 'ti-revocations');
    assert.ok(!empty.includes('revoke\t'), empty);
  });
});
