// Builds the package-manager matrix's installers: one per (runtime, major
// version), the way the site does without a build server, exactly as
// tests/fidelity/build.mjs does (src/shared/builder.js in this process, mode C,
// the plan inside the installer, from the working tree's policy and the
// runtime catalogue).
//
//   node tests/tooling/build.mjs [--only python,node] [--platforms windows,linux,macos]
//        [--samples 5] [--majors python=3.9,3.14] [--mirror URL] [--out DIR]
//        [--policy FILE] [--catalog DIR] [--projects FILE]
//
// For each project it asks the resolver, major by major, which of the
// catalogue's majors it can actually install on at least one of the chosen
// platforms (a `range` of `==<major>.*`), then samples --samples of them:
// always the oldest and the newest, and the rest spread evenly, so a row
// covers the whole range without building all 197 (runtime, major) pairs
// the catalogue offers. --samples 0 means every one. --majors pins a
// runtime's list by hand.
//
// Writes DIR/<id>/<installer>, DIR/<id>/plan.txt and DIR/builds.json
// (default DIR: tests/tooling/out); tests/tooling/run.py installs them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runJob } from '../../src/shared/builder.js';
import { resolve } from '../../src/shared/resolve.js';
import { loadCatalog } from '../../src/build_server/lib/catalog.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(HERE, '..', '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const OUT = path.resolve(arg('--out', path.join(HERE, 'out')));
const PLATFORMS = arg('--platforms', 'windows,linux,macos').split(',');
const ONLY = arg('--only', '').split(',').filter(Boolean);
const SAMPLES = Number(arg('--samples', '5'));
const PROJECTS = path.resolve(arg('--projects', path.join(HERE, 'projects.json')));
const { projects } = JSON.parse(fs.readFileSync(PROJECTS, 'utf8'));
const PINNED = Object.fromEntries(arg('--majors', '').split(';').filter(Boolean)
  .map((s) => [s.split('=')[0], s.split('=')[1].split(',')]));

function readTree(dir, pre = '') {
  const files = {};
  for (const e of fs.readdirSync(path.join(dir, pre), { withFileTypes: true })) {
    const rel = pre ? pre + '/' + e.name : e.name;
    if (e.isDirectory()) Object.assign(files, readTree(dir, rel));
    else files[rel] = fs.readFileSync(path.join(dir, rel), 'utf8');
  }
  return files;
}

function localEnv() {
  const home = os.homedir();
  const cache = path.join(OUT, 'sha-cache.json');
  const serverCache = path.join(REPO, 'src/build_server/data/sha-cache.json');
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(cache) && fs.existsSync(serverCache)) fs.copyFileSync(serverCache, cache);
  const cat = loadCatalog({
    dir: path.resolve(arg('--catalog', path.join(home, 'projects/installer-builder-runtimes/catalog'))),
    policyPath: path.resolve(arg('--policy', path.join(REPO, 'src/build_server/policy.json'))),
    localRoot: path.join(home, 'projects/installer-builder-runtimes'),
    cachePath: cache,
  });
  if (arg('--mirror', '')) cat.policy.mirror_base = arg('--mirror', '');
  const bases = { windows: 'src/installers/windows/out/base.exe', linux: 'src/installers/unix/out/ti-base.run', macos: 'src/installers/unix/out/ti-base-macos.zip' };
  return { catalog: cat, backend: '', embedPlan: true, base: (plat) => new Uint8Array(fs.readFileSync(path.join(REPO, bases[plat]))) };
}

const env = localEnv();

// Every major of a runtime the catalogue has any release for, oldest
// first, including the runtimes it is served by on some OS family: C/C++
// on Linux and macOS is zig (policy "via"), so the cc rows have to carry
// zig's majors as well as WinLibs GCC's, or `zig cc` would never be run.
function catalogMajors(runtime) {
  const dir = path.resolve(arg('--catalog', path.join(os.homedir(), 'projects/installer-builder-runtimes/catalog')));
  const ids = new Set([runtime]);
  const pol0 = env.catalog.policy.runtimes[runtime];
  for (const f of Object.keys((pol0 && pol0.via) || {})) ids.add(String(pol0.via[f]));
  const majors = new Set();
  for (const id of ids) {
    const pol = env.catalog.policy.runtimes[id];
    const folder = (pol && pol.folder) || id;
    const p = path.join(dir, folder, 'releases.json');
    if (!fs.existsSync(p)) continue;
    for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) majors.add(String(r.major));
  }
  const key = (m) => m.split('.').map(Number);
  const list2 = [...majors];
  list2.sort((a, b) => {
    const A = key(a), B = key(b);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const d = (A[i] || 0) - (B[i] || 0);
      if (d) return d;
    }
    return 0;
  });
  return list2;
}

// The majors whose plan has at least one block with a release, for the
// platforms being built: what the catalogue can really install.
function installable(p, majors) {
  const out = [];
  for (const m of majors) {
    const app = {
      recordHash: 'preview', name: 'x', project: p.project, runtime: p.runtime,
      select: 'range', range: '==' + m + '.*', launch: p.launch, install: p.install || 'default',
      platforms: PLATFORMS,
    };
    let plan;
    try { plan = resolve(env.catalog, app); } catch (e) { continue; }
    if (plan.split('\n').some((l) => l.startsWith('runtime\t') && l.split('\t').length > 2)) out.push(m);
  }
  return out;
}

// Keep the oldest, the newest, and n-2 spread evenly between them.
function sample(list, n) {
  if (n <= 0 || list.length <= n) return list.slice();
  if (n === 1) return [list[list.length - 1]];
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

const buildsFile = path.join(OUT, 'builds.json');
const builds = fs.existsSync(buildsFile) ? JSON.parse(fs.readFileSync(buildsFile, 'utf8')) : {};
const sampled = {};
let failed = 0;
for (const [id, p] of Object.entries(projects)) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const files0 = readTree(path.join(path.dirname(PROJECTS), 'projects', id));
  let majors = PINNED[id] || PINNED[p.runtime];
  if (p.select === 'range') {
    // A project that pins its own range (Zig: its standard library changes
    // shape every release, so one source cannot span the catalogue).
    majors = [p.range];
    sampled[id] = { offered: installable(p, catalogMajors(p.runtime)), built: majors };
  } else if (!majors) {
    const all = installable(p, catalogMajors(p.runtime));
    majors = sample(all, Number(p.samples || SAMPLES));
    sampled[id] = { offered: all, built: majors };
  } else {
    sampled[id] = { offered: majors, built: majors };
  }
  for (const m of majors) {
    const cell = id + '@' + m;
    const files = {};
    for (const [n, t] of Object.entries(files0)) files[n] = t.split('{{MAJOR}}').join(m);
    const job = {
      name: 'Tooling ' + cell, project: p.project, source: { kind: 'inline' }, files,
      runtime: p.runtime, mode: 'C', platforms: PLATFORMS.filter((x) => !p.platforms || p.platforms.includes(x)),
      launch: p.launch + (p.launch_args ? ' ' + p.launch_args : ''),
      console: true, menu: false,
      select: 'range', range: p.select === 'range' ? m : '==' + m + '.*',
    };
    if (p.install) job.install = p.install;
    if (p.prerequisites) job.prerequisites = p.prerequisites;
    if (p.tools) job.tools = p.tools;
    const dir = path.join(OUT, cell.replace('@', '-'));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    try {
      const out = await runJob(job, env);
      const made = {};
      for (const f of out.files) {
        fs.writeFileSync(path.join(dir, f.name), f.data);
        made[f.platform] = path.join(dir, f.name);
      }
      fs.writeFileSync(path.join(dir, 'plan.txt'), resolve(env.catalog, out.app));
      builds[cell] = { status: 'done', project: id, runtime: p.runtime, major: m,
        record: out.hash, checks: p.checks, files: made };
      console.log(`${cell}: ${Object.keys(made).join(', ')}`);
    } catch (e) {
      failed++;
      builds[cell] = { status: 'failed', project: id, runtime: p.runtime, major: m,
        error: String((e && e.message) || e) };
      console.log(`${cell}: FAILED ${builds[cell].error}`);
    }
  }
}
fs.writeFileSync(buildsFile, JSON.stringify(builds, null, 1));
fs.writeFileSync(path.join(OUT, 'sampled.json'), JSON.stringify(sampled, null, 1));
console.log('\nsampled per project (offered by the catalogue -> built):');
for (const [id, s] of Object.entries(sampled)) {
  console.log(`  ${id.padEnd(8)} ${String(s.offered.length).padStart(3)} offered: ${s.offered.join(' ')}`);
  console.log(`  ${''.padEnd(8)} ${String(s.built.length).padStart(3)} built:    ${s.built.join(' ')}`);
}
process.exit(failed ? 1 : 0);
