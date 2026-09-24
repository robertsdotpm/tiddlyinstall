// Replacing the catalogue built into this page with the one a build
// server is serving now.
//
// Why this exists: the catalogue is baked in at build time
// (tools/build_site.py), so a copy saved to disk in March still offers
// March's runtime releases in September. Nothing is wrong with it -- the
// installers it builds work -- but it cannot install anything published
// since. Refreshing is how a saved copy catches up without being
// downloaded again.
//
// What makes it safe to do over the network: the catalogue is one file,
// catalog.gz, and tools/sign_runtime_scripts.mjs signs a short document
// naming that file's SHA-256 (kind ti-catalog-attest). Both are served:
//
//   GET /api/catalog/attest    the signed statement
//   GET /api/catalog/archive   the bytes it is about
//
// So the page checks the statement against the key it was built with, and
// the bytes against the statement. A server that hands back something
// else -- or a proxy that rewrites it on the way -- fails one of those two
// checks, and nothing is stored. The connection is never trusted; only
// the key is. That is the same check the Verify page makes about a plan,
// against the same key, which is why refreshing does not widen what this
// page is willing to believe.
//
// It works from a file:// page. A saved copy has an opaque origin, and
// every route on the build server answers with
// `Access-Control-Allow-Origin: *` and uses no cookies, so a cross-origin
// GET is allowed. The one thing that cannot work is an https page calling
// an http server: the browser blocks it as mixed content, and the error
// says so rather than leaving it to look like the server is down.
import { loadSnapshot, splitSnapshot, loadAllRuntimes, runtimesSummary } from '../shared/resolve.js';
import { docSignature, docField } from '../shared/signeddoc.js';
import { sha256 } from './lib/sha.js';
import { verify as ed25519Verify } from './lib/ed25519.js';

const KEY = 'ti-catalog-refresh';
const IDB_NAME = 'tiddlyinstall';
const ATTEST_KIND = 'ti-catalog-attest';
// A catalogue is a couple of megabytes; a page that asked for one and got
// a video file should say so rather than spend a minute on it.
const MAX_ARCHIVE = 64 * 1024 * 1024;

const hex = (u8) => Array.prototype.map.call(u8, (b) => ('0' + b.toString(16)).slice(-2)).join('');

function b64bytes(s) {
  const bin = atob(String(s).trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// The key tools/build_site.py baked in, the same one verify.js checks
// plans against. Without it this page cannot check anything it is handed,
// and refreshing is refused rather than done on trust.
function bakedKey() {
  const n = typeof document !== 'undefined' && document.getElementById('ti-plan-pubkey');
  if (!n || !n.textContent.trim()) return null;
  try { return b64bytes(n.textContent); } catch (e) { return null; }
}

export const keyId = (pub) => hex(sha256(pub)).slice(0, 16);
export function haveKey() { return bakedKey() != null; }
export function bakedKeyId() { const k = bakedKey(); return k ? keyId(k) : ''; }

export class RefreshError extends Error {
  constructor(msg, detail) { super(msg); this.detail = detail || ''; }
}

/* ---------- storage ---------- */

// The same database the overlay uses, a different key. IndexedDB rather
// than localStorage because this is megabytes, not kilobytes.
function idb(mode, f) {
  return new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(IDB_NAME, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
    };
    req.onerror = () => rej(req.error);
    req.onsuccess = () => {
      const db = req.result;
      try {
        const tx = db.transaction('kv', mode);
        const r = f(tx.objectStore('kv'));
        tx.oncomplete = () => { db.close(); res(r && r.result); };
        tx.onerror = () => { db.close(); rej(tx.error); };
      } catch (e) { db.close(); rej(e); }
    };
  });
}

// What is kept: the archive the signed statement is about, that archive
// taken apart for use, and the statement itself. Both halves are needed.
// Another page on the same origin can write to this database -- they
// share one in Chrome -- so nothing that comes back is ours until it has
// been proved, and a digest this page wrote beside the data would be
// forgeable by the same writer that replaced the data. The only anchor
// is the sha256 inside the signed statement, over the archive; so the
// signature is checked, the archive is checked against it, and the split
// catalogue is re-derived from the archive rather than trusted.
export async function readStored() {
  let rec;
  try { rec = await idb('readonly', (s) => s.get(KEY)); } catch (e) { return null; }
  if (!rec || rec.v !== 1) return null;
  const key = bakedKey();
  // The signature is re-checked on the way out of storage. Another page on
  // the same origin can write to this database (they share one in Chrome),
  // so what comes back is treated as something handed to us, not as ours.
  const s = docSignature(String(rec.attest || ''), ATTEST_KIND, b64bytes);
  let ok = false;
  if (key && s.signed) { try { ok = ed25519Verify(key, s.bytes, s.sig); } catch (e) { ok = false; } }
  if (!ok) { await clearStored(); return null; }

  // A verified statement about an archive says nothing about an index
  // somebody else wrote next to it. block()/blockBytes() serve these
  // bytes to every build, so a forged index chooses both the URL a file
  // comes from and the sha256 it is checked against.
  const want = String(docField(String(rec.attest || ''), 'sha256') || '').toLowerCase();
  let raw = rec.raw;
  if (raw instanceof ArrayBuffer) raw = new Uint8Array(raw);
  if (!/^[0-9a-f]{64}$/.test(want) || !(raw instanceof Uint8Array) || hex(sha256(raw)) !== want) {
    await clearStored();
    return null;
  }
  try {
    const cat = await loadSnapshot(raw);
    await loadAllRuntimes(cat);
    const summary = runtimesSummary(cat);
    const { index, chunks } = await splitSnapshot(cat);
    index.summary = summary;
    const folders = {};
    for (const c of chunks) folders[c.folder] = c.bytes;
    rec.raw = raw;
    rec.index = index;
    rec.folders = folders;
    rec.sha256 = want;
  } catch (e) {
    await clearStored();
    return null;
  }
  return rec;
}

export async function writeStored(rec) {
  await idb('readwrite', (s) => s.put(rec, KEY));
}

export async function clearStored() {
  try { await idb('readwrite', (s) => s.delete(KEY)); } catch (e) { /* nothing there */ }
}

/* ---------- fetching ---------- */

function joinUrl(base, path) { return String(base).replace(/\/+$/, '') + path; }

// A fetch that explains itself. The interesting failure is an https page
// asking for an http server: fetch rejects with the same TypeError it
// uses for a server that is simply not there, and the difference matters
// to whoever is reading the message.
async function get(url, what, accept) {
  const mixed = typeof location !== 'undefined' && location.protocol === 'https:' && /^http:\/\//i.test(url);
  if (mixed) {
    throw new RefreshError('This page was loaded over https, so the browser will not let it fetch ' + what + ' from an http address.',
      'Use the https address of the server, or open a copy of this page from a file instead.');
  }
  let r;
  try {
    r = await fetch(url, { method: 'GET', headers: accept ? { Accept: accept } : undefined, credentials: 'omit', redirect: 'follow' });
  } catch (e) {
    throw new RefreshError('Could not reach ' + url + ' to fetch ' + what + '.',
      'The server may be down or the address wrong. ' + (e && e.message ? e.message : String(e)));
  }
  if (r.status === 404) {
    throw new RefreshError('That server has no catalogue to hand out.',
      'It answered 404 for ' + url + '. A build server only serves one when it was deployed with it.');
  }
  if (!r.ok) throw new RefreshError('The server answered ' + r.status + ' for ' + what + '.', url);
  return r;
}

// Fetches the catalogue a server is serving, checks it against the key
// this page carries, and returns it split the way the page bakes it.
// Nothing is stored here: the caller decides, after the person has been
// told what it will replace.
export async function fetchCatalog(backend, onStep) {
  const step = typeof onStep === 'function' ? onStep : () => {};
  const key = bakedKey();
  if (!key) {
    throw new RefreshError('This page was built without the TiddlyInstall key, so it cannot check a catalogue it is handed.',
      'Refreshing is refused rather than done on trust.');
  }

  step('Asking ' + backend + ' what it is serving…');
  const attest = (await (await get(joinUrl(backend, '/api/catalog/attest'), 'the signed statement', 'text/plain')).text());

  const s = docSignature(attest, ATTEST_KIND, b64bytes);
  if (!s.signed) {
    throw new RefreshError('The statement that server sent is not signed.', s.why || '');
  }
  let sigOk = false;
  try { sigOk = ed25519Verify(key, s.bytes, s.sig); } catch (e) { sigOk = false; }
  if (!sigOk) {
    throw new RefreshError('The statement that server sent is signed by a different key.',
      'It does not check out against ' + keyId(key) + ', the key this page carries. Nothing has been changed.');
  }

  const want = String(docField(attest, 'sha256') || '').toLowerCase();
  const said = Number(docField(attest, 'bytes'));
  const issued = String(docField(attest, 'issued') || '');
  if (!/^[0-9a-f]{64}$/.test(want)) throw new RefreshError('That server\'s statement names no catalogue.', 'It carries no usable sha256 line.');
  if (Number.isFinite(said) && said > MAX_ARCHIVE) {
    throw new RefreshError('That server\'s catalogue is ' + Math.round(said / (1024 * 1024)) + ' MB, which is more than this page will load.', '');
  }

  step('Fetching the catalogue…');
  const r = await get(joinUrl(backend, '/api/catalog/archive'), 'the catalogue', 'application/gzip');
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > MAX_ARCHIVE) throw new RefreshError('That server sent more than this page will load.', buf.length + ' bytes.');

  step('Checking it against the signed statement…');
  const got = hex(sha256(buf));
  if (got !== want) {
    throw new RefreshError('The catalogue that server sent is not the one it signed.',
      'The statement is for ' + want.slice(0, 16) + ' and the file is ' + got.slice(0, 16) + '. Nothing has been changed.');
  }
  if (Number.isFinite(said) && said > 0 && said !== buf.length) {
    throw new RefreshError('The catalogue that server sent is the wrong length.',
      'The statement says ' + said + ' bytes and the file is ' + buf.length + '.');
  }

  // From here on the bytes are proved, and everything else is worked out
  // from them by this page: the summary is not taken from the server,
  // so nothing on display comes from outside what was just checked.
  step('Reading the catalogue…');
  let cat;
  try { cat = await loadSnapshot(buf); } catch (e) {
    throw new RefreshError('That catalogue is signed but could not be read.', e && e.message ? e.message : String(e));
  }
  step('Working out what it offers…');
  await loadAllRuntimes(cat);
  const summary = runtimesSummary(cat);
  const { index, chunks } = await splitSnapshot(cat);
  index.summary = summary;

  const folders = {};
  for (const c of chunks) folders[c.folder] = c.bytes;
  return {
    v: 1,
    backend: String(backend),
    at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    issued,
    sha256: want,
    bytes: buf.length,
    // Kept so the catalogue can be bound to the signature again on the
    // way out of storage. These bytes are the ones the statement names
    // and they were hash-checked above, so they are the only thing in
    // this record that another writer cannot forge past.
    raw: buf,
    attest,
    keyId: keyId(key),
    index,
    folders,
    releases: Object.keys(index.folders).reduce((a, f) => a + (Number(index.folders[f].releases) || 0), 0),
  };
}
