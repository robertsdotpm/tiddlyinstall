// The one client for the build server (docs/api.md).
//
// Which server: `?api=` on the page URL, else the one saved in this browser,
// else the default: this page's own origin when the build server is serving
// it, otherwise DEFAULT_REMOTE. The footer control (mountApiFooter) shows it
// and lets people change it, like netstats on warpgate.io.
//
// Every call goes through apiRequest(). A network error or a 5xx marks the
// server as down: a banner says so, /api/health is polled with backoff
// (1, 2, 4 ... 60 s, with jitter), and every waiting call resumes by itself
// once the server answers again. Nothing on the page is reset, so a form
// being submitted keeps its contents. A 4xx is the caller's problem: it is
// thrown as an ApiError carrying the server's {error, code}.

export const DEFAULT_REMOTE = 'http://10.0.1.76:8080';
// The site is one file (tools/build_site.py, plan.md section 1.11) that
// also carries its own builder, js/local-api.js, as globalThis.ibLocalApi.
// LOCAL as the backend means "no build server: this page answers every
// call itself". Opened from disk, the page starts that way.
export const LOCAL = 'local';
const HAS_LOCAL = !!globalThis.IB_HAS_LOCAL;
// The page's pages are sections of one file (#new, #build&job=...).
const ONE_FILE = !!globalThis.IB_ONE_FILE;
// The name "Save this page" suggests.
export const SAVE_AS = 'tiddlyinstall.html';
const API_KEY = 'ib.api';
const SAME_ORIGIN_KEY = 'ib.api.sameorigin';
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

// True when this page builds installers itself (no build server).
export function apiLocal() { return apiBaseUrl === LOCAL; }

// A job this page built itself (files from the user's computer are, even
// with a build server) and its record are answered by the page.
function localPath(path) {
  if (!HAS_LOCAL || !globalThis.ibLocalApi) return false;
  if (/^\/api\/jobs\/local-/.test(path)) return true;
  return !!globalThis.ibLocalApi.url(path);
}

// Sends a job to this page's own builder, whatever the backend.
export function localSubmit(body) {
  return globalThis.ibLocalApi.request('/api/jobs', { method: 'POST', body });
}
let readyPromise = null;

// Is this page served by a build server? Asked once per tab, and only when
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
    return globalThis.ibLocalApi ? globalThis.ibLocalApi.url(path) : '';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    return /^https?:\/\//i.test(path) ? path : '';
  }
  return apiBaseUrl + (path.startsWith('/') ? '' : '/') + path;
}

export function setApiBase(url) {
  apiBaseUrl = url;
  paintMode();
  try {
    if (url === defaultApi) localStorage.removeItem(API_KEY);
    else localStorage.setItem(API_KEY, url);
  } catch (e) { /* private browsing: the choice won't outlive the tab */ }
  paintApiFooter();
  if (banner) banner.querySelector('.api-url').textContent = apiBaseUrl;
  window.dispatchEvent(new CustomEvent('ib-api-change', { detail: { url } }));
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
    '<span class="api-banner-text">Can\'t reach the build server at <code class="api-url"></code>. ' +
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
    scheduleHealth();
  }
}

function markUp() {
  if (!isDown) return;
  isDown = false;
  failures = 0;
  clearTimeout(retryTimer);
  clearInterval(tickTimer);
  retryTimer = tickTimer = null;
  if (banner) banner.hidden = true;
  document.documentElement.classList.remove('api-down');
  const w = upWaiters;
  upWaiters = [];
  w.forEach((f) => f());
  window.dispatchEvent(new CustomEvent('ib-api-up'));
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
  if (apiLocal() || localPath(path)) return globalThis.ibLocalApi.request(path, opts);
  for (;;) {
    await whenUp();
    // Switched to this page's own builder while waiting for a server.
    if (apiLocal()) return globalThis.ibLocalApi.request(path, opts);
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

function prettyApi(u) {
  return u === LOCAL ? 'none, this page builds installers itself' : String(u).replace(/^https?:\/\//, '');
}

// Which features show: html.ib-local hides what needs a build server (mode
// A, packing runtimes, the timestamp relay; css/style.css .online-only).
function paintMode() {
  document.documentElement.classList.toggle('ib-local', apiLocal());
  document.documentElement.classList.toggle('ib-has-local', HAS_LOCAL);
}

function paintApiFooter() {
  if (!footerEl) return;
  const a = footerEl.querySelector('.api-ctl-url');
  if (apiLocal()) {
    a.removeAttribute('href');
  } else {
    a.href = apiBaseUrl + '/api/health';
  }
  a.textContent = prettyApi(apiBaseUrl);
  a.title = apiBaseUrl === defaultApi ? apiBaseUrl + ' (default)' : apiBaseUrl + ' (chosen)';
}

// Adds "Build server: <url> [change]" to the page footer, and "Save this
// page" when the page is the one-file site. Carries a ?api= from the URL
// onto links to the site's other pages.
export function mountApiFooter() {
  if (footerEl) return;   // the one-file site's pages share one footer
  const footer = document.querySelector('.site-footer') || document.body;
  footerEl = document.createElement('div');
  footerEl.className = 'api-ctl';
  footerEl.innerHTML =
    '<span>Build server:</span> <a class="api-ctl-url" target="_blank" rel="noopener noreferrer"></a> ' +
    '<button type="button" class="link-button api-ctl-edit">change</button>' +
    '<form class="api-ctl-form" hidden>' +
    '<label>Build server URL <input type="text" class="api-ctl-input" spellcheck="false" autocomplete="off" ' +
    'autocapitalize="off" placeholder="http://host:8080"></label>' +
    '<p class="api-ctl-err" hidden></p>' +
    '<div class="actions">' +
    '<button type="submit">Use</button>' +
    '<button type="button" class="secondary api-ctl-default">Default</button>' +
    (HAS_LOCAL ? '<button type="button" class="secondary api-ctl-local">No server</button>' : '') +
    '<button type="button" class="secondary api-ctl-cancel">Cancel</button>' +
    '</div>' +
    '<p class="hint">Kept in this browser only, and shareable as <code>?api=</code> on the page URL. ' +
    'A page served over HTTPS can\'t use a plain http:// server.' +
    (HAS_LOCAL ? ' With no server, this page builds installers itself: modes B and C, code written here or package names.' : '') +
    '</p></form>';
  footer.appendChild(footerEl);
  const form = footerEl.querySelector('form');
  const input = footerEl.querySelector('.api-ctl-input');
  const err = footerEl.querySelector('.api-ctl-err');
  const edit = footerEl.querySelector('.api-ctl-edit');
  const showErr = (m) => { err.textContent = m || ''; err.hidden = !m; };
  const close = () => { form.hidden = true; showErr(''); };
  edit.addEventListener('click', () => {
    if (form.hidden) {
      input.value = apiLocal() ? '' : apiBaseUrl;
      form.hidden = false;
      input.focus();
      input.select();
    } else close();
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
  if (typeof IB_PRISTINE !== 'undefined') {
    const save = document.createElement('p');
    save.className = 'save-ctl';
    save.innerHTML = '<button type="button" class="link-button save-page">Save this page</button> ' +
      '<span class="muted">One file with everything inside. Opened from your disk it works with no build server.</span>';
    footer.appendChild(save);
    save.querySelector('.save-page').addEventListener('click', savePage);
  }
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

// Saves the page exactly as it was loaded (IB_PRISTINE, captured before any
// script changed it), so the saved copy is as good as the original. The
// Runtimes page may put this browser's catalogue changes inside it, when
// asked (globalThis.ibPageForSave, js/catalog-editor.js).
export function savePage() {
  let html = typeof IB_PRISTINE !== 'undefined' ? IB_PRISTINE : '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
  if (typeof globalThis.ibPageForSave === 'function') html = globalThis.ibPageForSave(html);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  a.download = SAVE_AS;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// A link to another page of the site that keeps ?api= (for navigation from JS).
// In the one-file site the pages are sections: #<page>&<hash>.
export function pageUrl(file, hash) {
  if (ONE_FILE) return '#' + file.replace(/\.html$/, '').replace(/^index$/, 'home') + (hash ? '&' + hash : '');
  const p = readParamApi();
  return file + (p ? '?api=' + encodeURIComponent(p) : '') + (hash ? '#' + hash : '');
}
