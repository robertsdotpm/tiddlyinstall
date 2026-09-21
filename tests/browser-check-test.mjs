// Checks the page's browser check (web/browser-check.js) in headless Chrome:
// no notice at all in a modern browser; with features taken away before
// the page loads, the right notice in the right place; its details
// (features, and the tested machine x browser matrix with the visitor's
// nearest row marked); dismissing; and plain http.
//
// Which notice, and where, is the point of most of this (web/browser-check.js
// explains the rule): a feature with no stand-in means something cannot be
// done here, so a bar goes under the header; a stand-in that only costs
// time gets a line in the footer instead, because "the same installer,
// more slowly" is not worth the top of every page. Features with a
// stand-in (compression, WebCrypto, :has(), ...) show as "fallback";
// ES2017 syntax too, where the page's ES5 copy can run instead (checked
// here by running it) -- that one is loud anyway, since it changes how the
// whole page runs. Only a browser too old for that copy is told it
// "can't run".
//
// Two things the check must not do, both found on the live site: offer an
// upgrade to the browser already running, and blame the browser for the
// page being served over plain http.
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
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-bcheck-'));
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
  await waitFor(js, `document.readyState === 'complete' && document.documentElement.getAttribute('data-ti-ready') === '1'`, 'the browser check', 60000);
}
const barShown = () => js(`!!document.querySelector('.ti-compat-bar:not([hidden]):not(.ti-compat-quiet)')`);
const quietShown = () => js(`!!document.querySelector('.ti-compat-bar.ti-compat-quiet:not([hidden])')`);
const barText = () => js(`(document.querySelector('.ti-compat-bar .ti-compat-text') || {}).textContent || ''`);
// Where the notice sits, and how wide it is next to the page's other
// banner: two banners disagreeing about that would be its own bug.
const noticeBox = () => js(`(() => {
  const e = document.querySelector('.ti-compat-bar');
  if (!e) return null;
  const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
  const mainEl = document.querySelector('.ti-page:not([hidden]) main') || document.querySelector('main');
  const main = mainEl.getBoundingClientRect();
  return { inFooter: !!e.closest('footer'), afterHeader: e.previousElementSibling === document.querySelector('header'),
    left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width),
    mainLeft: Math.round(main.left), mainRight: Math.round(main.right),
    bg: cs.backgroundColor, color: cs.color, maxWidth: cs.maxWidth }; })()`);
const FILE = 'file://' + PAGE;

try {
  chrome = await launchChrome({ profile: path.join(TMP, 'profile') });
  js = chrome.js;

  // A modern Chrome: nothing to say.
  await open(FILE);
  ok(await js(`document.documentElement.getAttribute('data-ti-missing') === '' && document.documentElement.getAttribute('data-ti-degraded') === ''`),
    'modern Chrome: nothing missing or degraded', await js(`document.documentElement.getAttribute('data-ti-degraded')`));
  ok(!await barShown(), 'modern Chrome: no bar');
  const env = await js(`tiCompat.env`);
  ok(env.browser && env.version && env.os, 'the browser, version and OS are detected', JSON.stringify(env));
  ok(await js(`!!document.getElementById('ti-compat') && JSON.parse(document.getElementById('ti-compat').textContent).results.length > 0`),
    'the tested-browsers summary is in the page');

  // Compression and WebCrypto taken away: the page works on its own
  // JavaScript; a "with limits" bar says so.
  await open(FILE, 'delete window.DecompressionStream; delete window.CompressionStream; Object.defineProperty(window.crypto, "subtle", { get: function () {} });');
  ok(await js(`document.documentElement.getAttribute('data-ti-missing') === ''`), 'without (De)CompressionStream and WebCrypto: nothing is missing',
    await js(`document.documentElement.getAttribute('data-ti-missing')`));
  const degr = await js(`document.documentElement.getAttribute('data-ti-degraded')`);
  ok(/compress/.test(degr) && /decompress/.test(degr) && /webcrypto/.test(degr), 'they are degraded (fallback)', degr);
  // Both have a stand-in, so nothing is impossible here: the same
  // installer, more slowly. That belongs in the footer, not at the top of
  // every page (web/browser-check.js).
  ok(!await barShown() && await quietShown(), 'a stand-in that only costs time raises no bar');
  const box = await noticeBox();
  ok(box && box.inFooter, 'it is a line in the footer instead', JSON.stringify(box));
  const text = await barText();
  ok(/own JavaScript/.test(text), 'which says the page uses its own JavaScript', text);
  ok(/Tested on Debian 12 and working: \w/.test(text), 'and recommends the browsers tested on the nearest OS (Linux: Debian 12)', text);
  await js(`document.querySelector('.ti-compat-more').click()`);
  const rows = await js(`Array.prototype.map.call(document.querySelectorAll('.ti-compat-details table:first-of-type tr'), (r) => r.textContent)`);
  ok(rows.some((r) => /CompressionStream.*~ fallback/.test(r)) && rows.some((r) => /:has\(\).*✓ native/.test(r)), 'details: each feature, native or fallback, and what that means', rows.join(' | '));
  ok(await js(`document.querySelectorAll('.ti-compat-matrix tr[data-machine]').length >= 5`), 'details: the tested matrix renders');
  ok(await js(`(document.querySelector('.ti-compat-matrix tr.ti-you') || {}).dataset?.machine === 'debian12' && !!document.querySelector('.ti-compat-matrix tr.ti-you td.ti-you')`),
    'details: the nearest machine row and this browser\'s cell are marked');
  if (SHOT) {
    const { data } = await chrome.cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    await js(`document.querySelector('.ti-compat-matrix').scrollIntoView()`);
    const m = await chrome.cdp('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT.replace(/\.png$/, '') + '-matrix.png', Buffer.from(m.data, 'base64'));
    console.log('screenshots: ' + SHOT + ', ' + SHOT.replace(/\.png$/, '') + '-matrix.png');
  }

  // A JavaScript without async functions (IE 11, Chrome 49): the page runs
  // its ES5 copy (web/page-loader.js), and the bar says so.
  const NO_ASYNC = '(function () { var F = Function; window.Function = function () { if (/async/.test(String(arguments[arguments.length - 1]))) throw new SyntaxError("old"); return F.apply(this, arguments); }; window.Function.prototype = F.prototype; })();';
  await open(FILE, NO_ASYNC);
  ok(await js(`document.documentElement.getAttribute('data-ti-missing') === '' && tiCompat.status.syntax === 'fallback'`), 'without ES2017 syntax: the ES5 copy stands in (fallback, nothing missing)',
    await js(`document.documentElement.getAttribute('data-ti-missing') + ' / ' + tiCompat.status.syntax`));
  ok(/copy for older browsers/.test(await barText()) && !await js(`document.querySelector('.ti-compat-bar').classList.contains('ti-too-old')`), 'the bar says it runs the copy for older browsers', await barText());
  ok(await barShown() && !await quietShown(), 'and it is a bar, not a footer line: running the whole page differently is loud');
  // Constrained like everything else on the page, .api-banner included.
  // Wider than the 1240 px the page is held to, or the two coincide and
  // the check proves nothing.
  await chrome.cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  const es5box = await noticeBox();
  ok(es5box && es5box.width < 1600, 'the bar is narrower than the viewport (else this check proves nothing)', JSON.stringify(es5box));
  ok(es5box && es5box.afterHeader && es5box.left === es5box.mainLeft && es5box.right === es5box.mainRight,
    'the bar sits under the header and is exactly as wide as the page', JSON.stringify(es5box));
  ok(es5box && es5box.maxWidth === '1240px', 'with the same max-width as .api-banner', es5box && es5box.maxWidth);
  await chrome.cdp('Emulation.clearDeviceMetricsOverride');
  await sleep(150);
  await waitFor(js, `!!(globalThis.tiLocalApi && document.querySelector('.save-ctl'))`, 'the ES5 copy to start', 60000);
  ok(await js(`window.TI_ES5 === true && document.documentElement.classList.contains('ti-local')`), 'the ES5 copy starts the page');

  // Too old for that too (no typed arrays, Blob or atob: IE 9 and before): a "can't run" bar.
  await open(FILE, NO_ASYNC + 'window.atob = undefined;');
  const miss = await js(`document.documentElement.getAttribute('data-ti-missing')`);
  ok(/2017/.test(miss), 'without ES2017 syntax or what the ES5 copy needs: missing', miss);
  ok(await barShown() && await js(`document.querySelector('.ti-compat-bar').classList.contains('ti-too-old')`), 'the bar shows, as "can\'t run"');
  ok(/can't start/.test(await barText()) && /pages still read/.test(await barText()), 'the bar names the effect, and that the pages still read', await barText());
  ok(await js(`!window.TI_ES5 && !globalThis.tiLocalApi`), 'and no code of the page runs');
  ok(!await js(`!!document.querySelector('.ti-compat-dismiss')`), 'a "can\'t run" bar has no Dismiss');
  // It links the build server's simple form: from disk, the server the page was built for.
  const backend = await js(`JSON.parse(document.getElementById('ti-offline').textContent).backend`);
  const classic = await js(`(document.querySelector('.ti-compat-classic a') || {}).href || ''`);
  ok(classic === backend.replace(/\/+$/, '') + '/classic', 'a "can\'t run" bar links the build server\'s simple form', classic);

  // A visitor on Windows XP (Supermium's engine, no compression streams):
  // the XP row, and what works there.
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Windows NT 5.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' });
  await open(FILE, 'delete window.DecompressionStream; delete window.CompressionStream; delete Navigator.prototype.userAgentData;');
  const xp = await barText();
  ok(/Tested on Windows XP and working: .*Supermium/.test(xp), 'an XP visitor is pointed at what works on XP (Supermium)', xp);
  ok(await js(`!!document.querySelector('.ti-compat-get a[href="https://github.com/win32ss/supermium/releases"]')`), 'with a link to get it');
  await js(`document.querySelector('.ti-compat-more').click()`);
  ok(await js(`(document.querySelector('.ti-compat-matrix tr.ti-you') || {}).dataset?.machine === 'xp'`), 'an XP visitor: the XP row is marked');
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: '' });

  // Only an optional feature missing: a dismissable bar, gone after dismissing.
  await open(FILE, 'delete window.OffscreenCanvas;');
  ok(await barShown() && !await js(`document.querySelector('.ti-compat-bar').classList.contains('ti-too-old')`), 'without OffscreenCanvas: a "with limits" bar');
  ok(/icons must be PNG/.test(await barText()), 'it says what that means (icons must be PNG)', await barText());
  ok(await js(`document.documentElement.getAttribute('data-ti-missing') === ''`), 'an optional feature isn\'t counted as missing');
  await js(`document.querySelector('.ti-compat-dismiss').click()`);
  ok(!await barShown(), 'Dismiss hides it');
  await open(FILE, 'delete window.OffscreenCanvas;');
  ok(!await barShown(), 'and it stays hidden after a reload, for this browser');

  // The colours are the page's, in whichever theme is on: the bar carries
  // its own CSS, so a hardcoded light one would only show on a dark site.
  // (The case above dismissed this exact bar, so forget that first.)
  await open(FILE);
  await js(`localStorage.clear()`);
  await open(FILE, 'delete window.OffscreenCanvas;');
  ok(await barShown(), 'a bar to read the colours off');
  const themed = {};
  for (const theme of ['light', 'dark']) {
    await js('document.documentElement.setAttribute("data-theme", "' + theme + '")');
    await sleep(80);
    themed[theme] = await js(`(() => { const e = document.querySelector('.ti-compat-bar'), cs = getComputedStyle(e);
      const probe = document.createElement('span'); probe.style.color = 'var(--warn-soft)';
      document.body.appendChild(probe); const want = getComputedStyle(probe).color; probe.remove();
      return { bg: cs.backgroundColor, want: want }; })()`);
  }
  ok(themed.light.bg === themed.light.want && themed.dark.bg === themed.dark.want,
    'the bar takes its colours from the page, so it follows the theme', JSON.stringify(themed));
  ok(themed.light.bg !== themed.dark.bg, 'and they really are different in the two themes', JSON.stringify(themed));
  await js(`document.documentElement.removeAttribute('data-theme')`);

  // Never offer an upgrade to the browser that is running. Chrome 153 is
  // what tests/browsers found working on Debian 12, so a visitor already
  // on Chrome 153 must not be told to get it.
  const tested = await js(`(JSON.parse(document.getElementById('ti-compat').textContent).results
    .filter((r) => r[0] === 'debian12' && r[1] === 'chrome')[0] || [])[2]`);
  ok(tested, 'the page knows which Chrome was tested on Debian 12', tested);
  const asChrome = (v) => 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + v + ' Safari/537.36';
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: asChrome(tested) });
  await open(FILE, 'delete window.OffscreenCanvas; delete Navigator.prototype.userAgentData;');
  const same = await barText();
  const gets = await js(`Array.prototype.map.call(document.querySelectorAll('.ti-compat-get a'), (a) => a.textContent).join(', ')`);
  ok(!/Chrome/.test(same), 'on the very version our tests passed on, Chrome is not among the browsers offered', same);
  ok(gets && !/Chrome/.test(gets), 'nor among the Get links', gets);
  ok(/icons must be PNG/.test(same), 'but it still says what is actually wrong', same);
  // An older Chrome is a different matter: "Chrome 153" is the real advice.
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: asChrome('49.0.2623.112') });
  await open(FILE, 'delete window.OffscreenCanvas; delete Navigator.prototype.userAgentData;');
  const older = await barText();
  ok(new RegExp('Get: Chrome ' + String(tested).split('.')[0]).test(await js(`document.querySelector('.ti-compat-bar').textContent`)),
    'on an older Chrome it is offered, because there it is an upgrade', older);
  await chrome.cdp('Emulation.setUserAgentOverride', { userAgent: '' });

  // Not in a secure context: everything degraded follows from that, so the
  // browser is not the problem and none is suggested.
  const INSECURE = 'Object.defineProperty(window, "isSecureContext", { get: function () { return false; }, configurable: true });' +
    'Object.defineProperty(window.crypto, "subtle", { get: function () {} });';
  await open(FILE, INSECURE);
  const http = await barText();
  ok(await js(`window.isSecureContext === false`), 'the rig really did make it an insecure context (else this proves nothing)');
  ok(!await barShown() && await quietShown(), 'insecure context: no bar at the top of the page');
  ok(/not on https/.test(http) && /withholds WebCrypto/.test(http), 'it names http, not the browser', http);
  ok(!/This browser/.test(http) && !/Get: /.test(http) && !await js(`!!document.querySelector('.ti-compat-get')`),
    'and blames no browser, and offers none', http);
  ok(/saved to disk/.test(http), 'and says where it does not happen', http);
  // One degradation that is not about the secure context puts it back to
  // talking about the browser.
  await open(FILE, INSECURE + 'delete window.OffscreenCanvas;');
  const mixed = await barText();
  ok(/This browser can run TiddlyInstall/.test(mixed) && /icons must be PNG/.test(mixed),
    'with anything else degraded too, it goes back to reporting the browser', mixed);

  // No WebCrypto at a plain-http LAN address: the page runs on its own.
  if (SITE) {
    await open(SITE.replace(/\/$/, '') + '/');
    const s = await barText();
    ok(await js(`window.isSecureContext === false`), 'a plain-http LAN address is not a secure context');
    ok(!await barShown() && await quietShown(), 'plain http on a LAN address: a footer line, not a bar');
    ok(/not on https/.test(s) && /own JavaScript/.test(s) && !/Get: /.test(s),
      'and it says the page is not on https, and suggests no browser', s);
    // Served by a build server, a browser that can't run the page is sent to that server's simple form.
    await open(SITE.replace(/\/$/, '') + '/', NO_ASYNC + 'window.atob = undefined;');
    const classic = await js(`(document.querySelector('.ti-compat-classic a') || {}).href || ''`);
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
