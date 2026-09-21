// The plain-JavaScript fallbacks (src/web_client/lib/inflate.js, deflate.js, zlib.js, sha.js,
// hmac-pbkdf2.js, aes.js, bignum.js, rsa.js, ec.js, ed25519.js, cryptox.js,
// has-shim.js, polyfills.js's TextDecoder) against the native versions: Node's zlib and WebCrypto,
// openssl and published test vectors.
//
//   node tests/fallback-test.mjs [--quick]
//
// Needs Node 20+ and openssl. --quick uses fewer random cases.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inflate } from '../src/web_client/lib/inflate.js';
import { deflate } from '../src/web_client/lib/deflate.js';
import * as Z from '../src/web_client/lib/zlib.js';
import { sha } from '../src/web_client/lib/sha.js';
import { hmac, pbkdf2 } from '../src/web_client/lib/hmac-pbkdf2.js';
import * as AES from '../src/web_client/lib/aes.js';
import * as B from '../src/web_client/lib/bignum.js';
import * as RSA from '../src/web_client/lib/rsa.js';
import * as EC from '../src/web_client/lib/ec.js';
import * as ED from '../src/web_client/lib/ed25519.js';
import * as X from '../src/web_client/lib/cryptox.js';
import { convertCss, specificity } from '../src/web_client/has-shim.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');
const N = QUICK ? 3 : 20;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-fallback-'));

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? ' -- ' + String(extra).slice(0, 400) : '')); }
}
async function run(name, fn) {
  try { await fn(); } catch (e) { failed++; console.log('FAIL ' + name + ' threw: ' + (e && e.stack || e)); }
}
const hx = (u) => Buffer.from(u).toString('hex');
const unhex = (h) => new Uint8Array(Buffer.from(h.replace(/\s+/g, ''), 'hex'));
const eq = (a, b) => a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const rnd = (n) => new Uint8Array(crypto.randomBytes(n));
const te = new TextEncoder();
const sub = crypto.webcrypto.subtle;
const nodeHash = (h) => h.replace('-', '').toLowerCase();

// Inputs of various shapes: empty, tiny, random, runs, text, code, binary.
function samples() {
  const out = [new Uint8Array(0), new Uint8Array([0]), rnd(1), rnd(70000), new Uint8Array(300000).fill(97),
    te.encode('hello hello hello world '.repeat(4000)), new Uint8Array(fs.readFileSync(path.join(REPO, 'src/shared/resolve.js'))),
    new Uint8Array(fs.readFileSync(process.execPath).subarray(0, 2e6))];
  for (let i = 0; i < N; i++) {
    const n = (i * 7919) % 90000;
    const b = new Uint8Array(n);
    for (let j = 0; j < n; j++) b[j] = Math.random() < 0.6 ? 97 + (j % (i + 2)) : (Math.random() * 256) | 0;
    out.push(b);
  }
  return out;
}

/* ---------- compression ---------- */

const FORMATS = [['deflate-raw', zlib.deflateRawSync, zlib.inflateRawSync], ['deflate', zlib.deflateSync, zlib.inflateSync],
  ['gzip', zlib.gzipSync, zlib.gunzipSync]];

await run('zlib', async () => {
  let bad = [];
  for (const d of samples()) {
    for (const [fmt, comp, decomp] of FORMATS) {
      for (const level of [0, 1, 6, 9]) {
        if (!eq(inflate(new Uint8Array(comp(d, { level })), fmt), d)) bad.push('inflate ' + fmt + ' level ' + level + ' n=' + d.length);
      }
      const mine = deflate(d, fmt);
      if (!eq(new Uint8Array(decomp(mine)), d)) bad.push('deflate->native ' + fmt + ' n=' + d.length);
      if (!eq(inflate(mine, fmt), d)) bad.push('deflate->inflate ' + fmt + ' n=' + d.length);
    }
  }
  ok(!bad.length, 'inflate/deflate against Node zlib: every format, levels 0-9, ' + samples().length + ' inputs', bad.slice(0, 5).join('; '));

  // Native CompressionStream output inflates with the plain code, and back.
  bad = [];
  for (const d of samples().slice(0, 8)) {
    for (const [fmt] of FORMATS) {
      const n = new Uint8Array(await new Response(new Blob([d]).stream().pipeThrough(new CompressionStream(fmt))).arrayBuffer());
      if (!eq(inflate(n, fmt), d)) bad.push('native stream -> inflate ' + fmt);
      const back = new Uint8Array(await new Response(new Blob([deflate(d, fmt)]).stream().pipeThrough(new DecompressionStream(fmt))).arrayBuffer());
      if (!eq(back, d)) bad.push('deflate -> native stream ' + fmt);
    }
  }
  ok(!bad.length, 'plain code against CompressionStream/DecompressionStream', bad.join('; '));

  const cat = new Uint8Array(zlib.gzipSync('abc')), cat2 = new Uint8Array(Buffer.concat([zlib.gzipSync('abc'), zlib.gzipSync('def')]));
  ok(new TextDecoder().decode(inflate(cat2, 'gzip')) === 'abcdef' && inflate(cat, 'gzip').length === 3, 'concatenated gzip members');
  const corrupt = new Uint8Array(zlib.gzipSync(rnd(5000)));
  corrupt[corrupt.length - 6] ^= 1;
  let threw = '';
  try { inflate(corrupt, 'gzip'); } catch (e) { threw = e.message; }
  ok(/CRC/.test(threw), 'a damaged gzip is refused (CRC)', threw);
  const zc = new Uint8Array(zlib.deflateSync(rnd(3000)));
  zc[zc.length - 1] ^= 1;
  threw = '';
  try { inflate(zc, 'deflate'); } catch (e) { threw = e.message; }
  ok(/checksum/.test(threw), 'a damaged zlib stream is refused (Adler-32)', threw);
  threw = '';
  try { inflate(rnd(200), 'deflate-raw'); } catch (e) { threw = e.message; }
  ok(/inflate/.test(threw), 'random bytes are not inflated', threw);

  // The real catalogue snapshot, if a build folder is named.
  const catDir = process.env.TI_CATALOG_DIR;
  const snap = catDir && path.join(catDir, 'catalog.gz');
  if (snap && fs.existsSync(snap)) {
    const g = new Uint8Array(fs.readFileSync(snap));
    const t = Date.now();
    const mine = inflate(g, 'gzip');
    ok(eq(mine, zlib.gunzipSync(g)), 'catalog.gz inflates the same (' + g.length + ' -> ' + mine.length + ' bytes, ' + (Date.now() - t) + ' ms)');
  } else console.log('SKIP catalog.gz (set TI_CATALOG_DIR to the folder with catalog.gz)');

  // A zip made by another tool: every entry inflates with the plain code.
  const zipPy = path.join(TMP, 'z.zip');
  const py = spawnSync('python3', ['-c', `import zipfile,sys,os
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
  for f in sorted(os.listdir(sys.argv[2]))[:25]: z.write(os.path.join(sys.argv[2],f), f)`, zipPy, path.join(REPO, 'src', 'web_client', 'lib')]);
  if (py.status === 0) {
    const zb = new Uint8Array(fs.readFileSync(zipPy)), dv = new DataView(zb.buffer, zb.byteOffset);
    let o = 0, n = 0, badz = 0;
    while (dv.getUint32(o, true) === 0x04034b50) {
      const method = dv.getUint16(o + 8, true), csize = dv.getUint32(o + 18, true), nl = dv.getUint16(o + 26, true), xl = dv.getUint16(o + 28, true);
      const name = new TextDecoder().decode(zb.subarray(o + 30, o + 30 + nl));
      const data = zb.subarray(o + 30 + nl + xl, o + 30 + nl + xl + csize);
      const got = method === 8 ? inflate(data, 'deflate-raw') : data;
      if (!eq(got, new Uint8Array(fs.readFileSync(path.join(REPO, 'src', 'web_client', 'lib', name))))) badz++;
      n++; o += 30 + nl + xl + csize;
    }
    ok(n > 5 && !badz, 'zip entries written by Python inflate (' + n + ' entries)');
  }

  // src/web_client/lib/zlib.js: native in Node; with TI_PURE_JS the plain path, same bytes out.
  const d = samples()[6];
  ok(Z.nativeFor('gzip').inflate && Z.nativeFor('deflate-raw').deflate, 'zlib.js takes the native streams in Node');
  const nat = await Z.deflate(d, 'gzip');
  globalThis.TI_PURE_JS = true;
  ok(!Z.nativeFor('gzip').inflate, 'TI_PURE_JS turns the native streams off');
  const pureOut = await Z.inflate(nat, 'gzip'), pureComp = await Z.deflate(d, 'deflate-raw');
  delete globalThis.TI_PURE_JS;
  ok(eq(pureOut, d) && eq(await Z.inflate(pureComp, 'deflate-raw'), d), 'zlib.js round trip across the native and plain paths');
});

/* ---------- hashes, HMAC, PBKDF2, AES ---------- */

await run('sha', async () => {
  // FIPS 180 examples: "abc" and the 448/896-bit messages.
  const KAT = {
    'SHA-1': ['a9993e364706816aba3e25717850c26c9cd0d89d', '84983e441c3bd26ebaae4aa1f95129e5e54670f1'],
    'SHA-256': ['ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
    'SHA-384': ['cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
      '09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039'],
    'SHA-512': ['ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
      '8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909'],
  };
  const m2 = { 'SHA-1': 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', 'SHA-256': 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    'SHA-384': 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'SHA-512': 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu' };
  for (const h of Object.keys(KAT)) {
    ok(hx(sha(h, te.encode('abc'))) === KAT[h][0] && hx(sha(h, te.encode(m2[h]))) === KAT[h][1], h + ' FIPS 180 examples');
    let bad = 0;
    for (const n of [0, 1, 55, 56, 63, 64, 65, 111, 112, 119, 127, 128, 129, 1000, 65537]) {
      const d = rnd(n);
      if (hx(sha(h, d)) !== hx(new Uint8Array(await sub.digest(h, d)))) bad++;
    }
    ok(!bad, h + ' against WebCrypto at block boundaries', bad);
  }
});

await run('hmac-pbkdf2', async () => {
  // RFC 4231 test cases 1, 2 and 6 (key longer than a block).
  const k6 = new Uint8Array(131).fill(0xaa);
  const m6 = te.encode('Test Using Larger Than Block-Size Key - Hash Key First');
  const V = [
    [new Uint8Array(20).fill(0x0b), te.encode('Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
      '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cdedaa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854'],
    [te.encode('Jefe'), te.encode('what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
      '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea2505549758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737'],
    [k6, m6, '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
      '80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f3526b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598'],
  ];
  let good = true;
  for (const [k, m, s256, s512] of V) good = good && hx(hmac('SHA-256', k, m)) === s256 && hx(hmac('SHA-512', k, m)) === s512;
  ok(good, 'HMAC RFC 4231 vectors (SHA-256, SHA-512)');
  let bad = 0;
  for (const h of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
    for (const kl of [0, 1, 64, 65, 128, 129]) {
      const k = rnd(kl), d = rnd(3 * kl + 1);
      if (hx(hmac(h, k, d)) !== crypto.createHmac(nodeHash(h), k).update(d).digest('hex')) bad++;
    }
  }
  ok(!bad, 'HMAC against Node for SHA-1/256/384/512 and key lengths 0-129', bad);
  // RFC 6070 (PBKDF2-HMAC-SHA1).
  const P = [['password', 'salt', 1, 20, '0c60c80f961f0e71f3a9b524af6012062fe037a6'],
    ['password', 'salt', 4096, 20, '4b007901b765489abead49d926f721d065a429c1'],
    ['passwordPASSWORDpassword', 'saltSALTsaltSALTsaltSALTsaltSALTsalt', 4096, 25, '3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038'],
    ['pass\0word', 'sa\0lt', 4096, 16, '56fa6aa75548099dcc37d7f03425e0c3']];
  ok(P.every(([p, s, c, n, w]) => hx(pbkdf2('SHA-1', te.encode(p), te.encode(s), c, n)) === w), 'PBKDF2 RFC 6070 vectors');
  bad = 0;
  for (const h of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
    for (const [it, len] of [[1, 16], [2048, 32], [1000, 77]]) {
      const pw = rnd(11), salt = rnd(16);
      if (hx(pbkdf2(h, pw, salt, it, len)) !== crypto.pbkdf2Sync(pw, salt, it, len, nodeHash(h)).toString('hex')) bad++;
    }
  }
  ok(!bad, 'PBKDF2 against Node (SHA-1/256/384/512, 1-2048 iterations)', bad);
});

await run('aes', async () => {
  // FIPS 197 appendix C.
  const pt = unhex('00112233445566778899aabbccddeeff');
  const C = [['000102030405060708090a0b0c0d0e0f', '69c4e0d86a7b0430d8cdb78070b4c55a'],
    ['000102030405060708090a0b0c0d0e0f1011121314151617', 'dda97ca4864cdfe06eaf70a0ec0d7191'],
    ['000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', '8ea2b7ca516745bfeafc49904b496089']];
  ok(C.every(([k, c]) => hx(AES.aesEncryptBlock(unhex(k), pt)) === c), 'AES FIPS 197 C.1-C.3 (128, 192, 256)');
  let bad = [];
  for (const kl of [16, 24, 32]) {
    for (const n of [0, 1, 15, 16, 17, 100, 4099]) {
      const k = rnd(kl), iv = rnd(16), d = rnd(n);
      const c = crypto.createCipheriv('aes-' + kl * 8 + '-cbc', k, iv);
      const ref = new Uint8Array(Buffer.concat([c.update(d), c.final()]));
      if (!eq(AES.aesCbcEncrypt(k, iv, d), ref)) bad.push('cbc enc ' + kl + '/' + n);
      if (!eq(AES.aesCbcDecrypt(k, iv, ref), d)) bad.push('cbc dec ' + kl + '/' + n);
      const f = crypto.createCipheriv('aes-' + kl * 8 + '-cfb', k, iv);
      const cf = new Uint8Array(Buffer.concat([f.update(d), f.final()]));
      if (!eq(AES.aesCfb(k, iv, d, false), cf) || !eq(AES.aesCfb(k, iv, cf, true), d)) bad.push('cfb ' + kl + '/' + n);
    }
  }
  ok(!bad.length, 'AES-CBC and AES-CFB against Node (128/192/256, 0-4099 bytes)', bad.join(' '));
  // A wrong key fails the padding check (as WebCrypto's OperationError).
  let wrong = 0;
  for (let i = 0; i < 50; i++) {
    const k = rnd(32), iv = rnd(16), c = AES.aesCbcEncrypt(k, iv, rnd(40));
    try { AES.aesCbcDecrypt(rnd(32), iv, c); } catch (e) { wrong++; }
  }
  ok(wrong >= 45, 'AES-CBC with a wrong key is refused (' + wrong + '/50; a few pass by chance)');
});

/* ---------- bignum, RSA, ECDSA, Ed25519 ---------- */

await run('bignum', async () => {
  const big = (u8) => (u8.length ? BigInt('0x' + hx(u8)) : 0n);
  const toB = (x) => big(B.toBytes(x));
  const bad = [];
  for (let it = 0; it < (QUICK ? 60 : 400); it++) {
    const la = 1 + (it % 97), lb = 1 + ((it * 7) % 61);
    const a8 = rnd(la), b8 = rnd(lb);
    b8[lb - 1] |= 1;
    const a = B.fromBytes(a8), b = B.fromBytes(b8), A = big(a8), Bn = big(b8);
    if (toB(a) !== A || !eq(B.toBytes(a, la), a8)) bad.push('bytes');
    if (toB(B.add(a, b)) !== A + Bn) bad.push('add');
    if (toB(B.mul(a, b)) !== A * Bn) bad.push('mul');
    if (A >= Bn && toB(B.sub(a, b)) !== A - Bn) bad.push('sub');
    const qr = B.divmod(a, b);
    if (toB(qr[0]) !== A / Bn || toB(qr[1]) !== A % Bn) bad.push('divmod');
    const s = it % 60;
    if (toB(B.shl(a, s)) !== A << BigInt(s) || toB(B.shr(a, s)) !== A >> BigInt(s)) bad.push('shift');
    if (Bn > 1n) {
      const e8 = rnd(1 + (it % 40));
      let r = 1n, x = A % Bn, e = big(e8);
      while (e > 0n) { if (e & 1n) r = r * x % Bn; x = x * x % Bn; e >>= 1n; }
      if (toB(B.modPow(a, B.fromBytes(e8), b)) !== r) bad.push('modPow');
    }
  }
  ok(!bad.length, 'bignum (no BigInt) against BigInt: add, sub, mul, divmod, shifts, modPow', bad.slice(0, 5).join(' '));
});

function ossl(args, input) {
  const r = spawnSync('openssl', args, { cwd: TMP, input });
  return { code: r.status, out: String(r.stdout) + String(r.stderr) };
}

await run('rsa', async () => {
  for (const bits of QUICK ? [2048] : [1024, 2048, 3072, 4096]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });
    const pkcs8 = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }));
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
    const k = RSA.parsePkcs8(pkcs8), pub = RSA.parseSpki(spki);
    fs.writeFileSync(path.join(TMP, 'rsa.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
    for (const h of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) {
      const msg = rnd(333);
      const t = Date.now();
      const s = RSA.sign(k, h, msg);
      const ms = Date.now() - t;
      ok(eq(s, crypto.sign(nodeHash(h), msg, privateKey)), `RSA-${bits} ${h}: the plain signature equals Node's (${ms} ms)`);
      fs.writeFileSync(path.join(TMP, 'm'), msg); fs.writeFileSync(path.join(TMP, 's'), s);
      const v = ossl(['dgst', '-' + nodeHash(h), '-verify', 'rsa.pub', '-signature', 's', 'm']);
      ok(v.code === 0, `RSA-${bits} ${h}: openssl verifies it`, v.out);
      const w = crypto.sign(nodeHash(h), msg, privateKey);
      ok(RSA.verify(pub, h, msg, w) && !RSA.verify(pub, h, rnd(9), w), `RSA-${bits} ${h}: the plain verify accepts Node's and rejects others`);
    }
  }
  const t = Date.now();
  const g = RSA.generate(QUICK ? 1024 : 2048);
  const ms = Date.now() - t;
  const jwk = { kty: 'RSA', n: Buffer.from(RSA.toBytesParts(g).n).toString('base64url'), e: 'AQAB' };
  const m = rnd(10);
  ok(crypto.verify('sha256', m, crypto.createPublicKey({ key: jwk, format: 'jwk' }), RSA.sign(g, 'SHA-256', m)),
    'RSA key generation (' + B.bitLength(g.n) + ' bits, ' + ms + ' ms): its signature verifies in Node');
});

function derSig(raw) {
  const h = raw.length / 2;
  const int = (b) => { let i = 0; while (i < b.length - 1 && !b[i]) i++; b = b.subarray(i); return b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : Buffer.from(b); };
  const r = int(raw.subarray(0, h)), s = int(raw.subarray(h));
  const body = Buffer.concat([Buffer.from([2, r.length]), r, Buffer.from([2, s.length]), s]);
  return body.length < 128 ? Buffer.concat([Buffer.from([0x30, body.length]), body]) : Buffer.concat([Buffer.from([0x30, 0x81, body.length]), body]);
}

await run('ecdsa', async () => {
  for (const [nc, name] of [['prime256v1', 'P-256'], ['secp384r1', 'P-384'], ['secp521r1', 'P-521']]) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: nc });
    const k = EC.parsePkcs8(new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })));
    const pub = EC.parseSpki(new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })));
    fs.writeFileSync(path.join(TMP, 'ec.pub'), publicKey.export({ type: 'spki', format: 'pem' }));
    ok(eq(EC.publicKey({ curve: name, d: k.d }), EC.publicKey(pub)), name + ': public key from the private one');
    for (const h of ['SHA-256', 'SHA-384', 'SHA-512']) {
      const msg = rnd(99);
      const t = Date.now();
      const s = EC.sign(k, h, msg);
      const ms = Date.now() - t;
      ok(crypto.verify(nodeHash(h), msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, s), `${name} ${h}: Node verifies the plain signature (${ms} ms)`);
      ok(eq(s, EC.sign(k, h, msg)), `${name} ${h}: signatures are deterministic (RFC 6979)`);
      fs.writeFileSync(path.join(TMP, 'm'), msg); fs.writeFileSync(path.join(TMP, 's'), derSig(s));
      const v = ossl(['dgst', '-' + nodeHash(h), '-verify', 'ec.pub', '-signature', 's', 'm']);
      ok(v.code === 0, `${name} ${h}: openssl verifies it`, v.out);
      const w = crypto.sign(nodeHash(h), msg, { key: privateKey, dsaEncoding: 'ieee-p1363' });
      ok(EC.verify(pub, h, msg, w) && !EC.verify(pub, h, msg.subarray(1), w), `${name} ${h}: the plain verify accepts Node's and rejects others`);
    }
  }
  // RFC 6979 A.2.5 (P-256) and A.2.6 (P-384), message "sample".
  const k256 = EC.fromPrivate('P-256', unhex('C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721'));
  ok(hx(EC.sign(k256, 'SHA-256', te.encode('sample'))).toUpperCase() ===
    'EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8',
  'ECDSA RFC 6979 A.2.5 (P-256, SHA-256, "sample")');
  const k384 = EC.fromPrivate('P-384', unhex('6B9D3DAD2E1B8C1C05B19875B6659F4DE23C3B667BF297BA9AA47740787137D896D5724E4C70A825F872C9EA60D2EDF5'));
  ok(hx(EC.sign(k384, 'SHA-384', te.encode('sample'))).toUpperCase() ===
    '94EDBB92A5ECB8AAD4736E56C691916B3F88140666CE9FA73D64C4EA95AD133C81A648152E44ACF96E36DD1E80FABE46' +
    '99EF4AEB15F178CEA1FE40DB2603138F130E740A19624526203B6351D0A3A94FA329C145786E679E7B82C71A38628AC8',
  'ECDSA RFC 6979 A.2.6 (P-384, SHA-384, "sample")');
});

await run('ed25519', async () => {
  // RFC 8032 section 7.1, tests 1, 2, 3 and SHA(abc).
  const V = [
    ['9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '',
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
    ['4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb', '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72',
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
    ['c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7', 'fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82',
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
    ['833fe62409237b9d62ec77587520911e9a759cec1d19755b7da901b96dca3d42', 'ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf',
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
      'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704'],
  ];
  let good = true;
  for (const [sk, pk, m, sig] of V) {
    good = good && hx(ED.publicFromSeed(unhex(sk))) === pk && hx(ED.sign(unhex(sk), unhex(m))) === sig && ED.verify(unhex(pk), unhex(m), unhex(sig));
  }
  ok(good, 'Ed25519 RFC 8032 7.1 vectors (public key, signature, verify)');
  let bad = 0;
  for (let i = 0; i < N; i++) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const seed = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })).slice(-32);
    const pub = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })).slice(-32);
    const msg = rnd(i * 37);
    const s = ED.sign(seed, msg);
    if (!eq(s, crypto.sign(null, msg, privateKey)) || !ED.verify(pub, msg, s) || ED.verify(pub, rnd(3), s)) bad++;
    const t = new Uint8Array(s); t[5] ^= 1;
    if (ED.verify(pub, msg, t)) bad++;
  }
  ok(!bad, 'Ed25519: the plain signatures equal Node\'s, and damaged ones are refused', bad);
  // S >= l must be refused (malleability, RFC 8032 5.1.7).
  const [sk, pk, m, sig] = V[0];
  const s = unhex(sig), L = unhex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
  let c = 0;
  for (let i = 0; i < 32; i++) { const x = s[32 + i] + L[i] + c; s[32 + i] = x & 255; c = x >> 8; }
  ok(!ED.verify(unhex(pk), unhex(m), s), 'Ed25519: S + l is refused');
});

/* ---------- cryptox: the same results native and plain ---------- */

await run('cryptox', async () => {
  const both = async (f) => {
    const a = await f();
    globalThis.TI_PURE_JS = true;
    try { return [a, await f()]; } finally { delete globalThis.TI_PURE_JS; }
  };
  const d = rnd(1000), k = rnd(32), iv = rnd(16);
  let r = await both(() => X.digest('SHA-384', d));
  ok(eq(r[0], r[1]), 'cryptox digest: native and plain agree');
  r = await both(() => X.hmac('SHA-512', k, d));
  ok(eq(r[0], r[1]), 'cryptox hmac: native and plain agree');
  r = await both(() => X.pbkdf2('SHA-256', k, iv, 2048, 32));
  ok(eq(r[0], r[1]), 'cryptox pbkdf2: native and plain agree');
  r = await both(() => X.aesCbcEncrypt(k, iv, d));
  ok(eq(r[0], r[1]), 'cryptox AES-CBC encrypt: native and plain agree');
  r = await both(() => X.aesCbcDecrypt(k, iv, r[0]));
  ok(eq(r[0], d) && eq(r[1], d), 'cryptox AES-CBC decrypt: native and plain agree');
  r = await both(() => X.aesCfb(k, iv, d.subarray(0, 77), false));
  ok(eq(r[0], r[1]), 'cryptox AES-CFB: native and plain agree');
  let e1 = null, e2 = null;
  try { await X.aesCbcDecrypt(rnd(32), iv, (await X.aesCbcEncrypt(k, iv, d))); } catch (e) { e1 = e; }
  globalThis.TI_PURE_JS = true;
  try { await X.aesCbcDecrypt(rnd(32), iv, (await X.aesCbcEncrypt(k, iv, d))); } catch (e) { e2 = e; }
  delete globalThis.TI_PURE_JS;
  ok(e1 && e2, 'cryptox AES-CBC: a wrong key throws on both paths');

  for (const [type, alg] of [['rsa', { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }], ['ec', { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' }],
    ['ec', { name: 'ECDSA', namedCurve: 'P-384', hash: 'SHA-256' }]]) {
    const opts = type === 'rsa' ? { modulusLength: 2048 } : { namedCurve: alg.namedCurve === 'P-256' ? 'prime256v1' : 'secp384r1' };
    const { privateKey, publicKey } = crypto.generateKeyPairSync(type, opts);
    const pkcs8 = new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' }));
    const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
    const nk = await X.importPkcs8(pkcs8, alg);
    globalThis.TI_PURE_JS = true;
    const pk = await X.importPkcs8(pkcs8, alg);
    const ps = await X.sign(pk, d);
    const pv = await X.verifySpki(alg, spki, ps, d);
    delete globalThis.TI_PURE_JS;
    const ns = await X.sign(nk, d);
    const label = alg.name + (alg.namedCurve ? ' ' + alg.namedCurve : '');
    ok(!!nk.native && !!pk.pure, `cryptox ${label}: native key in Node, plain key with TI_PURE_JS`);
    ok(await X.verifySpki(alg, spki, ps, d), `cryptox ${label}: the native side verifies the plain signature`);
    ok(pv && (await (async () => { globalThis.TI_PURE_JS = true; try { return X.verifySpki(alg, spki, ns, d); } finally { delete globalThis.TI_PURE_JS; } })()),
      `cryptox ${label}: the plain side verifies itself and the native signature`);
    if (type === 'rsa') ok(eq(ns, ps), 'cryptox RSA: native and plain signatures are identical');
  }
  // Ed25519 keys: generate and sign on each path, check against Node.
  for (const pure of [false, true]) {
    if (pure) globalThis.TI_PURE_JS = true;
    const kp = await X.generateEd25519();
    const key = await X.importEd25519(kp.seed);
    const s = await X.sign(key, d);
    delete globalThis.TI_PURE_JS;
    const nodePub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(kp.pub)]), format: 'der', type: 'spki' });
    ok(crypto.verify(null, d, nodePub, s), 'cryptox Ed25519 (' + (pure ? 'plain' : 'native') + ' path): Node verifies the signature');
  }
  // RSA from parts, as pgp.js imports gpg keys.
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = privateKey.export({ format: 'jwk' });
  const parts = {};
  for (const n of ['n', 'e', 'd', 'p', 'q']) parts[n] = new Uint8Array(Buffer.from(jwk[n], 'base64url'));
  const kn = await X.importRsaParts(parts);
  globalThis.TI_PURE_JS = true;
  const kpu = await X.importRsaParts(parts);
  const sp = await X.sign(kpu, d);
  delete globalThis.TI_PURE_JS;
  ok(kn.native && kpu.pure && eq(await X.sign(kn, d), sp), 'cryptox RSA from parts: native and plain signatures are identical');
  globalThis.TI_PURE_JS = true;
  const gen = await X.generateRsa(1024);
  delete globalThis.TI_PURE_JS;
  const genPub = crypto.createPublicKey({ key: { kty: 'RSA', n: Buffer.from(gen.parts.n).toString('base64url'), e: Buffer.from(gen.parts.e).toString('base64url') }, format: 'jwk' });
  globalThis.TI_PURE_JS = true;
  const gs = await X.sign(gen.key, d);
  delete globalThis.TI_PURE_JS;
  ok(crypto.verify('sha256', d, genPub, gs), 'cryptox RSA generation on the plain path: Node verifies its signature');
});

/* ---------- polyfills: the UTF-8 TextDecoder ---------- */

// src/web_client/polyfills.js in a context without TextDecoder, so it adds its own;
// its answers must be Node's, on text, broken UTF-8 and the catalogue.
await run('TextDecoder stand-in', async () => {
  const ctx = { Object, Array, Uint8Array, ArrayBuffer, String, RangeError, TypeError, Error, Promise, Symbol, Number, Math, JSON, Map, Set };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(REPO, 'src/web_client/polyfills.js'), 'utf8'), ctx);
  ok(typeof ctx.TextDecoder === 'function' && ctx.TextDecoder !== TextDecoder, 'TextDecoder stand-in: added where missing');
  const mine = new ctx.TextDecoder(), node = new TextDecoder();
  let bad = 0, n = 0;
  const check = (u) => { n++; if (mine.decode(u) !== node.decode(u)) bad++; };
  for (let t = 0; t < N * 50; t++) {
    const len = crypto.randomInt(0, 400);
    const u = new Uint8Array(len);
    for (let i = 0; i < len; i++) u[i] = crypto.randomInt(0, 10) < 8 ? crypto.randomInt(0, 128) : crypto.randomInt(0, 256);
    check(u);
    check(new Uint8Array(Buffer.from('é漢😀'.repeat(t % 7) + 'a'.repeat(t % 200) + '€\uffff' + 'b'.repeat(t * 37 % 70000))));
  }
  check(new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xc3]));
  const cat = new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'tests/golden/catalog.gz'))));
  check(cat);
  ok(bad === 0, `TextDecoder stand-in: the same text as Node's for ${n} inputs (random bytes, mixed text, a BOM, the ${(cat.length >> 20)} MB catalogue)`, bad + ' differ');
});

/* ---------- has-shim ---------- */

await run('has-shim', async () => {
  const css = fs.readFileSync(path.join(REPO, 'src/web_client/css/style.css'), 'utf8');
  const n = (css.match(/:has\(/g) || []).length;
  const r = convertCss(css);
  ok(n > 0 && !/:has\(|:is\(|:focus-visible/.test(r.css), 'every :has() in src/web_client/css/style.css is rewritten (' + n + ' uses, ' + r.probes.length + ' probes)');
  const plain = (s) => s.replace(/\s+/g, ' ').replace(/\s*([{}])\s*/g, '$1').trim();
  ok(plain(convertCss('form:has(#a:checked) .x { color: red }').css) === plain('form.tihas0:not(#ti-z) .x { color: red }'), 'a :has(#id:checked) rule');
  ok(plain(convertCss('form:not(:has(#r option[value="a"]:checked)) .x{a:b}').css) === plain('form:not(.tihas0):not(#ti-z):not(.ti-z):not(ti-z) .x {a:b}'), 'a :not(:has(...)) rule, padded');
  ok(plain(convertCss('@media (x) { .t:has(input:focus-visible) { o: 1 } } .keep { a: b }').css) === plain('@media (x) { .t.tihas0:not(ti-z) { o: 1 } } .keep { a: b }'),
    '@media blocks, :focus-visible and untouched rules');
  const c3 = convertCss('a:has(#r option:is([value="p"], [value="q"]):checked) b {}');
  ok(c3.probes[0].sels.length === 2 && c3.probes[0].sels[1] === '#r option[value="q"]:checked', ':is() inside :has() is expanded');
  // Specificity is kept. The original: form (0,0,1) + :has(#src-write:checked)
  // (1,1,0) + :not(:has(#runtime option[value]:checked)) (1,2,1) + .w (0,1,0).
  const spec = (s) => specificity(s);
  const orig = 'form:has(#src-write:checked):not(:has(#runtime option:is([value="python"], [value="node"]):checked)) .w';
  const conv = convertCss(orig + ' {}').css.replace(/\s*\{\}\s*$/, '');
  ok(String(spec(conv)) === '2,4,2', 'specificity of a :has()/:not(:has()) selector is kept (2,4,2): ' + conv);
});

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
