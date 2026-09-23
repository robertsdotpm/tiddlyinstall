// The server's API, answered inside the page (plan.md section 1.11).
// The one-file site sets globalThis.tiLocalApi from here, and api.js sends
// every call to it when there is no server (opened from disk, or "No
// server" chosen). Two things leave the browser, and nothing else:
// package registry lookups, which only happen when a package's version
// isn't given, and -- for a GitHub source -- api.github.com, to turn a
// branch or tag into the commit the record pins and to read the names at
// the top of the repository, which is how the install rule is chosen
// (src/shared/github.js; the server derives both the same way, from the
// same code, so one form gives one record either side).
//
// **A copy saved to disk makes neither GitHub call.** Its promise is that
// nothing leaves it, and a GitHub installer does not need the API: a full
// commit id and an install command are exactly what the API would have
// been asked for, and the refusal names those two fields. The installer
// it builds still fetches the repository from GitHub when it runs --
// that is the installer's job, not the page's.
//
// Jobs run through src/shared/builder.js, as on the server, with embedPlan: each
// installer carries its plan (resolved from the catalogue snapshot in the
// page) and packs the app's source, so it never needs a server. The
// plan is unsigned, which the engines accept for a plan inside the
// installer, with a warning (format.md "Plan signature"). Runtimes still
// download from their URLs when the installer runs.
//
// What the page carries (tools/build_site.py writes these blocks):
//   #ti-offline   JSON {built, rev, backend}
//   #ti-catalog   the catalogue's index, JSON: its shared files, its folders,
//                 and GET /api/catalog/runtimes's answer (docs/format.md 6)
//   #ti-cat-NAME  each catalogue folder, gzipped, base64; unpacked when a
//                 build first needs one of its runtimes (src/web_client/overlay.js)
//   #ti-overlay   catalogue changes saved inside the page (src/web_client/overlay.js)
//   #base-windows, #base-linux, #base-macos   the unsigned bases, base64
//
// The catalogue is the snapshot with this browser's changes from the
// Runtimes page on top (src/web_client/overlay.js effectiveCatalog). A build made with
// changes says so in its result (`catalog`), and the build page shows it.
import { ApiError, pageFromDisk } from './api.js';
import { noNetworkGet } from '../shared/github.js';
import { validate, runJob, planPackFiles, MAX_PACK, MAX_MAC_PACK } from '../shared/builder.js';
import { resolve, setRevoked } from '../shared/resolve.js';
import { writeInstallerLayout, streamInstallerLayout, parseFooterTail, bytesToHex, packTarSize } from '../shared/tifile.js';
import { sha256Stream } from './lib/sha.js';
import { packBudget, packEnv } from '../shared/form-job.js';
import { effectiveCatalog, effectiveSummary, unpackedFolders } from './overlay.js';

const enc = new TextEncoder();
const MB = 1024 * 1024;

function block(id) {
  const el = document.getElementById(id);
  return el && !el.dataset.placeholder ? el.textContent : null;
}

function blockBytes(id) {
  const t = block(id);
  if (t == null) return null;
  const s = atob(t.replace(/\s+/g, ''));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

export const offlineInfo = (() => {
  try { return JSON.parse(block('ti-offline') || '{}'); } catch (e) { return {}; }
})();

// {catalog, applied, id}: rebuilt by overlay.js whenever the changes do.
function catalog() {
  return effectiveCatalog();
}

/* ---------- jobs: the queue's view, in memory ---------- */

const jobs = new Map();
const records = new Map();
let nextTicket = 1;

function view(j) {
  const v = { id: j.id, ticket: j.ticket, class: 'build', status: j.status, position: 0,
    eta_seconds: j.status === 'done' || j.status === 'failed' ? null : 2, progress: j.progress, error: j.error };
  if (j.result) v.result = j.result;
  return v;
}

// The revocation list baked into this page (tools/build_site.py). Without
// it the page's resolver would happily write a plan naming a build that
// has been withdrawn: builder.js calls setRevoked(), but nothing in the
// page ever supplied the hashes, so until 2026-09-23 it was a no-op here
// and only the build server ever made the withdrawn-build choice.
//
// An online installer was still covered by the engine's own fetch of
// /api/revocations at install time. A fully offline one was not covered
// anywhere, which is the case this closes.
// Read per build, not cached: a cache here held the first answer for the
// life of the tab, which is a stale-state hazard for no measurable gain
// -- it is one small JSON parse per build. It also made the regression
// test below impossible to write, which is usually the same smell.
export function pageRevocations() {
  try {
    const n = document.getElementById('ti-revocations');
    if (n) {
      const d = JSON.parse(n.textContent);
      if (d && Array.isArray(d.sha)) return { issued: String(d.issued || ''), sha: d.sha };
    }
  } catch (e) { /* a page built before this block, or a damaged one: revoke nothing */ }
  return { issued: '', sha: [] };
}

async function env() {
  const eff = await catalog();
  const e = { catalog: eff.catalog, overlay: eff, base: (plat) => blockBytes('base-' + plat), backend: offlineInfo.backend || '',
    embedPlan: true, packRuntimes: true, githubWho: 'page',
    revoked: () => pageRevocations().sha };
  // On the catalogue itself, not only through builder.js: the offline
  // path resolves in packPlan() below, which never goes near that call.
  setRevoked(e.catalog, pageRevocations().sha);
  // A GitHub source is pinned by its commit, and which commit a branch
  // or tag is -- and which files are at the top of it -- comes from
  // api.github.com, which answers browsers (src/shared/github.js). A copy
  // saved to disk asks nothing: there the two answers have to be typed,
  // and the refusal says which fields to type them into.
  if (pageFromDisk()) e.githubGet = noNetworkGet();
  return e;
}

/* ---------- offline installers, packed here (docs/browser-packing.md) ---------- */

// Packing runtimes into an installer used to need the server. It was
// measured instead (docs/browser-packing.md): every machine we have, down
// to a 744 MB 32-bit VM and Firefox 52 on Vista, packs any single default
// installer, and the ceiling is the largest single installer rather than
// the sum of what was ticked, because the three platforms are three files
// built one after another.
//
// Three things make that safe to switch on:
//
//   1. **A budget.** src/shared/form-job.js packBudget turns what this browser
//      will say about itself into a size, conservatively, and a pack over
//      it is refused before a byte is fetched, with what would make it
//      possible. A refusal costs someone a choice; a tab that dies costs
//      them the work with nothing to explain it.
//   2. **One installer at a time.** Each file is assembled, handed over and
//      dropped before the next one starts, so the page never holds two.
//      The previous build's object URLs are revoked when the next build
//      starts -- not when a download starts, which cannot be observed.
//   3. **The footer is read back** out of the finished Blob before the file
//      is offered. Android Chrome built and hashed a 640 MB pack and then
//      could not read its own last 64 bytes; without this check that file
//      would have been handed over looking complete.

// Where a destination the user picked is waiting (showSaveFilePicker or
// showDirectoryPicker, taken in src/web_client/new.js while the click that started the
// build is still fresh). Used once, by the next build.
let saveTo = null;
export function setPackDestination(dest) { saveTo = dest || null; }

// Object URLs the last build handed over. Revoked when the next one starts:
// by then the browser has long taken whatever was downloaded, and the rule
// needs no completion event, which `<a download>` does not have.
let handedOver = [];
function releasePrevious() {
  for (const u of handedOver) { try { URL.revokeObjectURL(u); } catch (e) { /* gone already */ } }
  handedOver = [];
}

const mirrorBaseOf = (cat) => String((cat && cat.policy && cat.policy.mirror_base) || '').replace(/\/+$/, '');

// One packed file, from our mirror and nowhere else. A browser cannot
// fetch from the vendors -- they send no CORS headers -- and it should not
// try: that would tell python.org who is building what, from the
// publisher's own address. Our mirror answers `Access-Control-Allow-Origin:
// *`, so a file it holds can be fetched and a file it does not hold is the
// one thing here that really does need the server.
async function fetchMember(cat, f) {
  const base = mirrorBaseOf(cat);
  const urls = base ? f.urls.filter((u) => u.indexOf(base + '/') === 0) : [];
  if (!urls.length) {
    throw new Error('our mirror has no copy of ' + f.label + ', and a browser cannot fetch it from the vendor (they send no ' +
      'Access-Control-Allow-Origin header). Build this one on a server, or choose a version we mirror.');
  }
  const tried = [];
  for (const u of urls) {
    let res;
    try {
      res = await fetch(u);
    } catch (x) { tried.push(u + ': ' + (x && x.message ? x.message : 'could not be reached')); continue; }
    if (!res.ok) { tried.push(u + ': ' + res.status + ' ' + res.statusText); continue; }
    const got = new Uint8Array(await res.arrayBuffer());
    if (got.length !== f.size) { tried.push(u + ': ' + got.length + ' bytes, not the ' + f.size + ' the plan gives'); continue; }
    const h = sha256Stream();
    h.update(got);
    const sum = bytesToHex(h.digest());
    if (sum !== f.sha256) { tried.push(u + ': SHA-256 ' + sum.slice(0, 16) + '…, not the plan\'s ' + f.sha256.slice(0, 16) + '…'); continue; }
    return got;
  }
  throw new Error('couldn\'t fetch ' + f.label + ': ' + tried.join('; '));
}

// The plan an offline installer carries, and the files it must hold: the
// blocks that cover what was ticked under "Must work offline on", and
// nothing else (src/shared/builder.js planPackFiles). The plan is unsigned --
// the page has no key -- which the engines accept for a plan inside an
// installer, with a warning.
async function packPlan(body, e, plat, app, progress) {
  const cat = e.catalog;
  const plan = resolve(cat, Object.assign({}, app, { platforms: [plat] }));
  const targets = (body.pack && Array.isArray(body.pack.offline_targets)) ? body.pack.offline_targets : null;
  const sel = planPackFiles(plan, plat, targets);
  if (!sel.files.length) {
    throw new Error('nothing was ticked under "Must work offline on" for ' + plat + ', so there would be nothing packed in it');
  }
  // Refused here, before anything is fetched: the budget is about what this
  // browser can hold, and the answer does not improve after a 200 MB
  // download.
  const bytes = packTarSize(sel.files.map((f) => ({ name: f.name, size: f.size })));
  checkBudget(bytes, plat, sel.files.length);
  const mb = Math.round(bytes / MB);
  progress('Packing ' + mb + ' MB for ' + plat + ': ' + sel.files.length + ' file' + (sel.files.length === 1 ? '' : 's') +
    ' from ' + sel.blocks + ' of the plan\'s targets');
  return {
    plan,
    files: sel.files.map((f) => ({
      name: f.name, sha256: f.sha256, size: f.size, label: f.label,
      // Fetched when its bytes are about to be written into the output and
      // dropped straight after, so the page holds one packed file at a
      // time and not the whole pack (docs/browser-packing.md section 7).
      read: () => fetchMember(cat, f),
    })),
  };
}

// The budget, and the sentence when a pack is over it. `stream` (the save
// picker) makes the installer format the only ceiling.
function checkBudget(bytes, plat, count) {
  const b = packBudget(packEnv(globalThis, { macZip: plat === 'macos', noPicker: !saveTo }));
  const hard = plat === 'macos' ? MAX_MAC_PACK : MAX_PACK;
  const mb = Math.round(bytes / MB);
  if (bytes > hard) {
    throw new Error('the packed files for ' + plat + ' come to ' + mb + ' MB, past the ' + Math.round(hard / MB) +
      ' MB one installer can hold. Untick some systems or architectures, or build it on a server.');
  }
  if (bytes <= b.mb * MB) return b;
  const fix = b.stream ? 'Untick some systems or architectures, or build it on a server.'
    : (typeof globalThis.showSaveFilePicker === 'function'
      ? 'Untick some systems or architectures, or let the page save it straight to a file when you press Build.'
      : 'Untick some systems or architectures, or build it on a server. A browser that can write a file as it is made ' +
        '(Chrome or Edge on a computer) has no such limit.');
  throw new Error('this browser is not being asked to hold ' + mb + ' MB: the limit here is ' + b.mb + ' MB, because ' +
    b.why + '. ' + fix + ' ' + count + ' file' + (count === 1 ? '' : 's') + ' would be packed.');
}

// env.save for the page: the finished installer, checked and handed over,
// without the page keeping it. `spec.layout` is the .exe/.run layout, which
// is assembled into one buffer (or written straight to the user's file);
// `spec.data` is the macOS zip, which a zip library has already built.
async function savePacked(hash, name, spec, plat, live) {
  // A .exe with a custom icon carries a PE checksum, which is computed
  // over the whole file and sits near its start, so it cannot be written
  // to a file as the file is made: that one is held in memory even where
  // there is a picker, and then the ordinary budget decides. Said here,
  // before the work, rather than as a failure at the end of it.
  const layout = spec.layout ? layoutOf(spec.layout) : null;
  const streamable = !!(layout && saveTo && !spec.layout.fixChecksum);
  if (layout && saveTo && !streamable) checkHeldBudget(layout, name);

  let size, sha256, blob = null, handle = null;
  if (streamable) {
    // Straight to the file the user chose, a chunk at a time: measured at
    // 4.3 GB written with the page holding 44-116 MB.
    const w = await openDest(name);
    handle = w.handle;
    try {
      const r = await streamInstallerLayout({ write: (b) => w.stream.write(b) }, layout);
      size = r.size; sha256 = r.sha256;
      await w.stream.close();
    } catch (x) { try { await w.stream.abort(); } catch (e2) { /* the write failed anyway */ } throw x; }
  } else {
    const built = layout ? await writeInstallerLayout(layout, { hash: true })
      : { data: spec.data, size: spec.data.length, sha256: await shaOf(spec.data) };
    size = built.size; sha256 = built.sha256;
    if (saveTo) {
      // Held in memory (a macOS zip, or a Windows file with a checksum),
      // but still written to the file the user chose.
      const w = await openDest(name);
      handle = w.handle;
      try { await w.stream.write(built.data); await w.stream.close(); }
      catch (x) { try { await w.stream.abort(); } catch (e2) { /* failed anyway */ } throw x; }
    } else {
      blob = new Blob([built.data], { type: 'application/octet-stream' });
      // built.data goes out of scope here: the page's own copy is gone and
      // only the browser's Blob is left, which is what frees the next build.
    }
  }
  await checkFooter({ blob, handle, size, name, footer: !!layout });
  const out = { size, sha256 };
  if (blob) {
    out.url = URL.createObjectURL(blob);
    handedOver.push(out.url);
  } else out.saved = true;
  // Handed over now, not at the end of the job: three platforms are three
  // downloads, and the first should be there while the third is building.
  if (live) live({ platform: plat, name, size, sha256, url: out.url || '', saved: !!out.saved });
  return out;
}

async function openDest(name) {
  const dest = await saveTo.fileFor(name);
  return { handle: dest.handle, stream: await dest.handle.createWritable() };
}

// The budget for a file that has to be held whole even though a
// destination was picked.
function checkHeldBudget(layout, name) {
  const total = layout.base.length + layout.record.length + layout.plan.length +
    (layout.pack.length ? packTarSize(layout.pack) : 0) + 64;
  const b = packBudget(packEnv(globalThis, { noPicker: true }));
  if (total > b.mb * MB) {
    throw new Error(name + ' is ' + Math.round(total / MB) + ' MB and has a custom icon, so it carries a checksum over the whole ' +
      'file that can only be written by holding all of it at once -- and the limit here is ' + b.mb + ' MB, because ' + b.why +
      '. Build it without a custom icon, pack fewer systems, or use the server.');
  }
}

const layoutOf = (l) => ({ base: l.base, record: l.record, plan: l.plan, pack: l.pack,
  pe: l.fixChecksum ? { checksumOff: l.checksumOff } : null });

async function shaOf(data) {
  const h = sha256Stream();
  h.update(data);
  return bytesToHex(h.digest());
}

// Read the last 64 bytes of the finished file back and check they say what
// was written. This is the one check that catches the failure that produces
// no error of its own: a file that is short, or that the browser cannot
// read back, while everything up to that point reported success.
async function checkFooter({ blob, handle, size, name, footer }) {
  let tail, whole = size;
  try {
    if (blob) {
      tail = new Uint8Array(await blob.slice(blob.size - 64).arrayBuffer());
      whole = blob.size;
    } else {
      const f = await handle.getFile();
      whole = f.size;
      tail = new Uint8Array(await f.slice(f.size - 64).arrayBuffer());
    }
  } catch (x) {
    throw new Error(name + ' was built, but this browser could not read it back to check it (' +
      (x && x.message ? x.message : x) + '), so it is not being offered. Pack fewer systems, or build it on a server.');
  }
  // A macOS installer is a zip and has no metadata footer; for it the
  // check is that the file is there, is the length that was written, and
  // can be read back at all, which is the failure this catches.
  const f = footer ? parseFooterTail(tail) : tail;
  if (!f || whole !== size) {
    throw new Error(name + ' came back ' + whole + ' bytes' + (f ? '' : ' with no readable footer') +
      ', not the ' + size + ' that were written, so it is not being offered.');
  }
}

async function build(body, e, progress, live) {
  if (e.overlay.applied) progress('Using ' + e.overlay.applied + ' catalogue change' + (e.overlay.applied === 1 ? '' : 's') + ' from this browser');
  const offline = !!body.offline;
  if (offline) {
    e.packPlan = (hash, plat, prog, app) => packPlan(body, e, plat, app, prog);
    e.save = (hash, name, spec, plat) => savePacked(hash, name, spec, plat, live);
  }
  const out = await runJob(body, e, progress);
  records.set(out.hash, out.record);
  const res = {
    // Where it was built, for the build page to say so (design.md 11.0
    // item 6): this job never went near a server.
    built: { where: 'page' },
    record: out.hash,
    files: out.files.map((f) => {
      const o = { platform: f.platform, name: f.name, size: f.size, sha256: f.sha256, signed: '', offline };
      if (f.url) o.url = f.url;                 // packed: handed over as it was built
      else if (f.saved) o.saved = true;         // written to the file the user chose
      else {
        o.url = URL.createObjectURL(new Blob([f.data], { type: 'application/octet-stream' }));
        handedOver.push(o.url);
      }
      return o;
    }),
  };
  // Downloads our mirror has no copy of, as the server reports them
  // (src/build_server/lib/jobs.js): the build page warns the same way either way.
  if (out.unmirrored && out.unmirrored.length) res.unmirrored = out.unmirrored;
  // What a branch or tag resolved to (src/shared/builder.js), exactly as the
  // server reports it: the build page says which commit was pinned
  // either way.
  if (out.source) res.source = out.source;
  // Made with a changed catalogue: the build page says so.
  if (e.overlay.applied) res.catalog = { changed: true, changes: e.overlay.applied, id: e.overlay.id };
  return res;
}

async function submit(body) {
  // Checked before queueing, as the server does, so the form shows the error.
  // The job is built with the catalogue as it is now, even if the changes
  // move on while it runs.
  let e;
  try {
    e = await env();
    validate(JSON.parse(JSON.stringify(body)), e);
  } catch (x) {
    throw new ApiError(x.status || 400, x.message, x.code || 'invalid');
  }
  // The last build's files are let go now: one installer at a time is what
  // makes the ceiling the largest single file rather than the sum.
  releasePrevious();
  const dest = saveTo;
  const j = { id: 'local-' + nextTicket, ticket: nextTicket++, status: 'running', progress: 'Starting', error: '' };
  jobs.set(j.id, j);
  // Files appear on the build page as each one is finished, not all at the
  // end: with three platforms the first download is ready while the third
  // is still being packed.
  const live = (f) => {
    if (!j.result) j.result = { built: { where: 'page' }, files: [] };
    j.result.files.push(f);
  };
  build(body, e, (m) => { j.progress = m; }, live)
    .then((res) => { j.result = res; j.status = 'done'; j.progress = 'Done'; })
    .catch((x) => { j.status = 'failed'; j.error = x && x.message ? x.message : String(x); })
    .then(() => { if (saveTo === dest) setPackDestination(null); });
  return view(j);
}

const OFFLINE_ONLY = 'This needs a server; the page is building installers itself (choose a server at the bottom of the page).';

async function request(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const [p] = String(path).split('?');
  let m;
  let out;
  if (method === 'GET' && p === '/api/health') out = { ok: true, offline: true };
  else if (method === 'GET' && p === '/api/catalog/runtimes') out = await effectiveSummary();
  else if (method === 'POST' && p === '/api/jobs') out = await submit(opts.body || {});
  else if (method === 'GET' && (m = /^\/api\/jobs\/([^/]+)$/.exec(p))) {
    const j = jobs.get(decodeURIComponent(m[1]));
    if (!j) throw new ApiError(404, 'No such build in this page (builds made offline last until the page is closed).', 'not_found');
    out = view(j);
  } else if (method === 'GET' && (m = /^\/api\/records\/([a-z2-7]{26})$/.exec(p)) && records.has(m[1])) {
    out = records.get(m[1]);
    return opts.as === 'bytes' ? enc.encode(out) : out;
  } else throw new ApiError(501, OFFLINE_ONLY, 'offline');
  if (opts.as === 'text') return JSON.stringify(out);
  if (opts.as === 'bytes') return enc.encode(JSON.stringify(out));
  return out;
}

// A link for a backend path (absUrl): records built here, as blob URLs.
const recordUrls = new Map();
function url(path) {
  const m = /^\/api\/records\/([a-z2-7]{26})$/.exec(String(path));
  if (!m || !records.has(m[1])) return '';
  if (!recordUrls.has(m[1])) recordUrls.set(m[1], URL.createObjectURL(new Blob([records.get(m[1])], { type: 'text/plain' })));
  return recordUrls.get(m[1]);
}

export function installLocalApi() {
  globalThis.tiLocalApi = { request, url, info: offlineInfo, unpacked: unpackedFolders };
  catalog().catch(() => { /* reported when a build needs it */ });
}
