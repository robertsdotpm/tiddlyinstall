// The page finding its build server when DNS does not work.
//
//   node --experimental-websocket tests/dns-fallback-test.mjs [--page out/index.html]
//
// Why this exists. The product's own design note says DNS is often
// misconfigured or blocked on the old systems it targets (design.md 1.3).
// If the name of the build server will not resolve, a saved copy of the
// page has no server at all -- and the page would sit there reporting it
// as down, while the server answers perfectly well by address.
//
// The browser is started with --host-resolver-rules so the server's name
// resolves to a dead port, which is what broken DNS looks like from
// inside a page. The addresses are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './browsers/cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PAGE = path.resolve(arg('--page', path.join(REPO, 'out/index.html')));

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d ? '\n     ' + d : '')); } };
if (!fs.existsSync(PAGE)) { console.error('missing ' + PAGE); process.exit(2); }

const NAME = 'tiddlyinstall.warpgate.io';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-dns-'));

// The page carries the addresses at all.
const html = fs.readFileSync(PAGE, 'utf8');
ok(html.indexOf('158.69.27.176') >= 0, 'the page carries the server\'s IPv4 address');
ok(html.indexOf('2607:5300:60:80b0::1') >= 0, '...and its IPv6 address');

// DNS for the name is dead; the addresses still work.
const c = await launchChrome({
  profile: path.join(TMP, 'p'),
  args: ['--host-resolver-rules=MAP ' + NAME + ' 127.0.0.1:9', '--ignore-certificate-errors'],
});

await c.cdp('Page.navigate', { url: 'file://' + PAGE + '#new' });
await c.waitFor("!!document.querySelector('.site-footer')", 'the page', 60000);

// Prove the simulation: the name really is unreachable from in here.
const nameDead = await c.js(`(async function(){
  try { await fetch('https://${NAME}/api/health', { cache: 'no-store' }); return false; }
  catch (e) { return true; }
})()`);
ok(nameDead === true, 'the server\'s name does not resolve in this browser (the simulation works)');

// ...and the address does.
const addrLive = await c.js(`(async function(){
  try { var r = await fetch('http://158.69.27.176/api/health', { cache: 'no-store' }); return r.ok; }
  catch (e) { return String(e); }
})()`);
ok(addrLive === true, 'the same server answers on its address', String(addrLive));

// The page, asked to use the default server, finds it by address.
await c.js(`window.tiTestApi && 0; (function(){ try { localStorage.clear(); } catch (e) {} })()`);
await c.cdp('Page.navigate', { url: 'file://' + PAGE + '?api=https://' + NAME + '#new' });
await c.waitFor("!!document.querySelector('.site-footer')", 'the page again', 60000);
await sleep(12000);   // the health check runs on a backoff
const landed = await c.js(`(function(){
  var b = document.querySelector('.api-url');
  var chip = document.querySelector('.settings-where, .api-where, .where-chip');
  return { apiUrl: b ? b.textContent : '', chip: chip ? chip.textContent.trim() : '' };
})()`);
ok(/158\.69\.27\.176|2607:5300:60:80b0::1/.test(landed.apiUrl),
  'with the name dead, the page reaches the same server by address', JSON.stringify(landed));
// Not silent: whoever is looking at the page can see which address it is
// talking to, because a page that quietly substitutes a server is exactly
// what this product tells people not to accept.
ok(/158\.69\.27\.176|2607:5300:60:80b0::1/.test(landed.chip),
  '...and says so, rather than substituting a server quietly', JSON.stringify(landed));
ok(!/api-down/.test(await c.js('document.documentElement.className')),
  '...and does not go on reporting the server as down');

await c.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
