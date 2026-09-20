// The resolver's release parts (python's msi-layout) and windowed programs
// (launch.gui_program for console 0 apps), and LocalIndex with several
// copies of one file name, on a small made-up catalogue.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LocalIndex, loadCatalog } from '../lib/catalog.js';
import { resolveFiles, writeSnapshot, loadSnapshot } from '../../js/resolve.js';
import { tmpDir } from './helpers.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('LocalIndex: of several copies with one name and size, the one with the SHA-256', (t) => {
  const d = tmpDir(t);
  const a = Buffer.alloc(4096, 1), b = Buffer.alloc(4096, 2);
  for (const [dir, data] of [['v1', a], ['v2', b]]) {
    fs.mkdirSync(path.join(d, dir));
    fs.writeFileSync(path.join(d, dir, 'core.msi'), data);
  }
  fs.mkdirSync(path.join(d, 'u'));
  fs.writeFileSync(path.join(d, 'u', 'only.zip'), a);
  const ix = new LocalIndex(d, path.join(d, 'cache.json'));
  assert.equal(ix.find('core.msi', 4096, sha(b)), 'v2/core.msi');
  assert.equal(ix.find('core.msi', 4096, sha(a)), 'v1/core.msi');
  assert.equal(ix.find('core.msi', 4096, sha(Buffer.from('other'))), '');
  assert.equal(ix.find('core.msi', 4096), 'v1/core.msi');        // no SHA-256: the first, as before
  assert.equal(ix.find('only.zip', 4096, sha(b)), 'u/only.zip');  // one copy: not hashed, as before
});

test('LocalIndex: a copy stored under the URL\'s escaped name is found by the catalogue\'s', (t) => {
  // tools/download.py names our copy after the URL's last segment, escapes
  // and all, while the catalogue's own name for the file un-escapes %2B
  // (resolve.js fileName). 73 files -- every python-build-standalone and
  // LLVM release -- were stored as cpython-3.14.7%2B2026… and looked for
  // as cpython-3.14.7+2026…, so they were invisible here and their plans
  // carried no mirror URL at all.
  const d = tmpDir(t);
  const data = Buffer.alloc(4096, 3);
  fs.mkdirSync(path.join(d, 'python'));
  fs.writeFileSync(path.join(d, 'python', 'cpython-3.14.7%2B20260901-x86_64-linux.tar.gz'), data);
  const ix = new LocalIndex(d, path.join(d, 'cache.json'));
  const stored = 'python/cpython-3.14.7%2B20260901-x86_64-linux.tar.gz';
  assert.equal(ix.find('cpython-3.14.7+20260901-x86_64-linux.tar.gz', 4096, sha(data)), stored);
  assert.equal(ix.find('cpython-3.14.7%2B20260901-x86_64-linux.tar.gz', 4096, sha(data)), stored);
  assert.equal(ix.find('cpython-3.14.7+20260901-x86_64-linux.tar.gz', 99, sha(data)), '');
});

function miniCatalogue(d) {
  const cat = path.join(d, 'catalog'), local = path.join(d, 'local');
  fs.mkdirSync(path.join(cat, 'python'), { recursive: true });
  const core = Buffer.alloc(4096, 7), lib = Buffer.alloc(8192, 8);
  // Our copy of core.msi and lib.msi, beside another version's same-sized core.msi.
  fs.mkdirSync(path.join(local, 'python/windows/amd64/3.14.7-msi-layout'), { recursive: true });
  fs.mkdirSync(path.join(local, 'python/windows/amd64/3.14.6-msi-layout'), { recursive: true });
  fs.writeFileSync(path.join(local, 'python/windows/amd64/3.14.6-msi-layout/core.msi'), Buffer.alloc(4096, 6));
  fs.writeFileSync(path.join(local, 'python/windows/amd64/3.14.7-msi-layout/core.msi'), core);
  fs.writeFileSync(path.join(local, 'python/windows/amd64/3.14.7-msi-layout/lib.msi'), lib);
  fs.writeFileSync(path.join(cat, 'os_versions.json'), JSON.stringify({ windows: [{ id: '10', nt: '10.0' }] }));
  const u = (f) => 'https://www.python.org/ftp/python/3.14.7/amd64/' + f;
  fs.writeFileSync(path.join(cat, 'python/releases.json'), JSON.stringify([{
    version: '3.14.7', os: 'windows', arch: 'amd64', kind: 'installer', format: 'msi', variant: 'msi-layout',
    url: u('core.msi'), mirrors: [u('core.msi')], checksum: { algo: 'sha256', value: sha(core) }, size: 4096,
    parts: [
      { name: 'lib.msi', url: u('lib.msi'), mirrors: [u('lib.msi'), 'https://mirror.example/lib.msi'], sha256: sha(lib), size: 8192 },
      { name: 'tcltk.msi', url: u('tcltk.msi'), mirrors: null, sha256: 'ab'.repeat(32), size: 12288 },
    ],
  }]));
  fs.writeFileSync(path.join(cat, 'python/install.json'), JSON.stringify({ recipes: [{
    match: { os: 'windows', kind: 'installer', format: 'msi', variant: 'msi-layout' }, method: 'extract', isolation: 'full',
    steps: [
      { run: 'msiexec /a "{file}" /qn TARGETDIR="{runtime_dir}"', shell: 'cmd' },
      { run: 'msiexec /a "{tmp}\\lib.msi" /qn TARGETDIR="{runtime_dir}"', shell: 'cmd' },
      { run: 'msiexec /a "{tmp}\\tcltk.msi" /qn TARGETDIR="{runtime_dir}"', shell: 'cmd' },
      { run: 'del /q "{runtime_dir}\\*.msi"', shell: 'cmd' },
    ],
    executable: 'python.exe',
    launch: { program: '{runtime_dir}\\python.exe', gui_program: '{runtime_dir}\\pythonw.exe', args: ['-E', '-s'] },
  }] }));
  const policy = path.join(d, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({
    mirror_base: 'http://ib.example/mirror', mirror_first: true, method_order: ['unpack', 'extract', 'run'],
    unknown_floor: { windows: 1000 }, runtimes: { python: { label: 'Python 3', versions: '>=3', variants: ['msi-layout'], launch: '{runtime} -m {project}' } },
  }));
  return loadCatalog({ dir: cat, policyPath: policy, localRoot: local, cachePath: path.join(d, 'cache.json') });
}

const app = (console) => ({ recordHash: 'r', name: 'My App', project: 'app', runtime: 'python', launch: '{runtime} {app_dir}/main.py', console, menu: true, platforms: ['windows'] });

test('release parts: extra files with their own mirrors; windowed program for console 0', async (t) => {
  const cat = miniCatalogue(tmpDir(t));
  const { plan, files } = resolveFiles(cat, app(false));
  const start = plan.indexOf('[target]');
  const block = plan.slice(start, plan.indexOf('[target]', start + 1));
  assert.equal(block, [
    '[target]',
    'when\twindows\t1000\t9999\tamd64',
    'covers\tWindows 10',
    'runtime\tpython\t3.14.7',
    'note\tNot confirmed to run on every OS version in this range; chosen by the catalogue\'s default floor.',
    `file\tpython\tcore.msi\t${files[0].sha256}\t4096`,
    'url\thttp://ib.example/mirror/python/windows/amd64/3.14.7-msi-layout/core.msi',
    'url\thttps://www.python.org/ftp/python/3.14.7/amd64/core.msi',
    'step\trun\tmsiexec /a "{file}" /qn TARGETDIR="{runtime_dir}"',
    `file\tlib\tlib.msi\t${files[1].sha256}\t8192`,
    'url\thttp://ib.example/mirror/python/windows/amd64/3.14.7-msi-layout/lib.msi',
    'url\thttps://www.python.org/ftp/python/3.14.7/amd64/lib.msi',
    'url\thttps://mirror.example/lib.msi',
    'step\trun\tcopy /y "{file}" "{tmp}\\lib.msi" >nul',
    `file\ttcltk\ttcltk.msi\t${'ab'.repeat(32)}\t12288`,
    'url\thttps://www.python.org/ftp/python/3.14.7/amd64/tcltk.msi',
    'step\trun\tcopy /y "{file}" "{tmp}\\tcltk.msi" >nul',
    'step\trun\tmsiexec /a "{tmp}\\lib.msi" /qn TARGETDIR="{runtime_dir}"',
    'step\trun\tmsiexec /a "{tmp}\\tcltk.msi" /qn TARGETDIR="{runtime_dir}"',
    'step\trun\tdel /q "{runtime_dir}\\*.msi"',
    'exe\tpython.exe',
    'launch\t"{runtime_dir}\\pythonw.exe" -E -s "{app_dir}\\main.py"',
    '', '',
  ].join('\n'));
  assert.deepEqual(files.map((f) => [f.name, f.local]), [
    ['core.msi', 'python/windows/amd64/3.14.7-msi-layout/core.msi'],
    ['lib.msi', 'python/windows/amd64/3.14.7-msi-layout/lib.msi'],
    ['tcltk.msi', ''],
  ]);
  // A console app keeps the console program.
  assert.match(resolveFiles(cat, app(true)).plan, /\nlaunch\t"\{runtime_dir\}\\python\.exe" -E -s /);
  // The snapshot carries the parts (with our copies' paths), and plans from it are the same.
  const snap = await loadSnapshot(await writeSnapshot(cat));
  assert.equal(resolveFiles(snap, app(false)).plan, plan);
});
