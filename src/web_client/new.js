// new.html: turn the form into POST /api/jobs (docs/api.md), then open the
// ticket page. What each field means is src/shared/form-job.js's, which the build
// server uses too when the form is posted without JavaScript (its action,
// POST /submit). Also fills the "Newest that runs on the user's system"
// table from GET /api/catalog/runtimes.
import { apiRequest, errorText, mountApiFooter, pageUrl, apiLocal, apiBase, apiReady, setApiBase, LOCAL, localSubmit } from './api.js';
import { tarWrite } from '../shared/tifile.js';
import { loadOverlay, overlayState, hasCatalog, changedRuntimes } from './overlay.js';
import { jobFromForm, BUILD_DEFAULTS, ENTRY_DEFAULTS, TEMPLATE_FILES, OFFLINE_TARGETS, ARCH_LABEL, MAC_ARCH, FAMILY_ARCHES, FAMILY_LABEL, NO_32_BIT,
  PACK_WARN_MB, PACK_MAX_MB, offlineField, offlineSizeMb, offlineTargets, archCoverage, vcmp, parseSource,
  packBudget, packEnv } from '../shared/form-job.js';
import { templateLaunch } from '../shared/templates.js';
import { mountWriteEditor } from './write-editor.js';
import { mountDialog } from './dialog.js';
import { mountOverlayConsent } from './overlay-consent.js';
import { openNotices } from './open-notice.js';
import { setPackDestination } from './local-api.js';

mountApiFooter();
mountOverlayConsent();

const form = document.getElementById('new-form');
mountWriteEditor(form);
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

// The form, as src/shared/form-job.js reads it (the server reads a plain post of
// the same form the same way).
const reader = {
  val: (name) => String(val(name) || ''),
  checked,
  launchEdited: (runtime) => {
    const entry = form.elements['entry_' + runtime];
    return !!entry && entry.value !== entry.defaultValue;
  },
  buildEdited: (runtime) => {
    const build = form.elements[runtime === 'cc' ? 'cc_build' : 'build_' + runtime];
    return !!build && build.value.trim() !== (Object.prototype.hasOwnProperty.call(BUILD_DEFAULTS, runtime) ? BUILD_DEFAULTS[runtime] : '');
  },
  has: (name) => !!form.elements[name],
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

/* ---------- where this build will happen ---------- */

// The page can build installers itself or send the job to a server,
// and which one it is changes what leaves this computer, so the form says
// so plainly before the build (design.md 11.0 item 6). The build page says
// the same for the finished job. Written as text into the page, so a saved
// copy still reads right; short, so it fits a phone.
const whereBoxes = Array.from(document.querySelectorAll('.build-where'));

// Files from the user's computer are built here whatever the backend
// (src/web_client/new.js submit, below), so the wording follows the form too.
function paintWhere() {
  if (!whereBoxes.length) return;
  const host = String(apiBase()).replace(/^https?:\/\//, '');
  const uploaded = val('source_kind') === 'local';
  let main, rest;
  if (apiLocal()) {
    main = 'Built in this page';
    rest = ': your browser makes the installers, and nothing is sent to a server.';
  } else if (uploaded) {
    main = 'Built in this page';
    rest = ': files from your computer are packed here, not sent to the server at ' + host + '.';
  } else {
    main = 'Built by the server at ' + host;
    rest = ': your settings go there, and the installers come back.';
  }
  for (const box of whereBoxes) {
    box.replaceChildren(document.createElement('strong'), rest);
    box.firstChild.textContent = main;
  }
}
paintWhere();
window.addEventListener('ti-api-change', paintWhere);
form.addEventListener('change', paintWhere);      // "Where's the code?"
apiReady().then(paintWhere).catch(() => {});

async function buildJob() {
  const problems = [];
  const icon = await iconField(problems);
  const local = localPick && val('source_kind') === 'local' ? { name: localPick.name, size: localPick.bytes.length, base64: bytesToBase64(localPick.bytes) } : null;
  return jobFromForm(reader, { icon, local, problems });
}

/* ---------- submit ---------- */

const errBox = document.createElement('p');
errBox.className = 'form-error';
errBox.setAttribute('role', 'alert');
errBox.hidden = true;
// The form's last block: the build bar (new.html, "You'll get ..." and the
// button). Errors and the catalogue-overlay note go immediately above it, so
// they are the last thing read before the button is pressed.
const lastActions = form.querySelector(':scope > .build-bar, :scope > .actions');
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
    // A pack too big to hold in memory can still be written straight to a
    // file, and the dialog that asks where needs the click that is still
    // in hand (src/web_client/local-api.js savePacked).
    if (job.offline && apiLocal()) await askWhereToPack(job);
    // Files from the user's computer are built by the page itself.
    const r = job.source.kind === 'upload' ? await localSubmit(job) : await apiRequest('/api/jobs', { method: 'POST', body: job });
    location.href = pageUrl('build.html', 'job=' + encodeURIComponent(r.id));
  } catch (err) {
    showError((apiLocal() ? 'Couldn\'t build this: ' : 'The server refused this: ') + errorText(err));
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

// Architecture names, everywhere in this page (src/shared/form-job.js). 32-bit and
// 64-bit are always spelled out: "x64" and "amd64" mean nothing to most
// people, and "x86" is read as either.
const ARCH = ARCH_LABEL;

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
    const rows = entry.newest.map((r) => {
      const arch = r.arch ? ' <span class="muted">, ' + esc(ARCH[r.arch] || r.arch) + '</span>' : '';
      let v = r.version ? esc(r.version) : '<span class="muted">Nothing in the catalogue runs here</span>';
      // `behind` (api.md) is the resolver saying this row doesn't get the
      // newest. It isn't only a 32-bit thing -- Go 1.10.8 on Vista, Java 8
      // on XP -- and it was never shown before.
      if (r.version && r.behind) {
        v += ' <span class="arch-ceiling">- not the newest; ' + esc(entry.label || rt) + ' reaches ' +
          esc(r.behind) + ' on ' + esc(FAMILY_LABEL[r.family] || r.family) + '</span>';
      }
      return '<tr><td>' + esc(r.covers || r.family || '') + arch + '</td><td>' + v + '</td></tr>';
    });
    // An architecture the resolver makes no block for at all would
    // otherwise just be missing from the table, and a missing row reads as
    // "supported, not shown". Say it instead. A block that exists and
    // fails already says it in its own row, so it isn't repeated here.
    for (const fam of Object.keys(FAMILY_ARCHES)) {
      if (!entry.newest.some((r) => r && r.family === fam)) continue;
      for (const a of FAMILY_ARCHES[fam]) {
        if (entry.newest.some((r) => r && r.family === fam && (r.arch === a || r.arch === 'universal' || r.arch === 'any'))) continue;
        rows.push('<tr><td>' + esc(FAMILY_LABEL[fam]) + ' <span class="muted">, ' + esc(ARCH[a]) +
          '</span></td><td><span class="muted">No build in the catalogue</span></td></tr>');
      }
      if (fam === 'macos') {
        rows.push('<tr><td>macOS <span class="muted">, 32-bit</span></td><td><span class="muted">' +
          esc(NO_32_BIT.macos) + '</span></td></tr>');
      }
    }
    table.tBodies[0].innerHTML = rows.join('');
    hint.textContent = (apiLocal() ? 'From this page\'s catalogue' + (catalog.changed ? ', with your changes from the Registry page' : '') : 'From the server\'s catalogue') +
      ': one row per runtime install script it makes for ' + (entry.label || rt) + ', by OS version and architecture. ' +
      'The installer carries them all and picks on the machine.';
    panel.classList.remove('py-panel');   // show it for every language with data
  } else {
    table.tHead.innerHTML = staticHead;
    table.tBodies[0].innerHTML = staticBody;
    hint.innerHTML = staticHint;
    panel.classList.add('py-panel');      // back to the static Python table
  }
}

/* ---------- how the app starts ---------- */

// The launch command is the one thing about a project that cannot be
// inferred. Which packages to install can be read off the files -- a
// requirements.txt means pip, a package.json means npm -- but nothing in a
// repo says whether main.py is a library, a command, or something started
// with -m. So it lives in the main form (new.html, "How does it start?"),
// not under Customise, and the form says how much we actually know:
//
//   a GitHub repo, a URL, an upload -> we don't know at all: prominent,
//     with why it matters;
//   a package from a package registry -> the package registry names the
//     program it installs and {bin} comes from that: present, quieter;
//   written here -> we wrote the template, so we know the file it starts:
//     present, quieter, and the field shows the template's own command.
//
// The defaults themselves are unchanged (src/shared/form-job.js ENTRY_DEFAULTS).

const launchField = document.getElementById('launch-field');
const launchWhyRepo = document.getElementById('launch-why-repo');
const launchWhyWrite = document.getElementById('launch-why-write');

// <root> per platform and "Install for" (design.md 1.1), and the
// illustrative folder names that section and this form's own "Install
// locations" preview already use, so the two never disagree.
const ROOTS = {
  windows: { user: '%LOCALAPPDATA%\\', system: 'C:\\', sep: '\\' },
  linux: { user: '~/.local/share/', system: '/opt/', sep: '/' },
  macos: { user: '~/Library/', system: '/Library/', sep: '/' },
};
const EG_APP = 'k3m9q2x7v4p8';      // the app's folder
const EG_RT = 'tjfq5rqwnnrx';       // its runtime's folder

// Only the tokens a command actually uses are explained, in the order they
// appear. {runtime} and {bin} are left as tokens in the example rather than
// given a path: where a runtime keeps its program differs by runtime and
// platform (python.exe at the top of the embed zip, bin/java on a JDK), and
// a made-up path would be worse than none.
// Only what the example could not show for itself: {app_dir} and the rest
// come out as real folders above, and a path explains itself better than a
// gloss does. These three don't -- two are left as tokens because where a
// runtime keeps its program differs by runtime and platform, and {exe}
// expands to nothing outside Windows, which would otherwise just look like
// a typo. Matched against the command as written, not as expanded.
const TOKEN_WHY = [
  ['{runtime}', (l, root) => 'the ' + l + ' this installer sets up, inside its own folder under ' + root +
    ' - never one already on the computer'],
  ['{bin}', (l) => 'that ' + l + '’s scripts folder'],
  ['{exe}', () => '“.exe” on Windows and nothing on Linux or macOS'],
];

// The platform the example is drawn for: the first one ticked.
function examplePlatform() {
  for (const p of ['windows', 'linux', 'macos']) if (checked('target_' + p)) return p;
  return 'windows';
}

// The name {project} stands for: the package or repo being packaged, else
// the app's name, else something obviously stood in for.
function exampleProject() {
  if (val('source_kind') === 'repo') {
    const src = val('source').trim();
    const parsed = src ? parseSource(src, 'latest', '') : null;
    // A URL's last segment is an archive's file name, not a project name,
    // so only a repo or a package can say what {project} will be.
    if (parsed && (parsed.kind === 'github' || parsed.kind === 'package')) {
      const last = String(parsed.value || '').split('/').pop();
      if (last) return last.replace(/\.git$/, '');
    }
  }
  const name = val('app_name').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return name || 'myapp';
}

function runtimeLabel() {
  const e = catalogEntry(val('runtime'));
  const sel = form.elements.runtime;
  const opt = sel && sel.selectedOptions && sel.selectedOptions[0];
  return (e && e.label) || (opt && opt.textContent) || val('runtime') || 'the runtime';
}

// What is in the field now, whichever language is showing.
const launchInput = () => form.elements['entry_' + val('runtime')];

// Which of the four we are in: 'github', 'url', 'package', 'write', 'local'.
// The first three all come from the one "A GitHub repo or package" choice,
// and src/shared/form-job.js's own parser decides which, so the form and the job
// can't read the same text differently.
function sourceKindNow() {
  const k = val('source_kind');
  if (k !== 'repo') return k;
  const src = val('source').trim();
  return src ? parseSource(src, 'latest', '').kind : 'github';
}

// A written app's field follows its template, so what it shows is what will
// run. The "was it edited?" test is value !== defaultValue (the `reader`
// above, and src/shared/form-job.js for a plain post), so both move together while
// the field is untouched and only `defaultValue` moves once it has been
// edited: an edit is never silently thrown away, and an untouched field is
// never mistaken for one.
function syncLaunchDefault() {
  const rt = val('runtime');
  const el = form.elements['entry_' + rt];
  if (!el) return;
  const want = val('source_kind') === 'write'
    ? (templateLaunch(rt, val('template')) || ENTRY_DEFAULTS[rt] || el.defaultValue)
    : (Object.prototype.hasOwnProperty.call(ENTRY_DEFAULTS, rt) ? ENTRY_DEFAULTS[rt] : el.defaultValue);
  if (!want) return;
  const untouched = el.value === el.defaultValue;
  el.defaultValue = want;
  if (untouched) el.value = want;
}

function paintLaunch() {
  syncLaunchDefault();
  if (!launchField) return;
  const kind = sourceKindNow();
  // Quiet where the default comes from something we can see: a package
  // registry's metadata, or a template we wrote.
  const known = kind === 'package' || kind === 'write';
  launchField.classList.toggle('launch-quiet', known);
  if (launchWhyRepo) {
    // Only a package registry gets a sentence here. A GitHub repo used to
    // get a paragraph explaining why we cannot know; the eyebrow says that.
    launchWhyRepo.textContent = kind === 'package'
      ? 'For a package from a package registry the default is usually right: the package registry says which program the package ' +
        'installs, and that is what this runs. Change it only if your package starts some other way.'
      : '';
    launchWhyRepo.hidden = kind !== 'package';
  }
  if (launchWhyWrite && kind === 'write') {
    const fields = templateFilesOf() || {};
    const files = Object.keys(fields).map((k) => fields[k]);
    launchWhyWrite.textContent = files.length
      ? 'Set from the template you picked, which we wrote, so we know it starts ' + files[0] +
        '. Change it if you rename that file or start it another way.'
      : 'Set from the template you picked, which we wrote, so we know the file it starts. Change it if you start it another way.';
  }
}

// The template's files, for naming the one that starts (src/shared/templates.js).
function templateFilesOf() {
  const t = TEMPLATE_FILES[val('runtime')];
  return t ? t[val('template')] : null;
}

// The command with the folders filled in, then a line for each token it
// actually uses. An example beats a list: someone meeting {app_dir} for the
// first time learns more from one expanded path than from four glosses.

/* ---------- 32-bit and 64-bit: what an installer covers ---------- */

// What is covered, and the version ceilings that come with it, are worked
// out in src/shared/form-job.js (archCoverage) from the resolver's own answer, and
// shared with the build page so the two can't disagree.

// The "Build for" lines: what each platform's installer covers. Not a
// choice -- one online installer carries a block per architecture and picks
// on the machine (docs/format.md section 3) -- so this says what is covered
// and, where 32-bit isn't, why not.
const archCoverList = document.getElementById('arch-cover');
const archCoverNote = document.getElementById('arch-cover-note');

// How a ceiling is said: 32-bit is the case people most need warning about
// (Node's 32-bit Linux stops at 9.11.2, from 2018, because nodejs.org
// stopped building it), but the same sentence serves an old OS version.
function ceilingText(fam, a, cell, label) {
  return a === 'x86'
    ? ' - the newest 32-bit build there is. ' + label + ' reaches ' + cell.behind + ' on ' + FAMILY_LABEL[fam] + ' otherwise.'
    : ' - not the newest. ' + label + ' reaches ' + cell.behind + ' on ' + FAMILY_LABEL[fam] + ' elsewhere.';
}

// A list item for one architecture: whether there is a build at all, the
// version it tops out at, and -- the thing that must not be buried -- when
// that is behind what the rest of the family gets.
function archLine(fam, a, cell, label) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'arch-name';
  name.textContent = (fam === 'macos' ? MAC_ARCH[a] || ARCH[a] : ARCH[a]) + ': ';
  li.append(name);
  if (!cell.ok) {
    li.append('no build of ' + label + ' in the catalogue');
    li.className = 'arch-no';
    return li;
  }
  li.append(label + ' ' + cell.newest);
  if (cell.behind) {
    const w = document.createElement('strong');
    w.className = 'arch-ceiling';
    w.textContent = ceilingText(fam, a, cell, label);
    li.append(w);
  }
  return li;
}

function paintArchCover() {
  if (!archCoverList) return;
  const rt = val('runtime');
  const entry = catalogEntry(rt);
  const label = (entry && entry.label) || rt || 'this language';
  const cov = catalog ? archCoverage(entry) : null;
  for (const li of archCoverList.children) {
    const fam = li.dataset.family;
    const out = li.querySelector('.arch-cover-arches');
    if (!out || !fam || !cov) continue;       // no catalogue: leave the built-in text
    const kids = FAMILY_ARCHES[fam].map((a) => archLine(fam, a, cov[fam][a], label));
    // 32-bit macOS isn't a gap in the catalogue, it's a thing that stopped
    // existing; say which.
    if (fam === 'macos') {
      const li32 = document.createElement('li');
      li32.className = 'arch-no';
      li32.append(Object.assign(document.createElement('span'), { className: 'arch-name', textContent: '32-bit: ' }), NO_32_BIT.macos);
      kids.push(li32);
    }
    // musl (Alpine) is a separate answer from glibc, per architecture.
    const musl = FAMILY_ARCHES[fam].filter((a) => cov[fam][a].musl === true);
    const anyMusl = FAMILY_ARCHES[fam].some((a) => cov[fam][a].musl !== null);
    if (anyMusl) {
      const m = document.createElement('li');
      m.className = musl.length ? '' : 'arch-no';
      m.append(Object.assign(document.createElement('span'), { className: 'arch-name', textContent: 'musl (Alpine): ' }),
        musl.length ? musl.map((a) => ARCH[a]).join(', ') : 'nothing for any architecture');
      kids.push(m);
    }
    out.replaceChildren(...kids);
  }
  if (archCoverNote) {
    // One sentence, and only the part a publisher can act on. What Apple
    // did in 2015 and what a 32-bit machine needs at install time are both
    // true and neither changes anything they choose here, so they belong on
    // the installer's own review screen, where they are, and not on the form.
    archCoverNote.textContent = 'One installer covers all of these: it carries a plan for each and picks the right one on the ' +
      'computer it runs on, so there is nothing to choose here.';
  }
  paintOfflineArches(cov, label);
}

/* ---------- offline installers: the packed-target picker ---------- */

// The same warn/refuse/zip rule for every box in the table, architectures
// included: one running total, one warning, one refusal, one zip
// (packed-files.md section 9).
const offlineTable = document.getElementById('offline-targets');
const offlineSizeBox = document.getElementById('offline-size');
const offlineWarnBox = document.getElementById('offline-warn');
const offlineShapeZip = document.getElementById('offline-shape-zip');

const offlineBox = (id, arch) => form.elements[offlineField(id, arch)];

// Grey out an architecture the catalogue has no build for, with the reason
// in place of the size, so an empty list is never passed off as a choice.
// Where a build exists but is older than the 64-bit one, the version it
// would pack is on the box itself: an offline installer picks now, so this
// is the moment to see that 32-bit Linux means Node.js 9.11.2.
function paintOfflineArches(cov, label) {
  if (!offlineTable) return;
  for (const t of OFFLINE_TARGETS) {
    for (const a of t.arches) {
      const box = offlineBox(t.id, a.arch);
      if (!box) continue;
      const cell = cov && cov[t.platform][a.arch];
      const have = !cov || cell.ok;
      const lab = box.closest('label');
      box.disabled = !have;
      if (!have) box.checked = false;
      if (lab) lab.classList.toggle('arch-off', !have);
      const mb = lab && lab.querySelector('.arch-mb');
      if (mb) mb.textContent = have ? a.mb + ' MB' : 'no build of ' + label + ' for this';
      // A second line under the box, only where there is something to say.
      let why = lab && lab.querySelector('.arch-why');
      if (lab && !why) {
        why = document.createElement('span');
        why.className = 'small arch-why';
        lab.append(why);
      }
      if (!why) continue;
      // Only the rows that mean "the newest that runs there" can name a
      // version: an older Windows row picks its own, by OS range.
      if (!have || !t.latest) why.textContent = '';
      else if (cell && cell.behind) {
        why.textContent = 'Packs ' + label + ' ' + cell.newest + ceilingText(t.platform, a.arch, cell, label);
        why.className = 'small arch-why arch-ceiling';
      } else if (cell && cell.newest) {
        why.textContent = 'Packs ' + label + ' ' + cell.newest + '.';
        why.className = 'small arch-why muted';
      } else why.textContent = '';
    }
  }
  paintOfflineSize();
}

function paintOfflineSize() {
  if (!offlineSizeBox) return;
  const platforms = ['windows', 'linux', 'macos'].filter((p) => checked('target_' + p));
  const targets = offlineTargets(reader);
  // The runtimes, plus an uploaded source, which is packed with them.
  const uploadMb = localPick && val('source_kind') === 'local' ? Math.round(localPick.bytes.length / 1048576) : 0;
  const mb = offlineSizeMb(targets, platforms) + uploadMb;
  const n = targets.filter((t) => {
    const sys = OFFLINE_TARGETS.find((x) => t.indexOf(x.id + '_') === 0);
    return sys && platforms.indexOf(sys.platform) >= 0;
  }).length;
  offlineSizeBox.textContent = n
    ? 'About ' + mb + ' MB of packed files, over ' + n + ' system' + (n === 1 ? '' : 's') + ' and architecture' + (n === 1 ? '' : 's') + ', on top of the installer itself.'
    : 'Nothing ticked yet: an offline installer needs at least one system and architecture.';
  if (!offlineWarnBox) return;
  if (mb >= PACK_MAX_MB) {
    if (offlineShapeZip && !offlineShapeZip.checked) offlineShapeZip.checked = true;
    offlineWarnBox.textContent = 'About ' + mb + ' MB is past the ' + PACK_MAX_MB +
      ' MB one file can hold (the installer\'s metadata block counts in 32 bits), so Shape has been set to the zip. ' +
      'Untick some architectures to go back to a single file.';
    offlineWarnBox.hidden = false;
  } else if (mb >= PACK_WARN_MB) {
    offlineWarnBox.textContent = 'About ' + mb + ' MB is a large download for one installer. Each architecture ticked is a whole ' +
      'extra runtime; untick the ones your users don\'t have, or choose the zip under Shape.';
    offlineWarnBox.hidden = false;
  } else offlineWarnBox.hidden = true;
  paintPackWhere(mb, platforms);
}

/* ---------- which side of the line this browser is on ---------- */

// Packing happens in the browser when there is no server, and what a
// browser can hold was measured rather than assumed
// (docs/browser-packing.md). The publisher finds out here, at the tick,
// which of three answers applies -- and the two that are not "yes" say what
// would change them, because both are fixed by changing something on this
// screen.
//
// The size here is the form's estimate, so the words are "about"; the build
// itself works out the exact total from the plan and refuses before
// fetching anything if it is over. The estimate and the limit are compared
// the same way in both places (src/shared/form-job.js packBudget).
const offlineWhereBox = document.getElementById('offline-where');

// The largest single installer decides, not the sum: Windows, Linux and
// macOS are three files, built one after another, and the page holds one at
// a time (src/web_client/local-api.js).
function largestPackMb(platforms) {
  let most = 0;
  for (const p of platforms) {
    let mb = 0;
    for (const t of OFFLINE_TARGETS) {
      if (t.platform !== p) continue;
      for (const a of t.arches) if (checked(offlineField(t.id, a.arch))) mb += a.mb;
    }
    if (mb > most) most = mb;
  }
  return most;
}

function paintPackWhere(totalMb, platforms) {
  if (!offlineWhereBox) return;
  if (!apiLocal()) {
    offlineWhereBox.className = 'small muted offline-only';
    offlineWhereBox.textContent = 'The server packs these, and its own copies of the runtimes go into the files.';
    return;
  }
  const mb = largestPackMb(platforms);
  const picker = typeof globalThis.showSaveFilePicker === 'function' || typeof globalThis.showDirectoryPicker === 'function';
  const held = packBudget(packEnv(globalThis, { noPicker: true }));
  const lines = [];
  let cls = 'small muted offline-only';
  if (mb <= held.mb) {
    lines.push('Packed in this browser. The largest of these installers is about ' + mb + ' MB, and this browser is good for ' +
      held.mb + ' MB in one file, because ' + held.why + '.');
  } else if (picker) {
    lines.push('Packed in this browser, and written straight to a file: the largest of these is about ' + mb + ' MB, more than the ' +
      held.mb + ' MB this browser will hold in memory, so when you press Build it asks where to save and writes each installer ' +
      'there as it is made.');
  } else {
    cls = 'small warn-box offline-only';
    lines.push('Too big to pack in this browser: the largest of these is about ' + mb + ' MB and the limit here is ' + held.mb +
      ' MB, because ' + held.why + '. Untick systems or architectures until it fits, use the server, or use a browser that ' +
      'can write a file as it is made (Chrome or Edge on a computer).');
  }
  // The one thing no browser can do, whatever its memory: fetch a file our
  // mirror does not hold. Said as a fact about the choice, because it is
  // decided by which version is being packed, not by this machine.
  lines.push('Only files our mirror holds can be packed here -- a browser cannot download from the vendors, who send no ' +
    'cross-origin header. If one is missing, the build says which before it fetches anything.');
  offlineWhereBox.className = cls;
  offlineWhereBox.textContent = lines.join(' ');
}

// The destination for a pack this browser will not hold in memory, taken
// while the click that pressed Build is still fresh: a file picker needs
// that, and a build takes minutes. One dialog for one installer, one folder
// for several, and a cancel just falls back to the in-memory path, which
// then refuses if it must.
async function askWhereToPack(job) {
  const platforms = job.platforms || [];
  const mb = largestPackMb(platforms);
  const held = packBudget(packEnv(globalThis, { noPicker: true }));
  if (mb <= held.mb) return;
  try {
    if (platforms.length === 1 && typeof globalThis.showSaveFilePicker === 'function') {
      const handle = await globalThis.showSaveFilePicker({ suggestedName: 'installer' + EXT_FOR[platforms[0]] });
      setPackDestination({ fileFor: () => Promise.resolve({ handle }) });
    } else if (typeof globalThis.showDirectoryPicker === 'function') {
      const dir = await globalThis.showDirectoryPicker({ mode: 'readwrite' });
      setPackDestination({ fileFor: (name) => dir.getFileHandle(name, { create: true }).then((handle) => ({ handle })) });
    }
  } catch (e) {
    setPackDestination(null);        // cancelled: the in-memory path, or its refusal
  }
}

const EXT_FOR = { windows: '.exe', linux: '.run', macos: '.zip' };

// "Build for" starts as the computer this page is open on: someone making
// an installer almost always wants to try it here first, and the other two
// are one tick away. The HTML keeps all three checked, so /classic -- which
// has no JavaScript to run this -- still builds for everything; unticking
// happens only here, only when the form is untouched, and only when the OS
// is one we build for. An unrecognised OS (a BSD, say) leaves all three, on
// the grounds that a wrong guess is worse than no guess.
const TARGET_FOR_OS = [[/Windows/i, 'windows'], [/^macOS|Mac OS|iOS|iPadOS/i, 'macos'], [/Linux|ChromeOS|Android/i, 'linux']];
function defaultTargetsToThisComputer() {
  const boxes = ['windows', 'linux', 'macos'].map((p) => form.elements['target_' + p]);
  if (boxes.some((b) => !b) || boxes.some((b) => !b.checked)) return;   // touched, or restored: leave it
  const env = (globalThis.tiCompat && globalThis.tiCompat.env) || {};
  const hit = TARGET_FOR_OS.find(([re]) => re.test(String(env.os || '')));
  if (!hit) return;
  // No note explaining this: the three boxes show which one is ticked, and
  // that they are boxes says the others can be ticked too.
  for (const p of ['windows', 'linux', 'macos']) {
    if (p !== hit[1]) form.elements['target_' + p].checked = false;
  }
}
defaultTargetsToThisComputer();

// The architecture coverage list is a wall of catalogue facts that answers
// one question and then never changes, so it sits behind a link rather
// than under the three checkboxes it belongs to. The panel is not hidden
// in the markup -- dialog.js hides it -- so a page whose script does not
// arrive shows the list inline instead of losing it.
mountDialog({
  panel: document.getElementById('arch-panel'),
  opener: document.getElementById('arch-open'),
  closers: [document.getElementById('arch-close')],
  // Repaint on open: the language can change while the dialog is shut.
  onOpen: paintArchCover,
});

// The Run preview was opened by :target until 2026-09-22, which routed the
// page to Home and left the overlay 0x0 inside a hidden ancestor.
mountDialog({
  panel: document.getElementById('run-output'),
  opener: document.getElementById('run-open'),
  closers: [document.getElementById('run-close')],
  reveal: false,
});

form.addEventListener('change', paintOfflineSize);
paintOfflineSize();

/* ---------- what a recipient meets when they open it ---------- */

// Under the signing choice, because it is part of that decision: the
// platforms ticked at the top of the form and the mode chosen here decide
// whether someone who is sent this file meets SmartScreen, Gatekeeper or
// nothing. The wording is src/web_client/open-notice.js's, which the downloads on
// build.html use too.
const openNoticeBox = document.getElementById('open-notice');
const openNoticeList = document.getElementById('open-notice-list');

function paintOpenNotice() {
  if (!openNoticeBox || !openNoticeList) return;
  const platforms = ['windows', 'linux', 'macos'].filter((p) => checked('target_' + p));
  const rows = openNotices(platforms, radio('mode', 'unsigned'));
  openNoticeList.replaceChildren(...rows.map((r) => {
    const li = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = r.label;
    li.append(name, ' ' + r.text);
    return li;
  }));
  // Nothing ticked, or mode A (disabled in this prototype): say nothing
  // rather than something that isn't true of any file they will get.
  openNoticeBox.hidden = !rows.length;
}

form.addEventListener('change', paintOpenNotice);
paintOpenNotice();

form.elements.runtime.addEventListener('change', () => { paintCatalog(); paintArchCover(); });
paintArchCover();

// The launch field follows the language, the source, the platforms, the
// install root and the name, and is repainted as they are typed -- but
// only for the fields it reads, so typing in the code editor doesn't
// rebuild it on every keystroke.
const LAUNCH_INPUTS = ['source', 'app_name', 'rootname'];
form.addEventListener('change', paintLaunch);
form.addEventListener('input', (e) => {
  const n = e.target && e.target.name;
  if (n && (LAUNCH_INPUTS.indexOf(n) >= 0 || n.indexOf('entry_') === 0)) paintLaunch();
});
paintLaunch();
let catalogSeq = 0;
function fetchCatalog() {
  const seq = ++catalogSeq;
  apiRequest('/api/catalog/runtimes').then((c) => { if (seq === catalogSeq) { catalog = c; paintCatalog(); paintArchCover(); } })
    .catch(() => { /* a 4xx here just leaves the static table */ });
}
fetchCatalog();
// The table follows the catalogue: another server, or changes made on the
// Registry page (used when the page builds installers itself).
window.addEventListener('ti-api-change', () => { fetchCatalog(); paintOverlayNote(); });
window.addEventListener('ti-overlay-change', () => { if (apiLocal()) fetchCatalog(); paintOverlayNote(); });

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
  link.textContent = 'Registry page';
  const what = n + ' catalogue change' + (n === 1 ? '' : 's') + ' made in this browser (';
  if (apiLocal()) {
    const rts = [...changedRuntimes(overlayState().changes)].sort();
    const affected = rts.length
      ? ' Installers using ' + (rts.length === 1 ? rts[0] : rts.slice(0, -1).join(', ') + ' or ' + rts[rts.length - 1]) +
        ' can no longer show that their runtime steps came from us: what we signed is the steps as we published them, ' +
        'and these are yours now. Everything else is unaffected.'
      : '';
    overlayNote.replaceChildren('Builds use ' + what, link, ').' + affected +
      ' The installers\' review screens show the script they carry.');
  } else {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link-button';
    b.textContent = 'Build in this page instead';
    b.addEventListener('click', () => setApiBase(LOCAL));
    overlayNote.replaceChildren('The server uses its own catalogue, so your ' + what, link, ') aren\'t used. ', b);
  }
}
if (hasCatalog()) loadOverlay().then(() => apiReady()).then(paintOverlayNote).catch(() => {});
