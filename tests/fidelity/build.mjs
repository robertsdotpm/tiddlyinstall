// Builds the fidelity projects' installers (docs/test-results.md, "Real-app fidelity") the way
// the site does without a build server: src/shared/builder.js in this process, mode C,
// the plan inside the installer, from the working tree's policy and the
// runtime catalogue (~/projects/installer-builder-runtimes/catalog).
//
//   node tests/fidelity/build.mjs [--only python,ruby] [--platforms windows,linux,macos]
//        [--mirror URL] [--out DIR] [--policy FILE] [--catalog DIR] [--projects FILE]
//
// --mirror: our mirror's URL in the plans (the Mac reaches it through a
// tunnel: http://127.0.0.1:8080/mirror). Writes DIR/<id>/<installer> and
// DIR/builds.json (default DIR: tests/fidelity/out). --policy and --catalog
// build from another policy file or catalogue folder (to try a change).
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
const PROJECTS = path.resolve(arg('--projects', path.join(HERE, 'projects.json')));
const { projects } = JSON.parse(fs.readFileSync(PROJECTS, 'utf8'));

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
const buildsFile = path.join(OUT, 'builds.json');
const builds = fs.existsSync(buildsFile) ? JSON.parse(fs.readFileSync(buildsFile, 'utf8')) : {};
let failed = 0;
for (const [id, p] of Object.entries(projects)) {
  if (ONLY.length && !ONLY.includes(id)) continue;
  const job = {
    name: 'Fidelity ' + id, project: p.project, source: { kind: 'inline' }, files: readTree(path.join(path.dirname(PROJECTS), 'projects', id)),
    runtime: p.runtime, mode: 'C', platforms: PLATFORMS.filter((x) => !p.platforms || p.platforms.includes(x)),
    launch: p.launch, console: true, menu: false, select: p.select || 'newest', range: p.range || '',
  };
  if (p.install) job.install = p.install;
  if (p.prerequisites) job.prerequisites = p.prerequisites;
  if (p.tools) job.tools = p.tools;
  const dir = path.join(OUT, id);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = await runJob(job, env);
    const files = {};
    for (const f of out.files) {
      fs.writeFileSync(path.join(dir, f.name), f.data);
      files[f.platform] = path.join(dir, f.name);
    }
    fs.writeFileSync(path.join(dir, 'plan.txt'), resolve(env.catalog, out.app));
    builds[id] = { status: 'done', record: out.hash, runtime: p.runtime, checks: p.checks, files };
    console.log(`${id}: ${Object.keys(files).join(', ')}`);
  } catch (e) {
    failed++;
    builds[id] = { status: 'failed', error: String(e && e.message || e) };
    console.log(`${id}: FAILED ${builds[id].error}`);
  }
}
fs.writeFileSync(buildsFile, JSON.stringify(builds, null, 1));
process.exit(failed ? 1 : 0);
