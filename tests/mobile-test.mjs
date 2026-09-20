// The one-file site (dist/index.html, plan.md section 1.11) on phones and
// small screens. Headless Chrome with phone emulation over the DevTools
// protocol (a mobile viewport, touch, and an Android Chrome user agent and
// client hints), at 320, 360, 390, 414 and 768 CSS px; and optionally
// WebKitGTK (Safari's engine) on a test machine, at a narrow window, over
// WebDriver (tests/browsers/). Checks, in every section at every width:
//
//   - the page never scrolls sideways (scrollWidth <= innerWidth), and no
//     element reaches past the viewport unless it is inside a container
//     that scrolls (a wide table scrolls in its own box, not the page);
//   - the header's menu opens and its links work; the settings panel stays
//     inside the viewport;
//   - touch targets are at least 40 px high, and text fields have 16 px
//     text (iOS zooms into smaller ones on focus);
//   - an unsigned installer builds from the New installer form, and its
//     download links wrap their SHA-256s;
//   - the installer editor opens an .exe and a .run with their Sign panels;
//   - the Sources editor stacks its runtimes above the content, its release
//     list scrolls by touch and draws the rows it scrolls to, and a release
//     opens in a form;
//   - the folder picker is hidden where phones have none, quietly: it raises
//     no "can run, with limits" bar (design.md 11.0 item 5);
//   - the New installer form says where a build will happen;
//   - the outage banner and footer fit.
//
//   node --experimental-websocket tests/mobile-test.mjs [--page dist/index.html | --site URL]
//        [--widths 320,360,...] [--shots DIR] [--desktop DIR] [--webkit debian12] [--no-chrome]
//        [--cdp http://127.0.0.1:9222]
//
// --shots DIR    screenshots of every section at 360 px (full page).
// --desktop DIR  only screenshots of every section at 1400 px, no phone
//                emulation (to compare the desktop layout before and after).
// --webkit M     also runs the layout checks in WebKitGTK's MiniBrowser on
//                test machine M (tests/browsers/inventory.json), at 360 px.
// --cdp URL      a Chrome that is already running (Chrome on Android in the
//                emulator, through `adb forward`): no emulation is applied,
//                the device is what it is; the page is --site.
// --adb PATH     with --cdp on Android: adb, to copy the test files to the
//                device (/data/local/tmp/ib-mobile) for the file inputs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, connectCdp, sleep } from './browsers/cdp.mjs';
import { Checker, STARTED, waitFor as waitForIn, buildHello, makeSignFixtures, gpgVerify, setVal, $text } from './browsers/steps.mjs';
import { readInstaller } from '../js/ibfile.js';
import { execFileSync, spawnSync } from 'node:child_process';

if (typeof WebSocket === 'undefined') {
  console.log('usage: node --experimental-websocket tests/mobile-test.mjs [--page dist/index.html | --site URL] [--shots DIR]');
  process.exit(2);
}
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.resolve(arg('--page', path.join(HERE, '..', 'dist', 'index.html')));
const SITE = arg('--site');
// A bare origin gets its '/'; a URL with a path or query is used as it is.
let URL0 = SITE ? (/^https?:\/\/[^/?#]+$/.test(SITE) ? SITE + '/' : SITE) : 'file://' + PAGE;
const WIDTHS = arg('--widths', '320,360,390,414,768').split(',').map(Number);
const SHOTS = arg('--shots');
const DESKTOP = arg('--desktop');
const WEBKIT = arg('--webkit');
const CDP = arg('--cdp');
const ADB = arg('--adb');
const DEVICE_DIR = '/data/local/tmp/ib-mobile';
const SHOT_WIDTH = 360;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-mobile-'));
const t = new Checker();
const ok = t.ok.bind(t);
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
if (DESKTOP) fs.mkdirSync(DESKTOP, { recursive: true });

// Chrome on a Pixel-sized Android phone.
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36';
const ANDROID_HINTS = {
  brands: [{ brand: 'Google Chrome', version: '144' }, { brand: 'Chromium', version: '144' }, { brand: 'Not.A/Brand', version: '99' }],
  fullVersionList: [{ brand: 'Google Chrome', version: '144.0.7559.132' }, { brand: 'Chromium', version: '144.0.7559.132' }],
  platform: 'Android', platformVersion: '14.0.0', architecture: 'arm', model: 'Pixel 8', mobile: true, bitness: '64',
};

/* ---------- in the page: what the checks measure ---------- */

// Every element that reaches past the viewport, unless something between it
// and the page clips or scrolls it and itself fits; and the page's own width.
const AUDIT = `(() => {
  const iw = window.innerWidth, de = document.documentElement;
  const desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const shown = (e) => { const s = getComputedStyle(e); return s.visibility !== 'hidden' && s.opacity !== '0' && e.getClientRects().length > 0; };
  const inScroller = (e) => {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (/auto|scroll|hidden|clip/.test(s.overflowX)) { const r = p.getBoundingClientRect(); return r.right <= iw + 1 && r.left >= -1; }
    }
    return false;
  };
  const wide = [];
  for (const e of document.body.querySelectorAll('*')) {
    if (/^(SCRIPT|STYLE|TEMPLATE|OPTION|OPTGROUP|BR)$/.test(e.tagName)) continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || (r.right <= iw + 1 && r.left >= -1)) continue;
    if (!shown(e) || inScroller(e)) continue;
    wide.push(desc(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  // Touch targets: controls, and links that are buttons or nav.
  const small = [], tinyText = [];
  const TARGETS = 'button, .button, select, textarea, summary, .site-header nav > a, .ib-menu-btn, .tab, .lang-choice, label.choice, .icon-tile, .rt-rt, .rt-vrow, ' +
    'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])';
  // File inputs the page shows as they are (not those inside a button-styled label).
  for (const e of document.querySelectorAll('input[type=file]')) {
    if (!shown(e) || e.hidden || e.closest('label.button, .rt-file')) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 2 && r.height < 39.5) small.push(desc(e) + ' ' + Math.round(r.height) + 'px');
  }
  for (const e of document.querySelectorAll(TARGETS)) {
    if (!shown(e) || e.closest('[hidden]')) continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height || r.width < 2) continue;         // visually hidden inputs
    if (e.closest('.rt-file') && e.tagName === 'INPUT') continue;
    if (r.height < 39.5) small.push(desc(e) + ' ' + Math.round(r.height) + 'px');
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && parseFloat(getComputedStyle(e).fontSize) < 16) tinyText.push(desc(e) + ' ' + getComputedStyle(e).fontSize);
  }
  return { iw, sw: de.scrollWidth, wide: wide.slice(0, 12), nWide: wide.length, small: small.slice(0, 12), nSmall: small.length, tinyText: tinyText.slice(0, 8), nTiny: tinyText.length };
})()`;

/* ---------- a browser: Chrome over CDP, or WebKitGTK over WebDriver ---------- */

let B;   // { name, js, shot(file), setFile(sel, file), tap(sel), touchScroll(sel, dy), errors }

async function chromeBrowser() {
  const c = CDP ? await connectCdp(CDP) : await launchChrome({ profile: path.join(TMP, 'profile'), downloads: path.join(TMP, 'dl') });
  if (CDP) { await c.cdp('Runtime.enable'); await c.cdp('Page.enable'); }
  const shot = async (file) => {
    const m = await c.cdp('Page.getLayoutMetrics');
    const h = Math.ceil(m.cssContentSize.height), width = m.cssLayoutViewport.clientWidth;
    // A long page in parts of 3000 px (file.png, file-2.png, ...): very tall
    // images don't open in most viewers.
    const files = [];
    for (let y = 0, i = 1; y < h; y += 3000, i++) {
      const r = await c.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width, height: Math.min(3000, h - y), scale: 1 } });
      const f = i === 1 ? file : file.replace(/\.png$/, `-${i}.png`);
      fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
      files.push(f);
    }
    return files;
  };
  const center = async (sel) => c.js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  const tap = async (sel) => {
    const [x, y] = await center(sel);
    await c.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    await c.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(250);
  };
  // A finger dragging up over the element, in small steps (big ones don't
  // make Chrome scroll).
  const touchScroll = async (sel, dy) => {
    const [x, y] = await center(sel);
    const n = Math.ceil(dy / 10);
    await c.cdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y + dy / 2 }] });
    for (let i = 1; i <= n; i++) {
      await c.cdp('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + dy / 2 - (dy * i) / n }] });
      await sleep(16);
    }
    await c.cdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(500);
  };
  // On a device, the files are its own: copied there with adb.
  const setFile = ADB ? (sel, local) => c.setFile(sel, DEVICE_DIR + '/' + path.basename(local)) : c.setFile;
  return { name: CDP ? 'device' : 'chrome', c, js: c.js, shot, tap, touchScroll, setFile, errors: c.errors, close: () => (CDP ? c.close() : c.close()) };
}

async function emulate(width, { mobile = true } = {}) {
  const c = B.c;
  const height = width >= 768 ? 1024 : 740;
  await c.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, screenWidth: width, screenHeight: height });
  await c.cdp('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  if (mobile) await c.cdp('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l', userAgentMetadata: ANDROID_HINTS });
  else await c.cdp('Emulation.setUserAgentOverride', { userAgent: '' });
  await c.cdp('Emulation.setEmitTouchEventsForMouse', { enabled: mobile, configuration: 'mobile' }).catch(() => {});
}

// WebKitGTK's MiniBrowser on a test machine: the driver there, reached
// through `ssh -L` (tests/browsers/remote.mjs), the page copied over.
async function webkitBrowser(machineName) {
  const { loadMachines, findMachine, freePort, Remote } = await import('./browsers/remote.mjs');
  const { Session, evalIn, waitForDriver } = await import('./browsers/webdriver.mjs');
  const inv = JSON.parse(fs.readFileSync(path.join(HERE, 'browsers', 'inventory.json'), 'utf8'));
  const entry = (inv.machines[machineName].browsers || []).find((b) => b.id === 'webkitgtk');
  if (!entry) throw new Error('no webkitgtk on ' + machineName);
  const r = new Remote(findMachine(loadMachines(), machineName));
  r.readManifest();
  const work = r.dir('work', 'mobile-' + process.pid);
  r.mkdir(work);
  const remotePage = work + '/index.html';
  r.put(PAGE, remotePage);
  // WebKitGTK's windows can't be made phone-narrow (MiniBrowser's is at
  // least about 450 px), so the page runs in a 360 px frame of a page of
  // our own; media queries and innerWidth inside it are the frame's.
  const wrapper = path.join(TMP, 'frame.html');
  fs.writeFileSync(wrapper, `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>` +
    `<body style="margin:0;background:#888"><iframe id="f" style="display:block;width:${SHOT_WIDTH}px;height:740px;border:0;background:#fff"></iframe></body></html>`);
  r.put(wrapper, work + '/frame.html');
  const fx = await makeSignFixtures(TMP);
  r.put(fx.t('in.exe'), work + '/in.exe');
  r.put(fx.t('in.run'), work + '/in.run');
  r.stopDrivers(entry);
  const port = await freePort();
  const log = [];
  const drv = r.startDriver(entry, { port, log: (d) => log.push(String(d)) });
  const base = `http://127.0.0.1:${port}`;
  await waitForDriver(base, 60000);
  const s = await Session.create(base, { browserName: entry.browserName || 'MiniBrowser', 'webkitgtk:browserOptions': { binary: entry.binary, args: entry.args || [] } });
  const js = (expr) => evalIn(s, expr);
  await s.navigate(r.fileUrl(work + '/frame.html'));
  const intoFrame = async () => { await s.cmd('POST', '/frame', { id: null }); const f = await s.find('#f'); await s.cmd('POST', '/frame', { id: { 'element-6066-11e4-a52e-4f735466cecf': f } }); };
  const load = async (url) => {
    await s.cmd('POST', '/frame', { id: null });
    await s.run(`document.getElementById('f').src = 'about:blank'`);
    await sleep(300);
    await s.run(`document.getElementById('f').src = arguments[0]`, [url]);
    await sleep(1500);
    await intoFrame();
  };
  const shot = async (file) => { const png = await s.cmd('GET', '/screenshot'); fs.writeFileSync(file, Buffer.from(png, 'base64')); };
  const setFile = async (sel, local) => { const el = await s.find(sel); await s.sendKeys(el, work + '/' + path.basename(local)); };
  const tap = async (sel) => {
    await js(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'nearest' })`);
    await sleep(300);
    await s.click(await s.find(sel));
    await sleep(250);
  };
  const touchScroll = async (sel, dy) => { await js(`document.querySelector(${JSON.stringify(sel)}).scrollTop += ${dy}`); await sleep(400); };
  return {
    name: 'webkitgtk ' + entry.version, s, js, load, shot, tap, touchScroll, setFile, errors: [], url: r.fileUrl(remotePage), fx,
    close: async () => { await s.delete(); drv.stdin.end(); drv.kill(); r.stopDrivers(entry); r.remove(work); },
  };
}

/* ---------- steps ---------- */

const waitFor = (expr, what, ms = 60000) => waitForIn(B.js, expr, what, ms, B.errors);
const go = async (hash) => { await B.js(`location.hash = ${JSON.stringify(hash)}`); await sleep(350); };
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'; })()`;

async function open(url) {
  if (B.c) {
    B.errors.length = 0;
    await B.c.cdp('Page.navigate', { url });
  } else await B.load(url);
  await sleep(500);
  await waitFor(STARTED, 'the page to start', 120000);
  await sleep(300);
}

// Layout checks for the state the page is in now, and its screenshot.
async function audit(w, what, { shots, targets = true } = {}) {
  await sleep(150);
  const a = await B.js(AUDIT);
  const tag = `${B.name} ${w}px ${what}:`;
  ok(a.sw <= a.iw, `${tag} no sideways scrolling (scrollWidth ${a.sw} <= ${a.iw})`, a.wide.join(', '));
  ok(a.nWide === 0, `${tag} no element wider than the viewport`, a.nWide + ': ' + a.wide.join(', '));
  if (targets) {
    ok(a.nSmall === 0, `${tag} touch targets at least 40 px high`, a.nSmall + ': ' + a.small.join(', '));
    ok(a.nTiny === 0, `${tag} text fields at 16 px`, a.nTiny + ': ' + a.tinyText.join(', '));
  }
  if (shots) {
    const file = path.join(shots, `${B.name.split(' ')[0]}-${w}-${what}.png`);
    try { const fs2 = await B.shot(file); shotList.push(...(fs2 || [file])); } catch (e) { t.note(`${tag} screenshot`, e.message); }
  }
  return a;
}
const shotList = [];

async function header(w, shots) {
  const menu = await B.js(visible('.ib-menu-btn'));
  const narrow = w < 600;
  if (narrow) ok(menu, `${B.name} ${w}px header: the nav collapses into a menu button`);
  if (menu) {
    ok(await B.js(`document.querySelector('.ib-menu-btn').getAttribute('aria-expanded') === 'false' && !(${visible('.site-header nav > a[href="#runtimes"]')})`),
      `${B.name} ${w}px header: the menu starts closed`);
    await B.tap('.ib-menu-btn');
    const opened = () => B.js(`document.querySelector('.ib-menu-btn').getAttribute('aria-expanded') === 'true'`);
    // A freshly started Chrome on Android can swallow the very first touch.
    if (!(await opened()) && CDP) { t.note(`${B.name} ${w}px header`, 'the first tap did nothing; tapping again'); await sleep(500); await B.tap('.ib-menu-btn'); }
    ok(await opened(), `${B.name} ${w}px header: the menu button opens the menu`);
  }
  const links = await B.js(`Array.prototype.map.call(document.querySelectorAll('.site-header nav > a'), (a) => { const r = a.getBoundingClientRect(); return [a.textContent.trim(), Math.round(r.left), Math.round(r.right), Math.round(r.height), a.getClientRects().length > 0]; })`);
  ok(links.length === 4 && links.every((l) => l[4] && l[1] >= 0 && l[2] <= w), `${B.name} ${w}px header: the four links show inside the viewport`, JSON.stringify(links));
  await audit(w, menu ? 'menu-open' : 'header', { shots });
  await B.tap('.site-header nav > a[href="#runtimes"]');
  ok(await B.js(`location.hash === '#runtimes'`), `${B.name} ${w}px header: a nav link goes to its section`);
  if (menu) ok(await B.js(`document.querySelector('.ib-menu-btn').getAttribute('aria-expanded') === 'false'`), `${B.name} ${w}px header: following a link closes the menu`);
  await go('#home');
  // The settings panel.
  if (menu) await B.tap('.ib-menu-btn');
  await B.tap('.settings-btn');
  const p = await B.js(`(() => { const r = document.querySelector('.settings-panel').getBoundingClientRect(); return document.querySelector('.settings-panel').hidden ? null : [Math.round(r.left), Math.round(r.right), Math.round(r.width)]; })()`);
  ok(p && p[0] >= 0 && p[1] <= w, `${B.name} ${w}px header: the settings panel opens inside the viewport`, JSON.stringify(p));
  await audit(w, 'settings', { shots });
  await B.js(`document.querySelector('.api-ctl-cancel').click()`);
  await sleep(100);
  if (menu && await B.js(`document.querySelector('.ib-menu-btn').getAttribute('aria-expanded') === 'true'`)) await B.tap('.ib-menu-btn');
}

async function newInstaller(w, shots) {
  await go('#new');
  await audit(w, 'new', { shots });
  // Where the build will happen, in plain words (design.md 11.0 item 6):
  // short enough to read on a phone, and on no more than three lines.
  const where = await B.js(`(() => { const e = document.querySelector('.ib-page[data-page="new"] .build-where');
    if (!e) return null; const r = e.getBoundingClientRect();
    return { text: e.textContent, left: Math.round(r.left), right: Math.round(r.right), height: Math.round(r.height),
      line: Math.round(parseFloat(getComputedStyle(e).lineHeight) || 20) }; })()`);
  ok(where && /^Built (in this page|by the build server at )/.test(where.text),
    `${B.name} ${w}px new: it says where the build happens`, JSON.stringify(where));
  ok(where && where.left >= 0 && where.right <= w && where.height <= where.line * 3 + 4,
    `${B.name} ${w}px new: that line fits the width, in three lines or fewer`, JSON.stringify(where));
  // Phones have no folder picker: "Pick a folder" is hidden, the archive stays.
  await B.js(`document.getElementById('src-local').click()`);
  await sleep(200);
  const mobileUa = !!B.c;
  if (mobileUa) {
    ok(!(await B.js(visible('#local-folder-label'))) && await B.js(visible('#local-archive-label')),
      `${B.name} ${w}px new: no folder picker on a phone, the archive picker stays`);
  }
  await audit(w, 'new-local', { targets: false });
  await B.js(`document.getElementById('src-repo').click()`);
  await go('#new&write');
  ok(await B.js(visible('.write-editor textarea.code')), `${B.name} ${w}px new: "I'll write it here" shows the code editor`);
  const ed = await B.js(`(() => { const e = Array.prototype.find.call(document.querySelectorAll('.write-editor textarea.code'), (x) => x.getClientRects().length); const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })()`);
  ok(ed[0] >= 0 && ed[1] <= w, `${B.name} ${w}px new: the code editor fits the width`, JSON.stringify(ed));
  await audit(w, 'new-write', { shots });
  // Architecture, which the form states for an ordinary installer: three
  // short lines per platform, each inside the viewport.
  await go('#new');
  const arch = await B.js(`[...document.querySelectorAll('.ib-page[data-page="new"] #arch-cover .arch-cover-arches > li')]
    .map((li) => { const r = li.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; })`);
  ok(arch.length >= 3 && arch.every(([l, r]) => l >= 0 && r <= w),
    `${B.name} ${w}px new: the architecture lines fit the width`, JSON.stringify(arch.slice(0, 4)));
  // Every Customise group open, and the tables in them -- with the packed
  // installer's target picker showing, since its boxes are new controls in
  // a table and it is off by default.
  await B.js(`document.querySelectorAll('.ib-page[data-page="new"] details').forEach((d) => { d.open = true; });
    const f = document.getElementById('new-form'); f.elements.offline.checked = true;
    f.dispatchEvent(new Event('change', { bubbles: true }));`);
  await sleep(300);
  const packed = await B.js(`(() => { const t = document.getElementById('offline-targets');
    if (!t || !t.getClientRects().length) return null;
    const wrap = t.closest('.table-wrap').getBoundingClientRect();
    return { boxes: t.querySelectorAll('input[type=checkbox]').length,
      low: Math.min(...[...t.querySelectorAll('label.choice')].map((l) => Math.round(l.getBoundingClientRect().height))),
      wrapRight: Math.round(wrap.right), wrapLeft: Math.round(wrap.left) }; })()`);
  ok(packed && packed.boxes >= 12, `${B.name} ${w}px new: the packed picker shows a box per system and architecture`, JSON.stringify(packed));
  ok(packed && packed.low >= 40, `${B.name} ${w}px new: each architecture box is a 40 px touch target`, JSON.stringify(packed));
  ok(packed && packed.wrapLeft >= 0 && packed.wrapRight <= w + 1,
    `${B.name} ${w}px new: the packed picker's table scrolls in its own box, not the page`, JSON.stringify(packed));
  await audit(w, 'new-customise', { shots });
  await B.js(`(() => { const f = document.getElementById('new-form'); f.elements.offline.checked = false;
    f.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  // The compatibility bar and its matrix, where it shows.
  if (await B.js(visible('.ib-compat-more'))) {
    await B.js(`document.querySelector('.ib-compat-more').click()`);
    await sleep(200);
    await audit(w, 'compat-details', { shots });
    await B.js(`document.querySelector('.ib-compat-more').click()`);
  }
  await B.js(`document.querySelectorAll('.ib-page[data-page="new"] details').forEach((d) => { d.open = false; })`);
}

async function build(w, shots) {
  // Served by a build server, the build is the page's own ("No server" in
  // the settings, as a person would choose it): the steps read its jobs.
  if (!(await B.js(`document.documentElement.classList.contains('ib-local')`))) {
    await B.js(`document.querySelector('.api-ctl-edit').click(); document.querySelector('.api-ctl-local').click()`);
    await sleep(300);
  }
  const job = await buildHello(B.js, { runtime: 'python', mode: 'unsigned', name: 'Hello phone ' + w + (ADB ? ' ' + Date.now().toString(36) : ''), code: "print('hello from a phone')\n", platforms: ['windows', 'linux', 'macos'] });
  ok(job && job.status === 'done' && job.result.files.length === 3, `${B.name} ${w}px build: an unsigned installer builds from the form`, JSON.stringify(job).slice(0, 300));
  await waitFor(`!document.getElementById('job-downloads').hidden && document.querySelectorAll('#job-files a[download]').length === 3`, 'the download links');
  const sha = await B.js(`(() => { const s = document.querySelector('#job-files .sha'); const r = s.getBoundingClientRect(); const wrap = document.querySelector('#job-downloads .table-wrap').getBoundingClientRect(); return [Math.round(r.right), Math.round(wrap.right), s.getClientRects().length]; })()`);
  ok(sha[0] <= w && sha[0] <= sha[1] + 1, `${B.name} ${w}px build: the SHA-256 wraps inside its box`, JSON.stringify(sha));
  await audit(w, 'build', { shots });
  return job;
}

async function editor(w, shots) {
  await go('#edit');
  await audit(w, 'edit', { shots });
  const fx = B.fx;
  await B.setFile('#installer', fx.t('in.exe'));
  await waitFor(`!document.getElementById('sign-exe').hidden`, 'the Windows sign panel');
  await audit(w, 'edit-exe', { shots });
  await B.setFile('#installer', fx.t('in.run'));
  await waitFor(`!document.getElementById('sign-run').hidden`, 'the Linux sign panel');
  await audit(w, 'edit-run', { shots });
}

async function sources(w, shots) {
  await go('#runtimes');
  await waitFor(`!document.getElementById('rt-app').hidden && document.querySelectorAll('#rt-rel-list .rt-vrow').length > 3`, 'the Sources editor');
  const lay = await B.js(`(() => { const a = document.getElementById('rt-runtimes').getBoundingClientRect(), b = document.querySelector('.rt-main').getBoundingClientRect(); return [Math.round(a.bottom), Math.round(b.top), Math.round(a.right), Math.round(b.left)]; })()`);
  if (w < 800) ok(lay[0] <= lay[1] + 1, `${B.name} ${w}px sources: the runtimes are above the content`, JSON.stringify(lay));
  await audit(w, 'sources', { shots });
  // Touch scrolling the release list draws the rows scrolled to.
  const before = await B.js(`document.getElementById('rt-rel-list').scrollTop`);
  await B.touchScroll('#rt-rel-list', 300);
  const after = await B.js(`(() => { const l = document.getElementById('rt-rel-list'), rows = Array.prototype.map.call(l.querySelectorAll('.rt-vrow'), (r) => r.offsetTop);
    return [l.scrollTop, Math.min.apply(null, rows), Math.max.apply(null, rows) + (l.querySelector('.rt-vrow') || {}).offsetHeight, l.clientHeight]; })()`);
  ok(after[0] > before, `${B.name} ${w}px sources: the release list scrolls by touch`, JSON.stringify([before, after]));
  ok(after[1] <= after[0] && after[2] >= after[0] + after[3], `${B.name} ${w}px sources: rows are drawn for the scrolled-to part of the list`, JSON.stringify(after));
  const rowH = await B.js(`document.querySelector('#rt-rel-list .rt-vrow').getBoundingClientRect().height`);
  ok(rowH >= 39.5, `${B.name} ${w}px sources: release rows are at least 40 px high`, rowH);
  await B.js(`document.getElementById('rt-rel-list').scrollIntoView({ block: 'nearest' })`);
  await sleep(400);
  const k = await B.js(`(() => { const l = document.getElementById('rt-rel-list'); const r = Array.prototype.find.call(l.querySelectorAll('.rt-vrow'), (x) => x.getBoundingClientRect().top >= l.getBoundingClientRect().top); r.id = 'ib-test-row'; return r.dataset.k; })()`);
  await B.tap('#ib-test-row');
  await waitFor(`!document.getElementById('rt-detail').hidden`, 'the release form');
  ok(await B.js(`!!document.querySelector('#rt-detail input')`), `${B.name} ${w}px sources: tapping release ${k} opens its form`);
  await audit(w, 'sources-release', { shots });
  for (const tab of ['recipes', 'rules', 'policy']) {
    await B.js(`document.querySelector('#rt-tabs [data-tab="${tab}"]').click()`);
    await sleep(300);
    await audit(w, 'sources-' + tab, { shots: tab === 'recipes' ? shots : null });
  }
  await B.js(`document.querySelector('#rt-tabs [data-tab="releases"]').click()`);
}

async function banner(w, shots) {
  const u = new URL(URL0);
  u.searchParams.set('api', 'http://127.0.0.1:9');
  u.hash = '#home';
  await open(u.href);
  await waitFor(`!!document.querySelector('.api-banner') && !document.querySelector('.api-banner').hidden`, 'the outage banner', 30000);
  await B.js(`window.scrollTo(0, 0)`);
  await audit(w, 'banner', { shots });
  await B.js(`window.scrollTo(0, document.body.scrollHeight)`);
  await audit(w, 'footer', { targets: true });
  await B.js(`localStorage.removeItem('ib.api')`);
}

/* ---------- on a device: downloads land in its Download folder ---------- */

const DL_DIR = '/sdcard/Download';
const adb = (...a) => execFileSync(ADB, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
// Chrome names a download "x (1).y" when it remembers an "x.y", even one
// deleted since: the newest of those is the one.
const deviceName = (name) => {
  const dot = name.lastIndexOf('.'), stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let list = '';
  try { list = adb('shell', `ls -t '${DL_DIR}'`); } catch (e) { return null; }
  return list.split('\n').map((l) => l.trim()).find((l) => l === name || (l.startsWith(stem + ' (') && l.endsWith(')' + ext))) || null;
};
const deviceSize = (name) => {
  const n = deviceName(name);
  if (!n) return 0;
  try { return Number(adb('shell', `stat -c %s '${DL_DIR}/${n}'`).trim()) || 0; } catch (e) { return 0; }
};
// (uiautomator needs the device's animations off to see an idle screen:
// adb shell settings put global window_animation_scale 0, and the
// transition and animator scales.)
// Chrome on Android asks before saving over a name it has saved before
// ("Download file again?") and before a second download from one tap
// ("... wants to download multiple files"): answered as a person would.
function answerDialog() {
  try {
    // uiautomator may say "could not get idle state" and still write the dump.
    spawnSync(ADB, ['shell', 'rm -f /sdcard/ib-ui.xml; uiautomator dump /sdcard/ib-ui.xml'], { stdio: 'ignore' });
    const xml = adb('shell', 'cat /sdcard/ib-ui.xml 2>/dev/null; true');
    const q = /Download file again/.test(xml) ? ['Download file again?', /text="Download again"/.test(xml) ? 'Download again' : 'Download']
      : /download multiple files/.test(xml) ? ['wants to download multiple files', 'Allow'] : null;
    if (!q) return false;
    const m = new RegExp('text="' + q[1] + '"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"').exec(xml);
    if (!m) return false;
    adb('shell', `input tap ${(+m[1] + +m[3]) >> 1} ${(+m[2] + +m[4]) >> 1}`);
    t.note(`${B.name}: download dialog`, `Chrome asked "${q[0]}"; tapped ${q[1]}`);
    return true;
  } catch (e) { return false; }
}
async function deviceFile(name, size, ms = 60000) {
  let next = Date.now() + 2000;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    if (Date.now() > next) { answerDialog(); next = Date.now() + 2000; }
    const n = deviceSize(name);
    if (n && (!size || n === size)) return n;
  }
  return deviceSize(name);
}
function pull(name) {
  const local = path.join(TMP, 'pulled-' + name);
  execFileSync(ADB, ['pull', `${DL_DIR}/${deviceName(name)}`, local], { stdio: 'ignore' });
  return local;
}

async function deviceDownloads(job) {
  const tag = `${B.name}:`;
  const run = 'app' + Date.now().toString(36);
  // Earlier runs' files, so that each file checked is this run's.
  adb('shell', `rm -f ${DL_DIR}/tiddlyinstall*.html ${DL_DIR}/install_python_hello_phone_* ${DL_DIR}/app*.run* ${DL_DIR}/Phone_*`);
  // A tap on a download link saves the installer.
  await go('#build&job=' + job.id);
  await waitFor(`document.querySelectorAll('#job-files a[download]').length === 3`, 'the download links');
  const exe = job.result.files.find((f) => f.platform === 'windows');
  await B.js(`document.querySelector('#job-files a[download="${exe.name}"]').id = 'ib-test-dl'`);
  await B.tap('#ib-test-dl');
  const got = await deviceFile(exe.name, exe.size);
  ok(got === exe.size, `${tag} tapping the .exe link saves it to ${DL_DIR} (${exe.size} bytes)`, got);
  if (got === exe.size) {
    const info = await readInstaller(new Uint8Array(fs.readFileSync(pull(exe.name))), exe.name);
    ok(info.kind === 'exe' && !!info.record, `${tag} the saved .exe reads back with its record`);
  }
  // "Save this page".
  const size = await B.js(`new Blob([IB_PRISTINE]).size`);
  await B.tap('.save-page');
  const saved = await deviceFile('tiddlyinstall.html', size);
  ok(saved === size, `${tag} "Save this page" saves the page (${size} bytes)`, saved);
  // Signing a .run with a new Ed25519 key: the .run, its .asc and the public key.
  await go('#edit');
  await B.setFile('#installer', B.fx.t('in.run'));
  await waitFor(`!document.getElementById('sign-run').hidden`, 'the Linux sign panel');
  await setVal(B.js, 'pgp-uid', `Phone ${run} TEST <phone@example.invalid>`);
  const t0 = Date.now();
  await B.tap('#pgp-make');
  const made = await waitFor(`/New key|rror|can't/.test(${$text('pgp-status')}) && ${$text('pgp-status')}`, 'the key');
  ok(/New key/.test(made), `${tag} makes an Ed25519 key (${Date.now() - t0} ms)`, made);
  await B.tap('#pgp-pub-dl');
  await setVal(B.js, 'out-name', run + '.run');
  await B.tap('#sign-go');
  const st = await waitFor(`/Saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'pgp signing');
  ok(/Saved/.test(st), `${tag} signs the .run`, st);
  const pubName = `Phone ${run} TEST <phone@example.invalid>`.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40) + '.pub.asc';   // js/sign-ui.js fileSafe
  // On a phone the signature is a tap of its own (js/sign-ui.js).
  ok(/Now save its signature/.test(st) && await B.js(visible('#sign-asc-again')), `${tag} after signing, the signature is offered as its own tap`, st);
  await B.tap('#sign-asc-again');
  const present = [];
  for (const n of [pubName, run + '.run', run + '.run.asc']) present.push([n, await deviceFile(n, 0, 20000)]);
  ok(present.every(([, n]) => n > 0), `${tag} the signed .run, its .asc and the public key are all saved`, JSON.stringify(present));
  if (present.every(([, n]) => n > 0)) {
    const g = gpgVerify(pull(pubName), pull(run + '.run.asc'), pull(run + '.run'), path.join(TMP, 'gnupg'), spawnSync);
    ok(g.ok, `${tag} gpg --verify: Good signature for the .run signed on the phone`, g.out);
  }
}

async function allSections(w, shots) {
  if (B.c) { await B.c.cdp('Page.navigate', { url: 'about:blank' }); await sleep(300); }   // a fresh start at each width
  await open(URL0 + '#home');
  ok(B.errors.length === 0, `${B.name} ${w}px: the page starts without errors`, B.errors.join(' | '));
  ok(await B.js(`!!document.querySelector('meta[name=viewport][content*="width=device-width"]')`), `${B.name} ${w}px: the page has a viewport meta tag`);
  await audit(w, 'home', { shots });
  await header(w, shots);
  await newInstaller(w, shots);
  const job = await build(w, shots);
  await B.js(`localStorage.removeItem('ib.api')`);   // the next start is as served again
  await editor(w, shots);
  if (ADB && job && job.status === 'done') await deviceDownloads(job);
  await sources(w, shots);
  await banner(w, shots);
}

/* ---------- js/browser-check.js: phones recognised ---------- */

// What the page makes of phone and tablet user agents: the OS, "a phone or
// tablet", and whether it offers the folder picker (caniuse: Safari from
// iOS/iPadOS 18.4, Chrome on Android from 147).
const UAS = [
  ['Safari, iOS 17.5', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'iPhone', { browser: 'Safari', os: 'iOS', mobile: true }, 'na'],
  ['Safari, iOS 18.4', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1', 'iPhone', { browser: 'Safari', os: 'iOS', mobile: true }, 'native'],
  ['Chrome, iOS 17', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.0.0 Mobile/15E148 Safari/604.1', 'iPhone', { browser: 'Chrome', os: 'iOS', mobile: true }, 'na'],
  ['Safari, iPadOS 17 (a Mac user agent, with touch)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'MacIntel', { browser: 'Safari', os: 'iPadOS', mobile: true }, 'na'],
  ['Chrome 146, Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36', 'Linux armv8l', { browser: 'Chrome', os: 'Android', mobile: true }, 'na'],
  ['Chrome 147, Android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36', 'Linux armv8l', { browser: 'Chrome', os: 'Android', mobile: true }, 'native'],
  ['Samsung Internet', 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/150.0.0.0 Mobile Safari/537.36', 'Linux armv8l', { browser: 'Samsung Internet', os: 'Android', mobile: true }, 'na'],
  ['Firefox, Android', 'Mozilla/5.0 (Android 14; Mobile; rv:150.0) Gecko/150.0 Firefox/150.0', 'Linux armv8l', { browser: 'Firefox', os: 'Android', mobile: true }, 'na'],
];
async function userAgents() {
  const c = B.c;
  await c.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await c.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  for (const [what, ua, platform, want, folder] of UAS) {
    await c.cdp('Emulation.setUserAgentOverride', { userAgent: ua, platform });
    await c.cdp('Page.navigate', { url: 'about:blank' });   // a new document, not a new hash
    await sleep(300);
    await open(URL0 + '#new');
    // Each of these navigations gets a new renderer, and the touch override
    // is pushed to it by the browser process: now and then the page's first
    // script runs before it lands, and navigator.maxTouchPoints is 0. That
    // is the rig failing to set up the test, not the page failing it -- the
    // iPadOS row is the only one that reads maxTouchPoints -- so put the
    // override back and load it again rather than assert on it.
    for (let tries = 0; tries < 3 && await B.js('navigator.maxTouchPoints') <= 1; tries++) {
      await c.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await c.cdp('Page.navigate', { url: 'about:blank' });
      await sleep(300);
      await open(URL0 + '#new');
    }
    const got = await B.js(`(() => { const e = ibCompat.env, b = document.querySelector('.ib-compat-bar');
      return { browser: e.browser, os: e.os, mobile: e.mobile, folder: ibCompat.status.folder, degraded: ibCompat.degraded,
      bar: !!(b && !b.hidden && b.style.display !== 'none'), barText: b ? b.textContent.slice(0, 300) : '',
      cls: document.documentElement.className, picker: !!document.getElementById('local-folder-label').getClientRects().length || getComputedStyle(document.getElementById('local-folder-label')).display !== 'none' }; })()`);
    ok(got.browser === want.browser && got.os === want.os && got.mobile === want.mobile, `user agent ${what}: seen as ${want.browser} on ${want.os}, a phone or tablet`, JSON.stringify(got));
    ok(got.folder === folder && /\bib-mobile\b/.test(got.cls) && /\bib-no-folder\b/.test(got.cls) === (folder !== 'native'),
      `user agent ${what}: folder picking ${folder === 'native' ? 'offered' : 'hidden'}`, JSON.stringify(got));
    // A phone without a folder picker is how phones are, not a limit of the
    // browser: it is hidden quietly, with no bar (design.md 11.0 item 5).
    ok(!got.degraded.includes('folder') && !(got.bar && /folder/i.test(got.barText)),
      `user agent ${what}: no compatibility bar for the missing folder picker`, JSON.stringify({ degraded: got.degraded, bar: got.bar, barText: got.barText }));
    if (folder !== 'native') ok(!got.bar, `user agent ${what}: no compatibility bar at all`, got.barText);
  }
  await c.cdp('Emulation.setUserAgentOverride', { userAgent: '' });
  await c.cdp('Emulation.setTouchEmulationEnabled', { enabled: false });
  await c.cdp('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await c.cdp('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await open(URL0 + '#new');
  const d = await B.js(`[ibCompat.env.mobile, ibCompat.status.folder, document.documentElement.className]`);
  ok(d[0] === false && d[1] === 'native' && !/ib-mobile|ib-no-folder/.test(d[2]), 'desktop Chrome: not a phone, folder picking offered', JSON.stringify(d));
}

/* ---------- desktop screenshots ---------- */

async function desktop(dir) {
  await emulate(1400, { mobile: false });
  await open(URL0 + '#home');
  const snap = async (name) => { await sleep(300); const f = path.join(dir, `desktop-1400-${name}.png`); shotList.push(...(await B.shot(f))); };
  await snap('home');
  await go('#new'); await snap('new');
  await go('#new&write'); await snap('new-write');
  await go('#new');
  await B.js(`document.querySelectorAll('.ib-page[data-page="new"] details').forEach((d) => { d.open = true; })`);
  await snap('new-customise');
  await B.js(`document.querySelectorAll('.ib-page[data-page="new"] details').forEach((d) => { d.open = false; })`);
  await go('#edit');
  await B.setFile('#installer', B.fx.t('in.exe'));
  await waitFor(`!document.getElementById('sign-exe').hidden`, 'the Windows sign panel');
  await snap('edit-exe');
  await go('#runtimes');
  await waitFor(`!document.getElementById('rt-app').hidden && document.querySelectorAll('#rt-rel-list .rt-vrow').length > 3`, 'the Sources editor');
  await snap('sources');
  await B.js(`document.querySelector('.settings-btn').click()`);
  await snap('settings');
  const a = await B.js(AUDIT);
  ok(a.sw <= a.iw, 'desktop 1400px: no sideways scrolling', a.wide.join(', '));
}

/* ---------- run ---------- */

try {
  const fx = await makeSignFixtures(TMP);
  if (!flag('--no-chrome')) {
    B = await chromeBrowser();
    B.fx = fx;
    if (ADB) {
      execFileSync(ADB, ['shell', `mkdir -p ${DEVICE_DIR} && chmod 755 ${DEVICE_DIR}`]);
      for (const f of ['in.exe', 'in.run']) {
        execFileSync(ADB, ['push', fx.t(f), DEVICE_DIR + '/' + f], { stdio: 'ignore' });
        execFileSync(ADB, ['shell', `chmod 644 ${DEVICE_DIR}/${f}`]);
      }
    }
    if (DESKTOP) {
      await desktop(DESKTOP);
    } else if (CDP) {
      const w = await B.js('innerWidth');
      console.log('connected Chrome: ' + await B.js('navigator.userAgent') + ', ' + w + ' px');
      await allSections(w, SHOTS);
    } else {
      await userAgents();
      for (const w of WIDTHS) {
        await emulate(w);
        await allSections(w, w === SHOT_WIDTH ? SHOTS : null);
      }
    }
    await B.close();
    B = null;
  }
  if (WEBKIT) {
    B = await webkitBrowser(WEBKIT);
    try {
      URL0 = B.url;
      await B.s.cmd('POST', '/window/rect', { width: 480, height: 900 }).catch(() => {});
      await open(URL0 + '#home');
      const iw = await B.js('innerWidth');
      t.note('webkitgtk viewport', `the page in a ${SHOT_WIDTH} px frame; innerWidth ${iw}; ${await B.js('navigator.userAgent')}`);
      await allSections(iw, SHOTS);
    } finally {
      await B.close();
    }
  }
} catch (e) {
  ok(false, 'the run finishes', e.stack || e.message);
} finally {
  if (B) await B.close().catch(() => {});
  fs.rmSync(TMP, { recursive: true, force: true });
}
if (shotList.length) console.log('screenshots:\n  ' + shotList.join('\n  '));
console.log(`\n${t.passed} passed, ${t.failed} failed`);
process.exit(t.failed ? 1 : 0);
