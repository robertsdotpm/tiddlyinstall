// The Verify page, driven in a browser.
//
//   node --experimental-websocket tests/verify-test.mjs [--page out/index.html]
//
// Why this exists. Nothing drove this page until 2026-09-23. It is the
// one surface whose whole job is to say whether an installer is what it
// claims, it reads the same signed documents the engines do, and on the
// day this was written it was telling people we had not signed the thing
// the design is built on -- because "the runtime install script" named
// both the half we sign and the wrapper we do not. A person found that.
// Nothing else was looking.
//
// Three files, because the interesting answers are the ones that are not
// "yes": a plan signed and proved, the same plan with its signature
// removed (which is every installer built in a page, since a page holds
// no key), and one with a byte of a download's hash changed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome, sleep } from './browsers/cdp.mjs';
import { readInstaller, buildInstaller } from '../src/shared/tifile.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const PAGE = path.resolve(arg('--page', path.join(REPO, 'out/index.html')));
const BASE = path.join(REPO, 'src/installers/windows/out/base.exe');
const PLAN = path.join(REPO, 'src/installers/test-proved.plan');
const REC = path.join(REPO, 'src/installers/test-proved.rec');

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d ? '\n     ' + d : '')); } };

for (const f of [PAGE, BASE, PLAN, REC]) {
  if (!fs.existsSync(f)) { console.error('missing ' + f + ' (build the site and the Windows base first)'); process.exit(2); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-verify-'));
const planText = fs.readFileSync(PLAN, 'utf8');
const record = fs.readFileSync(REC, 'utf8');

async function make(name, plan) {
  const info = await readInstaller(new Uint8Array(fs.readFileSync(BASE)), 'exe');
  const out = await buildInstaller(info, { record, plan });
  const p = path.join(TMP, name);
  fs.writeFileSync(p, Buffer.from(out.data));
  return p;
}

// Signed and proved, as the build server makes it.
const proved = await make('proved.exe', planText);
// The signature gone: what a page with no server can produce, since the
// key is not in the page and never will be. The proof survives, because
// it is against a separately signed roots document.
const unsigned = await make('unsigned.exe', planText.split('\n').filter((l) => !l.startsWith('sig\t')).join('\n'));
// A download's hash edited. The proof must stop matching.
const tamperedPlan = planText.replace(/^(file\t\S+\t\S+\t)([0-9a-f])/m, (m, a, b) => a + (b === '0' ? '1' : '0'));
const tampered = await make('tampered.exe', tamperedPlan);
if (tamperedPlan === planText) { console.error('could not tamper the fixture'); process.exit(2); }

// Signed by a key that is not ours. This is not hypothetical: on
// 2026-09-23 a tool with a stale path minted its own key and signed
// 8,891 runtime scripts with it, and every file it produced verified
// perfectly against itself. What catches that is a second artifact --
// this page's key -- disagreeing.
const strayKey = crypto.generateKeyPairSync('ed25519').privateKey;
const bodyOf = (t) => t.split('\n').filter((l) => !l.startsWith('sig\t')).join('\n');
const wrongBody = bodyOf(planText);
const wrongKeyPlan = wrongBody + 'sig\ted25519\t' +
  crypto.sign(null, Buffer.from(wrongBody, 'utf8'), strayKey).toString('base64') + '\n';
const wrongKey = await make('wrongkey.exe', wrongKeyPlan);

const c = await launchChrome({ profile: path.join(TMP, 'profile') });

async function verify(file) {
  await c.cdp('Page.navigate', { url: 'file://' + PAGE + '#verify' });
  await c.waitFor("!!document.getElementById('v-file')", 'the Verify page');
  await c.setFile('#v-file', file);
  await c.waitFor("(function(){var o=document.getElementById('v-out');var e=document.getElementById('v-error');"
    + "return (o && !o.hidden) || (e && !e.hidden);})()", 'a verdict for ' + path.basename(file), 60000);
  return c.js(`(function(){
    var t = function (id) { var e = document.getElementById(id); return e && !e.hidden ? e.innerText : ''; };
    return { signing: t('v-signing'), does: t('v-does'), facts: t('v-file-facts'), error: t('v-error') };
  })()`);
}

/* ---------- signed and proved ---------- */
let r = await verify(proved);
ok(!r.error, 'a signed installer is read without error', r.error);
ok(/runtime setup/i.test(r.signing), 'the signing table names the runtime setup');
ok(/proved/i.test(r.signing), '...and says it is proved', r.signing.slice(0, 200));
ok(/choices/i.test(r.signing), '...and names the choices separately');
// The fault of 2026-09-23: one phrase for the signed half and the
// unsigned wrapper, so the table read as "we did not sign it".
ok(!/runtime install script/i.test(r.signing),
  '...and never calls two different things by one name', r.signing.slice(0, 200));

// The chain a stranger can follow, added 2026-09-23: which server the
// file names, and what did the checking. Both were true before and
// neither was said, so a reader could not tell the check was made
// against something other than the file being checked.
ok(/where it says it came from/i.test(r.signing), 'it names where the file says it came from', r.signing.slice(0, 200));
ok(/what checked it/i.test(r.signing), '...and what did the checking');
ok(/a different file from the one being checked/i.test(r.signing),
  '...and that the checker is not the thing being vouched for');
ok(/does not, by itself, say whose key it is/i.test(r.signing),
  '...and does not overclaim: agreement is not proof of whose key it is');

/* ---------- the signature removed ---------- */
r = await verify(unsigned);
ok(!r.error, 'an unsigned installer is read without error', r.error);
ok(/proved/i.test(r.signing), 'the runtime setup is still proved: the proof does not need the plan signature');
ok(/not signed|are not signed/i.test(r.signing), '...and the choices are shown as not signed', r.signing.slice(0, 250));

/* ---------- a download hash changed ---------- */
r = await verify(tampered);
ok(!r.error, 'a tampered installer is still read rather than refused outright', r.error);
ok(!/\bare ours\b/i.test(r.signing), 'a tampered runtime setup is NOT called ours', r.signing.slice(0, 250));
ok(/do not prove|not signed|could not/i.test(r.signing),
  '...and the page says so', r.signing.slice(0, 250));

/* ---------- signed by a key that is not ours ---------- */
r = await verify(wrongKey);
ok(!r.error, 'a file signed by another key is still read', r.error);
ok(/does not check out/i.test(r.signing),
  'and its signature is refused against the key this page carries', r.signing.slice(0, 250));
ok(!/so our build server produced this file/i.test(r.signing),
  '...and it is never called ours');

/* ---------- the Trust page ---------- */
//
// The other half of the trust surface, and untested until now. It checks
// the signed documents in the page it is served from and prints the
// key's fingerprint, so it can be wrong in the same ways as Verify while
// saying the most reassuring things on the site.
await c.cdp('Page.navigate', { url: 'file://' + PAGE + '#trust' });
await c.waitFor("!!document.getElementById('trust-fp')", 'the Trust page');
await c.waitFor("(document.getElementById('trust-fp').textContent||'').length > 0", 'the fingerprint to be worked out', 30000);
const trust = await c.js(`(function(){
  var t = function (id) { var e = document.getElementById(id); return e ? e.textContent.trim() : null; };
  var v = function (id) { var e = document.getElementById(id); return e && !e.hidden; };
  return { fp: t('trust-fp'), pk: t('trust-pk'), carried: t('trust-carried'), nojsShown: v('trust-nojs') };
})()`);

const baked = fs.readFileSync(path.join(REPO, 'src/build_server/data/plan-signing-key.pub'), 'utf8').trim();
ok(/^[0-9a-f]{16}$/.test(trust.fp || ''), 'the Trust page works out a 16-hex fingerprint', trust.fp);
ok(trust.pk === baked, '...of the key this page actually carries', trust.pk + ' vs ' + baked);
// It is not a description: the point of the section is that the numbers
// come from checking the documents in the file, not from prose.
ok(trust.carried && trust.carried.length > 0, '...and says what this copy carries');
ok(!trust.nojsShown, 'and the "scripting is off" notice is hidden once it has run');

await c.close();
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
