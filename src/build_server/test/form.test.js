// Plain form posts and the pages for browsers that can't run the page
// (docs/api.md "Plain form posts"): the body parsers, src/shared/form-job.js against
// new.html, the pages' escaping and markup, and the server end to end
// (POST /submit, GET /status/<id>, GET /classic). The server part needs
// Redis like server.test.js, on a database of its own claimed with
// helpers.js claimRedisDb (a fixed number could not keep two concurrent
// runs apart); TI_TEST_FORM_REDIS_DB pins one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import IORedis from 'ioredis';
import { Server, parseFlags } from '../server.js';
import { Limiter } from '../lib/limiter.js';
import { parseForm, parseUrlencoded, parseMultipart, boundaryOf, BadForm } from '../lib/form.js';
import { esc, statusPage, classicPage, refusedPage, page } from '../lib/pages.js';
import { jobFromForm, postedForm, TEMPLATE_FILES, ENTRY_DEFAULTS, BUILD_DEFAULTS, parseSource,
  OFFLINE_TARGETS, OFFLINE_PICKER_FIELD, offlineField, offlineSizeMb, PACK_MAX_MB, PACK_WARN_MB } from '../../shared/form-job.js';
import { TEMPLATES, templateLaunch } from '../../shared/templates.js';
import { readInstaller, recordHash } from '../../shared/tifile.js';
import { haveCatalog, haveBases, tmpDir, claimRedisDb, REPO } from './helpers.js';

const REDIS = process.env.TI_TEST_REDIS || '127.0.0.1:6390';
const PINNED = process.env.TI_TEST_FORM_REDIS_DB;
const NEW_HTML = fs.readFileSync(path.join(REPO, 'src', 'web_client', 'new.html'), 'utf8');
const HOSTILE = '<script>alert(1)</script>"\'><img src=x onerror=alert(2)>&amp;';
const BAD_FILE = '<img src=x onerror=alert(2)>"\'&.exe';

/* ---------- a multipart body, as a browser writes one ---------- */

function multipart(parts, boundary = '---------------------------7d93b2a1f0e4c') {
  const chunks = [];
  for (const p of parts) {
    let h = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + p.name + '"';
    if (p.filename !== undefined) h += '; filename="' + p.filename + '"\r\nContent-Type: ' + (p.type || 'application/octet-stream');
    chunks.push(Buffer.from(h + '\r\n\r\n'), Buffer.isBuffer(p.value) ? p.value : Buffer.from(String(p.value)), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from('--' + boundary + '--\r\n'));
  return { body: Buffer.concat(chunks), type: 'multipart/form-data; boundary=' + boundary };
}

// A w x w RGBA PNG, one colour.
function png(w) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(w, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) raw.set([200, 60, 20, 255], y * (w * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- the parsers ---------- */

test('urlencoded bodies', () => {
  const { fields } = parseUrlencoded(Buffer.from('a=1&b=x+y%20z&a=2&c=%E2%9C%93&empty=&odd=%zz'));
  assert.deepEqual(fields.a, ['1', '2']);
  assert.deepEqual(fields.b, ['x y z']);
  assert.deepEqual(fields.c, ['\u2713']);
  assert.deepEqual(fields.empty, ['']);
  assert.deepEqual(fields.odd, ['%zz']);
  assert.equal(Object.getPrototypeOf(parseUrlencoded(Buffer.from('__proto__=1')).fields), null);
  assert.throws(() => parseUrlencoded(Buffer.from(Array.from({ length: 2001 }, (_, i) => 'k' + i + '=1').join('&'))), BadForm);
});

test('multipart bodies', () => {
  const icon = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
  const m = multipart([
    { name: 'app_name', value: 'Caf\u00e9 \u2713' },
    { name: 'code', value: 'a\r\nb\r\n' },
    { name: 'icon', filename: 'C:\\Documents and Settings\\me\\My Documents\\logo.png', type: 'image/png', value: icon },
    { name: 'win_cert', filename: 'secret.pfx', value: 'KEY' },
    { name: 'empty', filename: '', value: '' },
  ]);
  const { fields, files } = parseForm(m.type, m.body, { keepFiles: ['icon', 'empty'] });
  assert.deepEqual(fields.app_name, ['Caf\u00e9 \u2713']);
  assert.deepEqual(fields.code, ['a\r\nb\r\n']);
  assert.equal(files.icon.filename, 'logo.png');   // old IE sends the whole path
  assert.equal(files.icon.type, 'image/png');
  assert.deepEqual(files.icon.data, icon);
  assert.equal(files.win_cert, undefined, 'file parts not asked for are dropped');
  assert.equal(files.empty.data.length, 0);
  assert.equal(boundaryOf('multipart/form-data; boundary="a b"'), 'a b');
  assert.equal(boundaryOf('multipart/form-data'), null);
  // Truncated, no boundary, another type.
  assert.throws(() => parseMultipart(m.body.subarray(0, m.body.length - 60), '---------------------------7d93b2a1f0e4c'), /truncated/);
  assert.throws(() => parseForm('multipart/form-data', m.body), /boundary/);
  assert.throws(() => parseForm('multipart/form-data; boundary=zzz', m.body), /boundary/);
  assert.throws(() => parseForm('text/plain', Buffer.from('a=1')), (e) => e instanceof BadForm && e.unsupported);
});

/* ---------- src/shared/form-job.js against new.html ---------- */

test('new.html: the form posts to the server, and names what the mapping reads', () => {
  const tag = /<form id="new-form"[^>]*>/.exec(NEW_HTML);
  assert.ok(tag, 'the form has id new-form');
  assert.match(tag[0], /\baction="submit"/);
  assert.match(tag[0], /\bmethod="post"/);
  assert.match(tag[0], /\benctype="multipart\/form-data"/);
  // Nothing secret goes in a plain post: file inputs other than the icon,
  // and the access token, have no name.
  for (const m of NEW_HTML.matchAll(/<input\b[^>]*\btype="(?:file|password)"[^>]*>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[0]);
    assert.ok(!name || name[1] === 'icon', 'a secret input with a name: ' + m[0]);
  }
  // The templates' editors are rendered from src/shared/templates.js (src/web_client/write-editor.js):
  // new.html has their places and no code of its own.
  assert.match(NEW_HTML, /<div class="template-cards"><\/div>/);
  assert.match(NEW_HTML, /<div class="template-editor"><\/div>/);
  assert.ok(!/name="code_/.test(NEW_HTML), 'new.html has no template code of its own');
  // Every language in the form but Other has templates, and a script one.
  const langs = [...NEW_HTML.matchAll(/<select id="runtime" name="runtime">([\s\S]*?)<\/select>/g)][0][1];
  for (const m of langs.matchAll(/<option value="([a-z0-9]+)"/g)) {
    if (m[1] === 'none') assert.ok(!TEMPLATES[m[1]]);
    else assert.ok(TEMPLATE_FILES[m[1]] && TEMPLATE_FILES[m[1]].script, m[1] + ' has a script template');
  }
  // The build fields' starting values.
  const builds = {};
  for (const m of NEW_HTML.matchAll(/<input type="text" class="entry entry-([a-z]+)"[^>]*\bname="build_\1" value="([^"]*)"/g)) builds[m[1]] = m[2];
  const go = /<input type="text" class="entry entry-go" id="compiled-build" name="build_go" value="([^"]*)"/.exec(NEW_HTML);
  if (go) builds.go = go[1];
  builds.cc = /<input type="text" id="cc-build" name="cc_build"[^>]*?(?:value="([^"]*)")?[^>]*>/.exec(NEW_HTML)[1] || '';
  assert.deepEqual(builds, BUILD_DEFAULTS);
  // The launch fields' starting values.
  const entries = {};
  for (const m of NEW_HTML.matchAll(/<input type="text" class="entry entry-([a-z]+)"[^>]*\bname="entry_\1" value="([^"]*)"/g)) entries[m[1]] = m[2].replace(/&amp;/g, '&');
  assert.deepEqual(entries, ENTRY_DEFAULTS);
});

// A form's fields as the page has them at the start (new.html's defaults).
function defaults() {
  return {
    app_name: [''], source_kind: ['repo'], source: [''], runtime: ['python'], template: ['script'], rv_mode: ['newest'],
    runtime_version: [''], runtime_exact: [''], install_cmd: [''], ref_type: ['latest'], ref: [''],
    target_windows: ['on'], target_linux: ['on'], target_macos: ['on'], mode: ['ours'], root: ['user'], rootname: ['ti'],
    shortcut_menu: ['on'], uninstaller: ['on'], cleanup_pkg_cache: ['on'], cleanup_tools: ['remove'], cleanup_fail: ['remove'],
    uninstall_data: ['ask'], icon_choice: ['default'], entry_python: [ENTRY_DEFAULTS.python], entry_node: [ENTRY_DEFAULTS.node],
    code_python_script: ['print("hi")\r\n'], win_unpre_script: [''], unix_unpre_script: [''], pf_url: [''],
  };
}

test('src/shared/form-job.js: a plain post of the form reads as the page reads it', () => {
  const icon = { choice: 'default' };
  // GitHub, with a tag.
  let { job, problems } = jobFromForm(postedForm({ ...defaults(), source: [' https://github.com/psf/requests.git '], ref_type: ['tag'], ref: ['v2.0'] }), { icon });
  assert.deepEqual(problems, []);
  assert.deepEqual(job.source, { kind: 'github', value: 'psf/requests', ref: 'v2.0' });
  assert.equal(job.mode, 'A');
  assert.equal(job.offline, false);
  assert.deepEqual(job.platforms, ['windows', 'linux', 'macos']);
  assert.equal(job.launch, ENTRY_DEFAULTS.python);
  assert.equal(job.pack, undefined, 'mode A carries no pack');
  // Written here: CRLF from the browser becomes LF, and the launch command runs main.py.
  ({ job, problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], mode: ['unsigned'], offline: ['on'] }), { icon }));
  assert.deepEqual(problems, []);
  assert.deepEqual(job.files, { 'main.py': 'print("hi")\n' });
  assert.equal(job.launch, '{runtime} {app_dir}/main.py');
  assert.equal(job.mode, 'C');
  assert.equal(job.offline, true);
  // /classic has no packed-target picker, so ticking "offline" there takes
  // the defaults rather than asking for nothing (src/shared/form-job.js).
  // offline_include is gone: nothing read it, so both of its values
  // produced the same file and the form no longer sends it.
  assert.deepEqual(job.pack, { shape: 'single',
    offline_targets: ['win_1011_amd64', 'linux_amd64', 'mac_amd64', 'mac_arm64'] });
  // An edited launch command is kept.
  ({ job } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], entry_python: ['{runtime} other.py'] }), { icon }));
  assert.equal(job.launch, '{runtime} other.py');
  // /classic: one launch field, empty for the default.
  const classic = { ...defaults() };
  delete classic.entry_python;
  ({ job } = jobFromForm(postedForm({ ...classic, source: ['requests'], launch: [''] }), { icon }));
  assert.equal(job.launch, '');
  assert.deepEqual(job.source, { kind: 'package', value: 'requests' });
  ({ job } = jobFromForm(postedForm({ ...classic, source: ['requests'], launch: [' x '], ref_type: ['tag'], ref: ['2.31.0'] }), { icon }));
  assert.equal(job.launch, 'x');
  assert.deepEqual(job.source, { kind: 'package', value: 'requests', version: '2.31.0' });
  assert.deepEqual(parseSource('https://example.com/a.zip', 'latest', ''), { kind: 'url', value: 'https://example.com/a.zip' });
  // What's missing, said as the page says it.
  const bare = { ...defaults() };
  delete bare.target_windows; delete bare.target_linux; delete bare.target_macos;
  ({ problems } = jobFromForm(postedForm({ ...bare, rv_mode: ['range'] }), { icon }));
  assert.deepEqual(problems, ['Pick at least one platform under "Build for".', 'Say what to package: a GitHub repo URL or a package name.',
    'Enter the versions allowed, or pick another "Which version" option.']);
  ({ problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], runtime: ['none'] }), { icon }));
  assert.match(problems[0], /template isn't available/);
  ({ problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], runtime: ['ruby'], template: ['tray'] }), { icon }));
  assert.match(problems[0], /template isn't available/);
});

// The packed-target picker, which is the one place architecture is a choice
// (docs/format.md section 3; an online installer covers every architecture
// from one file and picks on the machine, so there is nothing to ask there).
test('new.html: the packed-target picker offers every architecture, with its size', () => {
  const offline = /<table class="small offline-targets"[\s\S]*?<\/table>/.exec(NEW_HTML);
  assert.ok(offline, 'new.html has the packed-target table');
  const html = offline[0];
  // The hidden marker that tells a plain post the picker was there at all.
  assert.match(NEW_HTML, new RegExp('<input type="hidden" name="' + OFFLINE_PICKER_FIELD + '"'));
  const seen = new Set();
  for (const m of html.matchAll(/<input type="checkbox" name="(offline_[a-z0-9_]+)"([^>]*)>\s*([^<]*)<span class="muted arch-mb">(\d+) MB<\/span>/g)) {
    seen.add(m[1]);
    const t = OFFLINE_TARGETS.find((x) => x.arches.some((a) => offlineField(x.id, a.arch) === m[1]));
    assert.ok(t, 'a box for an unknown target: ' + m[1]);
    const a = t.arches.find((y) => offlineField(t.id, y.arch) === m[1]);
    // The size in the page (what a browser with no JavaScript sees) and the
    // size the request is checked against must be the same number.
    assert.equal(Number(m[4]), a.mb, m[1] + ': new.html says ' + m[4] + ' MB, form-job.js says ' + a.mb);
    assert.equal(/\bchecked\b/.test(m[2]), !!a.on, m[1] + ": ticked by default?");
    // 32-bit and 64-bit are spelled out, never left as "x86" alone.
    assert.match(m[3], a.arch === 'x86' ? /32-bit/ : /64-bit|Apple Silicon/, m[1] + ' label: ' + m[3]);
  }
  for (const t of OFFLINE_TARGETS) {
    for (const a of t.arches) assert.ok(seen.has(offlineField(t.id, a.arch)), 'no box for ' + t.id + ' ' + a.arch);
  }
  // Where a platform has no 32-bit at all, the reason is in the page rather
  // than the row simply being short.
  assert.match(html, /32-bit: none\. Apple dropped 32-bit support in macOS 10\.15/);
  // And the ordinary (online) case says what is covered, and that it is not
  // a choice.
  assert.match(NEW_HTML, /<ul class="arch-cover small" id="arch-cover">/);
  assert.match(NEW_HTML, /picks the right one on the computer it runs on, so there is nothing to choose(?:&nbsp;| )here/);
});

test('src/shared/form-job.js: an offline pack names its architectures, and is refused when too big', () => {
  const icon = { choice: 'default' };
  const picker = { [OFFLINE_PICKER_FIELD]: ['1'] };
  const post = (extra) => jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], mode: ['unsigned'], offline: ['on'], ...picker, ...extra }), { icon });

  // A 32-bit and a 64-bit box ticked for the same system are two targets.
  let { job, problems } = post({ offline_win_1011_amd64: ['on'], offline_win_1011_x86: ['on'] });
  assert.deepEqual(problems, []);
  assert.deepEqual(job.pack.offline_targets, ['win_1011_amd64', 'win_1011_x86']);
  assert.equal(job.pack.shape, 'single');
  assert.equal(offlineSizeMb(job.pack.offline_targets, job.platforms), 58);

  // The picker there and nothing ticked is an error; without the picker
  // (that is, /classic) the same post takes the defaults.
  ({ problems } = post({}));
  assert.deepEqual(problems, ['Tick at least one system and architecture under "Must work offline on", or turn off "Also make offline installers".']);

  // A form from before architectures were a choice: the bare box still
  // means that system, with the architectures it started with.
  ({ job, problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], mode: ['unsigned'], offline: ['on'], offline_mac: ['on'] }), { icon }));
  assert.deepEqual(problems, []);
  assert.deepEqual(job.pack.offline_targets, ['mac_amd64', 'mac_arm64']);

  // Architectures only count for a platform being built for.
  ({ job, problems } = post({ offline_linux_x86: ['on'], target_linux: [] }));
  assert.deepEqual(problems, ['Tick at least one system and architecture under "Must work offline on", or turn off "Also make offline installers".']);

  // Too big for one file: refused, with the zip named. The same one
  // mechanism counts OS rows and architectures together, and an uploaded
  // source counts with them, since it is packed too.
  const every = {};
  for (const t of OFFLINE_TARGETS) for (const a of t.arches) every[offlineField(t.id, a.arch)] = ['on'];
  const all = Object.keys(every).map((k) => k.replace(/^offline_/, ''));
  assert.ok(PACK_WARN_MB < PACK_MAX_MB);
  assert.ok(offlineSizeMb(all, ['windows', 'linux', 'macos']) < PACK_WARN_MB,
    'every architecture ticked is still under the warning line on its own');
  ({ job, problems } = post({ ...every }));
  assert.deepEqual(problems, []);
  assert.equal(job.pack.offline_targets.length, all.length);
  // With a big upload on top it crosses the line, and the message names the
  // two ways out.
  const big = { name: 'app.zip', size: PACK_MAX_MB * 1048576 };
  ({ problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['local'], mode: ['unsigned'], offline: ['on'],
    ...picker, offline_win_1011_amd64: ['on'] }), { icon, local: big }));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /past the 1900 MB an installer can hold in one file/);
  assert.match(problems[0], /Untick some architectures, or choose the zip/);
  // The zip is the way out, and it is the same picker's radio.
  ({ problems } = jobFromForm(postedForm({ ...defaults(), source_kind: ['local'], mode: ['unsigned'], offline: ['on'],
    ...picker, offline_win_1011_amd64: ['on'], offline_shape: ['zip'] }), { icon, local: big }));
  assert.deepEqual(problems, []);

  // The zip is a radio on the same form, not a second mechanism.
  ({ job } = post({ offline_win_1011_amd64: ['on'], offline_shape: ['zip'] }));
  assert.equal(job.pack.shape, 'zip');

  // Mode A never carries a pack, architectures or not.
  ({ job } = jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], offline: ['on'], ...picker, offline_win_1011_x86: ['on'] }), { icon }));
  assert.equal(job.pack, undefined);
  assert.equal(job.offline, false);
});

// The launch command is the one thing about a project that can't be
// inferred -- the files say how to install it, nothing says how to run it --
// so it belongs in the main form, not behind a <details> under Customise.
// This test is here to fail if it is ever filed away again.
test('new.html: the launch command is in the main form, not hidden under Customise', () => {
  const form = NEW_HTML.slice(NEW_HTML.indexOf('<form id="new-form"'));
  const at = form.indexOf('name="entry_python"');
  assert.ok(at > 0, 'the form has the Python launch field');
  // Before the Customise sections, so it is on screen without opening
  // anything. Anchored on the container that holds them rather than on one
  // spelling of the heading: the heading is an eyebrow plus an <h2> now.
  const customise = form.indexOf('<div class="customise">');
  assert.ok(customise > 0 && at < customise, 'the launch field comes before Customise');
  assert.match(form.slice(0, customise), /Customise<\/span>|<h2>Customise/,
    'and the heading over those sections still calls them Customise');
  // And not inside any <details> at all: count the ones opened and closed
  // before it, which must balance.
  const before = form.slice(0, at);
  const opened = (before.match(/<details\b/g) || []).length;
  const closed = (before.match(/<\/details>/g) || []).length;
  assert.equal(opened, closed, 'the launch field is not inside a <details>');
  // Next to "Build for", in the same run of main-form questions.
  assert.ok(at < form.indexOf('<span class="label">Build for</span>'), 'it comes before "Build for"');
  // And it is asked by name, as the field's own label (it used to be a
  // heading above a "Launch command" field; the question is the label now).
  assert.match(form.slice(0, at), /<label for="entry-python">How does it start\?<\/label>/);
  // Every language still has its field, with the default the mapping knows
  // (the test above checks the values; this checks none was lost in the move).
  for (const rt of Object.keys(ENTRY_DEFAULTS)) {
    assert.ok(form.indexOf('name="entry_' + rt + '"') > 0, 'no launch field for ' + rt);
  }
  // How loudly it asks depends on the source: src/web_client/new.js swaps the repo text
  // for a quieter one when the source is a package, and the written-here
  // case is quiet with no JavaScript at all.
  assert.match(form, /id="launch-why-repo"/);
  assert.match(form, /class="small launch-why src-local-only"/);
  assert.match(form, /id="launch-why-write"/);
});

test('src/shared/form-job.js: a template\'s launch is used until the field is edited', () => {
  const icon = { choice: 'default' };
  const write = (extra) => jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], mode: ['unsigned'], ...extra }), { icon });
  // Electron's launch is nothing like the language default, so it is the
  // case that shows whether the distinction is being made at all.
  const tray = templateLaunch('node', 'tray');
  assert.notEqual(tray, ENTRY_DEFAULTS.node);
  // Untouched: the field still holds the language default, and the
  // template's command wins.
  let { job } = write({ runtime: ['node'], template: ['tray'], entry_node: [ENTRY_DEFAULTS.node] });
  assert.equal(job.launch, tray);
  // A page that put the template's own command in the field (src/web_client/new.js
  // syncLaunchDefault does) posts that, and it must not read as an edit.
  ({ job } = write({ runtime: ['node'], template: ['tray'], entry_node: [tray] }));
  assert.equal(job.launch, tray);
  // Edited: the publisher's command wins over the template's.
  ({ job } = write({ runtime: ['node'], template: ['tray'], entry_node: ['{runtime} {app_dir}/other.js'] }));
  assert.equal(job.launch, '{runtime} {app_dir}/other.js');
  // A repo is not a template: the field is used as it stands, edited or not.
  ({ job } = jobFromForm(postedForm({ ...defaults(), source: ['owner/thing'], runtime: ['node'],
    entry_node: [ENTRY_DEFAULTS.node] }), { icon }));
  assert.equal(job.launch, ENTRY_DEFAULTS.node);
  ({ job } = jobFromForm(postedForm({ ...defaults(), source: ['owner/thing'], runtime: ['node'],
    entry_node: ['{runtime} {app_dir}/server.js'] }), { icon }));
  assert.equal(job.launch, '{runtime} {app_dir}/server.js');
  // /classic has one launch field for every language, empty for the
  // default; it must still reach the same answers.
  const classic = { ...defaults() };
  delete classic.entry_python;
  delete classic.entry_node;
  ({ job } = jobFromForm(postedForm({ ...classic, source_kind: ['write'], runtime: ['node'], template: ['tray'], launch: [''] }), { icon }));
  assert.equal(job.launch, tray, '/classic, nothing typed: the template\'s command');
  ({ job } = jobFromForm(postedForm({ ...classic, source_kind: ['write'], runtime: ['node'], template: ['tray'], launch: ['  {app_dir}/run.sh  '] }), { icon }));
  assert.equal(job.launch, '{app_dir}/run.sh', '/classic, typed: the publisher\'s command');
});

test('src/shared/form-job.js: written apps take their template\'s commands (src/shared/templates.js)', () => {
  const icon = { choice: 'default' };
  const write = (extra) => jobFromForm(postedForm({ ...defaults(), source_kind: ['write'], mode: ['unsigned'], ...extra }), { icon });
  // A plain post without the editor (a page with no JavaScript): the template's own files.
  let { job, problems } = write({ runtime: ['node'], template: ['web'], code_python_script: [] });
  delete job.icon;
  assert.deepEqual(problems, []);
  assert.deepEqual(job.files, TEMPLATES.node.web.files);
  assert.equal(job.launch, '{runtime} {app_dir}/main.js');
  assert.equal(job.console, true);
  // A window app has no console; Java's classes run from the app's folder.
  ({ job } = write({ runtime: ['java'], template: ['window'] }));
  assert.equal(job.console, false);
  assert.equal(job.launch, '{runtime} -cp {app_dir} Main');
  assert.equal(job.install, '');
  assert.deepEqual(job.prerequisites, ['fontconfig', 'libxtst'], 'what Swing needs on Linux (policy prerequisites)');
  // Compiled: the build field as the form starts it isn't sent (the
  // policy's command for the template's files is used); an edited one is.
  ({ job } = write({ runtime: ['go'], build_go: [BUILD_DEFAULTS.go] }));
  assert.equal(job.install, '');
  assert.equal(job.launch, '{app_dir}/{project}{exe}');
  ({ job } = write({ runtime: ['go'], build_go: ['go build -tags x -o {app_dir}/{project}{exe} .'] }));
  assert.equal(job.install, 'go build -tags x -o {app_dir}/{project}{exe} .');
  // A repo keeps the build field, as before.
  ({ job } = jobFromForm(postedForm({ ...defaults(), runtime: ['go'], source: ['a/b'], build_go: [BUILD_DEFAULTS.go] }), { icon }));
  assert.equal(job.install, BUILD_DEFAULTS.go);
  // The versions a template needs, unless the form narrows them itself.
  ({ job } = write({ runtime: ['zig'] }));
  assert.equal(job.select, 'range');
  assert.equal(job.range, TEMPLATES.zig.script.versions);
  ({ job } = write({ runtime: ['zig'], rv_mode: ['exact'], runtime_exact: ['0.16.0'] }));
  assert.equal(job.range, '0.16.0');
  // A template for some platforms only says so.
  ({ problems } = write({ runtime: ['dotnet'], template: ['window'] }));
  assert.deepEqual(problems, ['This template doesn\'t work on Linux or macOS. Untick Linux and macOS under "Build for".']);
  ({ problems } = write({ runtime: ['dotnet'], template: ['window'], target_linux: [], target_macos: [] }));
  assert.deepEqual(problems, []);
});

/* ---------- the pages ---------- */

test('pages: escaped, HTML 4, no script, refresh only while under way', () => {
  assert.equal(esc(HOSTILE), '&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&gt;&lt;img src=x onerror=alert(2)&gt;&amp;amp;');
  const view = (status, extra = {}) => ({ id: 'j_' + 'a'.repeat(18), ticket: 7, class: 'build', status, position: 2, eta_seconds: 95, progress: HOSTILE, error: null, ...extra });
  const req = { name: HOSTILE, mode: 'B' };
  const done = view('done', { result: { record: 'abcdefghijklmnopqrstuvwxyz', files: [
    { platform: 'windows', name: BAD_FILE, url: '/dl/abcdefghijklmnopqrstuvwxyz/' + BAD_FILE, size: 2048, sha256: 'f'.repeat(64), signed: '' },
    { platform: 'macos', name: HOSTILE + '.zip', url: '/dl/abcdefghijklmnopqrstuvwxyz/' + HOSTILE + '.zip', size: 2048, sha256: 'f'.repeat(64), signed: '' },
    { platform: 'linux', name: 'x.run', url: 'javascript:alert(1)', size: 10, sha256: 'e'.repeat(64), signed: HOSTILE },
  ] } });
  const pages = {
    queued: statusPage(view('queued'), req), running: statusPage(view('running'), req), done: statusPage(done, req),
    failed: statusPage(view('failed', { error: HOSTILE }), req), classic: classicPage([{ id: 'py"thon', label: HOSTILE, launch: HOSTILE }]),
    refused: refusedPage([HOSTILE]), plain: page({ title: HOSTILE, body: '' }),
  };
  for (const [k, h] of Object.entries(pages)) {
    assert.ok(!/<script|<img|href="javascript:/i.test(h), k + ': hostile text got through: ' + (/.{40}(<script|<img|href="javascript:).{40}/i.exec(h) || [''])[0]);
    assert.ok(h.startsWith('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"'), k + ': HTML 4.01');
    assert.ok(!/<(header|footer|main|nav|section|article|aside)\b/.test(h), k + ': no HTML5 elements');
    assert.ok(!/var\(--|:has\(|display:\s*(flex|grid)/.test(h), k + ': no CSS old IE needs and lacks');
  }
  assert.match(pages.queued, /<meta http-equiv="refresh" content="3">/);
  assert.match(pages.queued, /2 ahead of you/);
  assert.match(pages.queued, /About 2 minutes/);
  assert.match(pages.running, /<meta http-equiv="refresh" content="3">/);
  assert.ok(!/http-equiv="refresh"/.test(pages.done) && !/http-equiv="refresh"/.test(pages.failed), 'no refresh when finished');
  assert.match(pages.failed, /The build failed: &lt;script&gt;/);
  // The file link: escaped and percent-encoded; a url that isn't /dl/ gets no link.
  assert.ok(pages.done.includes('<a href="../dl/abcdefghijklmnopqrstuvwxyz/%3Cimg%20src%3Dx%20onerror%3Dalert(2)%3E%22&#39;%26.exe">&lt;img src=x'));
  // A name with a slash, or a url that isn't /dl/: no link.
  assert.match(pages.done, /<td>&lt;script&gt;alert\(1\)&lt;\/script&gt;[^<]*\.zip<\/td>/);
  assert.match(pages.done, /<td>x\.run<\/td>/);
  assert.match(pages.done, /href="\.\.\/api\/records\/abcdefghijklmnopqrstuvwxyz"/);
  assert.match(pages.done, /sign these files with your own certificate/);
  assert.match(pages.classic, /<option value="py&quot;thon">&lt;script&gt;/);
});

/* ---------- the server end to end ---------- */

function reachable(addr) {
  const i = addr.lastIndexOf(':');
  return new Promise((resolve) => {
    const s = net.connect(Number(addr.slice(i + 1)), addr.slice(0, i), () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
}

const skip = !haveCatalog ? 'no runtime catalogue' : !haveBases ? 'no bases' : !(await reachable(REDIS)) ? 'no Redis at ' + REDIS : false;

function req(port, p, { method = 'GET', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => { const b = Buffer.concat(c); resolve({ status: res.statusCode, headers: res.headers, body: b, text: b.toString() }); });
    });
    r.on('error', reject);
    r.end(body);
  });
}

test('the server: plain form posts and status pages', { skip }, async (t) => {
  const data = tmpDir(t);
  const site = tmpDir(t);
  fs.writeFileSync(path.join(site, 'index.html'), '<!doctype html><title>t</title>');
  const DB = await claimRedisDb(t, IORedis, REDIS, PINNED);
  const o = parseFlags(['-redis', REDIS, '-redis-db', String(DB), '-data', data, '-site', site, '-public', 'http://127.0.0.1:1', '-workers', '1']);
  o.log = () => {};
  const s = new Server(o);
  await s.init();
  s.serveWorkers();
  const srv = http.createServer(s.handler());
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  // The keys go with the claim: claimRedisDb registered the cleanup.
  t.after(async () => {
    srv.close();
    await s.q.close();
  });
  const get = (p, opt) => req(port, p, opt);
  const form = (fields) => get('/submit', { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const isPage = (r, status, what) => {
    assert.equal(r.status, status, what + ': ' + r.text.slice(0, 600));
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', what);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/, what);
  };
  // Follows a 303 to the status page until the build is done; returns the last page.
  const follow = async (r) => {
    assert.equal(r.status, 303, r.text.slice(0, 800));
    const loc = r.headers.location;
    assert.match(loc, /^status\/j_[0-9a-f]+$/);
    let p;
    for (let i = 0; i < 600; i++) {
      p = await get('/' + loc);
      isPage(p, 200, 'status');
      if (!/http-equiv="refresh"/.test(p.text)) break;
      await new Promise((res) => setTimeout(res, 100));
    }
    return { id: loc.slice(7), page: p.text };
  };
  const links = (html) => [...html.matchAll(/<a href="\.\.\/dl\/([^"]+)">/g)].map((m) => '/dl/' + m[1].replace(/&amp;/g, '&'));
  const code = 'print("hello from a plain form")\r\n';
  const base = { source_kind: 'write', runtime: 'python', template: 'script', code_python_script: code, mode: 'unsigned', rv_mode: 'newest',
    entry_python: ENTRY_DEFAULTS.python, target_linux: 'on', shortcut_menu: 'on', root: 'user', rootname: 'ti' };

  await t.test('/classic: the form, from the catalogue', async () => {
    const r = await get('/classic');
    isPage(r, 200, 'classic');
    assert.match(r.text, /<form action="submit" method="post" enctype="multipart\/form-data" accept-charset="utf-8">/);
    assert.match(r.text, /<option value="python" selected>/);
    for (const n of ['app_name', 'source', 'runtime', 'ref_type', 'ref', 'target_windows', 'mode', 'offline', 'rv_mode', 'install_cmd', 'launch', 'icon', 'root']) {
      assert.match(r.text, new RegExp('name="' + n + '"'), n);
    }
    assert.equal((await get('/classic', { method: 'HEAD' })).status, 200);
  });

  await t.test('urlencoded: 303, the status page, the files read back', async () => {
    const r = await form({ ...base, app_name: HOSTILE });
    const { id, page: html } = await follow(r);
    assert.ok(!/<script|<img/.test(html), 'the name is escaped');
    assert.match(html, /<h1>&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /Done/);
    const j = JSON.parse((await get('/api/jobs/' + id)).text);
    assert.equal(j.status, 'done', j.error);
    const dl = links(html);
    assert.deepEqual(dl, j.result.files.map((f) => f.url.replace(/[^/]+$/, (n) => encodeURIComponent(n))));
    const rec = (await get('/api/records/' + j.result.record)).text;
    assert.match(rec, /\nlaunch\t\{runtime\} \{app_dir\}\/main\.py\n/);
    const d = await get(dl[0]);
    assert.equal(d.status, 200);
    const info = await readInstaller(new Uint8Array(d.body), j.result.files[0].name);
    assert.equal(info.record, rec);
    assert.equal(await recordHash(info.record), j.result.record);
    // CRLF as sent became LF, as the page reads a textarea.
    const queued = await s.q.get(id);
    assert.deepEqual(queued.request.files, { 'main.py': code.replace(/\r\n/g, '\n') });
    assert.match(html, new RegExp('href="\\.\\./api/records/' + j.result.record + '"'));
  });

  await t.test('the same form as JSON makes the same record (but its time)', async () => {
    const a = await follow(await form({ ...base, app_name: 'Same' }));
    const ja = JSON.parse((await get('/api/jobs/' + a.id)).text);
    const { job } = jobFromForm(postedForm(Object.fromEntries(Object.entries({ ...base, app_name: 'Same' }).map(([k, v]) => [k, [v]]))), { icon: { choice: 'default' } });
    let jb = JSON.parse((await get('/api/jobs', { method: 'POST', body: JSON.stringify(job) })).text);
    while (jb.status !== 'done' && jb.status !== 'failed') { await new Promise((r) => setTimeout(r, 100)); jb = JSON.parse((await get('/api/jobs/' + jb.id)).text); }
    // The records match but for when each was made.
    const rec = async (h) => (await get('/api/records/' + h)).text.replace(/^created\t.*\n/m, '');
    assert.equal(await rec(jb.result.record), await rec(ja.result.record));
  });

  await t.test('multipart, with an icon', async () => {
    const icon = png(32);
    const m = multipart([...Object.entries({ ...base, app_name: 'Iconic', mode: 'yours' }).map(([name, value]) => ({ name, value })),
      { name: 'icon', filename: 'C:\\pics\\logo.png', type: 'image/png', value: icon }]);
    const { id, page: html } = await follow(await get('/submit', { method: 'POST', body: m.body, headers: { 'Content-Type': m.type } }));
    const j = JSON.parse((await get('/api/jobs/' + id)).text);
    assert.equal(j.status, 'done', j.error);
    const rec = (await get('/api/records/' + j.result.record)).text;
    const sha = /\nicon\t([0-9a-f]{64})\n/.exec(rec);
    assert.ok(sha, 'the record names the icon: ' + rec);
    assert.deepEqual((await get('/icons/' + sha[1] + '.png')).body, icon);
    assert.match(html, /sign these files with your own certificate/);
    // Not a PNG, too big.
    const bad = multipart([...Object.entries(base).map(([name, value]) => ({ name, value })), { name: 'icon', filename: 'a.png', value: 'not a png' }]);
    isPage(await get('/submit', { method: 'POST', body: bad.body, headers: { 'Content-Type': bad.type } }), 400, 'not a png');
    const big = multipart([...Object.entries(base).map(([name, value]) => ({ name, value })), { name: 'icon', filename: 'a.png', value: Buffer.alloc((1 << 20) + 1) }]);
    const rb = await get('/submit', { method: 'POST', body: big.body, headers: { 'Content-Type': big.type } });
    isPage(rb, 400, 'big icon');
    assert.match(rb.text, /The icon is over 1 MB/);
  });

  await t.test('bad input: a page saying why, escaped', async () => {
    const cases = [
      [{ ...base, source_kind: 'repo', source: 'a/b', runtime: HOSTILE }, 400, /unknown runtime &quot;&lt;script&gt;/],
      [{ ...base, runtime: HOSTILE }, 400, /template isn&#39;t available/],
      [{ ...base, app_name: 'a\u202eb' }, 400, /control or text-direction/],
      [{ ...base, source_kind: 'repo', source: '' }, 400, /Say what to package/],
      [{ ...base, source_kind: 'local' }, 400, /Files from your computer/],
      [{ ...base, source_kind: 'repo', source: 'not a/valid name!', runtime: 'python' }, 400, /./],
      [{ ...base, rv_mode: 'exact' }, 400, /Enter the exact version/],
    ];
    for (const [f, status, re] of cases) {
      const r = await form(f);
      isPage(r, status, JSON.stringify(f).slice(0, 80));
      assert.match(r.text, re);
      assert.ok(!/<script|<img/.test(r.text));
      assert.match(r.text, /<a href="classic">start again<\/a>/);
    }
    isPage(await get('/submit', { method: 'POST', body: 'a=1', headers: { 'Content-Type': 'text/plain' } }), 415, 'text/plain');
    const m = multipart([{ name: 'a', value: 'b' }]);
    isPage(await get('/submit', { method: 'POST', body: m.body.subarray(0, 50), headers: { 'Content-Type': m.type } }), 400, 'truncated');
    const huge = await get('/submit', { method: 'POST', body: 'a=' + 'x'.repeat(5 << 20), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    isPage(huge, 413, 'over 4 MB');
    assert.equal(huge.headers.connection, 'close');
    // Status pages for no such job.
    for (const p of ['/status/j_nothing', '/status/' + encodeURIComponent(HOSTILE)]) {
      const r = await get(p);
      isPage(r, 404, p);
      assert.ok(!/<script/.test(r.text));
    }
    assert.equal((await get('/status/j_x', { method: 'POST' })).status, 405);
    const g = await get('/submit');
    assert.deepEqual([g.status, g.headers.location], [303, 'classic']);
  });

  await t.test('a failed build: its reason, escaped, and no refresh', async () => {
    // A package no registry has fails in the worker, not at the door.
    const r = await form({ ...base, source_kind: 'repo', source: 'https://127.0.0.1/<b>.zip', mode: 'unsigned' });
    const { page: html } = await follow(r);
    assert.match(html, /Failed/);
    assert.match(html, /The build failed: /);
    assert.ok(!/<b>/.test(html));
  });

  await t.test('rate limits: shared with POST /api/jobs', async () => {
    s.limiter = new Limiter(2, 60000);
    assert.equal((await form(base)).status, 303);
    assert.equal((await get('/api/jobs', { method: 'POST', body: '{' })).status, 400);
    const r = await form(base);
    isPage(r, 429, 'the third');
    assert.match(r.text, /Too many builds from your address/);
    assert.equal((await get('/api/jobs', { method: 'POST', body: '{' })).status, 429);
  });
});
