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
import { OFFLINE_TARGETS, offlineField, ARCH_LABEL, ENTRY_DEFAULTS } from '../shared/form-job.js';
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
  ok(await js(`getComputedStyle(document.getElementById('mode-ours').closest('label')).display === 'none' && document.getElementById('mode-unsigned').checked`),
    '"Signed by Installer Builder" is hidden and Unsigned is chosen');
  // Where a build happens, in plain words, before building (design.md 11.0 item 6).
  ok(await js(`[...document.querySelectorAll('.ti-page[data-page="new"] .build-where')].length >= 1 &&
    [...document.querySelectorAll('.ti-page[data-page="new"] .build-where')].every((p) => /^Built in this page:/.test(p.textContent))`),
    'the New installer form says "Built in this page"', await js(`(document.querySelector('.build-where') || {}).textContent`));
  ok(await js(`getComputedStyle(document.getElementById('offline-on').closest('label')).display === 'none'`), 'packing runtimes is hidden');
  ok(await js(`getComputedStyle(document.getElementById('ts-on').closest('.online-only')).display === 'none'`), 'the timestamp relay is hidden');
  // Signing services whose API a browser can't call go through the build
  // server's relay, so offline they don't exist (docs/browser-signing.md 3).
  ok(await js(`(() => { const s = document.getElementById('svc-name');
    return !!s && s.options.length >= 4 && ![].some.call(s.options, (o) => o.value === 'azurets'); })()`),
    'the relayed signing services are not offered', await js(`[].map.call(document.getElementById('svc-name').options, (o) => o.value).join(',')`));
  await checkLaunchField();
  await checkArchitecture();
  await checkSections(t, js);
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
    const job = await buildHello({ runtime: 'python', mode: 'unsigned', name: 'Hello again', code: "print('hello')\n", platforms: ['linux'] });
    await checkJob(job, 'saved copy', 'python');
    await waitFor(js, `document.getElementById('job-where').textContent === 'Built in this page.'`, 'the saved copy\'s build page to say the same', 15000, errors);
    ok(true, 'the saved copy\'s build page says the same');
  }
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
    await js(`document.querySelector('.api-ctl-edit').click(); document.querySelector('.api-ctl-local').click()`);
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
