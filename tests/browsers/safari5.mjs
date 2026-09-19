// Safari 5.1.7 for Windows (Apple's last Windows build, 2012) and the
// page's graceful failure: it can't run the builder, so what matters is that
// the page reads and its compatibility bar says so and recommends a browser
// that works (js/browser-check.js). No driver exists for it, and it has no
// COM automation, so the page copy carries a small ES3 reporter
// (safari5/reporter.js) that sends what it finds, 5 and 20 seconds after
// loading, as image requests to 127.0.0.1:38517, where ibcollect.exe
// (safari5/ibcollect.cs, compiled on the machine with the .NET Framework's
// csc) logs them. Safari runs in the SSH session (safari5/drive.cmd), on its
// hidden desktop: no screenshot is possible there.
//
//   node tests/browsers/safari5.mjs [--machine xp] [--page dist/index.html] [--seconds 35] [--no-record]
//
// Safari is installed from Apple's own SafariSetup.exe (docs/test-vms.md):
// Safari.msi only, out of the installer's cabinet. On Windows 7 it crashes
// at start (0xC0000005 in JIT code: DEP is AlwaysOn there); XP (DEP OptIn)
// runs it. Results go to usage.jsonl as browser "safari", and results/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadMachines, findMachine, Remote } from './remote.mjs';
import { Checker } from './steps.mjs';
import { writeCompat } from './compat.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const flag = (k) => argv.includes(k);
const PAGE = path.resolve(arg('--page', path.join(ROOT, 'dist', 'index.html')));
const SECONDS = Number(arg('--seconds', 35));
const DIR = 'C:\\ibbrowsers\\safari-5.1.7';

// The beacons: "GET /r?k=<key>&n=<chunk>&q=<seq>&v=<value> HTTP/1.1" lines.
function parseBeacons(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const m = /^GET \/r\?(\S+) HTTP/.exec(line.trim());
    if (!m) continue;
    const q = new URLSearchParams(m[1]);
    const k = q.get('k');
    (out[k] = out[k] || []).push([Number(q.get('n')), q.get('v') || '']);
  }
  const joined = {};
  for (const [k, parts] of Object.entries(out)) joined[k] = parts.sort((a, b) => a[0] - b[0]).map((p) => p[1]).join('');
  return joined;
}

function fields(v) {
  const o = {};
  for (const line of String(v || '').split('\n')) { const i = line.indexOf('='); if (i > 0) o[line.slice(0, i)] = line.slice(i + 1); }
  return o;
}

// WCAG contrast of "rgb(a, b, c)" text on "rgb(...)" background.
function contrast(fg, bg) {
  const rgb = (s) => (/rgba?\(([^)]*)\)/.exec(s || '') || [0, '0,0,0'])[1].split(',').map(Number);
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

async function main() {
  const machines = loadMachines();
  const m = findMachine(machines, arg('--machine', 'xp'));
  if (!m || m.os !== 'windows') { console.log('a Windows machine, please'); process.exit(2); }
  const remote = new Remote(m);
  const t = new Checker({ prefix: `[${m.name}/safari] ` });
  const rec = { time: new Date().toISOString(), machine: m.name, browser: 'safari', version: '5.1.7', result: '', protocol: 'beacon' };
  const detail = { ...rec, checks: t.checks };
  const started = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

  // The page copy, with the reporter first in <head>.
  const html = fs.readFileSync(PAGE, 'utf8');
  const gen = /<meta name="generator" content="[^,"]*, ([^,"]+), ([^"]+)">/.exec(html.slice(0, 4000));
  const reporter = fs.readFileSync(path.join(HERE, 'safari5', 'reporter.js'), 'utf8');
  const copy = html.replace(/<head>/i, () => '<head>\n<script>' + reporter + '</script>');
  const hash = crypto.createHash('sha256').update(copy).digest('hex').slice(0, 12);
  rec.page = { rev: gen ? gen[1] : '', hash };
  const tmp = fs.mkdtempSync(path.join(HERE, '.safari5-'));
  try {
    const local = path.join(tmp, `ibsafari5-${hash}.html`);
    fs.writeFileSync(local, copy);
    const remotePage = remote.dir('work', path.basename(local));
    remote.put(local, remotePage);
    // The helpers, compiled there if they aren't yet.
    remote.put(path.join(HERE, 'safari5', 'drive.cmd'), DIR + '\\drive.cmd');
    if (!remote.list(DIR).includes('ibcollect.exe')) {
      remote.put(path.join(HERE, 'safari5', 'ibcollect.cs'), DIR + '\\ibcollect.cs');
      const c = remote.sh(`cmd /c "cd /d ${DIR} & %SystemRoot%\\Microsoft.NET\\Framework\\v2.0.50727\\csc.exe /nologo /out:ibcollect.exe ibcollect.cs"`);
      if (!remote.list(DIR).includes('ibcollect.exe')) throw new Error('driver: could not compile ibcollect.exe: ' + (c.out + c.err).slice(0, 300));
    }
    const log = remote.dir('work', 'safari5-beacons.txt');
    const r = remote.sh(`cmd /c ${DIR}\\drive.cmd ${remote.fileUrl(remotePage)} ${SECONDS} ${log}`, { timeout: (SECONDS + 120) * 1000 });
    const alive = /Safari\.exe/i.test(r.out.split('@SAFARI')[1]?.split('@BEACONS')[0] || '');
    const b = parseBeacons(r.out.split('@BEACONS')[1] || '');
    remote.removeFile(remotePage);
    remote.removeFile(log);
    detail.beacons = b;
    detail.userAgent = b.start || '';

    if (!b.start) {
      // Safari never ran the page: ask the event log why (Vista and later).
      const ev = remote.sh('wevtutil qe Application /c:2 /rd:true /f:text /q:"*[System[Provider[@Name=\'Application Error\']]]"');
      // Newest first: a crash logs 0xc0000005 (access violation), then
      // 0xc000041d (it escaped a callback).
      const codes = [...ev.out.matchAll(/Faulting application name: Safari\.exe[\s\S]*?Exception code: (0x[0-9a-f]+)/gi)].map((x) => x[1].toLowerCase()).reverse().join(', ');
      const dep = remote.sh('wmic OS Get DataExecutionPrevention_SupportPolicy /value').out;
      const always = /SupportPolicy=1/.test(dep);
      detail.eventLog = ev.out.slice(0, 1500);
      t.ok(false, 'Safari starts and runs the page\'s scripts', alive ? 'no report from the page' : 'Safari exited' + (codes ? ' (Application Error, ' + codes + ')' : ''));
      rec.result = 'error: Safari ' + (alive ? 'sent no report' : 'crashed at start' + (codes ? ' (' + codes + (always ? '; DEP is AlwaysOn here' : '') + ')' : ''));
      return;
    }
    t.ok(true, 'Safari starts and runs the page\'s scripts');
    const s = fields(b['state-20s'] || b['state-5s']);
    detail.state = s;
    t.ok(s.ready === '1', 'the startup check finishes (data-ib-ready)', s.ready);
    t.ok(!!s.missing && s.missing !== 'null', 'the startup check finds what this browser lacks', s.missing);
    t.ok(/\bib-too-old\b/.test(s.bar) && /^[1-9]\d*x[1-9]/.test(s.barbox || ''), 'the compatibility bar shows, marked too old', s.bar + ' ' + s.barbox);
    t.ok(/can't run TiddlyInstall/.test(s.bartext || ''), 'the bar says this browser can\'t run the builder', s.bartext);
    t.ok(/ -> https:\/\//.test(s.barlinks || ''), 'the bar links a browser to use instead', s.barlinks);
    t.ok(/home:shown/.test(s.pages || '') && !/(new|edit|bases|runtimes):shown/.test(s.pages || ''), 'one section shows: home', s.pages);
    const bodyLen = Number((/^(\d+) chars/.exec(s.body || '') || [0, 0])[1]);
    t.ok(bodyLen > 1000 && s.h1 && s.h1 !== 'none', 'the page\'s text is there to read', s.body);
    let [fg, bg] = (/chars, (rgba?\([^)]*\)) on (rgba?\([^)]*\))/.exec(s.body || '') || []).slice(1);
    // A transparent body shows the html element's background, or else the
    // canvas's: white.
    const clear = (c) => !c || /rgba\([^)]*,\s*0\)$/.test(c) || c === 'transparent';
    if (clear(bg)) bg = clear(s.htmlbg) ? 'rgb(255, 255, 255)' : s.htmlbg;
    const cr = contrast(fg, bg);
    t.ok(cr >= 4.5, 'the text is dark on light (contrast 4.5:1 or more)', `${fg} on ${bg}: ${cr.toFixed(1)}:1`);
    t.ok(!s.errors, 'the page throws no errors', s.errors);
    rec.result = t.failed ? 'fail: ' + t.checks.filter((c) => c.pass === false).map((c) => c.name).slice(0, 3).join('; ') : 'unsupported: ' + s.missing;
  } catch (e) {
    t.checks.push({ name: 'run', pass: false, detail: String(e.stack || e).slice(0, 1500) });
    rec.result = (/^driver|scp|timeout/i.test(e.message) ? 'error: ' : 'fail: ') + e.message.split('\n')[0].slice(0, 300);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    rec.seconds = Math.round((Date.now() - started) / 1000);
    Object.assign(detail, rec, { checks: t.checks });
    console.log(`<-- ${m.name}/safari 5.1.7: ${rec.result}`);
    if (!flag('--no-record')) {
      fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
      const f = path.join(HERE, 'results', `${stamp}-${m.name}-safari5.json`);
      fs.writeFileSync(f, JSON.stringify(detail, null, 1) + '\n');
      rec.details = path.relative(HERE, f);
      fs.appendFileSync(path.join(HERE, 'usage.jsonl'), JSON.stringify(rec) + '\n');
      writeCompat();
    }
  }
}

await main();
