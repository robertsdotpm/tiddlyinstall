// The Verify page: read an installer without running it.
//
// Why this page exists. Until now the only way to see what an installer
// would do was to execute it and read the screen it chose to show you --
// which asks you to run an untrusted program in order to decide whether
// to run it. Everything here is read from the file with the page's own
// parsers, and nothing is executed.
//
// Why there is no verdict. There is no tick, no "verified", no score,
// and there will not be one. docs/design.md ("What we sign, and the
// words for it") is built on keeping two statements apart -- who made
// the installer program, and what the installer installs -- and a single
// green mark adds them together into "this is safe", which is the one
// reading the whole project is written to prevent. Every row states a
// fact. The judgement is the reader's.
//
// Offline it can say what is in the file. With a build server it can
// also say the things that decay after the file was written: whether
// these settings were ever published, whether the plan is still the one
// the resolver produces, and whether it has been revoked since. Those
// cannot live in the file, which is exactly why they need a server.
import { readInstaller } from '../shared/tifile.js';
import { apiRequest, apiBase, apiLocal, apiReady, errorText, mountApiFooter } from './api.js';
import { sha256, sha256Stream } from './lib/sha.js';
import { verify as ed25519Verify } from './lib/ed25519.js';
import { mountCopyButtons } from './copy.js';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Above this, hash in pieces: a 400 MB offline installer copied whole
// into one buffer is how a phone tab dies (docs/browser-packing.md).
const STREAM_OVER = 32 * 1024 * 1024;

const hex = (u8) => Array.prototype.map.call(u8, (b) => ('0' + b.toString(16)).slice(-2)).join('');

function b64bytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ---------- the plan, read as lines of tab-separated fields ---------- */

function planLines(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    const f = line.split('\t');
    out.push({ key: f[0], f, val: (i) => f[i + 1] || '' });
  }
  return out;
}

// The signed bytes of a document are everything before its last line,
// which must be `sig<TAB>ed25519<TAB>…` (docs/format.md, "Plan
// signature"). Nothing is normalised: the bytes are checked exactly as
// they are. Plans and the revocation list are signed the same way and
// differ only in the header the signed bytes must start with, which is
// what stops a signature over one being passed off as the other.
function docSignature(text, header) {
  const s = String(text);
  let body = s;
  if (body.endsWith('\n')) body = body.slice(0, -1);
  if (body.endsWith('\r')) body = body.slice(0, -1);
  const cut = body.lastIndexOf('\n');
  const last = cut < 0 ? body : body.slice(cut + 1);
  if (!/^sig\t/.test(last)) return { signed: false, why: 'no sig line' };
  const f = last.split('\t');
  if (f[1] !== 'ed25519') return { signed: false, why: 'signature type "' + f[1] + '" is not ed25519' };
  const signed = s.slice(0, cut + 1);
  if (!signed.startsWith(header + '\t')) return { signed: false, why: 'the signed bytes do not start with ' + header };
  let sig;
  try { sig = b64bytes(f[2]); } catch (e) { return { signed: false, why: 'the signature is not base64' }; }
  if (sig.length !== 64) return { signed: false, why: 'the signature is ' + sig.length + ' bytes, not 64' };
  return { signed: true, sig, bytes: new TextEncoder().encode(signed) };
}

// The key the engines are built with, embedded by tools/build_site.py so
// this page checks plans against the same key they do. Absent when the
// page was built without one; then a plan can only be checked by asking
// a server for the key, and an offline page says so rather than guessing.
function bakedKey() {
  const n = document.getElementById('ti-plan-pubkey');
  if (!n || !n.textContent.trim()) return null;
  try { return b64bytes(n.textContent); } catch (e) { return null; }
}

const keyId = (pub) => hex(sha256(pub)).slice(0, 16);

/* ---------- rows ---------- */

function rows(dl, list) {
  dl.innerHTML = list.filter(Boolean)
    .map(([k, v]) => '<dt>' + esc(k) + '</dt><dd>' + v + '</dd>').join('');
}

const PLATFORM = { exe: 'Windows', run: 'Linux', zip: 'macOS' };

function hsize(n) {
  if (n < 1024) return n + ' bytes';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ---------- what the plan would do ---------- */

function describe(planText) {
  const lines = planLines(planText);
  const get = (k) => (lines.find((l) => l.key === k) || { val: () => '' }).val(0);
  const files = [];
  const cmds = [];
  let admin = false;
  for (const l of lines) {
    if (l.key === 'file') files.push({ name: l.val(0), file: l.val(1), sha: l.val(2), size: l.val(3), url: '' });
    else if (l.key === 'url' && files.length) files[files.length - 1].url = l.val(0);
    else if (l.key === 'step' && l.val(0) === 'run') cmds.push(l.f.slice(2).join(' '));
    else if (l.key === 'install' && l.val(0)) cmds.push(l.val(0));
    else if (l.key === 'admin' && l.val(0) === '1') admin = true;
  }
  return {
    name: get('name'), project: get('project'), appid: get('appid'), record: get('record'),
    launch: get('launch'), menu: get('menu'), desktop: get('desktop'), root: get('root'),
    files, cmds, admin,
  };
}

/* ---------- the server checks ---------- */

// Each returns a row, and each says what it could not do rather than
// going quiet: a check that silently did not run looks exactly like a
// check that passed, which is the failure this project keeps meeting.
async function serverChecks(info, d, out) {
  const add = (k, v) => out.push([k, v]);
  const base = apiBase();
  add('Build server', '<code>' + esc(base) + '</code>');

  // 1. Are these settings ones the server published? The record's name is
  //    the hash of its exact bytes, so a byte comparison is the whole test.
  if (!d.record) {
    add('These settings', 'the plan names no record, so there is nothing to look up');
  } else {
    try {
      const got = await apiRequest('/api/records/' + encodeURIComponent(d.record), { as: 'text' });
      const mine = info.record == null ? '' : info.record;
      add('These settings', String(got) === mine
        ? 'match the record <code>' + esc(d.record) + '</code> the server holds, byte for byte'
        : '<strong>differ from the record the server holds under that hash.</strong> '
          + 'The settings in this file are not the ones it published');
    } catch (e) {
      const m = errorText(e);
      add('These settings', /404/.test(String(m))
        ? 'the server does not have a record <code>' + esc(d.record) + '</code>. Anyone can write a record, so this only means it was not published there'
        : 'could not be checked: ' + esc(m));
    }
  }

  // 2. Is the embedded plan still the plan? The nonce is echoed into the
  //    signed bytes, so the answer cannot be a replayed capture.
  if (d.record) {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    try {
      const fresh = await apiRequest('/api/plan/' + encodeURIComponent(d.record) + '?nonce=' + nonce, { as: 'text' });
      const sig = docSignature(String(fresh), 'ti-plan');
      const live = sig.signed && String(fresh).indexOf(nonce) >= 0;
      add('The server answering now', live
        ? 'signed a plan carrying the nonce this page just made, so this is a live answer and not a replay'
        : '<strong>did not echo the nonce in a signed plan</strong>, so this answer could be a recording');
      const same = String(fresh).replace(/\r/g, '') === String(info.plan || '').replace(/\r/g, '');
      add('The plan in this file', same
        ? 'is the plan the server gives for that record today'
        : 'is <strong>not</strong> what the server gives today. That happens when the catalogue moved on, and also when a plan was altered; compare the downloads above with a fresh build');
    } catch (e) {
      const m = errorText(e);
      add('The plan in this file', /451/.test(String(m))
        ? '<strong>the record is taken down</strong> on this server'
        : 'could not be compared: ' + esc(m));
    }
  }

  // 3. Revocation: news that postdates the file, so it can only come from
  //    a server. This is the check no saved copy can ever make.
  try {
    const rev = await apiRequest('/api/revocations', { as: 'text' });
    const lines = planLines(rev);
    const meta = (k) => (lines.find((l) => l.key === k) || { val: () => '' }).val(0);
    const revoked = lines.some((l) => l.key === 'revoke' && l.val(0) === 'record' && l.val(1) === d.record);
    // The list is signed with the same key as plans, so it is checked
    // rather than believed: an unsigned "nothing is revoked" is exactly
    // what someone suppressing a revocation would serve.
    const baked = bakedKey();
    const rs = docSignature(rev, 'ti-revocations');
    let sigSays = '';
    if (!rs.signed) sigSays = ' <strong>The list is not signed</strong> (' + esc(rs.why) + '), so it proves nothing.';
    else if (!baked) sigSays = ' The list is signed, but this page has no key to check it with.';
    else {
      let ok = false;
      try { ok = ed25519Verify(baked, rs.bytes, rs.sig); } catch (e) { ok = false; }
      sigSays = ok ? '' : ' <strong>The list\'s own signature does not check out</strong>, so it proves nothing.';
    }
    add('Revocations', (revoked
      ? '<strong>this record is on the revocation list.</strong> It was withdrawn after this file was made'
      : 'not on the list issued ' + esc(meta('issued') || 'recently') + ' (serial ' + esc(meta('serial') || '?') + ')')
      + sigSays);
  } catch (e) {
    add('Revocations', 'could not be fetched: ' + esc(errorText(e)));
  }

  // 4. The signing key, which rotates. A plan signed by a retired key
  //    verifies against a stale baked copy and means nothing.
  try {
    const pk = await apiRequest('/api/pubkey');
    const serverKey = pk && pk.key;
    const baked = bakedKey();
    if (serverKey && baked) {
      const same = hex(b64bytes(serverKey)) === hex(baked);
      add('Signing key', same
        ? 'the key this page checks with is the one the server signs with (<code>' + esc(keyId(baked)) + '</code>)'
        : '<strong>the server signs with a different key</strong> (<code>' + esc(keyId(b64bytes(serverKey)))
          + '</code>) than this page checks with (<code>' + esc(keyId(baked)) + '</code>). The key was rotated');
    } else if (serverKey) {
      add('Signing key', 'the server signs with <code>' + esc(keyId(b64bytes(serverKey))) + '</code>; this page has no key of its own to compare');
    }
  } catch (e) {
    add('Signing key', 'could not be fetched: ' + esc(errorText(e)));
  }
}

/* ---------- reading one file ---------- */

async function hashFile(file) {
  if (file.size <= STREAM_OVER) return hex(sha256(new Uint8Array(await file.arrayBuffer())));
  const h = sha256Stream();
  const CHUNK = 8 * 1024 * 1024;
  for (let o = 0; o < file.size; o += CHUNK) {
    h.update(new Uint8Array(await file.slice(o, Math.min(o + CHUNK, file.size)).arrayBuffer()));
  }
  return hex(h.digest());
}

async function open(file) {
  el('v-error').hidden = true;
  el('v-out').hidden = true;
  el('v-busy').hidden = false;
  try {
    const sha = await hashFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const info = await readInstaller(bytes, file.name);
    paint(file, sha, info);
  } catch (e) {
    el('v-error').textContent = 'Could not read ' + file.name + ': ' + errorText(e);
    el('v-error').hidden = false;
  } finally {
    el('v-busy').hidden = true;
  }
}

function paint(file, sha, info) {
  const d = info.plan ? describe(info.plan) : null;

  rows(el('v-file-facts'), [
    ['Name', '<code>' + esc(file.name) + '</code>'],
    ['Kind', esc(PLATFORM[info.kind] || info.kind) + ' installer (<code>.' + esc(info.kind) + '</code>)'],
    ['Size', esc(hsize(file.size))],
    ['SHA-256', '<code>' + esc(sha) + '</code><button type="button" class="copy-btn" data-copy="' + esc(sha) + '">Copy</button>'],
    ['Settings', info.record ? 'carried in the file' : 'none in the file'],
    ['Plan', info.plan ? 'carried in the file' : 'none; it would fetch one when it ran'],
    info.pack && info.pack.length ? ['Packed files', info.pack.length + ' file' + (info.pack.length === 1 ? '' : 's') + ' inside, so it can install with no internet'] : null,
  ]);

  el('v-plan-none').hidden = !!d;
  if (d) {
    rows(el('v-does'), [
      ['Installs', esc(d.name || d.project || 'an app')],
      ['Into', esc(d.root === 'machine' ? 'a folder for the whole machine' : "a folder of its own in the user's home")],
      ['Admin rights', d.admin ? '<strong>yes</strong>' : 'not needed'],
      ['Downloads', d.files.length ? d.files.length + ' file' + (d.files.length === 1 ? '' : 's') : 'nothing'],
      ['Runs', d.cmds.length ? d.cmds.length + ' command' + (d.cmds.length === 1 ? '' : 's') + ' on the machine' : 'no commands'],
      ['Shortcuts', [d.menu === '1' ? 'app menu' : null, d.desktop === '1' ? 'desktop' : null].filter(Boolean).join(', ') || 'none'],
      d.launch ? ['Starts', '<code>' + esc(d.launch) + '</code>'] : null,
    ]);
    const tb = el('v-downloads').querySelector('tbody');
    tb.innerHTML = d.files.map((f) => {
      let host = '';
      try { host = f.url ? new URL(f.url).host : ''; } catch (e) { host = f.url; }
      return '<tr><td><code>' + esc(f.file || f.name) + '</code></td><td>' + esc(host || 'not given')
        + '</td><td><code class="small">' + esc((f.sha || '').slice(0, 16)) + '&hellip;</code></td></tr>';
    }).join('');
    el('v-downloads-wrap').hidden = !d.files.length;
    el('v-cmds').innerHTML = d.cmds.map((c) => '<li><code>' + esc(c) + '</code></li>').join('');
    el('v-cmds-wrap').hidden = !d.cmds.length;
  } else {
    el('v-downloads-wrap').hidden = true;
    el('v-cmds-wrap').hidden = true;
    el('v-does').innerHTML = '';
  }

  // Signing, kept in two separate sentences on purpose.
  const sign = [];
  if (info.kind === 'exe') {
    sign.push(['The installer file', info.signed
      ? 'carries an Authenticode signature. Windows checks who it names; this page does not open the certificate'
      : 'is not signed. Windows will warn about it']);
  } else if (info.kind === 'run') {
    sign.push(['The installer file', 'carries no signature, because Linux checks none when it runs a <code>.run</code>. '
      + 'The SHA-256 above is the comparison that works']);
  } else {
    sign.push(['The installer file', 'is a macOS <code>.zip</code>; the app inside is checked by Gatekeeper when it is opened, not by this page']);
  }
  if (!info.plan) {
    sign.push(['The plan', 'there is none in the file to check']);
  } else {
    const s = docSignature(info.plan, 'ti-plan');
    const baked = bakedKey();
    if (!s.signed) {
      sign.push(['The plan', 'is <strong>not signed</strong> (' + esc(s.why) + '). It is only as trustworthy as this file']);
    } else if (!baked) {
      sign.push(['The plan', 'is signed, but this page carries no key to check it against. Set a build server and it can be checked']);
    } else {
      let ok = false;
      try { ok = ed25519Verify(baked, s.bytes, s.sig); } catch (e) { ok = false; }
      sign.push(['The plan', ok
        ? 'is signed by the TiddlyInstall key <code>' + esc(keyId(baked)) + '</code>, and the signature checks out'
        : '<strong>has a signature that does not check out</strong> against key <code>' + esc(keyId(baked)) + '</code>']);
    }
  }
  rows(el('v-signing'), sign);

  el('v-out').hidden = false;

  // The server half, which fills in after the offline half is on screen.
  const dl = el('v-server');
  dl.innerHTML = '';
  const none = apiLocal() || !apiBase();
  el('v-server-none').hidden = !none;
  if (none || !d) return;
  const out = [];
  serverChecks(info, d, out).then(() => rows(dl, out), (e) => rows(dl, [['Checks', 'could not run: ' + esc(errorText(e))]]));
}

/* ---------- wiring ---------- */

mountApiFooter();
mountCopyButtons();
apiReady();

el('v-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) open(f);
});
const drop = el('v-drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('dragging')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) open(f);
});
