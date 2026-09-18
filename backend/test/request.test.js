// POST /api/jobs bodies are decoded as Go's encoding/json decodes them into
// build.Request; JSON is written as Go writes it; flags parse as Go's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRequest, BadJSON } from '../lib/request.js';
import { goJSON, sorted, Raw } from '../lib/gojson.js';
import { Limiter } from '../lib/limiter.js';
import { parseFlags } from '../server.js';

const dec = (s) => decodeRequest(Buffer.from(s));

test('decoding: defaults, case-insensitive keys, later keys win, null', () => {
  const r = dec('{"Name":"a","name":"b","RUNTIME":"python","source":{"KIND":"inline"},"console":null,"desktop":true,"unknown":[1,2]}');
  assert.equal(r.name, 'b');
  assert.equal(r.runtime, 'python');
  assert.equal(r.source.kind, 'inline');
  assert.equal(r.console, null);
  assert.equal(r.menu, null);
  assert.equal(r.desktop, true);
  assert.equal(r.platforms, null);
  assert.equal(r.files, null);
  assert.equal(r.icon, null);
  assert.equal(dec('null').mode, '');
  assert.deepEqual(dec('{"files":{"a":null,"b":"x"}}').files, { a: '', b: 'x' });
  assert.deepEqual(dec('{"platforms":["linux",null]}').platforms, ['linux', '']);
  assert.equal(dec('{"icon":{"Data":"abc"}}').icon.data, 'abc');
});

test('decoding: wrong types and non-objects are bad JSON', () => {
  for (const s of ['[1]', '"x"', '5', 'true', '{"name":5}', '{"console":"yes"}', '{"platforms":"linux"}', '{"platforms":[1]}',
    '{"files":[]}', '{"files":{"a":1}}', '{"source":"x"}', '{"icon":5}', '{"desktop":null,"offline":1}', '{', '{}x', '']) {
    assert.throws(() => dec(s), BadJSON, s);
  }
});

test('JSON as Go writes it', () => {
  const ls = String.fromCharCode(0x2028), ps = String.fromCharCode(0x2029);
  assert.equal(goJSON(sorted({ error: 'a <b> & c', code: 'x' })), '{"code":"x","error":"a \\u003cb\\u003e \\u0026 c"}');
  assert.equal(goJSON({ s: ls + ps + '\b\f\n' }), '{"s":"\\u2028\\u2029\\u001b\\b\\f\\n"}');
  assert.equal(goJSON({ a: null, b: undefined, c: [1, true], d: new Raw('{"x":1}') }), '{"a":null,"c":[1,true],"d":{"x":1}}');
});

test('rate limits per address', () => {
  const l = new Limiter(2, 1000);
  assert.ok(l.allow('a', 0));
  assert.ok(l.allow('a', 10));
  assert.ok(!l.allow('a', 20));
  assert.ok(l.allow('b', 20));
  assert.ok(l.allow('a', 1001));
});

test('flags: Go\'s forms and defaults', () => {
  const o = parseFlags(['-addr', ':8090', '--redis-db=2', '-mirror-last', '-workers', '3', '-public=http://x:1'], '/home/u');
  assert.equal(o.addr, ':8090');
  assert.equal(o['redis-db'], 2);
  assert.equal(o['mirror-last'], true);
  assert.equal(o.workers, 3);
  assert.equal(o.public, 'http://x:1');
  assert.equal(o.catalog, '/home/u/projects/installer-builder-runtimes/catalog');
  assert.equal(parseFlags([], '/h').redis, '127.0.0.1:6390');
  assert.equal(parseFlags(['-mirror-last=false'], '/h')['mirror-last'], false);
  assert.throws(() => parseFlags(['-nope', 'x']), /not defined/);
  assert.throws(() => parseFlags(['-workers', 'many']), /invalid value/);
});
