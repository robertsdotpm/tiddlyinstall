// Signing tests for web/lib/pkcs12.js, web/lib/authenticode.js and web/lib/pgp.js, checked
// with the real tools. Test keys are made fresh in a temporary folder and
// deleted afterwards; none is ever committed.
//
//   node tests/sign-test.mjs [--no-network] [--relay http://127.0.0.1:8080]
//   node --import ./tests/no-native.mjs tests/sign-test.mjs    (no WebCrypto:
//        the plain-JavaScript crypto in web/lib/cryptox.js does it all)
//   node tests/sign-test.mjs --sslcom-sandbox   (opt-in: really calls
//        SSL.com's sandbox; credentials from the environment, see below)
//
// Needs Node 20+, openssl and gpg; osslsigncode (on PATH or in
// ~/.local/opt/ti-tools) is used when present. --no-network skips
// the RFC 3161 timestamp tests, which call DigiCert's and Sectigo's TSAs;
// --relay also sends one through a running server's POST /api/tsa.
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as der from '../web/lib/der.js';
import { openPfx } from '../web/lib/pkcs12.js';
import * as ac from '../web/lib/authenticode.js';
import { parseCertBundle } from '../web/lib/x509.js';
import { readInstaller, writeInstaller, newRecordText, recordHash } from '../shared/tifile.js';
import * as pgp from '../web/lib/pgp.js';
import * as X from '../web/lib/cryptox.js';
import * as SS from '../web/sign-services.js';
import { checkRelay, signRelay } from '../server/lib/signrelay.js';
import { startMockServices } from './mock-sign-services.mjs';
import { FX } from './fixtures.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NETWORK = !process.argv.includes('--no-network');
const RELAY = process.argv.includes('--relay') ? process.argv[process.argv.indexOf('--relay') + 1] : null;
// Opt-in only: --sslcom-sandbox calls SSL.com's sandbox for real. Off by
// default so a plain test run never touches somebody else's service.
const SSLCOM_SANDBOX = process.argv.includes('--sslcom-sandbox');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-sign-test-'));
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
const OSSL = which('osslsigncode', [path.join(os.homedir(), '.local/opt/ti-tools/root/usr/bin')]);

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
  const base = path.join(REPO, 'installer/unix/out/ti-base.run');
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
    // shared/tifile.js is also the build server's reader (server/).
    ok(info.signed && info.record === RECORD, name + ': shared/tifile.js still reads the record');
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

const bases = path.join(REPO, 'installer/windows/out');
const inputs = [['fixture', b64(FX.peIcon)]];
if (fs.existsSync(path.join(bases, 'base.exe'))) inputs.push(['base.exe', read(path.join(bases, 'base.exe'))]);
else skip('base.exe', 'installer/windows/out/base.exe not built');

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

    // The streaming PE hash (used above 64 MB, to save a copy of the whole
    // file) must give exactly what the joined-buffer one gives.
    {
      const { bytes, pe } = ac.unsignedPE(unsigned);
      const [joined, streamed] = await Promise.all([ac.peHash(bytes, pe, { stream: false }), ac.peHash(bytes, pe, { stream: true })]);
      ok(der.hex(joined) === der.hex(streamed), label + ': the streaming PE hash equals the joined-buffer one', der.hex(joined) + ' vs ' + der.hex(streamed));
    }

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

/* ---------- cloud signing services (web/sign-services.js) ---------- */
//
// None of these providers can be opened without paying and an identity
// check, so not one of them has been called for real. What is checked here
// is everything up to the wire and back: each descriptor against a mock that
// speaks the API as documented (tests/mock-sign-services.mjs), the errors it
// turns into words, where credentials do and do not go, and -- the one part
// that can be verified exactly without an account -- AWS's SigV4 against
// Amazon's own published test vectors.
//
// Every credential below is made fresh at run time. None is real, and none
// is written to a file.
await run('signing services', async () => {
  const fake = (n) => crypto.randomBytes(n).toString('hex');
  const CREDS = {
    sslcom: {
      clientId: 'mock-' + fake(4), clientSecret: fake(16), username: 'mock-user-' + fake(2),
      password: fake(12), credentialId: 'cred-' + fake(4),
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    },
    gcpkms: {
      keyVersion: 'projects/mock/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/1',
      accessToken: 'ya29.mock-' + fake(12),
    },
    awskms: { region: 'us-east-1', keyId: 'arn:aws:kms:us-east-1:111122223333:key/' + fake(8), accessKeyId: 'AKIA' + fake(8).toUpperCase().slice(0, 16), secretAccessKey: fake(20) },
    azurets: { region: 'eus', account: 'mockaccount', profile: 'mockprofile', accessToken: 'eyJmock.' + fake(12) },
    generic: { apiKey: fake(16) },
  };

  // The mock's key: EC where the service also hands back a certificate
  // (so the chain it sends is the one the signature belongs to), RSA where
  // the publisher supplies the certificate themselves.
  const EC_SIGNS = ['sslcom', 'azurets', 'generic-with-cert'];
  const signWith = async (digest, which) => {
    fs.writeFileSync(t('svc-digest.bin'), digest);
    const ec = EC_SIGNS.indexOf(which) >= 0;
    const args = ['pkeyutl', '-sign', '-inkey', ec ? 'ec.key' : 'rsa.key', '-in', 'svc-digest.bin', '-out', 'svc.sig'];
    if (!ec) args.push('-pkeyopt', 'digest:sha256');
    execFileSync('openssl', args, { cwd: TMP });
    return fs.readFileSync(t('svc.sig'));
  };
  const derOf = (pemFile) => {
    execFileSync('openssl', ['x509', '-in', pemFile, '-outform', 'DER', '-out', pemFile + '.der'], { cwd: TMP });
    return fs.readFileSync(t(path.basename(pemFile) + '.der')).toString('base64');
  };
  const serviceChain = [derOf('ec.crt'), derOf('ca.crt')];     // what sslcom/azurets hand back
  const rsaChain = parseCertBundle(fs.readFileSync(t('rsa.crt'), 'utf8'));
  const ecChain = parseCertBundle(fs.readFileSync(t('ec.crt'), 'utf8') + fs.readFileSync(t('ca.crt'), 'utf8'));

  const mock = await startMockServices({ sign: signWith, certsB64: serviceChain, creds: CREDS });

  // Azure is relayed in production, so it is relayed here too: the real
  // server/lib/signrelay.js handler, over a real socket, in front of the
  // mock. `relayed` records what the relay actually dialled and with which
  // headers, for the credential checks below.
  const relayed = [];
  const relayStub = {
    readBody: (rq) => new Promise((resolve) => { const c = []; rq.on('data', (x) => c.push(x)); rq.on('end', () => resolve(Buffer.concat(c))); }),
    apiError: (res, status, code, msg) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: msg, code })); },
    writeJSON: (res, status, v) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); },
    // lib/netsafe.js refuses to dial loopback, which is right in production
    // and wrong for a mock, so the test injects the fetch it uses.
    fetch: async (url, o) => {
      relayed.push({ url, headers: o.headers });
      const r = await fetch(mock.rewrite(url), { method: o.method, headers: o.headers, body: o.body });
      const buf = Buffer.from(await r.arrayBuffer());
      return { status: r.status, headers: Object.fromEntries(r.headers), upTo: async () => buf };
    },
  };
  const relaySrv = http.createServer((rq, rs) => signRelay(rq, rs, rq.url.split('/').pop(), relayStub));
  await new Promise((r) => relaySrv.listen(0, '127.0.0.1', r));
  const relayOrigin = 'http://127.0.0.1:' + relaySrv.address().port;

  const send = SS.makeSend({ fetch: (u, o) => fetch(u, o), rewrite: mock.rewrite, relayBase: relayOrigin });
  const ctx = { send, sleep: () => Promise.resolve() };

  try {
    /* --- AWS SigV4 against Amazon's own vectors --- */
    // Two of the twenty published cases are internally inconsistent in
    // Amazon's own suite: sha256 of the .creq they ship is not the hash
    // inside the .sts they ship, so their signature cannot be reproduced
    // from their canonical request by anybody. The canonical request is
    // checked for all twenty; the string to sign and the Authorization
    // header for the eighteen that are self-consistent.
    const V = JSON.parse(fs.readFileSync(path.join(REPO, 'tests/sigv4-vectors.json'), 'utf8'));
    let creqOK = 0, authOK = 0, skippedV = 0;
    for (const c of V.cases) {
      const r = await SS.sigv4Sign({
        method: c.method, path: c.path, query: c.query, headers: c.headers, body: c.body,
        region: V.config.region, service: V.config.service, amzDate: '20150830T123600Z',
        accessKeyId: V.config.accessKeyId, secretAccessKey: V.config.secretAccessKey,
      });
      if (r.creq === c.creq) creqOK++;
      else ok(false, 'sigv4 ' + c.name + ': canonical request', JSON.stringify(r.creq) + ' != ' + JSON.stringify(c.creq));
      const selfConsistent = der.hex(await X.digest('SHA-256', new TextEncoder().encode(c.creq))) === c.sts.split('\n')[3];
      if (!selfConsistent) { skippedV++; continue; }
      if (r.sts === c.sts && r.authorization === c.authz) authOK++;
      else ok(false, 'sigv4 ' + c.name + ': string to sign and Authorization', r.authorization + ' != ' + c.authz);
    }
    ok(creqOK === V.cases.length, 'sigv4: the canonical request matches all ' + V.cases.length + ' of Amazon\'s published vectors', creqOK + '/' + V.cases.length);
    ok(authOK === V.cases.length - skippedV, 'sigv4: the Authorization header matches the ' + (V.cases.length - skippedV) +
      ' vectors Amazon ships self-consistently (' + skippedV + ' of theirs are not)', authOK);

    /* --- RFC 6238, for eSigner's one-time code --- */
    let totpOK = 0;
    for (const [T, want] of [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']]) {
      if (await SS.totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', T * 1000) === want) totpOK++;
    }
    ok(totpOK === 6, 'eSigner: the TOTP code matches all six RFC 6238 SHA-1 test vectors', totpOK + '/6');

    /* --- each provider, end to end, into a real signed installer --- */
    const cases = [
      ['SSL.com eSigner', 'sslcom', {
        env: 'production', clientId: CREDS.sslcom.clientId, clientSecret: CREDS.sslcom.clientSecret,
        username: CREDS.sslcom.username, password: CREDS.sslcom.password,
        totp: CREDS.sslcom.totpSecret, credentialId: '', keyType: 'ec',
      }, null, 'ca.crt', 'ec.crt'],
      ['Google Cloud KMS', 'gcpkms', { keyVersion: CREDS.gcpkms.keyVersion, accessToken: CREDS.gcpkms.accessToken }, rsaChain, 'rsa.crt', 'rsa.crt'],
      ['AWS KMS', 'awskms', {
        region: CREDS.awskms.region, keyId: CREDS.awskms.keyId, accessKeyId: CREDS.awskms.accessKeyId,
        secretAccessKey: CREDS.awskms.secretAccessKey, sessionToken: '', algorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
      }, rsaChain, 'rsa.crt', 'rsa.crt'],
      ['Azure Trusted Signing', 'azurets', {
        region: CREDS.azurets.region, account: CREDS.azurets.account, profile: CREDS.azurets.profile,
        accessToken: CREDS.azurets.accessToken, algorithm: 'ES256',
      }, null, 'ca.crt', 'ec.crt'],
      ['generic, JSON in and out', 'generic', {
        url: 'https://127.0.0.1:0/x', method: 'POST', headers: 'X-API-Key: ' + CREDS.generic.apiKey,
        digestEncoding: 'base64', bodyTemplate: '{"hash":"{{digest}}"}', signaturePath: 'result.sig',
        signatureEncoding: 'base64', certPath: '',
      }, rsaChain, 'rsa.crt', 'rsa.crt', '/generic/json-base64'],
      ['generic, hex both ways', 'generic', {
        url: 'https://127.0.0.1:0/x', method: 'POST', headers: '',
        digestEncoding: 'hex', bodyTemplate: '{"digest_hex":"{{digest}}"}', signaturePath: 'signatures.0',
        signatureEncoding: 'hex', certPath: '',
      }, rsaChain, 'rsa.crt', 'rsa.crt', '/generic/json-hex'],
      ['generic, raw digest as the body', 'generic', {
        url: 'https://127.0.0.1:0/x', method: 'POST', headers: '',
        digestEncoding: 'raw', bodyTemplate: '', signaturePath: '', signatureEncoding: 'base64', certPath: '',
      }, rsaChain, 'rsa.crt', 'rsa.crt', '/generic/raw-body'],
      ['generic, the service sends the chain', 'generic', {
        url: 'https://127.0.0.1:0/x', method: 'POST', headers: '',
        digestEncoding: 'base64', bodyTemplate: '{"hash":"{{digest}}"}', signaturePath: 'sig',
        signatureEncoding: 'base64', certPath: 'chain',
      }, null, 'ca.crt', 'ec.crt', '/generic/with-cert'],
    ];

    for (const [label, id, creds, chain, ca, certFile, genericPath] of cases) {
      const svc = SS.service(id);
      if (genericPath) creds.url = mock.origin + genericPath;
      const unsigned = await withRecord(b64(FX.peIcon));
      const state = await ac.beginPE(unsigned, { programName: 'Service Test' });
      const answer = await svc.sign(creds, state.digest, ctx);
      const certs = answer.certs ? parseCertBundle(answer.certs) : chain;
      const r = await ac.finishPE(state, answer.signature, certs);
      const f = t('svc-' + id + '-' + (genericPath || '').replace(/\W+/g, '') + '.exe');
      fs.writeFileSync(f, r.file);
      await checkFile(label, f, t(ca), t(certFile));
    }
    ok(true, 'every provider produced a signature that finishPE accepted and osslsigncode verified (' + cases.length + ' shapes)');

    /* --- the certificate a service sends is the one the chain is built from --- */
    {
      const svc = SS.service('sslcom');
      const state = await ac.beginPE(await withRecord(b64(FX.peIcon)));
      const answer = await svc.sign({
        env: 'production', clientId: CREDS.sslcom.clientId, clientSecret: CREDS.sslcom.clientSecret,
        username: CREDS.sslcom.username, password: CREDS.sslcom.password, totp: CREDS.sslcom.totpSecret,
        credentialId: CREDS.sslcom.credentialId, keyType: 'ec',
      }, state.digest, ctx);
      const chain = parseCertBundle(answer.certs);
      ok(chain.length === 2 && chain[0].commonName === 'Sign Test EC Leaf TEST' && chain[1].commonName === 'Sign Test CA TEST',
        'eSigner: the chain from credentials/info is read leaf first', chain.map((c) => c.commonName).join(' -> '));
    }

    /* --- no credential ever goes into a URL, where it could be logged --- */
    {
      const secrets = [CREDS.sslcom.clientSecret, CREDS.sslcom.password, CREDS.sslcom.totpSecret,
        CREDS.gcpkms.accessToken, CREDS.awskms.secretAccessKey, CREDS.azurets.accessToken, CREDS.generic.apiKey];
      const urls = mock.calls.map((c) => c.path + c.query).join(' ');
      ok(!secrets.some((s) => urls.indexOf(s) >= 0), 'no credential appears in any request path or query string');
      // And the secret access key must never be sent at all: SigV4 proves
      // possession without it.
      const everything = mock.calls.map((c) => JSON.stringify(c.headers) + ' ' + c.text).join(' ');
      ok(everything.indexOf(CREDS.awskms.secretAccessKey) < 0, 'the AWS secret access key is never sent, only used to sign');
      ok(everything.indexOf(CREDS.sslcom.totpSecret) < 0, 'the eSigner TOTP secret is never sent, only used to make a code');
      ok(everything.indexOf(CREDS.sslcom.clientSecret) >= 0 && everything.indexOf(CREDS.gcpkms.accessToken) >= 0,
        'the credentials that must be sent are sent (a control for the two checks above)');
    }

    /* --- the descriptors do not keep or change what they were given --- */
    {
      const before = { keyVersion: CREDS.gcpkms.keyVersion, accessToken: CREDS.gcpkms.accessToken };
      const copy = JSON.parse(JSON.stringify(before));
      const state = await ac.beginPE(await withRecord(b64(FX.peIcon)));
      await SS.service('gcpkms').sign(copy, state.digest, ctx);
      ok(JSON.stringify(copy) === JSON.stringify(before), 'a descriptor does not change the credentials object it is handed');
    }

    /* --- failures, in plain words --- */
    const digest = (await ac.beginPE(await withRecord(b64(FX.peIcon)))).digest;
    const says = async (id, creds, what) => {
      try { await SS.service(id).sign(creds, digest, ctx); return '(no error)'; } catch (e) { return e.message; }
    };
    const G = { keyVersion: CREDS.gcpkms.keyVersion, accessToken: CREDS.gcpkms.accessToken };
    const S = {
      env: 'production', clientId: CREDS.sslcom.clientId, clientSecret: CREDS.sslcom.clientSecret,
      username: CREDS.sslcom.username, password: CREDS.sslcom.password, totp: CREDS.sslcom.totpSecret,
      credentialId: CREDS.sslcom.credentialId, keyType: 'ec',
    };
    const A = {
      region: CREDS.azurets.region, account: CREDS.azurets.account, profile: CREDS.azurets.profile,
      accessToken: CREDS.azurets.accessToken, algorithm: 'ES256',
    };
    const W = {
      region: CREDS.awskms.region, keyId: CREDS.awskms.keyId, accessKeyId: CREDS.awskms.accessKeyId,
      secretAccessKey: CREDS.awskms.secretAccessKey, sessionToken: '', algorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
    };
    const bad = (o, k, v) => Object.assign(JSON.parse(JSON.stringify(o)), { [k]: v });

    let m = await says('gcpkms', bad(G, 'accessToken', 'expired-token'));
    ok(/did not accept those credentials/.test(m), 'Cloud KMS: a bad token is reported as a rejected credential, not a stack trace', m);
    m = await says('gcpkms', bad(G, 'keyVersion', 'projects/mock/locations/global/keyRings/r/cryptoKeys/k/cryptoKeyVersions/9'));
    ok(/no key or profile by that name/.test(m), 'Cloud KMS: a missing key version says which identifier to check', m);
    m = await says('gcpkms', bad(G, 'accessToken', ''));
    ok(/every field above/.test(m), 'Cloud KMS: an empty field is caught before anything is sent', m);

    m = await says('sslcom', bad(S, 'password', 'wrong'));
    ok(/invalid_grant|did not accept|refused the request/.test(m), 'eSigner: a wrong password is reported from the token call', m);
    m = await says('sslcom', bad(S, 'totp', '000000'));
    ok(/one-time code is the usual reason/.test(m), 'eSigner: a wrong one-time code names the one-time code', m);
    m = await says('sslcom', bad(S, 'totp', 'not base32!'));
    ok(/TOTP secret/.test(m), 'eSigner: something that is neither a code nor a secret is caught before anything is sent', m);

    m = await says('awskms', bad(W, 'secretAccessKey', 'wrong-secret-key-entirely'));
    ok(/signature did not match|refused those credentials/.test(m), 'AWS KMS: a wrong secret key is reported as a signature mismatch, with the clock as a suspect', m);
    m = await says('awskms', bad(W, 'keyId', 'arn:aws:kms:us-east-1:111122223333:key/nope'));
    ok(/no key by that ID in that region/.test(m), 'AWS KMS: a missing key is read out of the __type field', m);
    m = await says('awskms', bad(W, 'region', 'not a region'));
    ok(/not an AWS region name/.test(m), 'AWS KMS: a malformed region is caught before anything is sent', m);

    m = await says('azurets', bad(A, 'accessToken', 'stale'));
    ok(/did not accept that token.*expired|expired.*hour/s.test(m), 'Azure: a stale token says tokens expire and names the resource', m);
    m = await says('azurets', bad(A, 'account', 'has spaces and /slashes'));
    ok(/letters, digits/.test(m), 'Azure: an account name that could bend the URL is refused before anything is sent', m);

    mock.setFail({ 'azurets-failed': true });
    m = await says('azurets', A);
    ok(/came back "Failed"/.test(m), 'Azure: an operation that fails after polling is reported as such', m);
    mock.setFail({ 'sslcom-many': true });
    m = await says('sslcom', bad(S, 'credentialId', ''));
    ok(/several credentials/.test(m), 'eSigner: several credentials and no choice made asks for the choice', m);
    mock.setFail({ gcpkms: { status: 429, body: { error: { message: 'Quota exceeded' } } } });
    m = await says('gcpkms', G);
    ok(/rate-limiting you/.test(m) && /Quota exceeded/.test(m), 'Cloud KMS: a 429 is explained and the provider\'s own words are kept', m);
    mock.setFail({ gcpkms: { status: 503, body: { error: { message: 'backend unavailable' } } } });
    m = await says('gcpkms', G);
    ok(/their end, not yours/.test(m), 'Cloud KMS: a 5xx says whose problem it is', m);
    mock.setFail({});

    /* --- the generic option's own mistakes --- */
    const gen = (o) => Object.assign({
      url: mock.origin + '/generic/json-base64', method: 'POST', headers: 'X-API-Key: ' + CREDS.generic.apiKey,
      digestEncoding: 'base64', bodyTemplate: '{"hash":"{{digest}}"}', signaturePath: 'result.sig',
      signatureEncoding: 'base64', certPath: '',
    }, o);
    m = await says('generic', gen({ url: 'http://signing.example.com/sign' }));
    ok(/must be https/.test(m), 'generic: a plain http:// address is refused, saying why', m);
    m = await says('generic', gen({ headers: 'X-API-Key ' + CREDS.generic.apiKey }));
    ok(/Name: value/.test(m), 'generic: a header line without a colon says what one looks like', m);
    m = await says('generic', gen({ bodyTemplate: '{"hash":"fixed"}' }));
    ok(/no \{\{digest\}\}/.test(m), 'generic: a body template with no {{digest}} is refused rather than signing nothing', m);
    m = await says('generic', gen({ signaturePath: 'result.nope' }));
    ok(/nothing at "result.nope"/.test(m), 'generic: a wrong path into the answer names the path', m);
    m = await says('generic', gen({ url: mock.origin + '/generic/not-json' }));
    ok(/not JSON/.test(m), 'generic: an HTML answer (a login page, usually) is reported as not JSON', m);
    m = await says('generic', gen({ headers: 'X-API-Key: wrong' }));
    ok(/did not accept those credentials/.test(m), 'generic: the service\'s own 401 is explained', m);
    m = await says('generic', gen({ digestEncoding: 'raw' }));
    ok(/only works as the whole body/.test(m), 'generic: raw bytes with a body template is refused with the fix', m);
    m = await says('generic', gen({ url: 'https://127.0.0.1:1/nothing-listening' }));
    ok(/CORS/.test(m) && /curl/.test(m), 'generic: an unreachable address names CORS as the likely cause and how to tell', m);

    /* --- a hostile answer cannot produce a file --- */
    {
      const state = await ac.beginPE(await withRecord(b64(FX.peIcon)));
      const answer = await SS.service('gcpkms').sign(G, state.digest, ctx);
      // The right signature, but claimed for somebody else's certificate.
      let why = '';
      try { await ac.finishPE(state, answer.signature, ecChain); } catch (e) { why = e.message; }
      ok(/does not verify/.test(why), 'a service answer is still checked against the certificate before anything is written', why);
    }

    /* --- the relay's allow-list (server/lib/signrelay.js) --- */
    {
      const good = 'https://eus.codesigning.azure.net/codeSigningAccounts/acct/certificateProfiles/prof:sign?api-version=2023-06-15-preview';
      ok(checkRelay('azurets', good, 'POST').url === good, 'relay: the documented Azure sign URL is allowed');
      ok(checkRelay('azurets', good.replace(':sign', '/operations/op-1'), 'GET').url.indexOf('/operations/') > 0, 'relay: the status URL is allowed');
      const refused = [
        ['another host entirely', 'https://evil.example.com/sign?api-version=2023-06-15-preview'],
        ['a lookalike host', 'https://eus.codesigning.azure.net.evil.example.com/codeSigningAccounts/a/certificateProfiles/p:sign?api-version=2023-06-15-preview'],
        ['a userinfo trick', 'https://eus.codesigning.azure.net@evil.example.com/codeSigningAccounts/a/certificateProfiles/p:sign?api-version=2023-06-15-preview'],
        ['plain http', 'http://eus.codesigning.azure.net/codeSigningAccounts/a/certificateProfiles/p:sign?api-version=2023-06-15-preview'],
        ['a path of their choosing', 'https://eus.codesigning.azure.net/codeSigningAccounts/a/certificateProfiles/p/../../../admin?api-version=2023-06-15-preview'],
        ['a second query parameter', good + '&redirect=https://evil.example.com'],
        ['loopback', 'https://127.0.0.1/codeSigningAccounts/a/certificateProfiles/p:sign?api-version=2023-06-15-preview'],
        ['no query at all', good.replace(/\?.*$/, '')],
      ];
      let stopped = 0;
      for (const [what, url] of refused) {
        try { checkRelay('azurets', url, 'POST'); ok(false, 'relay refuses ' + what, url); } catch (e) { if (e.code === 'not_allowed') stopped++; }
      }
      ok(stopped === refused.length, 'relay: all ' + refused.length + ' URLs a page might try to smuggle through are refused', stopped);
      let unknown = '';
      try { checkRelay('digicert', good, 'POST'); } catch (e) { unknown = e.code; }
      ok(unknown === 'not_allowed', 'relay: a provider that is not on the list is refused (DigiCert is deliberately not relayed)');
      let wrongMethod = '';
      try { checkRelay('azurets', good, 'DELETE'); } catch (e) { wrongMethod = e.code; }
      ok(wrongMethod === 'not_allowed', 'relay: a method the provider does not use is refused');
    }

    /* --- the relay, which every Azure call above already went through --- */
    {
      // Several of the Azure calls above deliberately used a stale token, so
      // the check is that every relayed call carried the token it was given,
      // as a bearer token, and that the good one got through unaltered.
      ok(relayed.length >= 2 && relayed.every((s) => /^Bearer \S+$/.test(String(s.headers.Authorization || ''))),
        'relay: every relayed call carried the caller\'s token as a bearer token', relayed.length);
      ok(relayed.filter((s) => s.headers.Authorization === 'Bearer ' + CREDS.azurets.accessToken).length >= 2,
        'relay: the token reaches Azure unaltered, in the header Azure expects');
      ok(relayed.every((s) => s.url.indexOf(CREDS.azurets.accessToken) < 0),
        'relay: the token is never put in the URL the relay dials, so it cannot reach an access log');
      ok(relayed.every((s) => /^https:\/\/eus\.codesigning\.azure\.net\//.test(s.url)),
        'relay: every address it dialled was Azure\'s own', relayed.map((s) => s.url).join(' '));
      // The page puts the credential in a header of its own, so the relay's
      // request line -- the only thing server.js logs -- carries nothing.
      const before = relayed.length;
      const smuggle = await fetch(relayOrigin + '/api/sign/azurets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TI-Sign-Auth': 'Bearer ' + CREDS.azurets.accessToken },
        body: JSON.stringify({ url: 'https://evil.example.com/steal', method: 'POST', body: {} }),
      });
      const why = await smuggle.json();
      ok(smuggle.status === 403 && why.code === 'not_allowed' && relayed.length === before,
        'relay: a URL off the allow-list is refused with 403 over the wire, and never dialled', JSON.stringify(why));
      const junk = await fetch(relayOrigin + '/api/sign/azurets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
      ok(junk.status === 400, 'relay: a body that is not JSON is refused', junk.status);
    }

    /* --- what the panel must say, before anyone types anything --- */
    {
      const direct = SS.SERVICES.filter((s) => s.where === 'browser').map((s) => s.id);
      const relayed = SS.SERVICES.filter((s) => s.where === 'server').map((s) => s.id);
      ok(direct.join(',') === 'sslcom,gcpkms,awskms,generic', 'the direct providers are the ones whose APIs send CORS headers', direct.join(','));
      ok(relayed.join(',') === 'azurets', 'exactly one provider is relayed', relayed.join(','));
      ok(SS.servicesFor(false).every((s) => s.where !== 'server') && SS.servicesFor(true).length === SS.SERVICES.length,
        'the offline page is offered every provider except the relayed one');
      let said = 0;
      for (const s of SS.SERVICES) {
        const d = SS.describe(s);
        if (!d.credentials || !d.evidence || !d.untested) continue;
        if (s.where === 'browser' && !/stay in this browser/.test(d.credentials)) continue;
        if (s.where === 'server' && !/pass through the build server/.test(d.credentials)) continue;
        if (s.where === 'paste' && !/Nothing secret is typed/.test(d.credentials)) continue;
        said++;
      }
      ok(said === SS.SERVICES.length, 'every provider says where its credentials go, how it was checked, and how far it has been tested', said + '/' + SS.SERVICES.length);
      // Sandbox-verified and live-account-verified are different claims.
      const sandboxed = SS.SERVICES.filter((x) => x.verified).map((x) => x.id);
      ok(sandboxed.join(',') === 'sslcom', 'exactly one provider claims more than "written from documentation"', sandboxed.join(','));
      ok(/sandbox/i.test(SS.service('sslcom').verified) && /not yet used with a paid production account/i.test(SS.service('sslcom').verified),
        'eSigner claims the sandbox specifically, and says a paid account is still untried', SS.service('sslcom').verified);
      ok(SS.SERVICES.filter((x) => !x.verified).every((x) => SS.describe(x).untested === SS.UNTESTED),
        'every other provider still says it is untested against a live account');
      ok(SS.SERVICES.every((s) => s.where !== 'browser' || /Access-Control|CORS/.test(s.evidence)),
        'every provider called directly cites the CORS evidence for it');
      const dc = SS.service('digicert');
      ok(dc.where === 'paste' && /mutual TLS|client certificate/i.test(dc.evidence),
        'DigiCert says it is paste-only because of the client certificate');
      const cmd = dc.command({ keypairId: 'kp-1', sigAlg: 'SHA256WithRSA', host: 'clientauth.one.digicert.com' }, 'QUJD');
      ok(/smctl sign/.test(cmd) && /QUJD/.test(cmd) && /keypairs\/kp-1\/sign/.test(cmd),
        'DigiCert\'s commands carry the digest and the keypair, both ways round', cmd.slice(0, 80));
      const cl = SS.contactLink();
      ok(cl !== null && /^(mailto:|https:\/\/)/.test(cl.href) && cl.text && cl.text.indexOf(':') < 0,
        'the panel has a working contact address to show', cl && cl.href);
    }
  } finally {
    await new Promise((r) => relaySrv.close(r));
    await mock.close();
  }
});

/* ---------- SSL.com eSigner, against their sandbox (opt-in) ---------- */
//
// The one provider on the list that can be checked against the real thing
// without spending anything: SSL.com publish sandbox demo credentials. This
// is off unless --sslcom-sandbox is given, because it calls someone else's
// service; and the credentials come from the environment, never from this
// file. They are public, but a test that carries credentials in its source
// teaches the wrong habit.
//
//   SSLCOM_SANDBOX_CLIENT_ID=… SSLCOM_SANDBOX_USER=… SSLCOM_SANDBOX_PASS=… \
//   SSLCOM_SANDBOX_TOTP=… node tests/sign-test.mjs --sslcom-sandbox
//
// The values are on SSL.com's "eSigner demo credentials and certificates"
// page. Sandbox only: the test fails if a production URL is even built.
if (!SSLCOM_SANDBOX) skip('SSL.com eSigner sandbox', 'needs --sslcom-sandbox; it calls SSL.com');
else if (!NETWORK) skip('SSL.com eSigner sandbox', '--no-network');
else await run('sslcom sandbox', async () => {
  const env = process.env;
  const creds = {
    env: 'sandbox',
    clientId: env.SSLCOM_SANDBOX_CLIENT_ID || '',
    clientSecret: env.SSLCOM_SANDBOX_CLIENT_SECRET || '',   // the sandbox has none published
    username: env.SSLCOM_SANDBOX_USER || '',
    password: env.SSLCOM_SANDBOX_PASS || '',
    totp: env.SSLCOM_SANDBOX_TOTP || '',
    credentialId: env.SSLCOM_SANDBOX_CREDENTIAL_ID || '',
    keyType: 'rsa',
  };
  if (!creds.clientId || !creds.username || !creds.password || !creds.totp) {
    skip('SSL.com eSigner sandbox', 'set SSLCOM_SANDBOX_CLIENT_ID, _USER, _PASS and _TOTP from SSL.com\'s published demo page');
    return;
  }

  // Every URL the descriptor builds, so the test can prove it never went
  // near production.
  const urls = [];
  const send = SS.makeSend({ fetch: (u, o) => fetch(u, o), rewrite: (u) => { urls.push(u); return u; } });

  const unsigned = await withRecord(b64(FX.peIcon));   // the synthetic fixture, not a real installer
  const state = await ac.beginPE(unsigned, { programName: 'Sign Test TEST', url: 'https://example.invalid/' });
  let answer;
  try {
    answer = await SS.service('sslcom').sign(creds, state.digest, { send });
  } catch (e) {
    if (/Couldn't reach|fetch failed|ENOTFOUND|EAI_AGAIN/.test(String(e && e.message))) {
      skip('SSL.com eSigner sandbox', 'sandbox unreachable: ' + e.message);
      return;
    }
    throw e;
  }
  ok(urls.length > 0 && urls.every((u) => /^https:\/\/(cs-try|oauth-sandbox)\.ssl\.com\//.test(u)),
    'sslcom sandbox: every call went to the sandbox, none to production', urls.join(' '));

  const chain = parseCertBundle(answer.certs);
  ok(chain.length >= 2, 'sslcom sandbox: credentials/info returned a chain', chain.length + ' certificates');
  ok(!chain[0].selfIssued && chain[1] && der.eqBytes(chain[0].issuerRaw, chain[1].subjectRaw),
    'sslcom sandbox: the chain really is leaf first, then its issuer',
    chain.map((c) => c.commonName).join(' -> '));

  // finishPE only accepts a signature that verifies against one of the
  // certificates, so this passing IS the end-to-end check: a real signature
  // from a real HSM over our Authenticode digest, checked by our own code.
  const r = await ac.finishPE(state, answer.signature, chain);
  const f = t('sslcom-sandbox.exe');
  fs.writeFileSync(f, r.file);
  ok(r.signer && /Esigner|SSL/i.test(r.signer.commonName + r.signer.subject),
    'sslcom sandbox: the signature verifies against the certificate eSigner sent', r.signer && r.signer.subject);

  // openssl's own check of the signature over the signed attributes, and of
  // the messageDigest attribute, against the leaf eSigner sent.
  fs.writeFileSync(t('sslcom-leaf.pem'), '-----BEGIN CERTIFICATE-----\n' +
    der.b64(chain[0].der).replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n') + '-----END CERTIFICATE-----\n');
  opensslCheck(f, t('sslcom-leaf.pem'), 'sslcom sandbox');
  const info = await readInstaller(read(f), 'x.exe');
  ok(info.signed && info.record === RECORD, 'sslcom sandbox: the signed file still reads as an installer with its record');

  // osslsigncode can check the digest without trusting the chain: the
  // sandbox chains to an SSL.com *development* root we do not have and
  // should not ship. What must match is the message digest.
  if (OSSL) {
    const v = sh(OSSL, ['verify', '-in', f]);
    const cur = /Current message digest\s*:\s*([0-9A-F]+)/.exec(v.out);
    const calc = /Calculated message digest\s*:\s*([0-9A-F]+)/.exec(v.out);
    ok(!!cur && !!calc && cur[1] === calc[1],
      'sslcom sandbox: osslsigncode recomputes the same PE digest (the chain is an untrusted development root, as expected)',
      v.out.split('\n').filter((l) => /digest|Signature|Error|error|CA/.test(l)).slice(0, 6).join(' | '));
  } else skip('sslcom sandbox: osslsigncode', 'osslsigncode not found');
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
