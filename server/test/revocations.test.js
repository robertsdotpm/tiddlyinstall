// The revocation document (lib/revocations.js, docs/format.md section 7).
import test from 'node:test';
import assert from 'node:assert/strict';
import { revocationsText, revokeValues, HOUR } from '../lib/revocations.js';

const AT = Date.parse('2026-09-20T11:02:07Z');

test('the header is the hour, not the minute', () => {
  const head = revocationsText(null, { now: AT, serial: 4711 }).split('\n').slice(0, 4);
  assert.deepEqual(head, ['ti-revocations\t1', 'issued\t2026-09-20T11:00:00Z', 'expires\t2026-09-20T12:00:00Z', 'serial\t4711']);
  // Every moment in one hour gives the same bytes, so the signature is stable.
  assert.equal(revocationsText(null, { now: AT }), revocationsText(null, { now: AT + 55 * 60 * 1000 }));
  assert.notEqual(revocationsText(null, { now: AT }), revocationsText(null, { now: AT + HOUR * 1000 }));
  // No list at all is still a document saying nothing is revoked.
  assert.equal(revocationsText(null, { now: AT }).split('\n').filter((l) => l.startsWith('revoke')).length, 0);
});

test('one revoke line per takedown entry, the words as values', () => {
  const entries = ['record tjfq5rqwnnrxk3m9q2x7v4p8ab', 'source github owner/repo', 'source package evil', 'sha ' + 'a'.repeat(64), 'file ' + 'b'.repeat(64), 'name python evil'];
  const lines = revocationsText(entries, { now: AT, serial: 1 }).split('\n').filter((l) => l.startsWith('revoke'));
  assert.deepEqual(lines, [
    'revoke\trecord\ttjfq5rqwnnrxk3m9q2x7v4p8ab',
    'revoke\tsource\tgithub\towner/repo',
    'revoke\tsource\tpackage\tevil',
    'revoke\tsha\t' + 'a'.repeat(64),
    'revoke\tfile\t' + 'b'.repeat(64),
    'revoke\tname\tpython\tevil',
  ]);
});

test('nothing an entry holds can break the format', () => {
  // Words, however they were spaced; no empty field in the middle.
  assert.deepEqual(revokeValues('  source   github   a/b  '), ['source', 'github', 'a/b']);
  assert.equal(revokeValues('   '), null);
  assert.equal(revokeValues(''), null);
  // A tab in the file is whitespace like a space, so no value can hold one.
  assert.deepEqual(revokeValues('record\tabc'), ['record', 'abc']);
  // Over the format's 1000-byte line limit: left out, never truncated.
  assert.equal(revokeValues('record ' + 'x'.repeat(1000)), null);
  const out = revocationsText(['record ' + 'x'.repeat(1000), 'record ok'], { now: AT });
  assert.equal(out.split('\n').filter((l) => l.startsWith('revoke')).join(''), 'revoke\trecord\tok');
  for (const l of out.split('\n')) assert.ok(!/\t\t/.test(l), l);
});
