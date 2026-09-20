// runtimes.html (#runtimes in the one-file site): the runtime catalogue
// editor (plan.md section 1.11, "The runtime catalogue editor"). Browse a
// runtime's releases, recipes, support rules and policy; change them with
// forms; see the plan the resolver makes before and after. Changes are kept
// by js/overlay.js as an overlay in this browser and used by js/local-api.js
// when the page builds installers itself.
//
// Everything shown comes from the catalogue or from an imported file, so it
// is written with textContent and DOM properties only (no innerHTML with
// values).
import { apiLocal, apiReady, apiBase, setApiBase, LOCAL, mountApiFooter } from './api.js';
import { resolve, fileName } from './resolve.js';
import * as O from './overlay.js';
// The change list, and the DOM helpers it shares with this page. The same
// list is shown by the prompt for changes found in storage.
import { el, short, show, matchText, describeChange, changeItem as changeListItem } from './change-list.js';
import { mountOverlayConsent } from './overlay-consent.js';

mountApiFooter();
mountOverlayConsent();

const $ = (id) => document.getElementById(id);
// A release row's height, from the stylesheet: 30 px, or two lines on narrow
// screens (css/style.css); measured when the list is first drawn and again
// when the window changes size.
let ROW = 30;
let rowSure = false;
const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const nz = (v, d) => (v != null ? v : d);        // v ?? d (d is evaluated either way)

/* ---------- DOM helpers (js/change-list.js: el, short, show) ---------- */

const opt = (value, label, sel) => el('option', { value, text: (label != null ? label : value), selected: sel ? 'selected' : null });

/* ---------- versions, for sorting and the version filter ---------- */

function vparts(s) {
  s = String(s || '').replace(/^v|^go/, '');
  const out = [];
  for (const p of s.split('.')) {
    const m = /^(\d+)/.exec(p);
    out.push(m ? Number(m[1]) : 0);
    if (!m || m[1].length !== p.length) break;
  }
  return out;
}
function vcmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
}
// A version filter: "3.12" (prefix) or a spec like ">=3.9,<3.13".
function versionFilter(text) {
  text = text.trim();
  if (!text) return null;
  if (!/^[<>=!~]/.test(text)) return (v) => v === text || v.startsWith(text + '.') || v.startsWith(text);
  if (O.specError(text)) return () => false;
  const cl = text.split(',').map((c) => {
    const m = /^(~=|==|!=|>=|<=|>|<)\s*(.+)$/.exec(c.trim());
    const star = m[2].endsWith('.*');
    return { op: m[1], t: vparts(star ? m[2].slice(0, -2) : m[2]), star };
  });
  return (v) => {
    const p = vparts(v);
    return cl.every(({ op, t, star }) => {
      if (star) { const inp = t.every((x, i) => p[i] === x); return op === '!=' ? !inp : inp; }
      const c = vcmp(p, t);
      return { '==': c === 0, '!=': c !== 0, '>=': c >= 0, '<=': c <= 0, '>': c > 0, '<': c < 0, '~=': c >= 0 && t.slice(0, -1).every((x, i) => p[i] === x) }[op];
    });
  };
}

/* ---------- state ---------- */

const S = {
  files: null, ctx: null, rt: '', tab: 'releases',
  ov: O.overlayState(), status: new Map(),
  rows: [], rowsKey: '', filtered: [],
  sel: null,          // {kind, i (built-in index or -1), id (added change id or new id), isNew}
  draft: undefined, dirty: false, problems: [],
  policyDraft: null,
  started: false,
};

const policyAll = () => S.files['policy.json'].runtimes;
const pol = (id = S.rt) => policyAll()[id] || {};
const folderOf = (id = S.rt) => pol(id).folder || id;
const labelOf = (id) => pol(id).label || id;
const runtimeIds = () => Object.keys(policyAll()).filter((k) => isMap(policyAll()[k])).sort();
const fileFor = (kind, id = S.rt) => folderOf(id) + '/' + { release: 'releases.json', recipe: 'install.json', rule: 'os_support.json' }[kind];

// The page's catalogue is unpacked a folder at a time (js/overlay.js): a
// runtime's folder, and those its previews need, when it is opened, and the
// folders the changes are about, to show them. Everything below reads
// S.files synchronously once `need` has resolved.
let busy = 0;
async function need(ids, changes = S.ov.changes) {
  const slow = ids.filter((id) => !O.folderLoaded(folderOf(id)));
  if (slow.length) {
    busy++;
    $('rt-app').setAttribute('aria-busy', 'true');
    $('rt-sub').textContent = 'Unpacking ' + slow.map(labelOf).join(', ') + ' from the page…';
  }
  try {
    await O.ensureRuntimes(ids, changes);
  } finally {
    if (slow.length && --busy === 0) $('rt-app').removeAttribute('aria-busy');
  }
}
// Release counts of folders not unpacked yet come from the page's index.
function releaseCount(id) {
  if (O.folderLoaded(folderOf(id))) return baseList('release', id).length;
  const f = O.catalogFolders()[folderOf(id)];
  return f ? f.releases : 0;
}
function failed(e) {
  $('rt-sub').textContent = 'Couldn\'t unpack this runtime from the page: ' + (e && e.message ? e.message : e);
}

function refreshStatus() {
  S.status = new Map();
  for (const c of S.ov.changes) S.status.set(O.changeKey(c), O.changeStatus(S.files, c, S.ctx));
}

function baseList(kind, id = S.rt) {
  const f = S.files[fileFor(kind, id)];
  if (kind === 'release') return Array.isArray(f) ? f : [];
  if (kind === 'recipe') return isMap(f) && Array.isArray(f.recipes) ? f.recipes : [];
  return isMap(f) && Array.isArray(f.rules) ? f.rules : [];
}
function pathFor(kind, i, id = S.rt) {
  const file = fileFor(kind, id);
  if (kind === 'release') return [file, i < 0 ? '-' : O.releaseSelector(baseList(kind, id)[i])];
  return [file, kind === 'recipe' ? 'recipes' : 'rules', i < 0 ? '-' : i];
}

// Rows of one list: built-in items with their changes, then added ones.
function itemRows(kind, id = S.rt) {
  const base = baseList(kind, id);
  const file = fileFor(kind, id);
  const byIdx = new Map(), added = [];
  for (const c of S.ov.changes) {
    if (c.path[0] !== file || O.pathKind(c.path) !== kind) continue;
    if (c.op === 'add') added.push(c);
    else {
      const i = O.baseIndex(S.files, c.path);
      if (i >= 0 && (S.status.get(O.changeKey(c)) || {}).ok !== false) byIdx.set(i, c);
      else if (i >= 0) byIdx.set(i, Object.assign({ stale: true }, c));
    }
  }
  const rows = [];
  base.forEach((v, i) => {
    if (v == null) return;
    const c = byIdx.get(i);
    const bad = c && S.status.get(O.changeKey(c)) && !S.status.get(O.changeKey(c)).ok;
    rows.push({ i, id: '', v: c && c.op === 'replace' && !bad ? c.value : v, st: !c ? '' : bad ? 'stale' : c.op === 'remove' ? 'removed' : 'changed', c });
  });
  for (const c of added) {
    const bad = !(S.status.get(O.changeKey(c)) || {}).ok;
    rows.push({ i: -1, id: c.id, v: c.value, st: bad ? 'stale' : 'added', c });
  }
  return rows;
}

const STATE_LABEL = { changed: 'changed', removed: 'removed', added: 'added', stale: 'not applied' };
const badge = (st) => (st ? el('span', { class: 'rt-badge rt-' + st, text: STATE_LABEL[st] }) : null);

/* ---------- runtimes list ---------- */

function paintRuntimes() {
  const nav = $('rt-runtimes');
  const perFolder = new Map();
  for (const c of S.ov.changes) {
    const f = O.pathRuntime(c.path);
    perFolder.set(f, (perFolder.get(f) || 0) + 1);
  }
  nav.replaceChildren(...runtimeIds().map((id) => {
    const n = (perFolder.get(folderOf(id)) || 0) + (folderOf(id) !== id ? perFolder.get(id) || 0 : 0);
    const count = releaseCount(id);
    return el('button', { type: 'button', class: 'rt-rt' + (id === S.rt ? ' active' : ''), 'aria-current': id === S.rt ? 'true' : null, dataset: { rt: id }, onclick: () => pickRuntime(id) },
      el('span', { class: 'rt-rt-name', text: labelOf(id) }),
      el('span', { class: 'rt-rt-meta', text: id + ' · ' + count.toLocaleString('en') }),
      n ? el('span', { class: 'rt-badge rt-changed', text: String(n) }) : null);
  }));
}

let pickSeq = 0;
async function pickRuntime(id) {
  if (!policyAll()[id]) return;
  const seq = ++pickSeq;
  try { await need([id]); } catch (e) { failed(e); return; }
  if (seq !== pickSeq) return;
  S.rt = id;
  S.sel = null;
  S.draft = undefined;
  S.policyDraft = null;
  resetFilters();
  paintAll();
  saveView();
}

function saveView() {
  try { history.replaceState(null, '', '#runtimes&rt=' + encodeURIComponent(S.rt) + '&tab=' + S.tab); } catch (e) { /* file:// quirks */ }
}

/* ---------- tabs ---------- */

function pickTab(tab) {
  S.tab = tab;
  S.sel = null;
  S.draft = undefined;
  paintTabs();
  paintDetail();
  saveView();
}

function paintTabs() {
  for (const b of $('rt-tabs').querySelectorAll('[data-tab]')) {
    const on = b.dataset.tab === S.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const t of ['releases', 'recipes', 'rules', 'policy']) $('rt-tab-' + t).hidden = t !== S.tab;
  if (S.tab === 'releases') paintReleases();
  else if (S.tab === 'recipes') paintRecipes();
  else if (S.tab === 'rules') paintRules();
  else paintPolicy();
}

function paintHead() {
  $('rt-title').textContent = labelOf(S.rt);
  const shared = runtimeIds().filter((id) => id !== S.rt && folderOf(id) === folderOf(S.rt));
  $('rt-sub').textContent = S.rt + ' · ' + baseList('release').length.toLocaleString('en') + ' releases, ' +
    baseList('recipe').length + ' recipes, ' + baseList('rule').length + ' support rules' +
    (folderOf(S.rt) !== S.rt || shared.length ? ' · files in ' + folderOf(S.rt) + '/, shared with ' + [folderOf(S.rt), ...shared].filter((x) => x !== S.rt).join(', ') : '');
}

/* ---------- releases: filters and the virtual list ---------- */

const F = () => ({ os: $('rt-f-os').value, arch: $('rt-f-arch').value, variant: $('rt-f-variant').value, format: $('rt-f-format').value, version: $('rt-f-version').value, changed: $('rt-f-changed').checked });

function resetFilters() {
  for (const k of ['os', 'arch', 'variant', 'format']) $('rt-f-' + k).value = '';
  $('rt-f-version').value = '';
  $('rt-f-changed').checked = false;
  S.rowsKey = '';
  $('rt-rel-list').scrollTop = 0;
}

function releaseRows() {
  const key = S.rt + ':' + S.ov.version;
  if (S.rowsKey !== key) {
    const rows = itemRows('release');
    for (const r of rows) r.vp = vparts(r.v.version);
    rows.sort((a, b) => vcmp(b.vp, a.vp) || String(a.v.os).localeCompare(String(b.v.os)) || String(a.v.arch).localeCompare(String(b.v.arch)) ||
      String((a.v.variant != null ? a.v.variant : '')).localeCompare(String((b.v.variant != null ? b.v.variant : ''))) || String(a.v.format).localeCompare(String(b.v.format)));
    S.rows = rows;
    S.rowsKey = key;
    paintFilterOptions();
  }
  return S.rows;
}

function paintFilterOptions() {
  const count = (k) => {
    const m = new Map();
    for (const r of S.rows) { const v = (r.v[k] != null ? r.v[k] : ''); m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  };
  for (const k of ['os', 'arch', 'variant', 'format']) {
    const s = $('rt-f-' + k), cur = s.value;
    s.replaceChildren(opt('', 'Any'), ...count(k).map(([v, n]) => opt(v === '' ? ' none' : v, (v === '' ? '(none)' : v) + ' (' + n.toLocaleString('en') + ')')));
    s.value = [...s.options].some((o) => o.value === cur) ? cur : '';
  }
}

function paintReleases() {
  const rows = releaseRows();
  const f = F();
  const vf = versionFilter(f.version);
  const want = (k, v) => !f[k] || (f[k] === ' none' ? ((v != null ? v : '')) === '' : v === f[k]);
  S.filtered = rows.filter((r) => want('os', r.v.os) && want('arch', r.v.arch) && want('variant', r.v.variant) && want('format', r.v.format) &&
    (!vf || vf(String(r.v.version))) && (!f.changed || r.st));
  const bad = f.version && /^[<>=!~]/.test(f.version.trim()) && O.specError(f.version.trim());
  $('rt-rel-count').textContent = bad ? 'Version filter: ' + bad :
    S.filtered.length.toLocaleString('en') + ' of ' + rows.length.toLocaleString('en') + ' releases';
  const list = $('rt-rel-list');
  list.firstChild.style.height = S.filtered.length * ROW + 'px';
  paintWindow();
}

// 0 while the list isn't shown.
function measureRow() {
  const probe = el('div', { class: 'rt-vrow', style: 'visibility:hidden' });
  $('rt-rel-list').firstChild.appendChild(probe);
  const h = probe.offsetHeight;
  probe.remove();
  return h;
}

function paintWindow() {
  const list = $('rt-rel-list');
  if (!rowSure) {
    const h = measureRow();
    if (h) {
      rowSure = true;
      if (h !== ROW) { ROW = h; list.firstChild.style.height = S.filtered.length * ROW + 'px'; }
    }
  }
  const top = list.scrollTop, h = list.clientHeight || 400;
  const a = Math.max(0, Math.floor(top / ROW) - 6), b = Math.min(S.filtered.length, Math.ceil((top + h) / ROW) + 6);
  const out = [];
  for (let k = a; k < b; k++) {
    const r = S.filtered[k];
    const on = S.sel && S.sel.kind === 'release' && ((r.i >= 0 && r.i === S.sel.i) || (r.id && r.id === S.sel.id));
    let file = '';
    try { file = fileName(r.v); } catch (e) { file = String(r.v.url || ''); }
    out.push(el('div', { class: 'rt-vrow' + (on ? ' selected' : '') + (r.st ? ' rt-row-' + r.st : ''), role: 'option', 'aria-selected': on ? 'true' : 'false', style: 'top:' + k * ROW + 'px', dataset: { k: String(k) } },
      el('span', { text: String((r.v.version != null ? r.v.version : '')) }), el('span', { text: String((r.v.os != null ? r.v.os : '')) }), el('span', { text: String((r.v.arch != null ? r.v.arch : '')) }),
      el('span', { text: r.v.variant == null || r.v.variant === '' ? '—' : String(r.v.variant) }), el('span', { text: String((r.v.format != null ? r.v.format : '')) }),
      el('span', { class: 'rt-file', text: file, title: String(r.v.url || '') }), el('span', {}, badge(r.st))));
  }
  list.firstChild.replaceChildren(...out);
}

function selectRow(k) {
  const r = S.filtered[k];
  if (!r) return;
  openItem('release', r.i, r.id);
  const list = $('rt-rel-list');
  if (k * ROW < list.scrollTop) list.scrollTop = k * ROW;
  else if ((k + 1) * ROW > list.scrollTop + list.clientHeight) list.scrollTop = (k + 1) * ROW - list.clientHeight;
  paintWindow();
}

/* ---------- recipes and rules: tables ---------- */

function tableRows(kind, table, cols, filter) {
  const rows = itemRows(kind).filter(filter || (() => true));
  const head = el('tr', {}, el('th', { text: '#' }), ...cols.map(([t]) => el('th', { text: t })), el('th', {}));
  const body = rows.map((r) => {
    const on = S.sel && S.sel.kind === kind && ((r.i >= 0 && r.i === S.sel.i) || (r.id && r.id === S.sel.id));
    return el('tr', { class: 'rt-trow' + (on ? ' selected' : '') + (r.st ? ' rt-row-' + r.st : ''), tabindex: '0', onclick: () => openItem(kind, r.i, r.id),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openItem(kind, r.i, r.id); } } },
    el('td', { text: r.i >= 0 ? String(r.i + 1) : 'new' }), ...cols.map(([, f]) => el('td', { text: short(String(nz(f(r.v), '')), 60) })), el('td', {}, badge(r.st)));
  });
  table.replaceChildren(el('thead', {}, head), el('tbody', {}, ...body));
  return rows.length;
}

function paintRecipes() {
  const n = tableRows('recipe', $('rt-rec-table'), [
    ['OS', (v) => matchText(v.match && v.match.os)], ['Kind', (v) => matchText(v.match && v.match.kind)],
    ['Format', (v) => matchText(v.match && v.match.format)], ['Arch', (v) => matchText(v.match && v.match.arch)],
    ['Variant', (v) => (v.match && Object.hasOwn(v.match, 'variant') ? matchText(v.match.variant) : 'any')],
    ['Versions', (v) => (v.match && v.match.versions) || 'any'], ['Method', (v) => v.method], ['Steps', (v) => (Array.isArray(v.steps) ? v.steps.length : 0)],
  ]);
  $('rt-rec-count').textContent = n + ' recipes';
}

function paintRules() {
  const s = $('rt-rule-os'), cur = s.value;
  const all = itemRows('rule');
  const oses = [...new Set(all.map((r) => r.v.os))].sort();
  s.replaceChildren(opt('', 'Any'), ...oses.map((o) => opt(o)));
  s.value = oses.includes(cur) ? cur : '';
  const n = tableRows('rule', $('rt-rule-table'), [
    ['OS', (v) => v.os], ['Versions', (v) => v.versions || 'any'], ['Lowest OS', (v) => (v.min_os != null ? v.min_os : '—')], ['Highest', (v) => (v.max_os != null ? v.max_os : '')],
    ['Arch', (v) => matchText(v.arch)], ['Format', (v) => matchText((v.format != null ? v.format : v.match && v.match.format))],
    ['Variant', (v) => matchText((v.variant != null ? v.variant : v.match && v.match.variant))],
  ], (r) => !s.value || r.v.os === s.value);
  $('rt-rule-count').textContent = n + ' of ' + all.length + ' rules';
}

/* ---------- one item: the detail form ---------- */

function currentRow(kind, i, id) {
  return itemRows(kind).find((r) => (i >= 0 ? r.i === i : r.id === id)) || null;
}

function newId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const TEMPLATES = {
  release: () => ({ version: '', os: 'windows', arch: 'amd64', kind: 'archive', format: 'zip', variant: null, libc: null, url: 'https://', mirrors: [], size: 0, min_os: null, ib_sha256: '' }),
  recipe: () => ({ match: { os: 'windows', kind: 'archive', format: 'zip', arch: null, variant: null, versions: '' }, method: 'unpack', isolation: 'full', executable: '', steps: [{ unpack: 'zip', to: '{runtime_dir}', strip_components: 0 }] }),
  rule: () => ({ os: 'windows', versions: '', min_os: null, max_os: null, min_build: null, arch: null, format: null, variant: null }),
};

function openItem(kind, i, id, value) {
  S.sel = { kind, i, id: id || '', isNew: !!value };
  const row = value ? null : currentRow(kind, i, id);
  S.draft = O.clone(value || (row ? row.v : undefined));
  S.dirty = !!value;
  paintDetail();
  if (kind === 'release') paintWindow();
  else if (kind === 'recipe') paintRecipes();
  else paintRules();
  schedulePreview();
}

function addItem(kind) {
  let v = TEMPLATES[kind]();
  // A new release starts as a copy of the one selected, which is usually
  // what is wanted (a new version of the same file).
  if (kind === 'release' && S.sel && S.sel.kind === 'release' && S.draft) v = Object.assign(O.clone(S.draft), { version: '', ib_sha256: '', size: 0 });
  openItem(kind, -1, newId(), v);
}

function detailTitle(kind, v, row) {
  if (kind === 'release') return 'Release ' + (v.version || '(new)') + ' · ' + [v.os, v.arch, v.variant, v.format].filter((x) => x).join(' ');
  const n = row && row.i >= 0 ? ' ' + (row.i + 1) : '';
  if (kind === 'recipe') return 'Recipe' + n + (row && row.i < 0 ? ' (added)' : '') + ' · ' + matchText(v.match && v.match.os) + ' ' + matchText(v.match && v.match.format) + ', ' + v.method;
  return 'Support rule' + n + ' · ' + v.os + ' ' + (v.versions || 'any version');
}

function paintDetail() {
  const box = $('rt-detail');
  if (!S.sel || S.tab === 'policy' || S.draft === undefined) { box.hidden = true; box.replaceChildren(); return; }
  const { kind } = S.sel;
  const row = S.sel.isNew ? null : currentRow(kind, S.sel.i, S.sel.id);
  if (!row && !S.sel.isNew) { box.hidden = true; return; }
  box.hidden = false;
  const st = S.sel.isNew ? 'new' : row.st;
  const children = [el('div', { class: 'rt-head' }, el('h3', { class: 'section-title', text: detailTitle(kind, S.draft, row) }), st === 'new' ? el('span', { class: 'rt-badge rt-added', text: 'not saved' }) : badge(st))];
  if (row && row.st === 'stale') {
    const s = S.status.get(O.changeKey(row.c));
    children.push(el('p', { class: 'warn-box small', text: 'Your change to this item isn\'t used: ' + (s ? s.why : 'it doesn\'t match') + '. Revert it, or save the form to replace it.' }));
  }
  if (row && row.st === 'removed') {
    children.push(el('p', { text: 'Removed by your changes: builds made in this page don\'t use it.' }),
      el('div', { class: 'actions' }, el('button', { type: 'button', text: 'Restore it', onclick: () => revert(row) })));
    box.replaceChildren(...children);
    return;
  }
  const form = el('form', { class: 'rt-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); saveItem(); } });
  if (kind === 'release') releaseForm(form);
  else if (kind === 'recipe') recipeForm(form);
  else ruleForm(form);
  form.append(rawJson(() => S.draft, (v) => { S.draft = v; S.dirty = true; paintDetail(); schedulePreview(); }));
  const errs = el('div', { class: 'rt-problems', id: 'rt-problems', role: 'alert' });
  form.append(errs);
  const acts = el('div', { class: 'actions' },
    el('button', { type: 'submit', id: 'rt-save', text: S.sel.isNew ? 'Add it' : 'Save change' }),
    el('button', { type: 'button', class: 'secondary', text: S.sel.isNew ? 'Discard' : 'Undo edits', onclick: () => (S.sel.isNew ? closeDetail() : openItem(kind, S.sel.i, S.sel.id)) }));
  if (row && (row.st === 'changed' || row.st === 'stale') && row.i >= 0) acts.append(el('button', { type: 'button', class: 'secondary', id: 'rt-revert', text: 'Revert to built-in', onclick: () => revert(row) }));
  if (row && !S.sel.isNew) acts.append(el('button', { type: 'button', class: 'secondary danger', id: 'rt-remove', text: row.i >= 0 ? 'Remove' : 'Remove (drop this added item)', onclick: () => removeItem(row) }));
  if (kind !== 'rule' && row) acts.append(el('button', { type: 'button', class: 'secondary', text: 'Duplicate as new', onclick: () => openItem(kind, -1, newId(), Object.assign(O.clone(S.draft), kind === 'release' ? { version: '', ib_sha256: '', size: 0 } : {})) }));
  acts.append(el('span', { class: 'small muted', id: 'rt-dirty', text: '' }));
  form.append(acts);
  children.push(form);
  box.replaceChildren(...children);
  validateDraft();
}

function closeDetail() {
  S.sel = null;
  S.draft = undefined;
  paintDetail();
  paintTabs();
  schedulePreview();
}

// Inputs. `get` and `set` read and write the draft; every edit validates.
function field(label, input, errKey, hint) {
  return el('div', { class: 'field rt-field', dataset: { err: errKey || '' } },
    el('label', {}, label, input), hint ? el('span', { class: 'hint', text: hint }) : null, el('span', { class: 'rt-err' }));
}
function edited() {
  S.dirty = true;
  validateDraft();
  schedulePreview();
  const raw = document.getElementById('rt-raw');
  if (raw && document.activeElement !== raw) raw.value = JSON.stringify(S.draft, null, 2);
}
function textIn(get, set, attrs = {}) {
  const i = el('input', Object.assign({ type: 'text', spellcheck: 'false', autocomplete: 'off' }, attrs));
  i.value = nz(get(), '');
  i.addEventListener('input', () => { set(i.value); edited(); });
  return i;
}
function selectIn(options, get, set) {
  const cur = get();
  const vals = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  if (!vals.some(([v]) => v === cur)) vals.push([cur, String(cur)]);
  const s = el('select', {}, ...vals.map(([v, l]) => opt(v, l, v === cur)));
  s.addEventListener('change', () => { set(vals[s.selectedIndex][0]); edited(); });
  return s;
}
// A match-style value as text: "" is any (null), "a | b" a list, "(none)" no variant.
const listToText = (v) => (v == null ? '' : Array.isArray(v) ? v.map((x) => (x === null ? '(none)' : x)).join(' | ') : String(v));
function textToList(t) {
  const parts = t.split(/[|,]/).map((x) => x.trim()).filter((x) => x !== '');
  if (!parts.length) return null;
  const vals = parts.map((x) => (x === '(none)' ? null : x));
  return vals.length === 1 && vals[0] !== null ? vals[0] : vals;
}

// An ordered list of text (mirrors, variants): each with up, down, remove.
function orderedList(get, set, { placeholder = '', errPrefix = '', add = '+ Add' } = {}) {
  const wrap = el('div', { class: 'rt-olist' });
  const paint = () => {
    const l = get() || [];
    const move = (i, d) => { const x = l.slice(); [x[i], x[i + d]] = [x[i + d], x[i]]; set(x); paint(); edited(); };
    wrap.replaceChildren(el('ol', {}, ...l.map((v, i) => {
      const inp = el('input', { type: 'text', spellcheck: 'false', autocomplete: 'off', placeholder, 'aria-label': (errPrefix || 'item') + ' ' + (i + 1) });
      inp.value = (v != null ? v : '');
      inp.addEventListener('input', () => { const x = (get() || []).slice(); x[i] = inp.value; set(x); edited(); });
      return el('li', { dataset: { err: errPrefix + '.' + i } }, inp,
        el('button', { type: 'button', class: 'icon-button', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0 ? 'disabled' : null, onclick: () => move(i, -1), text: '↑' }),
        el('button', { type: 'button', class: 'icon-button', title: 'Move down', 'aria-label': 'Move down', disabled: i === l.length - 1 ? 'disabled' : null, onclick: () => move(i, 1), text: '↓' }),
        el('button', { type: 'button', class: 'icon-button', title: 'Remove', 'aria-label': 'Remove', onclick: () => { const x = l.slice(); x.splice(i, 1); set(x); paint(); edited(); }, text: '✕' }),
        el('span', { class: 'rt-err' }));
    })), el('button', { type: 'button', class: 'link-button', text: add, onclick: () => { set([...(get() || []), '']); paint(); edited(); const last = wrap.querySelector('li:last-child input'); if (last) last.focus(); } }));
  };
  paint();
  return wrap;
}

function releaseForm(form) {
  const d = () => S.draft;
  const archs = ['amd64', 'x86', 'arm64', 'any', 'universal'];
  const formats = ['zip', 'tar.gz', 'tar.xz', '7z', 'msi', 'exe', 'pkg'];
  form.append(
    el('div', { class: 'row rt-row' },
      field('Version', textIn(() => d().version, (v) => { d().version = v; }), 'version'),
      field('OS', selectIn(O.OSES, () => d().os, (v) => { d().os = v; }), 'os'),
      field('Arch', textIn(() => d().arch, (v) => { d().arch = v; }, { list: 'rt-archs' }), 'arch'),
      field('Kind', selectIn(['archive', 'installer', 'source'], () => d().kind, (v) => { d().kind = v; }), 'kind'),
      field('Format', textIn(() => d().format, (v) => { d().format = v; }, { list: 'rt-formats' }), 'format'),
      field('Variant', textIn(() => nz(d().variant, ''), (v) => { d().variant = v === '' ? null : v; }, { placeholder: '(none)' }), 'variant'),
      field('C library', selectIn([[null, '(not set)'], ['glibc', 'glibc'], ['musl', 'musl'], ['', '(empty)']], () => nz(d().libc, null), (v) => { d().libc = v; }), 'libc')),
    el('datalist', { id: 'rt-archs' }, ...archs.map((a) => opt(a))),
    el('datalist', { id: 'rt-formats' }, ...formats.map((a) => opt(a))),
    field('Download URL', textIn(() => d().url, (v) => { d().url = v; }, { type: 'url', class: 'mono' }), 'url',
      'Tried first' + (S.files['policy.json'].mirror_first ? ', after the build server\'s own mirror (policy mirror_first)' : '') + ', then each mirror in order.'),
    el('div', { class: 'field rt-field', dataset: { err: 'mirrors' } }, el('span', { class: 'label', text: 'Mirrors, in the order tried' }),
      orderedList(() => d().mirrors, (v) => { d().mirrors = v; }, { placeholder: 'https://', errPrefix: 'mirrors', add: '+ Add a mirror' }), el('span', { class: 'rt-err' })),
    el('div', { class: 'row rt-row' },
      field('SHA-256', textIn(() => d().ib_sha256 || '', (v) => { d().ib_sha256 = v.trim().toLowerCase(); }, { class: 'mono', placeholder: '64 hex characters' }), 'ib_sha256',
        'The installer refuses the download if it doesn\'t match.'),
      field('Size in bytes', textIn(() => String(nz(d().size, 0)), (v) => { d().size = /^\d+$/.test(v.trim()) ? Number(v.trim()) : v; }, { inputmode: 'numeric' }), 'size')));
  // Releases downloaded in several files (Windows Python's MSIs): kept as
  // they are, since this form edits one download.
  if (Array.isArray(d().parts) && d().parts.length) {
    form.append(el('p', { class: 'small muted', dataset: { err: 'parts' } },
      'This release downloads ' + d().parts.length + ' more file' + (d().parts.length === 1 ? '' : 's') + ' with it (' +
      d().parts.slice(0, 6).map((q) => q && q.name).filter(Boolean).join(', ') + (d().parts.length > 6 ? ', …' : '') +
      '). They are kept as they are; this form edits the main download.', el('span', { class: 'rt-err' })));
  }
}

function stepEditor(get, set) {
  const wrap = el('div', { class: 'rt-steps' });
  const TYPES = [['run', 'Run a command'], ['unpack', 'Unpack the download'], ['write', 'Write a file'], ['mkdir', 'Make a folder']];
  const paint = () => {
    const steps = get() || [];
    const upd = (i, f) => { const x = steps.slice(); x[i] = f(Object.assign({}, x[i])); set(x); edited(); };
    const move = (i, dd) => { const x = steps.slice(); [x[i], x[i + dd]] = [x[i + dd], x[i]]; set(x); paint(); edited(); };
    wrap.replaceChildren(el('ol', {}, ...steps.map((st, i) => {
      const t = O.stepType(st) || 'run';
      const type = el('select', { 'aria-label': 'Step ' + (i + 1) + ' does' }, ...TYPES.map(([v, l]) => opt(v, l, v === t)));
      type.addEventListener('change', () => {
        const v = type.value;
        const fresh = { run: { run: '' }, unpack: { unpack: 'zip', to: '{dir}', strip_components: 0 }, write: { write: '', text: '' }, mkdir: { mkdir: '' } }[v];
        const x = steps.slice(); x[i] = fresh; set(x); paint(); edited();
      });
      const inp = (key, attrs = {}) => {
        const i2 = el(attrs.multiline ? 'textarea' : 'input', Object.assign({ type: attrs.multiline ? null : 'text', spellcheck: 'false', autocomplete: 'off', class: 'mono', placeholder: attrs.placeholder || '', 'aria-label': 'Step ' + (i + 1) + ' ' + key }, attrs.multiline ? { rows: 3 } : {}));
        i2.value = st[key] == null ? '' : typeof st[key] === 'string' ? st[key] : JSON.stringify(st[key]);
        i2.addEventListener('input', () => upd(i, (s) => { s[key] = key === 'strip_components' ? (/^\d+$/.test(i2.value) ? Number(i2.value) : i2.value) : i2.value; return s; }));
        return i2;
      };
      const body = t === 'run' ? [inp('run', { placeholder: 'a command, e.g. msiexec /a "{file}" /qn TARGETDIR="{runtime_dir}"' })]
        : t === 'unpack' ? [el('span', { class: 'rt-inline' }, 'as ', inp('unpack', { placeholder: 'zip' }), ' into ', inp('to', { placeholder: '{dir}' }), ' dropping ', inp('strip_components', { placeholder: '0' }), ' leading folders')]
          : t === 'write' ? [inp('write', { placeholder: 'the file, e.g. {runtime_dir}/pyvenv.cfg' }), inp('text', { multiline: true, placeholder: 'its contents' })]
            : [inp('mkdir', { placeholder: '{runtime_dir}/lib' })];
      return el('li', { dataset: { err: 'steps.' + i } },
        el('div', { class: 'rt-step-head' }, el('span', { class: 'step', text: String(i + 1) }), type,
          el('button', { type: 'button', class: 'icon-button', title: 'Move up', 'aria-label': 'Move step up', disabled: i === 0 ? 'disabled' : null, onclick: () => move(i, -1), text: '↑' }),
          el('button', { type: 'button', class: 'icon-button', title: 'Move down', 'aria-label': 'Move step down', disabled: i === steps.length - 1 ? 'disabled' : null, onclick: () => move(i, 1), text: '↓' }),
          el('button', { type: 'button', class: 'icon-button', title: 'Remove step', 'aria-label': 'Remove step', onclick: () => { const x = steps.slice(); x.splice(i, 1); set(x); paint(); edited(); }, text: '✕' })),
        ...body, el('span', { class: 'rt-err' }));
    })), el('button', { type: 'button', class: 'link-button', id: 'rt-add-step', text: '+ Add a step', onclick: () => { set([...(get() || []), { run: '' }]); paint(); edited(); const last = wrap.querySelector('li:last-child input'); if (last) last.focus(); } }));
  };
  paint();
  return wrap;
}

function recipeForm(form) {
  const d = () => S.draft;
  const m = () => (isMap(d().match) ? d().match : (d().match = {}));
  const mf = (k, label, hint) => field(label, textIn(() => listToText(m()[k]), (v) => {
    const x = textToList(v);
    if (x === null && k !== 'variant') delete m()[k]; else m()[k] = x;
  }, { placeholder: 'any' }), 'match.' + k, hint);
  const methods = (S.files['policy.json'].method_order || []).slice();
  form.append(
    el('h4', { class: 'rt-sub', text: 'Which releases it installs' }),
    el('div', { class: 'row rt-row' }, mf('os', 'OS'), mf('kind', 'Kind'), mf('format', 'Format'), mf('arch', 'Arch'), mf('libc', 'C library'),
      mf('variant', 'Variant', 'Empty: any. (none): releases with no variant. Several: a | b.'),
      field('Versions', textIn(() => m().versions || '', (v) => { if (v.trim() === '') delete m().versions; else m().versions = v; }, { placeholder: 'any, or >=3.9,<3.13' }), 'match.versions')),
    el('h4', { class: 'rt-sub', text: 'How' }),
    el('div', { class: 'row rt-row' },
      field('Method', selectIn(methods, () => d().method, (v) => { d().method = v; }), 'method', 'Earlier in the policy\'s method order is preferred.'),
      field('Isolation', selectIn([['', '(not set)'], 'full', 'leaks', 'impossible'], () => nz(d().isolation, ''), (v) => { d().isolation = v; }), 'isolation'),
      field('Executable', textIn(() => d().executable || '', (v) => { d().executable = v; }, { class: 'mono' }), 'executable')),
    el('div', { class: 'field rt-field', dataset: { err: 'steps' } }, el('span', { class: 'label', text: 'Steps, run in order on the user\'s computer' }),
      el('span', { class: 'hint', text: 'Tokens: {file} the download, {dir} or {runtime_dir} the runtime\'s folder, {tmp}, {version}, {exe}.' }),
      stepEditor(() => d().steps, (v) => { d().steps = v; }), el('span', { class: 'rt-err' })),
    el('div', { class: 'row rt-row' },
      field('Launch program', textIn(() => (d().launch && d().launch.program) || '', (v) => {
        if (v === '' && d().launch) delete d().launch.program; else if (v !== '') d().launch = Object.assign({}, d().launch || {}, { program: v });
      }, { class: 'mono' }), 'launch.program', 'What {runtime} means in the app\'s launch command.'),
      field('Its arguments', textIn(() => ((d().launch && d().launch.args) || []).join(' '), (v) => {
        const a = v.split(/\s+/).filter((x) => x);
        if (d().launch || a.length) d().launch = Object.assign({}, d().launch || {}, { args: a });
      }, { class: 'mono' }), 'launch.args', 'Separated by spaces.')));
}

function osChoices(os) {
  const raw = S.files['os_versions.json'] || {};
  const ids = (l) => (Array.isArray(l) ? l.map((x) => x && x.id).filter((x) => typeof x === 'string') : []);
  const list = os === 'windows' ? ids(raw.windows) : os === 'macos' ? ids(raw.macos) : os === 'linux' ? [...ids(raw.linux_glibc), ...ids(raw.linux_musl)] : [];
  return [[null, '(none)'], ...list.map((x) => [x, x])];
}

function ruleForm(form) {
  const d = () => S.draft;
  const lf = (k, label) => field(label, textIn(() => listToText(d()[k]), (v) => { d()[k] = textToList(v); }, { placeholder: 'any' }), k);
  const minSel = () => selectIn(osChoices(d().os), () => nz(d().min_os, null), (v) => { d().min_os = v; });
  const maxSel = () => selectIn(osChoices(d().os), () => nz(d().max_os, null), (v) => { d().max_os = v; });
  const minWrap = field('Lowest OS version', minSel(), 'min_os');
  const maxWrap = field('Highest OS version', maxSel(), 'max_os', 'Usually none.');
  form.append(
    el('div', { class: 'row rt-row' },
      field('OS', selectIn(['windows', 'macos', 'linux'], () => d().os, (v) => {
        d().os = v;
        minWrap.querySelector('select').replaceWith(minSel());
        maxWrap.querySelector('select').replaceWith(maxSel());
      }), 'os'),
      field('Versions it covers', textIn(() => d().versions || '', (v) => { d().versions = v; }, { placeholder: 'any, or >=3.9,<3.13' }), 'versions'),
      minWrap, maxWrap,
      field('Lowest Windows build', textIn(() => (d().min_build == null ? '' : String(d().min_build)), (v) => { d().min_build = v.trim() === '' ? null : /^\d+$/.test(v.trim()) ? Number(v.trim()) : v; }, { placeholder: 'none', inputmode: 'numeric' }), 'min_build')),
    el('div', { class: 'row rt-row' }, lf('arch', 'Arch'), lf('format', 'Format'), lf('kind', 'Kind'), lf('variant', 'Variant'),
      field('File name pattern', textIn(() => d().file_match || '', (v) => { if (v === '') delete d().file_match; else d().file_match = v; }, { class: 'mono', placeholder: 'none' }), 'file_match')),
    el('label', { class: 'choice' }, (() => {
      const c = el('input', { type: 'checkbox', checked: d().plan_floor !== false });
      c.addEventListener('change', () => { if (c.checked) delete d().plan_floor; else d().plan_floor = false; edited(); });
      return c;
    })(), 'Enforce the lowest version in plans'),
    field('Notes', (() => {
      const t = el('textarea', { rows: 2 });
      t.value = d().notes || '';
      t.addEventListener('input', () => { d().notes = t.value; edited(); });
      return t;
    })(), 'notes'));
}

// The item as JSON, for power users: edited as text, used only if it parses.
function rawJson(get, set) {
  const ta = el('textarea', { id: 'rt-raw', class: 'mono rt-raw', rows: 12, spellcheck: 'false', 'aria-label': 'Raw JSON' });
  ta.value = JSON.stringify(get(), null, 2);
  const err = el('span', { class: 'rt-err', id: 'rt-raw-err' });
  return el('details', { class: 'rt-rawwrap' }, el('summary', { text: 'Raw JSON' }), ta, err,
    el('div', { class: 'actions' }, el('button', { type: 'button', class: 'secondary', id: 'rt-raw-use', text: 'Use this JSON', onclick: () => {
      let v;
      try { v = JSON.parse(ta.value); } catch (e) { err.textContent = 'Not JSON: ' + e.message; return; }
      err.textContent = '';
      set(v);
    } })));
}

function validateDraft() {
  const { kind } = S.sel;
  S.problems = O.checkValue(kind, S.draft, S.ctx);
  const box = document.getElementById('rt-problems');
  if (!box) return S.problems;
  for (const f of $('rt-detail').querySelectorAll('[data-err]')) {
    const mine = S.problems.filter((p) => p.field === f.dataset.err || (f.tagName !== 'LI' && f.dataset.err && p.field.startsWith(f.dataset.err + '.') && !f.querySelector('[data-err="' + p.field + '"]')));
    const e = f.querySelector(':scope > .rt-err');
    if (e) {
      e.textContent = mine.map((p) => (p.warn ? 'Note: ' : '') + p.msg).join('. ');
      e.classList.toggle('warn', mine.length > 0 && mine.every((p) => p.warn));
    }
    f.classList.toggle('rt-bad', mine.some((p) => !p.warn));
  }
  const errors = S.problems.filter((p) => !p.warn);
  box.replaceChildren(...(errors.length ? [el('p', { class: 'error-text', text: 'Not saved: fix ' + (errors.length === 1 ? 'this' : 'these') + ' first.' }),
    el('ul', {}, ...errors.map((p) => el('li', { text: (p.field || 'item') + ': ' + p.msg })))] : []));
  const save = document.getElementById('rt-save');
  if (save) save.disabled = errors.length > 0;
  const dirty = document.getElementById('rt-dirty');
  if (dirty) dirty.textContent = S.dirty ? (errors.length ? 'Unsaved, and not valid yet' : 'Unsaved edits') : '';
  return S.problems;
}

// The change a saved draft makes: {put} or {revert} (back to built-in).
function draftChange() {
  const { kind, i, id } = S.sel;
  const path = pathFor(kind, i);
  if (i < 0) return { put: { op: 'add', id, path, value: O.clone(S.draft) } };
  const base = baseList(kind)[i];
  if (O.deepEqual(base, S.draft)) return { revert: O.changeKey({ op: 'replace', path }) };
  return { put: { op: 'replace', path, value: O.clone(S.draft), was: O.hashValue(base) } };
}

async function saveItem() {
  if (!S.sel) return;
  const errors = validateDraft().filter((p) => !p.warn);
  if (errors.length) return;
  const ch = draftChange();
  const { kind, i, id } = S.sel;
  if (ch.put) await O.editChanges([ch.put]);
  else await O.editChanges([], [ch.revert]);
  S.sel = { kind, i, id, isNew: false };
  S.dirty = false;
  const row = currentRow(kind, i, id);
  S.draft = row ? O.clone(row.v) : undefined;
  // after the overlay event has repainted
  paintDetail();
  flash('Saved.');
}

async function revert(row) {
  await O.revertChange(O.changeKey(row.c));
  if (S.sel && row.i < 0) { S.sel = null; S.draft = undefined; }
  else if (S.sel) { S.draft = O.clone(baseList(S.sel.kind)[row.i]); S.dirty = false; }
  paintAll();
}

async function removeItem(row) {
  if (row.i < 0) { await O.revertChange(O.changeKey(row.c)); S.sel = null; S.draft = undefined; }
  else await O.editChanges([{ op: 'remove', path: pathFor(S.sel.kind, row.i), was: O.hashValue(baseList(S.sel.kind)[row.i]) }]);
  paintAll();
}

function flash(msg) {
  const d = document.getElementById('rt-dirty');
  if (d) { d.textContent = msg; setTimeout(() => { if (d.textContent === msg) d.textContent = ''; }, 2500); }
}

/* ---------- policy ---------- */

function policyValue(f) {
  const c = S.ov.changes.find((x) => x.path[0] === 'policy.json' && x.path[2] === S.rt && x.path[3] === f);
  if (c && (S.status.get(O.changeKey(c)) || {}).ok) return O.clone(c.value);
  return O.clone(pol()[f]);
}

function paintPolicy() {
  const box = $('rt-tab-policy');
  if (!S.policyDraft || S.policyDraft.rt !== S.rt || S.policyDraft.version !== S.ov.version) {
    const v = {};
    for (const f of O.POLICY_FIELDS) { const x = policyValue(f); if (x !== undefined) v[f] = x; }
    S.policyDraft = { rt: S.rt, version: S.ov.version, v, dirty: false };
  }
  const d = () => S.policyDraft.v;
  const changedField = (f) => S.ov.changes.some((x) => x.path[0] === 'policy.json' && x.path[2] === S.rt && x.path[3] === f);
  const lbl = (text, f) => [text, changedField(f) ? badge('changed') : null];
  const osLists = el('div', { class: 'row rt-row' }, ...['windows', 'macos', 'linux'].map((os) => field(os === 'macos' ? 'macOS' : os[0].toUpperCase() + os.slice(1),
    textIn(() => ((d().formats || {})[os] || []).join(', '), (v) => {
      const l = v.split(',').map((x) => x.trim()).filter((x) => x);
      d().formats = Object.assign({}, d().formats || {});
      d().formats[os] = l.length ? l : null;
    }, { placeholder: 'any format' }), 'formats')));
  const pedit = () => { S.policyDraft.dirty = true; checkPolicy(); schedulePreview(); };
  const t = (f, attrs) => { const i = textIn(() => nz(d()[f], ''), (v) => { d()[f] = v; }, attrs); i.addEventListener('input', pedit); return i; };
  const only = el('input', { type: 'checkbox', checked: d().only === true });
  only.addEventListener('change', () => { d().only = only.checked; pedit(); });
  const variants = orderedList(() => d().variants, (v) => { d().variants = v; }, { placeholder: '(no variant)', errPrefix: 'variants', add: '+ Add a variant' });
  variants.addEventListener('input', pedit);
  variants.addEventListener('click', (e) => { if (e.target.closest('button')) pedit(); });
  const listText = (f) => { const i = textIn(() => (d()[f] || []).join(', '), (v) => { const l = v.split(',').map((x) => x.trim()).filter((x) => x); d()[f] = l.length ? l : null; }, { placeholder: 'none' }); i.addEventListener('input', pedit); return i; };
  osLists.addEventListener('input', pedit);
  const form = el('form', { class: 'panel rt-form', id: 'rt-policy-form', novalidate: true, onsubmit: (e) => { e.preventDefault(); savePolicy(); } },
    el('p', { class: 'small muted', text: 'How the resolver chooses among this runtime\'s releases. Other policy settings (prerequisites, package registries, install rules) are in the catalogue files; they can\'t be changed here.' }),
    el('div', { class: 'row rt-row' },
      field(lbl('Name', 'label'), t('label'), 'label'),
      field(lbl('Versions it covers', 'versions'), t('versions', { placeholder: 'any' }), 'versions'),
      field(lbl('Default launch command', 'launch'), t('launch', { class: 'mono' }), 'launch', 'Offered on the New installer page.')),
    el('div', { class: 'field rt-field', dataset: { err: 'variants' } }, el('span', { class: 'label' }, ...lbl('Preferred variants, best first', 'variants')),
      el('span', { class: 'hint', text: 'Among releases of the same version, the earlier variant wins. An empty entry means releases with no variant.' }), variants, el('span', { class: 'rt-err' })),
    el('label', { class: 'choice' }, only, 'Only use these variants', changedField('only') ? badge('changed') : null),
    field(lbl('Never use these variants', 'exclude_variants'), listText('exclude_variants'), 'exclude_variants', 'Separated by commas.'),
    el('div', { class: 'field rt-field', dataset: { err: 'formats' } }, el('span', { class: 'label' }, ...lbl('Formats per OS, preferred first', 'formats')), osLists, el('span', { class: 'rt-err' })),
    field(lbl('Kinds of release', 'kinds'), listText('kinds'), 'kinds', 'archive, installer; empty for any.'),
    rawJson(() => d(), (v) => { if (isMap(v)) { S.policyDraft.v = v; S.policyDraft.dirty = true; paintPolicy(); schedulePreview(); } }),
    el('div', { class: 'rt-problems', id: 'rt-policy-problems', role: 'alert' }),
    el('div', { class: 'actions' }, el('button', { type: 'submit', id: 'rt-policy-save', text: 'Save policy' }),
      el('button', { type: 'button', class: 'secondary', text: 'Undo edits', onclick: () => { S.policyDraft = null; paintPolicy(); schedulePreview(); } }),
      O.POLICY_FIELDS.some(changedField) ? el('button', { type: 'button', class: 'secondary', text: 'Revert policy to built-in', onclick: async () => {
        await O.editChanges([], O.POLICY_FIELDS.map((f) => O.changeKey({ op: 'replace', path: ['policy.json', 'runtimes', S.rt, f] })));
        S.policyDraft = null;
        paintAll();
      } }) : null,
      el('span', { class: 'small muted', id: 'rt-policy-dirty' })));
  box.replaceChildren(form);
  checkPolicy();
}

function policyProblems() {
  const out = [];
  const v = S.policyDraft.v;
  for (const f of Object.keys(v)) {
    if (!O.POLICY_FIELDS.includes(f)) { out.push({ field: f, msg: 'not a field this editor changes', warn: false }); continue; }
    const base = pol()[f];
    if (O.deepEqual(base, v[f])) continue;
    out.push(...O.checkValue('policy', v[f], S.ctx, f));
  }
  if (Array.isArray(v.variants) && new Set(v.variants).size !== v.variants.length) out.push({ field: 'variants', msg: 'a variant is listed twice', warn: false });
  return out;
}

function checkPolicy() {
  const probs = policyProblems();
  const form = $('rt-policy-form');
  if (!form) return probs;
  for (const f of form.querySelectorAll('[data-err]')) {
    const mine = probs.filter((p) => p.field === f.dataset.err || p.field.startsWith(f.dataset.err + '.'));
    const e = f.querySelector(':scope > .rt-err');
    if (e) e.textContent = mine.map((p) => p.msg).join('. ');
    f.classList.toggle('rt-bad', mine.some((p) => !p.warn));
  }
  const errors = probs.filter((p) => !p.warn);
  $('rt-policy-problems').replaceChildren(...(errors.length ? [el('p', { class: 'error-text', text: 'Not saved: ' + errors.map((p) => p.field + ': ' + p.msg).join('; ') })] : []));
  $('rt-policy-save').disabled = errors.length > 0;
  $('rt-policy-dirty').textContent = S.policyDraft.dirty ? 'Unsaved edits' : '';
  return probs;
}

function policyChanges() {
  const puts = [], reverts = [];
  const v = S.policyDraft.v;
  for (const f of O.POLICY_FIELDS) {
    const path = ['policy.json', 'runtimes', S.rt, f];
    const base = pol()[f];
    if (v[f] === undefined || O.deepEqual(base, v[f])) { reverts.push(O.changeKey({ op: 'replace', path })); continue; }
    puts.push(base === undefined ? { op: 'add', path, value: O.clone(v[f]) } : { op: 'replace', path, value: O.clone(v[f]), was: O.hashValue(base) });
  }
  return { puts, reverts };
}

async function savePolicy() {
  if (checkPolicy().some((p) => !p.warn)) return;
  const { puts, reverts } = policyChanges();
  await O.editChanges(puts, reverts);
  S.policyDraft = null;
  paintPolicy();
  const d = $('rt-policy-dirty');
  if (d) d.textContent = 'Saved.';
}

/* ---------- describing changes (the list, and imports) ---------- */

// js/change-list.js, against the catalogue as far as it is unpacked.
const describe = (c) => describeChange(c, S.files);

function changeItem(c, { status, actions = true } = {}) {
  const acts = actions ? [
    { text: 'Show', onclick: () => showChange(c) },
    { text: 'Revert',
      dataset: { revert: O.changeKey(c) },
      onclick: async () => { await O.revertChange(O.changeKey(c)); if (S.sel) { S.sel = null; S.draft = undefined; } paintAll(); } },
  ] : [];
  return changeListItem(c, { files: S.files, status: status || S.status.get(O.changeKey(c)) || { ok: true },
    badge: status ? 'will apply' : 'in use', actions: acts });
}

async function showChange(c) {
  const d = describe(c);
  if (!policyAll()[d.rt]) return;
  const seq = ++pickSeq;
  try { await need([d.rt]); } catch (e) { failed(e); return; }
  if (seq !== pickSeq) return;
  S.rt = d.rt;
  S.tab = { release: 'releases', recipe: 'recipes', rule: 'rules', policy: 'policy' }[d.kind];
  resetFilters();
  paintAll();
  if (d.kind === 'policy') return;
  const i = c.op === 'add' ? -1 : O.baseIndex(S.files, c.path);
  if (d.kind === 'release') {
    $('rt-f-changed').checked = true;
    paintReleases();
    const k = S.filtered.findIndex((r) => (i >= 0 ? r.i === i : r.id === c.id));
    if (k >= 0) selectRow(k);
  } else if (i >= 0 || c.id) openItem(d.kind, i, c.id || '');
  $('rt-detail').scrollIntoView({ block: 'nearest' });
  saveView();
}

function paintChanges() {
  const n = S.ov.changes.length;
  const bad = S.ov.changes.filter((c) => S.status.get(O.changeKey(c)) && !S.status.get(O.changeKey(c)).ok).length;
  $('rt-count').textContent = n === 0 ? 'No changes: the catalogue is as built into the page' : n + (n === 1 ? ' change' : ' changes') + ' in this browser' + (bad ? ' (' + bad + ' not applied)' : '');
  $('rt-where').textContent = S.ov.storage === 'ok' ? (S.ov.where ? 'kept in ' + S.ov.where : n ? '' : '') : '';
  $('rt-reset').disabled = n === 0;
  $('rt-export').disabled = n === 0;
  $('rt-changes-details').hidden = n === 0;
  $('rt-change-list').replaceChildren(...S.ov.changes.map((c) => changeItem(c)));
  const store = $('rt-store');
  store.hidden = !S.ov.storageWhy;
  store.textContent = S.ov.storageWhy;
  const note = $('rt-page-note');
  const po = O.pageOverlay();
  note.replaceChildren();
  // Found in this browser's storage and not in use: waiting for the answer
  // at the top of the page, or set aside for this session (js/overlay.js).
  if (S.ov.pending.length) {
    const p = S.ov.pending.length + ' catalogue change' + (S.ov.pending.length === 1 ? '' : 's') + ' found in this browser ';
    if (S.ov.consent === 'ask') note.append(p + 'are not in use: the question is at the top of the page.');
    else {
      note.append(p + (S.ov.pending.length === 1 ? 'is' : 'are') + ' set aside for this session. ',
        el('button', { type: 'button', class: 'link-button', id: 'rt-use-stored', text: 'Use them after all',
          onclick: async () => { await O.answerStored(true); S.sel = null; S.draft = undefined; paintAll(); } }),
        ' Saving a change here replaces them.');
    }
  } else if (S.ov.from === 'page') note.append('These changes came inside this page file (it was saved with them).');
  else if (po && po.changes.length && !O.deepEqual(po.changes, S.ov.changes)) {
    note.append('This page file also carries ' + po.changes.length + ' catalogue change' + (po.changes.length === 1 ? '' : 's') + ' of its own, not in use. ',
      el('button', { type: 'button', class: 'link-button', text: 'Review them', onclick: () => review(po, 'this page file') }));
  }
  note.hidden = !note.firstChild;
  paintSaveOption();
}

/* ---------- mode: do the changes apply? ---------- */

function paintMode() {
  const m = $('rt-mode');
  if (apiLocal()) {
    m.className = 'feature-box small';
    m.replaceChildren('This page builds installers itself, so builds use your changes. Each installer carries its plan, and its review screen shows it, changes included.');
  } else {
    m.className = 'warn-box';
    m.replaceChildren('This page uses the build server at ', el('code', { text: apiBase() }),
      ', which builds from its own catalogue: changes made here are kept in this browser but don\'t affect its builds. ',
      el('button', { type: 'button', class: 'secondary small-button', id: 'rt-use-local', text: 'Build in this page instead', onclick: () => setApiBase(LOCAL) }));
  }
}

/* ---------- import, export, reset ---------- */

let pendingImport = null;

async function review(parsed, from) {
  // Their folders, to check them against.
  try { await need([S.rt], [...S.ov.changes, ...parsed.changes]); } catch (e) { failed(e); return; }
  const ok = [], skipped = parsed.rejected.map((r) => 'change ' + (r.index + 1) + ': ' + r.why);
  const items = [];
  parsed.changes.forEach((c) => {
    const st = O.changeStatus(S.files, c, S.ctx);
    items.push(changeItem(c, { status: st, actions: false }));
    if (st.ok) ok.push(c);
    else skipped.push(describe(c).title + ': ' + st.why);
  });
  pendingImport = ok;
  $('rt-review-title').textContent = 'Review ' + parsed.changes.length + ' change' + (parsed.changes.length === 1 ? '' : 's') + ' from ' + from;
  $('rt-review-list').replaceChildren(...items);
  const sk = $('rt-review-skipped');
  sk.hidden = !skipped.length;
  sk.textContent = skipped.length ? 'Left out (' + skipped.length + '): ' + skipped.slice(0, 20).join('; ') + (skipped.length > 20 ? '; …' : '') : '';
  $('rt-review-add').disabled = !ok.length;
  $('rt-review-replace').disabled = !ok.length;
  $('rt-review').hidden = false;
  $('rt-review').scrollIntoView({ block: 'start' });
}

async function importFile(file) {
  const fail = (msg) => {
    pendingImport = null;
    $('rt-review-title').textContent = 'Couldn\'t import that file';
    $('rt-review-list').replaceChildren(el('li', { text: msg }));
    $('rt-review-skipped').hidden = true;
    $('rt-review-add').disabled = true;
    $('rt-review-replace').disabled = true;
    $('rt-review').hidden = false;
  };
  if (file.size > O.IMPORT_MAX) return fail('It is bigger than a catalogue overlay can be.');
  let parsed;
  try { parsed = O.parseOverlay(await file.text()); } catch (e) { return fail(e.message); }
  await review(parsed, '"' + short(file.name, 80) + '"');
}

async function applyImport(replace) {
  if (!pendingImport) return;
  const list = pendingImport;
  pendingImport = null;
  $('rt-review').hidden = true;
  if (replace) await O.setChanges(list);
  else await O.editChanges(list);
  S.sel = null;
  S.draft = undefined;
  paintAll();
}

function exportOverlay() {
  const text = JSON.stringify(O.overlayDoc(S.ov.changes), null, 1) + '\n';
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: 'tiddlyinstall-catalog-changes.json' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- "Save this page" with the changes ---------- */

let saveBox = null;
function paintSaveOption() {
  const ctl = document.querySelector('.save-ctl');
  if (!ctl) return;
  const n = S.ov.changes.length;
  const po = O.pageOverlay();
  if (!saveBox) {
    saveBox = el('label', { class: 'choice rt-save-with' }, el('input', { type: 'checkbox', id: 'rt-save-with' }), el('span'));
    ctl.append(saveBox);
    globalThis.ibPageForSave = (html) => {
      const cb = document.getElementById('rt-save-with');
      return cb && cb.checked && !saveBox.hidden ? O.bakeOverlay(html, S.ov.changes) : html;
    };
  }
  saveBox.hidden = !n && !(po && po.changes.length);
  saveBox.lastChild.textContent = n ? 'With my ' + n + ' catalogue change' + (n === 1 ? '' : 's') + ' inside (Runtimes page)' : 'Without the catalogue changes this page came with';
}

/* ---------- preview ---------- */

let previewTimer = null;
const baseSubs = new Map();
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(runPreview, 250);
}

function planBlocks(plan) {
  const blocks = [];
  let cur = null;
  for (const line of plan.split('\n')) {
    if (line === '[target]') { cur = null; continue; }
    const [k, ...v] = line.split('\t');
    if (k === 'when') { cur = { min: Number(v[1]), max: Number(v[2]), arches: String(v[3] || '').split(' '), minbuild: 0, version: '', file: '', sha: '', urls: [], fail: '', steps: [] }; blocks.push(cur); continue; }
    if (!cur) continue;
    if (k === 'minbuild') cur.minbuild = Number(v[0]);
    else if (k === 'runtime' && v.length >= 2) cur.version = v[1];
    else if (k === 'file' && !cur.file) { cur.file = v[1]; cur.sha = v[2]; }
    else if (k === 'url' && cur.file && !cur.steps.length) cur.urls.push(v[0]);
    else if (k === 'step') cur.steps.push(v.join(' '));
    else if (k === 'fail') cur.fail = v[0];
  }
  return blocks;
}

function picksFor(blocks, o, machine) {
  return blocks.filter((b) => b.arches.includes(machine) && b.min <= o.int && o.int <= b.max)
    .map((b) => ({ text: b.fail ? 'Nothing runs here' : b.version + ' · ' + b.file, key: [b.fail, b.version, b.file, b.sha].join('|'), urls: b.urls.join(' '), steps: b.steps.join('\n'), minbuild: b.minbuild, fail: !!b.fail, url: b.urls[0] || '' }));
}

// Line diff (LCS); returns [[' '|'-'|'+', line]].
function diffLines(a, b) {
  const n = a.length, m = b.length;
  if (n * m > 6e6) return null;
  const w = m + 1, L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[i] === b[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push(['-', a[i++]]);
    else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

function previewApp(rt) {
  const sel = $('rt-p-select').value || 'newest';
  const app = { recordHash: 'preview', name: 'Preview', project: 'preview', runtime: rt, launch: pol(rt).launch || '{runtime}', platforms: [$('rt-p-family').value], select: sel === 'newest' ? '' : sel };
  if (sel === 'range' || sel === 'exact') app.range = $('rt-p-range').value.trim();
  return app;
}

function paintPreviewControls() {
  const s = $('rt-p-select'), cur = s.value;
  const opts = [['newest', 'Newest that runs']];
  if (isMap(pol().asyncio)) opts.push(['asyncio', 'asyncio-safe per Windows version']);
  opts.push(['range', 'A range'], ['exact', 'An exact version']);
  s.replaceChildren(...opts.map(([v, l]) => opt(v, l)));
  s.value = opts.some(([v]) => v === cur) ? cur : 'newest';
  $('rt-p-range-label').hidden = !['range', 'exact'].includes(s.value);
}

function runPreview() {
  if (!S.files || !S.rt) return;
  const status = $('rt-p-status');
  const rt = S.rt;
  const app = previewApp(rt);
  if ((app.select === 'range' || app.select === 'exact') && !app.range) { status.textContent = 'Enter the versions to preview.'; return; }
  let note = '';
  let changes = S.ov.changes;
  // The edit being made counts once it is valid.
  if (S.sel && S.draft !== undefined && S.dirty) {
    if (S.problems.some((p) => !p.warn)) note = ' The edit you\'re making isn\'t valid yet, so it isn\'t in this preview.';
    else {
      const ch = draftChange();
      const drop = ch.revert || O.changeKey(ch.put);
      changes = changes.filter((c) => O.changeKey(c) !== drop);
      if (ch.put) changes = [...changes, ch.put];
      note = ' Includes the edit you haven\'t saved yet.';
    }
  } else if (S.tab === 'policy' && S.policyDraft && S.policyDraft.dirty) {
    if (policyProblems().some((p) => !p.warn)) note = ' The policy edit isn\'t valid yet, so it isn\'t in this preview.';
    else {
      const { puts, reverts } = policyChanges();
      const drop = new Set([...reverts, ...puts.map(O.changeKey)]);
      changes = [...changes.filter((c) => !drop.has(O.changeKey(c))), ...puts];
      note = ' Includes the policy edit you haven\'t saved yet.';
    }
  }
  let before, after, cat;
  const t0 = performance.now();
  try {
    if (!baseSubs.has(rt)) baseSubs.set(rt, O.subsetCatalog(S.files, [rt]));
    const base = baseSubs.get(rt);
    before = resolve(base, app);
    const eff = O.applyOverlay(S.files, changes);
    cat = changes.length ? O.subsetCatalog(eff.files, [rt]) : base;
    after = changes.length ? resolve(cat, app) : before;
  } catch (e) {
    status.textContent = 'The resolver stopped: ' + (e && e.message ? e.message : e);
    $('rt-p-table').replaceChildren();
    return;
  }
  const ms = Math.round(performance.now() - t0);
  const family = app.platforms[0];
  const b0 = planBlocks(before), b1 = planBlocks(after);
  const scale = (cat.os && cat.os.byFamily && cat.os.byFamily[family]) || [];
  const rows = [];
  let nChanged = 0;
  for (const machine of ['amd64', 'arm64', 'x86']) {
    for (const o of scale) {
      if (!o.arches.includes(machine)) continue;
      const p0 = picksFor(b0, o, machine), p1 = picksFor(b1, o, machine);
      const k0 = p0.map((p) => p.key).join('/'), k1 = p1.map((p) => p.key).join('/');
      const u0 = p0.map((p) => p.urls + p.steps).join('/'), u1 = p1.map((p) => p.urls + p.steps).join('/');
      const changed = k0 !== k1 || u0 !== u1;
      if (changed) nChanged++;
      rows.push({ o, machine, p0, p1, changed, same: k0 === k1 });
    }
  }
  const only = $('rt-p-diffonly').checked;
  // `other`: the built-in picks, to say when the same file now downloads
  // from other URLs or installs with other steps.
  const cell = (ps, other) => el('td', {}, ...ps.map((p, i) => el('div', {},
    p.minbuild ? el('span', { class: 'muted small', text: 'build ' + p.minbuild + '+: ' }) : null,
    el('span', { class: p.fail ? 'status fail' : '', text: p.text }),
    other && other[i] && other[i].key === p.key && other[i].urls + other[i].steps !== p.urls + p.steps
      ? el('div', { class: 'small rt-note', text: other[i].urls !== p.urls ? 'same file, other download URLs or order' : 'same file, other install steps' }) : null)));
  $('rt-p-table').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', { text: 'System' }), el('th', { text: 'Arch' }), el('th', { text: 'Built-in catalogue' }), el('th', { text: 'With your changes' }))),
    el('tbody', {}, ...rows.filter((r) => !only || r.changed).map((r) => el('tr', { class: r.changed ? 'rt-prow-changed' : '' },
      el('td', { text: r.o.label }), el('td', { text: r.machine }),
      cell(r.p0), cell(r.p1, r.p0)))));
  const d = diffLines(before.split('\n'), after.split('\n'));
  const pre = $('rt-p-diff');
  if (!d) pre.replaceChildren('Too long to compare here.');
  else {
    const keep = new Set();
    d.forEach(([t], i) => { if (t !== ' ') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    const out = [];
    let gap = false;
    d.forEach(([t, line], i) => {
      if (!keep.has(i)) { if (!gap && out.length) out.push(el('span', { class: 'rt-gap', text: '…\n' })); gap = true; return; }
      gap = false;
      out.push(el('span', { class: t === '+' ? 'rt-add' : t === '-' ? 'rt-del' : '', text: t + ' ' + line + '\n' }));
    });
    pre.replaceChildren(...(out.length ? out : ['No difference: your changes don\'t change this plan.']));
  }
  const nd = d ? d.filter(([t]) => t !== ' ').length : 0;
  $('rt-p-diff-sum').textContent = 'Plan lines that change (' + nd + ')';
  $('rt-p-plan').textContent = after;
  status.textContent = (changes.length ? nChanged + ' of ' + rows.length + ' systems get something different.' : 'No changes to compare yet: this is the built-in plan.') + note + ' (' + ms + ' ms)';
  status.setAttribute('data-changed', String(nChanged));
}

/* ---------- start ---------- */

function paintAll() {
  S.ov = O.overlayState();
  refreshStatus();
  S.rowsKey = '';
  paintRuntimes();
  paintHead();
  paintTabs();
  paintDetail();
  paintChanges();
  paintPreviewControls();
  schedulePreview();
}

function readView() {
  const h = new URLSearchParams(location.hash.slice(1).split('&').slice(1).join('&'));
  const rt = h.get('rt');
  if (rt && policyAll()[rt]) S.rt = rt;
  const tab = h.get('tab');
  if (['releases', 'recipes', 'rules', 'policy'].includes(tab)) S.tab = tab;
}

async function start() {
  if (S.started) return;
  S.started = true;
  if (!O.hasCatalog()) {
    $('rt-loading').hidden = true;
    $('rt-nocat').hidden = false;
    return;
  }
  try {
    S.files = await O.baseFiles();
    await O.loadOverlay();
  } catch (e) {
    $('rt-loading').textContent = 'Couldn\'t read the catalogue in this page: ' + (e && e.message ? e.message : e);
    return;
  }
  S.ctx = O.contextOf(S.files);
  S.rt = runtimeIds().includes('python') ? 'python' : runtimeIds()[0];
  readView();
  S.ov = O.overlayState();
  try {
    await need([S.rt]);
  } catch (e) {
    $('rt-loading').textContent = 'Couldn\'t read the catalogue in this page: ' + (e && e.message ? e.message : e);
    return;
  }
  $('rt-loading').hidden = true;
  $('rt-app').hidden = false;

  $('rt-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) pickTab(b.dataset.tab); });
  for (const k of ['os', 'arch', 'variant', 'format']) $('rt-f-' + k).addEventListener('change', () => { $('rt-rel-list').scrollTop = 0; paintReleases(); });
  $('rt-f-version').addEventListener('input', () => { $('rt-rel-list').scrollTop = 0; paintReleases(); });
  $('rt-f-changed').addEventListener('change', () => { $('rt-rel-list').scrollTop = 0; paintReleases(); });
  const list = $('rt-rel-list');
  let raf = 0;
  list.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; paintWindow(); }); });
  const remeasure = () => { rowSure = false; if (S.filtered && !$('rt-app').hidden) paintWindow(); };
  window.addEventListener('resize', remeasure);
  window.addEventListener('hashchange', () => { if (onPage()) setTimeout(remeasure, 0); });
  list.addEventListener('click', (e) => { const r = e.target.closest('.rt-vrow'); if (r) selectRow(Number(r.dataset.k)); });
  list.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    let k = S.sel && S.sel.kind === 'release' ? S.filtered.findIndex((r) => (S.sel.i >= 0 ? r.i === S.sel.i : r.id === S.sel.id)) : -1;
    k = Math.max(0, Math.min(S.filtered.length - 1, k + (e.key === 'ArrowDown' ? 1 : -1)));
    selectRow(k);
  });
  $('rt-rel-add').addEventListener('click', () => addItem('release'));
  $('rt-rec-add').addEventListener('click', () => addItem('recipe'));
  $('rt-rule-add').addEventListener('click', () => addItem('rule'));
  $('rt-rule-os').addEventListener('change', paintRules);
  $('rt-export').addEventListener('click', exportOverlay);
  $('rt-import').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  $('rt-reset').addEventListener('click', () => { $('rt-reset-confirm').hidden = false; });
  $('rt-reset-no').addEventListener('click', () => { $('rt-reset-confirm').hidden = true; });
  $('rt-reset-yes').addEventListener('click', async () => { $('rt-reset-confirm').hidden = true; await O.setChanges([]); S.sel = null; S.draft = undefined; S.policyDraft = null; paintAll(); });
  $('rt-review-add').addEventListener('click', () => applyImport(false));
  $('rt-review-replace').addEventListener('click', () => applyImport(true));
  $('rt-review-cancel').addEventListener('click', () => { pendingImport = null; $('rt-review').hidden = true; });
  for (const id of ['rt-p-family', 'rt-p-select', 'rt-p-diffonly']) $(id).addEventListener('change', () => { $('rt-p-range-label').hidden = !['range', 'exact'].includes($('rt-p-select').value); schedulePreview(); });
  $('rt-p-range').addEventListener('input', schedulePreview);
  window.addEventListener('ib-overlay-change', async () => {
    const ov = O.overlayState();
    // New changes may be about folders not unpacked yet.
    try { await need([S.rt], ov.changes); } catch (e) { failed(e); }
    const keep = S.sel && S.dirty ? { sel: S.sel, draft: S.draft } : null;
    S.ov = O.overlayState();
    refreshStatus();
    S.rowsKey = '';
    paintRuntimes();
    paintChanges();
    if (S.tab === 'policy') { if (!S.policyDraft || !S.policyDraft.dirty) S.policyDraft = null; paintPolicy(); }
    else paintTabs();
    if (keep) { S.sel = keep.sel; S.draft = keep.draft; }
    schedulePreview();
  });
  window.addEventListener('ib-api-change', paintMode);
  await apiReady();
  paintMode();
  paintAll();
}

const onPage = () => /^#runtimes(&|$)/.test(location.hash) || !globalThis.IB_ONE_FILE;
function maybeStart() {
  if (!$('rt-editor')) return;
  // The footer's "Save this page" option needs the overlay even before the
  // editor is opened.
  O.loadOverlay().then(() => { if (!S.started) { S.ov = O.overlayState(); if (S.files || !O.hasCatalog()) return; paintSaveLater(); } }).catch(() => {});
  if (onPage()) start();
}
function paintSaveLater() {
  // Enough state for paintSaveOption before the editor has started.
  S.ov = O.overlayState();
  paintSaveOption();
}
window.addEventListener('ib-overlay-change', () => { if (!S.started) paintSaveLater(); });
window.addEventListener('hashchange', () => { if (onPage()) start(); });
maybeStart();
