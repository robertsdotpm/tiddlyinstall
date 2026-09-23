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
// Offline it can say what is in the file. With a server it can
// also say the things that decay after the file was written: whether
// these settings were ever published, whether the plan is still the one
// the resolver produces, and whether it has been revoked since. Those
// cannot live in the file, which is exactly why they need a server.
import { readInstaller, parseKv, kvGet, recordHash } from '../shared/tifile.js';
import { resolve, loadRuntimes, packagePolicyFor, packageProject } from '../shared/resolve.js';
import { parseReleases, checkChain, rootAt } from '../shared/ledger.js';
import { canonicalTarget, targetBlocks, rootFor, normaliseDoc } from '../shared/rtscript.js';
import { leafHash, rootFromProof } from '../shared/merkle.js';
import { effectiveCatalog, hasCatalog } from './overlay.js';
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

// The catalogue's label for a runtime id, so the page says "Python 3"
// rather than "python". Falls back to the id, which is still readable.
const RUNTIME_NAME = { python: 'Python 3', python2: 'Python 2', node: 'Node.js', ruby: 'Ruby', php: 'PHP',
  java: 'Java', dotnet: '.NET', r: 'R', cc: 'C/C++', go: 'Go', rust: 'Rust', zig: 'Zig', nim: 'Nim',
  none: 'no runtime' };
const runtimeName = (id) => RUNTIME_NAME[id] || id;

function hsize(n) {
  if (n < 1024) return n + ' bytes';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/* ---------- what the plan would do ---------- */

// A plan is a header and then one block per [target]: one OS and one
// architecture each, and the engine picks the block for the machine it
// lands on (docs/format.md section 3). Reading them as one list, which
// this page did until 2026-09-22, adds every platform's downloads
// together and describes an install nobody will ever get.
function parsePlan(text) {
  const head = [];
  const blocks = [];
  let cur = null;
  for (const l of planLines(text)) {
    if (l.key === '[target]') { cur = []; blocks.push(cur); continue; }
    (cur || head).push(l);
  }
  return { head, blocks };
}

const FAMILY = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
const ARCH = { amd64: '64-bit (x64)', x86: '32-bit (x86)', arm64: '64-bit ARM', ppc: 'PowerPC', '*': 'any architecture' };

function pick(lines, key) {
  const l = lines.find((x) => x.key === key);
  return l || null;
}

// One target: the machine it is for, the runtime it puts there, what it
// downloads and what it runs. Sizes are the plan's own numbers.
function describeTarget(block) {
  const when = pick(block, 'when');
  const rt = pick(block, 'runtime');
  const covers = pick(block, 'covers');
  const files = [];
  for (const l of block) {
    if (l.key === 'file') files.push({ name: l.val(0), file: l.val(1), sha: l.val(2), size: +l.val(3) || 0, urls: [] });
    else if (l.key === 'url' && files.length) files[files.length - 1].urls.push(l.val(0));
  }
  const runs = [];
  for (const l of block) {
    if (l.key === 'step' && l.val(0) === 'run') runs.push(l.f.slice(2).join(' '));
    else if (l.key === 'install' && l.val(0)) runs.push(l.val(0));
  }
  const arch = when ? when.val(3).split(' ')[0] : '';
  return {
    family: when ? when.val(0) : '',
    arch,
    covers: covers ? covers.val(0) : '',
    runtime: rt ? rt.val(0) : '',
    version: rt ? rt.val(1) : '',
    files,
    bytes: files.reduce((n, f) => n + f.size, 0),
    runs,
    admin: block.some((l) => l.key === 'admin' && l.val(0) === '1'),
  };
}

function describe(planText) {
  const { head, blocks } = parsePlan(planText);
  const get = (k) => { const l = pick(head, k); return l ? l.val(0) : ''; };
  const targets = blocks.map(describeTarget);
  return {
    name: get('name'), project: get('project'), appid: get('appid'), record: get('record'),
    launch: get('launch'), menu: get('menu'), desktop: get('desktop'), root: get('root'),
    runtime: get('runtime'), maxage: get('maxage'), signedAt: get('signed'),
    targets,
    admin: targets.some((t) => t.admin),
  };
}

// The host a download really comes from, for the "from" column. Our own
// mirror is named as ours rather than as an address nobody recognises.
function hostOf(u) {
  try {
    const h = new URL(u).host;
    return /\/mirror\//.test(u) ? h + ' (our mirror)' : h;
  } catch (e) { return u || 'not given'; }
}

// An installer with no plan inside fetches one when it runs (mode A).
// "Nothing here to read" was the wrong answer: this page carries the
// same catalogue and the same resolver the server uses, so it can
// work out the plan the record asks for and show that instead. It is
// not the plan the installer will get -- that one is made when it runs,
// against the catalogue as it is then -- so it is labelled as ours.
async function planFromRecord(recordText) {
  if (!recordText || !hasCatalog || !hasCatalog()) return null;
  let entries;
  try { entries = parseKv(recordText); } catch (e) { return null; }
  const one = (k) => { const v = kvGet(entries, k); return v && v.length ? v[0] : ''; };
  const runtime = one('runtime');
  if (!runtime) return null;
  const app = {
    name: one('name'), project: one('project'), runtime,
    select: one('select') || 'newest', range: one('range'),
    launch: one('launch'), install: one('install'),
    console: one('console') === '1', menu: one('menu') === '1', desktop: one('desktop') === '1',
    root: one('root') || 'user', rootname: one('rootname') || 'ti',
    recordHash: 'preview',
  };
  const pkg = kvGet(entries, 'source');
  if (pkg && pkg.length) {
    const f = String(pkg[0]).split('\t');
    if (f[0] === 'package') { app.package = f[1] || app.project; app.packageVersion = f[2] || ''; }
  }
  try {
    const eff = await effectiveCatalog();
    const cat = eff && eff.catalog ? eff.catalog : eff;
    // The catalogue is split per runtime and the chunks are unpacked on
    // demand (docs/format.md 6), so the folder has to be loaded before
    // resolving or it throws notLoaded. Doing this synchronously is why
    // the first version of this silently produced nothing at all.
    await loadRuntimes(cat, [runtime]);
    return resolve(cat, app);
  } catch (e) {
    return null;
  }
}

// Mode A carries no settings block at all: the settings *are* the file
// name, chosen after the installer was signed, which is why renaming one
// retargets it (docs/design.md, "Why the file name, for mode A"). The
// page read only the block, so every mode A installer came out as "no
// settings, nothing to read" -- the one shape where reading the name is
// the whole job. Same rule the Windows engine uses (base.nsi TiNameParts):
// drop the extension, drop a trailing record-hash token if there is one,
// require install_, then split at the first underscore.
export function nameSettings(fileName) {
  let n = String(fileName || '').replace(/\.(exe|run|zip)$/i, '');
  n = n.replace(/_[a-z2-7]{26}$/i, '');
  if (n.slice(0, 8).toLowerCase() !== 'install_') return null;
  n = n.slice(8);
  const i = n.indexOf('_');
  if (i <= 0 || i >= n.length - 1) return null;
  return { runtime: n.slice(0, i), pkg: n.slice(i + 1) };
}

// The plan a plain-name installer would get: the package from the
// runtime's registry with every setting at its default, which is what
// the server's nameRecord builds (src/build_server/lib/jobs.js).
async function planFromName(fileName) {
  const s = nameSettings(fileName);
  if (!s || !hasCatalog || !hasCatalog()) return null;
  try {
    const eff = await effectiveCatalog();
    const cat = eff && eff.catalog ? eff.catalog : eff;
    await loadRuntimes(cat, [s.runtime]);
    const pol = packagePolicyFor(cat, s.runtime);
    if (!pol) return null;
    const project = packageProject(pol, s.pkg) || s.pkg;
    const plan = resolve(cat, {
      name: project, project, runtime: s.runtime, select: 'newest',
      package: s.pkg, packageVersion: '',
      launch: typeof pol.launch === 'string' ? pol.launch : '',
      install: 'default', console: true, menu: true, desktop: false,
      root: 'user', rootname: 'ti', recordHash: 'preview',
    });
    return { plan, pkg: s.pkg, runtime: s.runtime };
  } catch (e) {
    return null;
  }
}

/* ---------- the server checks ---------- */

// Each returns a row, and each says what it could not do rather than
// going quiet: a check that silently did not run looks exactly like a
// check that passed, which is the failure this project keeps meeting.
async function serverChecks(info, d, out, derived, file) {
  const add = (k, v) => out.push([k, v]);
  add('Server', '<code>' + esc(apiBase()) + '</code>');

  // The hash of the settings actually in the file, computed from their
  // bytes. The earlier version used d.record, which for an installer
  // whose contents this page worked out is the string "preview" -- so
  // the server was asked about a record id that cannot exist and
  // answered bad_hash, twice, in front of the reader.
  let hash = '';
  if (info.record) {
    try { hash = await recordHash(info.record); } catch (e) { hash = ''; }
  } else if (!derived && d && d.record) {
    hash = d.record;
  }

  const named = nameSettings(file.name);
  if (!hash && named) {
    // Nothing is fixed in the file; the server works out the same thing
    // from the name, and its answer carries the id to check below.
    try {
      const txt = await apiRequest('/api/plan/name/' + encodeURIComponent(named.runtime) + '/'
        + encodeURIComponent(named.pkg), { as: 'text' });
      const rec = planLines(txt).find((l) => l.key === 'record');
      hash = rec ? rec.val(0) : '';
      add('Does the server know it?', 'yes, it builds <code>' + esc(named.pkg) + '</code> for '
        + esc(runtimeName(named.runtime)) + ' and would install the same thing');
    } catch (e) {
      add('Does the server know it?', e && (e.status === 404 || e.code === 'not_found')
        ? '<strong>no.</strong> It has no package <code>' + esc(named.pkg) + '</code> for ' + esc(runtimeName(named.runtime))
        : (e && e.status === 451 ? '<strong>this installer has been withdrawn</strong>' : 'could not be asked: ' + esc(errorText(e))));
    }
  } else if (hash) {
    try {
      const got = await apiRequest('/api/records/' + encodeURIComponent(hash), { as: 'text' });
      add('Does the server know it?', String(got) === String(info.record)
        ? 'yes, byte for byte'
        : '<strong>it has something different under the same id.</strong> This file is not what it published');
    } catch (e) {
      add('Does the server know it?', e && (e.status === 404 || e.code === 'not_found')
        ? 'no. Anyone can build an installer, so this only means it was not built here'
        : 'could not be asked: ' + esc(errorText(e)));
    }
  } else {
    add('Does the server know it?', 'nothing in this file or its name identifies it, so there is nothing to ask about');
  }

  // Would it install the same thing today? Only meaningful where the
  // file fixes its contents; where they are worked out at run time the
  // answer is "whatever is newest", which the table already says.
  if (hash && info.plan) {
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
    try {
      const fresh = await apiRequest('/api/plan/' + encodeURIComponent(hash) + '?nonce=' + nonce, { as: 'text' });
      const sig = docSignature(String(fresh), 'ti-plan');
      add('Answering live?', sig.signed && String(fresh).indexOf(nonce) >= 0
        ? 'yes: it signed a one-off number this page just made up, so this is not a recording'
        : '<strong>no: it did not sign the number this page sent</strong>, so this could be a recording');
      const same = String(fresh).replace(/\r/g, '') === String(info.plan || '').replace(/\r/g, '');
      add('Same as a fresh build?', same
        ? 'yes, identical to what it would build today'
        : '<strong>no.</strong> A newer version may have come out, or this file was changed; compare the table above');
    } catch (e) {
      add('Same as a fresh build?', e && e.status === 451
        ? '<strong>this installer has been withdrawn</strong>'
        : 'could not be compared: ' + esc(errorText(e)));
    }
  }

  // Withdrawn since it was made: the one thing no file can know about
  // itself, signed, and checked before it is believed.
  try {
    const rev = await apiRequest('/api/revocations', { as: 'text' });
    const lines = planLines(rev);
    const meta = (k) => (lines.find((l) => l.key === k) || { val: () => '' }).val(0);
    const revoked = hash && lines.some((l) => l.key === 'revoke' && l.val(0) === 'record' && l.val(1) === hash);
    const baked = bakedKey();
    const rs = docSignature(rev, 'ti-revocations');
    let sigSays = '';
    if (!rs.signed) sigSays = ' <strong>The list is not signed</strong>, so it proves nothing.';
    else if (baked) {
      let ok = false;
      try { ok = ed25519Verify(baked, rs.bytes, rs.sig); } catch (e) { ok = false; }
      if (!ok) sigSays = ' <strong>The list\'s signature does not check out</strong>, so it proves nothing.';
    }
    add('Withdrawn since?', (revoked
      ? '<strong>yes, it was withdrawn after this file was made</strong>'
      : (hash ? 'no, as of the list issued ' + esc(meta('issued') || 'recently') : 'cannot be told without knowing which installer this is'))
      + sigSays);
  } catch (e) {
    add('Withdrawn since?', 'could not be checked: ' + esc(errorText(e)));
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

// The digest the ledger chains with. The server computes it over the
// same UTF-8 bytes with node's crypto, and the two have to agree
// exactly or every root differs (src/shared/ledger.js).
function hashHex(text) {
  return hex(sha256(new TextEncoder().encode(text)));
}

// A copy of TiddlyInstall itself, rather than something it built. The
// page you are reading is one too, so it can answer without a server:
// TI_PRISTINE is this page exactly as it arrived, before any script
// touched it, which is the same bytes a "save this page" would write.
//
// What it can say is narrow and is said narrowly: *the same build as
// yours*, which is worth exactly as much as yours is. A page cannot
// carry its own hash, and a hostile copy can claim any commit it likes,
// so the commit it names is reported as a claim and never as a finding.
function pageBlock(text, id) {
  const m = new RegExp('id="' + id + '"[^>]*>([\\s\\S]*?)</script>').exec(text);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

function isTiddlyInstallPage(text) {
  return /<title>[^<]*TiddlyInstall/i.test(text) && text.indexOf('id="ti-offline"') > 0;
}

async function paintPage(file, sha, text) {
  const them = pageBlock(text, 'ti-offline') || {};
  const rev = (v) => v ? '<code>' + esc(String(v).slice(0, 12)) + '</code>' : '<span class="muted">not stated</span>';
  const facts = [
    ['Name', '<code>' + esc(file.name) + '</code>'],
    ['Size', esc(hsize(file.size))],
    ['SHA-256', '<code>' + esc(sha) + '</code><button type="button" class="copy-btn" data-copy="' + esc(sha) + '">Copy</button>'],
    ['It says it was built', esc(String(them.built || 'not stated')) + ' from ' + rev(them.rev)],
  ];
  rows(el('v-page-facts'), facts);
  el('v-page-note').textContent = 'Looking it up in the release ledger\u2026';
  el('v-page-out').hidden = false;

  // Against the ledger, not against this page. Comparing two copies tells
  // you only that they differ, and the likeliest reason is that one of
  // them is newer -- which is not an answer to "is this one real?".
  const mineLedger = (typeof TI_PRISTINE !== 'undefined' && pageBlock(TI_PRISTINE, 'ti-ledger')) || null;
  if (apiLocal() || !apiBase()) {
    el('v-page-note').innerHTML = 'No server is set, so there is nothing outside this file to check it against. ' +
      'A page cannot carry its own hash and any copy can claim any commit, so the date and commit above are what ' +
      'this file <em>says</em> about itself. Set a server and the release ledger can be asked.';
    return;
  }
  try {
    const doc = await apiRequest('/api/releases', { as: 'text' });
    const baked = bakedKey();
    const s2 = docSignature(doc, 'ti-releases');
    let sigOk = false;
    if (baked && s2.signed) { try { sigOk = ed25519Verify(baked, s2.bytes, s2.sig); } catch (e) { sigOk = false; } }
    const lines = planLines(doc);
    const stated = (lines.find((l) => l.key === 'root') || { val: () => '' }).val(0);
    const entries = parseReleases(doc);
    const chain = checkChain(entries, stated, hashHex);
    const hit = entries.find((e) => e.sha256 === sha);

    const more = [
      ['Signed ledger', sigOk
        ? 'yes, by the TiddlyInstall key <code>' + esc(keyId(baked)) + '</code>'
        : '<strong>no</strong> -- ' + (baked ? 'the signature does not check out' : 'this page carries no key to check it with')],
      ['Its chain', chain.ok
        ? 'holds: ' + entries.length + ' release' + (entries.length === 1 ? '' : 's') +
          ', root <code>' + esc(chain.root.slice(0, 16)) + '</code>'
        : '<strong>broken</strong> -- ' + esc(chain.why)],
      ['These bytes', hit
        ? '<strong>published</strong> as release ' + hit.seq + ' on ' + esc(hit.date) + ', from ' + rev(hit.rev)
        : '<strong>not in the ledger</strong>'],
    ];
    // The part a list alone could not do. This page was built with the
    // root as of its own day inside it; if the log now disagrees about
    // what that root was, the log has been rewritten since -- and the
    // witness is a file the operator of that server does not hold.
    let rewritten = false;
    if (mineLedger && mineLedger.seq > 0) {
      const was = rootAt(entries, mineLedger.seq, hashHex);
      rewritten = !!was && was !== mineLedger.root;
      more.push(['Rewritten since your copy?', !was
        ? 'cannot be told: the ledger is shorter than your copy expects (' + entries.length +
          ' entries, yours witnessed ' + mineLedger.seq + ')'
        : was === mineLedger.root
          ? 'no -- it still agrees with the root your own copy was built with'
          : '<strong>yes</strong> -- your copy was built when release ' + mineLedger.seq +
            ' chained to <code>' + esc(String(mineLedger.root).slice(0, 16)) + '</code>, and this ledger says <code>' +
            esc(was.slice(0, 16)) + '</code>. One of them has been changed']);
    }
    rows(el('v-page-facts'), facts.concat(more));
    el('v-page-note').innerHTML = rewritten
      ? '<strong>Whatever else this says, treat it as unresolved.</strong> The ledger is still signed by our key and ' +
        'still chains to its own stated root -- a signature cannot catch a rewrite, because we hold the key. ' +
        'What caught it is your own copy, which was built carrying the root of the day and does not agree. Either ' +
        'this ledger has been changed, or your copy has.'
      : hit && sigOk && chain.ok
        ? 'Published by us, on the date above. The ledger is append-only and every copy of this page carries the root ' +
          'as of the day it was built, so rewriting it means contradicting copies other people already hold.'
        : 'A file not in the ledger is not proof of anything by itself -- it may simply be older than the ledger, ' +
          'or built from a checkout rather than published. Compare the SHA-256 with the one published for that commit.';
  } catch (e) {
    el('v-page-note').textContent = 'The release ledger could not be fetched: ' + errorText(e);
  }
}

async function open(file) {
  el('v-error').hidden = true;
  el('v-out').hidden = true;
  el('v-page-out').hidden = true;
  el('v-busy').hidden = false;
  try {
    const sha = await hashFile(file);
    const bytes = new Uint8Array(await file.arrayBuffer());
    // Before readInstaller, which would only say it does not know the
    // format -- an unhelpful answer to a reasonable question.
    if (/\.html?$/i.test(file.name) || file.type === 'text/html') {
      const text = new TextDecoder('utf-8').decode(bytes);
      if (isTiddlyInstallPage(text)) { await paintPage(file, sha, text); return; }
    }
    const info = await readInstaller(bytes, file.name);
    await paint(file, sha, info);
  } catch (e) {
    el('v-error').textContent = 'Could not read ' + file.name + ': ' + errorText(e);
    el('v-error').hidden = false;
  } finally {
    el('v-busy').hidden = true;
  }
}

async function paint(file, sha, info) {
  let derived = '';
  let planText = info.plan;
  let fromName = null;
  if (!planText) {
    planText = await planFromRecord(info.record);
    if (planText) derived = 'record';
  }
  if (!planText) {
    fromName = await planFromName(file.name);
    if (fromName) { planText = fromName.plan; derived = 'name'; }
  }
  const d = planText ? describe(planText) : null;

  rows(el('v-file-facts'), [
    ['Name', '<code>' + esc(file.name) + '</code>'],
    ['Kind', esc(PLATFORM[info.kind] || info.kind) + ' installer (<code>.' + esc(info.kind) + '</code>)'],
    ['Size', esc(hsize(file.size))],
    ['SHA-256', '<code>' + esc(sha) + '</code><button type="button" class="copy-btn" data-copy="' + esc(sha) + '">Copy</button>'],

    info.pack && info.pack.length ? ['Packed files', info.pack.length + ' file' + (info.pack.length === 1 ? '' : 's') + ' inside, so it can install with no internet'] : null,
  ]);

  el('v-plan-none').hidden = !!d;
  const note = el('v-plan-derived');
  if (note) {
    // One line, and only for the case where it changes what the table
    // means. The version that explained both cases was three sentences
    // of theory above a table that already said everything: the reader
    // wants what it installs, not how installers work.
    note.hidden = !d || !derived;
    note.className = 'small muted';
    note.innerHTML = d && derived
      ? 'Versions are picked when it runs, so these are today\'s. A newer release would change them.'
      : '';
  }

  if (d) {
    const rtLabel = d.runtime || (d.targets.find((t) => t.runtime && t.runtime !== 'none') || {}).runtime || '';
    // Versions differ per machine -- an old Windows gets an old Python on
    // purpose -- so say the span rather than listing five numbers.
    const vers = [];
    for (const t of d.targets) if (t.version && vers.indexOf(t.version) < 0) vers.push(t.version);
    const cmp = (a, b) => { const A = a.split('.').map(Number), B = b.split('.').map(Number);
      for (let i = 0; i < 3; i++) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) - (B[i] || 0);
      return 0; };
    vers.sort(cmp);
    const verSays = vers.length > 1
      ? vers[vers.length - 1] + ' <span class="small muted">on current systems, back to ' + vers[0] + ' on the oldest</span>'
      : (vers[0] || '');
    const totals = d.targets.map((t) => t.bytes).filter((n) => n > 0);
    const runs = d.targets.reduce((n, t) => Math.max(n, t.runs.length), 0);
    rows(el('v-does'), [
      ['Installs', esc(d.name || d.project || 'an app')],
      rtLabel && rtLabel !== 'none'
        ? ['Runtime', esc(runtimeName(rtLabel)) + ' ' + verSays]
        : ['Runtime', 'none; it uses what is already there'],
      ['Into', esc(d.root === 'machine' ? 'a folder for the whole machine' : "a folder of its own in the user's home")],
      totals.length
        ? ['Downloads', 'up to ' + esc(hsize(Math.max.apply(null, totals)))]
        : ['Downloads', 'nothing'],
      ['Runs', runs ? runs + ' command' + (runs === 1 ? '' : 's') : 'no commands'],
      ['Admin rights', d.admin ? '<strong>yes</strong>' : 'not needed'],
      ['Shortcuts', [d.menu === '1' ? 'app menu' : null, d.desktop === '1' ? 'desktop' : null].filter(Boolean).join(', ') || 'none'],
      d.launch ? ['Starts', '<code>' + esc(d.launch) + '</code>'] : null,
    ]);

    // One row per target, because one machine gets exactly one of them.
    // A plan has a block per OS-version range as well as per
    // architecture, so the same machine and version appear more than
    // once. Identical rows are folded together; the ranges they differ
    // by are in "covers", which is shown rather than dropped.
    const tb = el('v-downloads').querySelector('tbody');
    const seenRow = new Map();
    for (const t of d.targets) {
      const hosts = [];
      for (const f of t.files) for (const u of f.urls) { const h = hostOf(u); if (hosts.indexOf(h) < 0) hosts.push(h); }
      const key = [t.family, t.arch, t.runtime, t.version, t.bytes].join('|');
      if (!seenRow.has(key)) seenRow.set(key, { t, hosts, covers: [] });
      if (t.covers) seenRow.get(key).covers.push(t.covers);
    }
    tb.innerHTML = [...seenRow.values()].map(({ t, hosts, covers }) => {
      const where = covers.join(', ').split(', ').filter((x, i, a) => x && a.indexOf(x) === i);
      return '<tr><td>' + esc(FAMILY[t.family] || t.family) + '<br><span class="small muted">' + esc(ARCH[t.arch] || t.arch)
        + (where.length ? ' &middot; ' + esc(where.slice(0, 2).join(', ')) + (where.length > 2 ? ' and ' + (where.length - 2) + ' more' : '') : '')
        + '</span></td>'
        + '<td>' + (t.version ? esc(runtimeName(t.runtime) + ' ' + t.version)
          : '<span class="muted">' + (t.files.length ? 'none' : 'no build for this machine') + '</span>') + '</td>'
        + '<td>' + (t.bytes ? esc(hsize(t.bytes)) : '<span class="muted">-</span>') + '</td>'
        // No urls and no files is not "packed inside", it is nothing to
        // fetch; saying the wrong reassuring thing is worse than saying
        // the plain one.
        + '<td class="small">' + (hosts.length
          ? esc(hosts[0]) + (hosts.length > 1 ? '<br><span class="muted">or ' + (hosts.length - 1) + ' other source' + (hosts.length === 2 ? '' : 's') + '</span>' : '')
          : '<span class="muted">' + (t.files.length ? 'packed inside' : 'nothing to fetch') + '</span>') + '</td></tr>';
    }).join('');
    el('v-downloads-wrap').hidden = !d.targets.length;

    // The commands, per target, with the same text shown once.
    const seen = [];
    for (const t of d.targets) for (const cmd of t.runs) if (seen.indexOf(cmd) < 0) seen.push(cmd);
    el('v-cmds').innerHTML = seen.map((c) => '<li><code>' + esc(c) + '</code></li>').join('');
    el('v-cmds-wrap').hidden = !seen.length;
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
  // The runtime install script, proved against a signed root.
  //
  // The installer does this too, but here it means more: the key, the
  // code and the roots all arrived by a different route from the file
  // being checked. An installer checking itself proves the file is
  // internally consistent; this proves it against something else.
  let rtProved = false;
  if (info.plan) {
    const rt = rtScriptRows(info.plan);
    for (const r of rt.rows) sign.push(r);
    rtProved = rt.proved;
  }

  // Which of the two ways it was made. Only our build server holds the
  // plan key, so a signature is also a statement of origin; without one
  // the record's `backend` is the best this file can say, and empty
  // means it was built with no server at all -- in a page, which cannot
  // sign because the key is not there and never will be (2026-09-23).
  const recBackend = info.record
    ? (planLines(info.record).find((l) => l.key === 'backend') || { val: () => '' }).val(0)
    : '';
  if (!info.plan) {
    sign.push(['The choices', 'are written when it runs, so there are none in the file to check. They are fetched, signed, at that point']);
  } else {
    const s = docSignature(info.plan, 'ti-plan');
    const baked = bakedKey();
    if (!s.signed && rtProved) {
      // With the steps proved a row above, "nothing can say where it
      // came from" is not true any more and reads as a contradiction.
      // What is genuinely unsigned here is the wrapper, so name that.
      sign.push(['The choices', '<strong>are not signed</strong>, and do not need to be: the part we wrote is proved ' +
        'above. These are the app name, where it installs and how it is started -- what whoever built this ' +
        'installer picked, which they know and we never saw']);
    } else if (!s.signed) {
      sign.push(['The choices', '<strong>are not signed</strong> (' + esc(s.why) + '). ' +
        (info.record && !recBackend
          ? 'It was worked out in a web page rather than by our build server -- a page has no signing key -- so nothing here can say where it came from'
          : 'Nothing here can say where it came from') +
        '<br><span class="small muted">what it does is listed above, and every file it names is checked against the SHA-256 beside it -- but those hashes are the script\'s own</span>']);
    } else if (!baked) {
      sign.push(['The choices', 'are signed, but this page carries no key to check them against. Set a server and they can be checked']);
    } else {
      let ok = false;
      try { ok = ed25519Verify(baked, s.bytes, s.sig); } catch (e) { ok = false; }
      // Worth more here than it is inside the installer. There, the
      // script, the key and the code checking it are one file, so the
      // check is the file vouching for itself; the installer's own
      // screen says so. Here the checker is a different artifact that
      // arrived by a different route, which is the whole reason this
      // page can say something the installer cannot.
      sign.push(['The choices', ok
        ? 'are signed by the TiddlyInstall key <code>' + esc(keyId(baked)) + '</code>, so our build server produced this file and nothing has changed it since'
          + '<br><span class="small muted">checked here, by this page, against a key this page carries - not by the installer against a key inside itself</span>'
        : '<strong>carry a signature that does not check out</strong> against key <code>' + esc(keyId(baked)) + '</code>']);
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
  serverChecks(info, d, out, derived, file).then(() => rows(dl, out), (e) => rows(dl, [['Checks', 'could not run: ' + esc(errorText(e))]]));
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

/* ---------- the runtime install script (src/shared/rtscript.js) ---------- */

// Rows for what the plan can prove about its own runtime steps. Returns
// [] when the plan carries no proof at all, which is the ordinary state
// of anything built before the catalogue was signed -- the signing rows
// below then say what they always said.
function rtScriptRows(planText) {
  const none = { rows: [], proved: false };
  const b64 = (planLines(planText).find((l) => l.key === 'rtroots') || { val: () => '' }).val(0);
  if (!b64) return none;
  let doc = '';
  try { doc = normaliseDoc(new TextDecoder().decode(b64ToBytes(b64))); } catch (e) { doc = ''; }
  if (!doc) return { rows: [['The runtime setup', '<strong>carry a proof that could not be read</strong>']], proved: false };

  const baked = bakedKey();
  const s = docSignature(doc, 'ti-rtscripts');
  let sigOk = false;
  if (baked && s.signed) { try { sigOk = ed25519Verify(baked, s.bytes, s.sig); } catch (e) { sigOk = false; } }
  if (!sigOk) {
    return { rows: [['The runtime setup', baked
      ? '<strong>claim a signature that does not check out</strong> against key <code>' + esc(keyId(baked)) + '</code>'
      : 'claim a signature, but this page carries no key to check it with']], proved: false };
  }

  const runtime = (planLines(planText).find((l) => l.key === 'runtime') || { val: () => '' }).val(0);
  const want = rootFor(doc, runtime);
  const issued = (planLines(doc).find((l) => l.key === 'issued') || { val: () => '' }).val(0);
  if (!want) return { rows: [['The runtime setup', 'are signed, but the document names no root for <code>' + esc(runtime) + '</code>']], proved: false };

  let proved = 0, missing = 0, wrong = 0;
  for (const b of targetBlocks(planText)) {
    if (b.indexOf('file\t') < 0) continue;      // a `fail` target installs nothing
    const pl = b.split('\n').find((l) => l.indexOf('rtproof\t') === 0);
    if (!pl) { missing++; continue; }
    const steps = pl.split('\t').slice(1).filter((x) => x !== '-');
    const reached = rootFromProof(leafHash(canonicalTarget(b), hashHex), steps, hashHex);
    if (reached === want) proved++; else wrong++;
  }
  const total = proved + missing + wrong;
  if (!total) return none;

  const out = [];
  if (wrong) {
    out.push(['The runtime setup', '<strong>' + wrong + ' of ' + total + ' do not prove against the signed root</strong>. ' +
      'The steps in this file are not the ones we published']);
  } else if (proved === total) {
    out.push(['The runtime setup', '<strong>are ours</strong>: all ' + total + ' proved against the root ' +
      'signed by key <code>' + esc(keyId(baked)) + '</code>' + (issued ? ', published ' + esc(issued) : '') +
      '<br><span class="small muted">the downloads, their SHA-256s and every command run against them. Not how it is ' +
      'started, which is whoever built this installer wrote</span>']);
  } else {
    out.push(['The runtime setup', proved + ' of ' + total + ' proved against the signed root; ' + missing +
      ' carry no proof, which is what a release older than the signing pass looks like']);
  }
  return { rows: out, proved: proved === total && total > 0 };
}

// base64 to bytes, without atob's unicode trouble.
function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
