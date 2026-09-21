// The editor's "Sign" panel (edit.html): Authenticode for .exe with a .pfx
// or a remote signing service, OpenPGP detached signatures for .run.
// Keys live in this module's variables only: never uploaded, never put in
// storage, gone with the tab. Only a hash of the signature is sent anywhere
// (to the timestamp server, through the build server's /api/tsa).
import { openPfx } from './lib/pkcs12.js';
// beginPE/finishPE rather than signPE(digestSigner(...)) for the service
// route: the certificate often arrives with the signature, so the chain
// isn't known until after the call, and the steps get their own status line.
import { beginPE, finishPE, pfxSigner, signPE } from './lib/authenticode.js';
import { parseCertBundle } from './lib/x509.js';
import { b64, unb64, hex } from './lib/der.js';
import * as pgp from './lib/pgp.js';
import { apiReady, apiBase, errorText, apiLocal } from './api.js';
import { servicesFor, service, describe, makeSend, contactLink, UNTESTED, ServiceError } from './sign-services.js';

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
  if (apiLocal() || !$('ts-on').checked) return null;   // the relay is the build server's
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

/* ---------- Windows: a cloud signing service ---------- */
//
// The provider list and everything provider-specific is in
// src/web_client/sign-services.js; this is only the panel around it. Credentials follow
// the same rules as the .pfx password: they live in one variable for the
// length of one signing, they are never put in localStorage or
// sessionStorage (tests/sign-ui-test.mjs checks), the fields are cleared
// when the signing finishes, and pagehide drops them.

let creds = null;        // {fieldId: value} while a signing is in flight
let svcState = null;     // {state, certs, name} while a paste provider is waiting

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Drop every credential. Called when a signing finishes, when the provider
// changes, and on pagehide.
function forgetCreds() {
  if (creds) for (const k in creds) if (Object.prototype.hasOwnProperty.call(creds, k)) creds[k] = '';
  creds = null;
  const box = $('svc-fields');
  if (!box) return;
  const inputs = box.querySelectorAll('input, textarea');
  for (let i = 0; i < inputs.length; i++) if (inputs[i].dataset.secret === '1') inputs[i].value = '';
}

function svcChosen() {
  const sel = $('svc-name');
  return sel ? service(sel.value) : null;
}

// The provider list, rebuilt whenever the build server changes: a relayed
// provider does not exist without one, so it is not offered in the offline
// page (the same rule as the timestamp relay).
function paintServiceList() {
  const sel = $('svc-name');
  if (!sel) return;
  const want = sel.value;
  const list = servicesFor(!apiLocal());
  let html = '';
  for (let i = 0; i < list.length; i++) html += '<option value="' + esc(list[i].id) + '">' + esc(list[i].name) + '</option>';
  sel.innerHTML = html;
  if (want && service(want) && list.indexOf(service(want)) >= 0) sel.value = want;
  paintService();
}

// Everything about the chosen provider, in the order someone reads it:
// what it is, where their credentials go, that it is untested, then fields.
function paintService() {
  const svc = svcChosen();
  if (!svc) return;
  const d = describe(svc);
  const where = svc.where === 'server'
    ? '<strong>Through the build server.</strong> '
    : svc.where === 'paste' ? '<strong>By hand.</strong> ' : '<strong>Straight from this page.</strong> ';
  let html = '<p class="small" style="margin-top:0">' + esc(d.summary) + '</p>' +
    '<p class="small' + (svc.where === 'server' ? ' error-text' : ' muted') + '">' + where + esc(d.credentials) + '</p>';
  if (d.warning) html += '<p class="small error-text">' + esc(d.warning) + '</p>';
  html += '<p class="small muted"><strong>' + esc(UNTESTED) + '</strong> ' + esc(d.evidence) + '</p>';
  const c = contactLink();
  html += '<p class="small muted">If this provider has changed and the page can no longer talk to it, please tell us' +
    (c ? ': <a href="' + esc(c.href) + '" rel="noopener noreferrer">' + esc(c.text) + '</a>.'
       : ' - <em>[contact address not yet set: see docs/browser-signing.md]</em>.') +
    (d.docs ? ' <a href="' + esc(d.docs) + '" target="_blank" rel="noopener noreferrer">Their documentation</a>.' : '') + '</p>';
  $('svc-about').innerHTML = html;

  let f = '';
  for (let i = 0; i < svc.fields.length; i++) {
    const x = svc.fields[i];
    const id = 'svcf-' + x.id;
    f += '<div class="field">';
    f += '<label for="' + id + '">' + esc(x.label) + (x.optional ? ' <span class="muted">(optional)</span>' : '') + '</label>';
    if (x.type === 'select') {
      f += '<select id="' + id + '" data-field="' + esc(x.id) + '">';
      for (let j = 0; j < x.options.length; j++) f += '<option value="' + esc(x.options[j][0]) + '">' + esc(x.options[j][1]) + '</option>';
      f += '</select>';
    } else if (x.type === 'textarea') {
      f += '<textarea id="' + id + '" rows="3" spellcheck="false" autocomplete="off" data-field="' + esc(x.id) + '"' +
        (x.secret ? ' data-secret="1"' : '') + (x.placeholder ? ' placeholder="' + esc(x.placeholder) + '"' : '') + '></textarea>';
    } else {
      f += '<input type="' + (x.type === 'password' ? 'password' : 'text') + '" id="' + id + '" spellcheck="false" ' +
        'autocomplete="off" autocapitalize="off" data-field="' + esc(x.id) + '"' +
        (x.secret ? ' data-secret="1"' : '') + (x.placeholder ? ' placeholder="' + esc(x.placeholder) + '"' : '') + '>';
    }
    if (x.hint) f += '<span class="hint">' + esc(x.hint) + '</span>';
    f += '</div>';
  }
  $('svc-fields').innerHTML = f;
  $('svc-certs-row').hidden = svc.certs === 'service';
  $('svc-certs-note').textContent = svc.certs === 'service'
    ? '' : svc.certs === 'either'
      ? 'Used unless your service sends a certificate back itself (the last field above).'
      : svc.name + ' holds the key, not the certificate, so the page needs your certificate from your CA.';
  cancelServicePaste();
  $('sign-go').textContent = signGoText();
}

// Read the fields into one object. Nothing here is written anywhere else.
function readCreds(svc) {
  const out = {};
  for (let i = 0; i < svc.fields.length; i++) {
    const e = $('svcf-' + svc.fields[i].id);
    out[svc.fields[i].id] = e ? e.value : '';
  }
  return out;
}

// The certificate chain: from a file or pasted PEM, when the provider
// doesn't send one.
async function readServiceCerts() {
  const f = $('svc-certs-file').files && $('svc-certs-file').files[0];
  if (f) return parseCertBundle(new Uint8Array(await f.arrayBuffer()));
  const text = $('svc-certs').value.trim();
  if (!text) throw new Error('Give your certificate (and its chain) first: a PEM, .cer, .crt or .p7b.');
  return parseCertBundle(text);
}

async function sendFor(svc) {
  if (svc.where !== 'server') return makeSend({});
  if (apiLocal()) return makeSend({});      // makeSend says why, in plain words
  let base = apiBase();
  try { base = await apiReady(); } catch (e) { /* the probe failed; the relay call will say so */ }
  return makeSend({ relayBase: base });
}

// A "paste" provider: show the digest and the commands to run for it.
async function startServicePaste(svc) {
  const certs = await readServiceCerts();
  creds = readCreds(svc);
  const { out, name } = await opts.build();
  const state = await beginPE(out, signOpts());
  svcState = { state, certs, name };
  $('svc-example').textContent = svc.command(creds, b64(state.digest));
  $('svc-digest-b64').textContent = b64(state.digest);
  $('svc-sig').value = '';
  $('svc-step').hidden = false;
  forgetCreds();      // the commands are written; nothing more is needed
  status('Run that, then paste the signature back. The digest covers this exact file: changing any setting means starting again.');
}

async function finishServicePaste() {
  if (!svcState) return;
  let sig;
  try { sig = unb64($('svc-sig').value); } catch (e) { status('That isn\'t base64.', true); return; }
  if (!sig.length) { status('Paste the signature first.', true); return; }
  status('Checking the signature…');
  try {
    const r = await finishPE(svcState.state, sig, svcState.certs, { timestamp: timestampFn() });
    opts.download(r.file, svcState.name);
    status(doneText(r, svcState.name));
    cancelServicePaste(true);
  } catch (e) {
    status(errorText(e), true);
  }
}

function cancelServicePaste(keepStatus) {
  svcState = null;
  forgetCreds();
  if ($('svc-step')) $('svc-step').hidden = true;
  if (keepStatus !== true) status('');
}

async function signWithService() {
  const svc = svcChosen();
  if (!svc) { status('Choose a signing service first.', true); return; }
  if (svc.where === 'paste') { await startServicePaste(svc); return; }

  creds = readCreds(svc);
  try {
    const send = await sendFor(svc);
    status('Building the installer…');
    const { out, name } = await opts.build();
    const state = await beginPE(out, signOpts());
    // The service sees the 32-byte digest and nothing else. The file stays here.
    status('Asking ' + svc.name + ' to sign the digest…');
    const answer = await svc.sign(creds, state.digest, { send });
    const certs = answer.certs ? parseCertBundle(answer.certs) : await readServiceCerts();
    status('Checking the signature…');
    // finishPE refuses a signature that doesn't verify against the
    // certificate, so a wrong or hostile answer can't produce a file.
    const r = await finishPE(state, answer.signature, certs, { timestamp: timestampFn() });
    opts.download(r.file, name);
    status(doneText(r, name));
  } finally {
    forgetCreds();
  }
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

function signGoText() {
  if (!opts || opts.kind() === 'run') return 'Sign and download (.run and .run.asc)';
  if ($('sign-src-remote') && $('sign-src-remote').checked) return 'Build and show the digest to sign';
  if ($('sign-src-service') && $('sign-src-service').checked) {
    const svc = svcChosen();
    return svc && svc.where === 'paste' ? 'Build and show the digest to sign' : 'Sign and download';
  }
  return 'Sign and download';
}

async function signClicked() {
  if (!opts) return;
  status('');
  try {
    if (opts.kind() === 'exe') {
      if ($('sign-src-remote').checked) { await startRemote(); return; }
      if ($('sign-src-service').checked) { await signWithService(); return; }
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
      const sigBytes = new TextEncoder().encode(sig);
      // Files go as application/octet-stream: Chrome on Android adds an
      // extension of its own to a type it knows (.asc.key, .asc.txt).
      // Two downloads from one tap make Chrome ask "download multiple
      // files?", and on a phone that stops the second until answered: there
      // the signature is its own tap. Elsewhere both are saved, and the
      // button is for a browser that kept the second.
      const phone = document.documentElement.classList.contains('ti-mobile');
      opts.download(out, name);
      if (!phone) opts.download(sigBytes, name + '.asc');
      const fp = pgp.fingerprintHex(pgpKey);
      status(phone ? 'Saved ' + name + ', signed by ' + fp + '. Now save its signature: '
        : 'Saved ' + name + ' and ' + name + '.asc, signed by ' + fp + '. Check with: gpg --verify ' + name + '.asc ' + name + '. Only got one file? ');
      const again = document.createElement('button');
      again.type = 'button';
      again.className = phone ? 'secondary' : 'link-button';
      again.id = 'sign-asc-again';
      again.textContent = 'Save ' + name + '.asc' + (phone ? '' : ' again');
      again.addEventListener('click', () => opts.download(sigBytes, name + '.asc'));
      $('sign-status').append(again);
    }
  } catch (e) {
    // A ServiceError is already the plain-words version, from the provider's
    // descriptor; anything else gets the generic wrapper.
    status(e instanceof ServiceError ? e.message : 'Couldn\'t sign it: ' + errorText(e), true);
  }
}

/* ---------- the service panel's markup ---------- */
//
// Built here rather than in edit.html so the whole cloud-signing feature is
// one module plus one descriptor file (src/web_client/api.js builds its settings panel
// the same way). Nothing in it needs new CSS.

const SERVICE_HTML =
  '<div class="field">' +
  '<label for="svc-name">Signing service</label>' +
  '<select id="svc-name"></select>' +
  '</div>' +
  '<div id="svc-about"></div>' +
  '<div id="svc-fields"></div>' +
  '<div class="field" id="svc-certs-row">' +
  '<label for="svc-certs">Your certificate and its chain</label>' +
  '<input type="file" id="svc-certs-file" accept=".pem,.cer,.crt,.der,.p7b">' +
  '<textarea id="svc-certs" rows="3" spellcheck="false" placeholder="Or paste PEM: -----BEGIN CERTIFICATE----- …"></textarea>' +
  '<span class="hint" id="svc-certs-note"></span>' +
  '</div>' +
  '<div id="svc-step" hidden>' +
  '<span class="label">Have your service sign this SHA-256 digest</span>' +
  '<p class="small" style="margin:4px 0">Base64 <code class="sha" id="svc-digest-b64"></code></p>' +
  '<pre class="small" id="svc-example"></pre>' +
  '<div class="field">' +
  '<label for="svc-sig">The signature it returns (base64)</label>' +
  '<textarea id="svc-sig" rows="3" spellcheck="false"></textarea>' +
  '<span class="hint">The page checks it against your certificate before writing the file.</span>' +
  '</div>' +
  '<div class="actions">' +
  '<button type="button" id="svc-finish">Finish and download</button>' +
  '<button type="button" class="link-button" id="svc-cancel">Cancel</button>' +
  '</div></div>';

function buildServicePanel() {
  if ($('sign-service')) return;
  const choices = $('sign-exe').querySelector('.inline-choices');
  const label = document.createElement('label');
  label.className = 'choice';
  label.innerHTML = '<input type="radio" name="sign-src" id="sign-src-service" value="service"> A cloud signing service';
  choices.appendChild(label);
  const box = document.createElement('div');
  box.id = 'sign-service';
  box.hidden = true;
  box.innerHTML = SERVICE_HTML;
  $('sign-remote').parentNode.insertBefore(box, $('sign-remote').nextSibling);
}

// Called by edit.js whenever an installer is opened.
export function paintSign(kind, programName) {
  // Signing uses WebCrypto where the page has it and plain JavaScript where
  // it doesn't (plain http:// pages, old browsers; src/web_client/lib/cryptox.js). Only the
  // random numbers must come from the browser.
  if (!globalThis.crypto || !crypto.getRandomValues) {
    ['sign-exe', 'sign-run', 'sign-zip', 'sign-go'].forEach((id) => { $(id).hidden = true; });
    status('Signing needs a browser with crypto.getRandomValues (any from 2014 on).', true);
    return;
  }
  $('sign-exe').hidden = kind !== 'exe';
  $('sign-run').hidden = kind !== 'run';
  $('sign-zip').hidden = kind !== 'zip';
  $('sign-go').hidden = kind === 'zip';
  $('sign-go').textContent = signGoText();
  if (programName && !$('sign-name').value) $('sign-name').value = programName;
  cancelRemote();
  cancelServicePaste();
  status('');
}

// build: async () => {out (Uint8Array), name}; download(bytes, name, type).
export function mountSign({ build, download, kind }) {
  opts = { build, download, kind };
  buildServicePanel();
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
    const svc = $('sign-src-service').checked;
    $('sign-pfx').hidden = rem || svc;
    $('sign-remote').hidden = !rem;
    $('sign-service').hidden = !svc;
    cancelRemote();
    cancelServicePaste();
    $('sign-go').textContent = signGoText();
  }));
  $('svc-name').addEventListener('change', () => { forgetCreds(); paintService(); });
  $('svc-finish').addEventListener('click', finishServicePaste);
  $('svc-cancel').addEventListener('click', () => cancelServicePaste());
  // A relayed provider needs a build server, so the list changes with it.
  paintServiceList();
  window.addEventListener('ti-api-change', paintServiceList);
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
    if (pgpKey) download(new TextEncoder().encode(pgp.publicKeyArmored(pgpKey)), fileSafe(pgpKey.userId) + '.pub.asc');
  });
  $('pgp-sec-dl').addEventListener('click', async () => {
    if (!pgpKey) return;
    const pass = $('pgp-sec-pass').value;
    try {
      download(new TextEncoder().encode(await pgp.secretKeyArmored(pgpKey, pass)), fileSafe(pgpKey.userId) + '.secret.asc');
      $('pgp-sec-pass').value = '';
      setText('pgp-status', $('pgp-status').textContent.split('\nSave')[0] + '\nSecret key saved' + (pass ? ', protected with your passphrase.' : ' WITHOUT a passphrase: keep that file safe.'));
    } catch (e) { setText('pgp-status', errorText(e), true); }
  });
  $('sign-go').addEventListener('click', signClicked);
  // Belt and braces: drop keys and credentials when the page is hidden for good.
  window.addEventListener('pagehide', () => { pfxKey = null; pgpKey = null; remote = null; svcState = null; forgetCreds(); });
}

