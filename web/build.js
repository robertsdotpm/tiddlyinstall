// build.html: the live ticket for one job, from #job=<id> in the address
// (so a reload keeps it). Polls GET /api/jobs/{id} every 2 s while it is
// queued or running, less often while the tab is hidden, and rides out
// outages through api.js.
import { apiRequest, absUrl, ApiError, apiBase, apiDefault, apiLocal, errorText, mountApiFooter } from './api.js';
import { ARCH_LABEL, MAC_ARCH, FAMILY_ARCHES, archCoverage } from '../shared/form-job.js';
import { mountOverlayConsent } from './overlay-consent.js';
import { mirrorGapBuildWarning } from '../shared/mirror-words.js';

mountApiFooter();
mountOverlayConsent();

const $ = (id) => document.getElementById(id);
const POLL_MS = 2000;
const HIDDEN_MAX_MS = 30000;

function jobId() {
  const h = new URLSearchParams(location.hash.slice(1));
  return h.get('job') || h.get('ticket') || '';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

export function humanSize(n) {
  if (n == null || isNaN(n)) return '';
  if (n < 1024) return n + ' B';
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}

function humanEta(s) {
  if (s == null) return 'Not known yet';
  if (s <= 1) return 'Any moment';
  if (s < 90) return 'About ' + Math.round(s) + ' s';
  if (s < 5400) return 'About ' + Math.round(s / 60) + ' min';
  return 'About ' + (s / 3600).toFixed(1) + ' h';
}

const PLATFORM = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

// 32-bit and 64-bit on the downloads (docs/format.md section 3, "32-bit and
// 64-bit, said plainly"). An ordinary online installer is not built for one
// architecture: it carries a plan block per architecture and picks on the
// computer it runs on, so the honest thing to show is the set it covers and
// when the choice is made. What that set is depends on the runtime -- Go
// has a 32-bit Linux build, Python doesn't -- so it is read from the
// catalogue for this job's runtime, never assumed. Until it has been read,
// the column says the choice is made on the machine and nothing more,
// rather than naming architectures that may not exist.
//
// An offline installer had to choose at build time, so it says which ones
// it packed, from `arches` on the file where the backend gives it.

// The runtime of this job's record, and the catalogue's answer for it.
// Both are fetched once and reused; a failure leaves the honest fallback.
let archCov = null;          // {windows: {...}, ...} from shared/form-job.js
let archLabel = '';          // the runtime's display name
let archFor = '';            // the record it was worked out for

async function loadArch(record) {
  if (!record || archFor === record) return;
  archFor = record;
  const rec = await apiRequest('/api/records/' + encodeURIComponent(record), { as: 'text' });
  const m = /^runtime\t(\S+)$/m.exec(String(rec));
  if (!m) return;
  const cat = await apiRequest('/api/catalog/runtimes');
  const entry = (cat && Array.isArray(cat.runtimes) ? cat.runtimes : []).find((r) => r && r.id === m[1]);
  if (!entry) return;
  archCov = archCoverage(entry);
  archLabel = entry.label || m[1];
}

function archCell(f) {
  const list = Array.isArray(f.arches) ? f.arches.filter((a) => typeof a === 'string') : null;
  if (list && list.length) {
    return '<span>' + esc(list.map((a) => ARCH_LABEL[a] || a).join(', ')) + '</span>' +
      (f.offline ? '<br><span class="muted">Packed in this file</span>' : '');
  }
  if (f.offline) return '<span class="muted">The packed ones; the installer\'s review screen lists them before it installs</span>';
  const cov = archCov && archCov[f.platform];
  if (!cov) return '<span class="muted">Chosen on the computer it runs on</span>';
  const have = FAMILY_ARCHES[f.platform].filter((a) => cov[a].ok);
  if (!have.length) return '<span class="muted">Chosen on the computer it runs on</span>';
  const names = have.map((a) => (f.platform === 'macos' ? MAC_ARCH[a] || ARCH_LABEL[a] : ARCH_LABEL[a]));
  // A build that is behind what the family reaches is worth saying here
  // too: it is the last screen before someone hands the file over.
  const behind = have.filter((a) => cov[a].behind);
  let out = esc(names.join(', ')) + '<br><span class="muted">Chosen on the computer</span>';
  if (behind.length) {
    out += '<br><span class="arch-ceiling">' + esc(behind.map((a) => ARCH_LABEL[a] + ' gets ' + archLabel + ' ' +
      cov[a].newest + ', not ' + cov[a].behind).join('; ')) + '</span>';
  }
  const missing = FAMILY_ARCHES[f.platform].filter((a) => !cov[a].ok);
  if (missing.length) {
    out += '<br><span class="muted">No build for ' + esc(missing.map((a) =>
      (f.platform === 'macos' ? MAC_ARCH[a] || ARCH_LABEL[a] : ARCH_LABEL[a])).join(', ')) + '</span>';
  }
  return out;
}
const STATUS = {
  queued: ['Queued', 'pending'],
  running: ['Building', 'running'],
  done: ['Ready', 'ok'],
  failed: ['Failed', 'fail'],
};
const CLASS = {
  record: 'Settings and signed installers: usually seconds',
  build: 'Installers with your settings inside: usually seconds',
  pack: 'Packing downloads into installers: usually minutes',
};

/* Progress lines seen so far, kept per job for the length of the tab. */
let steps = [];
function loadSteps(id) {
  try { steps = JSON.parse(sessionStorage.getItem('ti.steps.' + id) || '[]'); } catch (e) { steps = []; }
}
function saveSteps(id) {
  try { sessionStorage.setItem('ti.steps.' + id, JSON.stringify(steps)); } catch (e) { /* ignore */ }
}

function paintSteps(job) {
  // Once finished, the last progress text is just "Done"; don't list it.
  if (job.progress && job.status !== 'done' && steps[steps.length - 1] !== job.progress) {
    steps.push(job.progress);
    saveSteps(job.id);
  }
  const list = steps.length ? steps.slice() : [job.status === 'queued' ? 'Waiting for a free worker' : 'Starting'];
  if (job.status === 'done') list.push('Installers ready');
  const last = list.length - 1;
  $('job-steps').innerHTML = list.map((t, i) => {
    let cls = 'ok', label = 'Done';
    if (i === last) {
      if (job.status === 'failed') { cls = 'fail'; label = 'Failed'; }
      else if (job.status === 'queued') { cls = 'pending'; label = 'Waiting'; }
      else if (job.status === 'running') { cls = 'running'; label = 'Working…'; }
    }
    return '<li><span>' + esc(t) + '</span><span class="status ' + cls + '">' + label + '</span></li>';
  }).join('');
}

function paintFiles(job) {
  const res = job.result;
  const files = res && Array.isArray(res.files) ? res.files : [];
  $('job-downloads').hidden = !files.length;
  $('job-files').innerHTML = files.map((f) => {
    const url = absUrl(f.url);   // '' if the backend gave a non-http(s) URL
    const name = '<code>' + esc(f.name) + '</code>';
    const link = url ? '<a href="' + esc(url) + '" download="' + esc(f.name) + '">' + name + '</a>' : name;
    let signed = f.signed;
    if (!signed) signed = f.platform === 'linux' ? 'Not needed on Linux' : 'Unsigned';
    // How to run a `.run`, ready to copy. A browser download has no
    // executable bit and GNOME will not run a text file, so a
    // double-click opens the installer in an editor; `sh <file>` needs
    // no bit and no chmod, and works on a fresh download. The file's
    // own first lines say the same thing to whoever gets there first
    // (installer/unix/ti-engine.sh).
    const how = f.platform === 'linux'
      ? '<br><span class="muted">In a terminal: <code>sh ' + esc(f.name) + '</code></span>'
      : '';
    return '<tr><td>' + link +
      (f.sha256 ? '<br><span class="muted sha">SHA-256 <code>' + esc(f.sha256) + '</code></span>' : '') + how + '</td>' +
      '<td>' + esc(PLATFORM[f.platform] || f.platform) + '</td>' +
      '<td class="arch-col">' + archCell(f) + '</td>' +
      '<td>' + esc(humanSize(f.size)) + '</td>' +
      '<td>' + esc(signed) + '</td></tr>';
  }).join('');
  const note = $('job-arch');
  if (note) {
    const off = files.some((f) => f.offline);
    note.textContent = files.length
      ? 'Each of these installers covers every architecture listed beside it, from the one file: it carries an install plan per ' +
        'architecture and picks on the computer it runs on, and its review screen says which one it chose and why before it installs.' +
        (off ? ' An offline installer had to choose when it was built, so it only carries the architectures that were packed into it.' : '')
      : '';
  }
  const rec = $('job-record');
  if (res && res.record) {
    rec.hidden = false;
    rec.innerHTML = 'Settings record <a href="' + esc(absUrl('/api/records/' + encodeURIComponent(res.record))) +
      '"><code>' + esc(res.record) + '</code></a>. Installers signed by TiddlyInstall fetch it at install time and check it against the hash in their name.';
  } else rec.hidden = true;
}

function paintBackend() {
  // Make a non-default backend visible: a build (and its download links) came
  // from whatever ?api= or saved server this page points at, which a phishing
  // link could have set. The footer lets people change it back.
  const b = $('job-backend');
  if (!b) return;
  if (apiBase() !== apiDefault() && !apiLocal()) {
    b.textContent = 'This build and its downloads come from ' + apiBase() +
      ', not the default build server. If you did not choose that, change it at the bottom of the page before downloading anything.';
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

// Where this build happened: in the page, or on a build server (design.md
// 11.0 item 6). It comes from the job, not from what the page is pointed at
// now: a job the page built itself says so in its result (web/local-api.js
// `built`), and its id begins with "local-". Plain text, so a saved copy of
// this page still says the same thing, and short enough for a phone.
function paintWhere(job) {
  const built = job.result && job.result.built;
  const inPage = (built && built.where === 'page') || /^local-/.test(String(job.id || '')) || apiLocal();
  const host = String(apiBase()).replace(/^https?:\/\//, '');
  const done = job.status === 'done' || job.status === 'failed';
  const where = inPage ? 'in this page' : 'by the build server at ' + host;
  const w = $('job-where');
  if (w) w.textContent = (done ? 'Built ' : 'Being built ') + where + '.';
  const b = $('job-built');
  if (b) {
    b.textContent = inPage
      ? 'These installers were built in this page, by your browser. They were never on a build server.'
      : 'These installers were built by the build server at ' + host + ', and downloaded from it.';
  }
}

// Made with catalogue changes from this browser (web/local-api.js).
function paintCatalog(job) {
  const b = $('job-catalog');
  if (!b) return;
  const c = job.result && job.result.catalog;
  if (c && c.changed) {
    const n = Number(c.changes) || 0;
    b.textContent = 'Made with a changed catalogue: ' + n + ' change' + (n === 1 ? '' : 's') + ' made in this browser on the Sources page. ' +
      'What these installers download and run comes from the plan inside them, and their review screens show it in full before installing.';
    b.hidden = false;
  } else b.hidden = true;
}

// Downloads our mirror has no copy of (design.md 1.3, shared/mirror-words.js).
// The publisher is the one who can still choose another version, so they
// are told here as well as on the installer's review screen, in the same
// words. Nothing is said when the mirror has everything, which is the
// normal case.
function paintMirror(job) {
  const b = $('job-mirror');
  if (!b) return;
  const u = job.result && Array.isArray(job.result.unmirrored) ? job.result.unmirrored : [];
  if (u.length) {
    b.textContent = mirrorGapBuildWarning(u.map((f) => f.name));
    b.hidden = false;
  } else b.hidden = true;
}

function paint(job) {
  $('job-view').hidden = false;
  $('job-error').hidden = true;
  paintBackend();
  paintWhere(job);
  paintCatalog(job);
  paintMirror(job);
  const title = job.ticket != null ? 'Build #' + job.ticket : 'Build';
  $('job-title').textContent = title;
  document.title = title + ' · TiddlyInstall';

  const [label, cls] = STATUS[job.status] || [job.status || 'Unknown', 'pending'];
  const st = $('job-status');
  st.textContent = label;
  st.className = 'status big-number ' + cls;

  let pos;
  if (job.status === 'queued') {
    pos = job.position > 0 ? job.position + ' ahead of you' : "You're next";
  } else if (job.status === 'running') pos = 'Being built now';
  else pos = '-';
  $('job-position').textContent = pos;
  $('job-class').textContent = CLASS[job.class] || '';

  $('job-eta').textContent = job.status === 'done' ? 'Done' : job.status === 'failed' ? '-' : humanEta(job.eta_seconds);

  paintSteps(job);
  paintFiles(job);
  // What the installers cover comes from the job's runtime, so it needs the
  // record and the catalogue: fetched once, then the downloads are drawn
  // again with it. Until then they say the choice is made on the machine,
  // which is true whatever the answer turns out to be.
  const rec0 = job.result && job.result.record;
  if (rec0 && archFor !== rec0) {
    loadArch(rec0).then(() => { if (archCov) paintFiles(job); }).catch(() => { /* the fallback wording stands */ });
  }

  if (job.status === 'failed') {
    showError('The build failed: ' + (job.error || 'no reason given') + '. Change the settings and try again.');
  }
}

function showError(msg) {
  const e = $('job-error');
  e.textContent = msg;
  e.hidden = !msg;
}

/* ---------- polling ---------- */

let timer = null;
let hiddenDelay = POLL_MS;
let pollSeq = 0;
let finished = false;

function schedule() {
  clearTimeout(timer);
  if (finished) return;
  let delay = POLL_MS;
  if (document.hidden) {
    hiddenDelay = Math.min(HIDDEN_MAX_MS, hiddenDelay * 2);
    delay = hiddenDelay;
  } else hiddenDelay = POLL_MS;
  timer = setTimeout(poll, delay);
}

async function poll() {
  clearTimeout(timer);
  const id = jobId();
  const seq = ++pollSeq;
  if (!id) return;
  try {
    const job = await apiRequest('/api/jobs/' + encodeURIComponent(id));
    if (seq !== pollSeq) return;          // a newer poll (or job) took over
    paint(job);
    finished = job.status === 'done' || job.status === 'failed';
  } catch (e) {
    if (seq !== pollSeq) return;
    if (e instanceof ApiError && e.status === 404) {
      $('job-view').hidden = true;
      showError(apiLocal() ? e.message : 'No build with id ' + id + ' on ' + apiBase() + '. It may have expired, or this page is pointed at a different build server (see the bottom of the page).');
      finished = true;
      return;
    }
    showError('Couldn\'t get this build\'s status: ' + errorText(e));
  }
  schedule();
}

function start() {
  const id = jobId();
  finished = false;
  if (!id) {
    $('no-job').hidden = false;
    $('job-view').hidden = true;
    return;
  }
  $('no-job').hidden = true;
  loadSteps(id);
  poll();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !finished && jobId()) poll();
});
window.addEventListener('hashchange', start);
window.addEventListener('ti-api-change', () => { if (jobId()) start(); });

start();
