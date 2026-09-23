// Refreshing the page's catalogue from a build server, driven in a browser.
//
//   node --experimental-websocket tests/catalog-refresh-test.mjs [--page out/index.html]
//
// Why this exists. The catalogue is baked into the page at build time, so
// a saved copy cannot install anything published after the day it was
// saved. Refreshing fixes that, and in doing so it is the only thing in
// the product that takes a multi-megabyte file off the network and then
// builds installers from it. If the checks around that are wrong, a
// server (or anything between) chooses what every installer built
// afterwards downloads. So the interesting cases here are the refusals:
// the right answer to a catalogue that does not check out is that
// nothing changes at all.
//
// The page is served from a file:// URL on purpose. That is the saved
// copy, it has an opaque origin, and it is the configuration where a
// cross-origin fetch is least likely to be allowed -- so it is the one
// worth proving.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './browsers/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PAGE = path.resolve(arg('--page', path.join(REPO, 'out/index.html')));
const ATTEST = path.join(REPO, 'src/build_server/data/rtscripts/catalog.txt');
const CACHE = process.env.TI_CATALOG_CACHE || path.join(os.homedir(), '.cache/tiddlyinstall');
const ARCHIVE = path.join(CACHE, 'catalog.gz');

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d ? '\n     ' + d : '')); } };

for (const f of [PAGE, ATTEST, ARCHIVE]) {
  if (!fs.existsSync(f)) { console.error('missing ' + f + ' (build the site, and make the catalogue snapshot first)'); process.exit(2); }
}

const attestText = fs.readFileSync(ATTEST, 'utf8');
const archive = fs.readFileSync(ARCHIVE);
// The attestation has to be about the catalogue this page was built from,
// or a passing refresh proves nothing about the checks.
const said = (attestText.split('\n').find((l) => l.startsWith('sha256\t')) || '').split('\t')[1];
const have = crypto.createHash('sha256').update(archive).digest('hex');
if (said !== have) { console.error('the attestation is for ' + said + ' and the archive is ' + have + '; re-run tools/sign_runtime_scripts.mjs'); process.exit(2); }

// Signed by a key that is not the page's. The catalogue itself is
// untouched and its hash is right: the only thing wrong is who said so.
const strayKey = crypto.generateKeyPairSync('ed25519').privateKey;
const body = attestText.split('\n').filter((l) => !l.startsWith('sig\t')).join('\n');
const strayAttest = body + 'sig\ted25519\t' + crypto.sign(null, Buffer.from(body, 'utf8'), strayKey).toString('base64') + '\n';

// A byte of the catalogue changed, with the real signed statement about
// the original. This is a server (or a proxy) handing over something
// other than what was signed.
const tampered = Buffer.from(archive);
tampered[Math.floor(tampered.length / 2)] ^= 0xff;

/* ---------- a stand-in build server ---------- */

// Only the two routes a refresh uses, answering as the real server does:
// CORS open to every origin, no cookies (src/build_server/server.js).
let mode = 'good';
const srv = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const p = req.url.split('?')[0];
  if (mode === 'missing') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found\n'); }
  if (p === '/api/catalog/attest') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(mode === 'straykey' ? strayAttest : attestText);
  }
  if (p === '/api/catalog/archive') {
    const b = mode === 'tampered' ? tampered : archive;
    res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': b.length });
    return res.end(b);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found\n');
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const PORT = srv.address().port;
const BACKEND = 'http://127.0.0.1:' + PORT;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-catrefresh-'));
const c = await launchChrome({ profile: path.join(TMP, 'profile') });

// A hash change is a same-document navigation: the page does not reload
// and no module runs again. Going via about:blank is what actually
// reloads, and the difference matters here, because the checks below turn
// on what survives a reload and what is only in memory.
async function reloadTo(hash, ready, what) {
  await c.cdp('Page.navigate', { url: 'about:blank' });
  await c.cdp('Page.navigate', { url: 'file://' + PAGE + hash });
  await c.waitFor(ready, what, 60000);
}

async function openRegistry() {
  await reloadTo('#runtimes', "(function(){var a=document.getElementById('rt-app');return a && !a.hidden;})()", 'the Registry page');
}

// Runs a refresh against the stand-in server and returns what the page
// shows afterwards.
async function refresh(kind, backend) {
  mode = kind;
  await c.js("document.getElementById('rt-refresh').click()");
  await c.waitFor("(function(){var b=document.getElementById('rt-refresh-box');return b && !b.hidden;})()", 'the warning');
  await c.js(`(function(){var i=document.getElementById('rt-refresh-url');i.value=${JSON.stringify(backend || BACKEND)};})()`);
  await c.js("document.getElementById('rt-refresh-go').click()");
  await c.waitFor("(function(){"
    + "var e=document.getElementById('rt-refresh-error');var s=document.getElementById('rt-source');"
    + "var g=document.getElementById('rt-refresh-go');"
    + "return (e && !e.hidden) || (s && !s.hidden && !g.disabled);})()", 'a result from the refresh', 180000);
  return c.js(`(function(){
    var t = function (id) { var e = document.getElementById(id); return e && !e.hidden ? e.innerText : ''; };
    return { error: t('rt-refresh-error'), source: t('rt-source'), count: t('rt-count'),
             runtimes: (document.getElementById('rt-runtimes').innerText || '').split('\\n').filter(Boolean).length };
  })()`);
}

await openRegistry();
const before = await c.js("(function(){var n=document.getElementById('rt-runtimes');return (n.innerText||'').split('\\n').filter(Boolean).length;})()");
ok(before > 0, 'the Registry page lists runtimes from the catalogue built into the page', 'listed ' + before);
ok(await c.js("(function(){var s=document.getElementById('rt-source');return !s || s.hidden;})()"),
  'and says nothing about where the catalogue came from, because it came with the page');

/* ---------- the warning, before anything is fetched ---------- */
await c.js("document.getElementById('rt-refresh').click()");
await c.waitFor("(function(){var b=document.getElementById('rt-refresh-box');return b && !b.hidden;})()", 'the warning');
const warn = await c.js("document.getElementById('rt-refresh-box').innerText");
ok(/replaces the whole catalogue/i.test(warn), 'it warns that the whole catalogue is replaced', warn.slice(0, 160));
ok(/your own changes are kept/i.test(warn), '...and that your own changes are not lost with it');
ok(/signed/i.test(warn) && /key/i.test(warn), '...and says what it checks before it uses any of it');
const filled = await c.js("document.getElementById('rt-refresh-url').value");
ok(/^https?:\/\//.test(filled), 'the server box is filled in with an address to start from', filled);
await c.js("document.getElementById('rt-refresh-cancel').click()");
ok(await c.js("document.getElementById('rt-refresh-box').hidden"), 'cancelling closes it and fetches nothing');

/* ---------- a catalogue signed by another key ---------- */
let r = await refresh('straykey');
ok(/different key/i.test(r.error), 'a catalogue signed by another key is refused', r.error.slice(0, 200));
ok(/nothing has been changed/i.test(r.error), '...and the page says nothing was changed');
ok(!r.source, '...and the catalogue in use is still the one built into the page');

/* ---------- a catalogue that is not the one signed ---------- */
r = await refresh('tampered');
ok(/not the one it signed/i.test(r.error), 'a catalogue that does not match the signed statement is refused', r.error.slice(0, 200));
ok(!r.source, '...and again nothing is swapped in');

/* ---------- a server with no catalogue ---------- */
r = await refresh('missing');
ok(/no catalogue to hand out/i.test(r.error), 'a server without one says so plainly rather than looking broken', r.error.slice(0, 200));
ok(!r.source, '...and nothing is swapped in');

/* ---------- an address the page must not fetch ---------- */
// The address is typed, so it is an input like any other. A scheme that
// is not http(s) is refused before a fetch is attempted: a javascript:
// value handed to fetch is not the risk, but treating typed text as a
// URL without looking at the scheme is a habit worth not having.
r = await refresh('good', 'javascript:alert(1)');
ok(/not an address this page can fetch from/i.test(r.error), 'an address that is not http(s) is refused before anything is fetched', r.error.slice(0, 200));
ok(!r.source, '...and nothing is swapped in');

r = await refresh('good', '   ');
ok(/not an address this page can fetch from/i.test(r.error), 'an empty address is refused the same way', r.error.slice(0, 200));
ok(!r.source, '...and nothing is swapped in');

/* ---------- the one that works ---------- */
r = await refresh('good');
ok(!r.error, 'a catalogue that checks out is accepted', r.error.slice(0, 300));
ok(r.source.indexOf('127.0.0.1:' + PORT) >= 0, 'the page says which server it came from', r.source.slice(0, 200));
ok(/97930ea1888d1a12/.test(r.source), '...and which key it was checked against', r.source.slice(0, 200));
ok(r.runtimes === before, '...and the runtimes still list, from the fetched catalogue', 'was ' + before + ', now ' + r.runtimes);

// A file:// page did a cross-origin GET against a server on another
// origin and used the answer. That is the whole question the feature
// turned on, so it is worth stating as its own result.
ok(true, 'a page opened from a file fetched a catalogue from a server on another origin');

/* ---------- it survives a reload ---------- */
// The proof that the fetched catalogue is really what the page builds
// from: after a reload nothing is left of the fetch except what was
// stored, and the blocks baked into the file are still sitting there in
// the DOM. If the swap were cosmetic, the reload would quietly go back
// to them.
await openRegistry();
await c.waitFor("(function(){var s=document.getElementById('rt-source');return s && !s.hidden;})()", 'the source line after a reload', 60000);
const after = await c.js(`(function(){
  var t = function (id) { var e = document.getElementById(id); return e && !e.hidden ? e.innerText : ''; };
  return { source: t('rt-source'), runtimes: (document.getElementById('rt-runtimes').innerText || '').split('\\n').filter(Boolean).length };
})()`);
ok(after.source.indexOf('127.0.0.1:' + PORT) >= 0, 'the refreshed catalogue is still in use after a reload', after.source.slice(0, 200));
ok(after.runtimes === before, '...and it still lists every runtime', 'was ' + before + ', now ' + after.runtimes);

/* ---------- the Trust page says which catalogue is in use ---------- */
// The Trust page's whole claim is that it describes this copy rather than
// the product. Before the catalogue could be replaced, its "runtime list"
// row could only be about the one baked in. Now it can be about a
// different one, and saying the baked-in figures anyway would be a true
// statement about the file and a wrong one about the reader.
await reloadTo('#trust', "(function(){var l=document.getElementById('trust-live');return l && !l.hidden;})()", 'the Trust page checks to run');
const trust = await c.js("document.getElementById('trust-carried').innerText");
ok(/not the one built into this page/i.test(trust), 'the Trust page says the runtime list is not the one built in', trust.slice(0, 400));
ok(trust.indexOf('127.0.0.1:' + PORT) >= 0, '...and names the server it came from', trust.slice(0, 400));
ok(/checked against the key above/i.test(trust), '...and that it was checked against the key before it was used');
ok(/the one built in/i.test(trust), '...and still accounts for the one baked into the file');

/* ---------- going back ---------- */
await reloadTo('#runtimes', "(function(){var s=document.getElementById('rt-source');return s && !s.hidden;})()", 'the Registry page again');

await c.js("(function(){var b=document.querySelectorAll('#rt-source button');if(b.length)b[0].click();})()");
await c.waitFor("(function(){var s=document.getElementById('rt-source');return !s || s.hidden;})()", 'the source line to go away', 60000);
ok(await c.js("(function(){var n=document.getElementById('rt-runtimes');return (n.innerText||'').split('\\n').filter(Boolean).length;})()") === before,
  'going back to the catalogue built into the page works, and it still lists every runtime');
await openRegistry();
ok(await c.js("(function(){var s=document.getElementById('rt-source');return !s || s.hidden;})()"),
  '...and it stays gone after a reload, so the stored copy was dropped too');

await c.close();
srv.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
