// The one client for the server (docs/api.md).
//
// Which server: `?api=` on the page URL, else the one saved in this browser,
// else the default: this page's own origin when the server is serving
// it, otherwise DEFAULT_REMOTE. The settings panel (mountApiFooter) shows it
// and lets people change it, like netstats on warpgate.io.
//
// Every call goes through apiRequest(). A network error or a 5xx marks the
// server as down: a banner says so, /api/health is polled with backoff
// (1, 2, 4 ... 60 s, with jitter), and every waiting call resumes by itself
// once the server answers again. Nothing on the page is reset, so a form
// being submitted keeps its contents. A 4xx is the caller's problem: it is
// thrown as an ApiError carrying the server's {error, code}.

import { mountDialog } from './dialog.js';

export const DEFAULT_REMOTE = 'http://10.0.1.76:8080';
// The site is one file (tools/build_site.py, plan.md section 1.11) that
// also carries its own builder, src/web_client/local-api.js, as globalThis.tiLocalApi.
// LOCAL as the backend means "no server: this page answers every
// call itself". Opened from disk, the page starts that way.
export const LOCAL = 'local';
const HAS_LOCAL = !!globalThis.TI_HAS_LOCAL;
// The page's pages are sections of one file (#new, #build&job=...).
const ONE_FILE = !!globalThis.TI_ONE_FILE;
// The name "Save this page" suggests.
export const SAVE_AS = 'tiddlyinstall.html';
const API_KEY = 'ti.api';
const SAME_ORIGIN_KEY = 'ti.api.sameorigin';
const REQUEST_TIMEOUT_MS = 20000;

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message || ('HTTP ' + status));
    this.status = status;
    this.code = code || '';
  }
}

/* ---------- which backend ---------- */

function readStoredApi() {
  try { return localStorage.getItem(API_KEY) || ''; } catch (e) { return ''; }
}
function readParamApi() {
  try { return new URLSearchParams(location.search).get('api') || ''; } catch (e) { return ''; }
}

// 'host:port' is accepted as readily as a full URL. Returns an origin-ish
// URL with no trailing slash, or null.
export function normalizeApi(v) {
  v = (v || '').trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = 'http://' + v;
  let u;
  try { u = new URL(v); } catch (e) { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

const pageIsHttp = typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
const localOk = (v) => (HAS_LOCAL && String(v || '').trim() === LOCAL ? LOCAL : null);
const explicitApi = localOk(readParamApi()) || normalizeApi(readParamApi()) || localOk(readStoredApi()) || normalizeApi(readStoredApi());
// Opened from disk (or any non-http page) with its own builder: no server.
let defaultApi = HAS_LOCAL && !pageIsHttp ? LOCAL : DEFAULT_REMOTE;
let apiBaseUrl = explicitApi || defaultApi;

// True when this page builds installers itself (no server).
export function apiLocal() { return apiBaseUrl === LOCAL; }

// Has the server now chosen actually answered this page? Set only
// where we truly learn it (a reply to a request, a health check, or the
// same-origin probe), and cleared whenever the chosen server changes.
// buildWhere() below is why it exists: the header must not claim a server
// is up because it is written down somewhere.
let serverSeen = false;

// Where installers are built, as far as we honestly know it. One answer,
// shared by the header indicator (mountApiFooter), the outage banner and
// the "Built in this page / by the server" lines on the forms, so
// the three of them cannot disagree:
//
//   'page'     no server: this page builds installers itself
//   'up'       the chosen server has answered us
//   'down'     it cannot be reached -- exactly when the banner is showing
//   'unknown'  a server is chosen, but nothing has asked it yet
//
// 'unknown' is not a slower 'up'. probeSameOrigin only ever asks this
// page's own origin, so a server typed into the settings panel is
// genuinely unchecked until a call goes to it, and a tick we have not
// earned is the kind of quiet lie this project exists not to tell.
export function buildWhere() {
  if (apiLocal()) return 'page';
  if (isDown) return 'down';
  return serverSeen ? 'up' : 'unknown';
}

// A copy saved to someone's disk has no server and did not choose
// that: it is the one file, off an http(s) page. The indicator says so as
// a fact rather than dressing it up as a setting.
export function buildWhereFixed() {
  return apiLocal() && ONE_FILE && !pageIsHttp;
}

// This page was opened from disk, not served. A copy saved to someone's
// disk promises that nothing but a package registry lookup ever leaves
// it, so the things the page would otherwise ask the internet -- the
// GitHub API, for one -- are not asked from here (src/web_client/local-api.js).
export function pageFromDisk() { return !pageIsHttp; }

// A job this page built itself (files from the user's computer are, even
// with a server) and its record are answered by the page.
function localPath(path) {
  if (!HAS_LOCAL || !globalThis.tiLocalApi) return false;
  if (/^\/api\/jobs\/local-/.test(path)) return true;
  return !!globalThis.tiLocalApi.url(path);
}

// Sends a job to this page's own builder, whatever the backend.
export function localSubmit(body) {
  return globalThis.tiLocalApi.request('/api/jobs', { method: 'POST', body });
}
let readyPromise = null;

// Is this page served by a server? Asked once per tab, and only when
// nothing more specific was chosen.
async function probeSameOrigin() {
  let cached = null;
  try { cached = sessionStorage.getItem(SAME_ORIGIN_KEY); } catch (e) { /* ignore */ }
  if (cached === '1') return true;
  if (cached === '0') return false;
  let yes = false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const r = await fetch(location.origin + '/api/health', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (r.ok) {
      const j = await r.json();
      yes = !!(j && j.ok);
    }
  } catch (e) { yes = false; }
  try { sessionStorage.setItem(SAME_ORIGIN_KEY, yes ? '1' : '0'); } catch (e) { /* ignore */ }
  return yes;
}

// Resolves once the backend URL is settled (instant unless we have to probe).
export function apiReady() {
  if (!readyPromise) {
    readyPromise = (async () => {
      if (pageIsHttp && await probeSameOrigin()) {
        defaultApi = location.origin;
        if (!explicitApi) apiBaseUrl = defaultApi;
        // The probe asked this origin and it answered, so if that is the
        // server we are using, it is checked. Any other one is not.
        if (apiBaseUrl === location.origin) serverSeen = true;
      }
      paintMode();
      paintApiFooter();
      return apiBaseUrl;
    })();
  }
  return readyPromise;
}

export function apiBase() { return apiBaseUrl; }
export function apiDefault() { return defaultApi; }

// A backend-relative path ("/dl/x") as an absolute URL. An absolute value from
// the server (a download URL) is only trusted when it is http(s): a hostile
// backend chosen with ?api= must not be able to smuggle a javascript:/data:
// link onto the page. Anything else, or a value that isn't a URL, returns ''.
export function absUrl(path) {
  if (!path) return '';
  if (apiLocal() || (HAS_LOCAL && /^blob:/i.test(path)) || localPath(path)) {
    // Only what this page made: blob: URLs, and paths it can answer.
    if (/^blob:/i.test(path)) return path;
    return globalThis.tiLocalApi ? globalThis.tiLocalApi.url(path) : '';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return /^https?:\/\//i.test(path) ? path : '';
  }
  return apiBaseUrl + (path.startsWith('/') ? '' : '/') + path;
}

export function setApiBase(url) {
  // A different server is a server nobody has asked yet.
  if (url !== apiBaseUrl) serverSeen = false;
  apiBaseUrl = url;
  paintMode();
  try {
    if (url === defaultApi) localStorage.removeItem(API_KEY);
    else localStorage.setItem(API_KEY, url);
  } catch (e) { /* private browsing: the choice won't outlive the tab */ }
  paintApiFooter();
  if (banner) banner.querySelector('.api-url').textContent = apiBaseUrl;
  window.dispatchEvent(new CustomEvent('ti-api-change', { detail: { url } }));
  // A new server deserves an immediate try rather than the old backoff;
  // this page's own builder is never down.
  if (isDown) {
    if (url === LOCAL) markUp();
    else tryNow();
  }
}

/* ---------- down / up ---------- */

let isDown = false;
let upWaiters = [];
let failures = 0;
let retryAt = 0;
let retryTimer = null;
let tickTimer = null;
let banner = null;

function backoffMs(n) {
  const base = Math.min(60, Math.pow(2, Math.max(0, n - 1)));   // 1, 2, 4 ... 60
  const jitter = 0.8 + Math.random() * 0.4;                     // +-20%
  return Math.round(base * jitter * 1000);
}

function ensureBanner() {
  if (banner) return banner;
  banner = document.createElement('div');
  banner.className = 'api-banner';
  banner.setAttribute('role', 'status');
  banner.hidden = true;
  banner.innerHTML =
    '<span class="api-banner-text">Can\'t reach the server at <code class="api-url"></code>. ' +
    '<span class="api-wait"></span></span> ' +
    '<button type="button" class="secondary api-try">Try now</button>' +
    (HAS_LOCAL ? ' <button type="button" class="secondary api-use-local">Build in this page instead</button>' : '');
  banner.querySelector('.api-try').addEventListener('click', tryNow);
  if (HAS_LOCAL) banner.querySelector('.api-use-local').addEventListener('click', () => setApiBase(LOCAL));
  document.body.prepend(banner);
  return banner;
}

function paintBanner() {
  const b = ensureBanner();
  b.querySelector('.api-url').textContent = apiBaseUrl;
  const wait = b.querySelector('.api-wait');
  if (retryAt === -1) {
    wait.textContent = 'Checking…';
  } else {
    const s = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    wait.textContent = 'Trying again in ' + s + ' s…';
  }
  b.hidden = false;
}

function markDown() {
  if (!isDown) {
    isDown = true;
    failures = 0;
    document.documentElement.classList.add('api-down');
    paintWhereChip();
    scheduleHealth();
  }
}

function markUp() {
  // Every caller of this has just had an answer from the server, which is
  // the only thing that earns the header's tick.
  if (!apiLocal() && !serverSeen) {
    serverSeen = true;
    paintWhereChip();
  }
  if (!isDown) return;
  isDown = false;
  failures = 0;
  clearTimeout(retryTimer);
  clearInterval(tickTimer);
  retryTimer = tickTimer = null;
  if (banner) banner.hidden = true;
  document.documentElement.classList.remove('api-down');
  paintWhereChip();
  const w = upWaiters;
  upWaiters = [];
  w.forEach((f) => f());
  window.dispatchEvent(new CustomEvent('ti-api-up'));
}

function scheduleHealth() {
  failures += 1;
  retryAt = Date.now() + backoffMs(failures);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(checkHealth, retryAt - Date.now());
  if (!tickTimer) tickTimer = setInterval(paintBanner, 500);
  paintBanner();
}

async function checkHealth() {
  clearTimeout(retryTimer);
  retryAt = -1;
  paintBanner();
  let ok = false;
  try {
    const r = await timedFetch(apiBaseUrl + '/api/health', { cache: 'no-store' });
    ok = r.status < 500;
  } catch (e) { ok = false; }
  if (ok) markUp();
  else if (isDown) scheduleHealth();
}

export function tryNow() {
  if (isDown) checkHealth();
}

export function apiIsDown() { return isDown; }

function whenUp() {
  if (!isDown) return Promise.resolve();
  return new Promise((res) => upWaiters.push(res));
}

async function timedFetch(url, opts) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
  } finally {
    clearTimeout(t);
  }
}

/* ---------- the one request function ---------- */

// apiRequest('/api/jobs', {method: 'POST', body: {...}}) -> parsed JSON.
// Waits through outages; throws ApiError on 4xx. `as: 'text'` or 'bytes'
// returns the body as a string or Uint8Array instead.
export async function apiRequest(path, opts = {}) {
  await apiReady();
  if (apiLocal() || localPath(path)) return globalThis.tiLocalApi.request(path, opts);
  for (;;) {
    await whenUp();
    // Switched to this page's own builder while waiting for a server.
    if (apiLocal()) return globalThis.tiLocalApi.request(path, opts);
    const init = { method: opts.method || 'GET', cache: 'no-store', headers: {} };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      // A cross-origin JSON POST is preflighted; the API answers OPTIONS.
      init.headers['Content-Type'] = 'application/json';
    }
    let r;
    try {
      r = await timedFetch(absUrl(path), init);
    } catch (e) {
      markDown();
      continue;
    }
    if (r.status >= 500 || r.status === 429) {
      if (r.status === 429) {
        // Rate limited: not an outage, just wait and retry quietly.
        const ra = parseInt(r.headers.get('Retry-After') || '5', 10);
        await new Promise((res) => setTimeout(res, Math.min(60, Math.max(1, ra || 5)) * 1000));
      } else {
        markDown();
      }
      continue;
    }
    if (!r.ok) {
      let msg = '', code = '';
      try {
        const j = await r.json();
        msg = j.error || '';
        code = j.code || '';
      } catch (e) { /* not JSON */ }
      throw new ApiError(r.status, msg || (r.status + ' ' + r.statusText), code);
    }
    // A good answer also proves the server is up for anyone still waiting.
    markUp();
    if (opts.as === 'text') return r.text();
    if (opts.as === 'bytes') return new Uint8Array(await r.arrayBuffer());
    if (r.status === 204) return null;
    return r.json();
  }
}

// Human text for an error from apiRequest, for showing on the page.
export function errorText(e) {
  if (e instanceof ApiError) {
    return e.message + (e.code ? ' (' + e.code + ')' : '');
  }
  return String(e && e.message ? e.message : e);
}

/* ---------- footer control ---------- */

let footerEl = null;
let whereEl = null;

function prettyHost(u) {
  return String(u).replace(/^https?:\/\//, '');
}
function prettyApi(u) {
  return u === LOCAL ? 'none, this page builds installers itself' : prettyHost(u);
}

// Which features show: html.ti-local hides what needs a server (mode
// A, packing runtimes, the timestamp relay; src/web_client/css/style.css .online-only).
function paintMode() {
  document.documentElement.classList.toggle('ti-local', apiLocal());
  document.documentElement.classList.toggle('ti-has-local', HAS_LOCAL);
}

/* ---------- the header indicator ---------- */

// A mark per state, because colour is the first thing to go: a reader who
// cannot tell green from red, and the floor's browsers without custom
// properties, both get the shape. Each one is a different silhouette, not
// a different colour of the same dot.
const WHERE_MARKS = {
  // A window: the page itself.
  page: '<rect x="1.6" y="2.6" width="12.8" height="10.8"/><line x1="1.6" y1="6.2" x2="14.4" y2="6.2"/>',
  up: '<circle cx="8" cy="8" r="6.2"/><polyline points="5.1,8.2 7.1,10.3 10.9,5.8"/>',
  down: '<circle cx="8" cy="8" r="6.2"/><line x1="5.7" y1="5.7" x2="10.3" y2="10.3"/><line x1="10.3" y1="5.7" x2="5.7" y2="10.3"/>',
  // Dashed, and a question mark: nothing has been established.
  unknown: '<circle cx="8" cy="8" r="6.2" stroke-dasharray="2.3 1.9"/>' +
    '<text x="8" y="11.4" text-anchor="middle" font-size="9" font-weight="700" fill="currentColor" stroke="none">?</text>'
};
const WHERE_WORDS = { up: 'reachable', down: 'not reachable', unknown: 'not checked' };
const WHERE_SAID = {
  up: 'reachable: it has answered this page, and it builds the installers.',
  down: 'not reachable. Until it answers, nothing can be built there.',
  unknown: 'not checked. Nothing has asked it yet, so whether it answers is not known.'
};

function mountWhere(parent) {
  whereEl = document.createElement('button');
  whereEl.type = 'button';
  whereEl.className = 'where-chip';
  whereEl.setAttribute('aria-haspopup', 'true');
  whereEl.setAttribute('aria-expanded', 'false');
  whereEl.innerHTML =
    '<span class="where-mark" aria-hidden="true"></span>' +
    '<span class="where-host"></span><span class="where-state"></span>';
  // Inside the control, before the panel it opens: in reading order, and
  // so a click on either counts as a click inside.
  parent.insertBefore(whereEl, parent.firstChild);
  return whereEl;
}

// Says where installers are being built, on every page, in the header. It
// reads buildWhere() and nothing else, so it cannot drift from the banner.
function paintWhereChip() {
  if (!whereEl) return;
  const state = buildWhere();
  const fixed = buildWhereFixed();
  whereEl.className = 'where-chip where-' + state + (fixed ? ' where-fixed' : '');
  whereEl.querySelector('.where-mark').innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
    WHERE_MARKS[state] + '</svg>';
  const host = whereEl.querySelector('.where-host');
  const word = whereEl.querySelector('.where-state');
  let said;
  if (state === 'page') {
    host.textContent = 'Built in this page';
    word.textContent = '';
    said = fixed
      ? 'Built in this page. This is a saved copy, so there is no server: your browser makes the installers.'
      : 'Built in this page. No server is chosen, so your browser makes the installers.';
  } else {
    // Same origin: the host is in the address bar already, so naming it
    // again says less than saying whose it is.
    host.textContent = apiSameOrigin() ? 'Server: this site' : 'Server ' + prettyHost(apiBaseUrl);
    word.textContent = WHERE_WORDS[state];   // its separator is in the CSS
    said = 'Server ' + apiBaseUrl + (apiSameOrigin() ? ' (this site) is ' : ' is ') + WHERE_SAID[state];
  }
  whereEl.title = said;
  whereEl.setAttribute('aria-label', said + ' Open settings.');
}

// How old is the catalogue baked into this page, and does it matter yet?
//
// Only with no server: with one, the build is resolved against that
// server's live catalogue and this copy's age does not come into it. So
// the line appears exactly where it is actionable, and the action is the
// control it sits under.
//
// The page cannot fetch a fresher one -- that is the whole point -- so
// this says the age and where a current one comes from, and nothing else.
function pageBuilt() {
  try {
    const n = document.getElementById('ti-offline');
    const d = JSON.parse(n.textContent);
    return String(d.built || '');
  } catch (e) { return ''; }
}

function daysSince(iso) {
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso + 'T00:00:00Z' : iso);
  if (!isFinite(t)) return -1;
  return Math.floor((Date.now() - t) / 86400000);
}

function paintCatalogueAge() {
  const line = footerEl && footerEl.querySelector('.settings-age');
  const note = footerEl && footerEl.querySelector('.settings-age-note');
  if (!line || !note) return;
  const built = pageBuilt();
  const days = built ? daysSince(built) : -1;
  if (!apiLocal() || days < 0) { line.hidden = true; note.hidden = true; return; }
  line.hidden = false;
  const age = days <= 0 ? 'today' : days === 1 ? 'yesterday' : days + ' days old';
  line.textContent = 'Runtime list in this page: ' + built + ' (' + age + '). ';
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'link-button';
  more.textContent = 'Why it matters';
  more.addEventListener('click', () => {
    note.hidden = !note.hidden;
    more.textContent = note.hidden ? 'Why it matters' : 'Hide';
  });
  line.appendChild(more);
  note.textContent = 'With no server, your installers are built from this list, and a copy of ' +
    'this page can only ever know what it knew when it was saved. Newer runtime versions, and ' +
    'anything withdrawn since, are not in it. Choose a server and builds are worked out ' +
    'against a current one instead.';
}

// Is the server this page's own origin? That is the difference between
// one trust decision and two: served from the same domain, trusting the
// page *is* trusting the server. Opened from disk there is no origin to
// match, and apiLocal() has already answered.
export function apiSameOrigin() {
  try { return !apiLocal() && apiBaseUrl === location.origin; } catch (e) { return false; }
}

function paintApiFooter() {
  paintWhereChip();
  if (!footerEl) return;
  const a = footerEl.querySelector('.api-ctl-url');
  if (apiLocal()) {
    a.removeAttribute('href');
  } else {
    a.href = apiBaseUrl + '/api/health';
  }
  a.textContent = prettyApi(apiBaseUrl);
  a.title = apiBaseUrl === defaultApi ? apiBaseUrl + ' (default)' : apiBaseUrl + ' (chosen)';
  paintCatalogueAge();
  const same = footerEl.querySelector('.settings-same');
  if (same) {
    same.hidden = !apiSameOrigin();
    same.textContent = 'Served from this site, so trusting this page is trusting the server -- ' +
      'one decision, not two.';
  }
}

// What the server is for, behind a link in the settings panel rather than
// in it: the panel is a place to change an address, and the answer to
// "what do I lose without one" is six lines that would swamp it. The
// wording is the page's, not ours -- "modes B and C" used to be in that
// hint, and nobody outside this repository knows what a mode is.
const WHAT_PANEL =
  '<div class="api-what-panel" aria-label="What the server does">' +
  '<div class="api-what-box">' +
  '<div class="dialog-head"><strong>What the server does</strong>' +
  '<button type="button" class="dialog-close api-ctl-what-close" aria-label="Close">&#10005;</button></div>' +
  '<ul class="small">' +
  '<li><strong>Builds the installers</strong>, instead of your browser. Mainly useful for offline ' +
  'installers, which carry the runtime inside them and can be too big for a browser to assemble.</li>' +
  '<li><strong>Signs the runtime setup.</strong> Ours is the only key that can, and every ' +
  'installer carries the matching public half -- so a signed setup can be checked by anyone, on any ' +
  'machine, years later, without asking us.</li>' +
  '<li><strong>Passes signing and timestamp requests through.</strong> Those services refuse calls ' +
  'from web pages, so the server forwards them on your behalf.</li>' +
  '<li><strong>Keeps copies of the runtimes</strong>, so an installer can still fetch them on an old ' +
  'machine that cannot make a modern HTTPS connection.</li>' +
  '<li><strong>Hands out the base installers</strong> and the list of runtimes this page offers.</li>' +
  '<li><strong>Answers a plain form</strong>, for browsers that cannot run this page at all.</li>' +
  '</ul>' +
  '<p class="small muted">With no server, your browser does the building. Signing and the relay are the parts it cannot do.</p>' +
  '</div></div>';

// A settings button (a spanner) in the site header opens a small panel
// with the server choice, and beside it an indicator saying where
// installers are being built (mountWhere), which is also what opens the
// panel -- there is no separate settings button: a spanner beside it was a
// second door to the same room, and the indicator has to be there anyway.
// "Save this page" goes in the footer when the page is the one-file site.
// Carries a ?api= from the URL onto links to the site's other pages.
export function mountApiFooter() {
  if (footerEl) return;   // the one-file site's pages share one header
  const header = document.querySelector('.site-header');
  const footer = document.querySelector('.site-footer') || document.body;
  footerEl = document.createElement('div');
  footerEl.className = 'api-ctl settings';
  footerEl.innerHTML =
    '<div class="settings-panel" hidden>' +
    '<p class="settings-now"><span>Server:</span> <a class="api-ctl-url" target="_blank" rel="noopener noreferrer"></a></p>' +
    '<p class="small settings-same" hidden></p>' +
    '<p class="small settings-age" hidden></p>' +
    '<p class="small muted settings-age-note" hidden></p>' +
    '<p class="settings-what"><button type="button" class="link-button api-ctl-what" hidden>' +
    'What does the server&nbsp;do?</button></p>' +
    '<form class="api-ctl-form">' +
    '<label>Server URL <input type="text" class="api-ctl-input" spellcheck="false" autocomplete="off" ' +
    'autocapitalize="off" placeholder="http://host:8080"></label>' +
    '<p class="api-ctl-err" hidden></p>' +
    '<div class="actions">' +
    '<button type="submit">Use</button>' +
    '<button type="button" class="secondary api-ctl-default">Default</button>' +
    (HAS_LOCAL ? '<button type="button" class="secondary api-ctl-local">No server</button>' : '') +
    '<button type="button" class="secondary api-ctl-cancel">Close</button>' +
    '</div>' +
    '<p class="hint">Kept in this browser only, and shareable as <code>?api=</code> on the page URL. ' +
    'A page served over HTTPS can\'t use a plain http:// server.</p>' +
    (HAS_LOCAL ? '<p class="hint">With no server, this page builds the installers itself -- everything ' +
      'except the ones we sign, from code written here, files from this computer, a GitHub repository ' +
      'or a package name.</p>' : '') +
    '</form></div>';
  // Beside the wordmark, not at the end of the nav: it is a statement
  // about the whole application, and among Home / New installer / ... it
  // read as a fifth link. insertBefore(el, null) appends, so a header
  // with no nav still gets it.
  if (header) header.insertBefore(footerEl, header.querySelector('nav'));
  else footer.appendChild(footerEl);
  // On <body>, so nothing above it in the header can trap it in a
  // stacking context.
  const whatWrap = document.createElement('div');
  whatWrap.innerHTML = WHAT_PANEL;
  const whatPanel = whatWrap.firstChild;
  document.body.appendChild(whatPanel);
  mountDialog({
    panel: whatPanel,
    opener: footerEl.querySelector('.api-ctl-what'),
    closers: [whatPanel.querySelector('.api-ctl-what-close')],
  });

  // Where installers are built, and the way to change it.
  mountWhere(footerEl);
  if (header && header.querySelector('nav')) mountMenu(header);
  const panel = footerEl.querySelector('.settings-panel');
  const form = footerEl.querySelector('form');
  const input = footerEl.querySelector('.api-ctl-input');
  const err = footerEl.querySelector('.api-ctl-err');
  const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };
  // The indicator is the control: it says where builds happen and opens
  // the panel that changes it. It is the only way in, so every page that
  // calls mountApiFooter() must get one.
  const setOpen = (open) => {
    panel.hidden = !open;
    whereEl.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      input.value = apiLocal() ? '' : apiBaseUrl;
      input.focus();
      input.select();
    } else showErr('');
  };
  const close = () => setOpen(false);
  const toggle = () => setOpen(panel.hidden);
  whereEl.addEventListener('click', toggle);
  // Closes on Escape or a click outside it.
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) close(); });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !footerEl.contains(e.target)) close();
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const url = localOk(input.value) || normalizeApi(input.value);
    if (!url) { showErr('That is not an http(s) URL.'); return; }
    setApiBase(url);
    close();
  });
  footerEl.querySelector('.api-ctl-default').addEventListener('click', () => {
    setApiBase(defaultApi);
    close();
  });
  if (HAS_LOCAL) {
    footerEl.querySelector('.api-ctl-local').addEventListener('click', () => {
      setApiBase(LOCAL);
      close();
    });
  }
  footerEl.querySelector('.api-ctl-cancel').addEventListener('click', close);
  if (typeof TI_PRISTINE !== 'undefined') {
    const save = document.createElement('p');
    save.className = 'save-ctl';
    save.innerHTML = '<button type="button" class="link-button save-page">Save this page</button> ' +
      '<span class="muted">for one file with everything inside. Opened from your disk it works with no server.</span>' +
      '<span class="muted mobile-only"> On a phone or tablet it goes to your downloads, to copy to a computer: phones may not open a saved page, or run it.</span>';
    footer.appendChild(save);
  }
  // Every "Save this page" button on the page, not only the footer's: the
  // home page has one too, and a button that looks like it saves and does
  // nothing is worse than no button.
  if (typeof TI_PRISTINE !== 'undefined') {
    document.querySelectorAll('.save-page').forEach((b) => b.addEventListener('click', savePage));
  }
  // The build stamp is written into the markup before any of this, so
  // move it to the end now that the footer's own parts are in place.
  // It is the quietest line in the footer and belongs under the rest.
  const stamp = footer.querySelector && footer.querySelector('.build-stamp');
  if (stamp) footer.appendChild(stamp);

  paintMode();
  paintApiFooter();
  apiReady();

  // Keep a ?api= while moving between pages, so a shared link keeps working.
  const p = readParamApi();
  if (p && !ONE_FILE) {
    document.querySelectorAll('a[href]').forEach((a) => {
      const h = a.getAttribute('href');
      if (!/^[\w./-]+\.html(#.*)?$/.test(h)) return;
      const [file, frag] = h.split('#');
      a.setAttribute('href', file + '?api=' + encodeURIComponent(p) + (frag !== undefined ? '#' + frag : ''));
    });
  }
}

// Narrow screens fold the header's nav into a menu (src/web_client/css/style.css, "Phones
// and small screens"): this button opens it; following a link, a click
// elsewhere, Escape or a new section closes it. Wider screens don't show it.
const MENU_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
function mountMenu(header) {
  const nav = header.querySelector('nav');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ti-menu-btn';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-label', 'Menu');
  btn.innerHTML = MENU_ICON;
  nav.appendChild(btn);
  header.classList.add('ti-menu');
  const set = (open) => {
    header.classList.toggle('menu-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  btn.addEventListener('click', () => set(!header.classList.contains('menu-open')));
  nav.addEventListener('click', (e) => { if (e.target.parentNode === nav && e.target.tagName === 'A') set(false); });
  document.addEventListener('click', (e) => { if (!header.contains(e.target)) set(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') set(false); });
  window.addEventListener('hashchange', () => set(false));
}

// Saves the page exactly as it was loaded (TI_PRISTINE, captured before any
// script changed it), so the saved copy is as good as the original. The
// Runtimes page may put this browser's catalogue changes inside it, when
// asked (globalThis.tiPageForSave, src/web_client/catalog-editor.js).
export function savePage() {
  let html = typeof TI_PRISTINE !== 'undefined' ? TI_PRISTINE : '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  if (typeof globalThis.tiPageForSave === 'function') html = globalThis.tiPageForSave(html);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = SAVE_AS;
  document.body.appendChild(a);
  a.click();
  // Safari cancels a download whose blob: URL is revoked too soon (iOS asks
  // first, and fetches the blob only once the person says yes).
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 120000);
}

// A link to another page of the site that keeps ?api= (for navigation from JS).
// In the one-file site the pages are sections: #<page>&<hash>.
export function pageUrl(file, hash) {
  if (ONE_FILE) return '#' + file.replace(/\.html$/, '').replace(/^index$/, 'home') + (hash ? '&' + hash : '');
  const p = readParamApi();
  return file + (p ? '?api=' + encodeURIComponent(p) : '') + (hash ? '#' + hash : '');
}
