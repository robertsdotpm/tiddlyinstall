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
  return loadCatalog({ dir: path.join(RUNTIMES, 'catalog'), policyPath: path.join(REPO, 'backend', 'policy.json'), localRoot: '', cachePath: '/dev/null' });
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

/* ---------- a Redis database no other test run is using ---------- */

// Two suites (server.test.js, form.test.js) each want a Redis database
// with nothing else in it, and each deletes every `ib:*` and `ib-bull:*`
// key in it when it finishes. Fixed numbers -- 5 and 6 -- kept those two
// apart, but not two *runs* of the same suite: with several agents on
// this machine, a second `npm test` flushes the first one's keys
// mid-flight and the first fails with things like "no such record". The
// failures land in whichever subtest was unlucky, look like real bugs,
// and cost an hour each time. Seen today in both suites.
//
// So the database is claimed rather than assumed. `SET <key> <token> NX
// PX` in a candidate database is Redis's own atomic test-and-set: the
// first run to get it owns that database, later runs move on to the
// next. A heartbeat keeps the claim alive while the suite runs and the
// TTL releases it if the run is killed, so nothing can be left locked.
// Set IB_TEST_REDIS_DB (or IB_TEST_FORM_REDIS_DB) to pin one anyway.
const CLAIM_KEY = 'ib-test-claim';
const CLAIM_MS = 60000;

// The databases a claim may use: Redis ships with 16 (0-15). 0 is the
// dev server's and 1-4 are left for anything else on this machine, and
// **5 and 6 are deliberately left out**: they are the numbers the old
// code hardcoded, so a checkout from before this change -- another
// agent's worktree, a stale shell -- will still take them, and a claim
// cannot stop it. Claiming only 7 and up means a run of this code is
// safe from a run of that one, which is the case that was actually
// biting. That is also how the bug was finally pinned down: with the
// claim taking 5 first, a test job vanished into another process's
// worker and the data folder had no `records` directory at all, though
// the job reported done and returned an installer.
export const TEST_DBS = [7, 8, 9, 10, 11, 12, 13, 14, 15];

// Claims a database, registers the release (its claim, and every ib: and
// ib-bull: key it made) with the test, and returns the number. `pinned`
// is an env var's value: given one, that database is used as it always
// was, with no claim, so a caller who wants a fixed number still gets it.
export async function claimRedisDb(t, IORedis, addr, pinned) {
  const [host, port] = [addr.slice(0, addr.lastIndexOf(':')), Number(addr.slice(addr.lastIndexOf(':') + 1))];
  const token = process.pid + '-' + Math.random().toString(36).slice(2);
  const clean = async (db) => {
    const r = new IORedis({ host, port, db });
    try {
      for (const pat of ['ib:*', 'ib-bull:*']) {
        const keys = await r.keys(pat);
        if (keys.length) await r.del(...keys);
      }
      // Only ever release our own claim: a claim that timed out and was
      // taken by another run must not be deleted from under it.
      if (await r.get(CLAIM_KEY) === token) await r.del(CLAIM_KEY);
    } finally {
      r.disconnect();
    }
  };
  if (pinned !== undefined && pinned !== '') {
    const db = Number(pinned);
    t.after(() => clean(db));
    return db;
  }
  const deadline = Date.now() + 120000;
  for (;;) {
    for (const db of TEST_DBS) {
      const r = new IORedis({ host, port, db });
      let got;
      try { got = await r.set(CLAIM_KEY, token, 'PX', CLAIM_MS, 'NX'); } finally { r.disconnect(); }
      if (got !== 'OK') continue;
      const beat = setInterval(() => {
        const h = new IORedis({ host, port, db });
        h.set(CLAIM_KEY, token, 'PX', CLAIM_MS, 'XX').catch(() => {}).finally(() => h.disconnect());
      }, CLAIM_MS / 3);
      beat.unref();
      t.after(async () => { clearInterval(beat); await clean(db); });
      return db;
    }
    if (Date.now() > deadline) {
      throw new Error('every Redis test database (' + TEST_DBS.join(', ') + ') is claimed by another test run; '
        + 'set IB_TEST_REDIS_DB to pick one anyway, or wait for the other run to finish');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
