// Plain form posts and the pages for browsers that can't run the page
// (docs/api.md "Plain form posts"): the body parsers, js/form-job.js against
// new.html, the pages' escaping and markup, and the server end to end
// (POST /submit, GET /status/<id>, GET /classic). The server part needs
// Redis like server.test.js, on its own database (IB_TEST_FORM_REDIS_DB,
// default 6), whose ib:* and ib-bull:* keys it removes afterwards.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import IORedis from 'ioredis';
import { Server, parseFlags } from '../server.js';
import { Limiter } from '../lib/limiter.js';
import { parseForm, parseUrlencoded, parseMultipart, boundaryOf, BadForm } from '../lib/form.js';
import { esc, statusPage, classicPage, refusedPage, page } from '../lib/pages.js';
import { jobFromForm, postedForm, TEMPLATE_FILES, ENTRY_DEFAULTS, parseSource } from '../../js/form-job.js';
import { readInstaller, recordHash } from '../../js/ibfile.js';
import { haveCatalog, haveBases, tmpDir, REPO } from './helpers.js';

const REDIS = process.env.IB_TEST_REDIS || '127.0.0.1:6390';
const DB = Number(process.env.IB_TEST_FORM_REDIS_DB || 6);
const NEW_HTML = fs.readFileSync(path.join(REPO, 'new.html'), 'utf8');
const HOSTILE = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>&amp;';
const BAD_FILE = '<img src=x onerror=alert(2)>"\'&.exe';

/* ---------- a multipart body, as a browser writes one ---------- */

function multipart(parts, boundary = '---------------------------7d93b2a1f0e4c') {
  const chunks = [];
  for (const p of parts) {
    let h = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + p.name + '"';
    if (p.filename !== undefined) h += '; filename="' + p.filename + '"\r\nContent-Type: ' + (p.type || 'application/octet-stream');
    chunks.push(Buffer.from(h + '\r\n\r\n'), Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(chunks), type: 'multipart/form-data; boundary=' + boundary };
}

// A w x w RGBA PNG, one colour.
function png(w) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([200, 60, 20, 255], y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- the parsers ---------- */

test('urlencoded bodies', () => {
  const { fields } = parseUrlencoded(Buffer.from('a=1&b=x+y%20z&a=2&c=%E2%9C%93&empty=&odd=%zz'));
  assert.deepEqual(fields.a, ['1', '2']);
  assert.deepEqual(fields.b, ['x y z']);
  assert.deepEqual(fields.c, ['\u2713']);
  assert.deepEqual(fields.empty, ['']);
  assert.deepEqual(fields.odd, ['%zz']);
  assert.equal(Object.getPrototypeOf(parseUrlencoded(Buffer.from('__proto__=1')).fields), null);
  assert.throws(() => parseUrlencoded(Buffer.from(Array.from({ length: 2001 }, (_, i) => 'k' + i + '=1').join('&'))), BadForm);
});

test('multipart bodies', () => {
  const icon = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
  const m = multipart([
    { name: 'app_name', value: 'Caf\u00e9 \u2713' },
    { name: 'code', value: 'a\r\nb\r\n' },
    { name: 'icon', filename: 'C:\\Documents and Settings\\me\\My Documents\\logo.png', type: 'image/png', value: icon },
    { name: 'win_cert', filename: 'secret.pfx', value: 'KEY' },
    { name: 'empty', filename: '', value: '' },
  ]);
  const { fields, files } = parseForm(m.type, m.body, { keepFiles: ['icon', 'empty'] });
  assert.deepEqual(fields.app_name, ['Caf\u00e9 \u2713']);
  assert.deepEqual(fields.code, ['a\r\nb\r\n']);
  assert.equal(files.icon.filename, 'logo.png');   // old IE sends the whole path
  assert.equal(files.icon.type, 'image/png');
  assert.deepEqual(files.icon.data, icon);
  assert.equal(files.win_cert, undefined, 'file parts not asked for are dropped');
  assert.equal(files.empty.data.length, 0);
  assert.equal(boundaryOf('multipart/form-data; boundary="a b"'), 'a b');
  assert.equal(boundaryOf('multipart/form-data'), null);
  // Truncated, no boundary, another type.
  assert.throws(() => parseMultipart(m.body.subarray(0, m.body.length - 60), '---------------------------7d93b2a1f0e4c'), /truncated/);
  assert.throws(() => parseForm('multipart/form-data', m.body), /boundary/);
  assert.throws(() => parseForm('multipart/form-data; boundary=zzz', m.body), /boundary/);
  assert.throws(() => parseForm('text/plain', Buffer.from('a=1')), (e) => e instanceof BadForm && e.unsupported);
});

/* ---------- js/form-job.js against new.html ---------- */

test('new.html: the form posts to the server, and names what the mapping reads', () => {
  const tag = /<form id="new-form"[^>]*>/.exec(NEW_HTML);
  assert.ok(tag, 'the form has id new-form');
  assert.match(tag[0], /\baction="submit"/);
  assert.match(tag[0], /\bmethod="post"/);
  assert.match(tag[0], /\benctype="multipart\/form-data"/);
  // Nothing secret goes in a plain post: file inputs other than the icon,
  // and the access token, have no name.
  for (const m of NEW_HTML.matchAll(/<input\b[^>]*\btype="(?:file|password)"[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0]);
    assert.ok(!name || name[1] === 'icon', 'a secret input with a name: ' + m[0]);
  }
  // Every template's textareas, with their file names (aria-label).
  const combos = {};
  for (const m of NEW_HTML.matchAll(/<div class="combo combo-([a-z]+)-([a-z]+)">([\s\S]*?)(?=<div class="combo |<\/section>|<div class="combo-actions)/g)) {
    const files = {};
    for (const t of m[3].matchAll(/<textarea class="code[^"]*" name="([^"]+)"[^>]*aria-label="([^"]+)"/g)) files[t[1]] = t[2];
    if (Object.keys(files).length) (combos[m[1]] = combos[m[1]] || {})[m[2]] = files;
  }
  assert.deepEqual(combos, TEMPLATE_FILES);
  // The launch fields' starting values.
  const entries = {};
  for (const m of NEW_HTML.matchAll(/<input type="text" class="entry entry-([a-z]+)"[^>]*\bname="entry_\1" value="([^"]*)"/g)) entries[m[1]] = m[2].replace(/&amp;/g, '&');
  assert.deepEqual(entries, ENTRY_DEFAULTS);
});

// A form's fields as the page has them at the start (new.html's defaults).
function defaults() {
  return {
    app_name: [''], source_kind: ['repo'], source: [''], runtime: ['python'], template: ['script'], rv_mode: ['newest'],
    runtime_version: [''], runtime_exact: [''], install_cmd: [''], ref_type: ['latest'], ref: [''], subdir: [''],
    target_windows: ['on'], target_linux: ['on'], target_macos: ['on'], mode: ['ours'], root: ['user'], rootname: ['ib'],
    shortcut_menu: ['on'], uninstaller: ['on'], cleanup_pkg_cache: ['on'], cleanup_tools: ['remove'], cleanup_fail: ['remove'],
    uninstall_data: ['ask'], icon_choice: ['default'], entry_python: [ENTRY_DEFAULTS.python], entry_node: [ENTRY_DEFAULTS.node],
    code_python_script: ['print("hi")\r\n'], win_unpre_script: [''], unix_unpre_script: [''], pf_url: [''],
  };
}

test('js/form-job.js: a plain post of the form reads as the page reads it', () => {
  const icon = { choice: 'default' };
  // GitHub, with a tag.
  let { job, problems } = jobFromForm(postedForm({ ...defaults(), source: [' https://github.com/psf/requests.git '], ref_type: ['tag'], ref: ['v2.0'] }), { icon });
  assert.deepEqual(problems, []);
  assert.deepEqual(job.source, { kind: 'github', value: 'psf/requests', ref: 'v2.0' });
  assert.equal(job.mode, 'A');
  assert.equal(job.offline, false);
  assert.deepEqual(job.platforms, ['windows', 'linux', 'macos']);
  assert.equal(job.launch, ENTRY_DEFAULTS.python);
  assert.equal(job.pack, undefined, 'mode A carries no pack');
  // Written here: CRLF from the browser becomes LF, and the launch command runs main.py.
  ({ job, problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], mode: ['unsigned'], offline: ['on'] }), { icon }));
  assert.deepEqual(problems, []);
  assert.deepEqual(job.files, { 'main.py': 'print("hi")\n' });
  assert.equal(job.launch, '{runtime} {app_dir}/main.py');
  assert.equal(job.mode, 'C');
  assert.equal(job.offline, true);
  assert.deepEqual(job.pack, { offline_include: 'all', offline_targets: [] });
  // An edited launch command is kept.
  ({ job } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], entry_python: ['{runtime} other.py'] }), { icon }));
  assert.equal(job.launch, '{runtime} other.py');
  // /classic: one launch field, empty for the default.
  const classic = { ...defaults() };
  delete classic.entry_python;
  ({ job } = jobFromForm(postedForm({ ...classic, source: ['requests'], launch: [''] }), { icon }));
  assert.equal(job.launch, '');
  assert.deepEqual(job.source, { kind: 'package', value: 'requests' });
  ({ job } = jobFromForm(postedForm({ ...classic, source: ['requests'], launch: [' x '], ref_type: ['tag'], ref: ['2.31.0'] }), { icon }));
  assert.equal(job.launch, 'x');
  assert.deepEqual(job.source, { kind: 'package', value: 'requests', version: '2.31.0' });
  assert.deepEqual(parseSource('https://example.com/a.zip', 'latest', ''), { kind: 'url', value: 'https://example.com/a.zip' });
  // What's missing, said as the page says it.
  const bare = { ...defaults() };
  delete bare.target_windows; delete bare.target_linux; delete bare.target_macos;
  ({ problems } = jobFromForm(postedForm({ ...bare, rv_mode: ['range'] }), { icon }));
  assert.deepEqual(problems, ['Pick at least one platform under "Build for".', 'Say what to package: a GitHub repo URL or a package name.',
    'Enter the versions allowed, or pick another "Which version" option.']);
  ({ problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], runtime: ['php'] }), { icon }));
  assert.match(problems[0], /template isn't available/);
});

/* ---------- the pages ---------- */

test('pages: escaped, HTML 4, no script, refresh only while under way', () => {
  assert.equal(esc(HOSTILE), '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&gt;&lt;img src=x onerror=alert(2)&gt;&amp;amp;');
  const view = (status, extra = {}) => ({ id: 'j_' + 'a'.repeat(18), ticket: 7, class: 'build', status, position: 2, eta_seconds: 95, progress: HOSTILE, error: null, ...extra });
  const req = { name: HOSTILE, mode: 'B' };
  const done = view('done', { result: { record: 'abcdefghijklmnopqrstuvwxyz', files: [
    { platform: 'windows', name: BAD_FILE, url: '/dl/abcdefghijklmnopqrstuvwxyz/' + BAD_FILE, size: 2048, sha256: 'f'.repeat(64), signed: '' },
    { platform: 'macos', name: HOSTILE + '.zip', url: '/dl/abcdefghijklmnopqrstuvwxyz/' + HOSTILE + '.zip', size: 2048, sha256: 'f'.repeat(64), signed: '' },
    { platform: 'linux', name: 'x.run', url: 'javascript:alert(1)', size: 10, sha256: 'e'.repeat(64), signed: HOSTILE },
  ] } });
  const pages = {
    queued: statusPage(view('queued'), req), running: statusPage(view('running'), req), done: statusPage(done, req),
    failed: statusPage(view('failed', { error: HOSTILE }), req), classic: classicPage([{ id: 'py"thon', label: HOSTILE, launch: HOSTILE }]),
    refused: refusedPage([HOSTILE]), plain: page({ title: HOSTILE, body: '' }),
  };
  for (const [k, h] of Object.entries(pages)) {
    assert.ok(!/<script|<img|href="javascript:/i.test(h), k + ': hostile text got through: ' + (/.{40}(<script|<img|href="javascript:).{40}/i.exec(h) || [''])[0]);
    assert.ok(h.startsWith('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"'), k + ': HTML 4.01');
    assert.ok(!/<(header|footer|main|nav|section|article|aside)\b/.test(h), k + ': no HTML5 elements');
    assert.ok(!/var\(--|:has\(|display:\s*(flex|grid)/.test(h), k + ': no CSS old IE needs and lacks');
  }
  assert.match(pages.queued, /<meta http-equiv="refresh" content="3">/);
  assert.match(pages.queued, /2 ahead of you/);
  assert.match(pages.queued, /About 2 minutes/);
  assert.match(pages.running, /<meta http-equiv="refresh" content="3">/);
  assert.ok(!/http-equiv="refresh"/.test(pages.done) && !/http-equiv="refresh"/.test(pages.failed), 'no refresh when finished');
  assert.match(pages.failed, /The build failed: &lt;script&gt;/);
  // The file link: escaped and percent-encoded; a url that isn't /dl/ gets no link.
  assert.ok(pages.done.includes('<a href="../dl/abcdefghijklmnopqrstuvwxyz/%3Cimg%20src%3Dx%20onerror%3Dalert(2)%3E%22&#39;%26.exe">&lt;img src=x'));
  // A name with a slash, or a url that isn't /dl/: no link.
  assert.match(pages.done, /<td>&lt;script&gt;alert\(1\)&lt;\/script&gt;[^<]*\.zip<\/td>/);
  assert.match(pages.done, /<td>x\.run<\/td>/);
  assert.match(pages.done, /href="\.\.\/api\/records\/abcdefghijklmnopqrstuvwxyz"/);
  assert.match(pages.done, /sign these files with your own certificate/);
  assert.match(pages.classic, /<option value="py&quot;thon">&lt;script&gt;/);
});

/* ---------- the server end to end ---------- */

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

test('the server: plain form posts and status pages', { skip }, async (t) => {
  const data = tmpDir(t);
  const site = tmpDir(t);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>');
  const o = parseFlags(['-redis', REDIS, '-redis-db', String(DB), '-data', data, '-site', site, '-public', 'http://127.0.0.1:1', '-workers', '1']);
  o.log = () => {};
  const s = new Server(o);
  await s.init();
  s.serveWorkers();
  const srv = http.createServer(s.handler());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  t.after(async () => {
    srv.close();
    await s.q.close();
    const r = new IORedis({ host: REDIS.split(':')[0], port: Number(REDIS.split(':')[1]), db: DB });
    for (const pat of ['ib:*', 'ib-bull:*']) {
      const keys = await r.keys(pat);
      if (keys.length) await r.del(...keys);
    }
    r.disconnect();
  });
  const get = (p, opt) => req(port, p, opt);
  const form = (fields) => get('/submit', { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const isPage = (r, status, what) => {
    assert.equal(r.status, status, what + ': ' + r.text.slice(0, 600));
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', what);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/, what);
  };
  // Follows a 303 to the status page until the build is done; returns the last page.
  const follow = async (r) => {
    assert.equal(r.status, 303, r.text.slice(0, 800));
    const loc = r.headers.location;
    assert.match(loc, /^status\/j_[0-9a-f]+$/);
    let p;
    for (let i = 0; i < 600; i++) {
      p = await get('/' + loc);
      isPage(p, 200, 'status');
      if (!/http-equiv="refresh"/.test(p.text)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    return { id: loc.slice(7), page: p.text };
  };
  const links = (html) => [...html.matchAll(/<a href="\.\.\/dl\/([^"]+)">/g)].map((m) => '/dl/' + m[1].replace(/&amp;/g, '&'));
  const code = 'print("hello from a plain form")\r\n';
  const base = { source_kind: 'write', runtime: 'python', template: 'script', code_python_script: code, mode: 'unsigned', rv_mode: 'newest',
    entry_python: ENTRY_DEFAULTS.python, target_linux: 'on', shortcut_menu: 'on', root: 'user', rootname: 'ib' };

  await t.test('/classic: the form, from the catalogue', async () => {
    const r = await get('/classic');
    isPage(r, 200, 'classic');
    assert.match(r.text, /<form action="submit" method="post" enctype="multipart\/form-data" accept-charset="utf-8">/);
    assert.match(r.text, /<option value="python" selected>/);
    for (const n of ['app_name', 'source', 'runtime', 'ref_type', 'ref', 'target_windows', 'mode', 'offline', 'rv_mode', 'install_cmd', 'launch', 'icon', 'root']) {
      assert.match(r.text, new RegExp('name="' + n + '"'), n);
    }
    assert.equal((await get('/classic', { method: 'HEAD' })).status, 200);
  });

  await t.test('urlencoded: 303, the status page, the files read back', async () => {
    const r = await form({ ...base, app_name: HOSTILE });
    const { id, page: html } = await follow(r);
    assert.ok(!/<script|<img/.test(html), 'the name is escaped');
    assert.match(html, /<h1>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Done/);
    const j = JSON.parse((await get('/api/jobs/' + id)).text);
    assert.equal(j.status, 'done', j.error);
    const dl = links(html);
    assert.deepEqual(dl, j.result.files.map((f) => f.url.replace(/[^/]+$/, (n) => encodeURIComponent(n))));
    const rec = (await get('/api/records/' + j.result.record)).text;
    assert.match(rec, /\nlaunch\t\{runtime\} \{app_dir\}\/main\.py\n/);
    const d = await get(dl[0]);
    assert.equal(d.status, 200);
    const info = await readInstaller(new Uint8Array(d.body), j.result.files[0].name);
    assert.equal(info.record, rec);
    assert.equal(await recordHash(info.record), j.result.record);
    // CRLF as sent became LF, as the page reads a textarea.
    const queued = await s.q.get(id);
    assert.deepEqual(queued.request.files, { 'main.py': code.replace(/\r\n/g, '\n') });
    assert.match(html, new RegExp('href="\\.\\./api/records/' + j.result.record + '"'));
  });

  await t.test('the same form as JSON makes the same record (but its time)', async () => {
    const a = await follow(await form({ ...base, app_name: 'Same' }));
    const ja = JSON.parse((await get('/api/jobs/' + a.id)).text);
    const { job } = jobFromForm(postedForm(Object.fromEntries(Object.entries({ ...base, app_name: 'Same' }).map(([k, v]) => [k, [v]]))), { icon: { choice: 'default' } });
    let jb = JSON.parse((await get('/api/jobs', { method: 'POST', body: JSON.stringify(job) })).text);
    while (jb.status !== 'done' && jb.status !== 'failed') { await new Promise((r) => setTimeout(r, 100)); jb = JSON.parse((await get('/api/jobs/' + jb.id)).text); }
    // The records match but for when each was made.
    const rec = async (h) => (await get('/api/records/' + h)).text.replace(/^created\t.*\n/m, '');
    assert.equal(await rec(jb.result.record), await rec(ja.result.record));
  });

  await t.test('multipart, with an icon', async () => {
    const icon = png(32);
    const m = multipart([...Object.entries({ ...base, app_name: 'Iconic', mode: 'yours' }).map(([name, value]) => ({ name, value })),
      { name: 'icon', filename: 'C:\\pics\\logo.png', type: 'image/png', value: icon }]);
    const { id, page: html } = await follow(await get('/submit', { method: 'POST', body: m.body, headers: { 'Content-Type': m.type } }));
    const j = JSON.parse((await get('/api/jobs/' + id)).text);
    assert.equal(j.status, 'done', j.error);
    const rec = (await get('/api/records/' + j.result.record)).text;
    const sha = /\nicon\t([0-9a-f]{64})\n/.exec(rec);
    assert.ok(sha, 'the record names the icon: ' + rec);
    assert.deepEqual((await get('/icons/' + sha[1] + '.png')).body, icon);
    assert.match(html, /sign these files with your own certificate/);
    // Not a PNG, too big.
    const bad = multipart([...Object.entries(base).map(([name, value]) => ({ name, value })), { name: 'icon', filename: 'a.png', value: 'not a png' }]);
    isPage(await get('/submit', { method: 'POST', body: bad.body, headers: { 'Content-Type': bad.type } }), 400, 'not a png');
    const big = multipart([...Object.entries(base).map(([name, value]) => ({ name, value })), { name: 'icon', filename: 'a.png', value: Buffer.alloc((1 << 20) + 1) }]);
    const rb = await get('/submit', { method: 'POST', body: big.body, headers: { 'Content-Type': big.type } });
    isPage(rb, 400, 'big icon');
    assert.match(rb.text, /The icon is over 1 MB/);
  });

  await t.test('bad input: a page saying why, escaped', async () => {
    const cases = [
      [{ ...base, source_kind: 'repo', source: 'a/b', runtime: HOSTILE }, 400, /unknown runtime &quot;&lt;script&gt;/],
      [{ ...base, runtime: HOSTILE }, 400, /template isn&#39;t available/],
      [{ ...base, app_name: 'a\u202eb' }, 400, /control or text-direction/],
      [{ ...base, source_kind: 'repo', source: '' }, 400, /Say what to package/],
      [{ ...base, source_kind: 'local' }, 400, /Files from your computer/],
      [{ ...base, source_kind: 'repo', source: 'not a/valid name!', runtime: 'python' }, 400, /./],
      [{ ...base, rv_mode: 'exact' }, 400, /Enter the exact version/],
    ];
    for (const [f, status, re] of cases) {
      const r = await form(f);
      isPage(r, status, JSON.stringify(f).slice(0, 80));
      assert.match(r.text, re);
      assert.ok(!/<script|<img/.test(r.text));
      assert.match(r.text, /<a href="classic">start again<\/a>/);
    }
    isPage(await get('/submit', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'text/plain' } }), 415, 'text/plain');
    const m = multipart([{ name: 'a', value: 'b' }]);
    isPage(await get('/submit', { method: 'POST', body: m.body.subarray(0, 50), headers: { 'Content-Type': m.type } }), 400, 'truncated');
    const huge = await get('/submit', { method: 'POST', body: 'a=' + 'x'.repeat(5 << 20), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    isPage(huge, 413, 'over 4 MB');
    assert.equal(huge.headers.connection, 'close');
    // Status pages for no such job.
    for (const p of ['/status/j_nothing', '/status/' + encodeURIComponent(HOSTILE)]) {
      const r = await get(p);
      isPage(r, 404, p);
      assert.ok(!/<script/.test(r.text));
    }
    assert.equal((await get('/status/j_x', { method: 'POST' })).status, 405);
    const g = await get('/submit');
    assert.deepEqual([g.status, g.headers.location], [303, 'classic']);
  });

  await t.test('a failed build: its reason, escaped, and no refresh', async () => {
    // A package no registry has fails in the worker, not at the door.
    const r = await form({ ...base, source_kind: 'repo', source: 'https://127.0.0.1/<b>.zip', mode: 'unsigned' });
    const { page: html } = await follow(r);
    assert.match(html, /Failed/);
    assert.match(html, /The build failed: /);
    assert.ok(!/<b>/.test(html));
  });

  await t.test('rate limits: shared with POST /api/jobs', async () => {
    s.limiter = new Limiter(2, 60000);
    assert.equal((await form(base)).status, 303);
    assert.equal((await get('/api/jobs', { method: 'POST', body: '{' })).status, 400);
    const r = await form(base);
    isPage(r, 429, 'the third');
    assert.match(r.text, /Too many builds from your address/);
    assert.equal((await get('/api/jobs', { method: 'POST', body: '{' })).status, 429);
  });
});
