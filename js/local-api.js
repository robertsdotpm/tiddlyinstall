// The build server's API, answered inside the page (plan.md section 1.11).
// The one-file site sets globalThis.ibLocalApi from here, and api.js sends
// every call to it when there is no build server (opened from disk, or "No
// server" chosen). Nothing leaves the browser except package registry
// lookups, which only happen when a package's version isn't given.
//
// Jobs run through js/builder.js, as on the server, with embedPlan: each
// installer carries its plan (resolved from the catalogue snapshot in the
// page) and packs the app's source, so it never needs a build server. The
// plan is unsigned, which the engines accept for a plan inside the
// installer, with a warning (format.md "Plan signature"). Runtimes still
// download from their URLs when the installer runs.
//
// What the page carries (tools/build_site.py writes these blocks):
//   #ib-offline   JSON {built, rev, backend}
//   #ib-catalog   the catalogue's index, JSON: its shared files, its folders,
//                 and GET /api/catalog/runtimes's answer (docs/format.md 6)
//   #ib-cat-NAME  each catalogue folder, gzipped, base64; unpacked when a
//                 build first needs one of its runtimes (js/overlay.js)
//   #ib-overlay   catalogue changes saved inside the page (js/overlay.js)
//   #base-windows, #base-linux, #base-macos   the unsigned bases, base64
//
// The catalogue is the snapshot with this browser's changes from the
// Runtimes page on top (js/overlay.js effectiveCatalog). A build made with
// changes says so in its result (`catalog`), and the build page shows it.
import { ApiError } from './api.js';
import { validate, runJob } from './builder.js';
import { effectiveCatalog, effectiveSummary, unpackedFolders } from './overlay.js';

const enc = new TextEncoder();

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
  try { return JSON.parse(block('ib-offline') || '{}'); } catch (e) { return {}; }
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

async function env() {
  const eff = await catalog();
  return { catalog: eff.catalog, overlay: eff, base: (plat) => blockBytes('base-' + plat), backend: offlineInfo.backend || '', embedPlan: true };
}

async function build(body, e, progress) {
  if (e.overlay.applied) progress('Using ' + e.overlay.applied + ' catalogue change' + (e.overlay.applied === 1 ? '' : 's') + ' from this browser');
  const out = await runJob(body, e, progress);
  records.set(out.hash, out.record);
  const res = {
    // Where it was built, for the build page to say so (design.md 11.0
    // item 6): this job never went near a build server.
    built: { where: 'page' },
    record: out.hash,
    files: out.files.map((f) => ({ platform: f.platform, name: f.name, size: f.size, sha256: f.sha256, signed: '', offline: false,
      url: URL.createObjectURL(new Blob([f.data], { type: 'application/octet-stream' })) })),
  };
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
  const j = { id: 'local-' + nextTicket, ticket: nextTicket++, status: 'running', progress: 'Starting', error: '' };
  jobs.set(j.id, j);
  build(body, e, (m) => { j.progress = m; })
    .then((res) => { j.result = res; j.status = 'done'; j.progress = 'Done'; })
    .catch((e) => { j.status = 'failed'; j.error = e && e.message ? e.message : String(e); });
  return view(j);
}

const OFFLINE_ONLY = 'This needs a build server; the page is building installers itself (choose a server at the bottom of the page).';

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
  globalThis.ibLocalApi = { request, url, info: offlineInfo, unpacked: unpackedFolders };
  catalog().catch(() => { /* reported when a build needs it */ });
}
