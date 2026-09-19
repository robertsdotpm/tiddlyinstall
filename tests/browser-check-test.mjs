// Checks the page's browser check (js/browser-check.js) in headless Chrome:
// no bar in a modern browser; with features taken away before the page
// loads, a bar that names the effect and recommends the browsers tested on
// this OS; its details (features, and the tested machine x browser matrix
// with the visitor's nearest row marked); dismissing; and plain http, where
// the page runs on its own cryptography. Features with a stand-in in the
// page (compression, WebCrypto, :has(), ...) show as "fallback"; ES2017
// syntax too, where the page's ES5 copy can run instead (checked here by
// running it); only a browser too old for that copy is told it "can't run".
//
//   node --experimental-websocket tests/browser-check-test.mjs [--page dist/index.html]
//        [--site http://10.0.1.76:8080] [--shot FILE.png]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchChrome, sleep } from './browsers/cdp.mjs';
import { Checker, waitFor } from './browsers/steps.mjs';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const HERE = path.dirname(new URL(import.meta.url).pathname);
const PAGE = path.resolve(arg('--page') || path.join(HERE, '..', 'dist', 'index.html'));
const SITE = arg('--site');
const SHOT = arg('--shot');
if (typeof WebSocket === 'undefined' || !fs.existsSync(PAGE)) {
  console.log('usage: node --experimental-websocket tests/browser-check-test.mjs [--page dist/index.html] [--site URL] [--shot FILE.png]');
  process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-bcheck-'));
const t = new Checker();
const ok = t.ok.bind(t);
let chrome, js;
let injected = null;

// Opens the page with `remove` (a script run before any of the page's)
// and waits for the check's verdict.
async function open(url, remove) {
  if (injected) { await chrome.cdp('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected }); injected = null; }
  if (remove) injected = (await chrome.cdp('Page.addScriptToEvaluateOnNewDocument', { source: remove })).identifier;
  await chrome.cdp('Page.navigate', { url });
  await sleep(300);
  await waitFor(js, `document.readyState === 'complete' && document.documentElement.getAttribute('data-ib-ready') === '1'`, 'the browser check', 60000);
}
const barShown = () => js(`!!document.querySelector('.ib-compat-bar:not([hidden])')`);
const barText = () => js(`(document.querySelector('.ib-compat-bar .ib-compat-text') || {}).textContent || ''`);
const FILE = 'file://' + PAGE;

try {
  chrome = await launchChrome({ profile: path.join(TMP, 'profile') });
  js = chrome.js;

  // A modern Chrome: nothing to say.
  await open(FILE);
  ok(await js(`document.documentElement.getAttribute('data-ib-missing') === '' && document.documentElement.getAttribute('data-ib-degraded') === ''`),
    'modern Chrome: nothing missing or degraded', await js(`document.documentElement.getAttribute('data-ib-degraded')`));
  ok(!await barShown(), 'modern Chrome: no bar');
  const env = await js(`ibCompat.env`);
  ok(env.browser && env.version && env.os, 'the browser, version and OS are detected', JSON.stringify(env));
  ok(await js(`!!document.getElementById('ib-compat') && JSON.parse(document.getElementById('ib-compat').textContent).results.length > 0`),
    'the tested-browsers summary is in the page');

  // Compression and WebCrypto taken away: the page works on its own
  // JavaScript; a "with limits" bar says so.
  await open(FILE, 'delete window.DecompressionStream; delete window.CompressionStream; Object.defineProperty(window.crypto, "subtle", { get: function () {} });');
  ok(await js(`document.documentElement.getAttribute('data-ib-missing') === ''`), 'without (De)CompressionStream and WebCrypto: nothing is missing',
    await js(`document.documentElement.getAttribute('data-ib-missing')`));
  const degr = await js(`document.documentElement.getAttribute('data-ib-degraded')`);
  ok(/compress/.test(degr) && /decompress/.test(degr) && /webcrypto/.test(degr), 'they are degraded (fallback)', degr);
  ok(await barShown() && !await js(`document.querySelector('.ib-compat-bar').classList.contains('ib-too-old')`), 'without them: a "with limits" bar');
  const text = await barText();
  ok(/own JavaScript/.test(text), 'the bar says the page uses its own JavaScript', text);
  ok(/Tested on Debian 12 and working: \w/.test(text), 'the bar recommends the browsers tested on the nearest OS (Linux: Debian 12)', text);
  await js(`document.querySelector('.ib-compat-more').click()`);
  const rows = await js(`Array.prototype.map.call(document.querySelectorAll('.ib-compat-details table:first-of-type tr'), (r) => r.textContent)`);
  ok(rows.some((r) => /CompressionStream.*~ fallback/.test(r)) && rows.some((r) => /:has\(\).*✓ native/.test(r)), 'details: each feature, native or fallback, and what that means', rows.join(' | '));
  ok(await js(`document.querySelectorAll('.ib-compat-matrix tr[data-machine]').length >= 5`), 'details: the tested matrix renders');
  ok(await js(`(document.querySelector('.ib-compat-matrix tr.ib-you') || {}).dataset?.machine === 'debian12' && !!document.querySelector('.ib-compat-matrix tr.ib-you td.ib-you')`),
    'details: the nearest machine row and this browser\'s cell are marked');
  if (SHOT) {
    const { data } = await chrome.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    await js(`document.querySelector('.ib-compat-matrix').scrollIntoView()`);
    const m = await chrome.cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT.replace(/\.png$/, '') + '-matrix.png', Buffer.from(m.data, 'base64'));
    console.log('screenshots: ' + SHOT + ', ' + SHOT.replace(/\.png$/, '') + '-matrix.png');
  }

  // A JavaScript without async functions (IE 11, Chrome 49): the page runs
  // its ES5 copy (js/page-loader.js), and the bar says so.
  const NO_ASYNC = '(function () { var F = Function; window.Function = function () { if (/async/.test(String(arguments[arguments.length - 1]))) throw new SyntaxError("old"); return F.apply(this, arguments); }; window.Function.prototype = F.prototype; })();';
  await open(FILE, NO_ASYNC);
  ok(await js(`document.documentElement.getAttribute('data-ib-missing') === '' && ibCompat.status.syntax === 'fallback'`), 'without ES2017 syntax: the ES5 copy stands in (fallback, nothing missing)',
    await js(`document.documentElement.getAttribute('data-ib-missing') + ' / ' + ibCompat.status.syntax`));
  ok(/copy for older browsers/.test(await barText()) && !await js(`document.querySelector('.ib-compat-bar').classList.contains('ib-too-old')`), 'the bar says it runs the copy for older browsers', await barText());
  await waitFor(js, `!!(globalThis.ibLocalApi && document.querySelector('.save-ctl'))`, 'the ES5 copy to start', 60000);
  ok(await js(`window.IB_ES5 === true && document.documentElement.classList.contains('ib-local')`), 'the ES5 copy starts the page');

  // Too old for that too (no typed arrays, Blob or atob: IE 9 and before): a "can't run" bar.
  await open(FILE, NO_ASYNC + 'window.atob = undefined;');
  const miss = await js(`document.documentElement.getAttribute('data-ib-missing')`);
  ok(/2017/.test(miss), 'without ES2017 syntax or what the ES5 copy needs: missing', miss);
  ok(await barShown() && await js(`document.querySelector('.ib-compat-bar').classList.contains('ib-too-old')`), 'the bar shows, as "can\'t run"');
  ok(/can't start/.test(await barText()) && /pages still read/.test(await barText()), 'the bar names the effect, and that the pages still read', await barText());
  ok(await js(`!window.IB_ES5 && !globalThis.ibLocalApi`), 'and no code of the page runs');
  ok(!await js(`!!document.querySelector('.ib-compat-dismiss')`), 'a "can\'t run" bar has no Dismiss');
  // It links the build server's simple form: from disk, the server the page was built for.
  const backend = await js(`JSON.parse(document.getElementById('ib-offline').textContent).backend`);
  const classic = await js(`(document.querySelector('.ib-compat-classic a') || {}).href || ''`);
  ok(classic === backend.replace(/\/+$/, '') + '/classic', 'a "can\'t run" bar links the build server\'s simple form', classic);

  // A visitor on Windows XP (Supermium's engine, no compression streams):
  // the XP row, and what works there.
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  await open(FILE, 'delete window.DecompressionStream; delete window.CompressionStream; delete Navigator.prototype.userAgentData;');
  const xp = await barText();
  ok(/Tested on Windows XP and working: .*Supermium/.test(xp), 'an XP visitor is pointed at what works on XP (Supermium)', xp);
  ok(await js(`!!document.querySelector('.ib-compat-get a[href="https://github.com/win32ss/supermium/releases"]')`), 'with a link to get it');
  await js(`document.querySelector('.ib-compat-more').click()`);
  ok(await js(`(document.querySelector('.ib-compat-matrix tr.ib-you') || {}).dataset?.machine === 'xp'`), 'an XP visitor: the XP row is marked');
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: '' });

  // Only an optional feature missing: a dismissable bar, gone after dismissing.
  await open(FILE, 'delete window.OffscreenCanvas;');
  ok(await barShown() && !await js(`document.querySelector('.ib-compat-bar').classList.contains('ib-too-old')`), 'without OffscreenCanvas: a "with limits" bar');
  ok(/icons must be PNG/.test(await barText()), 'it says what that means (icons must be PNG)', await barText());
  ok(await js(`document.documentElement.getAttribute('data-ib-missing') === ''`), 'an optional feature isn\'t counted as missing');
  await js(`document.querySelector('.ib-compat-dismiss').click()`);
  ok(!await barShown(), 'Dismiss hides it');
  await open(FILE, 'delete window.OffscreenCanvas;');
  ok(!await barShown(), 'and it stays hidden after a reload, for this browser');

  // No WebCrypto at a plain-http LAN address: the page runs on its own.
  if (SITE) {
    await open(SITE.replace(/\/$/, '') + '/');
    const s = await barText();
    ok(/with limits/.test(s) && /own JavaScript/.test(s) && /https, localhost and pages opened from disk/.test(s), 'plain http on a LAN address: it runs, on its own cryptography, and the bar says why', s);
    // Served by a build server, a browser that can't run the page is sent to that server's simple form.
    await open(SITE.replace(/\/$/, '') + '/', NO_ASYNC + 'window.atob = undefined;');
    const classic = await js(`(document.querySelector('.ib-compat-classic a') || {}).href || ''`);
    ok(classic === SITE.replace(/\/$/, '') + '/classic', 'served: the "can\'t run" bar links this server\'s simple form', classic);
    const r = await fetch(classic);
    ok(r.status === 200 && /text\/html; charset=utf-8/.test(r.headers.get('content-type')) && /<form action="submit"/.test(await r.text()), 'and the server has it');
  }
} catch (e) {
  ok(false, 'browser-check run', e.stack || e);
} finally {
  if (chrome) await chrome.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${t.passed} passed, ${t.failed} failed`);
process.exit(t.failed ? 1 : 0);
