// The job queue (plan.md 1.8): BullMQ on Redis runs the work; the ticket
// numbers, queue positions and wait estimates the front end shows are kept
// in Redis under the Go server's keys (ib:ticket, ib:job:<id>,
// ib:queued:<class>, ib:running:<class>, ib:dur:<class>), so the job JSON
// and the numbers mean the same.
//
// Classes, by what was asked for: `record` (mode A) before `build` (modes B
// and C) on the shared workers (BullMQ priorities, strict where Asynq's
// were weighted), and `pack` (offline installers: downloads) on a worker of
// its own, one at a time, so packs can't hold up records and builds.
import crypto from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

export const CLASSES = { record: 1, build: 2, pack: 3 };   // BullMQ priority: 1 runs first
const PREFIX = 'ib-bull';
const JOBS = 'ib-jobs', PACKS = 'ib-pack';
const WEEK = 7 * 24 * 3600;
const TIMEOUT = 2 * 3600 * 1000;   // Asynq's task timeout on the Go server

const key = (...parts) => ['ib', ...parts].join(':');

function newID() {
  return 'j_' + crypto.randomBytes(9).toString('hex');
}

const now = () => new Date().toISOString();

export class JobQueue {
  // addr "host:port", db, workers
  constructor(addr, db, workers) {
    const i = addr.lastIndexOf(':');
    this.conn = { host: addr.slice(0, i) || '127.0.0.1', port: Number(addr.slice(i + 1)), db };
    this.workers = workers;
    this.rdb = new IORedis({ ...this.conn, maxRetriesPerRequest: 1, lazyConnect: false });
    this.rdb.on('error', () => { /* reported by ping and submit */ });
    const connection = { ...this.conn, maxRetriesPerRequest: null };
    this.queues = { [JOBS]: new Queue(JOBS, { connection, prefix: PREFIX }), [PACKS]: new Queue(PACKS, { connection, prefix: PREFIX }) };
    for (const q of Object.values(this.queues)) q.on('error', () => {});
    this.running = [];
  }

  async ping() {
    let t;
    try {
      await Promise.race([this.rdb.ping(), new Promise((_, j) => { t = setTimeout(() => j(new Error('timeout')), 2000); })]);
    } finally {
      clearTimeout(t);
    }
  }

  async save(j) {
    await this.rdb.set(key('job', j.id), JSON.stringify(j), 'EX', WEEK);
  }

  async get(id) {
    const b = await this.rdb.get(key('job', id));
    if (b === null) return null;
    return JSON.parse(b);
  }

  // Submit queues a job and returns it with its ticket number.
  async submit(cls, request) {
    if (!Object.hasOwn(CLASSES, cls)) throw new Error('unknown class ' + JSON.stringify(cls));
    const ticket = await this.rdb.incr(key('ticket'));
    const j = { id: newID(), ticket, class: cls, status: 'queued', progress: 'Waiting in the queue', error: null, request, created: now() };
    await this.save(j);
    await this.rdb.zadd(key('queued', cls), ticket, j.id);
    try {
      await this.queues[cls === 'pack' ? PACKS : JOBS].add('ib:job', { id: j.id }, {
        jobId: j.id, priority: CLASSES[cls], attempts: 1,
        removeOnComplete: { age: 24 * 3600 }, removeOnFail: { age: 24 * 3600 },
      });
    } catch (e) {
      await this.rdb.zrem(key('queued', cls), j.id).catch(() => {});
      throw e;
    }
    return j;
  }

  // Position: how many tickets of the same class are queued ahead.
  async position(j) {
    if (j.status !== 'queued') return 0;
    try {
      const r = await this.rdb.zrank(key('queued', j.class), j.id);
      return r === null ? 0 : r;
    } catch (e) {
      return 0;
    }
  }

  // ETA estimates seconds until the job finishes: the jobs ahead plus this
  // one, at the recent average duration, spread over the workers. null when
  // there's no history yet.
  async eta(j, ahead) {
    let durs;
    try { durs = await this.rdb.lrange(key('dur', j.class), 0, 49); } catch (e) { return null; }
    if (!durs.length) return null;
    const avg = durs.reduce((s, d) => s + (parseFloat(d) || 0), 0) / durs.length;
    const w = j.class === 'pack' ? 1 : Math.max(1, this.workers);
    let secs;
    if (j.status === 'queued') {
      const running = await this.rdb.scard(key('running', j.class)).catch(() => 0);
      secs = ((ahead + running) / w + 1) * avg;
    } else if (j.status === 'running') {
      secs = j.started ? avg - (Date.now() - Date.parse(j.started)) / 1000 : 0;
      if (secs < 1) secs = 1;
    } else {
      return null;
    }
    return Math.floor(secs + 0.5);
  }

  // Depths: queued jobs per class.
  async depths() {
    const out = {};
    for (const c of Object.keys(CLASSES).sort()) out[c] = await this.rdb.zcard(key('queued', c)).catch(() => 0);
    return out;
  }

  // serve runs the workers: handler(job, progress) -> result object.
  serve(handler, log = console.log) {
    const work = async (bj) => {
      const j = await this.get(bj.data.id);
      if (!j) return;
      j.status = 'running';
      j.started = now();
      j.progress = 'Starting';
      await this.rdb.zrem(key('queued', j.class), j.id);
      await this.rdb.sadd(key('running', j.class), j.id);
      // Progress is saved in order, and before the final state.
      let saving = this.save(j);
      const progress = (s) => {
        j.progress = s;
        saving = saving.then(() => this.save(j)).catch(() => {});
      };
      let res, err = null, timer;
      try {
        res = await Promise.race([
          handler(j, progress),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('the job took over 2 hours')), TIMEOUT); }),
        ]);
      } catch (e) {
        err = e;
      } finally {
        clearTimeout(timer);
        await this.rdb.srem(key('running', j.class), j.id).catch(() => {});
      }
      await saving;
      j.finished = now();
      if (err) {
        j.status = 'failed';
        j.error = err && err.message ? err.message : String(err);
        j.progress = 'Failed';
      } else {
        j.status = 'done';
        j.result = res;
        j.progress = 'Done';
        const d = (Date.parse(j.finished) - Date.parse(j.started)) / 1000;
        await this.rdb.lpush(key('dur', j.class), d.toFixed(2));
        await this.rdb.ltrim(key('dur', j.class), 0, 49);
      }
      await this.save(j);
      // Failures are reported on the job, not retried.
    };
    const connection = { ...this.conn, maxRetriesPerRequest: null };
    const opts = { connection, prefix: PREFIX, lockDuration: 120000, maxStalledCount: 1 };
    this.running = [
      new Worker(JOBS, work, { ...opts, concurrency: Math.max(1, this.workers) }),
      new Worker(PACKS, work, { ...opts, concurrency: 1 }),
    ];
    for (const w of this.running) w.on('error', (e) => log('workers: ' + e.message));
  }

  async close() {
    await Promise.allSettled(this.running.map((w) => w.close()));
    await Promise.allSettled(Object.values(this.queues).map((q) => q.close()));
    this.rdb.disconnect();
  }
}
