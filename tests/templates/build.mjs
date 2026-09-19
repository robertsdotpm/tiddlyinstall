// Builds an installer for every "I'll write it here" template (js/templates.js),
// the way the New installer page does: the form's fields as the page starts
// them, with the template chosen and its files as the editor shows them,
// turned into a job by js/form-job.js (so the default launch command,
// build command, console flag and version range are the page's), then built
// by js/builder.js in this process, as the page builds without a build
// server (mode C, the plan inside the installer), or sent to a build server.
//
//   node tests/templates/build.mjs [--only python/window,go] [--platforms windows,linux,macos]
//        [--server URL [--mode A|B|C]] [--mirror URL] [--out DIR]
//
// --server: POST /api/jobs to that server instead (the live one is
// http://127.0.0.1:8080; mode A needs it). --mirror: our mirror's URL in the
// plans (for machines that reach it through a tunnel, like the Mac).
// Writes DIR/<runtime>-<template>/<installer> and DIR/builds.json
// (default DIR: tests/templates/out).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEMPLATES } from '../../js/templates.js';
import { formFor as formFields } from './form.mjs';
import { jobFromForm } from '../../js/form-job.js';
import { runJob } from '../../js/builder.js';
import { loadCatalog } from '../../backend/lib/catalog.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const REPO = path.join(HERE, '..', '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const OUT = path.resolve(arg('--out', path.join(HERE, 'out')));
const SERVER = arg('--server', '');
const MODE = arg('--mode', 'C');
const PLATFORMS = arg('--platforms', 'windows,linux,macos').split(',');
const ONLY = arg('--only', '').split(',').filter(Boolean);
const want = (rt, id) => !ONLY.length || ONLY.includes(rt) || ONLY.includes(rt + '/' + id);

let env = null;
function localEnv() {
  if (env) return env;
  const home = os.homedir();
  // A copy of the server's cache of our mirror's file hashes, so they aren't
  // worked out again (and the server's own file is left alone).
  const cache = path.join(OUT, 'sha-cache.json');
  const serverCache = path.join(REPO, 'backend/data/sha-cache.json');
  fs.mkdirSync(OUT, { recursive: true });
  if (!fs.existsSync(cache) && fs.existsSync(serverCache)) fs.copyFileSync(serverCache, cache);
  const cat = loadCatalog({
    dir: path.join(home, 'projects/installer-builder-runtimes/catalog'),
    policyPath: path.join(REPO, 'backend/policy.json'),
    localRoot: path.join(home, 'projects/installer-builder-runtimes'),
    cachePath: cache,
  });
  if (arg('--mirror', '')) cat.policy.mirror_base = arg('--mirror', '');
  const bases = { windows: 'bases/windows/out/base.exe', linux: 'bases/unix/out/ib-base.run', macos: 'bases/unix/out/ib-base-macos.zip' };
  env = { catalog: cat, backend: '', embedPlan: true, base: (plat) => new Uint8Array(fs.readFileSync(path.join(REPO, bases[plat]))) };
  return env;
}

async function api(p, body) {
  for (;;) {
    const r = await fetch(SERVER + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    if (r.status === 429) { await new Promise((res) => setTimeout(res, 5000)); continue; }
    if (!r.ok) throw new Error(p + ': ' + r.status + ' ' + (await r.text()).slice(0, 300));
    return r;
  }
}

async function build(job, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  if (!SERVER) {
    const out = await runJob(job, localEnv());
    for (const f of out.files) {
      fs.writeFileSync(path.join(dir, f.name), f.data);
      files[f.platform] = path.join(dir, f.name);
    }
    return { record: out.hash, files };
  }
  let j = await (await api('/api/jobs', job)).json();
  while (j.status !== 'done' && j.status !== 'failed') {
    await new Promise((res) => setTimeout(res, 1000));
    j = await (await api('/api/jobs/' + j.id)).json();
  }
  if (j.status === 'failed') throw new Error(j.error);
  for (const f of j.result.files) {
    const data = Buffer.from(await (await api(f.url)).arrayBuffer());
    fs.writeFileSync(path.join(dir, f.name), data);
    files[f.platform] = path.join(dir, f.name);
  }
  return { record: j.result.record, files };
}

const buildsFile = path.join(OUT, 'builds.json');
const builds = fs.existsSync(buildsFile) ? JSON.parse(fs.readFileSync(buildsFile, 'utf8')) : {};
let failed = 0;
for (const rt of Object.keys(TEMPLATES)) {
  for (const id of Object.keys(TEMPLATES[rt])) {
    if (!want(rt, id)) continue;
    const t = TEMPLATES[rt][id];
    const platforms = PLATFORMS.filter((p) => !t.platforms || t.platforms.includes(p));
    const key = rt + '/' + id;
    if (!platforms.length) {
      builds[key] = { status: 'skipped', platforms: t.platforms, console: t.console !== false, title: t.title || '' };
      console.log(`skip ${key}: not for ${PLATFORMS.join(', ')}`);
      continue;
    }
    const { job, problems } = jobFromForm(formFields(rt, id, platforms, MODE), { icon: { choice: 'default' } });
    if (problems.length) {
      failed++;
      builds[key] = { status: 'failed', error: problems.join(' ') };
      console.log(`FAIL ${key}: ${problems.join(' ')}`);
      continue;
    }
    try {
      const b = await build(job, path.join(OUT, rt + '-' + id));
      builds[key] = { status: 'done', record: b.record, files: b.files, name: job.name, console: job.console,
        launch: job.launch, install: job.install, range: job.range, title: t.title || '', platforms, mode: MODE };
      console.log(`built ${key}: ${b.record} (${Object.keys(b.files).join(', ')}) launch=${job.launch} install=${job.install || '(policy)'}${job.range ? ' range=' + job.range : ''}`);
    } catch (e) {
      failed++;
      builds[key] = { status: 'failed', error: String(e.message || e) };
      console.log(`FAIL ${key}: ${e.message || e}`);
    }
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(buildsFile, JSON.stringify(builds, null, 1));
  }
}
process.exit(failed ? 1 : 0);
