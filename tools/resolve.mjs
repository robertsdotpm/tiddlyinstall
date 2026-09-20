// Prints the plan the resolver makes for a runtime, for checking the
// catalogue and the policy by eye; or, with -missing FAMILY, the files that
// plans for that OS family download but that have no copy in our mirror (so
// old machines on plain HTTP can't get them), as JSON. The catalogue is
// loaded as the build server loads it (server/lib/catalog.js).
//
//   node tools/resolve.mjs [-runtime python] [-select newest|asyncio|range|exact] [-range R]
//                          [-platforms windows,macos,linux] [-package NAME [-version V]] [-install CMD]
//   node tools/resolve.mjs -missing windows
//
// Also: -catalog DIR, -local DIR, -policy FILE, -cache FILE (defaults as the
// build server's).
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../server/lib/catalog.js';
import { resolve, resolveFiles, validPackage, packagePolicyFor, packageProject, packageModule } from '../shared/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = path.join(os.homedir(), 'projects/installer-builder-runtimes');
const o = {
  catalog: path.join(RUNTIMES, 'catalog'), local: RUNTIMES, policy: path.join(REPO, 'server/policy.json'),
  cache: path.join(REPO, 'server/data/sha-cache.json'), runtime: 'python', select: 'newest', range: '',
  platforms: 'windows,macos,linux', package: '', version: '', install: '', missing: '',
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const m = /^--?([a-z]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m || !Object.hasOwn(o, m[1])) {
    console.error('usage: node tools/resolve.mjs [-' + Object.keys(o).join(' V] [-') + ' V]');
    process.exit(2);
  }
  o[m[1]] = m[2] !== undefined ? m[2] : argv[++i] ?? '';
}

try {
  const cat = loadCatalog({ dir: o.catalog, policyPath: o.policy, localRoot: o.local, cachePath: o.cache });
  if (o.missing) {
    const out = [];
    for (const id of Object.keys(cat.policy.runtimes || {}).sort()) {
      const { files } = resolveFiles(cat, { recordHash: 'x', runtime: id, launch: 'x', platforms: [o.missing] });
      for (const f of files) if (!f.local) out.push({ name: f.name, sha256: f.sha256, size: f.size, urls: f.urls });
    }
    console.log(JSON.stringify(out, null, 1));
  } else {
    const pol = (cat.policy.runtimes || {})[o.runtime] || {};
    const app = { recordHash: 'testtesttesttesttesttestte', name: 'Hello', project: 'hello', runtime: o.runtime, select: o.select,
      range: o.range, launch: pol.launch || '', console: true, menu: true, platforms: o.platforms.split(','), install: o.install };
    if (o.package) {
      const name = validPackage(cat, o.runtime, o.package, o.version);
      const p = packagePolicyFor(cat, o.runtime);
      app.package = name;
      app.packageVersion = o.version;
      app.project = packageProject(p, name);
      app.launch = (p.launch || '').split('{name}').join(name).split('{module}').join(packageModule(name)).split('{bin}').join(app.project);
    }
    process.stdout.write(resolve(cat, app));
  }
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
