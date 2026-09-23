// Which server a page connects to on its own, and which it does not.
//
// A copy of this site hosted anywhere used to call the address baked in
// at build time as soon as it loaded, and route that visitor's builds
// through it: a server neither of them picked, told about every build,
// and able to answer with whatever it liked. One file that copies itself
// is the point of this project, so "a copy is running somewhere we do not
// know about" is the normal case, not the edge one.
//
// The rule now: connect on load only to the server that served the page.
// Anywhere else it builds in the page and asks nobody until somebody
// presses Default.
//
// This cannot be tested by reading api.js, because the question is what
// the browser actually does with it, and the interesting half is a
// request that must NOT happen. So: two real page loads, and every URL
// the page asked for.
//
//   node --experimental-websocket tests/autoconnect-test.mjs [--site URL]
//
// --site is a running build server (default http://127.0.0.1:8080), which
// is the "served by its own server" half. The other half is served here.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './browsers/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const SITE = (arg('--site', 'http://127.0.0.1:8080') || '').replace(/\/+$/, '');
const PAGE = fs.readFileSync(path.join(REPO, 'out/index.html'));
const DEFAULT_REMOTE = /export const DEFAULT_REMOTE = '([^']+)'/
  .exec(fs.readFileSync(path.join(REPO, 'src/web_client/api.js'), 'utf8'))[1];

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('ok   ' + m); };
const no = (m, d) => { fail++; console.log('FAIL ' + m); if (d) console.log('     ' + d); };

// A plain static host: it serves the page and knows nothing about /api,
// which is every place somebody might put this file.
const foreign = http.createServer((req, res) => {
  if (req.url.indexOf('/api/') === 0) { res.writeHead(404); res.end('no'); return; }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => foreign.listen(0, '127.0.0.1', r));
const FOREIGN = 'http://127.0.0.1:' + foreign.address().port + '/tiddlyinstall.html';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-autoconnect-'));
const c = await launchChrome({ profile });

async function load(url) {
  c.requests.length = 0;
  await c.cdp('Page.navigate', { url });
  await c.waitFor("!!document.querySelector('.where-chip')", 'the indicator', 30000);
  await sleep(1500);            // the same-origin probe, and the paint after it
  return {
    chip: await c.js("document.querySelector('.where-chip').className"),
    said: await c.js("document.querySelector('.where-chip').getAttribute('aria-label')||''"),
    calledDefault: c.requests.filter((u) => u.indexOf(DEFAULT_REMOTE) === 0),
  };
}

// ---- hosted anywhere else
let r = await load(FOREIGN);
/where-page/.test(r.chip) ? ok('a copy hosted elsewhere builds in the page')
  : no('a copy hosted elsewhere builds in the page', r.chip + ' / ' + r.said);
// The one that matters. A page that merely *shows* "no server" while
// still calling home has fixed nothing.
r.calledDefault.length === 0 ? ok('...and asks the default server nothing')
  : no('...and asks the default server nothing', r.calledDefault.slice(0, 3).join(', '));
/hosted somewhere other than the build server/.test(r.said)
  ? ok('...and says why, rather than looking like a setting nobody made')
  : no('...and says why, rather than looking like a setting nobody made', r.said);

// ---- and the way back, which is the whole reason this is a default and
// not a rule: Default offers the server the page was built with, even
// though the page is not using it.
await c.js("document.querySelector('.api-ctl-default').click()");
await sleep(400);
const after = await c.js("document.querySelector('.where-chip').getAttribute('aria-label')||''");
after.indexOf(DEFAULT_REMOTE) >= 0 ? ok('Default still reaches the server it was built with')
  : no('Default still reaches the server it was built with', after);

// ---- served by a build server: connect, as before
r = await load(SITE + '/tiddlyinstall.html');
!/where-page/.test(r.chip) ? ok('a page its own server handed over connects to it')
  : no('a page its own server handed over connects to it', r.chip + ' / ' + r.said);
/this site/.test(r.said) ? ok('...and says it is this site')
  : no('...and says it is this site', r.said);

await c.close();
foreign.close();
fs.rmSync(profile, { recursive: true, force: true });
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
