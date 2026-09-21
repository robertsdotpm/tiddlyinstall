// Ports the Go server's netsafe_test.go (retired), and checks the client
// refuses every way to reach a private address.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isPublic, safeFetch } from '../lib/netsafe.js';

test('isPublic', () => {
  const want = {
    '8.8.8.8': true, '2606:4700::1111': true, '1.1.1.1': true, '::ffff:8.8.8.8': true, '172.32.0.1': true, '100.128.0.1': true,
    '127.0.0.1': false, '10.0.1.76': false, '192.168.1.1': false, '172.16.0.1': false, '172.31.255.255': false,
    '169.254.169.254': false, '100.64.0.1': false, '::1': false, 'fe80::1': false, 'fd00::1': false, 'fc00::1': false,
    '0.0.0.0': false, '0.1.2.3': false, '::ffff:127.0.0.1': false, '::ffff:10.0.0.1': false, '::': false, '224.0.0.1': false,
    '255.255.255.255': false, 'ff02::1': false, 'not an ip': false, '': false,
  };
  for (const [ip, w] of Object.entries(want)) assert.equal(isPublic(ip), w, ip);
});

function server(t) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => res.end('secret'));
    s.listen(0, '127.0.0.1', () => { t.after(() => s.close()); resolve(s.address().port); });
  });
}

test('refuses loopback, by address and by name', async (t) => {
  const port = await server(t);
  for (const u of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://2130706433:${port}/`, `http://0x7f.1:${port}/`]) {
    await assert.rejects(safeFetch(u, { timeout: 5000 }), /address not allowed/, u);
  }
});

test('refuses private and link-local addresses', async () => {
  for (const u of ['http://10.0.0.1/', 'http://192.168.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://[fd00::1]/']) {
    await assert.rejects(safeFetch(u, { timeout: 5000 }), /address not allowed/, u);
  }
});

test('refuses other schemes', async () => {
  await assert.rejects(safeFetch('file:///etc/passwd'), /unsupported protocol scheme/);
  await assert.rejects(safeFetch('ftp://example.com/x'), /unsupported protocol scheme/);
});
