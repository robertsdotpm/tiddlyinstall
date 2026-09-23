// Plan signatures (docs/format.md "Plan signature"; the Go server's plansig
// package), with node:crypto. A signed plan is the plan's exact bytes and
// one last line:
//
//   sig<TAB>ed25519<TAB><base64 of the 64-byte signature>\n
//
// The signature (RFC 8032 Ed25519, no prehash, no context) covers every
// byte before that line. Ed25519 is deterministic, so the same key and bytes
// give the same signature as the Go server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const KEY_FILE = 'plan-signing-key.pem'; // PKCS#8 private key, mode 0600
export const PUB_FILE = 'plan-signing-key.pub'; // base64 of the raw 32-byte public key; bases are built with it

const SIG_PREFIX = 'sig\ted25519\t';
const PLAN_HEAD = Buffer.from('ti-plan\t');
// The other document signed with the plan key: the revocation list
// (design.md 7.1). Its signed bytes must start with its own header, so a
// plan signature can never be read as one, or the other way round.
export const PLAN_KIND = 'ti-plan';
export const REVOCATIONS_KIND = 'ti-revocations';
export const RELEASES_KIND = 'ti-releases';
const headOf = (kind) => Buffer.from(kind + '\t');

function rawPublic(keyObject) {
  return Buffer.from(keyObject.export({ format: 'jwk' }).x, 'base64url');
}

export function publicKeyFromRaw(raw) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
}

// KeyID: the first 16 hex digits of the SHA-256 of the raw public key.
export function keyID(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

export class Signer {
  constructor(privateKey) {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
    this.priv = privateKey;
    this.pubKey = crypto.createPublicKey(privateKey);
    this.pub = rawPublic(this.pubKey);
  }

  publicBase64() { return this.pub.toString('base64'); }

  // SubjectPublicKeyInfo PEM, what openssl reads.
  publicPEM() { return this.pubKey.export({ type: 'spki', format: 'pem' }); }

  // plan (bytes or text) with its signature line appended. It must be an
  // ti-plan and not already signed; a missing final newline is added first.
  sign(plan) { return this.signAs(PLAN_KIND, plan); }

  // The same for another document signed with this key: its bytes must
  // start with `<kind><TAB>`.
  signAs(kind, doc) {
    let b = Buffer.from(doc);
    const head = headOf(kind);
    if (!b.subarray(0, head.length).equals(head)) throw new Error('plansig: not a ' + kind);
    if (split(b).ok) throw new Error('plansig: already signed');
    if (b.length && b[b.length - 1] !== 0x0a) b = Buffer.concat([b, Buffer.from('\n')]);
    const sig = crypto.sign(null, b, this.priv);
    return Buffer.concat([b, Buffer.from(SIG_PREFIX + sig.toString('base64') + '\n')]);
  }

  signString(plan) { return this.sign(Buffer.from(plan, 'utf8')).toString('utf8'); }
  signStringAs(kind, doc) { return this.signAs(kind, Buffer.from(doc, 'utf8')).toString('utf8'); }
}

// Where the private key lives, when nothing says otherwise.
//
// Not the data directory, and not anywhere under the repository. The
// repository is going public and the thing that must never leave is the
// one file that cannot be replaced: every installer ever built carries
// the public half, so losing this key ends the chain for all of them and
// leaking it lets somebody else sign as us. Keeping it out of the tree
// means no .gitignore has to be right for it to stay private.
//
// $TI_KEYS overrides, and -keys on the server.
export function defaultKeyDir() {
  return process.env.TI_KEYS ||
    path.join(process.env.HOME || process.env.USERPROFILE || '.', '.config', 'tiddlyinstall', 'keys');
}

// loadOrCreate reads the key from dir, or makes one if there is none. The
// public key file is (re)written from the private key every time, so it
// can't drift from it. `alsoPub` gets a copy of the public half: the base
// builds read it from the data directory, and it is not a secret.
// Returns {signer, created}.
export function loadOrCreate(dir, log = console.log, alsoPub = '') {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kp = path.join(dir, KEY_FILE);
  let signer, created = false;
  let pem = null;
  try { pem = fs.readFileSync(kp, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (pem === null) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const out = privateKey.export({ type: 'pkcs8', format: 'pem' });
    try {
      fs.writeFileSync(kp, out, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      if (e.code === 'EEXIST') return loadOrCreate(dir, log); // another process made it first: use theirs
      throw e;
    }
    signer = new Signer(privateKey);
    created = true;
  } else {
    const st = fs.statSync(kp);
    if (st.mode & 0o077) log(`plansig: WARNING: ${kp} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it`);
    if (!/^-----BEGIN PRIVATE KEY-----/m.test(pem)) throw new Error(kp + ': not a PEM private key');
    let key;
    try { key = crypto.createPrivateKey({ key: pem, format: 'pem' }); } catch (e) { throw new Error(kp + ': ' + e.message); }
    if (key.asymmetricKeyType !== 'ed25519') throw new Error(kp + ': not an Ed25519 key');
    signer = new Signer(key);
  }
  const pub = signer.publicBase64() + '\n';
  for (const d of alsoPub && alsoPub !== dir ? [dir, alsoPub] : [dir]) {
    const pp = path.join(d, PUB_FILE);
    let old = null;
    try { old = fs.readFileSync(pp, 'utf8'); } catch (e) { /* none yet */ }
    if (old !== pub) {
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(pp + '.tmp', pub, { mode: 0o644 });
      fs.renameSync(pp + '.tmp', pp);
    }
  }
  return { signer, created };
}

// split finds the signature line: {msg, line, ok}. ok is false when the last
// line (what follows the last newline, once one final "\n" or "\r\n" is set
// aside) isn't a `sig` line.
export function split(doc) {
  const b = Buffer.from(doc);
  let end = b.length;
  if (end > 0 && b[end - 1] === 0x0a) {
    end--;
    if (end > 0 && b[end - 1] === 0x0d) end--;
  }
  const nl = b.subarray(0, end).lastIndexOf(0x0a);
  if (nl < 0) return { msg: b, line: '', ok: false };
  const last = b.subarray(nl + 1, end).toString('utf8');
  if (last !== 'sig' && !last.startsWith('sig\t')) return { msg: b, line: '', ok: false };
  return { msg: b.subarray(0, nl + 1), line: last, ok: true };
}

export class VerifyError extends Error {}

// verify checks a signed plan against the raw public key and returns the
// signed bytes (the plan without its signature line). `kind` is the header
// the signed bytes must start with: a ti-plan unless another is named.
export function verify(pubRaw, doc, kind = PLAN_KIND) {
  const { msg, line, ok } = split(doc);
  if (!ok) throw new VerifyError('the plan is not signed');
  if (!line.startsWith(SIG_PREFIX)) throw new VerifyError('the plan\'s signature does not verify: unknown signature type ' + JSON.stringify(line));
  const b64 = line.slice(SIG_PREFIX.length);
  const sig = Buffer.from(b64, 'base64');
  if (b64.length !== 88 || !/^[A-Za-z0-9+/]{86}==$/.test(b64) || sig.length !== 64) throw new VerifyError('the plan\'s signature does not verify: malformed signature');
  const head = headOf(kind);
  if (!msg.subarray(0, head.length).equals(head)) throw new VerifyError('the plan\'s signature does not verify: signed bytes are not a ' + kind);
  if (!crypto.verify(null, msg, publicKeyFromRaw(pubRaw), sig)) throw new VerifyError('the plan\'s signature does not verify');
  return msg;
}

// verifyFor is verify plus the record binding: the plan's header `record`
// line must be exactly `record`.
export function verifyFor(pubRaw, doc, record) {
  const msg = verify(pubRaw, doc);
  const got = recordOf(msg);
  if (got !== record) throw new VerifyError(`the plan is for record "${got}", not "${record}"`);
  return msg;
}

// recordOf: the value of the plan header's first `record` line.
export function recordOf(plan) {
  for (let raw of Buffer.from(plan).toString('utf8').split('\n')) {
    raw = raw.replace(/\r$/, '');
    if (raw === '[target]') break;
    if (raw.startsWith('record\t')) return raw.slice(7).split('\t')[0];
  }
  return '';
}

// AddRequestLine puts `request<TAB>vals...` after the plan's header line and
// after any `request` lines already there, so the lines keep the order they
// were added in: `request<TAB>name<TAB>…` (a plan by name, format.md section
// 2) before `request<TAB>nonce<TAB>…` (design.md 7.1). The order is part of
// the format: an engine that reads one `request` line reads the first, which
// is the one saying what was asked for.
export function addRequestLine(plan, ...vals) {
  let i = plan.indexOf('\n');
  if (i < 0 || !plan.startsWith('ti-plan\t')) throw new Error('not a ti-plan');
  for (;;) {
    if (!plan.startsWith('request\t', i + 1)) break;
    const n = plan.indexOf('\n', i + 1);
    if (n < 0) break;
    i = n;
  }
  const line = ['request', ...vals.map((v) => String(v).replace(/[\t\r\n]/g, ' '))].join('\t') + '\n';
  return plan.slice(0, i + 1) + line + plan.slice(i + 1);
}
