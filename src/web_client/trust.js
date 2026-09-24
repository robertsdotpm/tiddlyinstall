// The Trust page's live half: what this copy of the page is actually
// carrying, checked as it loads.
//
// Doing it live rather than describing it is the point. A page about
// what can be proved should prove what it can, in front of the reader.
// If a document in this file does not verify, this page says so and says
// it is not used -- it does not print the reassuring version anyway.
//
// With scripting off, nothing here has run, so the markup ships with a
// notice saying exactly that and this replaces it. The rest of the page
// is static and reads either way.
import { mountApiFooter, apiReady } from './api.js';
import { mountCopyButtons } from './copy.js';
import { verifyDoc, docField } from '../shared/signeddoc.js';
import { normaliseDoc, rootFor } from '../shared/rtscript.js';
import { verify as ed25519Verify } from './lib/ed25519.js';
import { sha256 } from './lib/sha.js';
import { readStored as readRefreshed } from './catalog-refresh.js';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (b) => Array.from(b).map((x) => (x < 16 ? '0' : '') + x.toString(16)).join('');

function b64bytes(t) {
  const bin = atob(String(t).replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// data_block wraps its contents in newlines and textContent keeps them,
// so the signed bytes would not begin where the signature says.
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

/* ---------- one row of "what this copy carries" ---------- */

// The styles are inline to match the rest of this page, which is laid
// out that way by design rather than through the site's classes.
const ROW = 'display:flex; flex-wrap:wrap; align-items:baseline; padding:10px 0; border-bottom:1px solid var(--rule);';
const ROW_FAIL = ROW + ' background:var(--fail-soft); margin:0 -10px; padding-left:10px; padding-right:10px;';
const K = 'flex:0 0 190px; color:var(--text-loud); font-weight:600;';
const V = 'flex:1 1 260px; min-width:0;';
const BADGE = 'font-family:var(--mono); font-size:11.5px; font-weight:600; letter-spacing:0.06em; margin-right:8px;';
const DOT = 'display:inline-block; width:8px; height:8px; margin-right:6px;';
const MONO = 'font-family:var(--mono); font-size:13px;';
const CODE = 'font-family:var(--mono); font-size:13px; background:var(--code-bg); padding:1px 5px; border-radius:2px; word-break:break-all;';

const mono = (t) => '<span style="' + MONO + '">' + esc(t) + '</span>';
const code = (t) => '<code style="' + CODE + '">' + esc(t) + '</code>';

// Filled square when it checks out, hollow when it does not: the two
// states differ by shape as well as by colour.
function badge(ok) {
  const colour = ok ? 'var(--ok)' : 'var(--fail)';
  const dot = DOT + (ok ? ' background:' + colour + ';' : ' border:1.5px solid ' + colour + ';');
  return '<span style="' + BADGE + ' color:' + colour + ';">' +
    '<span aria-hidden="true" style="' + dot + '"></span>' +
    (ok ? 'CHECKED' : 'DOES NOT CHECK OUT') + '</span>';
}

// `state` is true (checked), false (does not check out), or null for a
// row that is a fact rather than a check and so carries no badge.
function row(into, label, state, detail) {
  const d = document.createElement('div');
  d.setAttribute('style', state === false ? ROW_FAIL : ROW);
  d.innerHTML = '<strong style="' + K + '">' + esc(label) + '</strong><span style="' + V + '">' +
    (state === null ? '' : badge(state)) + detail + '</span>';
  into.appendChild(d);
}

// "2026-09-23T05:00:34Z" -> "2026-09-23 05:00 UTC": the seconds are
// noise at this scale, and the zone should be said rather than implied.
function when(iso) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(iso));
  return m ? m[1] + ' ' + m[2] + ' UTC' : String(iso || '');
}

// Which paint is the current one. paint() became async on 2026-09-23 (it
// has to ask IndexedDB whether the catalogue was refreshed) and is also
// run again when the catalogue changes. Two of them overlap: the one at
// the bottom of this file, and the one the overlay's load event triggers.
// Both used to empty the table and then, after their await, append to it
// -- so every row appeared twice. Emptying after the await is not enough
// on its own; the later paint has to be able to say it has been
// superseded, or a slow one can still finish on top of a fast one.
let painting = 0;

async function paint() {
  const live = el('trust-live');
  const into = el('trust-carried');
  if (!live || !into) return;
  const mine = ++painting;
  const pub = pubKey();

  // Whether this copy is building from a catalogue fetched since it was
  // made. Kept in IndexedDB, so it has to be asked for; a browser that
  // will not answer means there is none, which is the ordinary case.
  let refreshed = null;
  try { refreshed = await readRefreshed(); } catch (e) { refreshed = null; }
  if (mine !== painting) return;          // a newer paint started while we waited
  into.innerHTML = '';

  if (pub) {
    el('trust-fp').textContent = hex(sha256(pub)).slice(0, 16);
    el('trust-pk').textContent = document.getElementById('ti-plan-pubkey').textContent.trim();
  }

  const roots = blockText('ti-rtroots');
  if (!roots) {
    row(into, 'Runtime setups', null, 'None carried, so installers from this page cannot show that what they install came from us.');
  } else if (!verifyDoc(roots, 'ti-rtscripts', pub, b64bytes, ed25519Verify)) {
    row(into, 'Runtime setups', false, 'They are ignored, exactly as if they were not here.');
  } else {
    let n = 0, total = 0;
    for (const raw of roots.split('\n')) {
      const f = raw.split('\t');
      if (f[0] === 'root') { n++; total += Number(f[3]) || 0; }
    }
    row(into, 'Runtime setups', true, total.toLocaleString() + ' sets across ' + n +
      ' languages. Published ' + mono(when(docField(roots, 'issued'))) + '.');
  }

  const rev = blockText('ti-revocations-signed');
  if (!rev) {
    row(into, 'Withdrawn files', null, 'No list carried.');
  } else if (!verifyDoc(rev, 'ti-revocations', pub, b64bytes, ed25519Verify)) {
    row(into, 'Withdrawn files', false, 'The list is ignored, exactly as if it were not here.');
  } else {
    const n = rev.split('\n').filter((l) => l.indexOf('revoke\t') === 0).length;
    row(into, 'Withdrawn files', true, (n ? n + ' withdrawn' : 'Nothing withdrawn') +
      ', as of ' + mono(when(docField(rev, 'issued'))) + '.');
  }

  // The runtime list can be replaced after the page was built: the
  // Registry page can fetch the current one from a build server
  // (src/web_client/catalog-refresh.js). When it has been, saying only
  // what the statement baked in says would be describing a catalogue this
  // page is no longer using -- true of the file, wrong about the reader's
  // situation, which is the worst kind of wrong for a page like this.
  const att = blockText('ti-catalog-attest');
  if (refreshed) {
    row(into, 'The runtime list', true, 'Not the one built into this page: fetched from ' +
      code(refreshed.backend) + ' on ' + mono(String(refreshed.at).slice(0, 10)) +
      ' and checked against the key above before it was used. Fingerprint ' +
      code(String(refreshed.sha256).slice(0, 32)));
    if (att && verifyDoc(att, 'ti-catalog-attest', pub, b64bytes, ed25519Verify)) {
      row(into, '...the one built in', null, 'Still in this file, unused. Published ' +
        mono(when(docField(att, 'issued'))) + '. Fingerprint ' + code(docField(att, 'sha256').slice(0, 32)));
    }
  } else if (!att) {
    row(into, 'The runtime list', null, 'Carried, with no dated statement about it.');
  } else if (!verifyDoc(att, 'ti-catalog-attest', pub, b64bytes, ed25519Verify)) {
    row(into, 'The runtime list', false, 'The statement about it does not hold.');
  } else {
    row(into, 'The runtime list', true, 'Published ' + mono(when(docField(att, 'issued'))) +
      '. Fingerprint ' + code(docField(att, 'sha256').slice(0, 32)));
  }

  const python = roots ? rootFor(roots, 'python') : '';
  if (python) {
    row(into, 'Example: Python', null, 'Every Python we publish comes down to one fingerprint, ' +
      'signed by the key above. ' + code(python));
  }

  const led = blockJSON('ti-ledger');
  if (led && led.seq > 0) {
    row(into, 'Our published record', null, 'This copy was built when we had published ' + led.seq +
      ' version' + (led.seq === 1 ? '' : 's') + '. Fingerprint ' + code(String(led.root).slice(0, 32)));
  }

  const off = blockJSON('ti-offline') || {};
  row(into, 'This page', null, 'Built ' + mono(String(off.built || 'unknown')) +
    (off.rev ? ' from ' + code(String(off.rev)) : ''));

  // Only now: the checks have run, so the notice saying they have not is
  // no longer true.
  const nojs = el('trust-nojs');
  if (nojs) nojs.hidden = true;
  live.hidden = false;

  // The copy buttons take their text from the page, since the key is not
  // known until it has been read out of it.
  const btns = document.querySelectorAll('.trust-copy');
  for (let i = 0; i < btns.length; i++) {
    const from = document.getElementById(btns[i].getAttribute('data-copy-from'));
    if (from) btns[i].setAttribute('data-copy', from.textContent);
  }
  mountCopyButtons(document);
}

mountApiFooter();
apiReady();
// Painted again when the catalogue is swapped (src/web_client/overlay.js
// emits this), because the Registry page can replace it while this page
// is open: a tab left on Trust would otherwise go on describing the
// catalogue that was in use when it loaded.
window.addEventListener('ti-overlay-change', () => { paint().catch(() => {}); });
paint().catch((e) => {
  const n = el('trust-nojs');
  if (n) n.textContent = 'These checks could not be run in this browser (' + (e && e.message ? e.message : e) + ').';
});
