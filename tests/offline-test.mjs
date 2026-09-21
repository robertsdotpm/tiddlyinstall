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
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './browsers/cdp.mjs';
import { Checker, STARTED, waitFor, checkSections, fetchBlob, buildHello as buildHelloIn, checkJob as checkJobIn } from './browsers/steps.mjs';
import { noNativeArg, disableNative, checkNativeState, checkHasRules } from './no-native-browser.mjs';
import { OFFLINE_TARGETS, OFFLINE_TARGET_OS, offlineField, ARCH_LABEL, ENTRY_DEFAULTS, packBudget, PACK_FLOOR_MB } from '../shared/form-job.js';
import { planPackFiles } from '../shared/builder.js';
import { parseFooterTail, readInstaller } from '../shared/tifile.js';
import { templateLaunch } from '../shared/templates.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.resolve(arg('--page') || path.join(HERE, '..', 'dist', 'index.html'));
const SITE = arg('--site');
const OUT = arg('--out');
if (typeof WebSocket === 'undefined' || !fs.existsSync(PAGE)) {
  console.log('usage: node --experimental-websocket tests/offline-test.mjs [--page dist/index.html] [--site URL] [--out DIR]');
  process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-offline-'));
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
  // The catalogue is unpacked a folder at a time, when something needs it:
  // not to start, nor for the runtimes summary (it is precomputed).
  await js(`tiLocalApi.request('/api/catalog/runtimes')`);
  ok(JSON.stringify(await js(`tiLocalApi.unpacked()`)) === '[]', 'starting and the runtimes summary unpack no catalogue folder', JSON.stringify(await js(`tiLocalApi.unpacked()`)));
  ok(await js(`document.documentElement.classList.contains('ti-local')`), 'from disk, the page builds installers itself');
  ok(/none, this page builds/.test(await js(`document.querySelector('.api-ctl-url').textContent`)), 'the footer says there is no build server');
  // And the header says it without being asked, on every page: the state
  // changes what the page can do, so it should never have to be looked up.
  // Opened from disk this is a fact, not a setting -- a saved copy has no
  // build server to be reachable or not.
  let ch = await chipState();
  ok(ch && ch.shown && ch.inHeader, 'the header carries the "where installers are built" indicator', JSON.stringify(ch));
  ok(ch && /\bwhere-page\b/.test(ch.cls) && ch.host === 'Built in this page' && ch.state === '',
    'from disk it says "Built in this page", with no reachable/not-reachable word to be wrong about', JSON.stringify(ch));
  ok(ch && /\bwhere-fixed\b/.test(ch.cls) && /saved copy/.test(ch.title),
    'and reads as a statement of fact, not a setting someone might change', ch && ch.title);
  ok(ch && ch.mark === 'rect,line', 'with a mark of its own, so it is not colour alone', ch && ch.mark);
  ok(await js(`(() => {
    const c = document.querySelector('.where-chip'), p = document.querySelector('.settings-panel');
    c.click(); const opened = !p.hidden && c.getAttribute('aria-expanded') === 'true';
    c.click(); return opened && p.hidden; })()`),
    'clicking it opens the one settings panel, and closes it again');
  ok(await js(`document.querySelectorAll('.where-chip').length === 1 && document.querySelectorAll('.api-ctl-input').length === 1`),
    'and there is still only one of it, and one build-server control');
  ok(await js(`getComputedStyle(document.getElementById('mode-ours').closest('label')).display === 'none' && document.getElementById('mode-unsigned').checked`),
    '"Signed by Installer Builder" is hidden and Unsigned is chosen');
  // Where a build happens, in plain words, before building (design.md 11.0 item 6).
  ok(await js(`[...document.querySelectorAll('.ti-page[data-page="new"] .build-where')].length >= 1 &&
    [...document.querySelectorAll('.ti-page[data-page="new"] .build-where')].every((p) => /^Built in this page:/.test(p.textContent))`),
    'the New installer form says "Built in this page"', await js(`(document.querySelector('.build-where') || {}).textContent`));
  // "Build for" starts as the computer the page is open on, with the other
  // two one tick away (web/new.js defaultTargetsToThisComputer). These runs
  // are on Linux, so Linux alone; the HTML keeps all three checked for
  // /classic, which has no JavaScript to narrow them.
  ok(await js(`(globalThis.tiCompat && tiCompat.env && tiCompat.env.os) === 'Linux'`),
    'the page knows which OS it is on', await js(`(globalThis.tiCompat && tiCompat.env || {}).os`));
  ok(await js(`document.querySelector('[name=target_linux]').checked
    && !document.querySelector('[name=target_windows]').checked
    && !document.querySelector('[name=target_macos]').checked`),
    '"Build for" defaults to this computer\'s system alone');
  ok(/^Set to Linux, the computer you are on\./.test(await js(`(document.getElementById('target-default-note') || {}).textContent || ''`)),
    'and says so, with how to add the others', await js(`(document.getElementById('target-default-note') || {}).textContent`));
  // Ticking one of them for yourself retires the note, and does not undo
  // the others: the default is a starting point, not a mode.
  await js(`document.querySelector('[name=target_windows]').click()`);
  ok(await js(`!document.getElementById('target-default-note')
    && document.querySelector('[name=target_windows]').checked
    && document.querySelector('[name=target_linux]').checked`),
    'choosing for yourself drops the note and keeps both');
  await js(`document.querySelector('[name=target_windows]').click()`);   // back as it was
  // Packing the runtimes is offered with no build server: what a browser
  // can hold was measured on every machine we have rather than assumed
  // (docs/browser-packing.md). It used to be hidden here.
  ok(await js(`getComputedStyle(document.getElementById('offline-on').closest('label')).display !== 'none' &&
    !document.getElementById('offline-on').disabled`), 'packing runtimes is offered with no build server');
  ok(await js(`getComputedStyle(document.getElementById('ts-on').closest('.online-only')).display === 'none'`), 'the timestamp relay is hidden');
  // Signing services whose API a browser can't call go through the build
  // server's relay, so offline they don't exist (docs/browser-signing.md 3).
  ok(await js(`(() => { const s = document.getElementById('svc-name');
    return !!s && s.options.length >= 4 && ![].some.call(s.options, (o) => o.value === 'azurets'); })()`),
    'the relayed signing services are not offered', await js(`[].map.call(document.getElementById('svc-name').options, (o) => o.value).join(',')`));
  await checkLaunchField();
  await checkArchitecture();
  const sections = await checkSections(t, js);
  await checkPanelReachable(sections);
  const rt = await tiRuntimes();
  ok(rt.includes('python') && rt.includes('python2'), 'the runtimes summary is in the page', rt.join(','));

  // One build through the form, as a person would.
  // Its code is main.py, which the default launch command must run.
  const ui = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello form', code: "print('hello from the form')\n" });
  await checkJob(ui, 'form', 'python', OUT && 'form');
  // The build page says where that job was built, in its heading and with
  // its downloads; the job carries it, so the page's own setting isn't asked.
  await waitFor(js, `document.getElementById('job-where').textContent === 'Built in this page.'`, 'the build page to say where it was built', 15000, errors);
  ok(true, 'the build page says the job was built in this page');
  ok(/built in this page/.test(await js(`document.getElementById('job-built').textContent`)),
    'the downloads say the installers were built in this page', await js(`document.getElementById('job-built').textContent`));
  ok(await js(`tiLocalApi.request('/api/jobs/' + ${JSON.stringify(ui.id)}).then((j) => j.result.built.where)`) === 'page',
    'the job result records where it was built');
  ok(JSON.stringify(await js(`tiLocalApi.unpacked()`)) === '["python"]', 'a Python build unpacks only the python folder', JSON.stringify(await js(`tiLocalApi.unpacked()`)));
  if (ui && ui.result) {
    const rec = await js(`tiLocalApi.request('/api/records/${ui.result.record}')`);
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
        let j = await tiLocalApi.request('/api/jobs', { method: 'POST', body: ${JSON.stringify(body)} });
        while (j.status !== 'done' && j.status !== 'failed') {
          await new Promise((r) => setTimeout(r, 100));
          j = await tiLocalApi.request('/api/jobs/' + j.id);
        }
        return j;
      })()`);
      const files = await checkJob(job, `${runtime} ${mode}`, runtime, OUT && `${runtime}/${mode}`);
      if (files) builds[`${runtime}/${mode}`] = { status: 'done', record: job.result.record, files };
    }
  }
  // Mode A is refused here, with a clear message.
  const a = await js(`tiLocalApi.request('/api/jobs', { method: 'POST', body: { runtime: 'python', mode: 'A', source: { kind: 'inline' }, files: { 'a/__main__.py': 'x' } } }).then(() => 'accepted', (e) => e.message)`);
  ok(/build server/.test(a), 'mode A is refused offline', a);
  const gh = await js(`tiLocalApi.request('/api/jobs', { method: 'POST', body: { runtime: 'python', mode: 'C', source: { kind: 'github', value: 'psf/requests' } } }).then(() => 'accepted', (e) => e.message)`);
  ok(/build server/.test(gh), 'GitHub sources are refused offline, saying why', gh);

  const outside = requests.filter((u) => !/^(file|blob|data):/.test(u));
  ok(outside.length === 0, 'nothing was fetched from the network', outside.slice(0, 5).join(' '));

  // Everything above this line is an installer that downloads its runtime
  // when it runs, and fetches nothing while it is built. Packing is the
  // one thing here that does reach the network, and only to our mirror.
  await checkPacking();

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
    ok(/^Built in this page:/.test(await js(`document.querySelector('.ti-page[data-page="new"] .build-where').textContent`)),
      'the saved copy still says "Built in this page"', await js(`document.querySelector('.build-where').textContent`));
    ch = await chipState();
    ok(ch && /\bwhere-page where-fixed\b/.test(ch.cls) && ch.host === 'Built in this page' && /saved copy/.test(ch.title),
      'and the saved copy\'s header says so as a fact, on every page of it', JSON.stringify(ch));
    const job = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello again', code: "print('hello')\n", platforms: ['linux'] });
    await checkJob(job, 'saved copy', 'python');
    await waitFor(js, `document.getElementById('job-where').textContent === 'Built in this page.'`, 'the saved copy\'s build page to say the same', 15000, errors);
    ok(true, 'the saved copy\'s build page says the same');
  }
  await checkWhereStates();
  await checkHoverColours();
  if (OUT) fs.writeFileSync(path.join(OUT, 'builds.json'), JSON.stringify(builds, null, 1));

  if (SITE) {
    // The same file, served by a build server: it uses the server.
    await open(SITE.replace(/\/$/, '') + '/');
    ok(errors.length === 0, 'served: the page starts without errors', errors.join(' | '));
    ok(!await js(`document.documentElement.classList.contains('ti-local')`), 'served: the page uses the build server');
    ok(await js(`getComputedStyle(document.getElementById('mode-ours').closest('label')).display !== 'none' &&
      document.getElementById('mode-ours').disabled && document.getElementById('mode-unsigned').checked`),
      'served: "Signed by TiddlyInstall" is shown but off, and Unsigned is chosen');
    ok(await js(`/^Built by the build server at /.test(document.querySelector('.ti-page[data-page="new"] .build-where').textContent)`),
      'served: the form says the build server builds it', await js(`document.querySelector('.build-where').textContent`));
    const rts = await js(`fetch('/api/catalog/runtimes').then(r => r.ok)`);
    ok(rts, 'served: the server answers the page');
    // Served by a build server that answered the same-origin probe: the
    // header names it, and shows it as reachable because it was asked.
    ch = await chipState();
    ok(ch && /\bwhere-up\b/.test(ch.cls) && ch.host === 'Build server ' + SITE.replace(/^https?:\/\//, '').replace(/\/$/, '') &&
      /reachable$/.test(ch.state) && ch.mark === 'circle,polyline',
      'served: the header names the build server and shows it as reachable', JSON.stringify(ch));
    await js(`document.querySelector('.where-chip').click(); document.querySelector('.api-ctl-local').click()`);
    ch = await chipState();
    ok(ch && /\bwhere-page\b/.test(ch.cls) && !/\bwhere-fixed\b/.test(ch.cls) && ch.host === 'Built in this page',
      'served: choosing "No server" moves the header to "Built in this page" at once, as a choice and not a fact', JSON.stringify(ch));
    ok(await js(`document.documentElement.classList.contains('ti-local') && document.getElementById('mode-unsigned').checked`),
      'served: "No server" switches to building in the page, on Unsigned');
    ok(await js(`/^Built in this page:/.test(document.querySelector('.ti-page[data-page="new"] .build-where').textContent)`),
      'served: the wording follows the change to "No server"', await js(`document.querySelector('.build-where').textContent`));
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

/* ---------- the header, after the spanner and the theme button ---------- */

// The indicator is now the only way into the settings panel, and the panel
// is the only way to change or clear the build server. So it has to open
// from every page, not just the one that happened to be open -- including
// Sources, which had no header controls at all as a separate page.
async function checkPanelReachable(sections) {
  ok(await js(`!document.querySelector('.settings-btn') && !document.querySelector('.api-ctl-edit')`),
    'the settings spanner is gone');
  ok(await js(`!document.getElementById('theme-btn') && !document.querySelector('.theme-btn')`),
    'and so is the theme button');
  ok(!await js(`!!document.documentElement.getAttribute('data-theme')`),
    'nothing sets data-theme any more: the page follows prefers-color-scheme',
    await js(`document.documentElement.getAttribute('data-theme')`));
  const bad = [];
  for (const p of sections) {
    await js(`location.hash = '#' + ${JSON.stringify(p)}`);
    await sleep(150);
    const r = await js(`(() => {
      const c = document.querySelector('.site-header .where-chip'), panel = document.querySelector('.settings-panel');
      if (!c || !panel) return 'no chip or panel';
      c.click();
      const open = !panel.hidden && !!document.querySelector('.api-ctl-input');
      document.querySelector('.api-ctl-cancel').click();
      return open && panel.hidden ? '' : 'panel did not open and close'; })()`);
    if (r) bad.push(p + ': ' + r);
  }
  ok(!bad.length, 'and the settings panel opens from the indicator on every page', bad.join('; '));
  await js(`location.hash = '#home'`);
  await sleep(150);
}

// Hovering must not change what the chip is saying. The generic
// `button:hover` paints an accent-coloured button, and the chip is a
// button, so without its own hover colour the words went unreadable --
// found by a person in ten seconds, by no test at all.
async function checkHoverColours() {
  const at = async (sel) => {
    const [x, y] = await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();
      return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
    await chrome.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await sleep(120);
    return js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      const cs = getComputedStyle(e);
      return { hovered: e.matches(':hover'), color: cs.color, bg: cs.backgroundColor,
        state: getComputedStyle(e.querySelector('.where-state') || e).color }; })()`);
  };
  const away = () => chrome.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 400, button: 'none' });
  // A token's value as the browser resolves it, so it can be compared with
  // a computed colour (getPropertyValue gives the hex it was written as).
  const token = (v) => js(`(() => { const e = document.createElement('span');
    e.style.color = 'var(' + ${JSON.stringify(v)} + ')';
    document.body.appendChild(e); const c = getComputedStyle(e).color; e.remove(); return c; })()`);
  const was = await js(`(() => { const c = document.querySelector('.where-chip');
    return [c.className, c.querySelector('.where-state').textContent]; })()`);
  const bad = [];
  for (const theme of ['dark', 'light']) {
    await js(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    const accentText = await token('--accent-text');
    const accentHover = await token('--accent-hover');
    // Every state, since each sets its own colour and each had to restate
    // it on hover. The class is what the CSS keys on, so setting it is
    // enough to put the chip in that state for a style question.
    for (const state of ['page', 'up', 'down', 'unknown']) {
      await js(`(() => { const c = document.querySelector('.where-chip');
        c.className = 'where-chip where-' + ${JSON.stringify(state)};
        c.querySelector('.where-state').textContent = 'reachable'; })()`);
      await away();
      const rest = await js(`(() => { const e = document.querySelector('.where-chip');
        return { color: getComputedStyle(e).color, state: getComputedStyle(e.querySelector('.where-state')).color }; })()`);
      const hot = await at('.site-header .where-chip');
      const where = theme + '/' + state;
      if (!hot.hovered) bad.push(where + ': not hovered at all');
      else if (hot.color !== rest.color || hot.state !== rest.state) bad.push(where + ': ' + JSON.stringify({ rest, hot }));
      else if (hot.color === accentText) bad.push(where + ': accent-text ' + hot.color);
    }
    // The menu button is the other button in the header and has no accent
    // style of its own either, so it is open to the same trap. It only
    // shows on a narrow window -- a narrow one with a mouse, since a
    // coarse pointer has no hover to measure.
    await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: 400, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const shows = await js(`!!document.querySelector('.ti-menu-btn') && document.querySelector('.ti-menu-btn').getClientRects().length > 0`);
    ok(shows, theme + ': the menu button shows at 400 px (else the next check proves nothing)');
    if (shows) {
      await away();
      const m = await at('.ti-menu-btn');
      ok(m.hovered && m.color !== accentText && m.bg !== accentHover,
        theme + ': hovering the menu button does not paint it with the accent', JSON.stringify({ m, accentText, accentHover }));
    }
    await chrome.cdp('Emulation.clearDeviceMetricsOverride');
    await sleep(150);
    await away();
  }
  ok(!bad.length, 'hovering the indicator never changes the colour it is saying things in, in either theme', bad.join(' | '));
  await js(`(() => { document.documentElement.removeAttribute('data-theme');
    const c = document.querySelector('.where-chip');
    c.className = ${JSON.stringify(was[0])};
    c.querySelector('.where-state').textContent = ${JSON.stringify(was[1])}; })()`);
}

/* ---------- where installers are built, in the header ---------- */

// Everything the indicator is saying, in one read.
function chipState() {
  return js(`(() => {
    const c = document.querySelector('.where-chip');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const b = document.querySelector('.api-banner');
    return {
      cls: c.className,
      host: c.querySelector('.where-host').textContent,
      state: c.querySelector('.where-state').textContent,
      mark: Array.prototype.map.call(c.querySelectorAll('.where-mark svg > *'), (e) => e.tagName).join(','),
      title: c.title,
      label: c.getAttribute('aria-label'),
      inHeader: !!c.closest('.site-header'),
      shown: r.width > 0 && r.height > 0,
      banner: !!(b && !b.hidden),
      bannerUrl: b ? b.querySelector('.api-url').textContent : ''
    };
  })()`);
}

// A build server that answers, so the three states a server can be in can
// be driven for real from a page opened off the disk. It replies to the
// two calls the page makes on its own: the health check, and the runtimes
// summary -- which it serves back exactly as this page's own builder gave
// it, so the form has a catalogue it recognises.
function startStub(runtimes) {
  const srv = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const p = req.url.split('?')[0];
    const body = p === '/api/catalog/runtimes' ? runtimes : { ok: true };
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, cors));
    res.end(JSON.stringify(body));
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res(srv)));
}

// The states a build server can be in, each reached the way a person
// reaches it -- through the settings panel -- and each read off the header.
// The one that matters most is the first: probeSameOrigin only ever asks
// this page's own origin, so a server typed in by hand has not been
// checked, and a tick there would be a lie the rest of the page would then
// be believed on.
async function checkWhereStates() {
  await open(PAGE);
  const runtimes = await js(`tiLocalApi.request('/api/catalog/runtimes')`);
  const srv = await startStub(runtimes);
  const url = 'http://127.0.0.1:' + srv.address().port;
  try {
    // 1. Typed in, not yet asked. Read in the same turn as the change, so
    //    no answer can have come back yet: this is the honest "unknown".
    const typed = await js(`(() => {
      document.querySelector('.where-chip').click();
      document.querySelector('.api-ctl-input').value = ${JSON.stringify(url)};
      document.querySelector('.api-ctl-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const c = document.querySelector('.where-chip'), b = document.querySelector('.api-banner');
      return { cls: c.className, host: c.querySelector('.where-host').textContent, state: c.querySelector('.where-state').textContent,
        mark: Array.prototype.map.call(c.querySelectorAll('.where-mark svg > *'), (e) => e.tagName).join(','),
        title: c.title, banner: !!(b && !b.hidden) }; })()`);
    ok(/\bwhere-unknown\b/.test(typed.cls) && /not checked$/.test(typed.state),
      'a build server nobody has asked shows as not checked, never as reachable', JSON.stringify(typed));
    ok(typed.host === 'Build server 127.0.0.1:' + srv.address().port, 'and is named by its host', typed.host);
    ok(typed.mark === 'circle,text', 'with a mark of its own (a dashed ring and a question mark)', typed.mark);
    ok(!typed.banner, 'and no outage banner: not checked is not the same as not reachable');

    // 2. It answers. Only now does the tick appear.
    await waitFor(js, `/\\bwhere-up\\b/.test(document.querySelector('.where-chip').className)`,
      'the indicator to turn to reachable once the server answers', 30000, errors);
    let s = await chipState();
    ok(/reachable$/.test(s.state) && !/not reachable/.test(s.state) && s.mark === 'circle,polyline',
      'once it has answered, the same server is shown as reachable, with a tick', JSON.stringify(s));
    ok(s.host === 'Build server 127.0.0.1:' + srv.address().port && !s.banner,
      'still named, still no banner', JSON.stringify(s));

    // 3. It stops. The indicator and the banner must say the same thing
    //    about the same server: two of them disagreeing would be worse
    //    than one. Re-choosing the server is what sends the next request.
    srv.closeAllConnections();
    await new Promise((res) => srv.close(res));
    await js(`(() => { document.querySelector('.where-chip').click();
      document.querySelector('.api-ctl-input').value = ${JSON.stringify(url)};
      document.querySelector('.api-ctl-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); })()`);
    await waitFor(js, `/\\bwhere-down\\b/.test(document.querySelector('.where-chip').className)`,
      'the indicator to turn to not reachable', 40000, errors);
    s = await chipState();
    ok(/not reachable$/.test(s.state) && s.mark === 'circle,line,line',
      'a build server that cannot be reached says so, with a cross', JSON.stringify(s));
    ok(s.banner && s.bannerUrl === url, 'and the banner agrees, about the same server', JSON.stringify(s));

    // 4. And it survives the change back, without waiting for anything.
    const back = await js(`(() => {
      document.querySelector('.where-chip').click();
      document.querySelector('.api-ctl-local').click();
      const c = document.querySelector('.where-chip'), b = document.querySelector('.api-banner');
      return { cls: c.className, host: c.querySelector('.where-host').textContent,
        mark: Array.prototype.map.call(c.querySelectorAll('.where-mark svg > *'), (e) => e.tagName).join(','),
        banner: !!(b && !b.hidden), local: document.documentElement.classList.contains('ti-local') }; })()`);
    ok(/\bwhere-page\b/.test(back.cls) && back.host === 'Built in this page' && back.mark === 'rect,line' && back.local,
      '"No server" puts the header back to "Built in this page" in the same turn', JSON.stringify(back));
    ok(!back.banner, 'and takes the banner down with it');
  } finally {
    try { srv.closeAllConnections(); srv.close(); } catch (e) { /* already closed */ }
    await js(`localStorage.clear(); sessionStorage.clear()`);
  }
}

// How the app starts: the one field a publisher must get right, because
// it is the one thing about a project that cannot be inferred. It is in
// the main form now, and the form says how much we actually know. The
// edited-versus-default distinction is what the GUI Python bug turned on,
// so it is checked through the real form rather than through the mapping
// alone (server/test/form.test.js covers that side).
async function checkLaunchField() {
  await js(`location.hash = '#new'`);
  await sleep(300);
  // Visible without opening anything, and not inside a collapsed section.
  const where = await js(`(() => { const e = document.querySelector('.ti-page[data-page="new"] #launch-field');
    if (!e) return null;
    let d = e.closest('details');
    return { shown: !!e.getClientRects().length, inDetails: !!d,
      label: (e.parentNode.querySelector('.label') || {}).textContent || '' }; })()`);
  ok(where && where.shown && !where.inDetails, 'the launch command is in the main form, on screen, not behind a details',
    JSON.stringify(where));

  // Set the form up and read back what the launch field is showing.
  const at = (o) => js(`(async () => {
    const f = document.getElementById('new-form');
    const s = ${JSON.stringify(o)};
    if (s.kind) for (const r of f.elements.source_kind) r.checked = r.value === s.kind;
    if (s.runtime) f.elements.runtime.value = s.runtime;
    if (s.source !== undefined) f.elements.source.value = s.source;
    if (s.tpl) { const b = document.getElementById('tpl-' + s.tpl); if (b) b.checked = true; }
    if (s.type !== undefined) { const e = f.elements['entry_' + f.elements.runtime.value]; e.value = s.type; }
    f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const e = f.elements['entry_' + f.elements.runtime.value];
    const why = [...document.querySelectorAll('.ti-page[data-page="new"] .launch-why')]
      .filter((p) => p.getClientRects().length).map((p) => p.textContent.replace(/\\s+/g, ' ').trim());
    return { value: e.value, def: e.defaultValue, edited: e.value !== e.defaultValue,
      quiet: document.getElementById('launch-field').classList.contains('launch-quiet'),
      why: why.join(' '),
      eg: document.getElementById('launch-example').textContent.replace(/\\s+/g, ' ').trim() };
  })()`);

  // A GitHub repo: we cannot know, so it asks loudly and says why.
  let g = await at({ kind: 'repo', runtime: 'python', source: 'https://github.com/psf/requests' });
  ok(!g.quiet, 'a GitHub repo gets the prominent launch field', JSON.stringify(g));
  ok(/Nothing in a repo says how to run it/.test(g.why), 'and says why it cannot be worked out', g.why);
  ok(g.value === ENTRY_DEFAULTS.python && !g.edited, 'with the language default, unedited', JSON.stringify(g));
  // The example expands the tokens for the chosen name and platform.
  ok(/for a project called .requests./.test(g.eg) && /-m requests/.test(g.eg),
    'the example expands {project} to the repo being packaged', g.eg);
  ok(/\{runtime\} is the Python 3 this installer sets up/.test(g.eg),
    'and explains only the tokens the command actually uses', g.eg);

  // A package from a registry: the default comes from the registry, so the
  // same field is present but quieter.
  const pk = await at({ kind: 'repo', runtime: 'python', source: 'requests' });
  ok(pk.quiet, 'a package from a registry gets the quiet launch field', JSON.stringify(pk));
  ok(/the registry says which program the package installs/.test(pk.why), 'and says why the default is usually right', pk.why);

  // An upload: we have the files but nothing says which one starts it.
  const up = await at({ kind: 'local', runtime: 'rust' });
  ok(!up.quiet, 'an upload gets the prominent launch field', JSON.stringify(up));
  ok(/Nothing in a folder of files says which one starts the app/.test(up.why), 'and says why', up.why);
  ok(/target\/release\/myapp|target\\release\\myapp/.test(up.eg), 'the example expands {app_dir} for a compiled language', up.eg);

  // Written here: we wrote the template, so the field shows the command
  // that template really starts with -- not the language default, which is
  // what used to be shown while something else ran.
  const tray = templateLaunch('node', 'tray');
  const w = await at({ kind: 'write', runtime: 'node', tpl: 'tray' });
  ok(w.quiet, 'a written app gets the quiet launch field', JSON.stringify(w));
  ok(w.value === tray, 'and the field shows the template\'s own launch command', JSON.stringify([w.value, tray]));
  ok(!w.edited, 'which still counts as untouched, so the template stays in charge', JSON.stringify(w));
  ok(/it starts main\.js/.test(w.why), 'and it names the file that starts', w.why);

  // Typing makes it an edit, and an edit survives changing the template.
  const typed = '{runtime} {app_dir}/other.js --flag';
  let e = await at({ type: typed });
  ok(e.value === typed && e.edited, 'typing in it counts as an edit', JSON.stringify(e));
  e = await at({ tpl: 'script' });
  ok(e.value === typed && e.edited, 'and the edit survives switching template', JSON.stringify(e));
  // Going back to a repo restores that language's default, not the last
  // template's -- but only because the field was put back first.
  await at({ type: templateLaunch('node', 'script') });
  const back = await at({ kind: 'repo', runtime: 'node', source: 'owner/thing' });
  ok(back.value === ENTRY_DEFAULTS.node && !back.edited, 'an untouched field returns to the language default', JSON.stringify(back));

  // End to end: an edited command is what the installer is built with.
  const edited = "{runtime} {app_dir}/main.py --started-by-the-form";
  const job = await js(`(async () => {
    const f = document.getElementById('new-form');
    location.hash = '#new&write';
    await new Promise((r) => setTimeout(r, 250));
    for (const r of f.elements.source_kind) r.checked = r.value === 'write';
    f.elements.runtime.value = 'python';
    f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('tpl-script').checked = true;
    for (const r of f.elements.mode) r.checked = r.value === 'unsigned';
    f.elements.app_name.value = 'Hello launch';
    f.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    f.elements.entry_python.value = ${JSON.stringify(edited)};
    f.elements.entry_python.dispatchEvent(new Event('input', { bubbles: true }));
    f.querySelector('button[type="submit"]').click();
    for (let i = 0; i < 600 && !/^#build&job=/.test(location.hash); i++) {
      const err = f.querySelector('.form-error');
      if (err && !err.hidden && err.textContent) return { error: err.textContent };
      await new Promise((r) => setTimeout(r, 100));
    }
    const id = new URLSearchParams(location.hash.slice(1)).get('job');
    for (let i = 0; i < 1200; i++) {
      const j = await tiLocalApi.request('/api/jobs/' + id);
      if (j.status === 'done' || j.status === 'failed') return j;
      await new Promise((r) => setTimeout(r, 100));
    }
    return { error: 'timed out' };
  })()`);
  ok(job && job.status === 'done', 'an installer builds with an edited launch command', JSON.stringify(job).slice(0, 300));
  if (job && job.result) {
    const rec = await js(`tiLocalApi.request('/api/records/${job.result && job.result.record}')`);
    ok(rec.indexOf('\nlaunch\t' + edited + '\n') >= 0,
      'and the record carries exactly what was typed, not the template\'s', String(rec).slice(0, 400));
  }
  // Put the form back for the checks after this one.
  await js(`(() => { const f = document.getElementById('new-form'); f.reset();
    f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(250);
}

// 32-bit and 64-bit, made explicit (docs/format.md section 3, "32-bit and
// 64-bit, said plainly"). An ordinary installer is not built for one
// architecture, so the form states what is covered; only a pack has to
// choose, so only there is it a tick with a size. Nothing here asserts a
// fixed answer for 32-bit Linux -- which runtimes have one is the
// resolver's to say, and it changes -- only that every screen agrees with
// the resolver and with itself.
async function checkArchitecture() {
  await js(`location.hash = '#new'`);
  await sleep(300);
  const cover = (rt) => js(`(async () => {
    const f = document.getElementById('new-form');
    f.elements.runtime.value = ${JSON.stringify(rt)};
    f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
    f.elements.offline.checked = true;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const per = {};
    for (const li of document.querySelectorAll('#arch-cover li[data-family]')) {
      per[li.dataset.family] = [...li.querySelectorAll('.arch-cover-arches > li')].map((x) => x.textContent.trim());
    }
    const boxes = {};
    for (const b of document.querySelectorAll('#offline-targets input[type=checkbox]')) {
      const lab = b.closest('label');
      boxes[b.name] = { disabled: b.disabled, checked: b.checked, text: lab.textContent.replace(/\\s+/g, ' ').trim() };
    }
    return { per, boxes, size: document.getElementById('offline-size').textContent,
      warn: document.getElementById('offline-warn').hidden ? '' : document.getElementById('offline-warn').textContent };
  })()`);

  const py = await cover('python');
  ok(py.per.windows && py.per.windows.length >= 3, 'the form lists what each platform covers, per architecture', JSON.stringify(py.per));
  ok(py.per.windows.some((l) => /^32-bit \(x86\): Python/.test(l)), 'Windows 32-bit is covered, and named', JSON.stringify(py.per.windows));
  ok(py.per.macos.some((l) => /^32-bit: Apple dropped 32-bit support in macOS 10\.15/.test(l)),
    'macOS 32-bit is a stated fact with its reason, not an empty list', JSON.stringify(py.per.macos));
  ok(py.per.linux.some((l) => /^musl \(Alpine\):/.test(l)),
    'musl is answered separately from glibc, because it is a separate answer', JSON.stringify(py.per.linux));
  ok(!/^Nothing/.test(await js(`document.getElementById('arch-cover-note').textContent`)) &&
    /nothing to choose here/.test(await js(`document.getElementById('arch-cover-note').textContent`)),
    'the form says an online installer covers them all and picks on the machine');

  // Every target and architecture in shared/form-job.js has a box, and the box
  // is greyed out with a reason exactly when the form says there is no
  // build. The two must not be able to disagree.
  for (const rt of ['python', 'node', 'go']) {
    const c = rt === 'python' ? py : await cover(rt);
    for (const tgt of OFFLINE_TARGETS) {
      for (const a of tgt.arches) {
        const b = c.boxes[offlineField(tgt.id, a.arch)];
        if (!b) { ok(false, `${rt}: a box for ${tgt.id} ${a.arch}`); continue; }
        const line = (c.per[tgt.platform] || []).find((l) => l.indexOf(ARCH_LABEL[a.arch] + ':') === 0 ||
          (tgt.platform === 'macos' && l.indexOf((a.arch === 'amd64' ? '64-bit Intel' : 'Apple Silicon') + ':') === 0));
        const noBuild = !!line && /no build of/.test(line);
        ok(b.disabled === noBuild, `${rt} ${tgt.id} ${a.arch}: the packed box agrees with what the form says is covered`,
          JSON.stringify([line, b]));
        ok(b.disabled ? /no build of/.test(b.text) : /\d+ MB/.test(b.text),
          `${rt} ${tgt.id} ${a.arch}: the box shows its size, or why there is none`, b.text);
      }
    }
  }
  // A 32-bit build years behind the 64-bit one has to be visible at the
  // tick, not discovered after building (Node's newest 32-bit Linux is
  // 9.11.2, from 2018).
  const node = await cover('node');
  const nl = (node.per.linux || []).find((l) => /^32-bit \(x86\):/.test(l)) || '';
  if (/no build of/.test(nl)) {
    ok(true, 'Node.js has no 32-bit Linux build in this catalogue, and the form says so', nl);
  } else {
    ok(/the newest 32-bit build there is\. Node\.js reaches [\d.]+ on Linux otherwise\./.test(nl),
      'a 32-bit build behind the rest says so where it is chosen', nl);
    ok(/Packs Node\.js [\d.]+ .* the newest 32-bit build there is/.test(node.boxes[offlineField('linux', 'x86')].text),
      'and the packed box names the version it would pack', node.boxes[offlineField('linux', 'x86')].text);
  }
  // One running total over systems and architectures, and it moves when an
  // architecture is ticked (the same mechanism the warning and the zip use).
  ok(/^About \d+ MB of packed files, over \d+ systems? and architectures?/.test(node.size), 'the picker adds up what is ticked', node.size);
  const mb = (s0) => Number(/About (\d+) MB/.exec(s0)[1]);
  const after = await js(`(async () => { const f = document.getElementById('new-form');
    f.elements[${JSON.stringify(offlineField('win_1011', 'x86'))}].checked = true;
    f.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    return document.getElementById('offline-size').textContent; })()`);
  const want = OFFLINE_TARGETS[0].arches.find((a) => a.arch === 'x86').mb;
  ok(mb(after) === mb(node.size) + want, 'ticking 32-bit Windows adds its own runtime to the total', node.size + ' -> ' + after);
  // The zip is the same picker's escape hatch, not a second one.
  ok(await js(`!!document.getElementById('offline-shape-zip') && document.getElementById('offline-shape-single').checked`),
    'the packed picker offers the zip, with one file as the default');
  // Put the form back.
  await js(`(() => { const f = document.getElementById('new-form'); f.reset();
    f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(200);
}

async function tiRuntimes() {
  const r = await js(`tiLocalApi.request('/api/catalog/runtimes')`);
  return (r.runtimes || []).map((x) => x.id);
}

/* ---------- packing the runtimes in, with no build server ---------- */

// docs/browser-packing.md measured what a browser can do and this is the
// feature built on it. Four things are checked here, in the page:
//
//   - the form says which side of the line this browser and this choice of
//     systems are on, before the build rather than after the failure;
//   - a pack over the budget is refused, before anything is fetched;
//   - the installers are built one at a time and handed over as each one
//     is finished, and the previous build's object URLs are let go;
//   - the finished file's own footer is read back out of the Blob and
//     agrees with what was written.
//
// The last one needs our mirror, because a pack is the runtime's real
// bytes. Where the mirror cannot be reached the build is not attempted and
// the run says so loudly rather than passing quietly; --pack-required
// makes that a failure (for a run where the mirror is meant to be up).
async function checkPacking() {
  checkBudgetRule();
  checkTargetMapping();
  await js(`location.hash = '#new'`);
  await sleep(300);
  const set = (o) => js(`(async () => {
    const f = document.getElementById('new-form');
    const s = ${JSON.stringify(o)};
    for (const p of ['windows', 'linux', 'macos']) f.elements['target_' + p].checked = s.platforms.indexOf(p) >= 0;
    f.elements.offline.checked = !!s.offline;
    for (const t of ${JSON.stringify(OFFLINE_TARGETS)}) for (const a of t.arches) {
      const b = f.elements['offline_' + t.id + '_' + a.arch];
      if (b) b.checked = (s.targets || []).indexOf(t.id + '_' + a.arch) >= 0;
    }
    f.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    const w = document.getElementById('offline-where');
    return { text: w ? w.textContent : '', cls: w ? w.className : '', shown: !!(w && w.getClientRects().length) };
  })()`);

  // Inside the line: it says where it will be packed and what this browser
  // is good for, with the mirror rule as a fact about the choice.
  const small = await set({ platforms: ['linux'], offline: true, targets: ['linux_amd64'] });
  ok(small.shown && /^Packed in this browser\./.test(small.text), 'the form says a pack this size is made here', small.text);
  ok(/this browser is good for \d+ MB in one file, because /.test(small.text),
    'and says what this browser is good for, and why', small.text);
  ok(/Only files our mirror holds can be packed here/.test(small.text),
    'and states the mirror rule as a fact about the choice', small.text);

  // Outside it. TI_PACK_MB only ever lowers the budget, so this is the
  // same refusal a small machine gets, on a machine that is not small.
  await js(`globalThis.TI_PACK_MB = 4`);
  const big = await set({ platforms: ['linux'], offline: true, targets: ['linux_amd64'] });
  const picker = await js(`typeof globalThis.showSaveFilePicker === 'function' || typeof globalThis.showDirectoryPicker === 'function'`);
  if (picker) {
    ok(/written straight to a file/.test(big.text) && /more than the 4 MB this browser will hold in memory/.test(big.text),
      'over the limit, with a save picker: it says it will write the file as it is made', big.text);
  } else {
    ok(/^Too big to pack in this browser/.test(big.text) && /Untick systems or architectures/.test(big.text),
      'over the limit, with no save picker: it says so and what would fix it', big.text);
  }

  // And the build refuses, before fetching anything.
  const before = requests.length;
  const refused = await js(`(async () => {
    let j = await tiLocalApi.request('/api/jobs', { method: 'POST', body: ${JSON.stringify(packBody(['linux'], ['linux_amd64']))} });
    for (let i = 0; i < 200 && j.status !== 'done' && j.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      j = await tiLocalApi.request('/api/jobs/' + j.id);
    }
    return { status: j.status, error: j.error };
  })()`);
  ok(refused.status === 'failed' && /the limit here is 4 MB/.test(refused.error),
    'a pack over the limit is refused, saying the limit and why', JSON.stringify(refused));
  ok(/Untick some systems or architectures/.test(refused.error), 'and what would make it possible', refused.error);
  const fetchedWhileRefusing = requests.slice(before).filter((u) => /^https?:/.test(u));
  ok(fetchedWhileRefusing.length === 0, 'and nothing was fetched before refusing', fetchedWhileRefusing.join(' '));
  await js(`delete globalThis.TI_PACK_MB`);

  // The real thing, which needs the mirror.
  if (!await mirrorReachable()) {
    console.log('SKIP a real pack: our mirror did not answer, so there is nothing to pack from');
    if (process.argv.includes('--pack-required')) ok(false, 'our mirror answers, so a pack can be built');
    return;
  }
  const job = await js(`(async () => {
    let j = await tiLocalApi.request('/api/jobs', { method: 'POST', body: ${JSON.stringify(packBody(['linux', 'macos'], ['linux_amd64', 'mac_arm64']))} });
    const partials = [];
    for (let i = 0; i < 6000 && j.status !== 'done' && j.status !== 'failed'; i++) {
      await new Promise((r) => setTimeout(r, 200));
      j = await tiLocalApi.request('/api/jobs/' + j.id);
      const n = (j.result && j.result.files || []).length;
      if (j.status === 'running' && n && n > partials.length) partials.push(j.result.files[n - 1].name);
    }
    j.partials = partials;
    return j;
  })()`);
  ok(job.status === 'done', 'a packed installer builds in the page', JSON.stringify({ e: job.error, p: job.progress }).slice(0, 300));
  if (job.status !== 'done') return;
  // Handed over as each one was finished: with two platforms the first
  // download exists while the second is still being packed. This is what
  // makes the ceiling the largest single installer and not the sum.
  ok(job.partials.length >= 1, 'each installer is handed over as it is built, not all at the end', JSON.stringify(job.partials));
  const files = job.result.files;
  ok(files.length === 2 && files.every((f) => f.offline), 'both platforms came out, marked as offline installers',
    JSON.stringify(files.map((f) => [f.platform, f.size, f.offline])));
  for (const f of files) {
    const seen = await js(`(async () => {
      const b = await (await fetch(${JSON.stringify(f.url)})).blob();
      const tail = new Uint8Array(await b.slice(b.size - 64).arrayBuffer());
      let hex = '';
      for (const x of tail) hex += x.toString(16).padStart(2, '0');
      return { size: b.size, tail: hex };
    })()`);
    ok(seen.size === f.size, `${f.platform}: the file reads back at the length it was built`, seen.size + ' of ' + f.size);
    const tail = Buffer.from(seen.tail, 'hex');
    if (f.platform === 'macos') {
      ok(tail.length === 64, 'macos: the zip reads its own last bytes back');   // a zip has no footer
    } else {
      const foot = parseFooterTail(new Uint8Array(tail));
      ok(foot && foot.pack > 0 && foot.record > 0, `${f.platform}: the footer read back out of the finished file is a footer`, JSON.stringify(foot));
    }
  }
  // The whole point, checked against the file itself: a real plan, and in
  // the pack exactly the files that plan's ticked blocks name, plus the
  // app's own source. Nothing here is taken on the builder's word.
  const lin = files.find((f) => f.platform === 'linux');
  if (lin) {
    const data = await fetchBlob(js, lin.url);
    const info = await readInstaller(data, lin.name);
    ok(info.kind === 'run' && !!info.plan && !!info.record, 'the packed .run carries its record and its plan', info.kind);
    const want = planPackFiles(info.plan, 'linux', ['linux_amd64']);
    const names = new Set(info.pack.map((m) => m.name));
    ok(want.files.length >= 1 && want.files.every((f) => names.has(f.sha256)),
      'and holds every file the blocks that were ticked name', JSON.stringify(want.files.map((f) => f.label)));
    ok(want.skipped >= 1 && info.pack.length === want.files.length + 1,
      'and nothing else but the app\'s source: the unticked architectures are left out',
      info.pack.length + ' members for ' + want.files.length + ' packed files, ' + want.skipped + ' blocks skipped');
    for (const m of info.pack) {
      const f = want.files.find((x) => x.sha256 === m.name);
      if (f) ok(m.data.length === f.size, `the packed ${f.label} is the length its plan gives`, m.data.length + ' of ' + f.size);
    }
  }
  // Only our mirror was asked, and only for files the plan names.
  const urls = requests.filter((u) => /^https?:/.test(u));
  ok(urls.length > 0 && urls.every((u) => u.indexOf('/mirror/') > 0),
    'the packed files came from our mirror and nowhere else', urls.slice(0, 3).join(' '));
  // The next build lets the last one's files go (docs/browser-packing.md
  // section 6): the rule is "revoke when the next build starts", which
  // needs no download-finished event, because there is none.
  const old = files[0].url;
  await buildHello({ runtime: 'python', mode: 'unsigned', name: 'After the pack', code: "print('hi')\n", platforms: ['linux'] });
  ok(await js(`fetch(${JSON.stringify(old)}).then(() => false, () => true)`),
    'the next build revokes the last one\'s downloads', old);
  await js(`(() => { const f = document.getElementById('new-form'); f.reset();
    f.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
}

// The budget itself: a pure function, so it is checked here rather than by
// finding a machine of each size. What matters is the shape of it -- the
// floor when the browser says nothing, more only where the machine says it
// has more, less for what the page already holds and for the macOS zip,
// and the format's limit when the file can be streamed to disk.
function checkBudgetRule() {
  const b = (e) => packBudget(e).mb;
  ok(b({}) === PACK_FLOOR_MB, 'a browser that says nothing about itself gets the measured floor', b({}));
  ok(b({ deviceMemory: 8 }) > b({ deviceMemory: 4 }) && b({ deviceMemory: 4 }) > b({}),
    'a machine that reports more memory gets more', [b({}), b({ deviceMemory: 4 }), b({ deviceMemory: 8 })].join(' '));
  ok(b({ deviceMemory: 2 }) < PACK_FLOOR_MB, 'a machine that reports little gets less than the floor', b({ deviceMemory: 2 }));
  ok(b({ deviceMemory: 8, usedHeapMb: 300 }) < b({ deviceMemory: 8 }),
    'what the page already holds comes off the top', [b({ deviceMemory: 8 }), b({ deviceMemory: 8, usedHeapMb: 300 })].join(' '));
  ok(b({ deviceMemory: 8, macZip: true }) < b({ deviceMemory: 8 }),
    'the macOS zip, whose path has never been measured, gets less', b({ deviceMemory: 8, macZip: true }));
  ok(b({ savePicker: true }) > 1000 && packBudget({ savePicker: true }).stream,
    'writing to a file as it is made is limited by the format, not by memory', b({ savePicker: true }));
  ok(b({ savePicker: true, limitMb: 10 }) === 10 && b({ deviceMemory: 8, limitMb: 10 }) === 10 &&
    b({ deviceMemory: 8, limitMb: 9000 }) === b({ deviceMemory: 8 }),
    'a hand-set ceiling only ever lowers it');
  // A footer that does not read back as a footer is the failure this
  // feature must never hand over, so the check that catches it is checked.
  const good = new Uint8Array(64);
  good.set(new TextEncoder().encode('TIMETA1 000000000042 000000000000 000000001024 '), 0);
  good.fill(32, 47, 63);
  good[63] = 10;
  ok(parseFooterTail(good) && parseFooterTail(good).pack === 1024, 'a footer reads back as its three lengths');
  const cut = good.slice(0, 63);
  ok(parseFooterTail(cut) === null && parseFooterTail(good.slice(1)) === null, 'a short or shifted tail is not taken for one');
}

// Every system in the picker must select at least one block of a real
// plan. A mapping that matched nothing would pack an empty installer and
// look exactly like one that worked -- the failure this project keeps
// finding -- so it is checked against the catalogue the page carries.
function checkTargetMapping() {
  for (const t of OFFLINE_TARGETS) {
    const os = OFFLINE_TARGET_OS[t.id];
    ok(os === null || (Array.isArray(os) && os.length > 0), `${t.id}: the picker's system has plan numbers`, JSON.stringify(os));
  }
  const plan = [
    '[target]', 'when\twindows\t1000\t9999\tamd64', 'file\tpython\tcore.msi\t' + 'a'.repeat(64) + '\t100\tamd64', 'url\thttp://m/core.msi',
    '[target]', 'when\twindows\t601\t603\tx86', 'file\tpython\told.msi\t' + 'b'.repeat(64) + '\t200\tx86', 'url\thttp://m/old.msi',
    '[target]', 'when\twindows\t501\t501\tx86', 'file\tpython\txp.msi\t' + 'c'.repeat(64) + '\t300\tx86', 'url\thttp://m/xp.msi',
  ].join('\n');
  const only1011 = planPackFiles(plan, 'windows', ['win_1011_amd64']);
  ok(only1011.files.length === 1 && only1011.files[0].label === 'core.msi' && only1011.skipped === 2,
    'ticking Windows 10/11 packs that block and leaves the others out', JSON.stringify(only1011.files.map((f) => f.label)));
  ok(only1011.files[0].urls.length === 1, 'and keeps the URLs of the file it takes', JSON.stringify(only1011.files[0].urls));
  const xp = planPackFiles(plan, 'windows', ['win_xp_x86']);
  ok(xp.files.length === 1 && xp.files[0].label === 'xp.msi', 'ticking Windows XP packs the build that runs there',
    JSON.stringify(xp.files.map((f) => f.label)));
  // A URL belongs to the file above it, including when that file was
  // skipped: the second copy of the same SHA-256 here must not hand its
  // URLs to the file before it, which would be a URL for the wrong bytes.
  const dup = [
    '[target]', 'when\twindows\t1000\t9999\tamd64',
    'file\tpython\tcore.msi\t' + 'a'.repeat(64) + '\t100\tamd64', 'url\thttp://m/core.msi',
    'file\tpython\tsame.msi\t' + 'a'.repeat(64) + '\t100\tamd64', 'url\thttp://m/other.msi',
    'file\tpython\tlib.msi\t' + 'd'.repeat(64) + '\t200\tamd64', 'url\thttp://m/lib.msi',
  ].join('\n');
  const dupSel = planPackFiles(dup, 'windows', ['win_1011_amd64']);
  ok(dupSel.files.length === 2 && dupSel.files[0].urls.length === 1 && dupSel.files[0].urls[0] === 'http://m/core.msi',
    'a skipped file does not give its URLs to the one before it', JSON.stringify(dupSel.files.map((f) => f.urls)));
  const both = planPackFiles(plan, 'windows', ['win_1011_amd64', 'win_78_x86']);
  ok(both.files.length === 2 && both.blocks === 2, 'two systems pack two blocks', JSON.stringify(both.files.map((f) => f.label)));
  ok(planPackFiles(plan, 'linux', ['win_1011_amd64']).files.length === 0, 'and a platform with nothing ticked packs nothing');
}

// A declaration, not a const: the checks above run while this module is
// still being evaluated, so anything they call has to be hoisted.
function packBody(platforms, targets) {
  return {
    name: 'Hello packed', project: 'hellopack', runtime: 'python', mode: 'C',
    source: { kind: 'inline' }, files: { 'hellopack/__main__.py': "print('hello from a packed installer')\n" },
    platforms, launch: '{runtime} -m hellopack', console: true, menu: true, offline: true,
    pack: { offline_include: 'all', shape: 'single', offline_targets: targets },
  };
}

// Is our mirror there? Asked from here, not from the page: the page's own
// fetch is what is being tested, and a probe from it would be the same
// call the test is meant to be checking.
async function mirrorReachable() {
  if (process.argv.includes('--no-pack')) return false;
  const base = process.env.TI_MIRROR || 'http://10.0.1.76:8080/mirror/';
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 8000);
    const r = await fetch(base, { signal: c.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch (e) { return false; }
}
