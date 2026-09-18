// The editor's "Sign" panel (edit.html): Authenticode for .exe with a .pfx
// or a remote signing service, OpenPGP detached signatures for .run.
// Keys live in this module's variables only: never uploaded, never put in
// storage, gone with the tab. Only a hash of the signature is sent anywhere
// (to the timestamp server, through the build server's /api/tsa).
import { openPfx } from './pkcs12.js';
import { beginPE, finishPE, pfxSigner, signPE } from './authenticode.js';
import { parseCertBundle } from './x509.js';
import { b64, unb64, hex } from './der.js';
import * as pgp from './pgp.js';
import { apiReady, errorText } from './api.js';

const $ = (id) => document.getElementById(id);

let pfxKey = null;       // openPfx() result
let pgpKey = null;       // pgp key object
let remote = null;       // {state, certs, name} while waiting for a pasted signature
let opts = null;         // {build, download, kind, programName}

function status(msg, isError) {
  const s = $('sign-status');
  s.textContent = msg || '';
  s.className = 'small' + (isError ? ' error-text' : ' muted');
}
function setText(id, text, isError) {
  const e = $(id);
  e.textContent = text || '';
  e.hidden = !text;
  e.classList.toggle('error-text', !!isError);
}

const fmtDate = (d) => d.toISOString().slice(0, 10);
function describeCert(c, chain) {
  const now = new Date();
  let s = 'Signs as: ' + c.subject + '\nIssued by: ' + c.issuer + '\nValid ' + fmtDate(c.notBefore) + ' to ' + fmtDate(c.notAfter);
  if (now > c.notAfter) s += ' (EXPIRED: Windows rejects new signatures made with it)';
  else if (now < c.notBefore) s += ' (not valid yet)';
  if (c.selfIssued) s += '\nSelf-signed: fine for testing, but Windows will say the publisher is unknown.';
  if (chain && chain.length > 1) s += '\nChain: ' + chain.map((x) => x.commonName).join(' → ');
  return s;
}

function timestampFn() {
  if (!$('ts-on').checked) return null;
  const name = $('ts-name').value;
  return async (req) => {
    let r;
    try {
      r = await fetch((await apiReady()) + '/api/tsa?name=' + encodeURIComponent(name), {
        method: 'POST', headers: { 'Content-Type': 'application/timestamp-query' }, body: req,
      });
    } catch (e) {
      throw new Error('Couldn\'t reach the build server for the timestamp. Untick "Timestamp" to sign without one.');
    }
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch (e) { /* not JSON */ }
      throw new Error('Timestamp failed: ' + msg);
    }
    return new Uint8Array(await r.arrayBuffer());
  };
}

function signOpts() {
  return { programName: $('sign-name').value.trim(), url: $('sign-url').value.trim(), timestamp: timestampFn() };
}

function doneText(r, name) {
  let s = 'Signed and saved ' + name + ' as ' + r.signer.commonName + '.';
  if (r.timestamp) s += ' Timestamped ' + r.timestamp.genTime.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC') + (r.timestamp.tsa ? ' by ' + r.timestamp.tsa : '') + '.';
  return s;
}

/* ---------- Windows: .pfx ---------- */

async function openPfxClicked() {
  const f = $('pfx-file').files && $('pfx-file').files[0];
  if (!f) { setText('pfx-status', 'Choose your .pfx or .p12 file first.', true); return; }
  setText('pfx-status', 'Opening…');
  try {
    pfxKey = await openPfx(new Uint8Array(await f.arrayBuffer()), $('pfx-pass').value);
    $('pfx-pass').value = '';
    $('pfx-file').value = '';
    setText('pfx-status', describeCert(pfxKey.cert, pfxKey.chain));
    $('pfx-forget').hidden = false;
  } catch (e) {
    pfxKey = null;
    setText('pfx-status', e.code === 'legacy' ? e.message : errorText(e), true);
  }
}

function forgetPfx() {
  pfxKey = null;
  $('pfx-forget').hidden = true;
  setText('pfx-status', 'Key forgotten.');
}

/* ---------- Windows: remote service, by paste ---------- */

async function readRemoteCerts() {
  const f = $('remote-certs-file').files && $('remote-certs-file').files[0];
  if (f) return parseCertBundle(new Uint8Array(await f.arrayBuffer()));
  const text = $('remote-certs').value.trim();
  if (!text) throw new Error('Give your certificate (and its chain) first: a PEM, .cer, .crt or .p7b.');
  return parseCertBundle(text);
}

function showDigest(state, certs) {
  const d64 = b64(state.digest);
  $('remote-digest-b64').textContent = d64;
  $('remote-digest-hex').textContent = hex(state.digest);
  const ec = certs.some((c) => c.keyType === 'ec');
  $('remote-example').textContent = [
    '# Any tool that signs a SHA-256 digest. Examples:',
    '# openssl (a key file or a PKCS#11 HSM):',
    'echo ' + d64 + ' | base64 -d > digest.bin',
    'openssl pkeyutl -sign -inkey key.pem' + (ec ? '' : ' -pkeyopt digest:sha256') + ' -in digest.bin | base64 -w0',
    '# AWS KMS:',
    'aws kms sign --key-id <key-arn> --message-type DIGEST --signing-algorithm ' + (ec ? 'ECDSA_SHA_256' : 'RSASSA_PKCS1_V1_5_SHA_256') +
      ' --message fileb://digest.bin --query Signature --output text',
    '# Google Cloud KMS:',
    'gcloud kms asymmetric-sign --location <loc> --keyring <ring> --key <key> --version <n> --digest-algorithm sha256 --input-file digest.bin --signature-file sig.bin && base64 -w0 sig.bin',
  ].join('\n');
  $('remote-sig').value = '';
  $('remote-step').hidden = false;
}

async function startRemote() {
  const certs = await readRemoteCerts();
  const { out, name } = await opts.build();
  const state = await beginPE(out, signOpts());
  remote = { state, certs, name };
  showDigest(state, certs);
  status('Waiting for the signature. The digest covers this exact file: changing any setting means starting again.');
}

async function finishRemote() {
  if (!remote) return;
  let sig;
  try { sig = unb64($('remote-sig').value); } catch (e) { status('That isn\'t base64.', true); return; }
  if (!sig.length) { status('Paste the signature first.', true); return; }
  status('Checking the signature…');
  try {
    const r = await finishPE(remote.state, sig, remote.certs, { timestamp: timestampFn() });
    opts.download(r.file, remote.name);
    status(doneText(r, remote.name));
    cancelRemote(true);
  } catch (e) {
    status(errorText(e), true);
  }
}

function cancelRemote(keepStatus) {
  remote = null;
  $('remote-step').hidden = true;
  if (keepStatus !== true) status('');
}

/* ---------- Linux: OpenPGP ---------- */

async function makePgpKey() {
  const uid = $('pgp-uid').value.trim();
  const type = $('pgp-type').value;
  setText('pgp-status', 'Making the key…');
  try {
    pgpKey = await pgp.generateKey(type === 'ed25519' ? 'ed25519' : 'rsa', uid, { bits: type === 'rsa4096' ? 4096 : 3072 });
    setText('pgp-status', 'New key ' + pgp.fingerprintHex(pgpKey) + '\n' + pgpKey.userId +
      '\nSave the secret key now if you will sign later versions with it: this page forgets it when you close the tab.');
    $('pgp-downloads').hidden = false;
  } catch (e) {
    pgpKey = null;
    setText('pgp-status', /Ed25519|Unrecognized|NotSupported/i.test(String(e && (e.name + e.message))) && type === 'ed25519'
      ? 'This browser can\'t make Ed25519 keys; choose RSA.' : errorText(e), true);
  }
}

async function importPgpKey() {
  const f = $('pgp-file').files && $('pgp-file').files[0];
  const input = f ? new Uint8Array(await f.arrayBuffer()) : $('pgp-paste').value;
  if (!f && !input.trim()) { setText('pgp-status', 'Choose your exported secret key, or paste it.', true); return; }
  setText('pgp-status', 'Opening…');
  try {
    pgpKey = await pgp.importSecretKey(input, $('pgp-pass').value);
    $('pgp-pass').value = '';
    $('pgp-paste').value = '';
    $('pgp-file').value = '';
    setText('pgp-status', 'Key ' + pgp.fingerprintHex(pgpKey) + (pgpKey.subkey ? ' (signing subkey)' : '') + '\n' + pgpKey.userId);
    $('pgp-downloads').hidden = true;
  } catch (e) {
    pgpKey = null;
    setText('pgp-status', errorText(e), true);
  }
}

function fileSafe(s) { return (s || 'key').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 40); }

/* ---------- the button ---------- */

async function signClicked() {
  if (!opts) return;
  status('');
  try {
    if (opts.kind() === 'exe') {
      if ($('sign-src-remote').checked) { await startRemote(); return; }
      if (!pfxKey) { status('Open your .pfx first.', true); return; }
      status('Building and signing…');
      const { out, name } = await opts.build();
      const r = await signPE(out, pfxSigner(pfxKey), signOpts());
      opts.download(r.file, name);
      status(doneText(r, name));
    } else if (opts.kind() === 'run') {
      if (!pgpKey) { status('Make or open a key first.', true); return; }
      status('Building and signing…');
      const { out, name } = await opts.build();
      const sig = await pgp.signDetached(pgpKey, out);
      opts.download(out, name);
      opts.download(new TextEncoder().encode(sig), name + '.asc', 'application/pgp-signature');
      status('Saved ' + name + ' and ' + name + '.asc, signed by ' + pgp.fingerprintHex(pgpKey) + '. Check with: gpg --verify ' + name + '.asc ' + name);
    }
  } catch (e) {
    status('Couldn\'t sign it: ' + errorText(e), true);
  }
}

// Called by edit.js whenever an installer is opened.
export function paintSign(kind, programName) {
  $('sign-exe').hidden = kind !== 'exe';
  $('sign-run').hidden = kind !== 'run';
  $('sign-zip').hidden = kind !== 'zip';
  $('sign-go').hidden = kind === 'zip';
  $('sign-go').textContent = kind === 'run' ? 'Sign and download (.run and .run.asc)'
    : $('sign-src-remote').checked ? 'Build and show the digest to sign' : 'Sign and download';
  if (programName && !$('sign-name').value) $('sign-name').value = programName;
  cancelRemote();
  status('');
}

// build: async () => {out (Uint8Array), name}; download(bytes, name, type).
export function mountSign({ build, download, kind }) {
  opts = { build, download, kind };
  $('pfx-open').addEventListener('click', openPfxClicked);
  $('pfx-forget').addEventListener('click', forgetPfx);
  // Enter in these fields must not submit the editor's form (an unsigned download).
  $('sign-panel').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
    e.preventDefault();
    if (e.target.id === 'pfx-pass') openPfxClicked();
    else if (e.target.id === 'pgp-pass') importPgpKey();
    else if (e.target.id === 'pgp-uid') makePgpKey();
  });
  document.querySelectorAll('input[name="sign-src"]').forEach((r) => r.addEventListener('change', () => {
    const rem = $('sign-src-remote').checked;
    $('sign-pfx').hidden = rem;
    $('sign-remote').hidden = !rem;
    $('sign-go').textContent = rem ? 'Build and show the digest to sign' : 'Sign and download';
    cancelRemote();
  }));
  $('ts-on').addEventListener('change', () => { $('ts-name').disabled = !$('ts-on').checked; });
  $('remote-finish').addEventListener('click', finishRemote);
  $('remote-cancel').addEventListener('click', () => cancelRemote());
  $('remote-copy').addEventListener('click', () => {
    if (navigator.clipboard) navigator.clipboard.writeText($('remote-digest-b64').textContent).catch(() => {});
  });
  document.querySelectorAll('input[name="pgp-src"]').forEach((r) => r.addEventListener('change', () => {
    const imp = $('pgp-src-import').checked;
    $('pgp-new').hidden = imp;
    $('pgp-import').hidden = !imp;
  }));
  $('pgp-make').addEventListener('click', makePgpKey);
  $('pgp-open').addEventListener('click', importPgpKey);
  $('pgp-pub-dl').addEventListener('click', () => {
    if (pgpKey) download(new TextEncoder().encode(pgp.publicKeyArmored(pgpKey)), fileSafe(pgpKey.userId) + '.pub.asc', 'application/pgp-keys');
  });
  $('pgp-sec-dl').addEventListener('click', async () => {
    if (!pgpKey) return;
    const pass = $('pgp-sec-pass').value;
    try {
      download(new TextEncoder().encode(await pgp.secretKeyArmored(pgpKey, pass)), fileSafe(pgpKey.userId) + '.secret.asc', 'application/pgp-keys');
      $('pgp-sec-pass').value = '';
      setText('pgp-status', $('pgp-status').textContent.split('\nSave')[0] + '\nSecret key saved' + (pass ? ', protected with your passphrase.' : ' WITHOUT a passphrase: keep that file safe.'));
    } catch (e) { setText('pgp-status', errorText(e), true); }
  });
  $('sign-go').addEventListener('click', signClicked);
  // Belt and braces: drop keys when the page is hidden for good.
  window.addEventListener('pagehide', () => { pfxKey = null; pgpKey = null; remote = null; });
}

