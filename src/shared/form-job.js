// The New installer form's fields -> a POST /api/jobs request (docs/api.md).
// One mapping for both ways the form reaches the server:
//
//   - src/web_client/new.js, in the page: reads the form's elements and posts JSON;
//   - src/build_server/server.js, for a plain form post (POST /submit, from browsers
//     that can't run the page: old Internet Explorer, JavaScript off), and
//     for its /classic form, which uses the same field names.
//
// Neither side decides what a field means; this file does, so the two can't
// drift. The caller gives a reader of the form:
//
//   val(name)      the field's value, '' when there is no such field
//   checked(name)  whether a checkbox of that name is ticked
//   launchEdited(runtime)  whether the launch command was changed from the
//                  one the form started with
//   buildEdited(runtime)   (optional) the same for a compiled language's
//                  build command
//   has(name)      (optional) whether the form has that field at all: a
//                  template's file the form doesn't carry is the template's
//                  own text (src/shared/templates.js)
//
// and the icon ({choice, data?, filename?, type?}) and, for "From my
// computer", the picked archive ({name, base64}) or null: those are read
// differently in a page (File objects) and on the server (a multipart part).
// No DOM here: the server runs it too. Plain ES2017 (the one-file page's
// floor): no `?.` or `??`.

import { TEMPLATES, templateFor, templateFields, templateLaunch, platformProblem } from './templates.js';

export const MODES = { ours: 'A', yours: 'B', unsigned: 'C' };
export const COMPILED = ['cc', 'go', 'rust', 'zig', 'nim'];

// The code templates of "I'll write it here" are src/shared/templates.js's. This is
// runtime -> template -> the form's <textarea> name -> the file it becomes;
// new.html's editors are rendered from the same data (src/web_client/new.js).
export const TEMPLATE_FILES = {};
for (const rt of Object.keys(TEMPLATES)) {
  TEMPLATE_FILES[rt] = {};
  for (const id of Object.keys(TEMPLATES[rt])) TEMPLATE_FILES[rt][id] = templateFields(rt, id);
}

// The launch command each language's field starts with in new.html (its
// entry_<runtime> inputs' values; the same test checks these). A plain form
// post can't say whether the field was edited, so it is compared with this.
export const ENTRY_DEFAULTS = {
  python: '{runtime} -m {project}', node: '{runtime} {app_dir}', ruby: '{bin}/{project}',
  php: '{runtime} {app_dir}/index.php', java: '{runtime} -jar {app_dir}/{project}.jar',
  dotnet: '{runtime} {app_dir}/{project}.dll', r: '{runtime} {app_dir}/main.R', cc: '{app_dir}/{project}',
  go: '{app_dir}/{project}', rust: '{app_dir}/target/release/{project}', zig: '{app_dir}/bin/{project}',
  nim: '{app_dir}/{project}', none: '{app_dir}/{project}',
};

// The build command each compiled language's field starts with in new.html
// (build_<runtime>, and cc_build for C/C++; the same test checks these). A
// written app whose field is left as it was builds the way its template
// says (templates.js), not with this.
export const BUILD_DEFAULTS = {
  go: 'go build -o {app_dir}/{project}{exe} .', rust: 'cargo build --release --locked',
  zig: 'zig build -Doptimize=ReleaseSafe --prefix {app_dir}', nim: 'nimble -y build', cc: '',
};

// Offline installers: the systems and architectures a pack can cover, and
// roughly what each one adds. An online installer needs none of this -- it
// carries a plan block per architecture and picks on the machine it runs on
// (docs/format.md section 3, "32-bit and 64-bit, said plainly"). A pack has
// to carry the bytes, so here each architecture is a real choice with a real
// cost, and is ticked one at a time.
//
// `arch` values are the plan's own (`x86` is 32-bit, `amd64` is 64-bit
// Intel/AMD), so a target id reads the same as the `when` line it will make.
// `mb` is an estimate, shown in new.html next to each box; the same numbers
// are written there so the form still says something with no JavaScript, and
// tests/offline-test.mjs checks the two agree.
export const OFFLINE_TARGETS = [
  { id: 'win_1011', platform: 'windows', label: 'Windows 10, 11', latest: true,
    arches: [{ arch: 'amd64', mb: 30, on: true }, { arch: 'x86', mb: 28 }, { arch: 'arm64', mb: 30 }] },
  { id: 'win_78', platform: 'windows', label: 'Windows 7, 8, 8.1',
    arches: [{ arch: 'amd64', mb: 28 }, { arch: 'x86', mb: 26 }] },
  { id: 'win_vista', platform: 'windows', label: 'Windows Vista',
    arches: [{ arch: 'x86', mb: 55 }] },
  { id: 'win_xp', platform: 'windows', label: 'Windows XP',
    arches: [{ arch: 'x86', mb: 50 }] },
  { id: 'linux', platform: 'linux', label: 'Linux', latest: true,
    arches: [{ arch: 'amd64', mb: 35, on: true }, { arch: 'x86', mb: 33 }, { arch: 'arm64', mb: 35 }] },
  { id: 'mac', platform: 'macos', label: 'macOS', latest: true,
    arches: [{ arch: 'amd64', mb: 45, on: true }, { arch: 'arm64', mb: 45, on: true }] },
];

// How each architecture is named to people, everywhere in the page.
export const ARCH_LABEL = {
  amd64: '64-bit (x64)', x86: '32-bit (x86)', arm64: '64-bit ARM',
  universal: 'Universal (Intel and Apple Silicon)', any: 'Any architecture',
};

// macOS names its two by chip, not by width.
export const MAC_ARCH = { amd64: '64-bit Intel', arm64: 'Apple Silicon' };

// Which architectures each platform can have at all. macOS has no 32-bit
// entry on purpose.
export const FAMILY_ARCHES = { windows: ['amd64', 'x86', 'arm64'], linux: ['amd64', 'x86', 'arm64'], macos: ['amd64', 'arm64'] };
export const FAMILY_LABEL = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

// Where a platform has no 32-bit builds at all, and why. A fact, not an
// empty list: the form says it rather than silently showing nothing.
export const NO_32_BIT = {
  macos: 'Apple dropped 32-bit support in macOS 10.15 Catalina (2019), so nothing has a 32-bit macOS build.',
};

/* ---------- what a runtime covers, per platform and architecture ---------- */

// "Is 32-bit Linux supported?" has no one answer, so nothing here gives
// one. It depends on the runtime (Go yes, Python no), on the C library
// (musl is a separate answer from glibc, and only Go and Zig have it), and
// it comes with a version ceiling that can be years behind 64-bit: the
// newest 32-bit Linux Node.js is 9.11.2, from 2018, where 64-bit gets 26.
//
// The answer is read off the resolver's own (`GET /api/catalog/runtimes`:
// one `newest` row per plan block, with the block's `covers` text, the
// version it picked, and `behind` where that isn't the newest the family
// reaches). No page holds a second opinion about what is supported, and a
// runtime gaining or losing a 32-bit build needs no change to this file.
// Lives here because both the New installer form and the build page need
// it, and because it is plain data, with no DOM.

function vparts(v) {
  return String(v == null ? '' : v).split(/[^0-9]+/).filter((x) => x !== '').map(Number);
}
export function vcmp(a, b) {
  const x = vparts(a), y = vparts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  }
  return 0;
}

// {ok, newest, behind, musl} per family and architecture. A row with a null
// version is a block that fails: not covered. `universal` and `any` builds
// run on every architecture of their family. `musl` is null where no block
// mentions it, false where one does and fails, true where one works.
export function archCoverage(entry) {
  const out = {};
  for (const fam of Object.keys(FAMILY_ARCHES)) {
    out[fam] = {};
    for (const a of FAMILY_ARCHES[fam]) out[fam][a] = { ok: false, newest: '', behind: '', musl: null };
  }
  const rows = entry && Array.isArray(entry.newest) ? entry.newest : [];
  for (const r of rows) {
    const fam = out[r && r.family];
    if (!fam) continue;
    const arches = r.arch === 'universal' || r.arch === 'any' ? Object.keys(fam) : [r.arch];
    const isMusl = /musl/i.test(String(r.covers || ''));
    for (const a of arches) {
      const cell = fam[a];
      if (!cell) continue;
      if (isMusl && (cell.musl === null || r.version)) cell.musl = !!r.version;
      if (!r.version) continue;
      cell.ok = true;
      if (!cell.newest || vcmp(r.version, cell.newest) > 0) {
        cell.newest = r.version;
        cell.behind = r.behind ? String(r.behind) : '';
      }
    }
  }
  // An architecture whose best block already reaches the family's newest
  // has no ceiling to report, whatever the older blocks under it said.
  for (const fam of Object.keys(out)) {
    for (const a of Object.keys(out[fam])) {
      const c = out[fam][a];
      if (c.behind && vcmp(c.newest, c.behind) >= 0) c.behind = '';
    }
  }
  return out;
}


// Packed-size limits, shared by the form's live total and its refusal
// (packed-files.md section 9, design.md 11.0). One mechanism: the OS rows
// and the architecture boxes feed the same number.
export const PACK_WARN_MB = 500;
export const PACK_MAX_MB = 1900;   // the metadata block's 32-bit offsets stop near 2 GiB
// The macOS installer is a zip, and a zip is built whole: the same shape of
// limit, under src/shared/builder.js MAX_MAC_PACK (1000 MB), which is where a
// build is actually refused.
export const PACK_MAC_MAX_MB = 900;

/* ---------- what this browser can be trusted to pack ---------- */

// docs/browser-packing.md measured what browsers really manage, machine by
// machine: 96 MB on a 744 MB 32-bit VM and on Firefox 52, 192 MB on 32-bit
// Edge, 256 MB on Windows XP, 512 MB on a phone, 1536 MB on anything with
// room. Those are ceilings found by bisection -- the size at which the tab
// died -- and the page cannot tell which row it is on: Supermium on 32-bit
// XP reports itself as `Windows NT 10.0; Win64; x64`, and Firefox on a
// 32-bit Linux VM reports `Linux x86_64`, so neither the OS nor the word
// length can be read off the user agent. `jsHeapSizeLimit` is no better:
// every Chromium measured exceeded its own reported limit, by 4.6 GB
// against 4.0 on 64-bit and by 812 MB against 515 on XP.
//
// So the budget is not computed from a guess about the machine. It starts
// at a size **every machine measured actually completed** and moves only
// on things the page can know for certain:
//
//   - the floor, 96 MB, is the largest pack the two tightest machines
//     finished -- and they finished it with the old three-copy path, which
//     needed about twice the heap the one-buffer path now does. A size
//     that was reached with twice the memory is the most conservative
//     starting point there is evidence for, and it clears the largest
//     single default installer (90 MB, macOS) that section 2 of the doc
//     lists.
//   - `navigator.deviceMemory` exists on Chromium only, is rounded down to
//     a power of two and is capped at 8, and it describes the device, not
//     what is free on it. It may therefore *raise* the budget only in the
//     two steps below, each of which sits under a machine of half that
//     size that was measured to work (a 3.9 GB Linux box packed 512 MB, a
//     2 GB XP box packed 256 MB); and it *lowers* it when the device says
//     it is small, because a phone with other apps open gets less than the
//     emulator that was measured. Its absence means "unknown", which takes
//     the floor rather than the benefit of the doubt.
//   - what the page is already holding (`usedJSHeapSize`, Chromium again)
//     comes off the top: an uploaded archive sits in the same heap the
//     pack has to fit in.
//   - `showSaveFilePicker()` changes the question entirely. Writing to the
//     file as it is made held 44-116 MB while writing 4.3 GB, so the limit
//     there is the installer format's own (32-bit offsets), not memory.
//
// Where it refuses, it says what would make it possible, because two of
// the three answers are fixed by changing a tick. Refusing a pack that
// would have worked costs someone a choice they could make differently;
// letting a tab die costs them the work with no error to explain it.
export const PACK_FLOOR_MB = 96;          // every machine measured finished this
export const PACK_PAGE_HEAP_MB = 64;      // what the page itself may hold for free

export function packBudget(env) {
  const e = env || {};
  const dm = typeof e.deviceMemory === 'number' && isFinite(e.deviceMemory) ? e.deviceMemory : 0;
  const out = { mb: PACK_FLOOR_MB, stream: !!e.savePicker, why: '', deviceMemory: dm };
  if (out.stream) {
    out.mb = e.macZip ? PACK_MAC_MAX_MB : PACK_MAX_MB;
    out.why = 'this browser can write the installer to a file as it is made, so its size is limited by the installer format, not by memory';
    return capped(out, e);
  }
  if (dm === 0) out.why = 'this browser does not say how much memory this computer has, so the limit is the one every machine we measured managed';
  else if (dm >= 8) { out.mb = 512; out.why = 'this computer reports 8 GB or more'; }
  else if (dm >= 4) { out.mb = 256; out.why = 'this computer reports ' + dm + ' GB'; }
  else { out.mb = 64; out.why = 'this computer reports only ' + dm + ' GB'; }
  // A macOS pack is built as a zip, entry by entry, by a compressor that
  // holds each one; that path has never been measured against a browser,
  // so it gets half the budget and its own ceiling.
  if (e.macZip) out.mb = Math.min(Math.round(out.mb / 2), PACK_MAC_MAX_MB);
  const held = typeof e.usedHeapMb === 'number' && isFinite(e.usedHeapMb) ? e.usedHeapMb : 0;
  if (held > PACK_PAGE_HEAP_MB) out.mb -= Math.round(held - PACK_PAGE_HEAP_MB);
  if (out.mb < 0) out.mb = 0;
  return capped(out, e);
}

// A ceiling somebody set by hand. It can only lower the budget -- a page
// told to be more careful is safe, a page told to be braver is the tab
// that dies -- and it is how a test reaches the refusal without a machine
// that really is that small.
function capped(out, e) {
  if (typeof e.limitMb === 'number' && isFinite(e.limitMb) && e.limitMb >= 0 && e.limitMb < out.mb) {
    out.mb = Math.round(e.limitMb);
    out.why = 'this page has been set to pack at most ' + out.mb + ' MB (TI_PACK_MB)';
  }
  return out;
}

// What a browser can read off itself. Kept here so the page and the tests
// ask the same question; `g` is a window (or a stand-in for one in a test).
export function packEnv(g, opts) {
  const o = opts || {};
  const nav = (g && g.navigator) || {};
  const perf = (g && g.performance) || {};
  const mem = perf.memory;
  return {
    deviceMemory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : 0,
    savePicker: !!(g && typeof g.showSaveFilePicker === 'function') && !o.noPicker,
    usedHeapMb: mem && typeof mem.usedJSHeapSize === 'number' ? Math.round(mem.usedJSHeapSize / 1048576) : 0,
    macZip: !!o.macZip,
    limitMb: g && typeof g.TI_PACK_MB === 'number' ? g.TI_PACK_MB : undefined,
  };
}

export const offlineField = (id, arch) => 'offline_' + id + '_' + arch;

// new.html carries this hidden field beside the picker. A form post only
// sends the boxes that are ticked, so without it "the form has no picker"
// and "the picker is there and nothing is ticked" look the same, and the
// two need opposite answers: the defaults, or an error.
export const OFFLINE_PICKER_FIELD = 'offline_targets_form';

const hasField = (f, name) => !!(f.has && f.has(name));

// Whether this form has a packed-target picker at all. /classic's lean form
// (src/build_server/lib/pages.js) has the offline tick and nothing else.
export function hasOfflinePicker(f) {
  if (hasField(f, OFFLINE_PICKER_FIELD)) return true;
  return OFFLINE_TARGETS.some((t) => hasField(f, 'offline_' + t.id) ||
    t.arches.some((a) => hasField(f, offlineField(t.id, a.arch))));
}

// The packed targets a form asks for: `<id>_<arch>` strings, in table order.
// Three shapes are read, because three exist:
//   - new.html today: a box per system and architecture;
//   - a form written before architectures were a choice (a cached page, a
//     hand-written post): a bare `offline_<id>` box, meaning that system
//     with the architectures it started with;
//   - a form with no picker at all (/classic): the defaults, so ticking
//     "make offline installers" there still means something.
export function offlineTargets(f) {
  const picker = hasOfflinePicker(f);
  const out = [];
  for (const t of OFFLINE_TARGETS) {
    const perArch = t.arches.some((a) => hasField(f, offlineField(t.id, a.arch)));
    for (const a of t.arches) {
      if (!picker) { if (a.on) out.push(t.id + '_' + a.arch); }
      else if (perArch) { if (f.checked(offlineField(t.id, a.arch))) out.push(t.id + '_' + a.arch); }
      else if (a.on && f.checked('offline_' + t.id)) out.push(t.id + '_' + a.arch);
    }
  }
  return out;
}

// Which OS versions each ticked target means, as the integers a plan's
// `when <family> <min> <max> <arch>` line uses (src/shared/resolve.js
// loadOSScale: Windows NT major.minor, so XP is 501, Vista 600, 7 is 601,
// 8 is 602, 8.1 is 603 and both 10 and 11 are 1000). A pack built in the
// browser carries the files of the plan blocks that cover these, and no
// others, so "Must work offline on Windows XP" packs the build that runs
// there rather than every Windows build in the plan.
//
// `null` means the whole family: Linux and macOS are ticked by
// architecture alone, with no OS-version choice in the picker.
//
// This is the one place the form's names for systems meet the plan's
// numbers for them. tests/offline-test.mjs checks that every target here
// selects at least one block of a real plan, because a mapping that
// silently matches nothing would pack an empty offline installer and look
// exactly like one that worked.
export const OFFLINE_TARGET_OS = {
  win_1011: [1000], win_78: [601, 602, 603], win_vista: [600], win_xp: [501],
  linux: null, mac: null,
};

// What those targets add, in MB (the same estimate the form shows).
export function offlineSizeMb(targets, platforms) {
  let mb = 0;
  for (const t of OFFLINE_TARGETS) {
    if (platforms && platforms.indexOf(t.platform) < 0) continue;
    for (const a of t.arches) if (targets.indexOf(t.id + '_' + a.arch) >= 0) mb += a.mb;
  }
  return mb;
}

const buildField = (runtime) => (runtime === 'cc' ? 'cc_build' : 'build_' + runtime);

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// A reader over a plain form post's fields (the server's side): `fields`
// maps each name to its values in the order sent. Browsers send a textarea's
// line breaks as CRLF, which a page's JavaScript reads as LF: LF here too.
export function postedForm(fields) {
  const first = (name) => (own(fields, name) && fields[name].length ? String(fields[name][0]) : '');
  const val = (name) => first(name).replace(/\r\n?/g, '\n');
  return {
    val,
    checked: (name) => own(fields, name) && fields[name].length > 0,
    has: (name) => own(fields, name),
    buildEdited: (runtime) => own(fields, buildField(runtime)) &&
      val(buildField(runtime)).trim() !== (own(BUILD_DEFAULTS, runtime) ? BUILD_DEFAULTS[runtime] : ''),
    // Edited: the language's field differs from new.html's default, or
    // /classic's single launch field was filled in.
    launchEdited: (runtime) => {
      if (own(fields, 'entry_' + runtime)) return val('entry_' + runtime) !== (own(ENTRY_DEFAULTS, runtime) ? ENTRY_DEFAULTS[runtime] : '');
      return val('launch').trim() !== '';
    },
  };
}

// A GitHub URL or owner/repo is a repo; another URL is a download; anything
// else is a package name.
export function parseSource(text, refType, ref) {
  const v = text.trim();
  // Anchored at both ends. Unanchored, https://github.com/psf/requests/
  // tree/v2.31.0 matched the owner and repo and the rest of the path --
  // the tag the publisher typed -- was silently dropped, so a pinned
  // URL built whatever HEAD happened to be. A URL carrying a ref is
  // refused with the fields that do pin it named, rather than quietly
  // meaning something else.
  const gh = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(v);
  const ghDeep = !gh && /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/\S+/i.test(v);
  if (ghDeep) {
    throw new Error('That GitHub URL points at something inside the repository. Give the repository itself '
      + '(github.com/owner/repo) and choose the tag, branch or commit under "Which version", so the pin is recorded.');
  }
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

// The files of a template, from the form: {file name: text}, or null when
// this language has no such template. A file the form doesn't have (a plain
// post from a page without the editor) is the template's own text.
export function templateFiles(f, runtime, template) {
  const fields = templateFields(runtime, template);
  if (!fields) return null;
  const t = templateFor(runtime, template);
  const files = {};
  for (const name of Object.keys(fields)) {
    const file = fields[name];
    files[file] = !f.has || f.has(name) ? f.val(name) : t.files[file];
  }
  return files;
}

function radio(f, name, fallback) {
  return f.val(name) || fallback;
}

// The Customise sections the server may act on (docs/api.md optional fields).
function optionFields(f, runtime, mode) {
  const fields = {
    cleanup: {
      tools: radio(f, 'cleanup_tools', 'remove'),
      source: f.checked('cleanup_source'),
      pkg_cache: f.checked('cleanup_pkg_cache'),
      docs: f.checked('cleanup_docs'),
      fail: radio(f, 'cleanup_fail', 'remove'),
    },
    uninstall: {
      register: f.checked('uninstaller'),
      data: radio(f, 'uninstall_data', 'ask'),
      before_windows: f.val('win_unpre_script').trim(),
      before_unix: f.val('unix_unpre_script').trim(),
    },
  };
  // Tools the project needs on top of the runtime (design.md 11.0 items 13
  // and 27; docs/api.md "tools"). Each is only read for the language it
  // belongs to, so a box left ticked while the language changes does nothing.
  if (runtime === 'cc') fields.tools = { cc_win: radio(f, 'cc_win', 'auto') };
  if (runtime === 'go' && f.checked('go_cgo')) fields.tools = { cgo: true };
  if (runtime === 'ruby' && f.checked('ruby_devkit')) fields.tools = { ruby_devkit: true };
  if (mode === 'B') fields.sign = { win_method: radio(f, 'win_sign', 'service') };
  return fields;
}

// Packed and offline files. Uploaded local files are NOT sent: for modes B/C
// they are added to the built file in the browser afterwards (packed-files.md).
function packField(f, mode, platforms, problems, localMb) {
  if (mode === 'A') return null;   // mode A never carries packed content
  const pack = {};
  if (f.checked('offline')) {
    // Each entry is `<system>_<arch>` (form-job.js OFFLINE_TARGETS), so the
    // request says 32-bit and 64-bit apart rather than naming a system and
    // leaving the architecture to be guessed.
    pack.offline_targets = offlineTargets(f);
    pack.shape = radio(f, 'offline_shape', 'single');
    const wanted = pack.offline_targets.filter((t) => {
      const sys = OFFLINE_TARGETS.find((x) => t.indexOf(x.id + '_') === 0);
      return sys && platforms.indexOf(sys.platform) >= 0;
    });
    if (!wanted.length) {
      // With no platform ticked at all the form already says so; don't say
      // it twice. A form with no picker took the defaults and can't be at
      // fault either, so only a picker left empty is an error.
      if (platforms.length && hasOfflinePicker(f)) {
        problems.push('Tick at least one system and architecture under "Must work offline on", or turn off "Also make offline installers".');
      }
    } else {
      const mb = offlineSizeMb(pack.offline_targets, platforms) + localMb;
      if (mb >= PACK_MAX_MB && pack.shape !== 'zip') {
        problems.push('Those offline targets come to about ' + mb + ' MB, past the ' + PACK_MAX_MB +
          ' MB an installer can hold in one file. Untick some architectures, or choose the zip under "Shape".');
      }
    }
  }
  // One URL-sourced file from the "+ Add a file" form, if given. Uploads stay
  // in the browser and are added after the build, so they aren't sent.
  const url = f.val('pf_url').trim();
  if (url) {
    pack.files = [{
      source: 'url', url,
      action: radio(f, 'pf_action', 'copy'),
      dest: f.val('pf_dest').trim(),
      args: f.val('pf_args').trim(),
      platforms: ['windows', 'linux', 'macos'].filter((p) => f.checked('pf_' + p)),
      packed: radio(f, 'pf_how', 'packed') === 'packed',
    }];
  }
  return Object.keys(pack).length ? pack : null;
}

// The request, and what's wrong with the form (sentences to show; `problems`
// may already hold some, such as an icon that is too big).
//   f       the form reader (above)
//   icon    {choice, data?, filename?, type?}
//   local   the archive picked for "From my computer": {name, base64}, or null
export function jobFromForm(f, { icon, local = null, problems = [] }) {
  const runtime = f.val('runtime');
  const kind = f.val('source_kind');
  const write = kind === 'write';
  const rv = f.val('rv_mode');
  const mode = MODES[f.val('mode')] || 'A';
  const platforms = ['windows', 'linux', 'macos'].filter((p) => f.checked('target_' + p));

  const job = {
    name: f.val('app_name').trim(),
    runtime,
    select: rv,
    range: rv === 'range' ? f.val('runtime_version').trim() : rv === 'exact' ? f.val('runtime_exact').trim() : '',
    // The page has one launch field per language; /classic has one for all.
    launch: (f.val('entry_' + runtime) || f.val('launch')).trim(),
    install: f.val('install_cmd').trim(),
    console: true,
    menu: f.checked('shortcut_menu'),
    desktop: f.checked('shortcut_desktop'),
    root: f.val('root') || 'user',
    rootname: f.val('rootname').trim() || 'ti',
    platforms,
    mode,
    offline: mode !== 'A' && f.checked('offline'),
  };
  // Compiled languages: the build command is how the project gets installed.
  if (!job.install && COMPILED.indexOf(runtime) >= 0) job.install = f.val(buildField(runtime)).trim();

  // Optional Customise fields the server may act on (docs/api.md).
  Object.assign(job, optionFields(f, runtime, mode));
  job.icon = icon;
  // An uploaded source is packed too, so it counts towards the one-file
  // limit alongside the runtimes. `size` when the caller knows it (the page
  // has the File); otherwise from the base64 it sent.
  const localMb = local ? Math.round((local.size != null ? local.size : local.base64.length * 3 / 4) / 1048576) : 0;
  const pack = packField(f, mode, platforms, problems, localMb);
  if (pack) job.pack = pack;

  if (!platforms.length) problems.push('Pick at least one platform under "Build for".');
  if (write) {
    const template = f.val('template');
    const t = templateFor(runtime, template);
    const files = templateFiles(f, runtime, template);
    if (!files) problems.push('This template isn\'t available for this language yet. Pick another template.');
    job.source = { kind: 'inline', value: '' };
    job.files = files || {};
    job.console = t ? t.console !== false : true;
    if (t) {
      // The template's own launch and build commands, unless the form's
      // were edited (a build command typed in Customise, or the install field).
      if (!f.launchEdited(runtime)) job.launch = templateLaunch(runtime, template);
      if (!f.val('install_cmd').trim()) {
        const edited = COMPILED.indexOf(runtime) >= 0 && f.buildEdited && f.buildEdited(runtime);
        job.install = edited ? f.val(buildField(runtime)).trim() : (t.install || '');
      }
      // The runtime versions the code needs, when the form leaves it to us.
      if (t.versions && (rv === 'newest' || rv === '')) {
        job.select = 'range';
        job.range = t.versions;
      }
      if (t.prerequisites && t.prerequisites.length) job.prerequisites = t.prerequisites.slice();
      const p = platformProblem(runtime, template, platforms);
      if (p) problems.push(p);
    }
  } else if (kind === 'local') {
    if (!local) problems.push('Pick an archive or a folder from your computer.');
    else {
      job.source = { kind: 'upload', value: local.name };
      job.archive = local.base64;
    }
    if (mode === 'A') problems.push('Installers we sign need the source on the server: their settings are published by us and fetched by name, never carried in the file. For files from your computer, choose "Signed by you" or "Unsigned" under Customise → Signing.');
  } else {
    const src = f.val('source');
    if (!src.trim()) problems.push('Say what to package: a GitHub repo URL or a package name.');
    job.source = parseSource(src, f.val('ref_type'), f.val('ref'));
  }
  if (rv === 'range' && !job.range) problems.push('Enter the versions allowed, or pick another "Which version" option.');
  if (rv === 'exact' && !job.range) problems.push('Enter the exact version, or pick another "Which version" option.');
  return { job, problems };
}
