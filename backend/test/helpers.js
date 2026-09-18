// Shared test helpers: the repo's catalogue (tests that need it skip when
// it isn't there), temporary folders, and a fetch for local test servers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from '../lib/catalog.js';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIMES = path.join(os.homedir(), 'projects', 'installer-builder-runtimes');
export const BASES = path.join(REPO, 'bases');
export const haveCatalog = fs.existsSync(path.join(RUNTIMES, 'catalog', 'os_versions.json'));
export const haveBases = fs.existsSync(path.join(BASES, 'windows', 'out', 'base.exe'));

export function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-test-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A fresh catalogue (tests may change its policy).
export function catalog() {
  return loadCatalog({ dir: path.join(RUNTIMES, 'catalog'), policyPath: path.join(REPO, 'server', 'policy.json'), localRoot: '', cachePath: '/dev/null' });
}

// The Builder's fetch, without the public-only check: for servers the test
// runs on this machine. Answers as lib/netsafe.js's SafeResponse does.
export async function localFetch(url, opts = {}) {
  const r = await fetch(url, { method: opts.method || 'GET', headers: opts.headers, body: opts.body, redirect: 'follow' });
  const body = r.body ? Readable.fromWeb(r.body) : Readable.from([]);
  return {
    status: r.status, statusText: r.statusText, statusLine: r.status + ' ' + r.statusText, headers: Object.fromEntries(r.headers), body, ok: r.ok,
    async bytes(limit = Infinity) { const b = Buffer.from(await new Response(Readable.toWeb(body)).arrayBuffer()); if (b.length > limit) throw new Error('download too large'); return b; },
    async upTo(limit) { const b = Buffer.from(await new Response(Readable.toWeb(body)).arrayBuffer()); return b.subarray(0, limit); },
    discard() { body.resume(); },
  };
}
