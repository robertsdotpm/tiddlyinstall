// Drives the one-file site (dist/index.html, plan.md section 1.11) in
// headless Chrome from file://, where it has no build server: builds
// installers from the New installer form, checks what comes out, and checks
// "Save this page" gives a copy that works too. With --site, also checks
// the same file served by a build server uses it, and can switch to "No
// server".
//
//   node --experimental-websocket tests/offline-test.mjs [--page dist/index.html] [--site URL] [--out DIR] [--no-native]
//
// --no-native: as a browser without DecompressionStream, crypto.subtle,
// BigInt or :has() (tests/no-native-browser.mjs).
//
// --out keeps the built installers (with a builds.json like
// tests/matrix/build.py writes), for running them on the test machines.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './browsers/cdp.mjs';
import { Checker, STARTED, waitFor, checkSections, buildHello as buildHelloIn, checkJob as checkJobIn } from './browsers/steps.mjs';
import { noNativeArg, disableNative, checkNativeState, checkHasRules } from './no-native-browser.mjs';

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

const t = new Checker();
const ok = t.ok.bind(t);

/* ---------- Chrome over CDP (tests/browsers/cdp.mjs) ---------- */

let chrome, js, errors, requests;
async function open(file) {
  errors.length = 0;
  await chrome.cdp('Page.navigate', { url: /^https?:/.test(file) ? file : 'file://' + file });
  await waitFor(js, STARTED, 'the page to start', 120000, errors);
  await sleep(300);   // the server probe, when served
}
const buildHello = (opts) => buildHelloIn(js, opts);
const checkJob = (job, what, runtime, keepAs) => checkJobIn(t, js, job, what, runtime, OUT ? { keepDir: OUT, keepAs } : {});

try {
  chrome = await launchChrome({ profile: path.join(TMP, 'profile'), downloads: DL });
  ({ js, errors, requests } = chrome);
  if (noNativeArg) await disableNative(chrome.cdp);
  await open(PAGE);
  ok(errors.length === 0, 'the page starts without errors', errors.join(' | '));
  await checkNativeState(ok, js);
  await checkHasRules(ok, js);
  await open(PAGE);                    // the form as it was
  ok(await js(`document.documentElement.classList.contains('ib-local')`), 'from disk, the page builds installers itself');
  ok(/none, this page builds/.test(await js(`document.querySelector('.api-ctl-url').textContent`)), 'the footer says there is no build server');
  ok(await js(`getComputedStyle(document.getElementById('mode-ours').closest('label')).display === 'none' && document.getElementById('mode-unsigned').checked`),
    '"Signed by Installer Builder" is hidden and Unsigned is chosen');
  ok(await js(`getComputedStyle(document.getElementById('offline-on').closest('label')).display === 'none'`), 'packing runtimes is hidden');
  ok(await js(`getComputedStyle(document.getElementById('ts-on').closest('.online-only')).display === 'none'`), 'the timestamp relay is hidden');
  await checkSections(t, js);
  const rt = await ibRuntimes();
  ok(rt.includes('python') && rt.includes('python2'), 'the runtimes summary is in the page', rt.join(','));

  // One build through the form, as a person would.
  // Its code is main.py, which the default launch command must run.
  const ui = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello form', code: "print('hello from the form')\n" });
  await checkJob(ui, 'form', 'python', OUT && 'form');
  if (ui && ui.result) {
    const rec = await js(`ibLocalApi.request('/api/records/${ui.result.record}')`);
    ok(/^launch\t\{runtime\} \{app_dir\}\/main\.py$/m.test(rec), 'form: the launch command runs main.py', rec);
  }
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
  ok(false, 'offline run', e.stack || e);
} finally {
  if (chrome) await chrome.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${t.passed} passed, ${t.failed} failed`);
process.exit(t.failed ? 1 : 0);

async function ibRuntimes() {
  const r = await js(`ibLocalApi.request('/api/catalog/runtimes')`);
  return (r.runtimes || []).map((x) => x.id);
}
