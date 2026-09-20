// What the resolver offers on 32-bit x86 Linux (i386/i686), runtime by
// runtime, against the catalogue snapshot the golden cases use.
//
//   node tests/linux-x86-test.mjs [--catalog FILE] [--show]
//
// tests/golden/resolve-cases.json.br already checks every plan byte for
// byte, but it says nothing about *why* an answer is right. This test is
// the x86 verdict written down: for each runtime, which glibc ranges get a
// build, which version, and where the answer is deliberately `fail`. It is
// the thing to re-read when a 32-bit answer changes, and the thing the
// 32-bit VM run is checked against (docs/design.md 1.11, "32-bit Linux").
//
// Musl is the `0 204` range: musl systems report glibc 0 (shared/resolve.js
// loadOSScale), so a block whose `when` starts at 0 covers Alpine x86.
//
// --show prints every runtime's x86 blocks instead of only the failures.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from '../shared/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const SHOW = process.argv.includes('--show');
const snapFile = path.resolve(arg('--catalog', path.join(REPO, 'tests/golden/catalog.gz')));

// Expected x86 blocks per runtime, newest OS range first, as
// `<min>-<max> <version>` or `<min>-<max> fail`. The evidence for each is
// in docs/design.md 1.11; the short version is in the comments here.
const WANT = {
  // Statically linked toolchain, native linux/386 (pkg/tool/linux_386/*),
  // no libc at all: one block over the whole scale, musl included.
  go: ['0-9999 1.27.1'],
  // Fully static musl binaries; the floor is the 3.x kernel rule zig
  // already has on amd64 and arm64, so 2.5/2.12 fail and musl works.
  zig: ['217-9999 0.16.0', '205-216 fail', '0-204 0.16.0'],
  // C/C++ on Linux is zig (policy "via"), so it answers exactly as zig.
  cc: ['217-9999 0.16.0', '205-216 fail', '0-204 0.16.0'],
  // i686-unknown-linux-gnu, glibc 2.17 floor (compilers_min_os, confirmed
  // in the binary). No i686 musl host toolchain exists upstream.
  rust: ['217-9999 1.98.1', '0-216 fail'],
  // nim-*-linux_x32: real 32-bit archives for 0.20, 1.6 and 2.2. The 2.28
  // floor above is the catalogue's default floor, as on amd64.
  nim: ['228-9999 2.2.12', '217-227 0.20.2', '0-216 fail'],
  // Azul Zulu linux_i686. OpenJDK removed the 32-bit x86 port after 19, so
  // x86 stops at 19 where amd64 gets 26 -- deliberate, not a gap.
  java: ['212-9999 19.0.0', '205-211 8.0.504', '0-204 fail'],
  // nodejs.org stopped building linux-x86 after 9.x, and policy takes
  // official builds only, so 9.11.2 is the newest there will be.
  node: ['212-9999 9.11.2', '205-211 7.10.0', '0-204 fail'],
  // No 32-bit Linux build in the catalogue at all: one honest `fail`.
  python: ['0-9999 fail'],
  python2: ['0-9999 fail'],
  ruby: ['0-9999 fail'],
  php: ['0-9999 fail'],
  r: ['0-9999 fail'],
  dotnet: ['0-9999 fail'],
};

// The x86 target blocks of a linux-only plan, as `<min>-<max> <version>`.
function x86Blocks(plan) {
  const out = [];
  let cur = null;
  for (const line of plan.split('\n')) {
    const f = line.split('\t');
    if (f[0] === 'when') cur = f[1] === 'linux' && f[4] === 'x86' ? `${f[2]}-${f[3]}` : null;
    else if (cur && f[0] === 'runtime') { out.push(`${cur} ${f[2]}`); cur = null; }
    else if (cur && f[0] === 'fail') { out.push(`${cur} fail`); cur = null; }
  }
  return out;
}

const bytes = new Uint8Array(fs.readFileSync(snapFile));
const cat = await R.loadSnapshot(bytes);
let passed = 0, failed = 0;
for (const id of Object.keys(WANT)) {
  const pol = (cat.policy.runtimes || {})[id] || {};
  const plan = R.resolve(cat, { recordHash: 'testtesttesttesttesttestte', name: 'Hello', project: 'hello',
    runtime: id, select: 'newest', launch: pol.launch || '', console: true, platforms: ['linux'] });
  const got = x86Blocks(plan);
  const same = got.length === WANT[id].length && got.every((x, i) => x === WANT[id][i]);
  if (same) { passed++; if (SHOW) console.log(`PASS ${id.padEnd(8)} ${got.join('  |  ')}`); }
  else { failed++; console.log(`FAIL ${id.padEnd(8)} want ${JSON.stringify(WANT[id])}\n            got  ${JSON.stringify(got)}`); }
}

// Every machine the scale offers on Linux, so a future edit to loadOSScale
// that quietly drops x86 (or adds an arch nothing can serve) is noticed.
const machines = new Set();
for (const o of cat.os.byFamily.linux) for (const a of o.arches) machines.add(a);
const wantMachines = 'amd64,arm64,x86';
const gotMachines = [...machines].sort().join(',');
if (gotMachines === wantMachines) passed++;
else { failed++; console.log(`FAIL linux machines: want ${wantMachines}, got ${gotMachines}`); }

// musl carries x86 too (Alpine still releases it), and it is the only OS
// entry whose integer is 0.
const musl = cat.os.byFamily.linux.filter((o) => o.int === 0);
if (musl.length === 1 && musl[0].arches.includes('x86')) passed++;
else { failed++; console.log(`FAIL musl entry: ${JSON.stringify(musl.map((o) => [o.id, o.arches]))}`); }

// The ceiling the front end shows. Node stops at 9.11.2 on 32-bit Linux
// and Java at 19, where amd64 gets 26 of each; a publisher has to be told
// that before building, so runtimesSummary marks the row `behind` with the
// newest that family reaches. `cc` is the case that must NOT be marked: it
// is WinLibs GCC on Windows and zig elsewhere, whose versions would
// compare as nonsense across families.
const summary = R.runtimesSummary(cat);
const row = (id, family, arch) => (summary.runtimes.find((r) => r.id === id).newest || [])
  .find((r) => r.family === family && r.arch === arch);
for (const [id, want] of [['node', '26.9.0'], ['java', '26.0.2.1']]) {
  const r = row(id, 'linux', 'x86');
  if (r && r.behind === want) passed++;
  else { failed++; console.log(`FAIL ${id} linux/x86 behind: want ${want}, got ${r && r.behind}`); }
}
for (const [id, family, arch] of [['go', 'linux', 'x86'], ['rust', 'linux', 'x86'], ['cc', 'linux', 'x86'], ['cc', 'linux', 'amd64']]) {
  const r = row(id, family, arch);
  if (r && r.behind === undefined) passed++;
  else { failed++; console.log(`FAIL ${id} ${family}/${arch}: should not be behind, got ${r && r.behind}`); }
}

console.log(`${path.relative(REPO, snapFile)}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
