// What every template's plan must say, checked here rather than on a VM.
//
//   node tests/templates/plan-test.mjs [--only python/tray,php] [--show N]
//
// tests/templates/run.py finds these things by installing on the test
// machines, which takes hours and needs the right machine to exist (a
// German Windows with a space in the user's name, a Windows XP, an Ubuntu
// 14.04). The rules below are the same failures read off the plan: each one
// is a bug that got to a VM once (docs/test-results.md, "Failures, by
// cause", 2026-09-20), so a plan that breaks one again fails here first.
//
// The plans are resolved from the templates the way the New installer page
// makes them (shared/templates.js -> form.mjs -> shared/form-job.js), against the
// catalogue in ~/projects/installer-builder-runtimes and server/policy.json.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from '../../shared/templates.js';
import { formFor } from './form.mjs';
import { jobFromForm } from '../../shared/form-job.js';
import { projectInstall } from '../../shared/builder.js';
import { loadCatalog } from '../../server/lib/catalog.js';
import { resolve } from '../../shared/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const ONLY = arg('--only', '').split(',').filter(Boolean);
const PLATFORMS = ['windows', 'linux', 'macos'];

const home = os.homedir();
const cat = loadCatalog({
  dir: path.join(home, 'projects/installer-builder-runtimes/catalog'),
  policyPath: path.join(REPO, 'server/policy.json'),
  localRoot: path.join(home, 'projects/installer-builder-runtimes'),
  cachePath: path.join(REPO, 'server/data/sha-cache.json'),
});
const policy = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(REPO, 'server/policy.json'), 'utf8'));

// One [target] block of a plan, as lines by key.
function blocks(plan) {
  const out = [];
  let cur = null;
  for (const line of plan.split('\n')) {
    if (line === '[target]') { cur = { when: '', lines: [] }; out.push(cur); continue; }
    if (!cur || line === '') continue;
    const [key, ...vals] = line.split('\t');
    if (key === 'when') cur.when = vals.join(' ');
    cur.lines.push({ key, vals });
  }
  return out;
}
const family = (b) => b.when.split(' ')[0];
const osInt = (b) => Number(b.when.split(' ')[1] || 0);
const lines = (b, key) => b.lines.filter((l) => l.key === key);
const one = (b, key) => (lines(b, key)[0] || { vals: [] }).vals.join('\t');
// Python 3.4.4, the newest that runs on Windows XP, from "runtime python 3.4.4".
const runtimeVersion = (b) => (lines(b, 'runtime')[0] || { vals: [] }).vals[1] || '';
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
};

// ---------------------------------------------------------------- the rules

// Each rule: (key, block, plan) -> a problem to report, or ''. `key` is
// "<runtime>/<template>".
const RULES = [
  // Windows 11 (the operator's PC), Python 2 window: a machine-wide
  // TCL_LIBRARY (CSR BlueSuite sets one) sent Python 2's Tcl 8.5 to the
  // wrong folder. Every build we ship carries its own Tcl/Tk.
  ['a stray TCL_LIBRARY must not reach a Python app', (key, b) => {
    if (!key.startsWith('python')) return '';
    const unset = lines(b, 'unset').map((l) => l.vals[0]);
    const missing = ['TCL_LIBRARY', 'TK_LIBRARY'].filter((v) => !unset.includes(v) && !lines(b, 'env').some((l) => l.vals[0] === v));
    return missing.length ? 'the block neither sets nor unsets ' + missing.join(' and ') : '';
  }],

  // Windows XP, every app with a requirements.txt: pip 1.5.6 (what
  // ensurepip gives Python 3.4.4) knows neither flag and stops with "no
  // such option".
  ['pip flags must exist in the pip that Python version has', (key, b) => {
    if (!key.startsWith('python/')) return '';
    const v = runtimeVersion(b);
    const inst = one(b, 'install');
    if (!v || !inst.includes('-m pip install')) return '';
    const bad = [];
    if (cmpVer(v, '3.5') < 0 && inst.includes('--no-warn-script-location')) bad.push('--no-warn-script-location (pip 8)');
    if (cmpVer(v, '3.5') < 0 && inst.includes('--disable-pip-version-check')) bad.push('--disable-pip-version-check (pip 6)');
    return bad.length ? `Python ${v}'s pip doesn't know ` + bad.join(', ') : '';
  }],

  // Windows 11 German: WinLibs GCC's link spec names default-manifest.o by
  // its absolute path, unquoted, so a space in the path breaks every link
  // (C/C++ directly, Rust and Nim through the same gcc).
  ['a WinLibs GCC must deal with a space in its own path', (key, b) => {
    if (family(b) !== 'windows') return '';
    const files = lines(b, 'file').map((l) => l.vals[1] || '');
    if (!files.some((f) => /^winlibs-/.test(f))) return '';
    const runs = lines(b, 'run').concat(lines(b, 'step').filter((l) => l.vals[0] === 'run'));
    return runs.some((l) => l.vals.join('\t').includes('default-manifest.o'))
      ? '' : 'the block unpacks WinLibs GCC but never deals with default-manifest.o';
  }],

  // Windows 11 German: PHP reads php.ini in the machine's ANSI code page,
  // so a path with non-ASCII letters can't be written into it correctly by
  // anything we have (cmd's echo writes the OEM code page, the write step
  // UTF-8). php.ini must stay ASCII: no install path in it.
  ['php.ini must not carry an install path', (key, b) => {
    if (family(b) !== 'windows') return '';
    const bad = [];
    for (const l of lines(b, 'step')) {
      const [kind, ...rest] = l.vals;
      const text = rest.join('\t');
      if (!/php\.ini/.test(text)) continue;
      if (kind === 'write' && /^[A-Za-z]:\\|\{(app|data|runtime|tmp)_dir\}/.test(rest[1] || '')) bad.push(rest[1]);
      if (kind === 'run' && />>?"?[^"]*php\.ini"? echo .*(\{(app|data|runtime|tmp)_dir\}|[A-Za-z]:\\)/.test(text)) bad.push(text);
    }
    return bad.length ? 'a php.ini line holds a path: ' + bad[0] : '';
  }],

  // Windows 11, 11 (de) and Server 2022, Electron tray: @electron/get
  // cached its 158 MB zip in %LOCALAPPDATA%\electron, which the uninstall
  // left behind.
  ['a package manager must cache inside the app', (key, b) => {
    if (one(b, 'install') === '' || !key.startsWith('node/')) return '';
    if (!(TEMPLATES[key.split('/')[0]][key.split('/')[1]].needs || []).includes('electron')) return '';
    const ienv = new Map(lines(b, 'ienv').concat(lines(b, 'env')).map((l) => [l.vals[0], l.vals[1] || '']));
    const bad = ['ELECTRON_CACHE', 'electron_config_cache'].filter((v) => !/\{data_dir\}|\{app_dir\}/.test(ienv.get(v) || ''));
    return bad.length ? bad.join(' and ') + " don't point inside the app's folders" : '';
  }],

  // Every block: what the engine will run must fit the format's line limit
  // (docs/format.md section 1), whatever the install path adds to it.
  ['plan lines must leave room for a long install path', (key, b) => {
    for (const l of b.lines) {
      const text = [l.key, ...l.vals].join('\t');
      const grown = text.length + 120 * (text.split('{runtime_dir}').length - 1 + text.split('{app_dir}').length - 1);
      if (grown > 1000) return `${l.key} line is ${text.length} bytes and grows past 1000 with a long install path`;
    }
    return '';
  }],
];

// ---------------------------------------------------------------- run

let checked = 0, failed = 0;
for (const rt of Object.keys(TEMPLATES)) {
  for (const id of Object.keys(TEMPLATES[rt])) {
    const key = rt + '/' + id;
    if (ONLY.length && !ONLY.includes(key) && !ONLY.includes(rt)) continue;
    const t = TEMPLATES[rt][id];
    const platforms = (t.platforms || PLATFORMS).filter((p) => PLATFORMS.includes(p));
    const { job, problems } = jobFromForm(formFor(rt, id, platforms), { icon: { choice: 'default' } });
    if (problems && problems.length) { console.log(`FAIL ${key}: the form says ${problems.join('; ')}`); failed++; continue; }
    const pol = policy.runtimes[job.runtime];
    const install = projectInstall(pol, job.install, null, Object.keys(t.files));
    const app = {
      recordHash: 'plan-test', name: job.name, project: 'app', runtime: job.runtime,
      select: job.select, range: job.range || '', launch: job.launch, install,
      console: job.console !== false, menu: true, desktop: false, root: 'user', rootName: 'ib',
      platforms, source: { name: 'src.tar.gz', sha256: '0'.repeat(64), size: 1, format: 'tar.gz', strip: 1, urls: ['https://example/src.tar.gz'] },
      package: '', packageVersion: '', prerequisites: job.prerequisites || [],
    };
    let plan;
    try { plan = resolve(cat, app); } catch (e) { console.log(`FAIL ${key}: resolve: ${e.message}`); failed++; continue; }
    for (const b of blocks(plan)) {
      if (lines(b, 'fail').length) continue;   // "nothing runs here" blocks
      for (const [name, rule] of RULES) {
        checked++;
        let why = '';
        try { why = rule(key, b, plan) || ''; } catch (e) { why = 'the rule threw: ' + e.message; }
        if (why) {
          failed++;
          console.log(`FAIL ${key} [${b.when}] ${name}: ${why}`);
        }
      }
    }
  }
}
console.log(`${checked} checks over the templates' plan blocks, ${failed} failed`);
process.exit(failed ? 1 : 0);
