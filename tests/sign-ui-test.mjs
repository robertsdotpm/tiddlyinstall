// Drives the editor's Sign panel in headless Chrome over the DevTools
// protocol and checks what it downloads with osslsigncode and gpg.
//
//   node --experimental-websocket tests/sign-ui-test.mjs --site http://127.0.0.1:8080
//        [--page file:///path/dist/index.html] [--no-timestamp]
//
// --site is a running ibserver (it serves the site, and /api/tsa for the
// timestamp); --page tests another copy of the editor against it. Keys are
// made fresh in a temporary folder and deleted afterwards.
import { spawn, execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInstaller, writeInstaller, newRecordText } from '../js/ibfile.js';
import { FX } from './fixtures.js';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const SITE = (arg('--site') || '').replace(/\/$/, '');
if (!SITE || typeof WebSocket === 'undefined') {
  console.log('usage: node --experimental-websocket tests/sign-ui-test.mjs --site http://127.0.0.1:8080 [--page URL] [--no-timestamp]');
  process.exit(2);
}
const PAGE = arg('--page') || SITE + '/#edit';
const TIMESTAMP = !process.argv.includes('--no-timestamp');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sign-ui-'));
const DL = path.join(TMP, 'dl');
fs.mkdirSync(DL);
const PW = 'test-' + Math.random().toString(36).slice(2);
const t = (f) => path.join(TMP, f);
const OSSL = [process.env.PATH.split(':'), path.join(os.homedir(), '.local/opt/ib-tools/root/usr/bin')].flat()
  .map((d) => path.join(d, 'osslsigncode')).find((p) => fs.existsSync(p));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -- ' + String(extra).slice(0, 500) : '')); }
}

/* ---------- fixtures ---------- */

const o = (args) => execFileSync('openssl', args, { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
fs.writeFileSync(t('cs.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=UI Test TEST\n[leaf]\nbasicConstraints=CA:FALSE\n' +
  'keyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n');
o(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'rsa.key', '-out', 'rsa.crt', '-days', '2', '-config', 'cs.cnf', '-extensions', 'leaf']);
o(['pkcs12', '-export', '-inkey', 'rsa.key', '-in', 'rsa.crt', '-out', 'rsa.pfx', '-passout', 'pass:' + PW]);
o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=UI Test CA TEST', '-config', 'cs.cnf', '-extensions', 'ca']);
o(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ec.key', '-out', 'ec.csr', '-subj', '/CN=UI Test EC TEST']);
o(['x509', '-req', '-in', 'ec.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'ec.crt', '-days', '2', '-extfile', 'cs.cnf', '-extensions', 'leaf']);
const RECORD = newRecordText({ name: 'UI Test', project: 'uitest', runtime: 'python', launch: '{runtime} -m uitest' });
const exe = await writeInstaller(await readInstaller(new Uint8Array(Buffer.from(FX.peIcon, 'base64')), 'x.exe'), { record: RECORD });
fs.writeFileSync(t('in.exe'), exe);
const run = await writeInstaller(await readInstaller(new TextEncoder().encode('#!/bin/sh\necho stand-in\nexit 0\n'), 'x.run'), { record: RECORD });
fs.writeFileSync(t('in.run'), run);

/* ---------- Chrome over CDP ---------- */

const PORT = 9300 + Math.floor(Math.random() * 90);
const chrome = spawn('google-chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + t('profile'), 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws, seq = 0;
const pending = new Map(), logs = [];
async function connect() {
  for (let i = 0; i < 75; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.type === 'page');
      if (page) {
        ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        ws.onmessage = (m) => {
          const d = JSON.parse(m.data);
          if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
          if (d.method === 'Runtime.exceptionThrown') logs.push(JSON.stringify(d.params.exceptionDetails).slice(0, 300));
        };
        return;
      }
    } catch (e) { /* starting */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}
const cdp = (method, params = {}) => new Promise((res, rej) => {
  const n = ++seq;
  pending.set(n, (d) => (d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});
async function js(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
async function setFile(sel, file) {
  const doc = await cdp('DOM.getDocument', { depth: 1 });
  const q = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
  await cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
}
async function waitFor(expr, what, ms = 90000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const v = await js(expr);
    if (v) return v;
  }
  throw new Error('timed out waiting for ' + what + (logs.length ? '; page errors: ' + logs.join(' | ') : ''));
}
async function download(name, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    if (fs.existsSync(path.join(DL, name)) && !fs.readdirSync(DL).some((f) => f.endsWith('.crdownload'))) return path.join(DL, name);
  }
  throw new Error('no download ' + name + ' (have: ' + fs.readdirSync(DL).join(' ') + ')');
}
const $text = (id) => `document.getElementById('${id}').textContent`;
const click = (id) => js(`document.getElementById('${id}').click()`);
const setVal = (id, v) => js(`(e => { e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); })(document.getElementById('${id}'))`);
const check = (id, on) => js(`(e => { e.checked = ${on}; e.dispatchEvent(new Event('change', {bubbles: true})); })(document.getElementById('${id}'))`);

function osslOk(file, ca) {
  if (!OSSL) return { skip: true };
  const r = spawnSync(OSSL, ['verify', '-in', file, '-CAfile', ca], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  return { ok: r.status === 0 && /Signature verification: ok/.test(out), ts: /Timestamp Server Signature verification: ok/.test(out), out };
}

try {
  await connect();
  await cdp('Runtime.enable');
  await cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await cdp('Page.navigate', { url: PAGE + '?api=' + encodeURIComponent(SITE) });
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('sign-go')`, 'the page');

  // Windows, .pfx
  await setFile('#installer', t('in.exe'));
  await waitFor(`!document.getElementById('sign-exe').hidden`, 'the Windows sign panel');
  // The plain save still works (edit.js shares its build step with signing).
  await setVal('out-name', 'plain.exe');
  await js(`document.querySelector('#editor button[type=submit]').click()`);
  const plain = await readInstaller(new Uint8Array(fs.readFileSync(await download('plain.exe'))), 'plain.exe');
  ok(plain.record === RECORD && !plain.signed, 'ui: "Download edited installer" still saves the unsigned installer with its record');
  await check('ts-on', TIMESTAMP);
  await setFile('#pfx-file', t('rsa.pfx'));
  await setVal('pfx-pass', PW + 'x');
  await click('pfx-open');
  ok(/Wrong password/.test(await waitFor(`/Wrong|Signs as/.test(${$text('pfx-status')}) && ${$text('pfx-status')}`, 'pfx')), 'ui: a wrong .pfx password is reported');
  await setFile('#pfx-file', t('rsa.pfx'));
  await setVal('pfx-pass', PW);
  await click('pfx-open');
  await waitFor(`/Signs as/.test(${$text('pfx-status')})`, 'pfx open');
  ok(await js(`document.getElementById('pfx-pass').value === ''`), 'ui: the password field is cleared once the key is open');
  await setVal('out-name', 'pfx.exe');
  await click('sign-go');
  const s1 = await waitFor(`/Signed and saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'pfx signing');
  ok(/Signed and saved/.test(s1) && (!TIMESTAMP || /Timestamped/.test(s1)), 'ui: .pfx signing says done' + (TIMESTAMP ? ' and timestamped' : ''), s1);
  let v = osslOk(await download('pfx.exe'), t('rsa.crt'));
  if (!v.skip) ok(v.ok && (!TIMESTAMP || v.ts), 'ui: the .pfx-signed download passes osslsigncode verify' + (TIMESTAMP ? ' with its timestamp' : ''), v.out);

  // Windows, remote service by paste; openssl pkeyutl plays the service
  await check('sign-src-remote', true);
  await setVal('remote-certs', fs.readFileSync(t('ec.crt'), 'utf8') + fs.readFileSync(t('ca.crt'), 'utf8'));
  await setVal('out-name', 'remote.exe');
  await click('sign-go');
  const d64 = await waitFor(`!document.getElementById('remote-step').hidden && document.getElementById('remote-digest-b64').textContent`, 'the digest');
  fs.writeFileSync(t('digest.bin'), Buffer.from(d64, 'base64'));
  o(['pkeyutl', '-sign', '-inkey', 'rsa.key', '-pkeyopt', 'digest:sha256', '-in', 'digest.bin', '-out', 'bad.sig']);
  await setVal('remote-sig', fs.readFileSync(t('bad.sig')).toString('base64'));
  await click('remote-finish');
  ok(/does not verify/.test(await waitFor(`/verify|Signed and saved/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'bad signature')),
    'ui: a pasted signature from the wrong key is refused');
  o(['pkeyutl', '-sign', '-inkey', 'ec.key', '-in', 'digest.bin', '-out', 'good.sig']);
  await setVal('remote-sig', fs.readFileSync(t('good.sig')).toString('base64'));
  await click('remote-finish');
  const s2 = await waitFor(`/Signed and saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'remote signing');
  ok(/Signed and saved/.test(s2), 'ui: remote signing by paste says done', s2);
  v = osslOk(await download('remote.exe'), t('ca.crt'));
  if (!v.skip) ok(v.ok && (!TIMESTAMP || v.ts), 'ui: the remote-signed download passes osslsigncode verify', v.out);

  // Linux, a new Ed25519 key
  await setFile('#installer', t('in.run'));
  await waitFor(`!document.getElementById('sign-run').hidden`, 'the Linux sign panel');
  await setVal('pgp-uid', 'UI Test TEST <ui@example.invalid>');
  await click('pgp-make');
  ok(/New key/.test(await waitFor(`/New key|rror|can't/.test(${$text('pgp-status')}) && ${$text('pgp-status')}`, 'the key')), 'ui: the page makes an Ed25519 key');
  await click('pgp-pub-dl');
  const pub = await download('UI_Test_TEST_ui_example.invalid_.pub.asc');
  await setVal('out-name', 'app.run');
  await click('sign-go');
  await waitFor(`/Saved|Couldn/.test(${$text('sign-status')})`, 'pgp signing');
  const runFile = await download('app.run');
  const asc = await download('app.run.asc');
  const home = t('gnupg');
  fs.mkdirSync(home, { mode: 0o700 });
  spawnSync('gpg', ['--homedir', home, '--batch', '--import', pub]);
  const g = spawnSync('gpg', ['--homedir', home, '--batch', '--verify', asc, runFile], { encoding: 'utf8' });
  ok(g.status === 0 && /Good signature/.test(g.stderr), 'ui: gpg --verify says Good signature for the downloaded .run.asc', g.stderr);
  spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']);

  const stored = await js(`JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])`);
  ok(!/pfx|pgp|key|sign/i.test(stored), 'ui: nothing about keys in localStorage or sessionStorage', stored);
  ok(!logs.length, 'ui: no page errors', logs.join(' | '));
} catch (e) {
  ok(false, 'ui run', e.message);
} finally {
  try { ws && ws.close(); } catch (e) { /* closed */ }
  chrome.kill('SIGKILL');
}
console.log(`\n${passed} passed, ${failed} failed`);
await sleep(300);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
