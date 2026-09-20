// Runs the TiddlyInstall page tests in Internet Explorer on a Windows test
// machine. No WebDriver: IEDriverServer needs Protected Mode and zoom
// settings changed and a desktop session, and SSH has neither. Instead
// tests/browsers/ie-agent.js drives IE through COM automation
// (InternetExplorer.Application, hidden) under cscript over SSH, and this
// sends it one command at a time.
//
//   node tests/browsers/ie.mjs --machine 7 [--page dist/index.html] [--docmode 7|8|9|10]
//        [--no-record] [--keep]
//   node tests/browsers/ie.mjs --machine xp --browser chromium49
//
// Every IE: the page loads from disk (a file:// copy, as a person would open
// a saved page); web/browser-check.js runs and its bar says whether this
// browser can run the builder and what to use instead; the static text
// reads, dark on light; and the page throws no errors. IE 11 runs the
// page's ES5 copy (web/page-loader.js), so there the same steps as run.mjs
// follow: sections and the :has()-driven form, an installer built with no
// server and read back with shared/ibfile.js, "Save this page" and the saved
// copy starting, and PGP and .pfx signing checked here with gpg and
// osslsigncode. IE saves through navigator.msSaveOrOpenBlob, which the test
// replaces to keep what is saved; files are given to the page's file inputs
// as Blobs (IE can't set an input's files from script).
//
// --docmode N adds X-UA-Compatible IE=N to the copy, so IE 11 and 9 stand in
// for IE 7-10 (the engine is the same; only the document mode changes);
// such runs are kept in results/ but not in usage.jsonl.
//
// The step expressions (tests/browsers/steps.mjs, modern JavaScript) go
// through Babel (tools/es5/node_modules) to ES5 before they run in IE 11.
// Results go to usage.jsonl as browser "ie", like run.mjs's.
//
// --classic URL: the build server's plain-HTML path instead (docs/api.md
// "Plain form posts"), for the IE that can't run the page: IE opens
// URL/classic over plain HTTP, fills the form and submits it (a real
// submit, multipart), follows the status page (it reloads itself with
// <meta http-equiv="refresh">) to the download links, and this side
// checks what the links give (tests/browsers/classic.mjs). --mode ours|
// yours|unsigned (default ours), --out DIR keeps the installers with a
// builds.json for tests/matrix/run.py. Results go to results/ only (not
// usage.jsonl: that is about the page).
//
// --browser chromium49: the same steps in Chromium 49 on XP (the last
// Chrome there; Google's snapshot build r369909, 49.0.2623.0, in
// C:\ibbrowsers\chromium-49, docs/test-vms.md), over the DevTools protocol:
// it has no async functions either, so it runs the ES5 copy too. Recorded
// as browser "chromium".
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMachines, findMachine, freePort, Remote } from './remote.mjs';
import { connectCdp } from './cdp.mjs';
import { Checker, STARTED, checkSections, buildHello, checkJob, makeSignFixtures, osslVerify, gpgVerify, $text, setVal, checkBox, sleep } from './steps.mjs';
import { readInstaller } from '../../shared/ibfile.js';
import { writeCompat } from './compat.mjs';
import { classicFields, checkFinished, MODE_LETTER } from './classic.mjs';

// The DevTools transport needs WebSocket (a flag on Node 20).
if (typeof WebSocket === 'undefined' && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const r = spawnSync(process.execPath, ['--experimental-websocket', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status === null ? 1 : r.status);
}

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..', '..');
const USAGE = path.join(HERE, 'usage.jsonl');
const RESULTS = path.join(HERE, 'results');
const ES5_TOOLS = path.join(ROOT, 'tools', 'es5', 'node_modules');

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const PAGE = path.resolve(arg('--page', path.join(ROOT, 'dist', 'index.html')));
const DOCMODE = arg('--docmode', '');
const BROWSER = arg('--browser', 'ie');
const C49 = 'C:\\ibbrowsers\\chromium-49\\chrome.exe';

/* ---------- the page copy ---------- */

// An error recorder in plain ES3 (window.onerror is the one IE 6 has),
// mirrored to <html data-ib-errors> so the agent can read it over COM even
// where no script of ours can run.
const RECORDER = '<script>window.__ibErrors=[];window.onerror=function(m,u,l,c){var a=window.__ibErrors;a.push(String(m)+" @"+String(u||"").slice(-40)+":"+l+(c?":"+c:""));' +
  'try{document.documentElement.setAttribute("data-ib-errors",a.join(" | "))}catch(e){}};' +
  'if(window.addEventListener)window.addEventListener("unhandledrejection",function(e){var r=e.reason;window.__ibErrors.push("unhandled rejection: "+String(r&&(r.stack||r.message)||r).slice(0,300));' +
  'try{document.documentElement.setAttribute("data-ib-errors",window.__ibErrors.join(" | "))}catch(x){}});</script>';

export function testPage(tmp) {
  let html = fs.readFileSync(PAGE, 'utf8');
  // After X-UA-Compatible, which must come before any script.
  const xua = /<meta http-equiv="X-UA-Compatible" content="IE=edge">\n/;
  if (!xua.test(html)) throw new Error('the page has no X-UA-Compatible meta; rebuild it (tools/build_site.py)');
  html = html.replace(xua, (m) => (DOCMODE ? m.replace('IE=edge', 'IE=' + DOCMODE) : m) + RECORDER + '\n');
  const hash = crypto.createHash('sha256').update(html).digest('hex').slice(0, 12);
  const file = path.join(tmp, `ibtest-${hash}.html`);
  fs.writeFileSync(file, html);
  return file;
}

/* ---------- the agent: IE over COM, one line per command ---------- */

export class Agent {
  constructor(remote, script) {
    this.p = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ServerAliveInterval=15', remote.ssh, `cscript //nologo //E:JScript ${script}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = ''; this.waiting = []; this.lines = []; this.err = '';
    this.p.stdout.on('data', (d) => {
      this.buf += d.toString('latin1');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).replace(/\r$/, '');
        this.buf = this.buf.slice(i + 1);
        const w = this.waiting.shift();
        if (w) w.res(line); else this.lines.push(line);
      }
    });
    this.p.stderr.on('data', (d) => { this.err += d; });
    this.p.on('exit', () => { for (const w of this.waiting.splice(0)) w.rej(new Error('agent exited: ' + this.err.trim().slice(-300))); });
  }
  send(line, ms = 600000) {
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('agent: no answer to ' + line.slice(0, 60))), ms);
      this.waiting.push({ res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.p.stdin.write(line + '\n');
    });
  }
  async ok(line, ms) {
    const r = await this.send(line, ms);
    if (!r.startsWith('OK ')) throw new Error('agent: ' + line.slice(0, 40) + ': ' + r.slice(0, 300));
    return JSON.parse(r.slice(3));
  }
  // Raw code in the page (ES3/ES5, ASCII); returns what it put in data-ibt.
  async raw(code) {
    const esc = code.replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')).replace(/\r?\n/g, '\x01');
    const r = await this.send('EVAL ' + esc);
    if (!r.startsWith('R ')) throw new Error('agent: EVAL: ' + r.slice(0, 300));
    return r.slice(2);
  }
  async quit() {
    try { await this.send('QUIT', 30000); } catch (e) { /* gone */ }
    try { this.p.stdin.end(); } catch (e) { /* gone */ }
    setTimeout(() => this.p.kill(), 5000).unref();
  }
}

// The agent's DOM report, as page script (ES5), for the DevTools transport.
const DOM_JS = `(function () {
  var d = document, h = d.documentElement, r = {}, body = d.body;
  r.title = d.title; r.documentMode = null;
  r.missing = h.getAttribute('data-ib-missing'); r.degraded = h.getAttribute('data-ib-degraded');
  r.ready = h.getAttribute('data-ib-ready'); r.htmlClass = h.className;
  var bar = d.querySelector('.ib-compat-bar');
  r.bar = bar ? { text: bar.innerText, className: bar.className, shown: bar.offsetHeight > 0 } : null;
  r.bodyText = body ? body.innerText.substring(0, 4000) : '';
  r.sections = Array.prototype.map.call(d.querySelectorAll('[data-page]'), function (e) { return e.getAttribute('data-page') + (e.offsetHeight > 0 ? ':shown' : ':hidden'); });
  var cs = getComputedStyle(body);
  r.colors = { body: cs.color + ' on ' + cs.backgroundColor };
  r.errors = h.getAttribute('data-ib-errors');
  return r;
})()`;

// Chromium 49 on the machine, over the DevTools protocol, with the Agent's
// interface (NAV, DOM, VERSION, raw).
class CdpAgent {
  static async start(remote, profile) {
    const a = new CdpAgent();
    a.remote = remote; a.profile = profile; a.log = [];
    a.port = await freePort();
    a.ssh = remote.runForwarded(`${C49} --remote-debugging-port=${a.port} --user-data-dir=${profile} --no-first-run --no-default-browser-check about:blank`, a.port, (d) => a.log.push(String(d)));
    a.conn = await connectCdp(`http://127.0.0.1:${a.port}`, { tries: 300 });
    a.version = (/Chrome\/([\d.]+)/.exec((await (await fetch(`http://127.0.0.1:${a.port}/json/version`)).json()).Browser) || [])[1] || '';
    return a;
  }
  async evaluate(expression) {
    const r = await this.conn.cdp('Runtime.evaluate', { expression, returnByValue: true });
    return r.exceptionDetails ? { error: JSON.stringify(r.exceptionDetails).slice(0, 300) } : { value: r.result.value };
  }
  async ok(line) {
    const sp = line.indexOf(' '), cmd = sp < 0 ? line : line.slice(0, sp), rest = sp < 0 ? '' : line.slice(sp + 1);
    if (cmd === 'VERSION') return { version: this.version };
    if (cmd === 'DOM') { const r = await this.evaluate(DOM_JS); if (r.error) throw new Error('agent: DOM: ' + r.error); return r.value; }
    if (cmd === 'NAV') {
      await this.conn.cdp('Page.navigate', { url: rest });
      const want = rest.split('#')[0];
      for (const end = Date.now() + 300000; Date.now() < end; await sleep(300)) {
        const r = await this.evaluate('[location.href.split("#")[0], document.readyState, document.title]');
        if (r.value && decodeURI(r.value[0]) === decodeURI(want) && r.value[1] === 'complete') return { ready: true, url: r.value[0], title: r.value[2], documentMode: null };
      }
      throw new Error('agent: timed out loading ' + rest);
    }
    throw new Error('agent: unknown command ' + cmd);
  }
  async raw(code) {
    const r = await this.evaluate(`document.documentElement.removeAttribute('data-ibt');\n${code}\n;(function () { var h = document.documentElement, v = h.getAttribute('data-ibt'); h.removeAttribute('data-ibt'); return v; })()`);
    return r.value === null || r.value === undefined ? 'null' : String(r.value);
  }
  async quit() {
    try { await this.conn.close(); } catch (e) { /* closed */ }
    this.remote.stopCdpBrowser(this.port);
    try { this.ssh.kill(); } catch (e) { /* gone */ }
    this.remote.remove(this.profile);
  }
}

/* ---------- modern step expressions, as ES5 ---------- */

let babel = null, presetEnv = null;
export async function toEs5(src) {
  if (!babel) {
    if (!fs.existsSync(ES5_TOOLS)) throw new Error('tools/es5 is not installed (npm install there): needed to run the steps in IE 11');
    babel = (await import(path.join(ES5_TOOLS, '@babel/core/lib/index.js'))).default;
    presetEnv = (await import(path.join(ES5_TOOLS, '@babel/preset-env/lib/index.js'))).default;
  }
  return babel.transformSync(src, {
    babelrc: false, configFile: false, sourceType: 'script', compact: true, comments: false,
    presets: [[presetEnv.default || presetEnv, { targets: { ie: '11', chrome: '49' }, modules: false }]],
  }).code;
}

// js(expr) for the steps: the expression's value (awaited), as JSON. The
// page's ES5 copy has already put Promise, Symbol and the rest in place.
let evalId = 0;
export function makeJs(agent) {
  return async (expr, ms = 600000) => {
    const id = ++evalId;
    const start = await toEs5(`window.__ibtR = window.__ibtR || {};
      Promise.resolve().then(() => (${expr})).then(
        (v) => { window.__ibtR[${id}] = { v: JSON.stringify(v === undefined ? null : v) }; },
        (e) => { window.__ibtR[${id}] = { e: JSON.stringify(String(e && (e.stack || e.message) || e)) }; });
      document.documentElement.setAttribute('data-ibt', '1');`);
    await agent.raw(start);
    const poll = `(function () { var R = window.__ibtR, r = R && R[${id}], out = '';
      if (r) { out = r.e !== undefined ? 'E' + r.e : 'V' + r.v; delete R[${id}]; }
      out = out.replace(/[\\u007f-\\uffff]/g, function (c) { return '\\\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });
      document.documentElement.setAttribute('data-ibt', out); })();`;
    for (const end = Date.now() + ms; Date.now() < end;) {
      const r = await agent.raw(poll);
      if (r && r !== 'null') {
        if (r[0] === 'E') throw new Error('in IE: ' + JSON.parse(r.slice(1)));
        return JSON.parse(r.slice(1));
      }
      await sleep(150);
    }
    throw new Error('in IE: timed out: ' + expr.slice(0, 80));
  };
}

async function waitUntil(js, expr, what, ms = 90000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    const v = await js(expr);
    if (v) return v;
  }
  throw new Error('timed out waiting for ' + what);
}

// Downloads, kept in the page by name instead of saved: IE saves Blobs
// through navigator.msSaveOrOpenBlob (web/legacy-dom.js); Chromium clicks
// an <a download> with a blob: URL.
const CAPTURE = `(() => { if (!window.__ibDl) { window.__ibDl = {};
  const keep = (b, n) => { window.__ibDl[n] = b; return true; };
  navigator.msSaveOrOpenBlob = keep; navigator.msSaveBlob = keep;
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!document.documentMode && this.getAttribute('download') && /^blob:/.test(this.href)) {
      window.__ibDl[this.getAttribute('download')] = fetch(this.href).then((r) => r.blob());
      return undefined;
    }
    return click.apply(this, arguments);
  }; } return true; })()`;

async function captured(js, name, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    if (await js(`!!(window.__ibDl && window.__ibDl[${JSON.stringify(name)}])`)) {
      const b64 = await js(`new Promise((res, rej) => { const fr = new FileReader();
        fr.onload = () => { const u = new Uint8Array(fr.result); let s = '';
          for (let i = 0; i < u.length; i += 0x1000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x1000));
          res(btoa(s)); };
        fr.onerror = () => rej(fr.error); Promise.resolve(window.__ibDl[${JSON.stringify(name)}]).then((b) => fr.readAsArrayBuffer(b), rej); })`);
      return Buffer.from(b64, 'base64');
    }
  }
  throw new Error('the page saved no ' + name + ' (saved: ' + (await js(`Object.keys(window.__ibDl || {}).join(' ')`)) + ')');
}

// Gives a local file to the page's <input type=file> matching css, as a
// Blob named like the file, and fires change (the page reads input.files).
async function setFile(agent, js, css, local) {
  const b64 = fs.readFileSync(local).toString('base64');
  await agent.raw(`window.__ibtUp = ''; document.documentElement.setAttribute('data-ibt', '1');`);
  for (let i = 0; i < b64.length; i += 60000) await agent.raw(`window.__ibtUp += '${b64.slice(i, i + 60000)}'; document.documentElement.setAttribute('data-ibt', '1');`);
  return js(`(() => { const s = atob(window.__ibtUp); window.__ibtUp = '';
    const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    const b = new Blob([u]); b.name = ${JSON.stringify(path.basename(local))};
    const input = document.querySelector(${JSON.stringify(css)});
    Object.defineProperty(input, 'files', { value: [b], configurable: true });
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true; })()`);
}

// IE's currentStyle gives "#rrggbb" (or a name); "transparent" is the
// window's white.
function darkOnLight(pair) {
  const lum = (c) => {
    const rgb = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(c || '');
    if (rgb) return rgb[4] === '0' ? 1 : (0.2126 * rgb[1] + 0.7152 * rgb[2] + 0.0722 * rgb[3]) / 255;
    const m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return c === 'transparent' || c === 'white' ? 1 : c === 'black' ? 0 : null;
    const n = parseInt(m[1], 16);
    return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  };
  const [fg, bg] = String(pair || '').split(' on ');
  return lum(fg) !== null && lum(bg) !== null && lum(fg) < 0.35 && lum(bg) > 0.8;
}

/* ---------- one run ---------- */

async function runIe(machine) {
  const started = Date.now();
  const remote = new Remote(machine);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const IE = BROWSER === 'ie';
  const bid = IE ? 'ie' : 'chromium';
  const t = new Checker({ prefix: `[${machine.name}/${bid}${DOCMODE ? ' docmode ' + DOCMODE : ''}] ` });
  const rec = { time: new Date().toISOString(), machine: machine.name, browser: bid, version: '', result: '', protocol: IE ? 'com' : 'cdp' };
  const detail = { ...rec, docmode: DOCMODE || 'edge', checks: t.checks };
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-ie-'));
  const dir = remote.dir('ie');
  const runDir = remote.dir('ie', 'run-' + crypto.randomBytes(3).toString('hex'));
  let agent = null;
  const finish = (result, why) => {
    rec.result = why ? `${result}: ${why}` : result;
    rec.seconds = Math.round((Date.now() - started) / 1000);
    return rec;
  };
  try {
    remote.mkdir(dir);
    remote.mkdir(runDir);
    const pageFile = testPage(tmpRoot);
    const pageName = path.basename(pageFile);
    const gen = /<meta name="generator" content="[^,"]*, ([^,"]+), ([^"]+)">/.exec(fs.readFileSync(PAGE, 'utf8').slice(0, 4000));
    rec.page = { rev: gen ? gen[1] : '', hash: pageName.replace(/^ibtest-|\.html$/g, '') };
    const have = remote.list(dir);
    if (!have.includes(pageName)) {
      for (const old of have.filter((f) => /^ibtest-.*\.html$/.test(f))) remote.removeFile(remote.dir('ie', old));
      remote.put(pageFile, remote.dir('ie', pageName));
    }
    if (IE) {
      remote.put(path.join(HERE, 'ie-agent.js'), remote.dir('ie', 'ie-agent.js'));
      // A stuck IE from an earlier run would take the COM request.
      remote.sh('taskkill /F /IM iexplore.exe');
      agent = new Agent(remote, remote.dir('ie', 'ie-agent.js'));
    } else {
      agent = await CdpAgent.start(remote, runDir + '\\profile');
    }
    rec.version = (await agent.ok('VERSION', 60000)).version;
    const pageUrl = remote.fileUrl(remote.dir('ie', pageName));

    // 1. Every IE: the page loads, the check says what it can do, the text reads.
    const navAt = Date.now();
    const nav = await agent.ok('NAV ' + pageUrl);
    detail.loadSeconds = Math.round((Date.now() - navAt) / 100) / 10;
    detail.documentMode = nav.documentMode;
    t.ok(nav.ready && nav.title === 'TiddlyInstall', 'the page loads from disk', JSON.stringify(nav));
    let dom = null;
    for (const end = Date.now() + 60000; Date.now() < end; await sleep(500)) {
      dom = await agent.ok('DOM');
      if (dom.ready === '1') break;
    }
    detail.dom = { ...dom, bodyText: dom.bodyText.slice(0, 1500) };
    // Scripts off (IE on Windows Server, Enhanced Security Configuration):
    // the <noscript> bar, and the static page.
    if (dom.ready !== '1' && !dom.errors && /JavaScript is off in this browser/.test(dom.bodyText)) {
      t.ok(true, 'scripts don\'t run here, and the <noscript> bar says so and what to do');
      t.ok(/Real installers for Windows, Linux and macOS/.test(dom.bodyText), 'the home page\'s text is there');
      const shownNs = dom.sections.filter((s) => /:shown$/.test(s));
      t.ok(shownNs.length === 1 && /^home:/.test(shownNs[0]), 'only the home section shows', dom.sections.join(' '));
      t.ok(darkOnLight(dom.colors && dom.colors.body), 'the text is dark on light', dom.colors && dom.colors.body);
      return finish(t.failed ? 'fail' : 'unsupported', 'scripts are off (Enhanced Security Configuration)');
    }
    t.ok(dom.ready === '1', 'the browser check runs (data-ib-ready)', JSON.stringify(dom).slice(0, 300));
    t.ok(dom.bar && dom.bar.shown, 'the compatibility bar shows', JSON.stringify(dom.bar));
    const barText = (dom.bar && dom.bar.text) || '';
    const canRun = dom.missing === '';
    if (!canRun) {
      t.ok(/can't run TiddlyInstall/.test(barText) && /ib-too-old/.test(dom.bar.className), 'the bar says this browser can\'t run the builder', barText);
      t.ok(/Tested on .* and working: |Please use /.test(barText), 'the bar names browsers to use instead', barText);
      t.ok(/pages still read/.test(barText), 'the bar says the pages still read', barText);
    } else {
      t.ok(/can run TiddlyInstall, with limits/.test(barText), 'the bar says this browser runs the builder, with limits', barText);
    }
    // The static page: its text, and only the home section showing.
    t.ok(/Real installers for Windows, Linux and macOS/.test(dom.bodyText), 'the home page\'s text is there', dom.bodyText.slice(0, 200));
    const shown = dom.sections.filter((s) => /:shown$/.test(s));
    t.ok(shown.length === 1 && /^home:/.test(shown[0]), 'only the home section shows (the others stay hidden)', dom.sections.join(' '));
    t.ok(darkOnLight(dom.colors && dom.colors.body), 'the text is dark on light', dom.colors && dom.colors.body);
    t.ok(!dom.errors, 'no script errors while loading', dom.errors);
    if (!canRun) {
      detail.missing = dom.missing;
      return finish(t.failed ? 'fail' : 'unsupported', t.failed ? t.checks.filter((c) => c.pass === false).map((c) => c.name).slice(0, 3).join('; ') : dom.missing);
    }

    // 2. IE 11: the ES5 copy starts.
    const js = makeJs(agent);
    let up = false;
    for (const end = Date.now() + 180000; Date.now() < end && !up; await sleep(1000)) {
      const r = await agent.raw(`document.documentElement.setAttribute('data-ibt', String(!!(window.ibLocalApi && document.readyState === 'complete' && document.querySelector('.save-ctl'))) + ' ' + String(window.IB_ES5));`);
      up = /^true /.test(r);
      detail.es5 = /true$/.test(r);
    }
    const errs = async () => { try { return await js('window.__ibErrors || []'); } catch (e) { return ['(could not read errors: ' + e.message + ')']; } };
    if (!up) {
      t.ok(false, 'the page starts (its ES5 copy)', (dom.errors || '') + ' ' + (await agent.ok('DOM')).errors);
      return finish('fail', 'the page did not start');
    }
    t.ok(detail.es5, 'the page runs its ES5 copy');
    detail.startSeconds = Math.round((Date.now() - navAt) / 100) / 10;   // loading, unpacking and starting the ES5 copy
    t.ok((await errs()).length === 0, 'the page starts without errors', (await errs()).join(' | '));
    t.ok(await js(`document.documentElement.classList.contains('ib-local')`), 'from disk, the page builds installers itself');

    await checkSections(t, js);
    await js(`location.hash = '#new&write'`);
    await sleep(500);
    const editor = await js(`(() => { const f = document.getElementById('new-form');
      f.elements.runtime.value = 'python'; f.elements.runtime.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('src-write').checked = true; document.getElementById('tpl-script').checked = true;
      document.getElementById('tpl-script').dispatchEvent(new Event('change', { bubbles: true }));
      const ta = f.querySelector('.combo-python-script textarea.code'); return !!ta && ta.offsetParent !== null; })()`);
    t.ok(editor, 'New installer: the code editor shows for Python + script (the :has() stand-in)');

    // 3. An installer built with no server, read back here.
    const job = await buildHello(js, { runtime: 'python', mode: 'unsigned', name: 'Hello IE', code: "print('hello from Internet Explorer')\n" });
    await checkJob(t, js, job, 'build', 'python');

    // 4. Save this page, and the saved copy starts.
    await js(CAPTURE);
    await js(`document.querySelector('.save-page').click()`);
    const html = await captured(js, 'tiddlyinstall.html', 60000).catch((e) => { t.ok(false, 'Save this page makes the page', e.message); return null; });
    if (html) {
      const head = html.toString('utf8', 0, 300);
      t.ok(html.length > 1e6 && head.startsWith('<!DOCTYPE html>'), 'Save this page makes the whole page', html.length + ' ' + head.slice(0, 80));
      t.ok(head.includes('saved from url=(0014)about:internet'), 'the saved page keeps the Mark of the Web (so IE runs it from disk)');
      const saved = path.join(tmpRoot, 'saved.html');
      fs.writeFileSync(saved, html);
      remote.put(saved, runDir + '\\saved.html');
      await agent.ok('NAV ' + remote.fileUrl(runDir + '\\saved.html'));
      let ok2 = false;
      for (const end = Date.now() + 180000; Date.now() < end && !ok2; await sleep(1000)) {
        ok2 = /^true/.test(await agent.raw(`document.documentElement.setAttribute('data-ibt', String(!!(window.ibLocalApi && document.querySelector('.save-ctl'))));`));
      }
      t.ok(ok2, 'the saved copy starts');
      if (ok2) {
        t.ok((await errs()).length === 0, 'the saved copy starts without errors', (await errs()).join(' | '));
        const again = await buildHello(js, { runtime: 'python', mode: 'unsigned', name: 'Hello again', code: "print('hello')\n", platforms: ['linux'] });
        await checkJob(t, js, again, 'saved copy', 'python');
      }
    }

    // 5. Signing: PGP (.run) and a .pfx (.exe), checked here. Without
    // secure random numbers the editor opens the installer but
    // offers no signing, and says why.
    const fx = await makeSignFixtures(tmpRoot);
    await agent.ok('NAV ' + pageUrl + '#edit');
    await waitUntil(js, STARTED, 'the page', 180000);
    await js(`location.hash = '#edit'`);
    await js(CAPTURE);
    if (await js(`ibCompat.status.random === 'missing'`)) {
      await setFile(agent, js, '#installer', fx.t('in.run'));
      const why = await waitUntil(js, `/getRandomValues/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'the editor to refuse signing', 60000).catch(() => '');
      t.ok(/getRandomValues/.test(why) && await js(`document.getElementById('sign-run').hidden && document.getElementById('sign-go').hidden`),
        'no secure random numbers: the editor opens the installer, offers no signing, and says why', why);
      t.ok((await errs()).length === 0, 'no page errors', (await errs()).join(' | '));
      return finish(t.failed ? 'fail' : 'partial', 'ES5 copy; builds, no signing (no crypto.getRandomValues)');
    }
    await setFile(agent, js, '#installer', fx.t('in.run'));
    await waitUntil(js, `!document.getElementById('sign-run').hidden`, 'the Linux sign panel');
    await setVal(js, 'pgp-uid', 'IE Test TEST <ie@example.invalid>');
    const makeKey = async (type) => {
      await setVal(js, 'pgp-type', type);
      await js(`document.getElementById('pgp-status').textContent = ''`);
      await js(`document.getElementById('pgp-make').click()`);
      return waitUntil(js, `/New key|rror|can't|Couldn/.test(${$text('pgp-status')}) && ${$text('pgp-status')}`, 'the key', 600000);
    };
    const keyType = 'ed25519';
    const t0 = Date.now();
    const st = await makeKey(keyType);
    detail.keySeconds = Math.round((Date.now() - t0) / 1000);
    t.ok(/New key/.test(st), `PGP: the page makes an ${keyType} key (${detail.keySeconds} s)`, st);
    if (/New key/.test(st)) {
      await js(`document.getElementById('pgp-pub-dl').click()`);
      await setVal(js, 'out-name', 'app.run');
      await js(`document.getElementById('sign-go').click()`);
      const s = await waitUntil(js, `/Saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, 'PGP signing', 600000);
      t.ok(/Saved/.test(s), 'PGP: signing says saved', s);
      const pubName = await js(`Object.keys(window.__ibDl).filter((n) => /\\.pub\\.asc$/.test(n))[0] || ''`);
      const files = { pub: await captured(js, pubName), run: await captured(js, 'app.run'), asc: await captured(js, 'app.run.asc') };
      for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(tmpRoot, 'pgp.' + k), v);
      const g = gpgVerify(path.join(tmpRoot, 'pgp.pub'), path.join(tmpRoot, 'pgp.asc'), path.join(tmpRoot, 'pgp.run'), path.join(tmpRoot, 'gnupg'), spawnSync);
      t.ok(g.ok, `PGP (${keyType}): gpg --verify says Good signature for the saved .run.asc`, g.out);
      const back = await readInstaller(new Uint8Array(files.run), 'app.run');
      t.ok(back.record === fx.RECORD, 'PGP: the signed .run keeps its record');
    }
    await setFile(agent, js, '#installer', fx.t('in.exe'));
    await waitUntil(js, `!document.getElementById('sign-exe').hidden`, 'the Windows sign panel');
    if (await js(`!!document.getElementById('ts-on')`)) await checkBox(js, 'ts-on', false);
    await setFile(agent, js, '#pfx-file', fx.t('rsa.pfx'));
    await setVal(js, 'pfx-pass', fx.PW);
    await js(`document.getElementById('pfx-open').click()`);
    const ps = await waitUntil(js, `/Signs as|rror|Wrong|can't|Couldn/.test(${$text('pfx-status')}) && ${$text('pfx-status')}`, 'the .pfx', 300000);
    t.ok(/Signs as/.test(ps), '.pfx: the page opens the RSA .pfx', ps);
    if (/Signs as/.test(ps)) {
      await setVal(js, 'out-name', 'pfx.exe');
      await js(`document.getElementById('sign-go').click()`);
      const s = await waitUntil(js, `/Signed and saved|Couldn/.test(${$text('sign-status')}) && ${$text('sign-status')}`, '.pfx signing', 600000);
      t.ok(/Signed and saved/.test(s), '.pfx: signing says done', s);
      const exe = await captured(js, 'pfx.exe');
      fs.writeFileSync(path.join(tmpRoot, 'pfx.exe'), exe);
      const v = osslVerify(path.join(tmpRoot, 'pfx.exe'), fx.t('rsa.crt'), spawnSync);
      if (v.skip) t.note('.pfx', 'osslsigncode not found here; signature not checked');
      else t.ok(v.ok, '.pfx: the signed .exe passes osslsigncode verify', v.out);
    }
    t.ok((await errs()).length === 0, 'no page errors while signing', (await errs()).join(' | '));
    // "ES5 copy" in the result: web/browser-check.js suggests only browsers
    // that pass on the page's own ES2017 code.
    return finish(t.failed ? 'fail' : 'pass', t.failed ? t.checks.filter((c) => c.pass === false).map((c) => c.name).slice(0, 3).join('; ') : detail.es5 ? 'ES5 copy' : '');
  } catch (e) {
    t.checks.push({ name: 'run', pass: false, detail: String(e.stack || e).slice(0, 1500) });
    console.log(`[${machine.name}/${bid}] ERROR ${e.stack || e}`);
    return finish(/^(agent|scp)/.test(e.message) ? 'error' : 'fail', e.message.split('\n')[0].slice(0, 300));
  } finally {
    if (agent) await agent.quit();
    if (BROWSER === 'ie') remote.sh('taskkill /F /IM iexplore.exe');
    remote.remove(runDir);
    if (flag('--keep')) console.log('kept ' + tmpRoot); else fs.rmSync(tmpRoot, { recursive: true, force: true });
    Object.assign(detail, rec, { checks: t.checks });
    fs.mkdirSync(RESULTS, { recursive: true });
    const f = path.join(RESULTS, `${stamp}-${machine.name}-${bid}${DOCMODE ? '-docmode' + DOCMODE : ''}.json`);
    fs.writeFileSync(f, JSON.stringify(detail, null, 1) + '\n');
    rec.details = path.relative(HERE, f);
  }
}

/* ---------- --classic: the server's plain-HTML form ---------- */

// A JavaScript string literal, ASCII (the agent sends ASCII only).
const lit = (v) => JSON.stringify(String(v)).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

async function runClassic(machine, base) {
  const started = Date.now();
  const remote = new Remote(machine);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const mode = arg('--mode', 'ours');
  const t = new Checker({ prefix: `[${machine.name}/ie classic] ` });
  const rec = { time: new Date().toISOString(), machine: machine.name, browser: 'ie', version: '', result: '', protocol: 'com', classic: base, mode };
  const dir = remote.dir('ie');
  let agent = null;
  // IE asks before it sends a form unencrypted from the Internet zone when
  // the zone's "Submit non-encrypted form data" (1601) is "Prompt" (1): a
  // person answers Yes (and can tick "don't ask again"); hidden, over COM,
  // nobody can, and IE drops the post. So for the run it is "Enable" (0),
  // and put back afterwards.
  const ZONE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Zones\\3';
  const was = /1601\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(remote.sh(`reg query "${ZONE}" /v 1601`).out);
  rec.zone1601 = was ? Number.parseInt(was[1], 16) : null;
  try {
    if (rec.zone1601 !== 0) remote.sh(`reg add "${ZONE}" /v 1601 /t REG_DWORD /d 0 /f`);
    remote.mkdir(dir);
    remote.put(path.join(HERE, 'ie-agent.js'), remote.dir('ie', 'ie-agent.js'));
    remote.sh('taskkill /F /IM iexplore.exe');
    agent = new Agent(remote, remote.dir('ie', 'ie-agent.js'));
    rec.version = (await agent.ok('VERSION', 60000)).version;
    const nav = await agent.ok('NAV ' + base + '/classic');
    rec.documentMode = nav.documentMode;
    t.ok(nav.ready && /^New installer - TiddlyInstall$/.test(nav.title), 'IE opens the simple form over plain HTTP', JSON.stringify(nav));
    const dom = await agent.ok('DOM');
    t.ok(/Signed by TiddlyInstall/.test(dom.bodyText) && /Build for/.test(dom.bodyText), 'the form reads', dom.bodyText.slice(0, 300));
    t.ok(darkOnLight(dom.colors && dom.colors.body), 'the text is dark on light', dom.colors && dom.colors.body);
    t.ok(nav.documentMode >= 7, 'standards mode (not quirks)', nav.documentMode);
    // Fill it as a person would (ES3: IE 8 runs this), then press the button.
    const label = machine.name + ' IE' + String(rec.version).split('.')[0] + ' ' + crypto.randomBytes(2).toString('hex');
    const f = classicFields(label, mode);
    const filled = await agent.raw(`var f = document.forms[0], e = f.elements;
      e['app_name'].value = ${lit(f.app_name)}; e['source'].value = ${lit(f.source)}; e['launch'].value = ${lit(f.launch)};
      var rt = e['runtime']; for (var i = 0; i < rt.options.length; i++) if (rt.options[i].value === ${lit(f.runtime)}) rt.selectedIndex = i;
      var m = e['mode']; for (i = 0; i < m.length; i++) m[i].checked = m[i].value === ${lit(f.mode)};
      e['target_macos'].checked = false;
      document.documentElement.setAttribute('data-ibt', f.method + ' ' + f.enctype + ' ' + f.action + ' ' + rt.value);`);
    t.ok(/^post multipart\/form-data .*\/submit python$/.test(filled), 'the form is filled (post, multipart, to /submit)', filled);
    await agent.raw(`var ins = document.getElementsByTagName('input');
      for (var i = 0; i < ins.length; i++) if (ins[i].type === 'submit') { ins[i].click(); break; }
      document.documentElement.setAttribute('data-ibt', 'clicked');`);
    // Follow the status page: IE reloads it itself; read it now and then.
    let status = null, seen = [], statusUrl = '', hrefs = null;
    for (const end = Date.now() + 600000; Date.now() < end; await sleep(1500)) {
      let r;
      try {
        r = await agent.raw(`var d = document, s = '';
          var as = d.getElementsByTagName('a'), dl = [];
          for (var i = 0; i < as.length; i++) if (as[i].href.indexOf('/dl/') >= 0) dl.push(as[i].href);
          var st = d.getElementsByTagName('td');
          d.documentElement.setAttribute('data-ibt', location.href + '\x02' + d.readyState + '\x02' + (st.length ? (st[0].innerText || '') : '') + '\x02' + dl.join(' ') + '\x02' + (d.getElementsByTagName('meta').length));`);
      } catch (e) { continue; }   // between pages
      const [href, ready, st, links] = r.split('\x02');
      if (/\/classic$/.test(href) && Date.now() - started > 120000 && !statusUrl) { seen.push('still on the form: ' + st); break; }
      if (!/\/status\/j_/.test(href) || ready !== 'complete') { if (href && seen[seen.length - 1] !== href) seen.push(href); continue; }
      statusUrl = href;
      if (seen[seen.length - 1] !== st) seen.push(st);
      if (/^(Done|Failed)$/.test(st)) { status = st; hrefs = links ? links.split(' ') : []; break; }
    }
    rec.statuses = seen;
    t.ok(!!statusUrl, 'the submit lands on the status page', statusUrl);
    t.ok(status === 'Done', 'IE follows the status page until the build is done', seen.join(' -> '));
    if (status === 'Done') {
      // IE's own view of the finished page: links, no errors.
      const errs = (await agent.ok('DOM')).errors;
      t.ok(!errs, 'no script errors', errs);
      const st = await checkFinished(t, statusUrl, { hrefs, name: f.app_name, modeLetter: MODE_LETTER[mode], out: arg('--out', null) });
      rec.record = st.record;
      rec.files = st.files.map((x) => x.name);
    }
    rec.result = t.failed ? 'fail: ' + t.checks.filter((c) => c.pass === false).map((c) => c.name).slice(0, 3).join('; ') : 'pass';
  } catch (e) {
    t.checks.push({ name: 'run', pass: false, detail: String(e.stack || e).slice(0, 1500) });
    console.log(`[${machine.name}/ie classic] ERROR ${e.stack || e}`);
    rec.result = 'error: ' + e.message.split('\n')[0].slice(0, 300);
  } finally {
    if (agent) await agent.quit();
    remote.sh('taskkill /F /IM iexplore.exe');
    if (rec.zone1601 === null) remote.sh(`reg delete "${ZONE}" /v 1601 /f`);
    else if (rec.zone1601 !== 0) remote.sh(`reg add "${ZONE}" /v 1601 /t REG_DWORD /d ${rec.zone1601} /f`);
    const now = /1601\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(remote.sh(`reg query "${ZONE}" /v 1601`).out);
    t.ok((now ? Number.parseInt(now[1], 16) : null) === rec.zone1601, 'the zone setting is put back', now && now[0]);
    rec.seconds = Math.round((Date.now() - started) / 1000);
    fs.mkdirSync(RESULTS, { recursive: true });
    const file = path.join(RESULTS, `${stamp}-${machine.name}-ie-classic.json`);
    fs.writeFileSync(file, JSON.stringify({ ...rec, checks: t.checks }, null, 1) + '\n');
    rec.details = path.relative(HERE, file);
  }
  return rec;
}

async function main() {
  const machines = loadMachines();
  if (arg('--classic', '')) {
    const m = findMachine(machines, arg('--machine', ''));
    if (!m || m.os !== 'windows') { console.log('usage: node tests/browsers/ie.mjs --machine xp|vista|... --classic http://10.0.1.76:8080 [--mode ours|yours|unsigned] [--out DIR]'); process.exit(2); }
    const rec = await runClassic(m, arg('--classic').replace(/\/+$/, ''));
    console.log(`<-- ${m.name}/ie ${rec.version} classic: ${rec.result} (${rec.seconds}s)`);
    process.exit(rec.result === 'pass' ? 0 : 1);
  }
  const m = findMachine(machines, arg('--machine', ''));
  if (!m || m.os !== 'windows' || !/^(ie|chromium49)$/.test(BROWSER)) { console.log('usage: node tests/browsers/ie.mjs --machine xp|vista|7|8.1|2022 [--docmode N] [--browser ie|chromium49]'); process.exit(2); }
  if (!fs.existsSync(PAGE)) { console.log('no page at ' + PAGE + '; build it: python3 tools/build_site.py'); process.exit(2); }
  const rec = await runIe(m);
  if (!DOCMODE && !flag('--no-record')) {
    fs.appendFileSync(USAGE, JSON.stringify(rec) + '\n');
    writeCompat();
  }
  console.log(`<-- ${m.name}/${rec.browser} ${rec.version}${DOCMODE ? ' (document mode ' + DOCMODE + ')' : ''}: ${rec.result} (${rec.seconds}s)`);
  process.exit(/^(pass|unsupported)/.test(rec.result) ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) await main();
