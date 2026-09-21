// edit.html (the Edit section of the one-file site, dist/index.html): open an
// installer file that carries no signature (one covers every byte, so editing
// would break it), edit its record, plan and packed files, download it.
// Nothing leaves the browser. Base installers for "start a new one" come
// from <script type="application/octet-stream" id="base-*"> blocks when the
// page has them (the standalone page), else from the build server.
import {
  readInstaller, writeInstaller, parseKv, serializeKv, kvGet, kvSet, newRecordText,
  recordHash, packMember, installerExt, toBytes, peInfo, bindPlan,
} from '../shared/tifile.js';
import { apiRequest, errorText, mountApiFooter } from './api.js';
import {
  rasterSource, buildIco, buildIcns, setExeIcon, setMacIcon, setLinuxIcon,
} from '../shared/icon.js';
import { mountSign, paintSign } from './sign-ui.js';

// The standalone build defines TI_PRISTINE (the page as loaded) before any
// script touches the DOM, for "Save this page".
const pagePristine = typeof TI_PRISTINE !== 'undefined' ? TI_PRISTINE : null;

mountApiFooter();

const el = (id) => document.getElementById(id);
const editor = el('editor');
const recordRaw = el('record-raw');
const planRaw = el('plan-raw');

let current = null;      // what readInstaller returned
let recEntries = [];     // the record, as parsed lines
let packFiles = [];      // [{name (sha256), data, label}]
let outNameAuto = false; // the file name follows the record until edited

function showError(msg) {
  el('edit-error').textContent = msg || '';
  el('edit-error').hidden = !msg;
}

function humanBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function escHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

const KIND_NAME = { exe: 'Windows installer', run: 'Linux installer', zip: 'macOS installer (zip)' };

/* ---------- record <-> fields ---------- */

const SRC_LABELS = {
  github: ['Repo (owner/name)', 'Commit'],
  package: ['Package name', 'Version'],
  url: ['URL', 'SHA-256'],
  inline: ['SHA-256 of the source', ''],
};

function paintSourceLabels() {
  const [a, b] = SRC_LABELS[el('f-src-kind').value] || ['Value', 'Detail'];
  el('f-src-a-label').textContent = a;
  el('f-src-b-label').textContent = b || '-';
  el('f-src-b').disabled = !b;
}

function fieldsFromRecord() {
  editor.querySelectorAll('[data-key]').forEach((f) => {
    const v = kvGet(recEntries, f.dataset.key);
    if (f.type === 'checkbox') f.checked = !!v && v[0] === '1';
    else {
      const s = v ? v.join('\t') : '';
      // Keep values this page doesn't know (a newer runtime id, say).
      if (f.tagName === 'SELECT' && s && !Array.from(f.options).some((o) => o.value === s)) f.add(new Option(s, s));
      f.value = s;
    }
  });
  const src = kvGet(recEntries, 'source') || ['github', '', ''];
  el('f-src-kind').value = SRC_LABELS[src[0]] ? src[0] : 'github';
  el('f-src-a').value = src[1] || '';
  el('f-src-b').value = src[2] || '';
  paintSourceLabels();
}

function recordFromFields() {
  editor.querySelectorAll('[data-key]').forEach((f) => {
    const key = f.dataset.key;
    if (f.type === 'checkbox') kvSet(recEntries, key, [f.checked ? '1' : '0']);
    else if (f.value.trim() === '' && !['name', 'launch', 'runtime', 'select'].includes(key)) kvSet(recEntries, key, null);
    else kvSet(recEntries, key, [f.value.trim()]);
  });
  const kind = el('f-src-kind').value;
  const vals = [kind, el('f-src-a').value.trim()];
  if (kind !== 'inline') vals.push(el('f-src-b').value.trim());
  kvSet(recEntries, 'source', vals[1] ? vals : null);
}

let hashSeq = 0;
async function paintRecord({ fromRaw = false } = {}) {
  const text = serializeKv(recEntries);
  if (!fromRaw) recordRaw.value = text;
  if (outNameAuto && current) el('out-name').value = defaultOutName();
  const seq = ++hashSeq;
  const h = await recordHash(fromRaw ? recordRaw.value : text);
  if (seq === hashSeq) el('record-hash').textContent = h;
}

editor.addEventListener('input', (e) => {
  if (e.target.closest('#sign-panel')) return;
  if (e.target === recordRaw) {
    recEntries = parseKv(recordRaw.value);
    fieldsFromRecord();
    paintRecord({ fromRaw: true });
    return;
  }
  if (e.target.id === 'out-name') { outNameAuto = false; return; }
  if (e.target === planRaw || e.target.id === 'ack-signed' || e.target.id === 'pack-add') return;
  if (e.target.id === 'f-src-kind') paintSourceLabels();
  recordFromFields();
  paintRecord();
});
editor.addEventListener('change', (e) => {
  if (e.target.closest('#sign-panel')) return;
  if (e.target.matches('select, input[type="checkbox"][data-key]')) {
    if (e.target.id === 'f-src-kind') paintSourceLabels();
    recordFromFields();
    paintRecord();
  }
});

/* ---------- packed files ---------- */

function paintPack() {
  const list = el('pack-list');
  if (!packFiles.length) {
    list.innerHTML = '<li><span class="muted small">No packed files.</span></li>';
    return;
  }
  list.innerHTML = packFiles.map((m, i) =>
    '<li><span><code class="sha">' + escHtml(m.name) + '</code>' +
    (m.label ? '<br><span class="small">' + escHtml(m.label) + '</span>' : '') + '</span>' +
    '<span class="small">' + humanBytes(m.data.length) +
    ' <button type="button" class="link-button" data-remove="' + i + '">Remove</button></span></li>').join('');
}

el('pack-list').addEventListener('click', (e) => {
  const i = e.target.dataset && e.target.dataset.remove;
  if (i === undefined) return;
  packFiles.splice(Number(i), 1);
  paintPack();
});

el('pack-add').addEventListener('change', async (e) => {
  for (const f of Array.from(e.target.files || [])) {
    const m = await packMember(new Uint8Array(await f.arrayBuffer()));
    if (packFiles.some((p) => p.name === m.name)) continue;
    m.label = f.name;
    packFiles.push(m);
  }
  e.target.value = '';
  paintPack();
});

/* ---------- icon ---------- */

const ICON_HINT = {
  exe: 'A square PNG (or SVG), 256×256 or larger. Written into the .exe as a Windows .ico (16/32/48 for old Windows, up to 256). Applied when you pick it.',
  zip: 'A square PNG (or SVG), 256×256 or larger. Written into the .app as an .icns. Applied when you pick it.',
  run: 'A square PNG (or SVG), 256×256 or larger. Kept inside the installer for the Linux launcher icon. Applied when you pick it.',
};

let iconPreviewUrl = null;
function setIconStatus(msg, isError) {
  const s = el('icon-status');
  s.textContent = msg || '';
  s.className = 'small' + (isError ? ' error-text' : msg ? ' muted' : '');
}
function showIconPreview(bytes) {
  if (iconPreviewUrl) URL.revokeObjectURL(iconPreviewUrl);
  iconPreviewUrl = URL.createObjectURL(new Blob([bytes]));
  const img = el('icon-preview');
  img.src = iconPreviewUrl;
  img.hidden = false;
  el('icon-clear').hidden = false;
}
function resetIcon() {
  if (iconPreviewUrl) { URL.revokeObjectURL(iconPreviewUrl); iconPreviewUrl = null; }
  el('icon-preview').hidden = true;
  el('icon-clear').hidden = true;
  el('icon-file').value = '';
  setIconStatus('');
}


async function applyIcon(bytes) {
  if (!current) return;
  setIconStatus('Making the icon…');
  try {
    const source = await rasterSource(bytes);
    if (current.kind === 'exe') {
      const ico = await buildIco(source);
      const newBase = await setExeIcon(current.base, ico);
      current.base = newBase;
      current.pe = peInfo(newBase);
      current.signed = false;      // resedit drops any signature
      el('signed-warning').hidden = true;
      el('ack-signed-row').hidden = true;
      setIconStatus('Icon set. It goes into the .exe when you download it.');
    } else if (current.kind === 'zip') {
      const icns = await buildIcns(source);
      await setMacIcon(current, icns);
      setIconStatus('Icon set. It goes into the .app when you download it.');
    } else {
      await setLinuxIcon(recEntries, packFiles, toBytes(bytes));
      paintRecord();
      paintPack();
      setIconStatus('Icon packed and named in the settings (Icon= is an engine TODO).');
    }
    if (typeof source.close === 'function') source.close();
    showIconPreview(bytes);
  } catch (e) {
    setIconStatus('Couldn\'t use that icon: ' + errorText(e), true);
    resetIcon();
  }
}

el('icon-file').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) { setIconStatus('That image is over 8 MB; use a smaller PNG.', true); e.target.value = ''; return; }
  applyIcon(new Uint8Array(await f.arrayBuffer()));
});
el('icon-clear').addEventListener('click', () => {
  // The icon is baked into the base/entries once applied; "Undo" clears the
  // picker and preview. Re-open the file to fully revert.
  resetIcon();
  setIconStatus('Reopen the installer to fully undo an icon change.', false);
});

/* ---------- opening ---------- */

function defaultOutName() {
  const rt = (kvGet(recEntries, 'runtime') || ['app'])[0];
  const proj = ((kvGet(recEntries, 'project') || kvGet(recEntries, 'name') || ['app'])[0] || 'app')
    .toLowerCase().replace(/[^a-z0-9_.-]+/g, '_');
  return 'install_' + rt + '_' + proj + installerExt(current.kind);
}

function load(info, displayName, note) {
  current = info;
  showError('');
  const fresh = !info.record;
  const text = info.record || newRecordText({
    name: 'My App', project: 'myapp', runtime: 'python', select: 'newest',
    launch: '{runtime} -m {project}', console: '1', menu: '1', desktop: '0',
    root: 'user', rootname: 'ti', created: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
  });
  recEntries = parseKv(text);
  planRaw.value = info.plan || '';
  packFiles = info.pack.map((m) => ({ name: m.name, data: m.data, label: '' }));
  resetIcon();
  el('icon-hint').textContent = ICON_HINT[info.kind] || ICON_HINT.exe;
  fieldsFromRecord();
  paintRecord();
  paintPack();

  const parts = ['<strong>' + escHtml(displayName) + '</strong>', KIND_NAME[info.kind] || info.kind];
  parts.push(fresh ? 'no settings inside yet, starting new ones' : 'settings found');
  if (info.plan) parts.push('has an install plan');
  if (info.pack.length) parts.push(info.pack.length + ' packed file' + (info.pack.length === 1 ? '' : 's'));
  el('file-summary').innerHTML = parts.join(' · ') + (note ? '<br><span class="small muted">' + escHtml(note) + '</span>' : '');
  el('file-summary').hidden = false;

  el('signed-warning').textContent = info.signed ? info.signedWhy : '';
  el('signed-warning').hidden = !info.signed;
  el('ack-signed-row').hidden = !info.signed;
  el('ack-signed').checked = false;

  outNameAuto = fresh;
  el('out-name').value = fresh ? defaultOutName() : displayName;
  paintSign(info.kind, (kvGet(recEntries, 'name') || [''])[0]);
  editor.hidden = false;
}

async function openBytes(bytes, name, note) {
  try {
    load(await readInstaller(bytes, name), name, note);
  } catch (e) {
    showError('Couldn\'t read ' + name + ': ' + errorText(e));
  }
}

el('installer').addEventListener('change', async (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
});

const drop = el('drop');
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('dragging'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('dragging')));
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) openBytes(new Uint8Array(await f.arrayBuffer()), f.name);
});
// Dropping a file anywhere else shouldn't navigate away from the edits.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* ---------- bases ---------- */

function b64ToBytes(s) {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const BASE_FILE = { windows: 'base.exe', linux: 'ti.run', macos: 'Install.zip' };

async function getBase(os) {
  const block = document.getElementById('base-' + os);
  if (block) {
    return {
      bytes: b64ToBytes(block.textContent),
      note: block.dataset.placeholder ? 'This page was built without the real ' + os +
        ' base, so this is a placeholder that parses but does not install anything.' : '',
    };
  }
  return { bytes: await apiRequest('/bases/' + os, { as: 'bytes' }), note: '' };
}

document.querySelectorAll('[data-base]').forEach((b) => b.addEventListener('click', async () => {
  const os = b.dataset.base;
  el('base-hint').textContent = 'Getting the ' + os + ' base…';
  try {
    const { bytes, note } = await getBase(os);
    el('base-hint').textContent = '';
    await openBytes(bytes, BASE_FILE[os], note);
  } catch (e) {
    el('base-hint').textContent = 'Couldn\'t get the ' + os + ' base: ' + errorText(e);
  }
}));

/* ---------- saving ---------- */

function download(bytes, name, type) {
  const url = URL.createObjectURL(new Blob([bytes], { type: type || 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The installer as it would be saved: {out, name}. Throws with a message
// for the person on bad settings.
async function buildOutput() {
  const lines = recordRaw.value.split('\n');
  if (!/^ti-record\t/.test(lines[0] || '')) throw new Error('The settings must start with the line "ti-record<TAB>1".');
  const record = recordRaw.value.replace(/\r\n/g, '\n').replace(/\n*$/, '\n');
  let plan = planRaw.value.trim() ? planRaw.value.replace(/\r\n/g, '\n').replace(/\n*$/, '\n') : '';
  // The installer refuses a plan made for another record, and an edited
  // plan's signature no longer matches (docs/format.md "Plan signature").
  ({ plan } = await bindPlan(plan, record, plan !== (current.plan || '')));
  const out = await writeInstaller(current, {
    record,
    plan,
    pack: packFiles.map((m) => ({ name: m.name, data: m.data })),
  });
  let name = el('out-name').value.trim() || defaultOutName();
  if (!name.toLowerCase().endsWith(installerExt(current.kind))) name += installerExt(current.kind);
  return { out, name };
}

editor.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!current) return;
  const status = el('save-status');
  if (current.signed && !el('ack-signed').checked) {
    status.textContent = 'Tick the box above first: saving removes the signature.';
    return;
  }
  status.textContent = 'Building…';
  try {
    const { out, name } = await buildOutput();
    download(out, name);
    status.textContent = 'Saved ' + name + ' (' + humanBytes(out.length) + ').';
  } catch (err) {
    status.textContent = 'Couldn\'t build it: ' + errorText(err);
  }
});

mountSign({
  build: () => {
    if (!current) throw new Error('Open an installer first.');
    return buildOutput();
  },
  download,
  kind: () => current && current.kind,
});

/* ---------- standalone page ---------- */

if (pagePristine) {
  el('standalone-note').hidden = false;
  el('base-hint').textContent = 'The bases are inside this page, so this works offline.';
  el('save-page').addEventListener('click', () => {
    download(new TextEncoder().encode(pagePristine), 'installer-editor.html', 'text/html');
  });
}
