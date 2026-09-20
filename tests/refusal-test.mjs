// Combinations the catalogue refuses up front, and -- the half that goes
// wrong -- the ones it must not (docs/format.md, "Combinations that cannot
// work").
//
//   node tests/refusal-test.mjs [-catalog DIR] [-local DIR] [-policy FILE]
//
// Two refusals live in backend/policy.json today:
//
//   R before 4.0 on Windows, for an app that installs something. CRAN
//   retired the Windows package index for every R below 4.0, so
//   install.packages() warns, installs nothing and exits 0 -- the install
//   "succeeds" and the app dies at its first library(). A runtime
//   `unsupported` rule turns that into the block's `fail`.
//
//   Python 2 on Windows with a %TEMP% that is not ASCII, for an app that
//   installs something. Its pip joins that path as bytes and raises
//   UnicodeDecodeError. A `need` with an `ascii` check and no way to
//   install it stops the install with its `nhow`.
//
// Each is asserted where it must fire and, at greater length, where it
// must not: the other OSes, the versions that are fine, the same runtime
// with nothing to install, and every other runtime.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../backend/lib/catalog.js';
import { resolve } from '../js/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = path.join(os.homedir(), 'projects/installer-builder-runtimes');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const cat = loadCatalog({
  dir: arg('-catalog', path.join(RUNTIMES, 'catalog')),
  policyPath: arg('-policy', path.join(REPO, 'backend/policy.json')),
  localRoot: arg('-local', RUNTIMES),
  cachePath: path.join(REPO, 'backend/data/sha-cache.json'),
});

let fails = 0;
const ok = (cond, what) => {
  if (!cond) {
    fails++;
    console.log('FAIL  ' + what);
  } else if (process.argv.includes('-v')) {
    console.log('ok    ' + what);
  }
};

// One plan, as [target] blocks of {when, family, lines: [[key, ...vals]]}.
function plan(opts) {
  const pol = (cat.policy.runtimes || {})[opts.runtime] || {};
  const text = resolve(cat, {
    recordHash: 'testtesttesttesttesttestte',
    name: 'Hello',
    project: 'hello',
    runtime: opts.runtime,
    select: opts.range ? 'range' : 'newest',
    range: opts.range || '',
    launch: pol.launch || 'x',
    console: true,
    platforms: [opts.os],
    install: opts.install || '',
    package: opts.package || '',
  });
  const out = [];
  let cur = null;
  for (const line of text.split('\n')) {
    if (line === '[target]') { cur = { when: '', lines: [] }; out.push(cur); continue; }
    if (!cur || line === '') continue;
    const [key, ...vals] = line.split('\t');
    if (key === 'when') cur.when = vals.join(' ');
    cur.lines.push([key, ...vals]);
  }
  return out;
}
const has = (b, key) => b.lines.some((l) => l[0] === key);
const val = (b, key) => (b.lines.find((l) => l[0] === key) || []).slice(1).join('\t');
// A block that resolved to a build, rather than one the catalogue has
// nothing for: only those can be refused, and only those prove anything.
const real = (bs) => bs.filter((b) => has(b, 'runtime') || (has(b, 'fail') && !/^No |has been withdrawn/.test(val(b, 'fail'))));
const cranFail = (b) => has(b, 'fail') && /CRAN/.test(val(b, 'fail'));
const asciiNeed = (b) => b.lines.some((l) => l[0] === 'need' && l[1] === 'ascii-temp');

// ---------------------------------------------------------------- R and CRAN

// The three R majors the catalogue can install on Windows amd64 today
// (2.15.3, 3.6.3, 4.6.1 -- the only Windows R builds our store has a
// SHA-256 for). Below 4.0 must refuse an app with an install command and
// install an app without one; 4.0 and up must do neither.
for (const range of ['==2.15.*', '==3.6.*', '==4.6.*']) {
  const withInstall = real(plan({ runtime: 'r', os: 'windows', range, install: '"{runtime}" -e "install.packages(\'jsonlite\')"' }));
  const without = real(plan({ runtime: 'r', os: 'windows', range }));
  const old = range !== '==4.6.*';
  ok(withInstall.length > 0, `R ${range} on Windows resolves to something at all`);
  for (const b of withInstall) {
    ok(cranFail(b) === old,
      `R ${range} on Windows, app with an install command: ${old ? 'refused' : 'not refused'} (${b.when})`);
    if (old) ok(!has(b, 'install') && !has(b, 'file'),
      `R ${range} on Windows: the refused block downloads and runs nothing (${b.when})`);
  }
  // The half that goes wrong: an R app with nothing to install works on
  // every one of these, because install.packages() is never called.
  for (const b of without) {
    ok(!cranFail(b), `R ${range} on Windows, app with nothing to install: not refused (${b.when})`);
    ok(has(b, 'file'), `R ${range} on Windows, app with nothing to install: still installs (${b.when})`);
  }
  // Linux compiles CRAN sources for every R version, and macOS is
  // deliberately not covered by the rule.
  for (const family of ['linux', 'macos']) {
    for (const b of real(plan({ runtime: 'r', os: family, range, install: '"{runtime}" -e "install.packages(\'jsonlite\')"' }))) {
      ok(!cranFail(b), `R ${range} on ${family}: not refused (${b.when})`);
    }
  }
}

// -------------------------------------------------- Python 2 and a non-ASCII %TEMP%

{
  const withPkg = real(plan({ runtime: 'python2', os: 'windows', package: 'six' }));
  ok(withPkg.length > 0, 'Python 2 on Windows resolves to something at all');
  for (const b of withPkg) {
    ok(asciiNeed(b), `Python 2 on Windows, app that installs a package: has the ascii-temp need (${b.when})`);
    const need = b.lines.slice(b.lines.findIndex((l) => l[0] === 'need' && l[1] === 'ascii-temp'));
    const upto = need.slice(1, need.findIndex((l, i) => i > 0 && (l[0] === 'need' || l[0] === 'file')));
    const keys = upto.map((l) => l[0]);
    ok(upto.some((l) => l[0] === 'ncheck' && l[1] === 'ascii' && l[2] === '%TEMP%'),
      `Python 2 on Windows: the need checks %TEMP% itself (${b.when})`);
    ok(keys.includes('nhow'), `Python 2 on Windows: the need says what to do about it (${b.when})`);
    ok(keys.includes('nwhy'), `Python 2 on Windows: the need says why it is needed (${b.when})`);
    // Nothing can install a machine's own folder names, and an engine that
    // thought it could would try to run something as administrator.
    ok(!keys.includes('nrun') && !keys.includes('nfile') && !keys.includes('npkg'),
      `Python 2 on Windows: the need offers nothing to install (${b.when})`);
  }
  // Where it must not fire.
  for (const b of real(plan({ runtime: 'python2', os: 'windows' }))) {
    ok(!asciiNeed(b), `Python 2 on Windows, app that installs nothing: no ascii-temp need (${b.when})`);
  }
  for (const family of ['linux', 'macos']) {
    for (const b of real(plan({ runtime: 'python2', os: family, package: 'six' }))) {
      ok(!asciiNeed(b), `Python 2 on ${family}: no ascii-temp need (${b.when})`);
    }
  }
}

// ------------------------------------------------ nothing else is touched

// Neither refusal may reach any other runtime: every runtime the policy
// knows, on every OS, with something to install.
for (const id of Object.keys(cat.policy.runtimes || {}).sort()) {
  for (const family of ['windows', 'linux', 'macos']) {
    const bs = plan({ runtime: id, os: family, install: 'echo hello' });
    for (const b of bs) {
      if (id !== 'python2' || family !== 'windows') {
        ok(!asciiNeed(b), `${id} on ${family}: no ascii-temp need (${b.when})`);
      }
      if (id !== 'r' || family !== 'windows') {
        ok(!cranFail(b), `${id} on ${family}: no CRAN refusal (${b.when})`);
      }
    }
  }
}

console.log(fails === 0 ? 'PASS' : `FAIL: ${fails} problems`);
process.exit(fails === 0 ? 0 : 1);
