// new.html: turn the form into POST /api/jobs (docs/api.md), then open the
// ticket page. Also fills the "Newest that runs on the user's system" table
// from GET /api/catalog/runtimes. Without JS the form still works as the
// no-JS prototype did.
import { apiRequest, errorText, mountApiFooter, pageUrl, apiLocal } from './api.js';

mountApiFooter();

const form = document.querySelector('form[action="build.html"]');
const val = (name) => {
  const el = form.elements[name];
  if (!el) return '';
  if (el instanceof RadioNodeList) return el.value;
  return el.type === 'checkbox' ? el.checked : el.value;
};
const checked = (name) => !!(form.elements[name] && form.elements[name].checked);

const MODES = { ours: 'A', yours: 'B', unsigned: 'C' };
const COMPILED = ['cc', 'go', 'rust', 'zig', 'nim'];

// A GitHub URL or owner/repo is a repo; another URL is a download; anything
// else is a package name.
export function parseSource(text, refType, ref) {
  const v = text.trim();
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(v);
  const pinned = refType && refType !== 'latest' && ref.trim() ? ref.trim() : '';
  if (gh || /^[\w.-]+\/[\w.-]+$/.test(v)) {
    const [owner, repo] = gh ? [gh[1], gh[2]] : v.split('/');
    const s = { kind: 'github', value: owner + '/' + repo.replace(/\.git$/, '') };
    if (pinned) s.ref = pinned;
    return s;
  }
  if (/^https?:\/\//i.test(v)) return { kind: 'url', value: v };
  const s = { kind: 'package', value: v };
  if (pinned) s.version = pinned;
  return s;
}

function radio(name, fallback) {
  const el = form.elements[name];
  const v = el instanceof RadioNodeList ? el.value : (el ? el.value : '');
  return v || fallback;
}

function bytesToBase64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

const ICON_MAX = 1024 * 1024; // 1 MB, docs/api.md

// The launcher icon: the gallery choice, plus base64 for an uploaded image.
async function iconField(problems) {
  const icon = { choice: radio('icon_choice', 'default') };
  const input = form.elements.icon;
  const file = input && input.files && input.files[0];
  if (file) {
    if (file.size > ICON_MAX) {
      problems.push('The icon is over 1 MB. Use a smaller PNG (a 512×512 or 1024×1024 PNG is plenty).');
    } else {
      icon.data = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      icon.filename = file.name;
      icon.type = file.type || 'image/png';
    }
  }
  return icon;
}

// The Customise sections the server may act on (docs/api.md optional fields).
function optionFields(runtime, mode) {
  const fields = {
    cleanup: {
      tools: radio('cleanup_tools', 'remove'),
      source: checked('cleanup_source'),
      pkg_cache: checked('cleanup_pkg_cache'),
      docs: checked('cleanup_docs'),
      fail: radio('cleanup_fail', 'remove'),
    },
    uninstall: {
      register: checked('uninstaller'),
      data: radio('uninstall_data', 'ask'),
      before_windows: (val('win_unpre_script') || '').trim(),
      before_unix: (val('unix_unpre_script') || '').trim(),
    },
  };
  if (runtime === 'cc') fields.tools = { cc_win: radio('cc_win', 'auto') };
  if (mode === 'B') fields.sign = { win_method: radio('win_sign', 'service') };
  return fields;
}

// Packed and offline files. Uploaded local files are NOT sent: for modes B/C
// they are added to the built file in the browser afterwards (packed-files.md).
function packField(mode) {
  if (mode === 'A') return null;   // mode A never carries packed content
  const pack = {};
  if (checked('offline')) {
    pack.offline_include = radio('offline_include', 'all');
    const targets = ['win_1011', 'win_78', 'win_vista', 'win_xp', 'linux', 'mac']
      .filter((t) => checked('offline_' + t));
    pack.offline_targets = targets;
  }
  // One URL-sourced file from the "+ Add a file" form, if given. Uploads stay
  // in the browser and are added after the build, so they aren't sent.
  const url = (val('pf_url') || '').trim();
  if (url) {
    pack.files = [{
      source: 'url', url,
      action: radio('pf_action', 'copy'),
      dest: (val('pf_dest') || '').trim(),
      args: (val('pf_args') || '').trim(),
      platforms: ['windows', 'linux', 'macos'].filter((p) => checked('pf_' + p)),
      packed: radio('pf_how', 'packed') === 'packed',
    }];
  }
  return Object.keys(pack).length ? pack : null;
}

// The files of the chosen template, from the visible editor.
function inlineFiles(runtime, template) {
  const combo = form.querySelector('.combo-' + runtime + '-' + template);
  if (!combo) return null;
  const files = {};
  combo.querySelectorAll('textarea.code').forEach((ta) => {
    files[ta.getAttribute('aria-label') || ta.name] = ta.value;
  });
  return files;
}

async function buildJob() {
  const runtime = val('runtime');
  const write = val('source_kind') === 'write';
  const rv = val('rv_mode');
  const mode = MODES[val('mode')] || 'A';
  const platforms = ['windows', 'linux', 'macos'].filter((p) => checked('target_' + p));

  const job = {
    name: val('app_name').trim(),
    runtime,
    select: rv,
    range: rv === 'range' ? val('runtime_version').trim() : rv === 'exact' ? val('runtime_exact').trim() : '',
    launch: (val('entry_' + runtime) || '').trim(),
    install: val('install_cmd').trim(),
    console: true,
    menu: checked('shortcut_menu'),
    desktop: checked('shortcut_desktop'),
    root: val('root') || 'user',
    rootname: (val('rootname') || '').trim() || 'ib',
    platforms,
    mode,
    offline: mode !== 'A' && checked('offline'),
  };
  // Compiled languages: the build command is how the project gets installed.
  if (!job.install && COMPILED.includes(runtime)) {
    job.install = String(runtime === 'cc' ? val('cc_build') : val('build_' + runtime)).trim();
  }

  const problems = [];
  // Optional Customise fields the server may act on (docs/api.md).
  Object.assign(job, optionFields(runtime, mode));
  job.icon = await iconField(problems);
  const pack = packField(mode);
  if (pack) job.pack = pack;

  if (!platforms.length) problems.push('Pick at least one platform under "Build for".');
  if (write) {
    const template = val('template');
    const files = inlineFiles(runtime, template);
    if (!files) problems.push('This template isn\'t available for this language yet. Pick another template.');
    job.source = { kind: 'inline', value: '' };
    job.files = files || {};
    job.console = template === 'script';
  } else {
    const src = val('source');
    if (!src.trim()) problems.push('Say what to package: a GitHub repo URL or a package name.');
    job.source = parseSource(src, val('ref_type'), val('ref'));
    const sub = val('subdir').trim();
    if (sub) job.source.subdir = sub;
  }
  if (rv === 'range' && !job.range) problems.push('Enter the versions allowed, or pick another "Which version" option.');
  if (rv === 'exact' && !job.range) problems.push('Enter the exact version, or pick another "Which version" option.');
  return { job, problems };
}

/* ---------- submit ---------- */

const errBox = document.createElement('p');
errBox.className = 'form-error';
errBox.setAttribute('role', 'alert');
errBox.hidden = true;
const lastActions = form.querySelector(':scope > .actions');
lastActions.before(errBox);
const submitButtons = Array.from(form.querySelectorAll('button[type="submit"]'));

function showError(msg) {
  errBox.textContent = msg;
  errBox.hidden = !msg;
  if (msg) errBox.scrollIntoView({ block: 'nearest' });
}

let sending = false;
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending) return;
  sending = true;
  const labels = submitButtons.map((b) => b.textContent);
  submitButtons.forEach((b) => { b.disabled = true; b.textContent = 'Sending…'; });
  try {
    const { job, problems } = await buildJob();
    if (problems.length) { showError(problems.join(' ')); return; }
    showError('');
    const r = await apiRequest('/api/jobs', { method: 'POST', body: job });
    location.href = pageUrl('build.html', 'job=' + encodeURIComponent(r.id));
  } catch (err) {
    showError((apiLocal() ? 'Couldn\'t build this: ' : 'The build server refused this: ') + errorText(err));
  } finally {
    sending = false;
    submitButtons.forEach((b, i) => { b.disabled = false; b.textContent = labels[i]; });
  }
});

/* ---------- "Newest that runs on the user's system" from the catalogue ---------- */

const panel = form.querySelector('.rv-newest-only');
const table = panel && panel.querySelector('table');
const staticHead = table && table.tHead.innerHTML;
const staticBody = table && table.tBodies[0].innerHTML;
const hint = panel && panel.querySelector('.hint');
const staticHint = hint && hint.innerHTML;
let catalog = null;

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const ARCH = { amd64: 'x64', x86: '32-bit', arm64: 'ARM64', universal: 'Universal' };

// The catalogue's entry for a runtime id. `runtimes` is a list (api.md).
function catalogEntry(id) {
  const list = catalog && Array.isArray(catalog.runtimes) ? catalog.runtimes : [];
  return list.find((r) => r && r.id === id) || null;
}

function paintCatalog() {
  if (!panel || !catalog) return;
  const rt = val('runtime');
  const entry = catalogEntry(rt);
  if (entry && Array.isArray(entry.newest) && entry.newest.length) {
    table.tHead.innerHTML = '<tr><th>System</th><th>' + esc(entry.label || rt) + ' installed</th></tr>';
    table.tBodies[0].innerHTML = entry.newest.map((r) => {
      const arch = r.arch ? ' <span class="muted">(' + esc(ARCH[r.arch] || r.arch) + ')</span>' : '';
      const v = r.version ? esc(r.version) : '<span class="muted">Nothing in the catalogue runs here</span>';
      return '<tr><td>' + esc(r.covers || r.family || '') + arch + '</td><td>' + v + '</td></tr>';
    }).join('');
    hint.textContent = 'From the build server\'s catalogue: one row per install plan it makes for ' + (entry.label || rt) + '.';
    panel.classList.remove('py-panel');   // show it for every language with data
  } else {
    table.tHead.innerHTML = staticHead;
    table.tBodies[0].innerHTML = staticBody;
    hint.innerHTML = staticHint;
    panel.classList.add('py-panel');      // back to the static Python table
  }
}

form.elements.runtime.addEventListener('change', paintCatalog);
apiRequest('/api/catalog/runtimes').then((c) => { catalog = c; paintCatalog(); })
  .catch(() => { /* a 4xx here just leaves the static table */ });
