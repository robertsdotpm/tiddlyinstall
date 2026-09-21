// Drives the editor's Sign panel in headless Chrome over the DevTools
// protocol and checks what it downloads with osslsigncode and gpg.
//
//   node --experimental-websocket tests/sign-ui-test.mjs --site http://127.0.0.1:8080
//        [--page file:///path/out/index.html] [--no-timestamp] [--no-native]
//
// --site is a running ibserver (it serves the site, and /api/tsa for the
// timestamp); --page tests another copy of the editor against it. Keys are
// made fresh in a temporary folder and deleted afterwards. --no-native: as a
// browser without DecompressionStream, crypto.subtle, BigInt or :has()
// (tests/no-native-browser.mjs), so the page signs with its own JavaScript.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readInstaller } from '../src/shared/tifile.js';
import { launchChrome, sleep } from './browsers/cdp.mjs';
import { Checker, makeSignFixtures, osslVerify, gpgVerify, $text, clickId, setVal as setValIn, checkBox } from './browsers/steps.mjs';
import { noNativeArg, disableNative, checkNativeState } from './no-native-browser.mjs';
import { startMockServices } from './mock-sign-services.mjs';

const arg = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const SITE = (arg('--site') || '').replace(/\/$/, '');
if (!SITE || typeof WebSocket === 'undefined') {
  console.log('usage: node --experimental-websocket tests/sign-ui-test.mjs --site http://127.0.0.1:8080 [--page URL] [--no-timestamp]');
  process.exit(2);
}
const PAGE = arg('--page') || SITE + '/#edit';
const TIMESTAMP = !process.argv.includes('--no-timestamp');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-sign-ui-'));
const DL = path.join(TMP, 'dl');
fs.mkdirSync(DL);

const T = new Checker();
const ok = T.ok.bind(T);

/* ---------- fixtures (tests/browsers/steps.mjs) ---------- */

const { PW, RECORD, t, openssl: o } = await makeSignFixtures(TMP);

// A stand-in signing service on loopback, for the "any service that signs a
// digest" option -- the one whose address the user gives, so the panel can
// be driven end to end without a real provider. Its key is the fixture RSA
// key; its API key is made fresh here and is not a real credential.
const MOCK_KEY = 'mock-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const mock = await startMockServices({
  creds: { generic: { apiKey: MOCK_KEY }, sslcom: {}, gcpkms: {}, awskms: {}, azurets: {} },
  certsB64: [],
  sign: async (digest) => {
    fs.writeFileSync(t('ui-digest.bin'), digest);
    o(['pkeyutl', '-sign', '-inkey', 'rsa.key', '-pkeyopt', 'digest:sha256', '-in', 'ui-digest.bin', '-out', 'ui.sig']);
    return fs.readFileSync(t('ui.sig'));
  },
});
const MOCK = { origin: mock.origin, apiKey: MOCK_KEY };

/* ---------- Chrome over CDP (tests/browsers/cdp.mjs) ---------- */

let chrome, js, setFile, waitFor, logs;
async function download(name, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    if (fs.existsSync(path.join(DL, name)) && !fs.readdirSync(DL).some((f) => f.endsWith('.crdownload'))) return path.join(DL, name);
  }
  throw new Error('no download ' + name + ' (have: ' + fs.readdirSync(DL).join(' ') + ')');
}
const click = (id) => clickId(js, id);
const setVal = (id, v) => setValIn(js, id, v);
const check = (id, on) => checkBox(js, id, on);
const osslOk = (file, ca) => osslVerify(file, ca, spawnSync);

try {
  chrome = await launchChrome({ profile: t('profile'), downloads: DL });
  ({ js, setFile, waitFor, errors: logs } = chrome);
  if (noNativeArg) await disableNative(chrome.cdp);
  await chrome.cdp('Page.navigate', { url: PAGE + '?api=' + encodeURIComponent(SITE) });
  await waitFor(`document.readyState === 'complete' && !!document.getElementById('sign-go')`, 'the page');
  await checkNativeState(ok, js);

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

  // Windows, a cloud signing service (src/web_client/sign-services.js). No real
  // provider can be called from a test, so the generic option -- the one
  // whose address the user gives -- is pointed at a mock, which exercises
  // the whole panel for real. The named providers are checked for what they
  // say and for what happens to a credential, which is the part that would
  // hurt if it were wrong.
  await check('sign-src-service', true);
  await waitFor(`!document.getElementById('sign-service').hidden && document.getElementById('svc-name').options.length > 3`, 'the service panel');
  const ids = await js(`[].map.call(document.getElementById('svc-name').options, (o) => o.value).join(',')`);
  ok(ids === 'sslcom,gcpkms,awskms,azurets,digicert,generic', 'ui: served, every provider is offered including the relayed one', ids);

  // Each provider says where the credentials go, before any field exists.
  let allSaid = true, saidWhat = '';
  for (const id of ids.split(',')) {
    await js(`(() => { const s = document.getElementById('svc-name'); s.value = ${JSON.stringify(id)};
      s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    const t2 = await js(`document.getElementById('svc-about').textContent`);
    const wants = id === 'azurets' ? /pass through the build server/
      : id === 'digicert' ? /Nothing secret is typed/ : /stay in this browser/;
    if (!wants.test(t2) || !/Not yet tested against a live account/.test(t2) || !/contact address not yet set|tell us/.test(t2)) {
      allSaid = false;
      saidWhat = id + ': ' + t2.slice(0, 160);
    }
  }
  ok(allSaid, 'ui: every provider says where credentials go and that it is untested, before any field is filled', saidWhat);

  // The generic option, end to end, against a mock on loopback.
  await js(`(() => { const s = document.getElementById('svc-name'); s.value = 'generic';
    s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`!!document.getElementById('svcf-url')`, 'the generic fields');
  await setVal('svcf-url', MOCK.origin + '/generic/json-base64');
  await setVal('svcf-headers', 'X-API-Key: ' + MOCK.apiKey);
  await setVal('svcf-bodyTemplate', '{"hash":"{{digest}}"}');
  await setVal('svcf-signaturePath', 'result.sig');
  await setVal('svc-certs', fs.readFileSync(t('rsa.crt'), 'utf8'));
  await setVal('out-name', 'service.exe');
  await click('sign-go');
  const s3 = await waitFor(`/Signed and saved|Couldn|refused|did not accept/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'service signing');
  ok(/Signed and saved/.test(s3), 'ui: signing through a cloud service says done', s3);
  v = osslOk(await download('service.exe'), t('rsa.crt'));
  if (!v.skip) ok(v.ok, 'ui: the service-signed download passes osslsigncode verify', v.out);
  ok(await js(`document.getElementById('svcf-headers').value === ''`),
    'ui: the credential field is cleared once the signing finishes');

  // A wrong credential: the panel says so in plain words, and still clears.
  await setVal('svcf-headers', 'X-API-Key: wrong-' + MOCK.apiKey);
  await setVal('out-name', 'service2.exe');
  await click('sign-go');
  const s4 = await waitFor(`/did not accept|Couldn|Signed and saved/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'a refused credential');
  ok(/did not accept those credentials/.test(s4), 'ui: a service that refuses the credential is reported in plain words', s4);
  ok(await js(`document.getElementById('svcf-headers').value === ''`),
    'ui: the credential field is cleared after a failure too');

  // Nothing about any of it reached storage -- checked while the panel is
  // still filled in, and again at the end with everything else.
  const stored1 = await js(`JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)]) +
    ' ' + [...Object.keys(localStorage)].map((k) => localStorage.getItem(k)).join(' ')`);
  ok(stored1.indexOf(MOCK.apiKey) < 0 && !/svcf|credential|apikey|token|secret/i.test(stored1),
    'ui: no signing-service credential in localStorage or sessionStorage', stored1.slice(0, 200));

  // pagehide must drop them, as it does the .pfx key.
  await setVal('svcf-headers', 'X-API-Key: ' + MOCK.apiKey);
  await js(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))`);
  ok(await js(`document.getElementById('svcf-headers').value === ''`), 'ui: pagehide drops the service credentials');

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
  const g = gpgVerify(pub, asc, runFile, t('gnupg'), spawnSync);
  ok(g.ok, 'ui: gpg --verify says Good signature for the downloaded .run.asc', g.out);

  const stored = await js(`JSON.stringify([Object.keys(localStorage), Object.keys(sessionStorage)])`);
  ok(!/pfx|pgp|key|sign/i.test(stored), 'ui: nothing about keys in localStorage or sessionStorage', stored);
  ok(!logs.length, 'ui: no page errors', logs.join(' | '));
} catch (e) {
  ok(false, 'ui run', e.message);
} finally {
  if (chrome) await chrome.close('SIGKILL');
  await mock.close();
}
console.log(`\n${T.passed} passed, ${T.failed} failed`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(T.failed ? 1 : 0);
