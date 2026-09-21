// Page steps shared by the tests that drive TiddlyInstall (out/index.html)
// in a browser: tests/offline-test.mjs and tests/sign-ui-test.mjs (headless
// Chrome here, over CDP) and tests/browsers/run.mjs (the test machines,
// over WebDriver). Every step takes `js`, a function that evaluates a
// JavaScript expression in the page, awaiting it if it's a promise, and
// returns its (JSON) value.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readInstaller, writeInstaller, newRecordText, parseKv, kvGet, recordHash } from '../../src/shared/tifile.js';
import { FX } from '../fixtures.js';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PASS/FAIL lines, and a list of what was checked for the results file.
export class Checker {
  constructor({ quiet = false, prefix = '' } = {}) {
    this.passed = 0; this.failed = 0; this.checks = []; this.quiet = quiet; this.prefix = prefix;
  }
  ok(cond, name, extra) {
    const pass = !!cond;
    if (pass) this.passed++; else this.failed++;
    const detail = pass || extra === undefined ? undefined : String(extra).slice(0, 600);
    this.checks.push(detail === undefined ? { name, pass } : { name, pass, detail });
    if (!this.quiet) console.log(this.prefix + (pass ? 'PASS ' : 'FAIL ') + name + (detail !== undefined ? ' -- ' + detail : ''));
    return pass;
  }
  note(name, detail) {
    this.checks.push({ name, note: String(detail).slice(0, 600) });
    if (!this.quiet) console.log(this.prefix + 'NOTE ' + name + ' -- ' + String(detail).slice(0, 300));
  }
}

// True once the page has started: its local API is installed and the
// footer's controls are drawn.
export const STARTED = `!!(globalThis.tiLocalApi && document.readyState === 'complete' && document.querySelector('.save-ctl'))`;

export async function waitFor(js, expr, what, ms = 120000, errors) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const v = await js(expr);
    if (v) return v;
  }
  const errs = typeof errors === 'function' ? await errors() : errors;
  throw new Error('timed out waiting for ' + what + (errs && errs.length ? '; page errors: ' + errs.join(' | ') : ''));
}

// Every section in the page (but #build, which needs a job), and a check
// each shows its own page; home last.
export async function checkSections(t, js) {
  const found = await js(`Array.prototype.map.call(document.querySelectorAll('.ti-page'), (e) => e.dataset.page)`);
  t.ok(found.length >= 4, 'the page has its sections', found.join(','));
  const sections = found.filter((p) => p !== 'build' && p !== 'home').concat(['home']);
  for (const p of sections) {
    await js(`location.hash = '#${p}'`);
    await sleep(150);
    t.ok(await js(`document.querySelector('.ti-page:not([hidden])').dataset.page === '${p}'`), `#${p} shows its page`);
  }
  return sections;
}

// Fills the New installer form for a hello app and builds it; returns the
// finished job (or {error}).
export async function buildHello(js, { runtime, mode, name, code, pkg, platforms = ['windows', 'linux', 'macos'] }) {
  await js(`location.hash = '#new${pkg ? '' : '&write'}'`);
  await sleep(200);
  return js(`(async () => {
    const f = document.getElementById('new-form');
    const set = (n, v) => { const e = f.elements[n]; if (e instanceof RadioNodeList) { for (const r of e) r.checked = r.value === v; } else if (e.type === 'checkbox') e.checked = v; else e.value = v; };
    set('runtime', ${JSON.stringify(runtime)});
    f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
    set('source_kind', ${JSON.stringify(pkg ? 'repo' : 'write')});
    set('app_name', ${JSON.stringify(name)});
    set('mode', ${JSON.stringify(mode)});
    for (const p of ['windows', 'linux', 'macos']) set('target_' + p, ${JSON.stringify(platforms)}.includes(p));
    ${pkg ? `set('source', ${JSON.stringify(pkg)}); set('ref_type', 'tag'); set('ref', ${JSON.stringify(pkg && pkg.version)});` : `
    set('template', 'script');
    const ta = f.querySelector('.combo-${runtime}-script textarea.code');
    ta.value = ${JSON.stringify(code)};`}
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
}

// The bytes at a URL the page can fetch (blob:, file:), as a Uint8Array.
export async function fetchBlob(js, url) {
  const b64 = await js(`fetch(${JSON.stringify(url)}).then(r => r.arrayBuffer()).then(b => {
    let s = ''; const u = new Uint8Array(b);
    for (let i = 0; i < u.length; i += 0x1000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x1000));
    return btoa(s); })`);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// Reads back every installer a finished job made, with src/shared/tifile.js, and
// checks each carries the job's record and a plan bound to it. With
// keepDir and keepAs, writes the files to keepDir/keepAs/ and returns {platform: path}.
export async function checkJob(t, js, job, what, runtime, { keepDir, keepAs } = {}) {
  t.ok(job && job.status === 'done', what + ': the build finishes', JSON.stringify(job).slice(0, 400));
  if (!job || job.status !== 'done') return;
  const res = job.result;
  const kinds = { windows: 'exe', linux: 'run', macos: 'zip' };
  const files = {};
  for (const f of res.files) {
    const data = await fetchBlob(js, f.url);
    t.ok(data.length === f.size, `${what}: ${f.platform} download is ${f.size} bytes`, data.length);
    const info = await readInstaller(data, f.name);
    t.ok(info.kind === kinds[f.platform], `${what}: ${f.platform} is a .${kinds[f.platform]}`, info.kind);
    t.ok(info.record && await recordHash(info.record) === res.record, `${what}: ${f.platform} carries the record ${res.record}`);
    const rec = parseKv(info.record);
    t.ok((kvGet(rec, 'runtime') || [])[0] === runtime, `${what}: ${f.platform} record says runtime ${runtime}`, info.record);
    t.ok(info.plan && info.plan.startsWith('ti-plan\t') && info.plan.includes('record\t' + res.record + '\n'),
      `${what}: ${f.platform} carries its plan, bound to the record`, (info.plan || '').slice(0, 200));
    const blocks = (info.plan || '').split('\n').filter((l) => l.startsWith('when\t')).map((l) => l.split('\t')[1]);
    t.ok(blocks.length && blocks.every((b) => b === f.platform), `${what}: ${f.platform} plan is for ${f.platform} only`, blocks.join(','));
    const src = /\nsource\t\S+\t([0-9a-f]{64})\t/.exec(info.plan || '');
    if (src) t.ok(info.pack.some((m) => m.name === src[1]), `${what}: ${f.platform} packs the app's source`);
    if (keepDir && keepAs) {
      fs.mkdirSync(path.join(keepDir, keepAs), { recursive: true });
      const p = path.join(keepDir, keepAs, f.name);
      fs.writeFileSync(p, data);
      files[f.platform] = p;
    }
  }
  return files;
}

/* ---------- signing ---------- */

// Fresh test keys in `dir` (openssl): an RSA code-signing cert and .pfx, an
// EC P-256 leaf under its own CA, and a stand-in .exe and .run carrying a
// record, for the editor to open.
export async function makeSignFixtures(dir) {
  const PW = 'test-' + Math.random().toString(36).slice(2);
  const t = (f) => path.join(dir, f);
  const o = (args) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
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
  return { PW, RECORD, t, openssl: o };
}

export const OSSL = [process.env.PATH.split(':'), path.join(process.env.HOME || '', '.local/opt/ti-tools/root/usr/bin')].flat()
  .map((d) => path.join(d, 'osslsigncode')).find((p) => fs.existsSync(p));

// osslsigncode verify against a CA file: {ok, ts, out}, or {skip} without it.
export function osslVerify(file, ca, spawnSync) {
  if (!OSSL) return { skip: true };
  const r = spawnSync(OSSL, ['verify', '-in', file, '-CAfile', ca], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  return { ok: r.status === 0 && /Signature verification: ok/.test(out), ts: /Timestamp Server Signature verification: ok/.test(out), out };
}

// gpg --verify of a detached signature with a fresh keyring holding `pub`.
// The key was made on another machine whose clock may run ahead of this
// one's; gpg would skip a key "created in the future".
export function gpgVerify(pub, asc, file, home, spawnSync) {
  fs.mkdirSync(home, { mode: 0o700, recursive: true });
  const i = spawnSync('gpg', ['--homedir', home, '--batch', '--ignore-time-conflict', '--import', pub], { encoding: 'utf8' });
  const g = spawnSync('gpg', ['--homedir', home, '--batch', '--ignore-time-conflict', '--ignore-valid-from', '--verify', asc, file], { encoding: 'utf8' });
  spawnSync('gpgconf', ['--homedir', home, '--kill', 'all']);
  return { ok: g.status === 0 && /Good signature/.test(g.stderr), out: 'import: ' + i.stderr + '\nverify: ' + g.stderr };
}

/* ---------- editor helpers (element ids from edit.html) ---------- */

export const $text = (id) => `document.getElementById('${id}').textContent`;
export const clickId = (js, id) => js(`document.getElementById('${id}').click()`);
export const setVal = (js, id, v) => js(`(e => { e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles: true})); e.dispatchEvent(new Event('change', {bubbles: true})); })(document.getElementById('${id}'))`);
export const checkBox = (js, id, on) => js(`(e => { e.checked = ${on}; e.dispatchEvent(new Event('change', {bubbles: true})); })(document.getElementById('${id}'))`);
