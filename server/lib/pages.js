// Server-rendered pages for browsers that can't run TiddlyInstall's page
// (Internet Explorer 6-10, Safari 5, Chrome 49 without the ES5 copy, and any
// browser with JavaScript off): the classic form (GET /classic), what a form
// post answers when it is refused (POST /submit), and a build's status
// (GET /status/<id>). docs/api.md "Plain form posts", plan.md 1.11 "Older
// browsers".
//
// No JavaScript at all, and nothing an old browser needs is new: HTML 4.01
// markup (no HTML5 elements), plain CSS (no custom properties, :has(),
// flexbox or grid), and <meta http-equiv="refresh"> while a build is under
// way. Served as text/html; charset=utf-8.
//
// Everything that came from a person (the app name, its error messages,
// file names) is untrusted: it goes through esc() and nothing else. Links
// are relative, so the pages work behind a proxy under a sub-path too.
import { mirrorGapBuildWarning } from '../../shared/mirror-words.js';

export function esc(s) {
  return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Only scripts are what an escaping slip could turn user text into; these
// pages have none, so browsers that know CSP refuse them all.
export const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const CSS = `body{margin:0;padding:0;background:#ffffff;color:#1b1b1b;font-family:Verdana,Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45}
#top{background:#16324f;color:#ffffff;padding:10px 16px}
#top a{color:#ffffff;font-weight:bold;text-decoration:none}
#page{padding:8px 16px 24px;max-width:860px}
h1{font-size:22px;margin:12px 0 8px}
h2{font-size:17px;margin:18px 0 6px}
a{color:#0b4bb3}
fieldset{border:1px solid #c8ccd2;margin:0 0 14px;padding:8px 12px 10px}
legend{font-weight:bold;padding:0 4px;color:#16324f}
label{font-weight:bold}
.opt label,label.opt{font-weight:normal}
.hint{color:#555555;font-size:12px}
.field{margin:6px 0 10px}
input.text{width:95%;max-width:520px}
table.facts th{text-align:left;padding:3px 14px 3px 0;vertical-align:top;color:#444444}
table.facts td{padding:3px 0}
table.files{border-collapse:collapse;margin:6px 0}
table.files th,table.files td{border:1px solid #c8ccd2;padding:4px 8px;text-align:left;vertical-align:top}
table.files th{background:#eef1f5}
.sha{font-family:"Courier New",Courier,monospace;font-size:11px}
.box{border:1px solid #c8ccd2;background:#f6f8fa;padding:8px 12px;margin:10px 0}
.error{border:2px solid #b3261e;background:#fdecea;color:#410e0b;padding:8px 12px;margin:10px 0}
.ok{color:#1b5e20;font-weight:bold}
.bad{color:#b3261e;font-weight:bold}
.foot{margin-top:24px;color:#555555;font-size:12px}`;

// A whole page. `refresh`: seconds, or 0 for none. `home`: the relative
// path to the site's root ('' at /submit and /classic, '../' at /status/x).
export function page({ title, body, refresh = 0, home = '' }) {
  return '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n' +
    '<html lang="en">\n<head>\n' +
    '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">\n' +
    (refresh ? '<meta http-equiv="refresh" content="' + Number(refresh) + '">\n' : '') +
    '<title>' + esc(title) + ' - TiddlyInstall</title>\n' +
    '<style type="text/css">\n' + CSS + '\n</style>\n</head>\n<body>\n' +
    '<div id="top"><a href="' + home + 'classic">TiddlyInstall</a> &nbsp; simple pages, for browsers that can\'t run the builder page</div>\n' +
    '<div id="page">\n' + body +
    '<p class="foot">TiddlyInstall: <a href="' + (home || './') + '">the builder page</a> (current browsers) &middot; <a href="' + home + 'classic">new installer</a>.</p>\n' +
    '</div>\n</body>\n</html>\n';
}

/* ---------- GET /classic: the form ---------- */

function radio(name, value, label, checked, hint, off) {
  const id = 'f-' + name + '-' + value;
  return '<div class="opt"><input type="radio" name="' + name + '" value="' + esc(value) + '" id="' + id + '"' +
    (checked ? ' checked' : '') + (off ? ' disabled' : '') + '> ' +
    '<label for="' + id + '">' + label + '</label>' + (hint ? '<br><span class="hint">' + hint + '</span>' : '') + '</div>\n';
}

function box(name, label, checked, hint) {
  const id = 'f-' + name;
  return '<div class="opt"><input type="checkbox" name="' + name + '" id="' + id + '"' + (checked ? ' checked' : '') + '> ' +
    '<label for="' + id + '">' + label + '</label>' + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</div>\n';
}

function text(name, label, hint, attrs = '') {
  const id = 'f-' + name;
  return '<div class="field"><label for="' + id + '">' + label + '</label><br>' +
    '<input type="text" class="text" name="' + name + '" id="' + id + '"' + attrs + '>' + (hint ? '<br><span class="hint">' + hint + '</span>' : '') + '</div>\n';
}

// runtimes: [{id, label, launch}] from the catalogue summary.
export function classicPage(runtimes) {
  const opts = runtimes.map((r) => '<option value="' + esc(r.id) + '"' + (r.id === 'python' ? ' selected' : '') + '>' + esc(r.label || r.id) + '</option>').join('');
  const launches = runtimes.filter((r) => r.launch).map((r) => esc(r.label || r.id) + ': <code>' + esc(r.launch) + '</code>').join('; ');
  const body = '<h1>New installer</h1>\n' +
    '<p>This is the build server\'s simple form. It works in any browser, with or without JavaScript: the server builds the installers and ' +
    'gives you a page with the links. The <a href="./">builder page</a> does more (editing, signing, files from your computer) in a current browser.</p>\n' +
    // The field names are new.html's: the server reads both with shared/form-job.js.
    '<form action="submit" method="post" enctype="multipart/form-data" accept-charset="utf-8">\n' +
    '<fieldset><legend>What to package</legend>\n<input type="hidden" name="source_kind" value="repo">\n' +
    text('app_name', 'Name', 'Shown by the installer and on the app\'s launcher. Leave blank to use the project\'s name.', ' maxlength="64"') +
    text('source', 'Source', 'A GitHub repo (<code>owner/repo</code> or its github.com address), a package name (PyPI, npm, RubyGems, crates.io, Go modules, NuGet .NET tools), ' +
      'or the address of a .zip or .tar.gz.') +
    '<div class="field"><label for="f-runtime">Language</label><br><select name="runtime" id="f-runtime">' + opts + '</select></div>\n' +
    '<div class="field"><label for="f-ref_type">Version of the source</label><br><select name="ref_type" id="f-ref_type">' +
    '<option value="latest" selected>Latest release (or the newest package)</option><option value="tag">A tag, or a package version</option>' +
    '<option value="branch">A branch</option><option value="commit">A commit</option></select> ' +
    '<input type="text" name="ref" id="f-ref" size="20" title="Tag, branch, commit or package version"><br>' +
    '<span class="hint">For a tag, branch, commit or package version, type it in the box.</span></div>\n' +
    '</fieldset>\n' +
    '<fieldset><legend>Build for</legend>\n' +
    box('target_windows', 'Windows', true) + box('target_linux', 'Linux', true) + box('target_macos', 'macOS', true) +
    '</fieldset>\n' +
    '<fieldset><legend>Signing</legend>\n' +
    '<p class="hint">A signature here goes on the installer program &mdash; the one we wrote, the same in every installer built here &mdash; ' +
    'and never on the software it installs. It says that program is what it claims to be and unaltered; it says nothing about your app.</p>\n' +
    radio('mode', 'ours', 'Signed by TiddlyInstall (not yet)', false,
      'Not available in this prototype: it needs a code-signing certificate, which we don\'t have yet.', true) +
    radio('mode', 'yours', 'Signed by you', false, 'Unsigned files for you to sign with your own certificate (signtool, osslsigncode or a current browser\'s Edit page).') +
    radio('mode', 'unsigned', 'Unsigned', true, 'For testing, or where signatures don\'t matter.') +
    box('offline', 'Pack the downloads into the installer (works offline)', false, '"Signed by you" and "Unsigned" only; larger files, and slower to build.') +
    '</fieldset>\n' +
    '<fieldset><legend>Options</legend>\n' +
    '<div class="field"><label>Which version of the language</label>\n' +
    radio('rv_mode', 'newest', 'The newest that runs on each computer', true) +
    radio('rv_mode', 'range', 'A range:', false) +
    '<div class="opt"><input type="text" name="runtime_version" id="f-runtime_version" size="24" title="Versions allowed, e.g. >=3.8, <3.13"> <span class="hint">e.g. <code>&gt;=3.8, &lt;3.13</code></span></div>\n' +
    radio('rv_mode', 'exact', 'Exactly:', false) +
    '<div class="opt"><input type="text" name="runtime_exact" id="f-runtime_exact" size="24" title="The exact version, e.g. 3.12.4"> <span class="hint">e.g. <code>3.12.4</code></span></div></div>\n' +
    text('install_cmd', 'Install command', 'Leave blank to choose from the project\'s files (or the package\'s defaults).') +
    text('launch', 'Launch command', 'Leave blank for the language\'s default: ' + launches + '.') +
    box('go_cgo', 'Go: this project uses cgo', false, 'Only read for Go. Adds a C compiler (Windows: MinGW-w64 GCC, about 110 MB more).') +
    box('ruby_devkit', 'Ruby: install the DevKit', false, 'Only read for Ruby. MSYS2\'s toolchain, for gems with native code: about 50 MB more, Windows 8.1 and later.') +
    box('shortcut_menu', 'Start menu / app launcher entries', true) +
    box('shortcut_desktop', 'Desktop shortcut', false) +
    '<div class="field"><label>Install for</label>\n' +
    radio('root', 'user', 'This user (no administrator rights needed)', true) +
    radio('root', 'system', 'Everyone on the computer', false) + '</div>\n' +
    '<div class="field"><label for="f-icon">Icon</label><br><input type="file" name="icon" id="f-icon" accept=".png"><br>' +
    '<span class="hint">Optional: a square PNG, 16 to 1024 pixels across, at most 1 MB.</span></div>\n' +
    '</fieldset>\n' +
    '<p><input type="submit" value="Build installers"></p>\n' +
    '</form>\n';
  return page({ title: 'New installer', body });
}

/* ---------- POST /submit refused ---------- */

export function refusedPage(messages, { home = '' } = {}) {
  const list = messages.map((m) => '<li>' + esc(m) + '</li>').join('\n');
  const body = '<h1>Couldn\'t build this</h1>\n<div class="error"><ul>\n' + list + '\n</ul></div>\n' +
    '<p>Use your browser\'s Back button to change the form (it keeps what you typed), or <a href="' + home + 'classic">start again</a>.</p>\n';
  return page({ title: 'Couldn\'t build this', body, home });
}

/* ---------- GET /status/<id> ---------- */

const STATUS = { queued: 'Waiting in the queue', running: 'Building', done: 'Done', failed: 'Failed' };
const CLASS = { record: 'settings records (for the installer program we sign)', build: 'builds', pack: 'offline builds' };
const PLATFORM = { windows: 'Windows', linux: 'Linux', macos: 'macOS' };

function size(n) {
  if (typeof n !== 'number') return '';
  if (n < 1024) return n + ' bytes';
  if (n < 1024 * 1024) return Math.ceil(n / 1024) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function eta(s) {
  if (typeof s !== 'number') return 'Not known yet (it is worked out from recent builds)';
  if (s < 60) return 'About ' + Math.max(1, Math.round(s)) + ' seconds';
  return 'About ' + Math.round(s / 60) + ' minute' + (Math.round(s / 60) === 1 ? '' : 's');
}

// A /dl/ link from a job's file url, relative to /status/<id>; null if it
// isn't one of ours (then no link is made).
function dlHref(url) {
  const m = /^\/dl\/([a-z0-9]+)\/([^/]+)$/.exec(String(url || ''));
  return m ? '../dl/' + m[1] + '/' + encodeURIComponent(m[2]) : null;
}

// view: the job's JSON (Server.jobView); request: what was asked for, or null.
export function statusPage(view, request, { refresh = 3 } = {}) {
  const st = view.status;
  const busy = st === 'queued' || st === 'running';
  const name = request && request.name ? request.name : '';
  const mode = request ? request.mode : '';
  const rows = [
    ['Status', '<span class="' + (st === 'done' ? 'ok' : st === 'failed' ? 'bad' : '') + '">' + esc(STATUS[st] || st) + '</span>'],
    ['Ticket', esc(view.ticket)],
  ];
  if (busy) {
    rows.push(['Queue', st === 'running' ? 'Running now' : view.position === 0 ? 'Next' : esc(view.position) + ' ahead of you, in the queue for ' + esc(CLASS[view.class] || view.class)]);
    rows.push(['Estimated wait', esc(eta(view.eta_seconds))]);
  }
  if (view.progress) rows.push(['Progress', esc(view.progress)]);
  let body = '<h1>' + (name ? esc(name) : 'Build') + '</h1>\n' +
    '<table class="facts">\n' + rows.map(([k, v]) => '<tr><th>' + k + '</th><td>' + v + '</td></tr>').join('\n') + '\n</table>\n';
  if (busy) {
    body += '<p class="hint">This page reloads every ' + refresh + ' seconds until the build is done. You can close it and come back: ' +
      'its address keeps your place for a week. <a href="' + esc(encodeURIComponent(view.id)) + '">Reload now</a>.</p>\n';
  }
  if (st === 'failed') {
    body += '<div class="error">The build failed: ' + esc(view.error || 'no reason given') + '</div>\n';
  }
  if (st === 'done' && view.result) {
    const r = view.result;
    const files = Array.isArray(r.files) ? r.files : [];
    body += '<h2>Downloads</h2>\n<table class="files">\n<tr><th>File</th><th>For</th><th>Size</th><th>Signed by</th><th>SHA-256</th></tr>\n' +
      files.map((f) => {
        const href = dlHref(f.url);
        const link = href ? '<a href="' + esc(href) + '">' + esc(f.name) + '</a>' : esc(f.name);
        return '<tr><td>' + link + '</td><td>' + esc(PLATFORM[f.platform] || f.platform) + '</td><td>' + esc(size(f.size)) + '</td><td>' +
          esc(f.signed || 'Not signed') + '</td><td class="sha">' + esc(f.sha256) + '</td></tr>';
      }).join('\n') + '\n</table>\n';
    // Downloads our mirror has no copy of (design.md 1.3), in the same
    // words the page and the installer's review screen use. This page is
    // for browsers too old to run the other one, so its reader is the most
    // likely of all to be sending installers to machines that cannot reach
    // a vendor over modern HTTPS.
    const um = Array.isArray(r.unmirrored) ? r.unmirrored : [];
    if (um.length) body += '<div class="error">' + esc(mirrorGapBuildWarning(um.map((f) => f.name))) + '</div>\n';
    if (r.record && /^[a-z0-9]+$/.test(r.record)) {
      body += '<p>Record <a href="../api/records/' + r.record + '"><code>' + r.record + '</code></a>: what the installers install, as the server stored it. ' +
        'Its current install plan, signed by the server: <a href="../api/plan/' + r.record + '">plan</a>.</p>\n';
    }
    body += '<div class="box">Each installer shows what it will install, where from, and who signed the installer file, before it changes anything. ' +
      'Install plans are checked against the server\'s signature and every download against its SHA-256, so these files don\'t depend on the ' +
      'connection they came over.' + (mode === 'B' ? ' <strong>Signed by you:</strong> sign these files with your own certificate before you publish them.' : '') + '</div>\n';
  }
  body += '<p><a href="../classic">Make another installer</a></p>\n';
  return page({ title: (name ? name + ': ' : 'Build: ') + (STATUS[st] || st), body, refresh: busy ? refresh : 0, home: '../' });
}

export function missingJobPage() {
  const body = '<h1>No such build</h1>\n<p>Builds are kept for a week. <a href="../classic">Make a new installer</a>.</p>\n';
  return page({ title: 'No such build', body, home: '../' });
}
