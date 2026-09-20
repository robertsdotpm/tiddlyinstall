// "From my computer" in the New installer form (plan.md section 1.11): a
// zip, a .tar.gz and a folder picked in the page are built into installers
// by the page itself, from disk and (with --site) on a page served by a
// build server, which still builds these in the page. Checks the record
// names the upload and the install rules saw its files, and each installer
// packs it.
//
//   node --experimental-websocket tests/upload-test.mjs [--page dist/index.html] [--site URL] [--out DIR] [--no-native]
//
// --no-native: as a browser without DecompressionStream, crypto.subtle,
// BigInt or :has() (tests/no-native-browser.mjs).
//
// --out keeps the built installers, to run by hand.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './browsers/cdp.mjs';
import { Checker, STARTED, waitFor, checkJob } from './browsers/steps.mjs';
import { noNativeArg, disableNative, checkNativeState } from './no-native-browser.mjs';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.resolve(arg('--page') || path.join(HERE, '..', 'dist', 'index.html'));
const SITE = arg('--site');
const OUT = arg('--out');
if (typeof WebSocket === 'undefined' || !fs.existsSync(PAGE)) {
  console.log('usage: node --experimental-websocket tests/upload-test.mjs [--page dist/index.html] [--site URL] [--out DIR]');
  process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-upload-'));
const t = new Checker();
const ok = t.ok.bind(t);

// A small Python project under one top folder, with a requirements.txt
// the install rules should notice.
const SRC = path.join(TMP, 'src');
const APP = path.join(SRC, 'myapp');
fs.mkdirSync(path.join(APP, 'hello'), { recursive: true });
fs.writeFileSync(path.join(APP, 'hello', '__main__.py'), "print('hello from upload')\n");
fs.writeFileSync(path.join(APP, 'hello', '__init__.py'), '');
fs.writeFileSync(path.join(APP, 'requirements.txt'), '\n');
const ZIP = path.join(TMP, 'myapp.zip');
const TGZ = path.join(TMP, 'myapp.tar.gz');
spawnSync('zip', ['-qr', ZIP, 'myapp'], { cwd: SRC });
spawnSync('tar', ['czf', TGZ, 'myapp'], { cwd: SRC });

let chrome, js, errors;
async function open(url) {
  errors.length = 0;
  await chrome.cdp('Page.navigate', { url: /^https?:/.test(url) ? url : 'file://' + url });
  await waitFor(js, STARTED, 'the page to start', 120000, errors);
  await sleep(300);   // the server probe, when served
}

// Fills the form for "From my computer", picks `files` in the archive or
// folder input, builds, and returns the finished job.
async function buildUpload(input, files) {
  await js(`location.hash = '#new'`);
  await sleep(200);
  await js(`(() => { const f = document.getElementById('new-form');
    for (const r of f.elements.source_kind) r.checked = r.value === 'local';
    f.elements.runtime.value = 'python'; f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
    for (const r of f.elements.mode) r.checked = r.value === 'unsigned';
    f.elements.app_name.value = 'Uploaded app';
    f.elements.entry_python.value = '{runtime} -m hello';
    for (const p of ['windows', 'linux', 'macos']) f.elements['target_' + p].checked = true;
    document.getElementById('local-picked').textContent = ''; })()`);
  const doc = await chrome.cdp('DOM.getDocument', { depth: 1 });
  const q = await chrome.cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: input });
  await chrome.cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files });
  await waitFor(js, `/\\(\\d/.test(document.getElementById('local-picked').textContent)`, 'the pick to be read', 60000, errors);
  return js(`(async () => {
    const f = document.getElementById('new-form');
    f.querySelector('button[type="submit"]').click();
    for (let i = 0; i < 600 && !/^#build&job=/.test(location.hash); i++) {
      const err = f.querySelector('.form-error');
      if (err && !err.hidden && err.textContent) return { error: err.textContent };
      await new Promise((r) => setTimeout(r, 100));
    }
    const id = new URLSearchParams(location.hash.slice(1)).get('job');
    for (let i = 0; i < 1200; i++) {
      const j = await ibLocalApi.request('/api/jobs/' + id);
      if (j.status === 'done' || j.status === 'failed') {
        await new Promise((r) => setTimeout(r, 2500));   // the build page's next poll
        return Object.assign(j, { shown: document.getElementById('job-status').textContent });
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    return { error: 'timed out' };
  })()`);
}

async function check(job, what) {
  await checkJob(t, js, job, what, 'python', OUT ? { keepDir: OUT, keepAs: what.replace(/\W+/g, '-') } : {});
  if (!job || !job.result) return;
  const rec = await js(`ibLocalApi.request('/api/records/${job.result.record}')`);
  ok(/^source\tupload\t[0-9a-f]{64}$/m.test(rec), what + ': the record names the upload', rec);
  ok(/^install\tdefault:requirements$/m.test(rec), what + ': the install rules saw requirements.txt', rec);
  ok(/Ready/.test(job.shown || ''), what + ': the build page shows it ready', job.shown);
  await checkDownloadArch(what);
}

// The build page's downloads say which architectures each installer covers.
// One online installer covers them all and picks on the computer, so the
// honest column is the set plus when the choice is made -- not a single
// architecture, which would be a lie (docs/format.md section 3).
async function checkDownloadArch(what) {
  const rows = await js(`[...document.querySelectorAll('#job-files tr')].map((tr) => ({
    platform: tr.cells[1].textContent.trim(),
    arch: tr.cells[2].textContent.replace(/\\s+/g, ' ').trim(),
  }))`);
  ok(rows.length === 3, what + ': three installers are listed', JSON.stringify(rows));
  const head = await js(`[...document.querySelectorAll('#job-downloads thead th')].map((th) => th.textContent)`);
  ok(head.indexOf('Architectures') === 2, what + ': the downloads have an Architectures column', JSON.stringify(head));
  for (const r of rows) {
    ok(/32-bit|Apple Silicon/.test(r.arch) && /64-bit/.test(r.arch),
      what + ' ' + r.platform + ': the download names its architectures in words', JSON.stringify(r));
    ok(/Chosen on the computer/.test(r.arch), what + ' ' + r.platform + ': and says the choice is made on the machine', r.arch);
  }
  ok(/Windows/.test(rows[0].platform) ? /32-bit \(x86\)/.test(rows[0].arch) : true, what + ': Windows covers 32-bit', rows[0].arch);
  const mac = rows.find((r) => r.platform === 'macOS');
  ok(mac && !/32-bit/.test(mac.arch), what + ': macOS claims no 32-bit, because there is none', mac && mac.arch);
  ok(/covers every architecture listed beside it/.test(await js(`document.getElementById('job-arch').textContent`)),
    what + ': the downloads explain that one file covers them all');
}

try {
  chrome = await launchChrome({ profile: path.join(TMP, 'profile') });
  ({ js, errors } = chrome);
  if (noNativeArg) await disableNative(chrome.cdp);
  await open(PAGE);
  await checkNativeState(ok, js);
  ok(await js(`getComputedStyle(document.getElementById('src-local').closest('label')).display !== 'none'`), 'the page offers "From my computer"');
  await check(await buildUpload('#local-archive', [ZIP]), 'zip');
  await check(await buildUpload('#local-archive', [TGZ]), 'tar.gz');
  await check(await buildUpload('#local-folder', [APP]), 'folder');
  if (SITE) {
    await open(SITE.replace(/\/$/, '') + '/');
    ok(!await js(`document.documentElement.classList.contains('ib-local')`), 'served: the page uses the build server');
    await check(await buildUpload('#local-archive', [ZIP]), 'served zip');
    ok(!await js(`document.documentElement.classList.contains('ib-local')`), 'served: still using the server for everything else');
    // "Signed by TiddlyInstall" can't take files from the computer.
    const refused = await js(`(async () => { const f = document.getElementById('new-form');
      location.hash = '#new'; await new Promise((r) => setTimeout(r, 200));
      for (const r of f.elements.source_kind) r.checked = r.value === 'local';
      for (const r of f.elements.mode) r.checked = r.value === 'ours';
      f.querySelector('button[type="submit"]').click();
      await new Promise((r) => setTimeout(r, 1500));
      return f.querySelector('.form-error').textContent; })()`);
    ok(/need the source on the build server/.test(refused), 'served: mode A with a local source says why not', refused);
  }
  ok(errors.length === 0, 'no page errors', errors.join(' | '));
} catch (e) {
  ok(false, 'upload run', e.stack || e);
} finally {
  if (chrome) await chrome.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${t.passed} passed, ${t.failed} failed`);
process.exit(t.failed ? 1 : 0);
