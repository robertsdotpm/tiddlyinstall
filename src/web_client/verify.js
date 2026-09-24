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
  // Prerequisites (format.md "Prerequisites"): a `need` and the n* lines
  // that follow it. They are why an install into the user's own folder
  // can still want administrator rights -- but only when the thing is
  // missing, so the screen has to say "only if", never a flat yes.
  const needs = [];
  for (const l of block) {
    if (l.key === 'need') { needs.push({ label: l.val(1) || l.val(0), files: [], runs: [], bytes: 0 }); continue; }
    if (!needs.length) continue;
    const q = needs[needs.length - 1];
    if (l.key === 'nfile') { q.files.push({ file: l.val(0), sha: l.val(1), size: +l.val(2) || 0, urls: [] }); q.bytes += +l.val(2) || 0; }
    else if (l.key === 'nurl' && q.files.length) q.files[q.files.length - 1].urls.push(l.val(0));
    else if (l.key === 'nrun') q.runs.push(l.val(0));
    else if (l.key === 'npkg') q.runs.push(l.val(0) + ' ' + l.val(1));
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
    needs,
    needRuns: needs.reduce((a, q) => a.concat(q.runs), []),
    needFiles: needs.reduce((a, q) => a.concat(q.files), []),
    needBytes: needs.reduce((a, q) => a + q.bytes, 0),
    admin: block.some((l) => l.key === 'admin' && l.val(0) === '1'),
  };
}

function describe(planText) {
  const { head, blocks } = parsePlan(planText);
  const get = (k) => { const l = pick(head, k); return l ? l.val(0) : ''; };
  const targets = blocks.map(describeTarget);
  return {
    name: get('name'), project: get('project'), appid: get('appid'), record: get('record'),
    // resolve.js writes `launch` as the last line of the target block,
    // not in the header, so reading it here always gave '' and the
    // "Starts" row below has never been shown to anybody.
    launch: (blocks.map((b) => (pick(b, 'launch') || { val: () => '' }).val(0)).find((v) => v) || ''),
    menu: get('menu'), desktop: get('desktop'), root: get('root'),
    runtime: get('runtime'), maxage: get('maxage'), signedAt: get('signed'),
    targets,
    admin: targets.some((t) => t.admin),
  };
}

// The host a download really comes from, for the "from" column. Our own
// mirror is named as ours rather than as an address nobody recognises.
function ourMirrorOrigins() {
  const out = [];
  try {
    const pol = (effectiveCatalog && effectiveCatalog() || {}).policy || {};
    for (const b of [pol.mirror_base].concat(Array.isArray(pol.mirror_base_ips) ? pol.mirror_base_ips : [])) {
      if (typeof b === 'string' && b !== '') { try { out.push(new URL(b).origin); } catch (e) { /* not a URL */ } }
    }
  } catch (e) { /* no catalogue here */ }
  return out;
}

function hostOf(u) {
  try {
    const h = new URL(u).host;
    // Compared against the mirror the policy actually names, by origin.
    // It used to be /\/mirror\// tested against the whole URL, so
    // https://evil.example/mirror/x.tgz -- an attacker-chosen first URL
    // in a plan -- was labelled "(our mirror)" in the one column a
    // reader uses to judge where the code is coming from.
    const ours = ourMirrorOrigins();
    let origin = '';
    try { origin = new URL(u).origin; } catch (e) { origin = ''; }
    return ours.indexOf(origin) >= 0 ? h + ' (our mirror)' : h;
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
        ? 'yes, the same text'
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
      // docSignature only says a sig line is well formed. Every other
      // reader in this file pairs it with ed25519Verify; this row used to
      // treat `signed` as a verdict, and looked for the nonce anywhere in
      // the document rather than inside the bytes the signature covers.
      const sig = docSignature(String(fresh), 'ti-plan');
      const bakedLive = bakedKey();
      let live;
      if (!sig.signed) live = '<strong>no: the answer carries no signature</strong>, so this could be a recording';
      else if (!bakedLive) live = 'cannot be told: this page carries no key to check the answer against';
      else {
        let okLive = false;
        try { okLive = ed25519Verify(bakedLive, sig.bytes, sig.sig); } catch (e) { okLive = false; }
        const echoed = okLive && planLines(new TextDecoder().decode(sig.bytes))
          .some((l) => l.key === 'request' && l.val(0) === 'nonce' && l.val(1) === nonce);
        live = !okLive
          ? '<strong>no: the signature on the answer does not check out</strong>'
          : echoed
            ? 'yes: it signed a one-off number this page just made up, so this is not a recording'
            : 'not proved: the answer is signed but carries no number, which is what an older backend looks like. A replayed older plan cannot be ruled out.';
      }
      add('Answering live?', live);
      // The server writes `request nonce <n>` into the answer it signs
      // (build_server/lib/jobs.js), so comparing the bytes would call
      // every genuine unmodified installer changed.
      const bare = (t) => String(t).replace(/\r/g, '').split('\n')
        .filter((l) => !/^request\tnonce\t/.test(l)).join('\n');
      const same = bare(fresh) === bare(info.plan || '');
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
    // Every kind the engines match, not just the record hash. A list can
    // withdraw a record, the source it was built from, or the bytes of a
    // download by SHA-256 (`sha` for one we store, `file` for the bytes
    // wherever they come from). Checking one of five and then printing an
    // unqualified "no" is the page answering a narrower question than the
    // one it asks.
    const revokes = lines.filter((l) => l.key === 'revoke');
    const hasRevoke = (kind, ...vals) => revokes.some((l) =>
      l.val(0) === kind && vals.every((v, i) => String(l.val(i + 1) || '').toLowerCase() === String(v).toLowerCase()));
    const srcLine = info.record ? planLines(String(info.record)).find((l) => l.key === 'source') : null;
    const srcKind = srcLine ? srcLine.val(0) : '';
    let srcVal = srcLine ? String(srcLine.val(1) || '').trim().toLowerCase() : '';
    if (srcKind === 'github') {
      srcVal = srcVal.replace(/^https?:\/\//, '').replace(/^github\.com\//, '').replace(/\/$/, '').replace(/\.git$/, '');
    }
    const planShas = [];
    for (const t of (d ? d.targets : [])) {
      for (const f of t.files || []) if (/^[0-9a-f]{64}$/.test(String(f.sha || ''))) planShas.push(f.sha);
      for (const f of t.needFiles || []) if (/^[0-9a-f]{64}$/.test(String(f.sha || ''))) planShas.push(f.sha);
    }
    const byFile = planShas.filter((h) => hasRevoke('sha', h) || hasRevoke('file', h));
    const revoked = (hash && hasRevoke('record', hash)) ||
      (srcKind !== '' && srcVal !== '' && hasRevoke('source', srcKind, srcVal)) ||
      byFile.length > 0;
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
      ? '<strong>yes, it was withdrawn after this file was made</strong>' +
        (byFile.length ? ' (a file it downloads: ' + esc(byFile[0].slice(0, 16)) + '…)' : '')
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
      // "Save this page" writes documentElement.outerHTML, which is the
      // browser's re-serialisation of the DOM and not the bytes the
      // server sent -- attribute order, entity escaping and the
      // browser-check attributes all move. So a saved copy can never
      // match the ledger, and reporting that as "not in the ledger"
      // reads as a warning about the file when it is a fact about how it
      // was made. page-loader prepends the Mark-of-the-Web comment when
      // it takes that snapshot, and the served file has none, so the
      // file says which it is.
      // A copy made with "Save this page" is documentElement.outerHTML --
      // the browser's re-serialisation of the DOM, not the bytes the
      // server sent -- so it can never match the ledger however genuine
      // it is. Both readings are stated, because this page cannot tell
      // them apart: the Mark-of-the-Web comment that a save prepends is
      // in the served file too, so there is no marker to test.
      ['These bytes', hit
        ? '<strong>published</strong> as release ' + hit.seq + ' on ' + esc(hit.date) + ', from ' + rev(hit.rev)
        : '<strong>not in the ledger</strong> &mdash; either these bytes were never published, or this is a copy '
          + 'saved from a browser, which rewrites the page as it saves it and so can never match. A file downloaded '
          + 'from the server is the one to compare.'],
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
  // Neither fall-through is safe on a file whose settings block this
  // reader could not parse. The engines parse it more loosely, so there
  // is a record and a plan in there that will run; working one out from
  // the record we could not read, or from the file name, and painting it
  // as what this file installs would describe something else entirely --
  // and the name is attacker-chosen.
  if (!planText && !info.footerBad) {
    planText = await planFromRecord(info.record);
    if (planText) derived = 'record';
  }
  if (!planText && !info.footerBad) {
    fromName = await planFromName(file.name);
    if (fromName) { planText = fromName.plan; derived = 'name'; }
  }
  const d = planText ? describe(planText) : null;

  rows(el('v-file-facts'), [
    ['Name', '<code>' + esc(file.name) + '</code>'],
    ['Kind', esc(PLATFORM[info.kind] || info.kind) + ' installer (<code>.' + esc(info.kind) + '</code>)'],
    ['Size', esc(hsize(file.size))],
    ['SHA-256', '<code>' + esc(sha) + '</code><button type="button" class="copy-btn" data-copy="' + esc(sha) + '">Copy</button>'],

    info.pack && info.pack.length ? ['Packed files', (() => {
      // "so it can install with no internet" is only true when the pack
      // covers every file the plan names. builder.js puts the app's own
      // source into the pack for ordinary online builds too, so counting
      // members claimed it for files that still have to be downloaded --
      // three rows above a Downloads total that said otherwise.
      const want = [];
      for (const t of (d ? d.targets : [])) {
        for (const f of t.files || []) if (f.sha) want.push(String(f.sha).toLowerCase());
        for (const f of t.needFiles || []) if (f.sha) want.push(String(f.sha).toLowerCase());
      }
      const have = new Set((info.pack || []).map((m) => String(m.name || '').toLowerCase()));
      const missing = want.filter((h) => !have.has(h));
      const n = info.pack.length + ' file' + (info.pack.length === 1 ? '' : 's') + ' inside';
      if (!want.length) return n;
      return missing.length === 0
        ? n + ', covering every file this plan names, so it can install with no internet'
        : n + ', but ' + missing.length + ' of the ' + want.length + ' files this plan names ' +
          (missing.length === 1 ? 'is' : 'are') + ' not among them, so it still needs the network';
    })()] : null,
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
    const totals = d.targets.map((t) => t.bytes + t.needBytes).filter((n) => n > 0);
    const runs = d.targets.reduce((n, t) => Math.max(n, t.runs.length + t.needRuns.length), 0);
    rows(el('v-does'), [
      ['Installs', esc(d.name || d.project || 'an app')],
      rtLabel && rtLabel !== 'none'
        ? ['Runtime', esc(runtimeName(rtLabel)) + ' ' + verSays]
        : ['Runtime', 'none; it uses what is already there'],
      ['Into', esc(d.root === 'system' ? 'a folder for the whole machine' : "a folder of its own in the user's home")],
      totals.length
        ? ['Downloads', 'up to ' + esc(hsize(Math.max.apply(null, totals)))]
        : ['Downloads', 'nothing'],
      ['Runs', runs ? runs + ' command' + (runs === 1 ? '' : 's') : 'no commands'],
      // design.md 1.1: rights are asked for when the folder is shared, or
      // when a prerequisite is missing. `admin` is a real format key no
      // writer emits yet, so on its own it was always false.
      ['Admin rights', d.root === 'system' || d.admin
        ? '<strong>yes</strong>'
        : (d.targets.some((t) => t.needRuns.length) ? 'only if a prerequisite is missing' : 'not needed')],
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
  // The runtime setup, proved against a signed root.
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
  if (info.footerBad) {
    // This file ends with something that says it is a settings block and
    // does not parse here. Both engines read the footer more loosely than
    // this page does, so a file they will read a record and a plan out of
    // -- and install from -- reaches this point looking empty. Saying
    // "there are none in the file to check" about it is the page stating
    // as fact the one thing it does not know.
    sign.push(['The choices', '<strong>could not be read</strong>: this file ends with something that claims to be a settings block ' +
      'and does not match the format, so nothing here describes what it will do. An installer that runs it may read it anyway.']);
  } else if (!info.plan) {
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
      // What did the checking, and what that is worth, is its own row
      // below -- said once, where a reader can see the whole chain
      // together, rather than twice in different words.
      sign.push(['The choices', ok
        ? 'are signed by the TiddlyInstall key <code>' + esc(keyId(baked)) + '</code>, so our build server wrote these settings and they have not changed since. That signature covers the settings and the record they name, not the installer program carrying them: no signature covers that, so compare this file\'s SHA-256 above with the one published where you got it'
        : '<strong>carry a signature that does not check out</strong> against key <code>' + esc(keyId(baked)) + '</code>']);
    }
  }
  // Where this file says it came from, and what that is worth.
  //
  // The chain a stranger can follow: the file names a server, this page
  // carries a key, and the signature either checks out against that key
  // or does not. All three were already true; none of them was said, so
  // a reader had no way to see that the check was made against something
  // other than the file being checked (the operator, 2026-09-23).
  //
  // What it can and cannot do is stated rather than implied. A file
  // naming a server that publishes a different key is provably wrong. A
  // hostile file naming a hostile server is perfectly consistent, so
  // agreement here is not proof of anything -- the stamp buys
  // falsifiability, not authenticity.
  if (info.record) {
    const signedStamp = info.plan && docSignature(info.plan, 'ti-plan').signed;
    sign.push(['Where it says it came from', recBackend
      ? '<code>' + esc(recBackend) + '</code>' +
        ' <button type="button" class="link-button" id="v-ask-origin">Ask that server</button>' +
        '<span id="v-ask-out"></span>' +
        (signedStamp
          ? '<br><span class="small muted">inside what the signature covers: the plan names this record by its hash, so this cannot be edited without breaking the signature above</span>'
          : '<br><span class="small muted">a claim, not a signed one: nothing here stops it saying anything. It is worth checking against that server, not against this file</span>')
      : 'nowhere: it was built in a web page, with no server' +
        '<br><span class="small muted">a page holds no signing key and never will, so there is nothing to have signed it</span>']);
  }
  {
    const baked = bakedKey();
    if (baked) {
      sign.push(['What checked it', 'this page, against the key it carries, <code>' + esc(keyId(baked)) + '</code>' +
        '<br><span class="small muted">a different file from the one being checked, fetched a different way -- which is the whole reason this page can say ' +
        'something the installer cannot, since the installer checks itself against a key inside itself. ' +
        'That this page and the file agree means the settings in the file have not been altered on their own; it does not, by itself, say whose key it is. ' +
        'What ties that key to us is that it is published: on the Trust page, in the release ledger, and in every copy of this page already saved to somebody else\'s disk</span>']);
    }
  }

  rows(el('v-signing'), sign);

  // Ask the server the file names whether it publishes the key that
  // signed this file. Three artifacts instead of two: the file, this
  // page, and whatever that address answers right now.
  //
  // Only ever on this page, never in an installer. An installer that
  // phoned a server to ask whether it was legitimate would be asking
  // the thing being vouched for, over a network it cannot trust, and
  // the whole design is that it does not need to (docs/design.md 7.1).
  //
  // What this can settle: a file naming a server that publishes a
  // different key is provably wrong. What it cannot: a hostile file
  // naming a hostile server agrees with itself perfectly. So the answer
  // is always stamped with the fact that it was asked, just now, over
  // the network -- never folded in with the offline proof above.
  const askBtn = document.getElementById('v-ask-origin');
  if (askBtn) {
    askBtn.addEventListener('click', async () => {
      const out = document.getElementById('v-ask-out');
      const say = (html) => { out.innerHTML = '<br><span class="small">' + html + '</span>'; };
      askBtn.disabled = true;
      say('asking ' + esc(recBackend) + '...');
      if (location.protocol === 'https:' && /^http:/i.test(recBackend)) {
        say('<strong>cannot ask it from here.</strong> This page came over HTTPS and that address is plain ' +
          '<code>http</code>, which a browser refuses. Open this page over http, or use an https address for the server.');
        askBtn.disabled = false;
        return;
      }
      let j = null;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 15000);
        const r = await fetch(recBackend.replace(/\/+$/, '') + '/api/pubkey', { cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        if (!r.ok) throw new Error('it answered ' + r.status);
        j = await r.json();
      } catch (e) {
        say('<strong>could not reach it</strong> (' + esc(String(e && e.message || e)) + '). That says nothing ' +
          'about this file: a server can be down, moved or behind a network this browser cannot see.');
        askBtn.disabled = false;
        return;
      }
      let pub = null;
      try { pub = b64bytes(j && j.key); } catch (e) { pub = null; }
      if (!pub || pub.length !== 32) {
        say('<strong>it did not answer with a key.</strong> Nothing here can be concluded.');
        askBtn.disabled = false;
        return;
      }
      const theirs = keyId(pub);
      const baked = bakedKey();
      const sig = info.plan ? docSignature(info.plan, 'ti-plan') : { signed: false };
      let good = false;
      if (sig.signed) { try { good = !!ed25519Verify(pub, sig.bytes, sig.sig); } catch (e) { good = false; } }
      const same = baked && keyId(baked) === theirs;
      let msg = 'Asked just now, over the network: <code>' + esc(recBackend) + '</code> publishes key <code>' +
        esc(theirs) + '</code>';
      msg += same ? ', the same key this page carries. ' : ', which is <strong>not</strong> the key this page carries. ';
      if (!sig.signed) {
        msg += 'This file carries no signature to check against it.';
      } else if (good) {
        msg += 'This file\'s signature checks out against it, so the server it names does vouch for it.';
      } else {
        msg += '<strong>This file\'s signature does not check out against it</strong> -- the file names that server ' +
          'and that server did not sign it. Something is wrong with the file, the server, or both.';
      }
      msg += '<br><span class="muted">An answer over the network is not the offline proof above. It can show a file ' +
        'is wrong; it cannot show one is right, because a file naming a server of its own agrees with itself.</span>';
      say(msg);
      askBtn.disabled = false;
    });
  }

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

/* ---------- the runtime setup (src/shared/rtscript.js) ---------- */

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
    // A block with no `file` line is not necessarily a `fail` block: it
    // can carry `install` or `npkg`, which the engine runs through
    // sh -c. Skipping it here took it out of the denominator, so
    // "all N proved, every command run against them" was said about a
    // set that excluded the commands with nothing vouching for them.
    if (b.indexOf('file\t') < 0 && b.indexOf('install\t') < 0 &&
        b.indexOf('step\t') < 0 && b.indexOf('npkg\t') < 0) continue;   // nothing to install, nothing to vouch for
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
