// new.html: turn the form into POST /api/jobs (docs/api.md), then open the
// ticket page. What each field means is js/form-job.js's, which the build
// server uses too when the form is posted without JavaScript (its action,
// POST /submit). Also fills the "Newest that runs on the user's system"
// table from GET /api/catalog/runtimes.
import { apiRequest, errorText, mountApiFooter, pageUrl, apiLocal, apiReady, setApiBase, LOCAL, localSubmit } from './api.js';
import { tarWrite } from './ibfile.js';
import { loadOverlay, overlayState, hasCatalog } from './overlay.js';
import { jobFromForm } from './form-job.js';

mountApiFooter();

const form = document.getElementById('new-form');
const val = (name) => {
  const el = form.elements[name];
  if (!el) return '';
  if (el instanceof RadioNodeList) return el.value;
  return el.type === 'checkbox' ? el.checked : el.value;
};
const checked = (name) => !!(form.elements[name] && form.elements[name].checked);

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

// The form, as js/form-job.js reads it (the server reads a plain post of
// the same form the same way).
const reader = {
  val: (name) => String(val(name) || ''),
  checked,
  launchEdited: (runtime) => {
    const entry = form.elements['entry_' + runtime];
    return !!entry && entry.value !== entry.defaultValue;
  },
};

/* ---------- "From my computer": an archive or a folder ---------- */

// What was picked: {name, bytes}. A folder becomes a tar here (paths as
// the browser gives them, under the folder's name); the builder turns any
// archive into the .tar.gz the installers unpack.
let localPick = null;
const pickedHint = document.getElementById('local-picked');
const pickedHintText = pickedHint && pickedHint.innerHTML;

function showPicked(text) {
  if (!pickedHint) return;
  if (text) pickedHint.textContent = text;
  else pickedHint.innerHTML = pickedHintText;
}

function humanBytes(n) {
  return n < 1024 * 1024 ? Math.ceil(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
}

const archiveInput = document.getElementById('local-archive');
if (archiveInput) {
  archiveInput.addEventListener('change', async () => {
    const f = archiveInput.files && archiveInput.files[0];
    if (!f) return;
    localPick = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    showPicked(f.name + ' (' + humanBytes(f.size) + ')');
  });
}
const folderInput = document.getElementById('local-folder');
if (folderInput) {
  folderInput.addEventListener('change', async () => {
    const files = Array.from(folderInput.files || []);
    if (!files.length) return;
    const members = [];
    const dirs = new Set();
    let total = 0;
    for (const f of files.sort((a, b) => (a.webkitRelativePath < b.webkitRelativePath ? -1 : 1))) {
      const rel = f.webkitRelativePath || f.name;
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) {
        const d = parts.slice(0, i).join('/') + '/';
        if (!dirs.has(d)) { dirs.add(d); members.push({ name: d, dir: true, mode: 0o755 }); }
      }
      const data = new Uint8Array(await f.arrayBuffer());
      total += data.length;
      // Browsers don't say which files are executable; scripts with a #! are.
      const exec = data[0] === 0x23 && data[1] === 0x21;
      members.push({ name: rel, data, mode: exec ? 0o755 : 0o644 });
    }
    const top = (files[0].webkitRelativePath || '').split('/')[0] || 'project';
    localPick = { name: top, bytes: tarWrite(members) };
    showPicked(top + '/: ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' (' + humanBytes(total) + ')');
  });
}

async function buildJob() {
  const problems = [];
  const icon = await iconField(problems);
  const local = localPick && val('source_kind') === 'local' ? { name: localPick.name, base64: bytesToBase64(localPick.bytes) } : null;
  return jobFromForm(reader, { icon, local, problems });
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
    // Files from the user's computer are built by the page itself.
    const r = job.source.kind === 'upload' ? await localSubmit(job) : await apiRequest('/api/jobs', { method: 'POST', body: job });
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
    hint.textContent = (apiLocal() ? 'From this page\'s catalogue' + (catalog.changed ? ', with your changes from the Runtimes page' : '') : 'From the build server\'s catalogue') +
      ': one row per install plan it makes for ' + (entry.label || rt) + '.';
    panel.classList.remove('py-panel');   // show it for every language with data
  } else {
    table.tHead.innerHTML = staticHead;
    table.tBodies[0].innerHTML = staticBody;
    hint.innerHTML = staticHint;
    panel.classList.add('py-panel');      // back to the static Python table
  }
}

form.elements.runtime.addEventListener('change', paintCatalog);
let catalogSeq = 0;
function fetchCatalog() {
  const seq = ++catalogSeq;
  apiRequest('/api/catalog/runtimes').then((c) => { if (seq === catalogSeq) { catalog = c; paintCatalog(); } })
    .catch(() => { /* a 4xx here just leaves the static table */ });
}
fetchCatalog();
// The table follows the catalogue: another server, or changes made on the
// Runtimes page (used when the page builds installers itself).
window.addEventListener('ib-api-change', () => { fetchCatalog(); paintOverlayNote(); });
window.addEventListener('ib-overlay-change', () => { if (apiLocal()) fetchCatalog(); paintOverlayNote(); });

/* ---------- catalogue changes made in this browser ---------- */

// Builds from a changed catalogue are said so before building: the changes
// decide what the installer downloads and runs.
const overlayNote = document.createElement('p');
overlayNote.className = 'warn-box small';
overlayNote.id = 'new-overlay-note';
overlayNote.hidden = true;
lastActions.before(overlayNote);

function paintOverlayNote() {
  const n = overlayState().changes.length;
  overlayNote.hidden = !n;
  if (!n) return;
  const link = document.createElement('a');
  link.href = pageUrl('runtimes.html');
  link.textContent = 'Runtimes page';
  const what = n + ' catalogue change' + (n === 1 ? '' : 's') + ' made in this browser (';
  if (apiLocal()) {
    overlayNote.replaceChildren('Builds use ' + what, link, '). The installers\' review screens show the plan they carry.');
  } else {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-button';
    b.textContent = 'Build in this page instead';
    b.addEventListener('click', () => setApiBase(LOCAL));
    overlayNote.replaceChildren('The build server uses its own catalogue, so your ' + what, link, ') aren\'t used. ', b);
  }
}
if (hasCatalog()) loadOverlay().then(() => apiReady()).then(paintOverlayNote).catch(() => {});
