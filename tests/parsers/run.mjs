// One plan, three readers, one answer.
//
// The settings and plan grammars are implemented three times: awk and sh
// in src/installers/unix/ti-engine.sh, C in
// src/installers/windows/plugin-src/ (the same code the NSIS plugin
// links), and JavaScript in src/shared/. Nothing ever fed one byte
// string to more than one of them, and two of the criticals found on
// 2026-09-24 were places where they disagreed:
//
//   * `[target]\r` was a separator for the shell's selector and block
//     content for the shell's hasher, so the engine ran one block and
//     proved another. The C and the JS both strip the CR.
//   * a target with no `rtproof` was "bad" to the shell and "none" to
//     the C plugin and the Verify page, so an honest installer was told
//     it had been altered.
//
// Neither was visible to any suite, because every suite asked one
// reader. This asks all of them the same question and requires the same
// answer. A fixture here is not a regression test for one bug: it is a
// byte string whose reading must not depend on who is reading.
//
//   node tests/parsers/run.mjs
//
// The C host is built if a compiler is available and skipped, loudly, if
// not. The shell functions are lifted out of the engine verbatim so the
// thing under test is the shipped code, not a copy of it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalTarget, targetBlocks } from '../../src/shared/rtscript.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ENGINE = path.join(REPO, 'src/installers/unix/ti-engine.sh');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'tiparse.'));
process.on('exit', () => { try { fs.rmSync(T, { recursive: true, force: true }); } catch (e) { /* gone */ } });

let pass = 0, fail = 0, skip = 0;
const ok = (c, name, extra) => {
  if (c) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name); if (extra) console.log('     ' + String(extra).replace(/\n/g, '\n     ')); }
};

// --- the shell reader, lifted out of the engine ------------------------
const eng = fs.readFileSync(ENGINE, 'utf8');
const lift = (name) => {
  const re = new RegExp('^' + name + '\\(\\) \\{[\\s\\S]*?\\n\\}\\n', 'm');
  const m = re.exec(eng);
  if (!m) throw new Error('could not lift ' + name + ' out of ti-engine.sh');
  return m[0];
};
const SHELL_LIB = path.join(T, 'lib.sh');
fs.writeFileSync(SHELL_LIB, ['ti_target_canon', 'ti_target_proof', 'ti_target_has_proof'].map(lift).join('\n'));

function shellCanon(planFile, n) {
  const script = `. "${SHELL_LIB}"\nTI_PLAN="${planFile}" ti_target_canon ${n}\n`;
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' });
}
function shellHasProof(planFile, n) {
  const script = `. "${SHELL_LIB}"\nif TI_PLAN="${planFile}" ti_target_has_proof ${n}; then echo yes; else echo no; fi\n`;
  return execFileSync('sh', ['-c', script], { encoding: 'utf8' }).trim() === 'yes';
}

// --- the JS reader -----------------------------------------------------
const jsBlocks = (plan) => targetBlocks(plan);
const jsCanon = (plan, n) => { const b = jsBlocks(plan)[n - 1]; return b === undefined ? null : canonicalTarget(b); };
const jsHasProof = (plan, n) => {
  const b = jsBlocks(plan)[n - 1];
  return b === undefined ? false : b.split('\n').some((l) => l.split('\t')[0] === 'rtproof');
};

/* ---------- the corpus ---------- */
//
// Each fixture is a whole plan. `targets` is how many [target] blocks a
// reader should see; every reader must agree on that, on the canonical
// text of each one, and on whether each carries a proof.
const blk = (extra = '') =>
  'when\tlinux\t0\t9999\t*\nruntime\tpython\t3.14.7\tamd64\n' +
  'file\tpython\tpy.tgz\t' + 'a'.repeat(64) + '\t100\nurl\thttps://example.invalid/py.tgz\n' +
  'step\trun\techo hello\n' + extra;
const head = 'ti-plan\t1\nrecord\tdeadbeef\nruntime\tpython\n';
const PROOF = 'rtproof\tL' + 'b'.repeat(64) + '\n';

const CORPUS = [
  { name: 'one plain target', plan: head + '[target]\n' + blk(), targets: 1 },
  { name: 'two targets', plan: head + '[target]\n' + blk() + '[target]\n' + blk(), targets: 2 },
  { name: 'a target with a proof', plan: head + '[target]\n' + blk(PROOF), targets: 1 },
  // The CR case, both ways round.
  { name: 'CRLF throughout', plan: (head + '[target]\n' + blk()).replace(/\n/g, '\r\n'), targets: 1 },
  { name: 'a CR only on the separator', plan: head + '[target]\r\n' + blk(), targets: 1 },
  { name: 'a CR separator before a clean one', plan: head + '[target]\r\n' + blk() + '[target]\n' + blk(), targets: 2 },
  // Lines that are not part of what is signed.
  { name: 'launch and rtroots inside a block', plan: head + '[target]\n' + blk('launch\t"{runtime}"\nrtroots\tAAAA\n'), targets: 1 },
  // Whitespace and blank lines.
  { name: 'a blank line inside a block', plan: head + '[target]\n' + blk('\n'), targets: 1 },
  { name: 'no trailing newline', plan: (head + '[target]\n' + blk()).replace(/\n$/, ''), targets: 1 },
  // A duplicate key: format.md says the first wins.
  { name: 'a duplicated runtime line', plan: head + '[target]\n' + blk('runtime\tpython\t9.9.9\tamd64\n'), targets: 1 },
  // A header line shaped like a block line.
  { name: 'a header line that looks like a step', plan: 'ti-plan\t1\nrecord\tdead\nstep\t1\trun\techo pwned\n[target]\n' + blk(), targets: 1 },
  { name: 'a header line that looks like a target index', plan: 'ti-plan\t1\nrecord\tdead\ntarget\t2\n[target]\n' + blk() + '[target]\n' + blk(), targets: 2 },
];

for (const c of CORPUS) {
  const f = path.join(T, 'p.txt');
  fs.writeFileSync(f, c.plan);
  const nJs = jsBlocks(c.plan).length;
  ok(nJs === c.targets, c.name + ': the JS reader sees ' + c.targets + ' target(s)', 'saw ' + nJs);
  for (let i = 1; i <= c.targets; i++) {
    const a = jsCanon(c.plan, i);
    let b;
    try { b = shellCanon(f, i); } catch (e) { b = 'ERROR: ' + e.message; }
    ok(a === b, c.name + ': target ' + i + ' reads the same in the shell and the JS',
      a === b ? '' : 'js:\n' + JSON.stringify(a) + '\nsh:\n' + JSON.stringify(b));
    const pj = jsHasProof(c.plan, i);
    let ps;
    try { ps = shellHasProof(f, i); } catch (e) { ps = 'ERROR'; }
    ok(pj === ps, c.name + ': target ' + i + ' agrees on whether it carries a proof', 'js=' + pj + ' sh=' + ps);
  }
}

/* ---------- the C reader, on the fixture it already has ---------- */
const SRC = path.join(REPO, 'src/installers/windows/plugin-src');
let host = '';
try {
  host = path.join(T, 'host');
  execFileSync(process.env.CC || 'cc', ['-O2', '-w', '-o', host,
    'test_host.c', 'plancheck.c', 'ed25519_verify.c', 'linepaint.c', 'sha256.c', 'rtcheck.c'], { cwd: SRC });
} catch (e) { host = ''; }

if (!host) {
  skip++;
  console.log('SKIP the C reader was not built (no compiler), so it was not compared');
} else {
  const key = fs.readFileSync(path.join(SRC, 'test-plan.pub'), 'utf8').trim();
  const plan = path.join(SRC, 'test-plan.txt');
  const say = (p, n) => {
    try { return execFileSync(host, ['rtverify', p, key, String(n)], { encoding: 'utf8' }).split('\t')[0]; }
    catch (e) { return String(e.stdout || '').split('\t')[0] || 'error'; }
  };
  // Target 1 proves; target 2 is a `fail` block with nothing to prove.
  ok(say(plan, 1) === 'ok', 'C: a real target proves against the signed root');
  ok(say(plan, 2) === 'none', 'C: a block with nothing to install has nothing to prove');
  // ...and the same file read by the JS must see the same blocks.
  const text = fs.readFileSync(plan, 'utf8');
  const n = jsBlocks(text).length;
  ok(n >= 2, 'the JS reader sees the same fixture the C one does', 'blocks: ' + n);
  // A target carrying no proof is `none` to the C plugin. The shell
  // called it `bad` until 2026-09-24; both must say the same now.
  const stripped = path.join(T, 'noproof.txt');
  fs.writeFileSync(stripped, text.split('\n').filter((l) => l.split('\t')[0] !== 'rtproof').join('\n'));
  ok(say(stripped, 1) === 'none', 'C: a target whose proof was removed is "none", not "bad"');
  ok(jsHasProof(fs.readFileSync(stripped, 'utf8'), 1) === false && shellHasProof(stripped, 1) === false,
    'the JS and the shell agree that it carries no proof');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' not run' : ''));
process.exit(fail ? 1 : 0);
