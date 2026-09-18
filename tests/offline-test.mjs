// Drives the one-file site (dist/index.html, plan.md section 1.11) in
// headless Chrome from file://, where it has no build server: builds
// installers from the New installer form, checks what comes out, and checks
// "Save this page" gives a copy that works too. With --site, also checks
// the same file served by a build server uses it, and can switch to "No
// server".
//
//   node --experimental-websocket tests/offline-test.mjs [--page dist/index.html] [--site URL] [--out DIR]
//
// --out keeps the built installers (with a builds.json like
// tests/matrix/build.py writes), for running them on the test machines.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInstaller, parseKv, kvGet, recordHash } from '../js/ibfile.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.resolve(arg('--page') || path.join(HERE, '..', 'dist', 'index.html'));
const SITE = arg('--site');
const OUT = arg('--out');
if (typeof WebSocket === 'undefined' || !fs.existsSync(PAGE)) {
  console.log('usage: node --experimental-websocket tests/offline-test.mjs [--page dist/index.html] [--site URL] [--out DIR]');
  process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-offline-'));
const DL = path.join(TMP, 'dl');
fs.mkdirSync(DL);

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -- ' + String(extra).slice(0, 600) : '')); }
}

/* ---------- Chrome over CDP (as tests/sign-ui-test.mjs) ---------- */

const PORT = 9400 + Math.floor(Math.random() * 90);
const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(TMP, 'profile'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map(), errors = [], requests = [];
async function connect() {
  for (let i = 0; i < 75; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
          if (d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails).slice(0, 400));
          if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url);
        };
        return;
      }
    } catch (e) { /* starting */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const n = ++seq;
  pending.set(n, (d) => (d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
async function waitFor(expr, what, ms = 120000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const v = await js(expr);
    if (v) return v;
  }
  throw new Error('timed out waiting for ' + what + (errors.length ? '; page errors: ' + errors.join(' | ') : ''));
}
async function open(file) {
  errors.length = 0;
  await cdp('Page.navigate', { url: /^https?:/.test(file) ? file : 'file://' + file });
  await waitFor(`!!(globalThis.ibLocalApi && document.readyState === 'complete' && document.querySelector('.save-ctl'))`, 'the page to start');
  await sleep(300);   // the server probe, when served
}

// Fills the New installer form for a hello app and builds it; returns the
// finished job.
async function buildHello({ runtime, mode, name, code, pkg, platforms = ['windows', 'linux', 'macos'] }) {
  await js(`location.hash = '#new${pkg ? '' : '&write'}'`);
  await sleep(200);
  return js(`(async () => {
    const f = document.querySelector('form[action="build.html"]');
    const set = (n, v) => { const e = f.elements[n]; if (e instanceof RadioNodeList) { for (const r of e) r.checked = r.value === v; } else if (e.type === 'checkbox') e.checked = v; else e.value = v; };
    set('runtime', ${JSON.stringify(runtime)});
    f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
    set('source_kind', ${JSON.stringify(pkg ? 'repo' : 'write')});
    set('app_name', ${JSON.stringify(name)});
    set('mode', ${JSON.stringify(mode)});
    for (const p of ['windows', 'linux', 'macos']) set('target_' + p, ${JSON.stringify(platforms)}.includes(p));
    ${pkg ? `set('source', ${JSON.stringify(pkg)}); set('ref_type', 'tag'); set('ref', ${JSON.stringify(pkg && pkg.version)});` : `
    set('template', 'script');
    const ta = f.querySelector('.combo-${runtime}-script textarea.code');
    ta.value = ${JSON.stringify(code)};`}
    f.querySelector('button[type="submit"]').click();
    for (let i = 0; i < 600 && !/^#build&job=/.test(location.hash); i++) {
      const err = f.querySelector('.form-error');
      if (err && !err.hidden && err.textContent) return { error: err.textContent };
      await new Promise((r) => setTimeout(r, 100));
    }
    const id = new URLSearchParams(location.hash.slice(1)).get('job');
    for (let i = 0; i < 1200; i++) {
      const j = await ibLocalApi.request('/api/jobs/' + id);
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { error: 'timed out' };
  })()`);
}

async function fetchBlob(url) {
  const b64 = await js(`fetch(${JSON.stringify(url)}).then(r => r.arrayBuffer()).then(b => {
    let s = ''; const u = new Uint8Array(b);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s); })`);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function checkJob(job, what, runtime, keepAs) {
  ok(job && job.status === 'done', what + ': the build finishes', JSON.stringify(job).slice(0, 400));
  if (!job || job.status !== 'done') return;
  const res = job.result;
  const kinds = { windows: 'exe', linux: 'run', macos: 'zip' };
  const files = {};
  for (const f of res.files) {
    const data = await fetchBlob(f.url);
    ok(data.length === f.size, `${what}: ${f.platform} download is ${f.size} bytes`, data.length);
    const info = await readInstaller(data, f.name);
    ok(info.kind === kinds[f.platform], `${what}: ${f.platform} is a .${kinds[f.platform]}`, info.kind);
    ok(info.record && await recordHash(info.record) === res.record, `${what}: ${f.platform} carries the record ${res.record}`);
    const rec = parseKv(info.record);
    ok((kvGet(rec, 'runtime') || [])[0] === runtime, `${what}: ${f.platform} record says runtime ${runtime}`, info.record);
    ok(info.plan && info.plan.startsWith('ib-plan\t') && info.plan.includes('record\t' + res.record + '\n'),
      `${what}: ${f.platform} carries its plan, bound to the record`, (info.plan || '').slice(0, 200));
    const blocks = (info.plan || '').split('\n').filter((l) => l.startsWith('when\t')).map((l) => l.split('\t')[1]);
    ok(blocks.length && blocks.every((b) => b === f.platform), `${what}: ${f.platform} plan is for ${f.platform} only`, blocks.join(','));
    const src = /\nsource\t\S+\t([0-9a-f]{64})\t/.exec(info.plan || '');
    if (src) ok(info.pack.some((m) => m.name === src[1]), `${what}: ${f.platform} packs the app's source`);
    if (keepAs) {
      fs.mkdirSync(path.join(OUT, keepAs), { recursive: true });
      const p = path.join(OUT, keepAs, f.name);
      fs.writeFileSync(p, data);
      files[f.platform] = p;
    }
  }
  return files;
}

try {
  await connect();
  await cdp('Runtime.enable');
  await cdp('Network.enable');
  await cdp('Page.enable');
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await open(PAGE);
  ok(errors.length === 0, 'the page starts without errors', errors.join(' | '));
  ok(await js(`document.documentElement.classList.contains('ib-local')`), 'from disk, the page builds installers itself');
  ok(/none, this page builds/.test(await js(`document.querySelector('.api-ctl-url').textContent`)), 'the footer says there is no build server');
  ok(await js(`getComputedStyle(document.getElementById('mode-ours').closest('label')).display === 'none' && document.getElementById('mode-unsigned').checked`),
    '"Signed by Installer Builder" is hidden and Unsigned is chosen');
  ok(await js(`getComputedStyle(document.getElementById('offline-on').closest('label')).display === 'none'`), 'packing runtimes is hidden');
  ok(await js(`getComputedStyle(document.getElementById('ts-on').closest('.online-only')).display === 'none'`), 'the timestamp relay is hidden');
  for (const p of ['new', 'edit', 'bases', 'home']) {
    await js(`location.hash = '#${p}'`);
    await sleep(100);
    ok(await js(`document.querySelector('.ib-page:not([hidden])').dataset.page === '${p}'`), `#${p} shows its page`);
  }
  const rt = await ibRuntimes();
  ok(rt.includes('python') && rt.includes('python2'), 'the runtimes summary is in the page', rt.join(','));

  // One build through the form, as a person would.
  const ui = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello form', code: "print('hello')\n" });
  await checkJob(ui, 'form', 'python');
  // The test matrix's hello projects (tests/matrix/projects.json), through
  // the page's API, kept for running on the test machines.
  const builds = {};
  const projects = JSON.parse(fs.readFileSync(path.join(HERE, 'matrix', 'projects.json'))).projects;
  for (const [runtime, p] of Object.entries(projects)) {
    for (const mode of ['B', 'C']) {
      const body = { name: 'Hello ' + runtime, project: p.project, source: { kind: 'inline' }, files: p.files, runtime, mode,
        platforms: ['windows', 'linux', 'macos'], launch: p.launch, console: true, menu: true };
      if (p.install) body.install = p.install;
      const job = await js(`(async () => {
        let j = await ibLocalApi.request('/api/jobs', { method: 'POST', body: ${JSON.stringify(body)} });
        while (j.status !== 'done' && j.status !== 'failed') {
          await new Promise((r) => setTimeout(r, 100));
          j = await ibLocalApi.request('/api/jobs/' + j.id);
        }
        return j;
      })()`);
      const files = await checkJob(job, `${runtime} ${mode}`, runtime, OUT && `${runtime}/${mode}`);
      if (files) builds[`${runtime}/${mode}`] = { status: 'done', record: job.result.record, files };
    }
  }
  // Mode A is refused here, with a clear message.
  const a = await js(`ibLocalApi.request('/api/jobs', { method: 'POST', body: { runtime: 'python', mode: 'A', source: { kind: 'inline' }, files: { 'a/__main__.py': 'x' } } }).then(() => 'accepted', (e) => e.message)`);
  ok(/build server/.test(a), 'mode A is refused offline', a);
  const gh = await js(`ibLocalApi.request('/api/jobs', { method: 'POST', body: { runtime: 'python', mode: 'C', source: { kind: 'github', value: 'psf/requests' } } }).then(() => 'accepted', (e) => e.message)`);
  ok(/build server/.test(gh), 'GitHub sources are refused offline, saying why', gh);

  const outside = requests.filter((u) => !/^(file|blob|data):/.test(u));
  ok(outside.length === 0, 'nothing was fetched from the network', outside.slice(0, 5).join(' '));

  // Save this page, then open the saved copy and build again from it.
  await js(`document.querySelector('.save-page').click()`);
  let saved = null;
  for (let i = 0; i < 100 && !saved; i++) {
    await sleep(200);
    if (fs.existsSync(path.join(DL, 'tiddlyinstall.html')) && !fs.readdirSync(DL).some((f) => f.endsWith('.crdownload'))) saved = path.join(DL, 'tiddlyinstall.html');
  }
  ok(saved && fs.statSync(saved).size > 1e6, 'Save this page downloads the page', saved);
  if (saved) {
    await open(saved);
    ok(errors.length === 0, 'the saved copy starts without errors', errors.join(' | '));
    const job = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello again', code: "print('hello')\n", platforms: ['linux'] });
    await checkJob(job, 'saved copy', 'python');
  }
  if (OUT) fs.writeFileSync(path.join(OUT, 'builds.json'), JSON.stringify(builds, null, 1));

  if (SITE) {
    // The same file, served by a build server: it uses the server.
    await open(SITE.replace(/\/$/, '') + '/');
    ok(errors.length === 0, 'served: the page starts without errors', errors.join(' | '));
    ok(!await js(`document.documentElement.classList.contains('ib-local')`), 'served: the page uses the build server');
    ok(await js(`getComputedStyle(document.getElementById('mode-ours').closest('label')).display !== 'none'`), 'served: "Signed by Installer Builder" is offered');
    const rts = await js(`fetch('/api/catalog/runtimes').then(r => r.ok)`);
    ok(rts, 'served: the server answers the page');
    await js(`document.querySelector('.api-ctl-edit').click(); document.querySelector('.api-ctl-local').click()`);
    ok(await js(`document.documentElement.classList.contains('ib-local') && document.getElementById('mode-unsigned').checked`),
      'served: "No server" switches to building in the page, on Unsigned');
    const job = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello no server', code: "print('hello')\n", platforms: ['linux'] });
    await checkJob(job, 'served, no server', 'python');
    await js(`localStorage.clear()`);
  }
} catch (e) {
  failed++;
  console.log('FAIL ' + (e.stack || e));
} finally {
  try { ws && ws.close(); } catch (e) { /* ignore */ }
  chrome.kill();
  await sleep(300);
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

async function ibRuntimes() {
  const r = await js(`ibLocalApi.request('/api/catalog/runtimes')`);
  return (r.runtimes || []).map((x) => x.id);
}
