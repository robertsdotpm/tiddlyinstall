// Who gets rate-limited, behind a proxy and without one.
//
// The documented deployment runs this server on 127.0.0.1 with Apache in
// front, so req.socket.remoteAddress is 127.0.0.1 for every caller on
// earth: the per-address limiters became one global bucket and every log
// line named the proxy. Honouring X-Forwarded-For fixes that and breaks
// something worse if it is done unconditionally, so it is behind a flag
// and only when the peer really is loopback.
import test from 'node:test';
import assert from 'node:assert';
import { clientIP } from '../server.js';

const req = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

test('without -trust-proxy the header is ignored', () => {
  assert.equal(clientIP(req('127.0.0.1', { 'x-forwarded-for': '9.9.9.9' }), false), '127.0.0.1');
  assert.equal(clientIP(req('203.0.113.7', { 'x-forwarded-for': '9.9.9.9' }), false), '203.0.113.7');
});

test('with -trust-proxy, a loopback peer means the header is our proxy speaking', () => {
  assert.equal(clientIP(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' }), true), '203.0.113.7');
  assert.equal(clientIP(req('::1', { 'x-forwarded-for': '203.0.113.7' }), true), '203.0.113.7');
});

test('a caller cannot choose their own bucket: the last hop wins', () => {
  // Apache appends the real peer, so the rightmost entry is the one it
  // wrote. A caller who sends their own header only prepends to it.
  assert.equal(clientIP(req('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 203.0.113.7' }), true), '203.0.113.7');
  assert.equal(clientIP(req('127.0.0.1', { 'x-forwarded-for': '  9.9.9.9 ,  203.0.113.7  ' }), true), '203.0.113.7');
});

test('a non-loopback peer is never overridden, even with the flag on', () => {
  // If the server is exposed directly, the header is a caller's input.
  assert.equal(clientIP(req('203.0.113.9', { 'x-forwarded-for': '9.9.9.9' }), true), '203.0.113.9');
});

test('IPv4-mapped peers are bare, and a missing header falls back', () => {
  assert.equal(clientIP(req('::ffff:203.0.113.7'), false), '203.0.113.7');
  assert.equal(clientIP(req('127.0.0.1', {}), true), '127.0.0.1');
});

test('Forwarded is read when X-Forwarded-For is absent', () => {
  assert.equal(clientIP(req('127.0.0.1', { forwarded: 'for=203.0.113.7;proto=https' }), true), '203.0.113.7');
});
