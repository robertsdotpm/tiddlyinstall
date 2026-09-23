// A Windows installer from a base, a record and a plan, with the plan
// carried inside it -- which is what a page with no build server makes,
// and the case the review screen keeps being wrong about.
//
//   node make_test_exe.mjs <base.exe> <record> <plan> <out.exe>
//
// The server has its own implementation (src/shared/tifile.js); this
// calls the same one, so a fixture cannot drift from what is shipped.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { readInstaller, buildInstaller } = await import(path.join(here, '../../shared/tifile.js'));

const [base, rec, plan, out] = process.argv.slice(2);
if (!out) { console.error('usage: make_test_exe.mjs <base.exe> <record> <plan> <out.exe>'); process.exit(2); }
const info = await readInstaller(new Uint8Array(readFileSync(base)), 'exe');
const built = await buildInstaller(info, {
  record: readFileSync(rec, 'utf8'),
  plan: readFileSync(plan, 'utf8'),
});
writeFileSync(out, Buffer.from(built.data));
