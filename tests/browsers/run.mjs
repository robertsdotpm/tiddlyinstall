// Runs the TiddlyInstall page tests in a browser on one of the test
// machines, over W3C WebDriver: a (machine, browser) pair picked at random,
// weighted towards the pairs used least so far (tests/browsers/usage.jsonl),
// so that over time every browser on every machine gets used.
//
//   node tests/browsers/run.mjs [--count N] [--jobs J] [--seed S]
//        [--machine X] [--browser Y] [--page out/index.html] [--no-served] [--keep]
//   node tests/browsers/run.mjs --inventory     # re-read every machine's browsers.json
//   node tests/browsers/run.mjs --list          # pairs and how often each was used
//
// Each run copies the page (with a small error recorder added at the top of
// <head>) to the machine, starts the browser's driver there bound to
// 127.0.0.1, reaches it through `ssh -L`, and checks, from file:// (a secure
// context, so WebCrypto is there): the page starts without errors; its
// sections and :has()-driven form work; an installer built with no server
// reads back with src/shared/tifile.js (record and plan); "Save this page" saves a
// copy that starts; the editor signs a .run with PGP (checked with gpg here)
// and an .exe with a .pfx (checked with osslsigncode here). With a build
// server on 127.0.0.1:8080 here, it also opens the page served through an
// SSH reverse tunnel, as http://localhost:PORT on the machine.
//
// A browser the page's startup check (src/web_client/browser-check.js) finds too old
// is recorded as "unsupported: <what's missing>", not as a failure.
// Results: one line per run in usage.jsonl, the details in results/.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Session, evalIn, waitForDriver, sleep } from './webdriver.mjs';
import { connectCdp } from './cdp.mjs';
import { MarionetteSession } from './marionette.mjs';
import { connectPlaywright } from './playwright.mjs';
import { loadMachines, findMachine, freePort, Remote } from './remote.mjs';
import { Checker, STARTED, checkSections, buildHello, checkJob, makeSignFixtures, osslVerify, gpgVerify, $text, setVal, checkBox } from './steps.mjs';
import { readInstaller } from '../../src/shared/tifile.js';
import { ensureDriver } from './drivers.mjs';
import { writeCompat } from './compat.mjs';

// The DevTools fallback needs WebSocket (a flag on Node 20).
if (typeof WebSocket === 'undefined') {
  const r = spawnSync(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..', '..');
const USAGE = path.join(HERE, 'usage.jsonl');
const RESULTS = path.join(HERE, 'results');
const INVENTORY = path.join(HERE, 'inventory.json');

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const PAGE = path.resolve(arg('--page', path.join(ROOT, 'out', 'index.html')));
const SERVER = 'http://127.0.0.1:8080';

/* ---------- inventory: what's installed where ---------- */

function readInventory() {
  try { return JSON.parse(fs.readFileSync(INVENTORY, 'utf8')); } catch (e) { return { machines: {} }; }
}

async function refreshInventory(machines, only = machines) {
  const inv = readInventory();
  await Promise.all(only.map(async (m) => {
    const r = new Remote(m);
    try {
      const man = r.readManifest();
      inv.machines[m.name] = { os: m.os, ssh: m.ssh, read: new Date().toISOString(), browsers: man.browsers };
      console.log(`${m.name}: ${man.browsers.map((b) => `${b.id} ${b.version || '?'}${b.driver ? '' : ' (no driver)'}`).join(', ')}`);
    } catch (e) {
      console.log(`${m.name}: ${e.message}`);
      if (!inv.machines[m.name]) inv.machines[m.name] = { os: m.os, ssh: m.ssh, error: e.message, browsers: [] };
    }
  }));
  const sorted = {};
  for (const m of machines) if (inv.machines[m.name]) sorted[m.name] = inv.machines[m.name];
  fs.writeFileSync(INVENTORY, JSON.stringify({ updated: new Date().toISOString(), machines: sorted }, null, 1) + '\n');
}

// Pairs that can be run: a browser that's installed (binary) with a way to
// drive it (a WebDriver driver, or the DevTools protocol for a Chromium
// without one).
function pairs(inv) {
  const out = [];
  for (const [machine, m] of Object.entries(inv.machines)) {
    for (const b of m.browsers || []) if (b.binary && protocolOf(b)) out.push({ machine, browser: b.id });
  }
  return out;
}

// WebDriver where there's a driver; the DevTools protocol for a Chromium
// without a usable one (XP; Edge 109 on 8.1; Vista, whose last chromedriver
// predates W3C: "protocol": "cdp" in its manifest); Firefox's own Marionette
// for a Firefox no geckodriver runs beside (52 on XP: "protocol":
// "marionette"); Playwright's own protocol for Playwright's WebKit
// ("protocol": "playwright", tests/browsers/playwright.mjs).
const CHROMIUM = new Set(['chrome', 'chromium', 'edge', 'supermium', 'supermium-installed', 'opera']);
function protocolOf(b) {
  if (b.protocol) return b.protocol;
  if (b.driver) return 'webdriver';
  return CHROMIUM.has(b.id) ? 'cdp' : null;
}

function readUsage() {
  if (!fs.existsSync(USAGE)) return [];
  return fs.readFileSync(USAGE, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

/* ---------- picking ---------- */

// mulberry32: small, seedable.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weight 1/(1+uses)^2: a pair never used is 4x as likely as one used once,
// 9x as one used twice. `busy` machines (running now) are skipped.
function pick(all, usage, rand, busy = new Set()) {
  const counts = new Map();
  for (const u of usage) counts.set(u.machine + '/' + u.browser, (counts.get(u.machine + '/' + u.browser) || 0) + 1);
  const cands = all.filter((p) => !busy.has(p.machine));
  if (!cands.length) return null;
  const w = cands.map((p) => 1 / (1 + (counts.get(p.machine + '/' + p.browser) || 0)) ** 2);
  let x = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < cands.length; i++) { x -= w[i]; if (x <= 0) return cands[i]; }
  return cands[cands.length - 1];
}

/* ---------- the page copy that runs on the machines ---------- */

// out/index.html with an error recorder first in <head> (plain ES5, so it
// runs in any browser): WebDriver has no portable way to read page errors.
const RECORDER = '<script>window.__tiErrors=[];window.addEventListener("error",function(e){__tiErrors.push(String(e.message||e.type)+" @"+(e.filename||"").slice(-40)+":"+(e.lineno||""))});' +
  'window.addEventListener("unhandledrejection",function(e){var r=e.reason;__tiErrors.push("unhandled rejection: "+String(r&&(r.stack||r.message)||r).slice(0,300))});</script>';

function testPage(tmp) {
  const html = fs.readFileSync(PAGE, 'utf8');
  if (!html.includes('data-ti-missing')) console.log('warning: the page has no startup browser check (src/web_client/browser-check.js); rebuild it with tools/build_site.py');
  const out = html.replace(/<head>/i, '<head>\n' + RECORDER);
  const hash = crypto.createHash('sha256').update(out).digest('hex').slice(0, 12);
  const file = path.join(tmp, `titest-${hash}.html`);
  fs.writeFileSync(file, out);
  return file;
}

// What the browser has of what the page needs (ES5, so it runs anywhere);
// the same list as src/web_client/browser-check.js, and a few more for the record.
const FEATURES = `var r = {}; function t(n, f) { try { r[n] = !!f(); } catch (e) { r[n] = false; } }
t('ES modules', function () { return 'noModule' in document.createElement('script'); });
t('?. ?? ||= syntax', function () { new Function('var a, b = a?.b ?? 1; a ||= b; try {} catch {}'); return true; });
t('BigInt', function () { return typeof BigInt === 'function'; });
t('Object.hasOwn', function () { return typeof Object.hasOwn === 'function'; });
t('CompressionStream deflate-raw', function () { new CompressionStream('deflate-raw'); return true; });
t('DecompressionStream deflate-raw', function () { new DecompressionStream('deflate-raw'); return true; });
t('CompressionStream gzip', function () { new CompressionStream('gzip'); return true; });
t('Blob.stream', function () { return !!Blob.prototype.stream; });
t('secure context', function () { return window.isSecureContext; });
t('WebCrypto', function () { return !!(window.crypto && crypto.subtle); });
t('CSS :has()', function () { return CSS.supports('selector(:has(a))'); });
t('CSS color-mix()', function () { return CSS.supports('color', 'color-mix(in srgb, red, blue)'); });
r.userAgent = navigator.userAgent;
return r;`;

// Which WebCrypto algorithms work (async; ES5 with promises).
const ALGOS = `var done = arguments[arguments.length - 1];
if (!(window.crypto && crypto.subtle)) { done({}); return; }
var s = crypto.subtle, r = {}, tries = [
  ['Ed25519', function () { return s.generateKey('Ed25519', true, ['sign', 'verify']); }],
  ['RSASSA-PKCS1-v1_5', function () { return s.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']); }],
  ['ECDSA P-256', function () { return s.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); }],
  ['PBKDF2', function () { return s.importKey('raw', new Uint8Array(8), 'PBKDF2', false, ['deriveBits']); }],
  ['AES-CBC', function () { return s.importKey('raw', new Uint8Array(16), 'AES-CBC', false, ['decrypt']); }],
  ['HMAC', function () { return s.importKey('raw', new Uint8Array(16), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); }],
  ['SHA-256', function () { return s.digest('SHA-256', new Uint8Array(1)); }]
], i = 0;
function next() {
  if (i >= tries.length) { done(r); return; }
  var t = tries[i++];
  try { t[1]().then(function () { r[t[0]] = true; next(); }, function (e) { r[t[0]] = String(e && e.name || e); next(); }); }
  catch (e) { r[t[0]] = String(e && e.name || e); next(); }
}
next();`;

// Downloads the page starts (anchors with a blob: href and a download
// name) are also kept in the page, so tests can read what it saved.
const CAPTURE = `(() => { if (!window.__tiDl) { window.__tiDl = {};
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download && /^blob:/.test(this.href)) window.__tiDl[this.download] = fetch(this.href).then((r) => r.arrayBuffer());
    return click.apply(this, arguments);
  }; } return true; })()`;

async function captured(js, name, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    if (await js(`!!(window.__tiDl && window.__tiDl[${JSON.stringify(name)}])`)) {
      const b64 = await js(`window.__tiDl[${JSON.stringify(name)}].then((b) => {
        let s = ''; const u = new Uint8Array(b);
        for (let i = 0; i < u.length; i += 0x1000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x1000));
        return btoa(s); })`);
      return Buffer.from(b64, 'base64');
    }
  }
  throw new Error('the page saved no ' + name + ' (saved: ' + (await js(`Object.keys(window.__tiDl || {}).join(' ')`)) + ')');
}

/* ---------- capabilities ---------- */

// Firefox's download prefs: through geckodriver's capabilities, or a
// profile's user.js where Firefox is driven over Marionette directly.
function firefoxPrefs(dlDir) {
  return {
    'browser.download.folderList': 2, 'browser.download.dir': dlDir, 'browser.download.useDownloadDir': true,
    'browser.download.manager.showWhenStarting': false, 'browser.download.always_ask_before_handling_new_types': false,
    'browser.helperApps.neverAsk.saveToDisk': 'text/html,application/octet-stream,application/pgp-signature,text/plain',
    'browser.download.start_downloads_in_tmp_dir': false, 'app.update.auto': false, 'app.update.enabled': false,
  };
}

function capabilities(entry, dlDir) {
  const args = [...(entry.args || [])];
  const chromium = {
    binary: entry.binary,
    args: [...args, '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen'],
    prefs: {
      'download.default_directory': dlDir, 'download.prompt_for_download': false, 'download.directory_upgrade': true,
      'profile.default_content_setting_values.automatic_downloads': 1, 'safebrowsing.enabled': false,
    },
  };
  switch (entry.driverKind) {
    case 'chromedriver': return { browserName: 'chrome', 'goog:chromeOptions': chromium };
    case 'msedgedriver': return { browserName: 'MicrosoftEdge', 'ms:edgeOptions': chromium };
    // operadriver is chromedriver built for Opera: the same options, under
    // Chrome's key, with Opera's binary.
    case 'operadriver': return { browserName: 'opera', 'goog:chromeOptions': chromium };
    case 'geckodriver': return {
      browserName: 'firefox',
      'moz:firefoxOptions': { binary: entry.binary, args, prefs: firefoxPrefs(dlDir) },
    };
    case 'safaridriver': return { browserName: 'safari' };
    // WebKitGTK's driver: MiniBrowser --automation, or Epiphany
    // --automation-mode (entry.args), on the Xvfb its wrapper starts.
    case 'webkitwebdriver': return {
      browserName: entry.browserName || 'MiniBrowser',
      'webkitgtk:browserOptions': { binary: entry.binary, args },
    };
    default: throw new Error('unknown driverKind ' + entry.driverKind);
  }
}

/* ---------- one run ---------- */

async function runPair(machine, browserId, { seed, served, tmpRoot }) {
  const started = Date.now();
  const remote = new Remote(machine);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = stamp + '-' + crypto.randomBytes(3).toString('hex');
  const t = new Checker({ prefix: `[${machine.name}/${browserId}] ` });
  const rec = { time: new Date().toISOString(), machine: machine.name, browser: browserId, version: '', result: '', seed };
  const detail = { ...rec, checks: t.checks };
  const driverLog = [];
  let cdpPort = 0, ssh = null, revProc = null, staticProc = null, session = null, cdpConn = null, pwConn = null, entry = null, b = null;
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'run-'));
  const finish = (result, why) => {
    rec.result = why ? `${result}: ${why}` : result;
    rec.seconds = Math.round((Date.now() - started) / 1000);
    return rec;
  };
  try {
    // The machine's manifest now (browsers update themselves).
    const man = remote.readManifest();
    entry = man.browsers.find((b) => b.id === browserId);
    if (!entry || !entry.binary) return finish('error', `${browserId} is not installed on ${machine.name}`);
    rec.version = entry.version;
    detail.entry = entry;
    const work = remote.dir('work');
    const dl = remote.dir('work', 'dl-' + runId);
    remote.mkdir(work);
    remote.mkdir(dl);

    // The page, and the signing fixtures, on the machine.
    const pageFile = testPage(tmpRoot);
    const pageName = path.basename(pageFile);
    // Which page this was: its build (the generator line names the git
    // revision it was built from) and a hash of the file.
    const gen = /<meta name="generator" content="[^,"]*, ([^,"]+), ([^"]+)">/.exec(fs.readFileSync(PAGE, 'utf8').slice(0, 4000));
    rec.page = { rev: gen ? gen[1] : '', hash: pageName.replace(/^titest-|\.html$/g, '') };
    const have = remote.list(work);
    if (!have.includes(pageName)) {
      for (const old of have.filter((f) => /^titest-.*\.html$/.test(f))) remote.removeFile(remote.dir('work', old));
      remote.put(pageFile, remote.dir('work', pageName));
    }
    const fx = await makeSignFixtures(tmp);
    for (const f of ['in.exe', 'in.run', 'rsa.pfx']) remote.put(fx.t(f), remote.dir('work', 'dl-' + runId, f));
    // Safari will not be driven to a file:// URL at all (remote.mjs
    // startStaticServer), so it gets the same file over http from the
    // machine it is running on. Everything else keeps file://, which is
    // what a saved copy actually is.
    const overHttp = entry.driverKind === 'safaridriver';
    if (overHttp) {
      // Safari has no WebDriver capability for the download folder -- the
      // other three take it in their options -- so it is set as a
      // preference on the machine before the session starts. Without it
      // Safari saves to ~/Downloads, the harness looks in this run's
      // folder, finds nothing, and reports it as the page failing to
      // save. Which is how a browser that builds every installer
      // correctly came out as a failure (2026-09-23).
      // Safari is sandboxed, so it cannot write to an arbitrary folder
      // however the preference is set -- pointing DownloadsPath at this
      // run's directory looked right and saved nothing. ~/Downloads is
      // inside what its container permits, so it saves there and the file
      // is moved across afterwards.
      remote.sh('defaults write com.apple.Safari DownloadsPath "$HOME/Downloads"');
      remote.sh('defaults write com.apple.Safari AlwaysPromptForDownloadFolder -bool false');
      remote.sh('defaults write com.apple.Safari DownloadsClearingPolicy -int 0');
      remote.sh('rm -f "$HOME/Downloads/tiddlyinstall.html" "$HOME/Downloads/tiddlyinstall-"*.html');
      // The same sandbox stops Safari *reading* a file input's path under
      // ~/tibrowsers, so the signing fixtures go where it is allowed too.
      // Without this the file input stays empty, #sign-run never appears,
      // and it reads as the signing panel being broken in Safari.
      remote.sh('mkdir -p "$HOME/Downloads/tifix"');
      for (const f of ['in.exe', 'in.run', 'rsa.pfx']) {
        remote.sh('cp ' + JSON.stringify(remote.dir('work', 'dl-' + runId, f)) + ' "$HOME/Downloads/tifix/"');
      }
    }
    let staticPort = 0;
    if (overHttp) {
      staticPort = await freePort();
      staticProc = remote.startStaticServer(remote.dir('work'), staticPort, null);
      await sleep(2500);
    }
    const httpUrl = (...parts) => `http://127.0.0.1:${staticPort}/` + parts.join('/');
    // Where a fixture is, for setFile. Safari reads it from its own
    // allowed folder; everything else from this run's directory.
    const fixture = (name) => (overHttp ? remote.home + '/Downloads/tifix/' + name
      : remote.dir('work', 'dl-' + runId, name));
    const pageUrl = overHttp ? httpUrl(pageName) : remote.fileUrl(remote.dir('work', pageName));

    // The driver (or DevTools, for a Chromium with no driver here).
    const port = await freePort();
    let reverse = null;
    if (served) {
      // The far end picks, where its sshd will; else we try a few.
      const r = await remote.reverse(SERVER.replace(/^http:\/\//, ''));
      if (r.proc) { reverse = { remotePort: r.port }; revProc = r.proc; } else { t.note('served', 'no reverse tunnel: ' + r.why); detail.served = 'no tunnel: ' + r.why; }
    }
    let js, setFile, pageErrors;
    remote.stopDrivers(entry);
    rec.protocol = protocolOf(entry);
    if (rec.protocol === 'marionette') {
      cdpPort = port;
      ssh = remote.startMarionetteBrowser(entry, {
        port, profile: 'tiprof-' + runId, tmp, log: (d) => driverLog.push(String(d)),
        prefs: { ...firefoxPrefs(dl), 'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore',
          'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.reportingpolicy.firstRun': false },
      });
      session = await MarionetteSession.connect('127.0.0.1', port, { ms: 180000 })
        .catch((e) => { throw new Error('driver: Marionette: ' + e.message + ' ' + driverLog.join('').slice(-400)); });
    }
    if (rec.protocol === 'webdriver') {
      ssh = remote.startDriver(entry, { port, log: (d) => driverLog.push(String(d)) });
      const base = `http://127.0.0.1:${port}`;
      await waitForDriver(base, 45000).catch((e) => { throw new Error('driver: ' + e.message + ' ' + driverLog.join('').slice(-400)); });
      let caps = capabilities(entry, dl);
      try {
        session = await Session.create(base, caps);
      } catch (e) {
        // A browser that updated itself past its driver: fetch the matching
        // driver, and try once more.
        const fixed = await ensureDriver(remote, entry, e.message, tmp);
        if (!fixed) throw e;
        entry = fixed;
        detail.entry = entry;
        try { ssh.stdin.end(); ssh.kill(); } catch (x) { /* gone */ }
        remote.stopDrivers(entry);
        ssh = remote.startDriver(entry, { port, log: (d) => driverLog.push(String(d)) });
        await waitForDriver(base, 45000);
        caps = capabilities(entry, dl);
        session = await Session.create(base, caps);
      }
    }
    if (session) {
      rec.version = session.browserVersion || entry.version;
      // Opera's driver reports the Chromium it's built on, not Opera's version.
      if (entry.id === 'opera') { rec.chromium = rec.version; rec.version = entry.version; }
      // Brave and Vivaldi run with the chromedriver of their Chromium, which
      // reports that Chromium: record the browser's own version.
      if (entry.chromiumVersion) { rec.chromium = rec.version; rec.version = entry.version; }
      // WebKitGTK: the engine's version, whatever the browser reports.
      if (entry.webkitVersion) { rec.webkit = entry.webkitVersion; if (entry.id !== 'webkitgtk') rec.version = entry.version; }
      detail.capabilities = session.capabilities;
      // W3C timeouts; older Marionette (Firefox 52) takes one {type, ms} at a time.
      await session.setTimeouts({ script: 600000, pageLoad: 300000 }).catch(async (e) => {
        for (const [type, ms] of [['script', 600000], ['page load', 300000]]) await session.setTimeouts({ type, ms }).catch(() => {});
        t.note('timeouts', 'W3C form refused (' + e.message + '); set the legacy way');
      });
      js = (expr) => evalIn(session, expr);
      // Old drivers (Firefox 52's Marionette) add to a file input's list
      // instead of replacing it, so empty it first.
      setFile = async (css, p) => {
        await js('(function () { var e = document.querySelector(' + JSON.stringify(css) + '); if (e) e.value = ""; return 1; })()');
        return session.sendKeys(await session.find(css), p);
      };
      b = { navigate: (u) => session.navigate(u), run: (x) => session.run(x), runAsync: (x) => session.runAsync(x) };
    } else if (rec.protocol === 'cdp') {
      cdpPort = port;
      ssh = remote.startCdpBrowser(entry, { port, profile: 'tiprof-' + runId, log: (d) => driverLog.push(String(d)) });
      cdpConn = await connectCdp(`http://127.0.0.1:${port}`, { tries: 200 }).catch((e) => { throw new Error('driver: DevTools: ' + e.message + ' ' + driverLog.join('').slice(-400)); });
      await cdpConn.cdp('Runtime.enable');
      await cdpConn.cdp('Page.enable');
      await cdpConn.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dl }).catch((e) => t.note('downloads', e.message));
      const ver = await cdpConn.cdp('Browser.getVersion');
      rec.version = (/[\d.]+$/.exec(ver.product) || [entry.version])[0];
      if (entry.id === 'opera') { rec.chromium = rec.version; rec.version = entry.version; }
      detail.capabilities = ver;
      ({ js, setFile } = cdpConn);
      const run = async (body) => js(`(function () { ${body} })()`);
      const runAsync = async (body) => js(`new Promise(function (done) { (function () { ${body} }).apply(null, [done]); })`);
      b = {
        navigate: async (u) => {
          await cdpConn.cdp('Page.navigate', { url: u });
          const want = u.split('#')[0];
          for (const end = Date.now() + 300000; Date.now() < end; await sleep(300)) {
            const st = await js(`[location.href.split('#')[0], document.readyState]`).catch(() => null);
            if (st && st[0] === want && st[1] === 'complete') return;
          }
          throw new Error('timed out loading ' + u);
        },
        run, runAsync,
      };
    } else if (rec.protocol === 'playwright') {
      // Put the server there before starting it. The machine has its own
      // copy under playwright-<v>/server.mjs, and until 2026-09-23
      // nothing ever replaced it: the harness ran whatever was installed.
      // So when the websocket path was renamed /ib to /ti with everything
      // else, the machines kept serving /ib and every WebKit run failed
      // with "400 Bad Request" -- the one browser standing in for Safari,
      // which we cannot drive at all. A file we run but never copy is a
      // file that silently drifts.
      const pwDir = entry.driver.replace(/[\\/][^\\/]*$/, '');
      remote.put(path.join(HERE, 'playwright-server.mjs'), pwDir + '/server.mjs');
      ssh = remote.startDriver(entry, { port, log: (d) => driverLog.push(String(d)) });
      pwConn = await connectPlaywright(port, {
        remote, dl, tmp, log: (d) => driverLog.push(String(d)),
        // The fixtures run.mjs put on the machine are here too.
        local: (p) => fx.t(p.split(/[\\/]/).pop()),
      }).catch((e) => { throw new Error((/^driver/.test(e.message) ? '' : 'driver: ') + e.message + ' ' + driverLog.join('').slice(-400)); });
      rec.version = pwConn.version || entry.version;
      rec.webkit = entry.webkitRevision ? 'Playwright WebKit r' + entry.webkitRevision : '';
      detail.capabilities = { browserVersion: pwConn.version, userAgent: await pwConn.userAgent() };
      ({ js, setFile, b } = pwConn);
    } else {
      throw new Error('no driver for ' + browserId + ' on ' + machine.name + (entry.notes ? ': ' + entry.notes : ''));
    }
    pageErrors = () => js('window.__tiErrors || []');

    // 1. The page starts, or says what this browser lacks.
    await b.navigate(pageUrl);
    detail.features = await b.run(FEATURES).catch((e) => ({ error: e.message }));
    detail.webcrypto = await b.runAsync(ALGOS).catch((e) => ({ error: e.message }));
    let state = null;
    for (const end = Date.now() + 120000; Date.now() < end && !state; await sleep(500)) {
      state = await b.run(`var m = document.documentElement.getAttribute('data-ti-missing');
        if (m && document.documentElement.getAttribute('data-ti-ready')) return { missing: m, banner: !!document.querySelector('.ti-compat-bar.ti-too-old:not([hidden])') };
        try { if (${STARTED}) return { started: true, missing: m }; } catch (e) {}
        return null;`).catch(() => null);
    }
    if (state && state.missing) {
      t.ok(state.banner, 'the page tells the person their browser is too old', state.missing);
      detail.missing = state.missing;
      return finish('unsupported', state.missing);
    }
    if (!state) {
      const missingFeatures = Object.entries(detail.features || {}).filter(([k, v]) => v === false && k !== 'CSS color-mix()').map(([k]) => k);
      const errs = await b.run('return window.__tiErrors || []').catch(() => []);
      t.ok(false, 'the page starts', 'no start and no browser-check verdict; errors: ' + errs.join(' | '));
      if (missingFeatures.length) return finish('unsupported', 'page did not start; the browser lacks ' + missingFeatures.join(', '));
      return finish('fail', 'the page did not start');
    }
    t.ok(state.missing === '', 'the startup check finds nothing missing', state.missing);
    // The compatibility bar shows exactly when something isn't native.
    const bar = await waitUntil(js, `document.documentElement.getAttribute('data-ti-ready') && [document.documentElement.getAttribute('data-ti-degraded'), !!document.querySelector('.ti-compat-bar:not([hidden])')]`, 'the browser check', 30000).catch(() => null);
    if (bar) {
      detail.degraded = bar[0];
      t.ok(bar[1] === (bar[0] !== ''), 'the compatibility bar shows only when a feature isn\'t native', 'degraded: "' + bar[0] + '", bar shown: ' + bar[1]);
    } else t.ok(false, 'the browser check finishes (data-ti-ready)');
    t.ok((await pageErrors()).length === 0, 'the page starts without errors', (await pageErrors()).join(' | '));
    t.ok(await js(`document.documentElement.classList.contains('ti-local')`), 'from disk, the page builds installers itself');
    if (detail.webcrypto && detail.webcrypto.Ed25519 !== true) t.note('WebCrypto Ed25519', 'not supported: ' + detail.webcrypto.Ed25519 + ' (the editor offers RSA keys instead)');

    // 2. Navigation, and the :has()-driven form.
    await checkSections(t, js);
    await js(`location.hash = '#new&write'`);
    await sleep(300);
    const editor = await js(`(() => { const f = document.getElementById('new-form');
      f.elements.runtime.value = 'python'; f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('src-write').checked = true; document.getElementById('tpl-script').checked = true;
      document.getElementById('tpl-script').dispatchEvent(new Event('change', { bubbles: true }));
      const ta = f.querySelector('.combo-python-script textarea.code'); return !!ta && ta.offsetParent !== null; })()`);
    t.ok(editor, 'New installer: the code editor shows for Python + script (CSS :has())');

    // 3. An installer built with no server, read back with src/shared/tifile.js.
    const job = await buildHello(js, { runtime: 'python', mode: 'unsigned', name: 'Hello browsers', code: "print('hello from " + browserId + "')\n" });
    await checkJob(t, js, job, 'build', 'python');

    // 4. Save this page, and the saved copy starts and builds.
    await js(CAPTURE);
    await js(`document.querySelector('.save-page').click()`);
    const html = await captured(js, 'tiddlyinstall.html', 30000).catch((e) => { t.ok(false, 'Save this page makes the page', e.message); return null; });
    if (html) t.ok(html.length > 1e6 && html.toString('utf8', 0, 200).includes('<!DOCTYPE html>'), 'Save this page makes the whole page', html.length);
    let savedName = null;
    for (const end = Date.now() + 30000; Date.now() < end && !savedName; await sleep(1000)) {
      // Safari saved into ~/Downloads (see above): move it where every
      // other browser puts it, so the rest of this is the same test.
      if (overHttp) {
        const r = remote.sh('mv "$HOME/Downloads/tiddlyinstall.html" ' + JSON.stringify(dl) + '/ 2>/dev/null; true');
        if (r && r.code !== 0) { /* not there yet */ }
      }
      const files = remote.list(dl);
      if (files.includes('tiddlyinstall.html') && !files.some((f) => /\.(part|crdownload|download)$/.test(f))) savedName = 'tiddlyinstall.html';
    }
    if (!savedName) {
      t.note('Save this page', 'the browser wrote no file to its download folder (' + remote.list(dl).join(' ') + ')');
      detail.saveToDisk = 'no file';
    } else {
      detail.saveToDisk = 'saved';
      await b.navigate(overHttp ? httpUrl('dl-' + runId, savedName) : remote.fileUrl(remote.dir('work', 'dl-' + runId, savedName)));
      const ok2 = await b.run(`try { return ${STARTED}; } catch (e) { return false; }`);
      let startedSaved = ok2;
      for (const end = Date.now() + 90000; Date.now() < end && !startedSaved; await sleep(500)) startedSaved = await js(STARTED);
      t.ok(startedSaved, 'the saved copy (from the browser\'s download folder) starts');
      t.ok((await pageErrors()).length === 0, 'the saved copy starts without errors', (await pageErrors()).join(' | '));
      const again = await buildHello(js, { runtime: 'python', mode: 'unsigned', name: 'Hello again', code: "print('hello')\n", platforms: ['linux'] });
      await checkJob(t, js, again, 'saved copy', 'python');
    }

    // 5. The editor's signing: PGP (.run) and a .pfx (.exe).
    //
    // Not through safaridriver. It sets a file input -- the element takes
    // the file and reports its name and size -- but Safari never issues the
    // sandbox grant that a real pick carries, so every read of the content
    // fails with NotReadableError: arrayBuffer, slice().arrayBuffer,
    // FileReader and stream() alike, and a 5-byte text file exactly as a
    // 247 KB installer. Probed directly on Safari 26.2 on 2026-09-24. The
    // section needs a readable File, so it cannot run here; `note` makes
    // the cell incomplete, which is what a section that did not run means.
    // Everything before and after this section does run on Safari.
    if (entry.driverKind === 'safaridriver') {
      t.note('editor signing', 'safaridriver sets the file input but Safari refuses the page every read of a file set that way (NotReadableError); section skipped');
    } else {
    await b.navigate(pageUrl + '#edit');
    for (const end = Date.now() + 90000; Date.now() < end && !(await js(STARTED)); await sleep(500));
    await js(`location.hash = '#edit'`);
    await js(CAPTURE);
    await setFile('#installer', fixture('in.run'));
    await waitUntil(js, `!document.getElementById('sign-run').hidden`, 'the Linux sign panel');
    await setVal(js, 'pgp-uid', 'Browser Test TEST <bt@example.invalid>');
    const makeKey = async (type) => {
      await setVal(js, 'pgp-type', type);
      await js(`document.getElementById('pgp-status').textContent = ''`);
      await js(`document.getElementById('pgp-make').click()`);
      return waitUntil(js, `/New key|rror|can't|Couldn/.test(${$text('pgp-status')}) && ${$text('pgp-status')}`, 'the key', 180000);
    };
    let keyType = 'ed25519';
    let st = await makeKey('ed25519');
    if (!/New key/.test(st) && /Ed25519/.test(st)) {
      t.note('PGP Ed25519 key', st);
      keyType = 'rsa3072';
      st = await makeKey('rsa3072');
    }
    t.ok(/New key/.test(st), `PGP: the page makes a ${keyType} key`, st);
    detail.pgpKey = keyType;
    if (/New key/.test(st)) {
      await js(`document.getElementById('pgp-pub-dl').click()`);
      await setVal(js, 'out-name', 'app.run');
      await js(`document.getElementById('sign-go').click()`);
      const s = await waitUntil(js, `/Saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'PGP signing', 180000);
      t.ok(/Saved/.test(s), 'PGP: signing says saved', s);
      const pubName = await js(`Object.keys(window.__tiDl).find((n) => /\\.pub\\.asc$/.test(n)) || ''`);
      const files = { pub: await captured(js, pubName), run: await captured(js, 'app.run'), asc: await captured(js, 'app.run.asc') };
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(tmp, 'pgp.' + k), v);
      const g = gpgVerify(path.join(tmp, 'pgp.pub'), path.join(tmp, 'pgp.asc'), path.join(tmp, 'pgp.run'), path.join(tmp, 'gnupg'), spawnSync);
      t.ok(g.ok, `PGP (${keyType}): gpg --verify says Good signature for the saved .run.asc`, g.out);
      const back = await readInstaller(new Uint8Array(files.run), 'app.run');
      t.ok(back.record === fx.RECORD, 'PGP: the signed .run keeps its record');
    }
    await setFile('#installer', fixture('in.exe'));
    await waitUntil(js, `!document.getElementById('sign-exe').hidden`, 'the Windows sign panel');
    if (await js(`!!document.getElementById('ts-on')`)) await checkBox(js, 'ts-on', false);
    await setFile('#pfx-file', fixture('rsa.pfx'));
    await setVal(js, 'pfx-pass', fx.PW);
    await js(`document.getElementById('pfx-open').click()`);
    const ps = await waitUntil(js, `/Signs as|rror|Wrong|can't|Couldn/.test(${$text('pfx-status')}) && ${$text('pfx-status')}`, 'the .pfx', 120000);
    if (/NotSupported|not supported|can't/i.test(ps) && !/Signs as/.test(ps)) {
      t.note('.pfx signing', 'this browser\'s WebCrypto can\'t open the .pfx: ' + ps);
      detail.pfx = 'unsupported: ' + ps;
    } else {
      t.ok(/Signs as/.test(ps), '.pfx: the page opens the RSA .pfx', ps);
      await setVal(js, 'out-name', 'pfx.exe');
      await js(`document.getElementById('sign-go').click()`);
      const s = await waitUntil(js, `/Signed and saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, '.pfx signing', 180000);
      t.ok(/Signed and saved/.test(s), '.pfx: signing says done', s);
      const exe = await captured(js, 'pfx.exe');
      fs.writeFileSync(path.join(tmp, 'pfx.exe'), exe);
      const v = osslVerify(path.join(tmp, 'pfx.exe'), fx.t('rsa.crt'), spawnSync);
      if (v.skip) t.note('.pfx', 'osslsigncode not found here; signature not checked');
      else t.ok(v.ok, '.pfx: the signed .exe passes osslsigncode verify', v.out);
      detail.pfx = 'signed';
    }
    t.ok((await pageErrors()).length === 0, 'no page errors while signing', (await pageErrors()).join(' | '));
    }

    // 6. Served by the build server, through the tunnel, as localhost.
    if (reverse) {
      try {
        await b.navigate(`http://localhost:${reverse.remotePort}/`);
        let s2 = null;
        for (const end = Date.now() + 90000; Date.now() < end && !s2; await sleep(500)) {
          s2 = await b.run(`var m = document.documentElement.getAttribute('data-ti-missing'); try { if (${STARTED}) return { m: m }; } catch (e) {} return m ? { m: m } : null;`).catch(() => null);
        }
        t.ok(s2 && s2.m === '', 'served (http://localhost through the tunnel): the page starts, WebCrypto and all', s2 && s2.m);
        if (s2 && s2.m === '') {
          await sleep(1500);
          t.ok(!await js(`document.documentElement.classList.contains('ti-local')`), 'served: the page uses the build server');
        }
      } catch (e) {
        t.ok(false, 'served (http://localhost through the tunnel): the page starts', e.message);
      }
    }
    // 'incomplete' is not 'pass'. A cell that skipped checks has not
    // shown the thing those checks were for, and reporting it green
    // makes the grid say more than the run established.
    if (t.failed) return finish('fail', t.checks.filter((c) => c.pass === false).map((c) => c.name).slice(0, 3).join('; '));
    if (t.noted) return finish('incomplete', t.checks.filter((c) => c.note !== undefined).map((c) => c.name).slice(0, 3).join('; '));
    return finish('pass', '');
  } catch (e) {
    t.checks.push({ name: 'run', pass: false, detail: String(e.stack || e).slice(0, 1500) });
    const infra = /^(driver|no driver|scp|.*no browsers\.json|session not created|no connection|timeout)/i.test(e.message) || !b;
    return finish(infra ? 'error' : 'fail', e.message.split('\n')[0].slice(0, 300));
  } finally {
    detail.driverLog = driverLog.join('').slice(-4000);
    if (session) await session.delete();
    if (cdpConn) await cdpConn.close();
    if (pwConn) await pwConn.close();
    if (/^(cdp|marionette)$/.test(rec.protocol) && cdpPort) remote.stopCdpBrowser(cdpPort);
    if (ssh) { try { ssh.stdin.end(); } catch (e) { /* gone */ } ssh.kill(); }
    if (revProc) revProc.kill();
    if (staticProc) staticProc.kill();
    if (entry) remote.stopDrivers(entry);
    remote.remove(remote.dir('work', 'dl-' + runId));
    if (/^(cdp|marionette)$/.test(rec.protocol)) remote.remove(remote.dir('work', 'tiprof-' + runId));
    if (flag('--keep')) console.log('kept ' + tmp); else fs.rmSync(tmp, { recursive: true, force: true });
    Object.assign(detail, rec, { checks: t.checks });
    fs.mkdirSync(RESULTS, { recursive: true });
    const f = path.join(RESULTS, `${stamp}-${machine.name}-${browserId}.json`);
    fs.writeFileSync(f, JSON.stringify(detail, null, 1) + '\n');
    rec.details = path.relative(HERE, f);
  }
}

async function waitUntil(js, expr, what, ms = 90000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    const v = await js(expr);
    if (v) return v;
  }
  throw new Error('timed out waiting for ' + what);
}

/* ---------- main ---------- */

async function main() {
  const machines = loadMachines();
  if (flag('--inventory')) return refreshInventory(machines, machines.filter((m) => !arg('--machine') || m === findMachine(machines, arg('--machine'))));
  const inv = readInventory();
  const all = pairs(inv);
  const usage = readUsage();
  if (flag('--list')) {
    const counts = {};
    for (const u of usage) counts[u.machine + '/' + u.browser] = (counts[u.machine + '/' + u.browser] || 0) + 1;
    for (const p of all) console.log(`${String(counts[p.machine + '/' + p.browser] || 0).padStart(3)}  ${p.machine}/${p.browser}`);
    return;
  }
  if (!fs.existsSync(PAGE)) { console.log('no page at ' + PAGE + '; build it: python3 tools/build_site.py'); process.exit(2); }
  const seed = arg('--seed') !== undefined ? Number(arg('--seed')) >>> 0 : crypto.randomBytes(4).readUInt32LE(0);
  const rand = rng(seed);
  const count = Number(arg('--count', 1));
  const jobs = Math.max(1, Number(arg('--jobs', 1)));
  let served = !flag('--no-served');
  if (served) {
    try { served = (await fetch(SERVER + '/api/health', { signal: AbortSignal.timeout(3000) })).ok; } catch (e) { served = false; }
    if (!served) console.log(`no build server at ${SERVER}; skipping the served check`);
  }
  let forced = null;
  if (arg('--machine') || arg('--browser')) {
    const m = arg('--machine') && findMachine(machines, arg('--machine'));
    if (arg('--machine') && !m) { console.log('unknown machine ' + arg('--machine')); process.exit(2); }
    forced = all.filter((p) => (!m || p.machine === m.name) && (!arg('--browser') || p.browser === arg('--browser')));
    if (!forced.length) { console.log('no such pair in tests/browsers/inventory.json (run --inventory?)'); process.exit(2); }
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-browsers-'));
  console.log(`seed ${seed}, ${count} run(s), ${jobs} at a time`);
  const busy = new Set();
  let started = 0, failures = 0;
  const worker = async () => {
    while (started < count) {
      const p = pick(forced || all, readUsage(), rand, busy);
      if (!p) { await sleep(2000); continue; }
      started++;
      busy.add(p.machine);
      const m = findMachine(machines, p.machine);
      console.log(`--> ${p.machine}/${p.browser}`);
      const rec = await runPair(m, p.browser, { seed, served, tmpRoot });
      busy.delete(p.machine);
      fs.appendFileSync(USAGE, JSON.stringify(rec) + '\n');
      writeCompat();
      if (!/^(pass|unsupported)/.test(rec.result)) failures++;
      console.log(`<-- ${p.machine}/${p.browser} ${rec.version}: ${rec.result} (${rec.seconds}s)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, count) }, worker));
  if (!flag('--keep')) fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

await main();
