// Ports the Go server's ibfile_test.go (retired: the metadata block and
// packs) for the server's streaming writer, and checks the tar reader
// against the cases Go's archive/tar handles.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { writeInstallerFile, ustarHeader, gzTarNames, tarNamesUnderTop, topFolder } from '../lib/files.js';
import { readInstaller, tarWrite, peChecksum, makeFooter } from '../../js/ibfile.js';
import { tmpDir } from './helpers.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

test('block: base, record, plan, pack, footer; read back', async (t) => {
  const d = tmpDir(t);
  const base = Buffer.from('#!/bin/sh\nexit 0\n');
  const a = Buffer.from('packed file one\n'), b = crypto.randomBytes(1500);
  fs.writeFileSync(path.join(d, 'b'), b);
  const out = path.join(d, 'x.run');
  const s = await writeInstallerFile(out, { base, record: Buffer.from('ib-record\t1\n'), plan: Buffer.from('ib-plan\t1\n'),
    pack: [{ name: sha(a), size: a.length, data: a }, { name: sha(b), size: b.length, path: path.join(d, 'b') }] });
  const f = fs.readFileSync(out);
  assert.equal(s.size, f.length);
  assert.equal(s.sha256, sha(f));
  const info = await readInstaller(new Uint8Array(f), 'x.run');
  assert.equal(info.record, 'ib-record\t1\n');
  assert.equal(info.plan, 'ib-plan\t1\n');
  assert.deepEqual(info.pack.map((m) => m.name), [sha(a), sha(b)]);
  assert.ok(Buffer.from(info.pack[1].data).equals(b));
  // The pack is the browser's tar, byte for byte (and so Go's).
  const start = base.length + 12 + 10;
  const tar = Buffer.from(tarWrite([{ name: sha(a), data: a }, { name: sha(b), data: b }]));
  assert.ok(f.subarray(start, start + tar.length).equals(tar));
  assert.equal(f.length, start + tar.length + 64);
  assert.equal(makeFooter(1, 2, 3).length, 64);
  // A base that already has a block is refused.
  await assert.rejects(writeInstallerFile(path.join(d, 'y'), { base: f, record: Buffer.from('R'), plan: Buffer.alloc(0), pack: [] }), /already has a metadata block/);
});

test('a pack file whose size is wrong is refused, and nothing is left', async (t) => {
  const d = tmpDir(t);
  fs.writeFileSync(path.join(d, 'b'), 'abc');
  await assert.rejects(writeInstallerFile(path.join(d, 'x'), { base: Buffer.from('x'), record: Buffer.from('R'), plan: Buffer.alloc(0),
    pack: [{ name: 'a'.repeat(64), size: 5, path: path.join(d, 'b') }] }), /wrote 3 of 5/);
  assert.deepEqual(fs.readdirSync(d), ['b']);
});

test('the PE checksum is made over the whole file', async (t) => {
  const d = tmpDir(t);
  const pe = Buffer.alloc(1025);
  pe[0] = 0x4d; pe[1] = 0x5a;
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80, 'latin1');
  pe.writeUInt16LE(0x20b, 0x80 + 24);
  for (let i = 0x200; i < pe.length; i++) pe[i] = (i * 7) & 255;
  const off = 0x80 + 24 + 64;
  const out = path.join(d, 'x.exe');
  const pack = crypto.randomBytes(3333);
  await writeInstallerFile(out, { base: pe, record: Buffer.from('R\n'), plan: Buffer.alloc(0),
    pack: [{ name: sha(pack), size: pack.length, data: pack }], fixChecksum: true, checksumOff: off });
  const f = new Uint8Array(fs.readFileSync(out));
  assert.equal(Buffer.from(f).readUInt32LE(off), peChecksum(f, off));
});

test('ustar headers are the browser\'s (and Go\'s)', () => {
  const data = Buffer.from('hello');
  assert.ok(ustarHeader(sha(data), data.length).equals(Buffer.from(tarWrite([{ name: sha(data), data }]).subarray(0, 512))));
});

// A tar entry for the reader tests.
function entry(name, data, type = '0', extra = {}) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0);
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  const magic = extra.magic ?? 'ustar\0';
  h.write(magic, 257, 'latin1');
  if (magic === 'ustar\0') h.write('00', 263);
  if (extra.prefix) h.write(extra.prefix, 345);
  let s = 0;
  for (const x of h) s += x;
  h.write(s.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([h, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

// PAX records: "<len> key=value\n", the length counting itself.
function pax(kv) {
  return Buffer.from(Object.entries(kv).map(([k, v]) => {
    const body = ' ' + k + '=' + v + '\n';
    let n = body.length + 1;
    while (String(n).length + body.length !== n) n = String(n).length + body.length;
    return n + body;
  }).join(''));
}

test('tar names as Go\'s archive/tar reads them', () => {
  // A GitHub archive: a PAX global header first, then one top folder.
  const gh = zlib.gzipSync(Buffer.concat([
    entry('pax_global_header', pax({ comment: '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d' }), 'g'),
    entry('octocat-Hello-World-7fd1a60/', Buffer.alloc(0), '5'),
    entry('octocat-Hello-World-7fd1a60/README', Buffer.from('Hello World!\n')),
    Buffer.alloc(1024)]));
  assert.deepEqual(gzTarNames(gh), ['pax_global_header', 'octocat-Hello-World-7fd1a60/', 'octocat-Hello-World-7fd1a60/README']);
  assert.deepEqual(tarNamesUnderTop(gh), ['pax_global_header', '', 'README']);
  assert.equal(topFolder(gh), 0, 'Go counts the global header as a top-level name');
  // Long names: a ustar prefix, a PAX path (and size), a GNU long name.
  const t2 = zlib.gzipSync(Buffer.concat([
    entry('setup.py', Buffer.from('x'), '0', { prefix: 'p/' + 'd'.repeat(120) }),
    entry('PaxHeaders/x', pax({ path: 'p/pax-name.txt' }), 'x'),
    entry('short', Buffer.from('abc')),
    entry('././@LongLink', Buffer.from('p/gnu-' + 'n'.repeat(100) + '\0'), 'L', { magic: 'ustar  \0' }),
    entry('p/gnu-trunc', Buffer.from('y'), '0', { magic: 'ustar  \0' }),
    Buffer.alloc(1024)]));
  assert.deepEqual(gzTarNames(t2), ['p/' + 'd'.repeat(120) + '/setup.py', 'p/pax-name.txt', 'p/gnu-' + 'n'.repeat(100)]);
  assert.equal(topFolder(t2), 1);
  const plain = (...names) => zlib.gzipSync(Buffer.concat([...names.map((n) => entry(n, Buffer.alloc(0))), Buffer.alloc(1024)]));
  assert.equal(topFolder(plain('a/x', 'b/y')), 0);
  assert.equal(topFolder(plain('./a/x', 'a/y')), 1);
  // Not gzip, or a bad checksum: nothing more, as Go stops at the first error.
  assert.equal(gzTarNames(Buffer.from('plain')), null);
  const bad = entry('a/x', Buffer.alloc(0));
  bad[0] = 0x62;
  assert.deepEqual(gzTarNames(zlib.gzipSync(Buffer.concat([bad, Buffer.alloc(1024)]))), []);
});
