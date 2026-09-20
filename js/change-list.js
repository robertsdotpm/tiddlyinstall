// One rendering of a list of catalogue changes (js/overlay.js), used by the
// Runtimes page (js/catalog-editor.js: the changes in use, and an imported
// file's review) and by the once-a-session prompt for changes found in this
// browser's storage (js/overlay-consent.js).
//
// Everything shown comes from the catalogue or from a stored or imported
// file, so it is written with textContent and DOM properties only: no
// innerHTML with values. Plain ES2017 (the one-file page's floor).
//
//   describeChange(c, files) -> {title, fields, rt, kind}
//   changeItem(c, {files, status, badge, actions}) -> <li>
//
// `files` is the catalogue's files as far as they are unpacked (js/overlay.js
// baseFiles/ensureFolders). With only the shared files, or none at all, the
// description still works: it then shows what the change puts there, without
// the value it replaces.
import * as O from './overlay.js';

const isMap = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/* ---------- DOM helpers (shared with js/catalog-editor.js) ---------- */

// el('div', {class: 'x', text: 'y', onclick: f, 'aria-label': 'z'}, child, ...)
export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (k === 'checked') e.checked = !!v;
    // (setAttribute, not dataset: IE 10's stand-in can't add keys.)
    else if (k === 'dataset') for (const dk of Object.keys(v)) e.setAttribute('data-' + dk.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), v[dk]);
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
  return e;
}

export const short = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const show = (v) => (v === undefined ? '(not set)' : v === null ? '(nothing)' : typeof v === 'string' ? (v === '' ? '(empty)' : v) : JSON.stringify(v));
export const matchText = (v) => (v == null ? 'any' : Array.isArray(v) ? v.map((x) => (x === null ? '(none)' : x)).join(' | ') : String(v));

/* ---------- describing one change ---------- */

function runtimesOf(files) {
  const pol = files && files['policy.json'];
  return isMap(pol) && isMap(pol.runtimes) ? pol.runtimes : {};
}

// The runtime a catalogue folder belongs to, and its label (python2's files
// are python's). Falls back to the folder's own name.
function runtimeOfFolder(rts, folder) {
  if (isMap(rts[folder])) return folder;
  const ids = Object.keys(rts).filter((k) => isMap(rts[k])).sort();
  return ids.find((id) => (rts[id].folder || id) === folder) || folder;
}

// One change in words: a title, and the fields it changes.
export function describeChange(c, files) {
  let kind = '';
  try { kind = O.pathKind(c.path); } catch (e) { return { title: 'Unknown change', fields: [], rt: '', kind: '' }; }
  const rts = runtimesOf(files);
  const folder = O.pathRuntime(c.path);
  const rt = kind === 'policy' ? c.path[2] : runtimeOfFolder(rts, folder);
  const label = isMap(rts[rt]) && rts[rt].label ? rts[rt].label : rt;
  const base = c.op === 'add' ? undefined : O.baseValue(files || {}, c.path);
  const v = c.op === 'remove' ? base : c.value;
  const verb = { add: 'Added', replace: 'Changed', remove: 'Removed' }[c.op];
  const last = c.path[c.path.length - 1];
  let what = '';
  // What the change is about: the new value, the old one, or (for a removal
  // whose folder isn't unpacked) the release the path names.
  const iv = isMap(v) ? v : isMap(base) ? base : isMap(last) ? last : {};
  if (kind === 'release') what = 'release ' + [iv.version, iv.os, iv.arch, iv.variant, iv.format].filter((x) => x).join(' ');
  else if (kind === 'recipe') what = 'recipe ' + (c.path[2] === '-' ? '(new)' : c.path[2] + 1) + ' (' + matchText(iv.match && iv.match.os) + ', ' + matchText(iv.match && iv.match.format) + ', ' + (iv.method || '?') + ')';
  else if (kind === 'rule') what = 'support rule ' + (c.path[2] === '-' ? '(new)' : c.path[2] + 1) + ' (' + (iv.os || '?') + ' ' + (iv.versions || 'any version') + (iv.min_os ? ', from ' + iv.min_os : '') + ')';
  else what = 'policy: ' + c.path[3];
  const fields = [];
  if (c.op === 'replace' && base !== undefined) {
    if (kind === 'policy') fields.push({ name: c.path[3], from: show(base), to: show(c.value) });
    else if (isMap(base) && isMap(c.value)) {
      for (const k of new Set([...Object.keys(base), ...Object.keys(c.value)])) {
        if (O.deepEqual(base[k], c.value[k])) continue;
        const a = base[k], b = c.value[k];
        // Lists of text (mirrors): only the positions that differ.
        if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every((x) => typeof x === 'string') && Math.max(a.length, b.length) <= 60) {
          for (let i = 0; i < Math.max(a.length, b.length); i++) {
            if (a[i] !== b[i]) fields.push({ name: k + ' ' + (i + 1), from: a[i] === undefined ? '' : a[i], to: b[i] === undefined ? '(gone)' : b[i] });
          }
          continue;
        }
        fields.push({ name: k, from: show(a), to: show(b) });
      }
    }
  } else if (c.op === 'add' || (c.op === 'replace' && base === undefined)) {
    // An addition, or a change whose folder isn't unpacked: what it puts there.
    if (kind === 'release') fields.push({ name: 'url', from: '', to: show(v && v.url) }, { name: 'ib_sha256', from: '', to: show(v && v.ib_sha256) });
    if (kind === 'recipe' && isMap(v) && Array.isArray(v.steps)) v.steps.forEach((s, i) => fields.push({ name: 'step ' + (i + 1), from: '', to: show(s) }));
    if (kind === 'rule' || kind === 'policy') fields.push({ name: 'value', from: '', to: show(v) });
  }
  return { title: label + ': ' + verb + ' ' + what, fields, rt, kind };
}

/* ---------- one <li> of the list ---------- */

// `status` {ok, why, stale, invalid} marks a change that wouldn't apply;
// `badge` is the wording for one that would ("in use", "will apply");
// `actions` are extra buttons ([{text, onclick, dataset}]).
export function changeItem(c, { files = null, status = null, badge = 'in use', actions = [] } = {}) {
  const d = describeChange(c, files);
  const st = status || { ok: true };
  const li = el('li', { class: st.ok ? '' : 'rt-change-bad' },
    el('div', { class: 'rt-change-head' }, el('span', { class: 'rt-change-title', text: d.title }),
      st.ok ? (badge ? el('span', { class: 'rt-badge rt-changed', text: badge }) : null)
        : el('span', { class: 'rt-badge rt-stale', text: (st.invalid ? 'invalid: ' : 'not applied: ') + st.why })),
    d.fields.length ? el('dl', { class: 'rt-diffs' }, ...d.fields.slice(0, 12).flatMap((f) => [
      el('dt', { text: f.name }),
      el('dd', {}, f.from !== '' ? el('del', { text: short(f.from, 300) }) : null, f.from !== '' ? ' → ' : '', el('ins', { text: short(f.to, 300) }))])) : null);
  if (actions.length) {
    li.append(el('div', { class: 'actions rt-change-acts' },
      ...actions.map((a) => el('button', { type: 'button', class: 'link-button', text: a.text, dataset: a.dataset, onclick: a.onclick }))));
  }
  return li;
}
