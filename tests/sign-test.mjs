// Signing tests for js/pkcs12.js, js/authenticode.js and js/pgp.js, checked
// with the real tools. Test keys are made fresh in a temporary folder and
// deleted afterwards; none is ever committed.
//
//   node tests/sign-test.mjs [--no-network] [--relay http://127.0.0.1:8080]
//   node --import ./tests/no-native.mjs tests/sign-test.mjs    (no WebCrypto:
//        the plain-JavaScript crypto in js/cryptox.js does it all)
//
// Needs Node 20+, openssl and gpg; osslsigncode (on PATH or in
// ~/.local/opt/ib-tools) is used when present. --no-network skips
// the RFC 3161 timestamp tests, which call DigiCert's and Sectigo's TSAs;
// --relay also sends one through a running server's POST /api/tsa.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as der from '../js/der.js';
import { openPfx } from '../js/pkcs12.js';
import * as ac from '../js/authenticode.js';
import { parseCertBundle } from '../js/x509.js';
import { readInstaller, writeInstaller, newRecordText, recordHash } from '../js/ibfile.js';
import * as pgp from '../js/pgp.js';
import * as X from '../js/cryptox.js';
import { FX } from './fixtures.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK = !process.argv.includes('--no-network');
const RELAY = process.argv.includes('--relay') ? process.argv[process.argv.indexOf('--relay') + 1] : null;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-sign-test-'));
const PW = 'test-' + Math.random().toString(36).slice(2);   // throwaway, for throwaway keys

let passed = 0, failed = 0, skipped = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -- ' + String(extra).slice(0, 600) : '')); }
}
function skip(name, why) { skipped++; console.log('SKIP ' + name + ' (' + why + ')'); }
async function run(name, fn) {
  try { await fn(); } catch (e) { failed++; console.log('FAIL ' + name + ' threw: ' + (e && e.stack || e)); }
}

const t = (f) => path.join(TMP, f);
const read = (f) => new Uint8Array(fs.readFileSync(f));
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: TMP, encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function which(name, extra = []) {
  for (const d of [...(process.env.PATH || '').split(':'), ...extra]) {
    const p = path.join(d, name);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (e) { /* next */ }
  }
  return null;
}
const OSSL = which('osslsigncode', [path.join(os.homedir(), '.local/opt/ib-tools/root/usr/bin')]);

/* ---------- keys ---------- */

const CNF = `[req]
distinguished_name=dn
prompt=no
[dn]
CN=Sign Test TEST
O=Installer Builder TEST
[leaf]
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=codeSigning
subjectKeyIdentifier=hash
[ca]
basicConstraints=critical,CA:TRUE
keyUsage=critical,keyCertSign,cRLSign
subjectKeyIdentifier=hash
`;
function makeKeys() {
  fs.writeFileSync(t('cs.cnf'), CNF);
  const o = (args) => execFileSync('openssl', args, { cwd: TMP, stdio: ['ignore', 'pipe', 'pipe'] });
  o(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'rsa.key', '-out', 'rsa.crt', '-days', '2', '-config', 'cs.cnf', '-extensions', 'leaf']);
  o(['pkcs12', '-export', '-inkey', 'rsa.key', '-in', 'rsa.crt', '-out', 'rsa.pfx', '-passout', 'pass:' + PW]);
  o(['pkcs12', '-export', '-legacy', '-inkey', 'rsa.key', '-in', 'rsa.crt', '-out', 'rsa-legacy.pfx', '-passout', 'pass:' + PW]);
  o(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=Sign Test CA TEST', '-config', 'cs.cnf', '-extensions', 'ca']);
  o(['req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ec.key', '-out', 'ec.csr', '-subj', '/CN=Sign Test EC Leaf TEST']);
  o(['x509', '-req', '-in', 'ec.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'ec.crt', '-days', '2', '-extfile', 'cs.cnf', '-extensions', 'leaf']);
  o(['pkcs12', '-export', '-inkey', 'ec.key', '-in', 'ec.crt', '-certfile', 'ca.crt', '-out', 'ec.pfx', '-passout', 'pass:' + PW]);
}

/* ---------- checks with the real tools ---------- */

function osslVerify(file, caFile) {
  if (!OSSL) return null;
  const r = sh(OSSL, ['verify', '-in', file, '-CAfile', caFile]);
  const cur = /Current message digest\s*:\s*([0-9A-F]+)/.exec(r.out);
  const calc = /Calculated message digest\s*:\s*([0-9A-F]+)/.exec(r.out);
  return {
    ok: r.code === 0 && /Signature verification: ok/.test(r.out) && !!cur && !!calc && cur[1] === calc[1],
    timestamp: /Timestamp Server Signature verification: ok/.test(r.out),
    out: r.out,
  };
}

// openssl, independently of osslsigncode: the SignerInfo's signature over
// its signed attributes, and the messageDigest attribute over the content.
function opensslCheck(file, certFile, name) {
  const u8 = read(file);
  const dv = new DataView(u8.buffer, u8.byteOffset);
  const peOff = dv.getUint32(0x3c, true);
  const opt = peOff + 24;
  const dirs = dv.getUint16(opt, true) === 0x20b ? opt + 112 : opt + 96;
  const off = dv.getUint32(dirs + 32, true), size = dv.getUint32(dirs + 36, true);
  const p7 = u8.subarray(off + 8, off + size);
  const ci = der.parse(p7, 0, p7.length);
  fs.writeFileSync(t(name + '.p7'), ci.raw);
  const asn = sh('openssl', ['asn1parse', '-inform', 'DER', '-in', name + '.p7']);
  ok(asn.code === 0 && /1\.3\.6\.1\.4\.1\.311\.2\.1\.4/.test(asn.out) && /pkcs7-signedData/.test(asn.out), name + ': openssl asn1parse reads the PKCS#7', asn.out.slice(-300));
  const sd = ci.kid(1).kid(0);
  const si = sd.kids[sd.kids.length - 1].kid(0);
  const attrs = der.retag(si.ctx(0).raw, 0x31);
  const sig = der.readOctets(si.kid(5));
  fs.writeFileSync(t(name + '.attrs'), attrs);
  fs.writeFileSync(t(name + '.sig'), sig);
  sh('openssl', ['x509', '-in', certFile, '-pubkey', '-noout', '-out', name + '.pub']);
  const v = sh('openssl', ['dgst', '-sha256', '-verify', name + '.pub', '-signature', name + '.sig', name + '.attrs']);
  ok(v.code === 0 && /Verified OK/.test(v.out), name + ': openssl dgst verifies the signature over the signed attributes', v.out);
  const content = sd.kid(2).kid(1).kid(0);
  fs.writeFileSync(t(name + '.content'), content.value);
  const md = sh('openssl', ['dgst', '-sha256', '-r', name + '.content']).out.split(' ')[0];
  const mdAttr = si.ctx(0).kids.find((a) => der.readOid(a.kid(0)) === '1.2.840.113549.1.9.4');
  ok(md === der.hex(der.readOctets(mdAttr.kid(1).kid(0))), name + ': messageDigest attribute = openssl sha256 of the content', md);
}

/* ---------- tests ---------- */

const b64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const RECORD = newRecordText({ name: 'Sign Test', project: 'signtest', runtime: 'python', launch: '{runtime} -m signtest' });

async function withRecord(pe) {
  const info = await readInstaller(pe, 'x.exe');
  return writeInstaller(info, { record: RECORD, plan: '', pack: [{ name: 'a'.repeat(64), data: new TextEncoder().encode('packed') }] });
}

const eqB = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const hex = (u8) => Buffer.from(u8).toString('hex');

// A Linux .run: the Linux base when built, else a stand-in script.
async function withRunFile() {
  const base = path.join(REPO, 'bases/unix/out/ib-base.run');
  const bytes = fs.existsSync(base) ? read(base) : new TextEncoder().encode('#!/bin/sh\necho stand-in\nexit 0\n');
  const info = await readInstaller(bytes, 'x.run');
  return writeInstaller(info, { record: RECORD, plan: '', pack: [] });
}

async function checkFile(name, file, caFile, certFile, { record = true } = {}) {
  const v = osslVerify(file, caFile);
  if (v) ok(v.ok, name + ': osslsigncode verify', v.out.split('\n').filter((l) => /digest|verification|Error|error/.test(l)).join(' | '));
  else skip(name + ': osslsigncode verify', 'osslsigncode not found');
  opensslCheck(file, certFile, name);
  if (record) {
    const info = await readInstaller(read(file), 'x.exe');
    // js/ibfile.js is also the build server's reader (backend/).
    ok(info.signed && info.record === RECORD, name + ': js/ibfile.js still reads the record');
  }
  return v;
}

makeKeys();
console.log('keys in ' + TMP + (OSSL ? ', osslsigncode ' + OSSL : ', no osslsigncode'));

let rsa, ec;
await run('pkcs12', async () => {
  rsa = await openPfx(read(t('rsa.pfx')), PW);
  ok(rsa.algorithm.name === 'RSASSA-PKCS1-v1_5' && rsa.cert.commonName === 'Sign Test TEST', 'pkcs12: OpenSSL 3 default .pfx (AES-256, PBKDF2, HMAC-SHA256)');
  const legacy = await openPfx(read(t('rsa-legacy.pfx')), PW);
  ok(legacy.cert.serialHex === rsa.cert.serialHex, 'pkcs12: legacy .pfx (RC2-40 certificates, 3DES key, HMAC-SHA1)');
  ec = await openPfx(read(t('ec.pfx')), PW);
  ok(ec.algorithm.namedCurve === 'P-256' && ec.chain.length === 2 && ec.chain[1].commonName === 'Sign Test CA TEST', 'pkcs12: ECDSA key with its CA, chain ordered leaf first');
  let code = null;
  try { await openPfx(read(t('rsa.pfx')), PW + 'x'); } catch (e) { code = e.code; }
  ok(code === 'badpass', 'pkcs12: wrong password is reported as such', code);
  code = null;
  try { await openPfx(new TextEncoder().encode('not a pfx'), PW); } catch (e) { code = e.code; }
  ok(code === 'format', 'pkcs12: garbage is reported as not a .pfx', code);
});

const bases = path.join(REPO, 'bases/windows/out');
const inputs = [['fixture', b64(FX.peIcon)]];
if (fs.existsSync(path.join(bases, 'base.exe'))) inputs.push(['base.exe', read(path.join(bases, 'base.exe'))]);
else skip('base.exe', 'bases/windows/out/base.exe not built');

for (const [label, pe] of inputs) {
  await run('authenticode ' + label, async () => {
    const unsigned = await withRecord(pe);
    const r = await ac.signPE(unsigned, ac.pfxSigner(rsa), { programName: 'Sign Test', url: 'https://example.invalid/' });
    const f = t(label + '-rsa.exe');
    fs.writeFileSync(f, r.file);
    ok(r.file.length % 8 === 0, label + ': signed file is 8-byte aligned');
    await checkFile(label + ' RSA', f, t('rsa.crt'), t('rsa.crt'));

    const r2 = await ac.signPE(unsigned, ac.pfxSigner(ec), {});
    const f2 = t(label + '-ec.exe');
    fs.writeFileSync(f2, r2.file);
    await checkFile(label + ' ECDSA chain', f2, t('ca.crt'), t('ec.crt'));

    // Re-signing replaces the old signature and keeps the same PE hash.
    const r3 = await ac.signPE(r2.file, ac.pfxSigner(rsa), {});
    const f3 = t(label + '-resigned.exe');
    fs.writeFileSync(f3, r3.file);
    ok(ac.describeSignature(r3.file).digest === ac.describeSignature(r2.file).digest && r3.file.length <= r2.file.length + 2048,
      label + ': re-signing keeps the PE hash and replaces (not nests) the signature');
    await checkFile(label + ' re-signed', f3, t('rsa.crt'), t('rsa.crt'));

    if (OSSL) {
      const bad = r.file.slice();
      bad[Math.floor(bad.length / 3)] ^= 1;
      fs.writeFileSync(t(label + '-tampered.exe'), bad);
      ok(!osslVerify(t(label + '-tampered.exe'), t('rsa.crt')).ok, label + ': a flipped bit fails osslsigncode verify (negative control)');
    }
  });
}

const signedBase = path.join(bases, 'base-signed.exe');
if (fs.existsSync(signedBase)) {
  await run('re-sign base-signed.exe', async () => {
    const orig = read(signedBase);
    const r = await ac.signPE(orig, ac.pfxSigner(rsa), {});
    fs.writeFileSync(t('base-resigned.exe'), r.file);
    ok(ac.describeSignature(r.file).digest === ac.describeSignature(orig).digest, 'base-signed.exe: our PE hash equals the one in its existing signature');
    await checkFile('base-signed.exe re-signed', t('base-resigned.exe'), t('rsa.crt'), t('rsa.crt'), { record: false });
  });
} else skip('re-sign base-signed.exe', 'not built');

// Remote signing: openssl stands in for an HSM or KMS that only ever sees
// the digest. It signs D with the key; the page never has the key.
await run('remote signing', async () => {
  for (const [label, keyFile, certs, ca] of [
    ['RSA', 'rsa.key', 'rsa.crt', 'rsa.crt'],
    ['ECDSA', 'ec.key', 'ec.crt', 'ca.crt'],
  ]) {
    const unsigned = await withRecord(b64(FX.peIcon));
    const chain = parseCertBundle(fs.readFileSync(t(certs), 'utf8') + (label === 'ECDSA' ? fs.readFileSync(t('ca.crt'), 'utf8') : ''));
    const signer = ac.digestSigner(chain, async (digest) => {
      fs.writeFileSync(t('digest.bin'), digest);
      const args = ['pkeyutl', '-sign', '-inkey', keyFile, '-in', 'digest.bin', '-out', 'remote.sig'];
      if (label === 'RSA') args.push('-pkeyopt', 'digest:sha256');
      execFileSync('openssl', args, { cwd: TMP });
      // As pasted: base64 text.
      return der.unb64(fs.readFileSync(t('remote.sig')).toString('base64').replace(/(.{64})/g, '$1\n'));
    });
    const r = await ac.signPE(unsigned, signer, {});
    const f = t('remote-' + label + '.exe');
    fs.writeFileSync(f, r.file);
    await checkFile('remote ' + label + ' (openssl pkeyutl signs the digest)', f, t(ca), t(certs));
  }

  // ECDSA as r||s (what WebCrypto and some KMS APIs return).
  const state = await ac.beginPE(await withRecord(b64(FX.peIcon)));
  const raw = await X.sign(ec.key, state.toBeSigned);
  const r = await ac.finishPE(state, raw, ec.chain);
  fs.writeFileSync(t('remote-raw.exe'), r.file);
  await checkFile('remote ECDSA r||s', t('remote-raw.exe'), t('ca.crt'), t('ec.crt'));

  // A signature for something else, or from another key, is refused.
  const state2 = await ac.beginPE(await withRecord(b64(FX.peIcon)));
  const wrong = await X.sign(rsa.key, new TextEncoder().encode('other'));
  let msg = '';
  try { await ac.finishPE(state2, wrong, rsa.chain); } catch (e) { msg = e.message; }
  ok(/does not verify/.test(msg), 'remote: a signature over the wrong data is refused before writing the file', msg);
  msg = '';
  const good = await X.sign(rsa.key, state2.toBeSigned);
  try { await ac.finishPE(state2, good, ec.chain); } catch (e) { msg = e.message; }
  ok(/does not verify/.test(msg), 'remote: a certificate that does not match the key is refused', msg);
});

const tsaFetch = (url) => async (req) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: req });
  if (!r.ok) throw new Error(url + ': HTTP ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
};
const TSAS = [['DigiCert', 'http://timestamp.digicert.com'], ['Sectigo', 'http://timestamp.sectigo.com']];
if (RELAY) TSAS.push(['relay (DigiCert)', RELAY.replace(/\/$/, '') + '/api/tsa?name=digicert']);
for (const [name, url] of TSAS) {
  if (!NETWORK) { skip('timestamp ' + name, '--no-network'); continue; }
  await run('timestamp ' + name, async () => {
    const unsigned = await withRecord(b64(FX.peIcon));
    let r;
    try {
      r = await ac.signPE(unsigned, ac.pfxSigner(rsa), { timestamp: tsaFetch(url) });
    } catch (e) {
      if (/fetch failed|ENOTFOUND|EAI_AGAIN|HTTP 5/.test(String(e && (e.cause || e.message)))) { skip('timestamp ' + name, 'TSA unreachable: ' + e.message); return; }
      throw e;
    }
    const f = t('ts-' + name.replace(/\W+/g, '') + '.exe');
    fs.writeFileSync(f, r.file);
    ok(r.timestamp && Math.abs(r.timestamp.genTime - Date.now()) < 10 * 60e3 && ac.describeSignature(r.file).timestamped,
      'timestamp ' + name + ': token added, time ' + (r.timestamp && r.timestamp.genTime.toISOString()));
    const v = await checkFile('timestamp ' + name, f, t('rsa.crt'), t('rsa.crt'));
    if (v) ok(v.timestamp, 'timestamp ' + name + ': osslsigncode verifies the timestamp', v.out.split('\n').filter((l) => /Timestamp/.test(l)).join(' | '));
  });
}

/* ---------- OpenPGP (Linux .run) ---------- */

function gpg(home, args, input) {
  const r = spawnSync('gpg', ['--homedir', home, '--batch', '--no-tty', '--pinentry-mode', 'loopback', ...args], { cwd: TMP, encoding: 'utf8', input });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const GPG = which('gpg');
if (!GPG) skip('OpenPGP', 'gpg not found');
else await run('openpgp', async () => {
  const run_ = await withRunFile();
  fs.writeFileSync(t('app.run'), run_);
  const home = t('gnupg-verify');
  fs.mkdirSync(home, { mode: 0o700 });

  for (const type of ['ed25519', 'rsa']) {
    const k = await pgp.generateKey(type, 'Sign Test ' + type + ' TEST <' + type + '@example.invalid>');
    fs.writeFileSync(t(type + '.pub.asc'), pgp.publicKeyArmored(k));
    fs.writeFileSync(t('app-' + type + '.run.asc'), await pgp.signDetached(k, run_));
    const imp = gpg(home, ['--import', type + '.pub.asc']);
    ok(/imported: 1/.test(imp.out), 'pgp ' + type + ': gpg imports the page-made public key (self-signature valid)', imp.out);
    const v = gpg(home, ['--status-fd', '1', '--verify', 'app-' + type + '.run.asc', 'app.run']);
    ok(v.code === 0 && v.out.includes('[GNUPG:] GOODSIG ' + hex(k.keyId).toUpperCase()) && v.out.includes('VALIDSIG ' + hex(k.fingerprint).toUpperCase()),
      'pgp ' + type + ': gpg --verify says Good signature', v.out.split('\n').filter((l) => /GOODSIG|BADSIG|Good|BAD|ERRSIG/.test(l)).join(' | '));

    // The secret key the page offers for download: gpg takes it, and so do we.
    const sec = await pgp.secretKeyArmored(k, PW);
    fs.writeFileSync(t(type + '.sec.asc'), sec);
    const home2 = t('gnupg-' + type);
    fs.mkdirSync(home2, { mode: 0o700 });
    const si = gpg(home2, ['--passphrase', PW, '--import', type + '.sec.asc']);
    ok(/secret keys imported: 1/.test(si.out), 'pgp ' + type + ': gpg imports the page-made secret key with its passphrase', si.out);
    const gs = gpg(home2, ['--passphrase', PW, '--armor', '--output', 'gpg-' + type + '.asc', '--detach-sign', 'app.run']);
    const gv = gpg(home, ['--verify', 'gpg-' + type + '.asc', 'app.run']);
    ok(gs.code === 0 && /Good signature/.test(gv.out), 'pgp ' + type + ': gpg signs with that secret key and it verifies (the secret material is right)', gs.out + gv.out);
    const back = await pgp.importSecretKey(sec, PW);
    ok(eqB(back.fingerprint, k.fingerprint), 'pgp ' + type + ': the page reads its own passphrase-protected export');
  }

  // Keys made by gpg, exported with its default protection, signed here.
  const home3 = t('gnupg-gen');
  fs.mkdirSync(home3, { mode: 0o700 });
  for (const [id, algo] of [['ed', 'ed25519'], ['rsa', 'rsa3072'], ['def', 'default']]) {
    const g = gpg(home3, ['--passphrase', PW, '--quick-gen-key', 'GPG ' + id + ' TEST <' + id + '@example.invalid>', algo, algo === 'default' ? 'default' : 'sign', 'never']);
    if (g.code !== 0) { ok(false, 'gpg --quick-gen-key ' + algo, g.out); continue; }
    const ex = gpg(home3, ['--passphrase', PW, '--armor', '--export-secret-keys', id + '@example.invalid']);
    const k = await pgp.importSecretKey(ex.out.slice(ex.out.indexOf('-----BEGIN')), PW);
    fs.writeFileSync(t('app-gpg' + id + '.run.asc'), await pgp.signDetached(k, run_));
    const v = gpg(home3, ['--status-fd', '1', '--verify', 'app-gpg' + id + '.run.asc', 'app.run']);
    ok(v.code === 0 && /GOODSIG/.test(v.out), 'pgp: a gpg ' + algo + ' key, imported with its passphrase, makes a signature gpg verifies', v.out.split('\n').filter((l) => /SIG|Good|BAD/.test(l)).join(' | '));
    let msg = '';
    try { await pgp.importSecretKey(ex.out.slice(ex.out.indexOf('-----BEGIN')), PW + 'x'); } catch (e) { msg = e.message; }
    ok(/Wrong passphrase/.test(msg), 'pgp ' + algo + ': a wrong passphrase is reported', msg);
  }

  const bad = run_.slice();
  bad[100] ^= 1;
  fs.writeFileSync(t('app-bad.run'), bad);
  const v = gpg(home, ['--verify', 'app-ed25519.run.asc', 'app-bad.run']);
  ok(v.code !== 0 && /BAD signature/.test(v.out), 'pgp: a flipped bit gives BAD signature (negative control)');
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
for (const d of fs.readdirSync(TMP)) if (d.startsWith('gnupg-')) spawnSync('gpgconf', ['--homedir', t(d), '--kill', 'all']);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
