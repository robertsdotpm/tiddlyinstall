// OpenPGP detached signatures for Linux installers (RFC 4880 v4 packets,
// which GnuPG 2.2 and 2.4 read). Ed25519 (EdDSA, algorithm 22) or RSA keys,
// generated in the page or imported from `gpg --export-secret-keys`.
// js/cryptox.js does the signing, hashing and AES (WebCrypto, or plain
// JavaScript without it); the key never leaves the page.
import { concat, b64, unb64, eqBytes, hex } from './der.js';
import * as X from './cryptox.js';
import * as B from './bignum.js';

const enc = new TextEncoder();
const ED25519_OID = new Uint8Array([0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01]);
const ALG = { RSA: 1, RSA_S: 3, EDDSA: 22 };
const HASH = { 2: 'SHA-1', 8: 'SHA-256', 9: 'SHA-384', 10: 'SHA-512', 11: 'SHA-224' };
const AES_KEYLEN = { 7: 16, 8: 24, 9: 32 };

export class PgpError extends Error {}

const digest = (h, b) => X.digest(h, b);
const u32 = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const u16 = (n) => new Uint8Array([(n >>> 8) & 255, n & 255]);

/* ---------- packets ---------- */

function packet(tag, body) {
  const n = body.length;
  let len;
  if (n < 192) len = [n];
  else if (n < 8384) len = [((n - 192) >> 8) + 192, (n - 192) & 255];
  else len = [255].concat(Array.from(u32(n)));
  return concat([new Uint8Array([0xc0 | tag].concat(len)), body]);
}

function mpi(bytes) {
  let i = 0;
  while (i < bytes.length && bytes[i] === 0) i++;
  const b = bytes.subarray(i);
  const bits = b.length ? (b.length - 1) * 8 + (32 - Math.clz32(b[0])) : 0;
  return concat([u16(bits), b]);
}

function readMpi(u8, o) {
  const bits = (u8[o] << 8) | u8[o + 1];
  const n = (bits + 7) >> 3;
  if (o + 2 + n > u8.length) throw new PgpError('Truncated key data.');
  return [u8.subarray(o + 2, o + 2 + n), o + 2 + n];
}

export function parsePackets(u8) {
  const out = [];
  let o = 0;
  while (o < u8.length) {
    const h = u8[o++];
    if (!(h & 0x80)) throw new PgpError('Not OpenPGP data.');
    let tag, len;
    if (h & 0x40) {
      tag = h & 0x3f;
      const a = u8[o++];
      if (a < 192) len = a;
      else if (a < 224) len = ((a - 192) << 8) + u8[o++] + 192;
      else if (a === 255) { len = ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; o += 4; }
      else throw new PgpError('Partial-length packets are not supported here.');
    } else {
      tag = (h >> 2) & 15;
      const lt = h & 3;
      if (lt === 0) len = u8[o++];
      else if (lt === 1) { len = (u8[o] << 8) | u8[o + 1]; o += 2; }
      else if (lt === 2) { len = ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0; o += 4; }
      else len = u8.length - o;
    }
    if (o + len > u8.length) throw new PgpError('Truncated OpenPGP packet.');
    out.push({ tag, body: u8.subarray(o, o + len) });
    o += len;
  }
  return out;
}

/* ---------- armor ---------- */

function crc24(u8) {
  let c = 0xb704ce;
  for (let i = 0; i < u8.length; i++) {
    c ^= u8[i] << 16;
    for (let j = 0; j < 8; j++) { c <<= 1; if (c & 0x1000000) c ^= 0x1864cfb; }
  }
  return c & 0xffffff;
}

export function armor(type, u8) {
  const body = b64(u8).replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  const c = crc24(u8);
  return '-----BEGIN PGP ' + type + '-----\n\n' + body + '\n=' + b64(new Uint8Array([c >> 16, (c >> 8) & 255, c & 255])) +
    '\n-----END PGP ' + type + '-----\n';
}

export function dearmor(input) {
  if (input instanceof Uint8Array) {
    if (input.length && input[0] & 0x80) return input;
    input = new TextDecoder().decode(input);
  }
  const m = /-----BEGIN PGP ([A-Z ]+)-----\r?\n([\s\S]*?)-----END PGP \1-----/.exec(input);
  if (!m) throw new PgpError('No OpenPGP armor found.');
  const lines = m[2].split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i].trim() !== '') i++;       // headers, then a blank line
  const data = [], rest = i < lines.length ? lines.slice(i + 1) : lines;
  let crc = null;
  for (const l of rest) {
    const t = l.trim();
    if (!t) continue;
    if (t[0] === '=' && t.length === 5) crc = t.slice(1);
    else data.push(t);
  }
  const u8 = unb64(data.join(''));
  if (crc) {
    const c = unb64(crc);
    if (((c[0] << 16) | (c[1] << 8) | c[2]) !== crc24(u8)) throw new PgpError('The armored key is damaged (checksum mismatch).');
  }
  return u8;
}

/* ---------- keys ---------- */

function pubKeyBody(algo, created, material) {
  return concat([new Uint8Array([4]), u32(created), new Uint8Array([algo]), material]);
}

async function fingerprintOf(body) {
  const fp = await digest('SHA-1', concat([new Uint8Array([0x99]), u16(body.length), body]));
  return { fingerprint: fp, keyId: fp.subarray(12) };
}

function subpacket(type, data) {
  return concat([new Uint8Array([data.length + 1, type]), data]);
}

// The v4 signature packet body, given what it signs (`prefix`, hashed
// before the signature's own fields) and a function that signs.
async function makeSignature(key, sigType, prefix, created, extraHashed = []) {
  const hashed = concat([
    subpacket(33, concat([new Uint8Array([4]), key.fingerprint])),
    subpacket(2, u32(created)),
    ...extraHashed,
  ]);
  const head = concat([new Uint8Array([4, sigType, key.algo, 8]), u16(hashed.length), hashed]);
  const trailer = concat([new Uint8Array([4, 0xff]), u32(head.length)]);
  const unhashed = subpacket(16, key.keyId);
  const toHash = concat([prefix, head, trailer]);
  const h = await digest('SHA-256', toHash);
  let sigMpis;
  if (key.algo === ALG.EDDSA) {
    const s = await X.sign(key.signKey, h);
    sigMpis = concat([mpi(s.subarray(0, 32)), mpi(s.subarray(32))]);
  } else {
    sigMpis = mpi(await X.sign(key.signKey, toHash));
  }
  return concat([head, u16(unhashed.length), unhashed, h.subarray(0, 2), sigMpis]);
}

function userIdPrefix(key, uid) {
  const u = enc.encode(uid);
  return concat([new Uint8Array([0x99]), u16(key.pubBody.length), key.pubBody, new Uint8Array([0xb4]), u32(u.length), u]);
}

// A new signing key. type: 'ed25519' or 'rsa' (3072 or 4096 bits).
export async function generateKey(type, userId, { bits = 3072 } = {}) {
  if (!userId || !userId.trim()) throw new PgpError('A key needs a name (user ID), such as "Your Name <you@example.com>".');
  const created = Math.floor(Date.now() / 1000);
  let key;
  if (type === 'ed25519') {
    const kp = await X.generateEd25519();
    key = await ed25519Key(created, kp.pub, kp.seed);
  } else if (type === 'rsa') {
    const g = await X.generateRsa(bits);
    key = await rsaKeyFromParts(created, g.parts, g.key);
  } else throw new PgpError('Unknown key type ' + type);
  key.userId = userId.trim();
  const flags = [subpacket(27, new Uint8Array([0x03])), subpacket(11, new Uint8Array([9, 8, 7])), subpacket(21, new Uint8Array([8, 10, 9])), subpacket(30, new Uint8Array([1]))];
  key.selfSig = await makeSignature(key, 0x13, userIdPrefix(key, key.userId), created, flags);
  return key;
}

async function ed25519Key(created, pub, seed) {
  const material = concat([new Uint8Array([ED25519_OID.length]), ED25519_OID, mpi(concat([new Uint8Array([0x40]), pub]))]);
  const pubBody = pubKeyBody(ALG.EDDSA, created, material);
  const signKey = await X.importEd25519(seed);
  return Object.assign({ algo: ALG.EDDSA, type: 'ed25519', created, pubBody, signKey, secretMpis: mpi(seed) }, await fingerprintOf(pubBody));
}

// parts: big-endian bytes {n, e, d, p, q}.
async function rsaKeyFromParts(created, parts, signKey) {
  let p = B.fromBytes(parts.p), q = B.fromBytes(parts.q);
  if (B.cmp(p, q) > 0) { const t = p; p = q; q = t; }         // OpenPGP wants p < q, u = p^-1 mod q
  let u;
  try { u = B.modInv(p, q); } catch (e) { throw new PgpError('Bad RSA key (no inverse).'); }
  const pubBody = pubKeyBody(ALG.RSA, created, concat([mpi(parts.n), mpi(parts.e)]));
  const secretMpis = concat([mpi(parts.d), mpi(B.toBytes(p)), mpi(B.toBytes(q)), mpi(B.toBytes(u))]);
  return Object.assign({ algo: ALG.RSA, type: 'rsa', bits: parts.n.length * 8, created, pubBody, signKey, secretMpis }, await fingerprintOf(pubBody));
}

/* ---------- secret key protection (S2K + AES-CFB) ---------- */

async function s2kKey(spec, pass, keyLen) {
  const [type, hashId] = spec;
  const hash = HASH[hashId];
  if (!hash) throw new PgpError('Unsupported S2K hash ' + hashId + '.');
  const pw = enc.encode(pass);
  let salt = new Uint8Array(0), count = 0;
  if (type === 1 || type === 3) salt = spec.salt;
  let data = concat([salt, pw]);
  if (type === 3) {
    count = Math.max(spec.count, data.length);
    if (count > 65011712) throw new PgpError('This key asks for an unreasonable S2K count.');
    const buf = new Uint8Array(count);
    for (let o = 0; o < count; o += data.length) buf.set(data.subarray(0, Math.min(data.length, count - o)), o);
    data = buf;
  } else if (type !== 0 && type !== 1) throw new PgpError('Unsupported S2K type ' + type + '.');
  const out = [];
  let have = 0;
  for (let i = 0; have < keyLen; i++) {
    const d = await digest(hash, concat([new Uint8Array(i), data]));
    out.push(d);
    have += d.length;
  }
  return concat(out).subarray(0, keyLen);
}

const cfb = (key, iv, data, decrypt) => X.aesCfb(key, iv, data, decrypt);

function parseS2k(b, o) {
  const type = b[o++];
  const spec = [type, b[o++]];
  if (type === 1 || type === 3) { spec.salt = b.subarray(o, o + 8); o += 8; }
  if (type === 3) { const c = b[o++]; spec.count = (16 + (c & 15)) << ((c >> 4) + 6); }
  if (type === 101) throw new PgpError('This secret key is on a smartcard or was exported without its secret part (gnu-dummy S2K).');
  return [spec, o];
}

// Secret-key packet body for a key made here. With a passphrase: AES-256,
// iterated and salted SHA-256 S2K, SHA-1 check (usage 254), which gpg reads.
async function secretKeyBody(key, passphrase) {
  if (!passphrase) {
    let sum = 0;
    for (const x of key.secretMpis) sum = (sum + x) & 0xffff;
    return concat([key.pubBody, new Uint8Array([0]), key.secretMpis, u16(sum)]);
  }
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const c = 0xe0;
  const spec = [3, 8];
  spec.salt = salt;
  spec.count = (16 + (c & 15)) << ((c >> 4) + 6);
  const k = await s2kKey(spec, passphrase, 32);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const plain = concat([key.secretMpis, await digest('SHA-1', key.secretMpis)]);
  return concat([key.pubBody, new Uint8Array([254, 9, 3, 8]), salt, new Uint8Array([c]), iv, await cfb(k, iv, plain, false)]);
}

export function publicKeyArmored(key) {
  return armor('PUBLIC KEY BLOCK', concat([packet(6, key.pubBody), packet(13, enc.encode(key.userId)), packet(2, key.selfSig)]));
}

export async function secretKeyArmored(key, passphrase) {
  if (!key.selfSig) throw new PgpError('Only keys made on this page can be saved from it; you already have this one.');
  return armor('PRIVATE KEY BLOCK', concat([packet(5, await secretKeyBody(key, passphrase)), packet(13, enc.encode(key.userId)), packet(2, key.selfSig)]));
}

/* ---------- importing gpg secret keys ---------- */

function keyFlagsOf(sigBody) {
  if (sigBody[0] !== 4) return null;
  const hl = (sigBody[4] << 8) | sigBody[5];
  const sub = sigBody.subarray(6, 6 + hl);
  for (let o = 0; o < sub.length;) {
    let len = sub[o++];
    if (len >= 192 && len < 255) { len = ((len - 192) << 8) + sub[o++] + 192; }
    else if (len === 255) { len = ((sub[o] << 24) | (sub[o + 1] << 16) | (sub[o + 2] << 8) | sub[o + 3]) >>> 0; o += 4; }
    const type = sub[o] & 0x7f;
    if (type === 27) return sub[o + 1];
    o += len;
  }
  return null;
}

async function openSecretPacket(body, passphrase) {
  if (body[0] !== 4) throw new PgpError('Only version 4 OpenPGP keys are supported (GnuPG 2.2 and 2.4 make these).');
  const created = ((body[1] << 24) | (body[2] << 16) | (body[3] << 8) | body[4]) >>> 0;
  const algo = body[5];
  let o = 6;
  let pubParts;
  if (algo === ALG.RSA || algo === ALG.RSA_S) {
    const [n, o1] = readMpi(body, o);
    const [e, o2] = readMpi(body, o1);
    pubParts = { n, e }; o = o2;
  } else if (algo === ALG.EDDSA) {
    const l = body[o];
    if (!eqBytes(body.subarray(o + 1, o + 1 + l), ED25519_OID)) throw new PgpError('Only Ed25519 EdDSA keys are supported.');
    const [q, o1] = readMpi(body, o + 1 + l);
    if (q[0] !== 0x40 || q.length !== 33) throw new PgpError('Unexpected Ed25519 public key encoding.');
    pubParts = { pub: q.subarray(1) }; o = o1;
  } else return null;                                            // not a signing algorithm we handle
  const pubBody = body.subarray(0, o);
  const usage = body[o++];
  let secret;
  if (usage === 0) {
    secret = body.subarray(o, body.length - 2);
  } else if (usage === 254 || usage === 255) {
    const sym = body[o++];
    const [spec, o1] = parseS2k(body, o);
    o = o1;
    if (!AES_KEYLEN[sym]) throw new PgpError('This key is protected with an old cipher (' + sym + '); re-export it with GnuPG 2.2 or later.');
    if (passphrase == null || passphrase === '') throw new PgpError('This key is protected; enter its passphrase.');
    const iv = body.subarray(o, o + 16);
    o += 16;
    const k = await s2kKey(spec, passphrase, AES_KEYLEN[sym]);
    const plain = await cfb(k, iv, body.subarray(o), true);
    if (usage === 254) {
      const s = plain.subarray(0, plain.length - 20);
      if (!eqBytes(await digest('SHA-1', s), plain.subarray(plain.length - 20))) throw new PgpError('Wrong passphrase.');
      secret = s;
    } else {
      const s = plain.subarray(0, plain.length - 2);
      let sum = 0;
      for (const x of s) sum = (sum + x) & 0xffff;
      if (sum !== ((plain[plain.length - 2] << 8) | plain[plain.length - 1])) throw new PgpError('Wrong passphrase.');
      secret = s;
    }
  } else if (usage === 253) {
    throw new PgpError('This key uses AEAD protection, which is not supported; export it from GnuPG 2.2 or 2.4 with the default settings.');
  } else throw new PgpError('Unsupported secret key protection (' + usage + ').');

  let key;
  if (algo === ALG.EDDSA) {
    const [seed] = readMpi(secret, 0);
    const s32 = new Uint8Array(32);
    s32.set(seed, 32 - seed.length);
    key = await ed25519Key(created, pubParts.pub, s32);
    if (!eqBytes(key.pubBody, pubBody)) throw new PgpError('Unexpected Ed25519 key layout.');
  } else {
    const [d, o1] = readMpi(secret, 0);
    const [p, o2] = readMpi(secret, o1);
    const [q] = readMpi(secret, o2);
    let signKey;
    try { signKey = await X.importRsaParts({ n: pubParts.n, e: pubParts.e, d, p, q }); } catch (e) { throw new PgpError('Bad RSA key (no inverse).'); }
    key = Object.assign({ algo, type: 'rsa', bits: pubParts.n.length * 8, created, pubBody: pubBody.slice(), signKey }, await fingerprintOf(pubBody));
  }
  // A key made on this page could be written out again; an imported one isn't.
  delete key.secretMpis;
  return key;
}

// Opens `gpg --export-secret-keys [--armor]` output. Signs with the primary
// key, or with a signing subkey when the primary may not sign.
export async function importSecretKey(input, passphrase) {
  const packets = parsePackets(dearmor(input));
  const keys = [];
  let uid = '', cur = null;
  for (const p of packets) {
    if (p.tag === 5 || p.tag === 7) { cur = { tag: p.tag, body: p.body, flags: null }; keys.push(cur); }
    else if (p.tag === 13 && !uid) uid = new TextDecoder().decode(p.body);
    else if (p.tag === 2 && cur) { const f = keyFlagsOf(p.body); if (f !== null) cur.flags = f; }
    else if (p.tag === 6 || p.tag === 14) throw new PgpError('That is a public key. Export the secret key: gpg --export-secret-keys --armor <id>');
  }
  if (!keys.length) throw new PgpError('No secret key found.');
  const order = keys.filter((k) => k.tag === 5 && (k.flags === null || k.flags & 2)).concat(keys.filter((k) => k.tag === 7 && k.flags & 2));
  if (!order.length) order.push(keys[0]);
  let lastErr = null;
  for (const k of order) {
    try {
      const key = await openSecretPacket(k.body, passphrase);
      if (!key) continue;
      key.userId = uid;
      key.subkey = k.tag === 7;
      return key;
    } catch (e) {
      if (e instanceof PgpError && /passphrase/.test(e.message)) throw e;
      lastErr = e;
    }
  }
  throw lastErr || new PgpError('None of the keys in this file can sign (supported: Ed25519 and RSA).');
}

/* ---------- signing ---------- */

// A detached, armored signature over `data` (a binary document).
export async function signDetached(key, data, { created = new Date() } = {}) {
  const body = await makeSignature(key, 0x00, data, Math.floor(created.getTime() / 1000));
  return armor('SIGNATURE', packet(2, body));
}

export function fingerprintHex(key) {
  return hex(key.fingerprint).toUpperCase().replace(/(.{4})/g, '$1 ').trim();
}
