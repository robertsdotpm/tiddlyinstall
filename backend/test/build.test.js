// Ports the Go server's package_test.go and icon_test.go: registry
// lookups, plain-name records, request checks, install rules, and icons in
// each mode, through the server's Builder and js/builder.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import { Builder } from '../lib/jobs.js';
import { loadOrCreate } from '../lib/plansig.js';
import { validate, packageLaunch, projectInstall, inlineTar } from '../../js/builder.js';
import { resolve } from '../../js/resolve.js';
import { readInstaller, zipEntryData, peInfo, peChecksum, tarRead } from '../../js/ibfile.js';
import { tarNamesUnderTop } from '../lib/files.js';
import { catalog, haveCatalog, haveBases, BASES, tmpDir, localFetch, REPO } from './helpers.js';

const skip = !haveCatalog && 'no runtime catalogue';

// The registry the Go tests serve.
function registry(t) {
  const answers = {
    '/npm/cowsay/latest': '{"name":"cowsay","version":"1.6.0","bin":{"cowsay":"./cli.js","cowthink":"./cli.js"}}',
    '/npm/cowsay/1.6.0': '{"name":"cowsay","version":"1.6.0","bin":{"cowsay":"./cli.js","cowthink":"./cli.js"}}',
    '/npm/evil/latest': '{"version":"1.0.0","bin":{"evil":"x.js\\" & calc & \\""}}',
    '/npm/badver/latest': '{"version":"1.0; rm -rf ~"}',
    '/npm/@antfu/ni/latest': '{"name":"@antfu/ni","version":"30.6.0","bin":{"na":"bin/na.mjs","ni":"bin/ni.mjs","nr":"bin/nr.mjs"}}',
    '/npm/@antfu/ni/30.6.0': '{"name":"@antfu/ni","version":"30.6.0","bin":{"na":"bin/na.mjs","ni":"bin/ni.mjs","nr":"bin/nr.mjs"}}',
    '/npm/@scope/strbin/latest': '{"version":"2.0.0","bin":"./cli.js"}',
    '/npm/@scope/strbin/2.0.0': '{"version":"2.0.0","bin":"./cli.js"}',
    '/npm/@evil/pkg/latest': '{"version":"1.0.0","bin":{"pkg":"$(id).js"}}',
    '/npm/@evil/pkg/1.0.0': '{"version":"1.0.0","bin":{"pkg":"$(id).js"}}',
    '/npm/@evil/ver/latest': '{"version":"1.0\\" & calc & \\"","bin":"cli.js"}',
    '/pypi/httpie/json': '{"info":{"version":"3.2.4"}}',
    '/pypi/junk/json': 'not json',
  };
  const seen = [];
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      seen.push(req.url);
      const a = answers[decodeURIComponent(req.url)];
      if (a === undefined) { res.writeHead(404); return res.end('404 page not found\n'); }
      res.end(a);
    });
    s.listen(0, '127.0.0.1', () => { t.after(() => s.close()); resolve({ url: 'http://127.0.0.1:' + s.address().port, seen }); });
  });
}

function builder(t, reg) {
  const cat = catalog();
  if (reg) {
    const n = cat.policy.runtimes.node.package;
    n.lookup = reg.url + '/npm/{name}/latest';
    n.lookup_version = reg.url + '/npm/{name}/{version}';
    const p = cat.policy.runtimes.python.package;
    p.lookup = reg.url + '/pypi/{name}/json';
    p.lookup_version = reg.url + '/pypi/{name}/{version}/json';
  }
  const data = tmpDir(t);
  const { signer } = loadOrCreate(data, () => {});
  return new Builder({ cat, data, bases: BASES, public: 'http://127.0.0.1:1', signer, fetch: localFetch });
}

test('package lookups', { skip }, async (t) => {
  const reg = await registry(t);
  const b = builder(t, reg);
  let info = await b.lookupPackage('node', 'cowsay', '');
  assert.deepEqual([info.version, info.bin, info.binPath], ['1.6.0', 'cowsay', 'cli.js']);
  const np = b.cat.policy.runtimes.node.package;
  assert.equal(packageLaunch('{runtime} {app_dir}/node_modules/{name}/{bin_path}', np, 'cowsay', info), '{runtime} {app_dir}/node_modules/cowsay/cli.js');
  assert.equal((await b.lookupPackage('python', 'httpie', '')).version, '3.2.4');
  await assert.rejects(b.lookupPackage('python', 'no-such-thing', ''), (e) => e.noPackage && /has no package named no-such-thing: no such package$/.test(e.message));
  await assert.rejects(b.lookupPackage('python', 'junk', ''), /package registry: unreadable answer/);
  // Registry answers are untrusted: nothing unsafe reaches a command.
  await assert.rejects(b.lookupPackage('node', 'evil', ''));
  await assert.rejects(b.lookupPackage('node', 'badver', ''), /gave no usable version for badver/);
  // Scoped npm names: asked at /@scope/name (the slash kept), and the
  // program is the bin named like the unscoped name.
  info = await b.lookupPackage('node', '@antfu/ni', '');
  assert.deepEqual([info.version, info.bin, info.binPath], ['30.6.0', 'ni', 'bin/ni.mjs']);
  assert.ok(reg.seen.includes('/npm/@antfu/ni/latest'), reg.seen.join(' '));
  assert.equal(packageLaunch(np.launch, np, '@antfu/ni', info), '{runtime} {app_dir}/node_modules/@antfu/ni/bin/ni.mjs');
  info = await b.lookupPackage('node', '@scope/strbin', '');
  assert.deepEqual([info.bin, info.binPath], ['strbin', 'cli.js']);
  for (const evil of ['@evil/pkg', '@evil/ver']) await assert.rejects(b.lookupPackage('node', evil, ''), evil);
  // No lookup configured (Go): the name is passed through unpinned.
  assert.equal((await b.lookupPackage('go', 'golang.org/x/example/hello', '')).version, '');
  // Answers are cached for ten minutes, missing packages too.
  const n = reg.seen.length;
  await b.lookupPackage('node', 'cowsay', '');
  await assert.rejects(b.lookupPackage('python', 'no-such-thing', ''));
  assert.equal(reg.seen.length, n);
});

test('plain-name records', { skip }, async (t) => {
  const b = builder(t, null);
  const h1 = await b.nameRecord('python', 'Cowsay');
  const h2 = await b.nameRecord('python', 'cowsay');
  assert.equal(h1, h2, 'the same name should give the same record');
  const s = fs.readFileSync(b.recordPath(h1), 'utf8');
  for (const want of ['source\tpackage\tcowsay\n', 'launch\t{runtime} -m cowsay\n', 'install\tdefault\n', 'origin\tname\n']) assert.ok(s.includes(want), want);
  assert.ok(!s.includes('created'), 'a name record must not carry a timestamp (its hash must be stable)');
  const { app } = await b.loadApp(h1);
  assert.deepEqual([app.package, app.packageVersion], ['cowsay', '']);
  for (const [rt, name] of [['python', 'a;b'], ['python', '../x'], ['java', 'x'], ['nope', 'x']]) {
    await assert.rejects(b.nameRecord(rt, name), `${rt} ${name}`);
  }
  await assert.rejects(b.nameRecord('node', '@antfu/ni'), /scoped package names/);
  assert.notEqual(await b.nameRecord('node', 'cowsay'), h1, 'different runtimes must give different records');
  // A record is stored once: a different record with a hash already taken is refused.
  fs.writeFileSync(b.recordPath(h1), s.replace('cowsay', 'other'));
  await assert.rejects(b.nameRecord('python', 'cowsay'), /record hash collision/);
});

test('request checks: versions and scoped names', { skip }, (t) => {
  const env = builder(t, null).env();
  const r = { runtime: 'python', mode: 'C', source: { kind: 'package', value: 'requests', version: '2.32.3; echo INJECTED #' } };
  assert.throws(() => validate(r, env), /bad package version/);
  r.source.version = '2.32.3';
  assert.equal(validate(r, env), 'build');
  r.runtime = 'php';
  assert.throws(() => validate(r, env), /no package registry/);
  const s = { runtime: 'node', mode: 'C', source: { kind: 'package', value: ' @Antfu/ni ' } };
  validate(s, env);
  assert.equal(s.source.value, '@antfu/ni');
  for (const bad of ['@antfu/ni" & calc & "', '@antfu/ni;id', '@antfu/$(id)', '@antfu/ni@1.0.0', '@antfu/../x', '@antfu/ni\\x']) {
    assert.throws(() => validate({ runtime: 'node', mode: 'C', source: { kind: 'package', value: bad } }, env), bad);
  }
  // Classes by what was asked for, and mode A's lock rules.
  const inline = (o) => Object.assign({ runtime: 'python', source: { kind: 'inline' }, files: { 'a.py': 'x' } }, o);
  assert.equal(validate(inline({ mode: 'A' }), env), 'record');
  assert.equal(validate(inline({ mode: 'B' }), env), 'build');
  assert.equal(validate(inline({ mode: 'C', offline: true }), env), 'pack');
  assert.throws(() => validate(inline({ mode: 'A', offline: true }), env), /offline installers can't be signed by Installer Builder/);
  assert.throws(() => validate(inline({ mode: 'C', name: 'x\u202e' }), env), /control or text-direction/);
  assert.throws(() => validate(inline({ mode: 'C', runtime: 'constructor' }), env), /unknown runtime "constructor"/);
  // A written template's system prerequisites: ids from the policy's table.
  assert.equal(validate(inline({ mode: 'C', prerequisites: ['fontconfig', 'libxtst'] }), env), 'build');
  assert.throws(() => validate(inline({ mode: 'C', prerequisites: ['nope'] }), env), /unknown prerequisite "nope"/);
  assert.throws(() => validate(inline({ mode: 'C', prerequisites: ['constructor'] }), env), /unknown prerequisite/);
  assert.throws(() => validate(inline({ mode: 'C', prerequisites: 'fontconfig' }), env), /a list/);
});

test('a written template\'s prerequisites: in the record, and in the plan for their OS', { skip }, async (t) => {
  const b = builder(t, null);
  const r = { name: 'Swing', runtime: 'java', mode: 'A', source: { kind: 'inline' }, files: { 'Main.java': 'class Main {}' },
    launch: '{runtime} -cp {app_dir} Main', console: false, platforms: ['windows', 'linux'], prerequisites: ['fontconfig'] };
  const out = await b.run(r, () => {});
  const rec = fs.readFileSync(b.recordPath(out.record), 'utf8');
  assert.match(rec, /^prerequisites\tfontconfig$/m);
  const { app } = await b.loadApp(out.record);
  assert.deepEqual(app.prerequisites, ['fontconfig']);
  const plan = resolve(b.cat, app);
  const linux = plan.split('\n[target]\n').filter((x) => /^when\tlinux\t/m.test(x) && /^runtime\tjava\t/m.test(x));
  assert.ok(linux.length && linux.every((x) => /^need\tfontconfig\t/m.test(x) && /^nwhy\tThe app's own code needs it\.$/m.test(x)), plan);
  const windows = plan.split('\n[target]\n').filter((x) => /^when\twindows\t/m.test(x));
  assert.ok(windows.length && windows.every((x) => !/^need\tfontconfig/m.test(x)));
});

test('install rules from the files a source has', { skip }, (t) => {
  const b = builder(t, null);
  const pol = (rt) => b.cat.policy.runtimes[rt];
  const reqOnly = inlineTar('app', { 'main.py': 'import cowsay', 'requirements.txt': 'cowsay\n' }).names;
  const proj = tarNamesUnderTop(zlib.gzipSync(inlineTar('app', { 'pyproject.toml': '', 'requirements.txt': '', 'app/__init__.py': '' }).tar));
  const cases = [
    ['python', '', false, reqOnly, 'default:requirements'],
    ['python', '', false, proj, 'default:project'],
    ['python', '', false, ['main.py'], ''],
    ['python', '', false, ['main.py', 'setup.cfg'], ''],
    ['python', 'my own command', false, reqOnly, 'my own command'],
    ['python', '', true, null, 'default'],
    ['node', '', false, ['package.json', 'index.js'], 'default:npm'],
    ['ruby', '', false, ['Gemfile'], 'default:bundler'],
    ['php', '', false, ['composer.json', 'index.php'], null],
    ['php', 'php my-install.php', false, ['composer.json'], 'php my-install.php'],
    ['php', '', false, ['index.php'], ''],
    ['rust', '', false, null, 'default'],
    // Rules for the written templates (js/templates.js), ahead of a
    // compiled language's own command.
    ['java', '', false, ['Main.java'], 'default:javac'],
    ['nim', '', false, ['main.nim'], 'default:main'],
    ['nim', '', false, ['hello.nim'], 'default'],
    ['cc', '', false, ['main.cpp'], 'default:cpp'],
    ['cc', '', false, ['main.c'], 'default'],
    ['cc', '', true, ['main.cpp'], 'default'],
  ];
  for (const [rt, given, pkg, names, want] of cases) {
    if (want === null) assert.throws(() => projectInstall(pol(rt), given, pkg, names || []), `${rt} ${names}`);
    else assert.equal(projectInstall(pol(rt), given, pkg, names || []), want, `${rt} ${names}`);
  }
});

// A square PNG (made here), like icon_test.go's iconPNG.
function png(size) {
  const row = size * 4 + 1;
  const raw = Buffer.alloc(row * size);
  for (let i = 0; i < raw.length; i++) raw[i] = i % row === 0 ? 0 : i & 255;
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// As the server does on submit: check, store the icon, queue only its hash; then run.
async function iconJob(b, mode, pngBytes) {
  await import('../../vendor/resedit-bundle.js');
  const r = { name: 'Hello', runtime: 'python', mode, platforms: ['windows', 'linux', 'macos'], source: { kind: 'inline' },
    files: { 'hello/__main__.py': "print('hi')" }, icon: { choice: 'custom', data: pngBytes.toString('base64'), filename: 'x.png', type: 'image/png' } };
  validate(r, b.env());
  await b.storeIcon(r, new Uint8Array(pngBytes));
  assert.equal(r.icon.data, '');
  assert.match(r.icon.sha256, /^[0-9a-f]{64}$/);
  return { res: await b.run(r, () => {}), sha: r.icon.sha256 };
}

test('icons in mode C: in the .exe, the pack and the .app', { skip: skip || (!haveBases && 'no bases') }, async (t) => {
  const b = builder(t, null);
  const p = png(300);
  const { res, sha } = await iconJob(b, 'C', p);
  const rec = fs.readFileSync(b.recordPath(res.record), 'utf8');
  assert.match(rec, new RegExp('^icon\\t' + sha + '$', 'm'));
  assert.ok(fs.readFileSync(b.iconPath(sha)).equals(p), 'icon stored by its hash');
  const files = {};
  for (const f of res.files) files[f.platform] = new Uint8Array(fs.readFileSync(path.join(b.data, 'dl', res.record, f.name)));
  // Windows: icon group, block readable, checksum right, NSIS data kept.
  const exe = files.windows;
  const pe = peInfo(exe);
  assert.equal(new DataView(exe.buffer).getUint32(pe.checksumOff, true), peChecksum(exe, pe.checksumOff), 'PE checksum');
  const ie = await readInstaller(exe, 'x.exe');
  assert.equal(ie.record, rec);
  const base = fs.readFileSync(path.join(BASES, 'windows', 'out', 'base.exe'));
  assert.ok(Buffer.from(exe).includes(base.subarray(114176)), 'NSIS overlay not preserved');
  // Linux: the PNG in the pack under its hash.
  const ir = await readInstaller(files.linux, 'x.run');
  assert.equal(ir.record, rec);
  assert.deepEqual(ir.pack.map((m) => m.name), [sha]);
  assert.ok(Buffer.from(ir.pack[0].data).equals(p));
  // macOS: icns and plist, the launcher's exec bit kept, the signature dropped.
  const iz = await readInstaller(files.macos, 'x.zip');
  const by = (suffix) => iz.entries.find((e) => e.name.endsWith(suffix));
  assert.ok(Buffer.from(await zipEntryData(by('/Contents/Resources/AppIcon.icns'))).subarray(0, 4).equals(Buffer.from('icns')));
  assert.match(Buffer.from(await zipEntryData(by('/Contents/Info.plist'))).toString(), /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/);
  assert.ok((by('/Contents/MacOS/install').extAttr >>> 16) & 0o111, 'macOS launcher lost its exec bit');
  assert.ok(!iz.entries.some((e) => e.name.includes('_CodeSignature')));
  assert.equal(iz.record, rec);
});

test('icons in mode A: in the record, the files untouched', { skip: skip || (!haveBases && 'no bases') }, async (t) => {
  const b = builder(t, null);
  const { res, sha } = await iconJob(b, 'A', png(64));
  const rec = fs.readFileSync(b.recordPath(res.record), 'utf8');
  assert.match(rec, new RegExp('^icon\\t' + sha + '$', 'm'));
  for (const f of res.files) {
    assert.ok(f.name.includes('_' + res.record + '.'), 'the file name carries the record hash');
    const d = fs.readFileSync(path.join(b.data, 'dl', res.record, f.name));
    if (f.platform === 'windows') {
      const signed = path.join(BASES, 'windows', 'out', 'base-signed.exe');
      const want = fs.readFileSync(fs.existsSync(signed) ? signed : path.join(BASES, 'windows', 'out', 'base.exe'));
      assert.ok(d.equals(want), 'mode A exe changed');
      assert.equal(f.signed, fs.existsSync(signed) ? 'TiddlyInstall TEST' : '');
    } else if (f.platform === 'linux') {
      assert.ok(d.equals(fs.readFileSync(path.join(BASES, 'unix', 'out', 'ib-base.run'))), 'mode A .run changed');
    } else {
      assert.ok(!d.includes('AppIcon.icns') && d.includes('_CodeSignature'), 'mode A zip changed');
      assert.equal(f.signed, 'ad-hoc (test)');
    }
  }
});

test('icon checks', { skip }, async (t) => {
  const b = builder(t, null);
  const env = b.env();
  const mk = (icon) => validate({ runtime: 'python', mode: 'C', source: { kind: 'inline' }, files: { 'a.py': 'x' }, icon }, env);
  mk({ choice: 'terminal' });
  mk({ data: 'data:image/png;base64,' + png(32).toString('base64') });
  for (const [name, icon] of Object.entries({
    'not base64': { data: '!!!' },
    'not png': { data: Buffer.from('GIF89a......').toString('base64') },
    'too large': { data: 'A'.repeat(2 << 20) },
    'bad sha': { sha256: '../../etc/passwd' },
    'too small': { data: png(8).toString('base64') },
  })) assert.throws(() => mk(icon), name);
  // A hash with no stored icon fails the job, not the server.
  await assert.rejects(b.iconPng({ sha256: 'a'.repeat(64) }), /wasn't found/);
});

test('offline: the signed plan and the source packed, streamed to disk', { skip: skip || (!haveBases && 'no bases') }, async (t) => {
  const b = builder(t, null);
  // Only the app's source to pack: a plan for a runtime version that isn't
  // there has no downloads.
  const r = { name: 'Hello', runtime: 'python', mode: 'C', offline: true, select: 'range', range: '>=99', platforms: ['linux'],
    source: { kind: 'inline' }, files: { 'hello/__main__.py': "print('hi')" } };
  const res = await b.run(r, () => {});
  const f = res.files[0];
  assert.equal(f.offline, true);
  const d = fs.readFileSync(path.join(b.data, 'dl', res.record, f.name));
  assert.equal(d.length, f.size);
  const info = await readInstaller(new Uint8Array(d), f.name);
  const { verifyFor } = await import('../lib/plansig.js');
  verifyFor(b.signer.pub, Buffer.from(info.plan), res.record);
  const src = /^source\tinline\t(\S+)$/m.exec(info.record)[1];
  assert.deepEqual(info.pack.map((m) => m.name), [src]);
  assert.ok(Buffer.from(info.pack[0].data).equals(fs.readFileSync(b.srcPath(src))));
});
