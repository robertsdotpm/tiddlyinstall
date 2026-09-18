// Unit tests for js/ibfile.js. Open tests/ibfile.html over http (ES modules
// don't load from file://), or headless:
//   google-chrome --headless=new --virtual-time-budget=20000 --dump-dom http://127.0.0.1:8093/tests/ibfile.html
import * as ib from '../js/ibfile.js';
import { FX } from './fixtures.js';

const out = document.getElementById('out');
let passed = 0, failed = 0;
function log(line) { out.textContent += line + '\n'; }
function ok(cond, name, extra) {
  if (cond) { passed++; log('PASS ' + name); }
  else { failed++; log('FAIL ' + name + (extra !== undefined ? ' -- ' + extra : '')); }
}
function eqBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const td = new TextDecoder();

async function run(name, fn) {
  try { await fn(); } catch (e) { failed++; log('FAIL ' + name + ' threw: ' + (e && e.stack || e)); }
}

const RECORD = 'ib-record\t1\nname\tHello Test\nproject\thello\nruntime\tpython\nlaunch\t{runtime} -m hello\n';
const PLAN = 'ib-plan\t1\nrecord\tabc\n\n[target]\nwhen\tlinux\t0\t9999\t*\n';

await run('hashes', async () => {
  ok(ib.base32(await ib.sha256(new Uint8Array(0))) === FX.emptyB32, 'base32(sha256("")) matches Python');
  ok(await ib.recordHash(FX.recordText) === FX.recordHash, 'recordHash matches Python', await ib.recordHash(FX.recordText));
  ok((await ib.recordHash('x')).length === 26 && /^[a-z2-7]+$/.test(await ib.recordHash('x')), 'recordHash is 26 base32 chars');
  ok(ib.base32(new Uint8Array([0x66, 0x6f, 0x6f, 0x62, 0x61])) === 'mzxw6ytb', 'base32 RFC 4648 vector "fooba"');
  ok(ib.base32(new Uint8Array([0x66])) === 'my', 'base32 RFC 4648 vector "f" (no padding)');
});

await run('footer', async () => {
  const f = ib.makeFooter(12, 0, 1024);
  ok(f.length === 64 && f[63] === 10, 'footer is 64 bytes ending in \\n');
  ok(td.decode(f).startsWith('IBMETA1 000000000012 000000000000 000000001024 '), 'footer text', td.decode(f));
  const buf = ib.concatBytes([new Uint8Array(100), new Uint8Array(12 + 1024), f]);
  const p = ib.parseFooter(buf);
  ok(p && p.start === 100 && p.record === 12 && p.plan === 0 && p.pack === 1024, 'footer parses back');
  const bad = f.slice(); bad[10] = 0x41;
  ok(ib.parseFooter(ib.concatBytes([new Uint8Array(2000), bad])) === null, 'non-digit length rejected');
  ok(ib.parseFooter(ib.concatBytes([new Uint8Array(10), f])) === null, 'lengths longer than the file rejected');
  let threw = false;
  try { ib.makeFooter(1e12, 0, 0); } catch (e) { threw = true; }
  ok(threw, 'length over 12 digits refused');
});

await run('pe checksum', async () => {
  const pe = unb64(FX.pe);
  ok(ib.peInfo(pe) && ib.peInfo(pe).checksumOff === FX.peChecksumOff, 'peInfo finds checksum field');
  ok(ib.peChecksum(pe, FX.peChecksumOff) === FX.peChecksum, 'PE checksum matches ' + FX.peChecksumFrom, ib.peChecksum(pe, FX.peChecksumOff));
  const odd = ib.concatBytes([pe, new Uint8Array([7])]);
  ok(ib.peChecksum(odd, FX.peChecksumOff) > 0, 'odd-length checksum computes');
});

await run('tar', async () => {
  const members = ib.tarRead(unb64(FX.tar));
  ok(members.length === 2 && members[0].name === FX.tarNames[0] && members[1].name === FX.tarNames[1], 'reads Python ustar names');
  ok(await ib.sha256Hex(members[1].data) === FX.tarNames[1], 'Python tar member content hashes to its name');
  const mine = [await ib.packMember('one'), await ib.packMember(new Uint8Array(1000).fill(9)), await ib.packMember('')];
  const t = ib.tarWrite(mine);
  ok(t.length % 512 === 0, 'tar length is a multiple of 512');
  const back = ib.tarRead(t);
  ok(back.length === 3 && back.every((m, i) => m.name === mine[i].name && eqBytes(m.data, ib.toBytes(mine[i].data))), 'tar round trip');
  ok(td.decode(t.subarray(257, 262)) === 'ustar', 'ustar magic');
  document.getElementById('artifact-tar').textContent = b64(t);
});

await run('record kv', async () => {
  const e = ib.parseKv('ib-record\t1\n# comment\nname\tA\nunknown\tx\ty\n\n');
  ok(ib.kvGet(e, 'name')[0] === 'A' && ib.kvGet(e, 'unknown').join(',') === 'x,y', 'parse keys and values');
  ib.kvSet(e, 'name', ['B\tC']);
  ib.kvSet(e, 'menu', ['1']);
  ib.kvSet(e, 'unknown', null);
  ok(ib.serializeKv(e) === 'ib-record\t1\n# comment\nname\tB C\n\nmenu\t1\n', 'set/remove keeps order, comments, strips tabs', JSON.stringify(ib.serializeKv(e)));
  ok(ib.newRecordText({ name: 'N', menu: '1' }) === 'ib-record\t1\nname\tN\nmenu\t1\n', 'new record text');
});

await run('plan binding', async () => {
  const rec = 'ib-record\t1\nname\tA\n';
  const h = await ib.recordHash(rec);
  const signed = 'ib-plan\t1\nrecord\t' + h + '\nname\tA\n\n[target]\nwhen\tlinux\t0\t9999\t*\nsig\ted25519\t' + 'A'.repeat(86) + '==\n';
  let r = await ib.bindPlan(signed, rec, false);
  ok(!r.changed && r.plan === signed, 'untouched plan keeps its bytes and signature');
  r = await ib.bindPlan(signed, 'ib-record\t1\nname\tB\n', false);
  const h2 = await ib.recordHash('ib-record\t1\nname\tB\n');
  ok(r.changed && r.plan.includes('record\t' + h2 + '\n') && !r.plan.includes('sig\t'), 'edited record: record line updated, signature dropped', r.plan);
  r = await ib.bindPlan(signed.replace('linux', 'macos'), rec, true);
  ok(r.changed && !r.plan.includes('sig\t') && r.plan.endsWith('*\n'), 'edited plan: signature dropped');
  r = await ib.bindPlan('ib-plan\t1\nname\tA\n', rec, false);
  ok(r.plan.startsWith('ib-plan\t1\nrecord\t' + h + '\n'), 'missing record line added');
  ok(ib.stripPlanSig('ib-plan\t1\nx\ty\n') === 'ib-plan\t1\nx\ty\n', 'unsigned plan unchanged by stripPlanSig');
});

await run('linux .run', async () => {
  const base = ib.toBytes('#!/bin/sh\n# base\nexit 0\n' + 'x'.repeat(300));
  const info0 = await ib.readInstaller(base, 'a.run');
  ok(info0.kind === 'run' && info0.record === null && eqBytes(info0.base, base), 'plain base has no block');
  const pack = [await ib.packMember('packed one'), await ib.packMember('packed two')];
  const f1 = await ib.writeInstaller(info0, { record: RECORD, plan: PLAN, pack });
  ok(f1.length === base.length + ib.toBytes(RECORD).length + ib.toBytes(PLAN).length + ib.tarWrite(pack).length + 64, 'block size is exact');
  const info1 = await ib.readInstaller(f1, 'a.run');
  ok(info1.record === RECORD && info1.plan === PLAN, 'record and plan read back');
  ok(info1.pack.length === 2 && td.decode(info1.pack[1].data) === 'packed two', 'pack read back');
  ok(eqBytes(info1.base, base), 'base unchanged');
  const f2 = await ib.writeInstaller(info1, { record: RECORD.replace('Hello Test', 'Renamed'), plan: '', pack: [] });
  const info2 = await ib.readInstaller(f2, 'a.run');
  ok(info2.record.includes('Renamed') && info2.plan === null && info2.pack.length === 0 && eqBytes(info2.base, base), 'rewrite replaces the old block');
  ok(f2.length === base.length + ib.toBytes(RECORD.replace('Hello Test', 'Renamed')).length + 64, 'no leftovers of the old block');
});

await run('windows .exe unsigned', async () => {
  const pe = unb64(FX.pe);
  const info0 = await ib.readInstaller(pe, 'b.exe');
  ok(info0.kind === 'exe' && !info0.signed && info0.record === null, 'unsigned PE with no block');
  const f1 = await ib.writeInstaller(info0, { record: RECORD, pack: [await ib.packMember('p')] });
  const dv = new DataView(f1.buffer);
  ok(dv.getUint32(FX.peChecksumOff, true) === ib.peChecksum(f1, FX.peChecksumOff), 'checksum updated after append');
  const info1 = await ib.readInstaller(f1, 'b.exe');
  ok(info1.record === RECORD && info1.plan === null && info1.pack.length === 1, 'exe block reads back');
  ok(eqBytes(info1.base.subarray(512), pe.subarray(512)), 'body after header untouched');
});

await run('windows .exe signed', async () => {
  // [pe][block][NUL padding to 8][certificate table], as signtool leaves it.
  const pe = unb64(FX.pe);
  const blockFile = await ib.writeInstaller(await ib.readInstaller(pe, 'c.exe'), { record: RECORD });
  const padLen = (8 - (blockFile.length % 8)) % 8 || 8 - 1;   // make sure some padding exists
  const cert = new Uint8Array(40).fill(0xcc);
  const signed = ib.concatBytes([blockFile, new Uint8Array(padLen), cert]);
  const info = ib.peInfo(signed);
  const dv = new DataView(signed.buffer);
  dv.setUint32(info.certDirOff, blockFile.length + padLen, true);
  dv.setUint32(info.certDirOff + 4, cert.length, true);
  const r = await ib.readInstaller(signed, 'c.exe');
  ok(r.signed && /signature/.test(r.signedWhy), 'certificate table detected, with a warning');
  ok(r.record === RECORD, 'block found before the certificate table, skipping ' + padLen + ' NULs');
  const w = await ib.writeInstaller(r, { record: RECORD + 'desktop\t1\n' });
  const wi = ib.peInfo(w);
  ok(wi.certOffset === 0 && wi.certSize === 0, 'certificate directory cleared on save');
  ok(!w.subarray(w.length - 200).includes(0xcc), 'certificate bytes removed');
  const back = await ib.readInstaller(w, 'c.exe');
  ok(!back.signed && back.record.endsWith('desktop\t1\n'), 'saved file reads back unsigned');

  // Signed, no block: the base ends where the table starts.
  const s2 = ib.concatBytes([pe, cert]);
  const d2 = new DataView(s2.buffer);
  const i2 = ib.peInfo(s2);
  d2.setUint32(i2.certDirOff, pe.length, true);
  d2.setUint32(i2.certDirOff + 4, cert.length, true);
  const r2 = await ib.readInstaller(s2, 'd.exe');
  ok(r2.signed && r2.record === null && r2.base.length === pe.length, 'signed base without a block');
});

await run('macOS .zip', async () => {
  const z = unb64(FX.zip);
  const entries = ib.zipRead(z);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  ok(ib.zipIsSymlink(byName['Install.app/Contents/Resources/current']), 'reads a symlink from Python zip');
  ok((ib.zipUnixMode(byName['Install.app/Contents/MacOS/install']) & 0o777) === 0o755, 'reads exec permission');
  ok(td.decode(await ib.zipEntryData(byName['Install.app/Contents/Info.plist'])).startsWith('<plist>'), 'inflates a deflated entry');

  const info0 = await ib.readInstaller(z, 'Install.zip');
  ok(info0.kind === 'zip' && info0.app === 'Install.app/' && info0.record === null && !info0.signed, 'finds the .app, no record yet');
  const pack = [await ib.packMember('mac packed'), await ib.packMember(new Uint8Array(5000).fill(65))];
  const w = await ib.writeInstaller(info0, { record: RECORD, plan: PLAN, pack });
  const info1 = await ib.readInstaller(w, 'Install.zip');
  ok(info1.record === RECORD && info1.plan === PLAN, 'record.txt and plan.txt read back');
  ok(info1.pack.length === 2 && info1.pack[1].data.length === 5000 && info1.pack[1].name === pack[1].name, 'pack/ files read back');
  const e1 = Object.fromEntries(ib.zipRead(w).map((e) => [e.name, e]));
  ok(ib.zipIsSymlink(e1['Install.app/Contents/Resources/current']) &&
     td.decode(await ib.zipEntryData(e1['Install.app/Contents/Resources/current'])) === '../MacOS/install', 'symlink preserved');
  ok((ib.zipUnixMode(e1['Install.app/Contents/MacOS/install']) & 0o777) === 0o755, 'exec permission preserved');
  ok(e1['Install.app/Contents/Resources/ib/pack/' + pack[1].name].method === 8, 'compressible pack file deflated');
  ok(e1['Install.app/Contents/Resources/ib/record.txt'].usize === ib.toBytes(RECORD).length, 'record.txt size');
  const w2 = await ib.writeInstaller(info1, { record: RECORD, plan: '', pack: [] });
  const n2 = ib.zipRead(w2).map((e) => e.name);
  ok(!n2.some((n) => n.includes('/ib/pack')) && !n2.some((n) => n.endsWith('plan.txt')), 'rewrite drops removed plan and pack');
  document.getElementById('artifact-zip').textContent = b64(w);

  // A signed app is flagged.
  const sig = await ib.zipNewEntry('Install.app/Contents/_CodeSignature/CodeResources', 'x');
  const zs = ib.zipWrite(entries.concat([sig]));
  ok((await ib.readInstaller(zs, 's.zip')).signed, 'code-signed .app flagged');
});

await run('detect', async () => {
  ok(ib.detectKind(unb64(FX.pe)) === 'exe', 'MZ is exe');
  ok(ib.detectKind(unb64(FX.zip)) === 'zip', 'PK is zip');
  ok(ib.detectKind(ib.toBytes('#!/bin/sh\n')) === 'run', 'script is run');
});

const s = document.getElementById('summary');
s.textContent = failed ? `FAIL ${failed} failed, ${passed} passed` : `PASS all ${passed}`;
s.className = failed ? 'status fail' : 'status ok';
document.title = s.textContent;
