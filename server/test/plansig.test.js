// Ports the Go server's plansig tests (server/internal/plansig, retired).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadOrCreate, keyID, split, verify, verifyFor, recordOf, addRequestLine, publicKeyFromRaw, KEY_FILE, PUB_FILE, VerifyError } from '../lib/plansig.js';
import { tmpDir, REPO } from './helpers.js';

const PLAN = 'ti-plan\t1\nrecord\ttjfq5rqwnnrxk3m9q2x7v4p8ab\nname\tHello\n\n[target]\nwhen\tlinux\t0\t9999\t*\nlaunch\techo hi\n';

function newSigner(t) {
  const dir = tmpDir(t);
  const { signer, created } = loadOrCreate(dir, () => {});
  assert.ok(created);
  return { s: signer, dir };
}

test('key files', (t) => {
  const { s, dir } = newSigner(t);
  assert.equal(fs.statSync(path.join(dir, KEY_FILE)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(dir, PUB_FILE), 'utf8'), s.publicBase64() + '\n');
  assert.equal(s.publicBase64().length, 44);
  // A second start loads the same key and doesn't make a new one.
  const again = loadOrCreate(dir, () => {});
  assert.equal(again.created, false);
  assert.ok(again.signer.pub.equals(s.pub));
  // The public key file is rewritten from the private key if it drifts.
  fs.writeFileSync(path.join(dir, PUB_FILE), 'junk\n');
  loadOrCreate(dir, () => {});
  assert.equal(fs.readFileSync(path.join(dir, PUB_FILE), 'utf8'), s.publicBase64() + '\n');
  assert.match(s.publicPEM(), /MCowBQYDK2VwAyEA/);
  assert.equal(keyID(s.pub).length, 16);
});

test('a key readable by others is used, with a warning', (t) => {
  const { dir } = newSigner(t);
  fs.chmodSync(path.join(dir, KEY_FILE), 0o644);
  const logs = [];
  loadOrCreate(dir, (m) => logs.push(m));
  assert.match(logs.join('\n'), /readable by other users/);
});

test('the server\'s key loads and signs deterministically', (t) => {
  const key = path.join(REPO, 'server', 'data', KEY_FILE);
  if (!fs.existsSync(key)) return t.skip('no server/data key');
  const dir = tmpDir(t);
  fs.copyFileSync(key, path.join(dir, KEY_FILE));
  fs.chmodSync(path.join(dir, KEY_FILE), 0o600);
  const { signer, created } = loadOrCreate(dir, () => {});
  assert.equal(created, false);
  assert.equal(fs.readFileSync(path.join(dir, PUB_FILE), 'utf8'), fs.readFileSync(path.join(REPO, 'server', 'data', PUB_FILE), 'utf8'));
  // Ed25519 is deterministic: signing twice gives the same bytes.
  assert.equal(signer.signString(PLAN), signer.signString(PLAN));
});

test('sign and verify', (t) => {
  const { s } = newSigner(t);
  const signed = s.sign(Buffer.from(PLAN));
  assert.ok(signed.subarray(0, PLAN.length).equals(Buffer.from(PLAN)), 'the plan\'s bytes changed');
  const lines = signed.toString().replace(/\n$/, '').split('\n');
  const line = lines[lines.length - 1];
  assert.ok(line.startsWith('sig\ted25519\t') && line.length === 'sig\ted25519\t'.length + 88 && signed.at(-1) === 0x0a);
  // Plain Ed25519 over the plan's bytes, checked without this module.
  const sig = Buffer.from(line.slice(12), 'base64');
  assert.ok(crypto.verify(null, Buffer.from(PLAN), publicKeyFromRaw(s.pub), sig));
  assert.equal(verifyFor(s.pub, signed, 'tjfq5rqwnnrxk3m9q2x7v4p8ab').toString(), PLAN);
  // CRLF on the signature line, and a missing final newline, are tolerated.
  verify(s.pub, Buffer.concat([signed.subarray(0, -1), Buffer.from('\r\n')]));
  verify(s.pub, signed.subarray(0, -1));
  assert.throws(() => s.sign(signed), /already signed/);
  assert.throws(() => s.sign(Buffer.from('ti-record\t1\n')), /not a ti-plan/);
});

test('no final newline: it is added, and signed', (t) => {
  const { s } = newSigner(t);
  const signed = s.sign(Buffer.from(PLAN.replace(/\n$/, '')));
  assert.ok(signed.subarray(0, PLAN.length).equals(Buffer.from(PLAN)));
  verify(s.pub, signed);
});

test('rejects', (t) => {
  const { s } = newSigner(t);
  const { s: other } = newSigner(t);
  const signed = s.sign(Buffer.from(PLAN)).toString('latin1');
  const flip = (() => { const i = signed.lastIndexOf('\t') + 5; return signed.slice(0, i) + (signed[i] === 'A' ? 'B' : 'A') + signed.slice(i + 1); })();
  const cases = {
    'tampered url': signed.replace('echo hi', 'echo HI'),
    'dropped line': signed.replace('name\tHello\n', ''),
    'added line': signed.replace('[target]\n', '[target]\nstep\trun\tevil\n'),
    'text after sig': signed + 'launch\tevil\n',
    'blank after sig': signed + '\n',
    'flipped sig bit': flip,
  };
  for (const [name, doc] of Object.entries(cases)) assert.throws(() => verify(s.pub, Buffer.from(doc, 'latin1')), VerifyError, name);
  assert.throws(() => verify(other.pub, Buffer.from(signed, 'latin1')), /does not verify/);
  assert.throws(() => verify(s.pub, Buffer.from(PLAN)), /not signed/);
  assert.throws(() => verifyFor(s.pub, Buffer.from(signed, 'latin1'), 'a'.repeat(26)), /is for record/);
  // A validly signed plan for another record is refused.
  const p2 = s.sign(Buffer.from(PLAN.replace('tjfq5rqwnnrxk3m9q2x7v4p8ab', 'b'.repeat(26))));
  assert.throws(() => verifyFor(s.pub, p2, 'tjfq5rqwnnrxk3m9q2x7v4p8ab'));
  // Non-canonical S (S + L) is refused.
  const i = signed.lastIndexOf('\t') + 1;
  const sig = Buffer.from(signed.slice(i, -1), 'base64');
  const L = Buffer.from('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010', 'hex');
  let c = 0;
  for (let k = 0; k < 32; k++) { const v = sig[32 + k] + L[k] + c; sig[32 + k] = v & 255; c = v >> 8; }
  assert.throws(() => verify(s.pub, Buffer.from(signed.slice(0, i) + sig.toString('base64') + '\n', 'latin1')));
});

test('recordOf and split', () => {
  assert.equal(recordOf(PLAN), 'tjfq5rqwnnrxk3m9q2x7v4p8ab');
  assert.equal(recordOf('ti-plan\t1\n\n[target]\nrecord\tx\n'), '', 'a record line inside a target block is not the header\'s');
  assert.equal(split(Buffer.from(PLAN)).ok, false);
});

// build/sign_test.go
test('addRequestLine', (t) => {
  const plan = 'ti-plan\t1\nrecord\tabc\n\n[target]\nwhen\tlinux\t0\t9999\t*\n';
  assert.equal(addRequestLine(plan, 'name', 'python', 'Some.Pkg'), 'ti-plan\t1\nrequest\tname\tpython\tSome.Pkg\nrecord\tabc\n\n[target]\nwhen\tlinux\t0\t9999\t*\n');
  // Tabs and newlines in a value can't add lines or fields.
  const got = addRequestLine(plan, 'name', 'python', 'a\tb\nlaunch\tevil');
  assert.equal(got.split('\n').length, plan.split('\n').length + 1);
  assert.throws(() => addRequestLine('ti-record\t1\n', 'name'));
  // The line is inside the signature.
  const { s } = newSigner(t);
  const signed = s.signString(addRequestLine(plan, 'name', 'python', 'requests'));
  assert.throws(() => verify(s.pub, Buffer.from(signed.replace('requests', 'evil'))));
});

// A second request line goes after the first, so `name` stays the first
// `request` line an engine reads (docs/format.md section 1).
test('addRequestLine keeps the order: name, then nonce', () => {
  const plan = 'ti-plan\t1\nrecord\tabc\n\n[target]\nwhen\tlinux\t0\t9999\t*\n';
  const hex = 'a'.repeat(32);
  const both = addRequestLine(addRequestLine(plan, 'name', 'python', 'requests'), 'nonce', hex);
  assert.equal(both.split('\n').slice(0, 4).join('\n'),
    'ti-plan\t1\nrequest\tname\tpython\trequests\nrequest\tnonce\t' + hex + '\nrecord\tabc');
  // A nonce alone is the second line, as `name` would have been.
  assert.equal(addRequestLine(plan, 'nonce', hex).split('\n')[1], 'request\tnonce\t' + hex);
});

// The revocation list is signed with the same key by the same rules, and
// its header keeps the two kinds of document apart (docs/format.md 7).
test('signing another kind of document', (t) => {
  const { s } = newSigner(t);
  const doc = 'ti-revocations\t1\nissued\t2026-09-20T11:00:00Z\nrevoke\trecord\tabc\n';
  const signed = s.signStringAs('ti-revocations', doc);
  assert.equal(verify(s.pub, Buffer.from(signed), 'ti-revocations').toString('utf8'), doc);
  // Not as a plan, and a plan is not one of these.
  assert.throws(() => verify(s.pub, Buffer.from(signed)), VerifyError);
  assert.throws(() => verify(s.pub, Buffer.from(s.signString(PLAN)), 'ti-revocations'), VerifyError);
  assert.throws(() => s.signStringAs('ti-revocations', PLAN));
  // A changed entry does not verify.
  assert.throws(() => verify(s.pub, Buffer.from(signed.replace('abc', 'xyz')), 'ti-revocations'), VerifyError);
});
