// The Trust page's live half: what this copy of the page is actually
// carrying, checked as it loads.
//
// The point of doing it live rather than describing it: a page about
// what can be proved should prove what it can, here, in front of the
// reader. If a document in this file does not verify, this page says so
// -- it does not quietly print the reassuring version.
import { mountApiFooter, apiReady } from './api.js';
import { mountCopyButtons } from './copy.js';
import { verifyDoc, docField } from '../shared/signeddoc.js';
import { normaliseDoc, rootFor } from '../shared/rtscript.js';
import { verify as ed25519Verify } from './lib/ed25519.js';
import { sha256 } from './lib/sha.js';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (b) => Array.from(b).map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');

function b64bytes(t) {
  const bin = atob(String(t).replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

function blockText(id) {
  const n = document.getElementById(id);
  const t = n && !n.dataset.placeholder ? n.textContent : '';
  return t ? normaliseDoc(t) : '';
}

function blockJSON(id) {
  const n = document.getElementById(id);
  try { return n ? JSON.parse(n.textContent) : null; } catch (e) { return null; }
}

function pubKey() {
  const n = document.getElementById('ti-plan-pubkey');
  if (!n || !n.textContent.trim()) return null;
  try { return b64bytes(n.textContent); } catch (e) { return null; }
}

function rows(dl, list) {
  dl.innerHTML = '';
  for (const [k, v] of list) {
    if (!k) continue;
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.innerHTML = v;
    dl.append(dt, dd);
  }
}

const yes = (s) => '<strong>' + s + '</strong>';
const no = (s) => '<strong class="bad-text">' + s + '</strong>';

function paint() {
  const pub = pubKey();
  const out = [];

  // The runtime instructions, and how many of them are covered.
  const roots = blockText('ti-rtroots');
  if (!roots) {
    out.push(['Runtime instructions', no('none carried') + ' -- installers from this page cannot show what they install came from us']);
  } else if (!verifyDoc(roots, 'ti-rtscripts', pub, b64bytes, ed25519Verify)) {
    out.push(['Runtime instructions', no('carried, but the signature does not check out')]);
  } else {
    let n = 0, total = 0;
    for (const raw of roots.split('\n')) {
      const f = raw.split('\t');
      if (f[0] === 'root') { n++; total += Number(f[3]) || 0; }
    }
    out.push(['Runtime instructions', yes('signed and checked') + ' -- ' + total.toLocaleString() +
      ' sets of instructions across ' + n + ' languages, published ' + esc(docField(roots, 'issued'))]);
  }

  // The withdrawn list.
  const rev = blockText('ti-revocations-signed');
  if (!rev) {
    out.push(['Withdrawn files', 'none carried']);
  } else if (!verifyDoc(rev, 'ti-revocations', pub, b64bytes, ed25519Verify)) {
    out.push(['Withdrawn files', no('the list does not check out') + ' -- it is ignored']);
  } else {
    const n = rev.split('\n').filter((l) => l.indexOf('revoke\t') === 0).length;
    out.push(['Withdrawn files', yes('signed and checked') + ' -- ' +
      (n ? n + ' withdrawn' : 'nothing withdrawn') + ', as of ' + esc(docField(rev, 'issued'))]);
  }

  // The catalogue this page carries.
  const att = blockText('ti-catalog-attest');
  if (!att) {
    out.push(['The runtime list', 'carried, with no dated statement about it']);
  } else if (!verifyDoc(att, 'ti-catalog-attest', pub, b64bytes, ed25519Verify)) {
    out.push(['The runtime list', no('the statement about it does not check out')]);
  } else {
    out.push(['The runtime list', yes('signed and checked') + ' -- published ' +
      esc(docField(att, 'issued')) + '<br><span class="small muted">fingerprint <code>' +
      esc(docField(att, 'sha256').slice(0, 32)) + '...</code></span>']);
  }

  // Where this copy sits in the record of what we have published.
  const led = blockJSON('ti-ledger');
  const off = blockJSON('ti-offline') || {};
  if (led && led.seq > 0) {
    out.push(['Our published record', 'this copy was built when we had published ' + led.seq +
      ' version' + (led.seq === 1 ? '' : 's') + '<br><span class="small muted">fingerprint <code>' +
      esc(String(led.root).slice(0, 32)) + '...</code> -- a copy of this page held by anyone else ' +
      'can be checked against ours, and disagreeing is the point</span>']);
  }
  out.push(['This page', 'built ' + esc(String(off.built || 'unknown')) +
    (off.rev ? ' from <code>' + esc(String(off.rev)) + '</code>' : '')]);
  rows(el('trust-carried'), out);

  // The key. One, public, and already inside every installer built here.
  const keys = [];
  if (!pub) {
    keys.push(['Signing key', no('this copy carries no key') + ' -- nothing in it can be checked']);
  } else {
    const id = hex(sha256(pub)).slice(0, 16);
    const b64 = document.getElementById('ti-plan-pubkey').textContent.trim();
    keys.push(['TiddlyInstall signing key', 'used for everything above: the runtime instructions, ' +
      'the withdrawn list, the runtime list and our published record']);
    keys.push(['Fingerprint', '<code>' + esc(id) + '</code><button type="button" class="copy-btn" data-copy="' + esc(id) + '">Copy</button>']);
    keys.push(['Public key', '<code class="wrap">' + esc(b64) + '</code><button type="button" class="copy-btn" data-copy="' + esc(b64) + '">Copy</button>' +
      '<br><span class="small muted">Ed25519. Public, and already inside every installer this page builds -- ' +
      'this only makes it readable. Compare it with the one shown by a copy of this page you already trust.</span>']);
    const pythonRoot = roots ? rootFor(roots, 'python') : '';
    if (pythonRoot) {
      keys.push(['Example: Python', 'the instructions for every Python we publish come down to one ' +
        'fingerprint, signed by the key above<br><code class="wrap">' + esc(pythonRoot) + '</code>']);
    }
  }
  rows(el('trust-keys'), keys);
  mountCopyButtons(document);
}

mountApiFooter();
apiReady();
paint();
