// Drives the runtime catalogue editor (#runtimes in the one-file site,
// web/catalog-editor.js and web/overlay.js) in headless Chrome from file://:
// edits a Python release's mirror order and a recipe's steps, checks the
// edits are kept across a reload, that the preview and a built installer's
// plan follow them, that invalid edits are refused, revert, export, import
// (with a hostile file), reset, "Save this page" with the changes inside,
// and that nothing breaks when storage throws. With --site, also checks the
// editor says a build server's catalogue is used, and offers "No server".
//
//   node --experimental-websocket tests/catalog-editor-test.mjs [--page dist/index.html] [--site URL] [--shots DIR] [--no-native]
//
// --no-native: as a browser without DecompressionStream, crypto.subtle,
// BigInt or :has() (tests/no-native-browser.mjs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInstaller } from '../shared/ibfile.js';
import { noNativeArg, disableNative, checkNativeState } from './no-native-browser.mjs';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.resolve(arg('--page') || path.join(HERE, '..', 'dist', 'index.html'));
const SITE = arg('--site');
const SHOTS = arg('--shots');
if (typeof WebSocket === 'undefined' || !fs.existsSync(PAGE)) {
  console.log('usage: node --experimental-websocket tests/catalog-editor-test.mjs [--page dist/index.html] [--site URL] [--shots DIR]');
  process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-cated-'));
const DL = path.join(TMP, 'dl');
fs.mkdirSync(DL);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -- ' + String(extra).slice(0, 600) : '')); }
}

/* ---------- Chrome over CDP (as tests/offline-test.mjs) ---------- */

const PORT = 9300 + Math.floor(Math.random() * 90);
const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--window-size=1400,1000',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(TMP, 'profile'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map(), errors = [];
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
async function waitFor(expr, what, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(150)) {
    let v;
    try { v = await js(expr); } catch (e) { v = null; }
    if (v) return v;
  }
  throw new Error('timed out waiting for ' + what + (errors.length ? '; page errors: ' + errors.join(' | ') : ''));
}
async function shot(name) {
  if (!SHOTS) return;
  await js(`window.scrollTo(0, 0)`);
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(r.data, 'base64'));
}
// Opens the page on the Runtimes section, python.
async function openEditor(file, hash = '#runtimes&rt=python&tab=releases') {
  errors.length = 0;
  await cdp('Page.navigate', { url: (/^https?:/.test(file) ? file : 'file://' + file) + hash });
  await waitFor(`document.readyState === 'complete' && !!globalThis.ibLocalApi && !document.getElementById('rt-app').hidden && document.querySelectorAll('.rt-vrow').length > 0`, 'the editor to start');
  await sleep(400);
}
// A real reload: Page.navigate to the same URL and hash would not be one.
async function reopen(file, hash) {
  await cdp('Page.navigate', { url: 'about:blank' });
  await sleep(200);
  await openEditor(file, hash);
}
const count = () => js(`document.getElementById('rt-count').textContent`);
const stored = () => js(`(() => { try { const t = localStorage.getItem('ib.catalog.overlay'); return t == null ? null : JSON.parse(t).changes.length; } catch (e) { return 'throws'; } })()`);

// Sets an input's value as typing would.
const setIn = (sel, v) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)};
  e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const click = (sel) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return false; e.click(); return true; })()`);

// What a Windows plan picks for Windows 10/11 amd64: the file and version,
// how many steps the block has, and its first step (which names the recipe
// the plan used, whatever the catalogue offers today).
function firstTarget(plan) {
  const block = plan.split('[target]').find((b) => /\nwhen\twindows\t\d+\t9999\tamd64/.test(b)) || '';
  const file = /\nfile\tpython\t(\S+)\t/.exec(block);
  const ver = /\nruntime\tpython\t(\S+)/.exec(block);
  const st = /\nstep\t(\w+)\t([^\n]*)/.exec(block);
  return { file: file && file[1], version: ver && ver[1], steps: (block.match(/\nstep\t/g) || []).length,
    stepType: st && st[1], stepText: st && st[2] };
}
let TARGET = null;

// Opens the release the Windows plan picks in the releases list.
async function pickRelease() {
  await js(`location.hash = '#runtimes&rt=python&tab=releases'`);
  await sleep(200);
  await js(`document.querySelector('#rt-tabs [data-tab="releases"]').click()`);
  for (const [k, v] of [['os', 'windows'], ['arch', 'amd64']]) await setIn('#rt-f-' + k, v);
  await setIn('#rt-f-version', '==' + TARGET.version);
  await sleep(200);
  await js(`[...document.querySelectorAll('.rt-vrow')].find((r) => r.querySelector('.rt-file').textContent === ${JSON.stringify(TARGET.file)}).click()`);
  await waitFor(`!document.getElementById('rt-detail').hidden`, 'the release form');
  return js(`({ version: document.querySelector('[data-err="version"] input').value, url: document.querySelector('[data-err="url"] input').value,
    mirrors: [...document.querySelectorAll('[data-err="mirrors"] li input')].map((i) => i.value) })`);
}

// Builds a Windows-only installer through the page's own API; returns {job, plan}.
async function buildWindows(name) {
  const body = { name, source: { kind: 'inline' }, files: { 'main.py': "print('hi')\n" }, runtime: 'python', mode: 'C',
    platforms: ['windows'], launch: '{runtime} {app_dir}/main.py', console: true };
  const job = await js(`(async () => {
    let j = await ibLocalApi.request('/api/jobs', { method: 'POST', body: ${JSON.stringify(body)} });
    while (j.status !== 'done' && j.status !== 'failed') { await new Promise((r) => setTimeout(r, 100)); j = await ibLocalApi.request('/api/jobs/' + j.id); }
    return j;
  })()`);
  if (!job || job.status !== 'done') return { job, plan: '' };
  const f = job.result.files[0];
  const b64 = await js(`fetch(${JSON.stringify(f.url)}).then(r => r.arrayBuffer()).then(b => { let s = ''; const u = new Uint8Array(b);
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); })`);
  const info = await readInstaller(new Uint8Array(Buffer.from(b64, 'base64')), f.name);
  return { job, plan: info.plan || '' };
}

async function waitDownload(name) {
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const p = path.join(DL, name);
    if (fs.existsSync(p) && !fs.readdirSync(DL).some((f) => f.endsWith('.crdownload'))) return p;
  }
  return null;
}

async function setFile(sel, file) {
  const { root } = await cdp('DOM.getDocument', { depth: 1 });
  const { nodeId } = await cdp('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
  await cdp('DOM.setFileInputFiles', { nodeId, files: [file] });
}

const STEP = 'echo hello-from-overlay';

try {
  await connect();
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('DOM.enable');
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  if (noNativeArg) await disableNative(cdp);

  /* ---- the editor starts, and nothing is changed ---- */
  await openEditor(PAGE);
  await checkNativeState(ok, js);
  // The catalogue is unpacked a folder at a time: opening Python unpacks
  // only python/ (python and python2), and the list still counts the rest.
  ok(JSON.stringify(await js(`ibLocalApi.unpacked()`)) === '["python"]', 'opening the editor on Python unpacks only its folder', JSON.stringify(await js(`ibLocalApi.unpacked()`)));
  ok(/13,452/.test(await js(`document.querySelector('.rt-rt[data-rt="node"] .rt-rt-meta').textContent`)), 'the runtimes list counts Node.js\'s releases before unpacking them');
  const before = await buildWindows('Hello before');
  TARGET = firstTarget(before.plan);
  ok(TARGET.file && TARGET.version && TARGET.steps > 0, 'a build with the built-in catalogue works', JSON.stringify(TARGET));
  ok(errors.length === 0, 'the editor starts without errors', errors.join(' | '));
  ok(/^No changes/.test(await count()), 'no changes to begin with', await count());
  // (the count itself moves with the catalogue, so only its shape is checked)
  const pyCount = await js(`document.getElementById('rt-rel-count').textContent`);
  ok(/^([\d,]+) of \1 releases$/.test(pyCount) && parseInt(pyCount, 10) > 100, 'the Python releases are listed', pyCount);
  ok(await js(`document.querySelectorAll('.rt-vrow').length < 60`), 'only the visible rows are drawn');

  /* ---- 32-bit availability, beside the other support facts ---- */
  // Whether a runtime has a 32-bit build is a support fact like the OS
  // versions it runs on, and it decides whether a 32-bit machine can be
  // installed on at all. It is stated per OS, and 64-bit with it, so
  // neither is read off an empty filter.
  const pyArch = await js(`document.getElementById('rt-arch').textContent`);
  ok(/^32-bit builds: /.test(pyArch), 'the Sources page states 32-bit availability for the open runtime', pyArch);
  ok(/Windows: yes/.test(pyArch), 'Python has 32-bit Windows builds, and the page says so', pyArch);
  ok(/macOS: no \(Apple dropped 32-bit support in macOS 10\.15 \(2019\)\)/.test(pyArch),
    'macOS 32-bit is absent with its reason, not simply missing', pyArch);
  ok(/Linux: no/.test(pyArch), 'Python has no 32-bit Linux build, and the page says so rather than showing nothing', pyArch);
  ok(/64-bit builds: Windows, Linux, macOS/.test(pyArch), 'and the same question is answered for 64-bit', pyArch);
  // The releases filter spells out what an arch id means: "x86" is read as
  // either width by people who don't already know.
  const archOpts = await js(`[...document.getElementById('rt-f-arch').options].map((o) => o.textContent).join(' | ')`);
  ok(/x86 — 32-bit \(/.test(archOpts) && /amd64 — 64-bit \(/.test(archOpts),
    'the releases filter spells out 32-bit and 64-bit', archOpts);
  // A runtime that does have 32-bit Linux says a different thing, from the
  // same catalogue: the page holds no opinion of its own.
  await js(`document.querySelector('.rt-rt[data-rt="go"]').click()`);
  await waitFor(`/^go ·/.test(document.getElementById('rt-sub').textContent)`, 'Go to open');
  await sleep(150);
  const goArch = await js(`document.getElementById('rt-arch').textContent`);
  ok(/Linux: yes/.test(goArch), 'Go has 32-bit Linux builds, and the page says so', goArch);
  ok(goArch !== pyArch, 'the answer is per runtime, not one claim for the site', goArch);
  await js(`document.querySelector('.rt-rt[data-rt="python"]').click()`);
  await waitFor(`/^python ·/.test(document.getElementById('rt-sub').textContent)`, 'Python to open again');
  await sleep(150);
  await js(`document.querySelector('.rt-rt[data-rt="node"]').click()`);
  await waitFor(`/13,452 of/.test(document.getElementById('rt-rel-count').textContent)`, 'Node.js to be unpacked and listed');
  await sleep(100);
  ok((await js(`ibLocalApi.unpacked()`)).includes('node'), 'opening Node.js unpacks its folder');
  const nodeRows = await js(`[document.getElementById('rt-rel-count').textContent, document.querySelectorAll('.rt-vrow').length]`);
  ok(/13,452 of 13,452/.test(nodeRows[0]) && nodeRows[1] < 60, 'Node.js: 13,452 releases, a few rows drawn', nodeRows.join(' '));
  await js(`const l = document.getElementById('rt-rel-list'); l.scrollTop = 200000; l.dispatchEvent(new Event('scroll'))`);
  await sleep(300);
  ok(await js(`document.querySelectorAll('.rt-vrow').length > 0 && document.querySelectorAll('.rt-vrow').length < 60`), 'scrolling far down draws rows there');
  await js(`document.querySelector('.rt-rt[data-rt="python"]').click()`);
  await waitFor(`document.getElementById('rt-rel-count').textContent === ` + JSON.stringify(pyCount), 'Python to be listed again');
  await sleep(100);

  /* ---- a release: invalid edits are refused ---- */
  const rel = await pickRelease();
  // (mirrors[0] is the URL itself in the Python catalogue, which plans list
  // once; so the test swaps the second and third mirrors.)
  ok(rel.mirrors.length >= 3 && /^https:/.test(rel.url), 'a release opens in the form with its URL and mirrors', JSON.stringify(rel).slice(0, 300));
  await setIn('[data-err="ib_sha256"] input', 'abc123');
  await sleep(100);
  ok(await js(`document.getElementById('rt-save').disabled && /64 hex/.test(document.querySelector('[data-err="ib_sha256"] .rt-err').textContent)`),
    'a SHA-256 that isn\'t 64 hex characters is shown inline and can\'t be saved');
  await setIn('[data-err="url"] input', 'ftp://example.com/x.zip');
  await sleep(100);
  ok(await js(`/https/.test(document.querySelector('[data-err="url"] .rt-err').textContent)`), 'a non-http URL is shown inline');
  await js(`document.getElementById('rt-save').click()`);
  await sleep(200);
  ok(/^No changes/.test(await count()) && await stored() === null, 'nothing is saved while the edit is invalid');
  await js(`[...document.querySelectorAll('#rt-detail button')].find((b) => b.textContent === 'Undo edits').click()`);
  await sleep(200);
  ok(!await js(`document.getElementById('rt-save').disabled`), 'Undo edits brings back the valid release');

  /* ---- change the mirror order ---- */
  await js(`document.querySelector('[data-err="mirrors"] li:nth-child(2) button[aria-label="Move down"]').click()`);
  await waitFor(`/Includes the edit/.test(document.getElementById('rt-p-status').textContent)`, 'the preview to include the unsaved edit');
  const pv = await js(`document.getElementById('rt-p-diff').textContent`);
  ok(pv.includes('+ url\t' + rel.mirrors[2]) || pv.includes('- url\t' + rel.mirrors[1]), 'the preview shows the plan\'s download order changing before saving', pv.slice(0, 400));
  await js(`document.getElementById('rt-p-diff-wrap').open = true`);
  await shot('editor-release.png');
  await js(`document.getElementById('rt-save').click()`);
  await waitFor(`/1 change/.test(document.getElementById('rt-count').textContent)`, 'the change to be saved');
  ok(await stored() === 1, 'the change is kept in localStorage');

  /* ---- a recipe: add a step ---- */
  await js(`document.querySelector('#rt-tabs [data-tab="recipes"]').click()`);
  await sleep(200);
  // The recipe the Windows plan used: the Windows one for that download's
  // format whose first step is the plan's first step. (Which format Windows
  // gets, and how many steps end up in the plan, are the catalogue's to
  // decide -- a release downloaded in parts adds steps of its own.)
  const targetFormat = (/\.(tar\.gz|tar\.xz|zip|msi|exe|7z)$/.exec(TARGET.file || '') || [, ''])[1];
  const recipeRow = await js(`(() => {
    const cells = (tr) => [...tr.cells].map((c) => c.textContent);
    const rows = [...document.querySelectorAll('#rt-rec-table tbody tr')]
      .filter((tr) => cells(tr)[1] === 'windows' && cells(tr)[3].split(' | ').includes(${JSON.stringify(targetFormat)}));
    for (const tr of rows) {
      tr.click();
      const first = document.querySelector('.rt-steps li:first-child input');
      if (first && first.value === ${JSON.stringify(TARGET.stepText || '')}) return cells(tr).join(' ');
    }
    return null; })()`);
  ok(!!recipeRow, 'the recipe the Windows plan uses is listed', recipeRow);
  await js(`document.getElementById('rt-add-step').click()`);
  await sleep(150);
  ok(await js(`document.getElementById('rt-save').disabled && /no command/.test(document.getElementById('rt-problems').textContent)`),
    'a step with no command is refused');
  await setIn('[data-err="match.versions"] input', '>>3');
  await sleep(100);
  ok(await js(`/isn't a version/.test(document.querySelector('[data-err="match.versions"] .rt-err').textContent)`), 'a version spec that doesn\'t parse is shown inline');
  await js(`[...document.querySelectorAll('#rt-detail button')].find((b) => b.textContent === 'Undo edits').click()`);
  await sleep(150);
  await js(`document.getElementById('rt-add-step').click()`);
  await sleep(150);
  await setIn('.rt-steps li:last-child input', STEP);
  await sleep(100);
  await shot('editor-recipe.png');
  await js(`document.getElementById('rt-save').click()`);
  await waitFor(`/2 changes/.test(document.getElementById('rt-count').textContent)`, 'the recipe change to be saved');
  await waitFor(`document.getElementById('rt-p-plan').textContent.includes('step\\trun\\t${STEP}')`, 'the preview plan to have the new step');
  ok(true, 'the preview plan runs the new step');

  /* ---- a reload keeps both ---- */
  await openEditor(PAGE, '#runtimes&rt=python&tab=recipes');
  ok(/2 changes/.test(await count()), 'both changes are still there after a reload', await count());
  ok(await js(`document.querySelectorAll('#rt-rec-table .rt-badge').length === 1`), 'the changed recipe is marked');
  await js(`document.getElementById('rt-changes-details').open = true`);
  await shot('editor-changes.png');

  /* ---- a build uses them, and says so ---- */
  const { job, plan } = await buildWindows('Hello overlay');
  ok(job && job.status === 'done', 'an installer builds with the changes', JSON.stringify(job).slice(0, 300));
  ok(job && job.result && job.result.catalog && job.result.catalog.changed && job.result.catalog.changes === 2, 'the job result says the catalogue was changed', JSON.stringify(job && job.result && job.result.catalog));
  ok(plan.includes('step\trun\t' + STEP), 'the installer\'s plan runs the added step');
  const i0 = plan.indexOf('url\t' + rel.mirrors[1] + '\n'), i1 = plan.indexOf('url\t' + rel.mirrors[2] + '\n');
  ok(i0 > 0 && i1 > 0 && i1 < i0, 'the installer\'s plan tries the mirrors in the new order', i0 + ' ' + i1);
  await js(`location.hash = '#build&job=${job && job.id}'`);
  await waitFor(`!document.getElementById('job-catalog').hidden`, 'the build page to say the catalogue changed');
  ok(/changed catalogue: 2 changes/.test(await js(`document.getElementById('job-catalog').textContent`)), 'the build page says it was made with a changed catalogue');
  await shot('build-page.png');
  await js(`location.hash = '#new'`);
  await sleep(300);
  ok(await js(`!document.getElementById('new-overlay-note').hidden && /Builds use 2 catalogue changes/.test(document.getElementById('new-overlay-note').textContent)`),
    'the New installer page says builds use the changes');
  const summary = await js(`ibLocalApi.request('/api/catalog/runtimes')`);
  ok(summary && summary.changed === 2 && summary.runtimes.some((r) => r.id === 'python'), 'the "newest that runs" summary is worked out with the changes');

  /* ---- export ---- */
  await openEditor(PAGE);
  await js(`document.getElementById('rt-export').click()`);
  const exported = await waitDownload('tiddlyinstall-catalog-changes.json');
  const doc = exported && JSON.parse(fs.readFileSync(exported, 'utf8'));
  ok(doc && doc['ib-catalog-overlay'] === 1 && doc.changes.length === 2, 'Export saves the overlay as a JSON file with both changes');

  /* ---- revert one ---- */
  await js(`document.getElementById('rt-changes-details').open = true`);
  await js(`[...document.querySelectorAll('[data-revert]')].find((b) => b.dataset.revert.includes('install.json')).click()`);
  await waitFor(`/^1 change/.test(document.getElementById('rt-count').textContent)`, 'the revert');
  await js(`document.querySelector('#rt-tabs [data-tab="recipes"]').click()`);
  await sleep(600);
  ok(!await js(`document.getElementById('rt-p-plan').textContent.includes(${JSON.stringify(STEP)})`) && await stored() === 1, 'Revert drops the recipe change, and the preview follows');

  /* ---- reset all ---- */
  await js(`document.getElementById('rt-reset').click(); document.getElementById('rt-reset-yes').click()`);
  await waitFor(`/^No changes/.test(document.getElementById('rt-count').textContent)`, 'the reset');
  ok(await stored() === 0, 'Reset all leaves no changes');
  const plain = await buildWindows('Hello plain');
  ok(plain.job && plain.job.status === 'done' && !plain.job.result.catalog && !plain.plan.includes(STEP), 'a build after the reset uses the built-in catalogue');

  /* ---- changes found in this browser's storage are asked about once ---- */

  // Pages opened from disk share one localStorage in Chrome, so changes can
  // appear that nobody here made (design.md 11.0 item 3). They are not used
  // until this session says so, and the question shows what they do.
  await js(`localStorage.setItem('ib.catalog.overlay', ${JSON.stringify(JSON.stringify(doc))}); sessionStorage.clear()`);
  await reopen(PAGE);
  await waitFor(`!document.querySelector('.overlay-ask').hidden`, 'the question about changes found in storage');
  ok(await js(`document.querySelectorAll('.overlay-ask .rt-change-list > li').length === 2`), 'the question lists both changes',
    await js(`document.querySelector('.overlay-ask').textContent.slice(0, 300)`));
  ok(await js(`[...document.querySelectorAll('.overlay-ask .rt-change-title')].every((e) => /^Python[\\d ]*: (Changed|Added) /.test(e.textContent))`),
    'each one says what it changes', await js(`[...document.querySelectorAll('.overlay-ask .rt-change-title')].map((e) => e.textContent).join(' | ')`));
  ok(/^No changes/.test(await count()), 'until answered they are not in use', await count());
  const unasked = await buildWindows('Hello unanswered');
  ok(unasked.job && unasked.job.status === 'done' && !unasked.job.result.catalog && !unasked.plan.includes(STEP),
    'a build before the answer uses the catalogue built into the page');
  await shot('overlay-consent.png');
  await click('.overlay-ask-no');
  await sleep(300);
  ok(await js(`document.querySelector('.overlay-ask').hidden`) && /set aside for this session/.test(await js(`document.getElementById('rt-page-note').textContent`)),
    '"Not now" sets them aside, and the Sources page says so', await js(`document.getElementById('rt-page-note').textContent`));
  await reopen(PAGE);
  ok(await js(`document.querySelector('.overlay-ask').hidden`) && /^No changes/.test(await count()),
    'the answer is remembered for the session: no second question', await count());
  await click('#rt-use-stored');
  await waitFor(`/2 changes/.test(document.getElementById('rt-count').textContent)`, 'the changes to be taken into use');
  const agreed = await buildWindows('Hello agreed');
  ok(agreed.plan.includes('step\trun\t' + STEP), 'once they are agreed to, builds use them');
  await reopen(PAGE);
  ok(await js(`document.querySelector('.overlay-ask').hidden`) && /2 changes/.test(await count()),
    'and they stay in use for the rest of the session', await count());
  await js(`localStorage.clear(); sessionStorage.clear()`);
  await reopen(PAGE);

  /* ---- policy ---- */
  await js(`document.querySelector('#rt-tabs [data-tab="policy"]').click()`);
  await sleep(200);
  await setIn('#rt-policy-form [data-err="versions"] input', '>=3,<');
  await sleep(100);
  ok(await js(`document.getElementById('rt-policy-save').disabled && /empty part|isn't a version/.test(document.querySelector('#rt-policy-form [data-err="versions"] .rt-err').textContent)`),
    'policy: a bad version spec is shown inline and can\'t be saved');
  await setIn('#rt-policy-form [data-err="versions"] input', '>=3');
  await setIn('#rt-policy-form [data-err="launch"] input', '{runtime} -m changed');
  await sleep(100);
  await js(`document.getElementById('rt-policy-save').click()`);
  await waitFor(`/^1 change/.test(document.getElementById('rt-count').textContent)`, 'the policy change');
  const sum2 = await js(`ibLocalApi.request('/api/catalog/runtimes')`);
  ok(await stored() === 1 && sum2.runtimes.find((r) => r.id === 'python').launch === '{runtime} -m changed', 'policy: the default launch command is changed, and the page\'s summary follows');
  await shot('editor-policy.png');
  await js(`document.getElementById('rt-reset').click(); document.getElementById('rt-reset-yes').click()`);
  await waitFor(`/^No changes/.test(document.getElementById('rt-count').textContent)`, 'the second reset');

  /* ---- import: shown first, applied only when asked ---- */
  await setFile('#rt-import', exported);
  await waitFor(`!document.getElementById('rt-review').hidden`, 'the import review');
  ok(await js(`document.querySelectorAll('#rt-review-list > li').length === 2`) && /^No changes/.test(await count()), 'an imported file is shown for review, not applied');
  await js(`document.getElementById('rt-review-add').click()`);
  await waitFor(`/2 changes/.test(document.getElementById('rt-count').textContent)`, 'the import');
  ok(await stored() === 2, 'applying the import keeps both changes');

  /* ---- a hostile import is data, not markup ---- */
  const hostile = path.join(TMP, 'hostile.json');
  const evil = '<img src=x onerror="window.pwned=1">';
  fs.writeFileSync(hostile, JSON.stringify({ 'ib-catalog-overlay': 1, changes: [
    { op: 'add', id: 'evil1', path: ['python/releases.json', '-'], value: { version: evil, os: 'windows', arch: 'amd64', kind: 'archive', format: 'zip', url: 'javascript:alert(1)', ib_sha256: 'x' } },
    { op: 'add', id: 'evil2', path: ['python/install.json', 'recipes', '-'], value: { match: { os: 'windows' }, method: 'run', steps: [{ run: 'echo hi‮' }] } },
    { op: 'replace', path: ['policy.json', 'mirror_base'], value: 'http://evil.example/', was: '0000000000000000' },
    { op: 'add', id: 'evil3', path: ['__proto__/releases.json', '-'], value: {} },
  ] }));
  await setFile('#rt-import', hostile);
  await waitFor(`/from "hostile.json"/.test(document.getElementById('rt-review-title').textContent)`, 'the hostile file\'s review');
  await sleep(300);
  ok(await js(`document.querySelectorAll('#rt-review img, #rt-review script').length === 0 && document.getElementById('rt-review').textContent.includes('<img src=x')`),
    'a hostile file\'s text is shown as text, never as markup');
  ok(await js(`window.pwned === undefined`), 'nothing in the hostile file ran');
  ok(await js(`document.getElementById('rt-review-add').disabled && /Left out \\(4\\)/.test(document.getElementById('rt-review-skipped').textContent)`),
    'every change in the hostile file is left out, with a reason', await js(`document.getElementById('rt-review-skipped').textContent`));
  await shot('editor-import-review.png');
  await js(`document.getElementById('rt-review-cancel').click()`);
  ok(/2 changes/.test(await count()), 'cancelling leaves the changes as they were');

  /* ---- "Save this page" with the changes inside ---- */
  ok(await js(`!document.querySelector('.rt-save-with').hidden`), 'Save this page offers to include the changes');
  await js(`document.getElementById('rt-save-with').checked = true; document.querySelector('.save-page').click()`);
  const saved = await waitDownload('tiddlyinstall.html');
  const savedText = saved ? fs.readFileSync(saved, 'utf8') : '';
  ok(/<script type="application\/json" id="ib-overlay">\s*\{"ib-catalog-overlay":1,"changes":\[/.test(savedText), 'the saved page carries the changes');
  await js(`localStorage.removeItem('ib.catalog.overlay')`);
  if (saved) {
    await openEditor(saved);
    ok(errors.length === 0, 'the saved copy starts without errors', errors.join(' | '));
    ok(/2 changes/.test(await count()) && /came inside this page file/.test(await js(`document.getElementById('rt-page-note').textContent`)),
      'opened in a browser with no changes of its own, the saved copy uses the changes it carries, and says so', await count());
    const b = await buildWindows('Hello saved');
    ok(b.job && b.job.status === 'done' && b.plan.includes('step\trun\t' + STEP), 'the saved copy builds with them');
  }
  await js(`localStorage.clear()`);

  /* ---- storage that throws ---- */
  const { identifier } = await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `
    for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) {
      Object.defineProperty(window, k, { configurable: true, get() { throw new DOMException('storage is blocked', 'SecurityError'); } });
    }` });
  await openEditor(PAGE);
  ok(errors.length === 0, 'with storage throwing, the page starts without errors', errors.join(' | '));
  ok(await js(`!document.getElementById('rt-store').hidden && /won't let the page keep data/.test(document.getElementById('rt-store').textContent)`), 'the editor says changes can\'t be kept');
  const rel2 = await pickRelease();
  await js(`document.querySelector('[data-err="mirrors"] li:nth-child(2) button[aria-label="Move down"]').click()`);
  await js(`document.getElementById('rt-save').click()`);
  await waitFor(`/1 change/.test(document.getElementById('rt-count').textContent)`, 'the change to be kept in memory');
  ok(true, 'an edit is kept for the tab without storage');
  await shot('editor-no-storage.png');
  const nb = await buildWindows('Hello no storage');
  const j0 = nb.plan.indexOf('url\t' + rel2.mirrors[1] + '\n'), j1 = nb.plan.indexOf('url\t' + rel2.mirrors[2] + '\n');
  ok(nb.job && nb.job.status === 'done' && j1 > 0 && j1 < j0, 'a build without storage still uses the edit');
  ok(errors.length === 0, 'no page errors without storage', errors.join(' | '));
  await cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier });

  /* ---- served by a build server ---- */
  if (SITE) {
    await openEditor(SITE.replace(/\/$/, '') + '/');
    ok(await js(`/build server/.test(document.getElementById('rt-mode').textContent) && /don't affect/.test(document.getElementById('rt-mode').textContent)`),
      'served: the editor says the server\'s catalogue is used');
    await shot('editor-served.png');
    await js(`document.getElementById('rt-use-local').click()`);
    await sleep(200);
    ok(await js(`document.documentElement.classList.contains('ib-local') && /builds use your changes/.test(document.getElementById('rt-mode').textContent)`),
      'served: "Build in this page instead" switches to no server');
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
