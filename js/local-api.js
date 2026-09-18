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
//   #ib-catalog   the catalogue snapshot (catalog.Snapshot), gzipped, base64
//   #ib-runtimes  GET /api/catalog/runtimes, JSON
//   #base-windows, #base-linux, #base-macos   the unsigned bases, base64
import { ApiError } from './api.js';
import { loadSnapshot } from './resolve.js';
import { validate, runJob } from './builder.js';

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

let catalogPromise = null;
function catalog() {
  if (!catalogPromise) {
    const b = blockBytes('ib-catalog');
    catalogPromise = b ? loadSnapshot(b) : Promise.reject(new Error('This page has no catalogue inside it.'));
  }
  return catalogPromise;
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
  return { catalog: await catalog(), base: (plat) => blockBytes('base-' + plat), backend: offlineInfo.backend || '', embedPlan: true };
}

async function build(body, progress) {
  const out = await runJob(body, await env(), progress);
  records.set(out.hash, out.record);
  return {
    record: out.hash,
    files: out.files.map((f) => ({ platform: f.platform, name: f.name, size: f.size, sha256: f.sha256, signed: '', offline: false,
      url: URL.createObjectURL(new Blob([f.data], { type: 'application/octet-stream' })) })),
  };
}

async function submit(body) {
  // Checked before queueing, as the server does, so the form shows the error.
  try {
    validate(JSON.parse(JSON.stringify(body)), await env());
  } catch (e) {
    throw new ApiError(e.status || 400, e.message, e.code || 'invalid');
  }
  const j = { id: 'local-' + nextTicket, ticket: nextTicket++, status: 'running', progress: 'Starting', error: '' };
  jobs.set(j.id, j);
  build(body, (m) => { j.progress = m; })
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
  else if (method === 'GET' && p === '/api/catalog/runtimes') out = JSON.parse(block('ib-runtimes') || '{"runtimes":[]}');
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
  globalThis.ibLocalApi = { request, url, info: offlineInfo };
  catalog().catch(() => { /* reported when a build needs it */ });
}
