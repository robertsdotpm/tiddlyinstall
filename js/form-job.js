// The New installer form's fields -> a POST /api/jobs request (docs/api.md).
// One mapping for both ways the form reaches the build server:
//
//   - js/new.js, in the page: reads the form's elements and posts JSON;
//   - backend/server.js, for a plain form post (POST /submit, from browsers
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
//                  own text (js/templates.js)
//
// and the icon ({choice, data?, filename?, type?}) and, for "From my
// computer", the picked archive ({name, base64}) or null: those are read
// differently in a page (File objects) and on the server (a multipart part).
// No DOM here: the server runs it too. Plain ES2017 (the one-file page's
// floor): no `?.` or `??`.

import { TEMPLATES, templateFor, templateFields, templateLaunch, platformProblem } from './templates.js';

export const MODES = { ours: 'A', yours: 'B', unsigned: 'C' };
export const COMPILED = ['cc', 'go', 'rust', 'zig', 'nim'];

// The code templates of "I'll write it here" are js/templates.js's. This is
// runtime -> template -> the form's <textarea> name -> the file it becomes;
// new.html's editors are rendered from the same data (js/new.js).
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
  if (runtime === 'cc') fields.tools = { cc_win: radio(f, 'cc_win', 'auto') };
  if (mode === 'B') fields.sign = { win_method: radio(f, 'win_sign', 'service') };
  return fields;
}

// Packed and offline files. Uploaded local files are NOT sent: for modes B/C
// they are added to the built file in the browser afterwards (packed-files.md).
function packField(f, mode) {
  if (mode === 'A') return null;   // mode A never carries packed content
  const pack = {};
  if (f.checked('offline')) {
    pack.offline_include = radio(f, 'offline_include', 'all');
    pack.offline_targets = ['win_1011', 'win_78', 'win_vista', 'win_xp', 'linux', 'mac']
      .filter((t) => f.checked('offline_' + t));
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
    rootname: f.val('rootname').trim() || 'ib',
    platforms,
    mode,
    offline: mode !== 'A' && f.checked('offline'),
  };
  // Compiled languages: the build command is how the project gets installed.
  if (!job.install && COMPILED.indexOf(runtime) >= 0) job.install = f.val(buildField(runtime)).trim();

  // Optional Customise fields the server may act on (docs/api.md).
  Object.assign(job, optionFields(f, runtime, mode));
  job.icon = icon;
  const pack = packField(f, mode);
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
      const p = platformProblem(runtime, template, platforms);
      if (p) problems.push(p);
    }
  } else if (kind === 'local') {
    if (!local) problems.push('Pick an archive or a folder from your computer.');
    else {
      job.source = { kind: 'upload', value: local.name };
      job.archive = local.base64;
    }
    if (mode === 'A') problems.push('Installers signed by TiddlyInstall need the source on the build server. For files from your computer, choose "Signed by you" or "Unsigned" under Customise → Signing.');
  } else {
    const src = f.val('source');
    if (!src.trim()) problems.push('Say what to package: a GitHub repo URL or a package name.');
    job.source = parseSource(src, f.val('ref_type'), f.val('ref'));
    const sub = f.val('subdir').trim();
    if (sub) job.source.subdir = sub;
  }
  if (rv === 'range' && !job.range) problems.push('Enter the versions allowed, or pick another "Which version" option.');
  if (rv === 'exact' && !job.range) problems.push('Enter the exact version, or pick another "Which version" option.');
  return { job, problems };
}
