// build.html: the live ticket for one job, from #job=<id> in the address
// (so a reload keeps it). Polls GET /api/jobs/{id} every 2 s while it is
// queued or running, less often while the tab is hidden, and rides out
// outages through api.js.
import { apiRequest, absUrl, ApiError, apiBase, apiDefault, errorText, mountApiFooter } from './api.js';

mountApiFooter();

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
  try { steps = JSON.parse(sessionStorage.getItem('ib.steps.' + id) || '[]'); } catch (e) { steps = []; }
}
function saveSteps(id) {
  try { sessionStorage.setItem('ib.steps.' + id, JSON.stringify(steps)); } catch (e) { /* ignore */ }
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
    return '<tr><td>' + link +
      (f.sha256 ? '<br><span class="muted sha">SHA-256 <code>' + esc(f.sha256) + '</code></span>' : '') + '</td>' +
      '<td>' + esc(PLATFORM[f.platform] || f.platform) + '</td>' +
      '<td>' + esc(humanSize(f.size)) + '</td>' +
      '<td>' + esc(signed) + '</td></tr>';
  }).join('');
  const rec = $('job-record');
  if (res && res.record) {
    rec.hidden = false;
    rec.innerHTML = 'Settings record <a href="' + esc(absUrl('/api/records/' + encodeURIComponent(res.record))) +
      '"><code>' + esc(res.record) + '</code></a>. Installers signed by Installer Builder fetch it at install time and check it against the hash in their name.';
  } else rec.hidden = true;
}

function paintBackend() {
  // Make a non-default backend visible: a build (and its download links) came
  // from whatever ?api= or saved server this page points at, which a phishing
  // link could have set. The footer lets people change it back.
  const b = $('job-backend');
  if (!b) return;
  if (apiBase() !== apiDefault()) {
    b.textContent = 'This build and its downloads come from ' + apiBase() +
      ', not the default build server. If you did not choose that, change it at the bottom of the page before downloading anything.';
    b.hidden = false;
  } else {
    b.hidden = true;
  }
}

function paint(job) {
  $('job-view').hidden = false;
  $('job-error').hidden = true;
  paintBackend();
  const title = job.ticket != null ? 'Build #' + job.ticket : 'Build';
  $('job-title').textContent = title;
  document.title = title + ' · Installer Builder';

  const [label, cls] = STATUS[job.status] || [job.status || 'Unknown', 'pending'];
  const st = $('job-status');
  st.textContent = label;
  st.className = 'status big-number ' + cls;

  let pos;
  if (job.status === 'queued') {
    pos = job.position > 0 ? job.position + ' ahead of you' : "You're next";
  } else if (job.status === 'running') pos = 'Being built now';
  else pos = '—';
  $('job-position').textContent = pos;
  $('job-class').textContent = CLASS[job.class] || '';

  $('job-eta').textContent = job.status === 'done' ? 'Done' : job.status === 'failed' ? '—' : humanEta(job.eta_seconds);

  paintSteps(job);
  paintFiles(job);

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
      showError('No build with id ' + id + ' on ' + apiBase() + '. It may have expired, or this page is pointed at a different build server (see the bottom of the page).');
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
window.addEventListener('ib-api-change', () => { if (jobId()) start(); });

start();
