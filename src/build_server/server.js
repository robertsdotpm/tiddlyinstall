#!/usr/bin/env node
// The TiddlyInstall build server in Node.js (plan.md sections 1.8 and 1.11):
// the HTTP API (docs/api.md), the BullMQ workers, and the one-file site.
// It began as a port of the Go server (server/cmd/ibserver, retired
// 2026-09-19) on the JavaScript core the browser runs too: src/shared/resolve.js,
// src/shared/builder.js, src/shared/tifile.js, src/shared/icon.js, and keeps that server's flags,
// URLs, JSON, data folder layout and Redis keys.
//
//   node src/build_server/server.js -addr :8080 -redis 127.0.0.1:6390 -public http://10.0.1.76:8080
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runtimesSummary, packagePolicyFor, validPackage, goQuote } from '../shared/resolve.js';
import { validate, iconBytes } from '../shared/builder.js';
import { decodeIconPng } from '../shared/icon.js';
import { loadCatalog } from './lib/catalog.js';
import { Builder, isHash26, isSHA256, isNonce } from './lib/jobs.js';
import { JobQueue } from './lib/queue.js';
import { loadOrCreate, defaultKeyDir, keyID, checkKeyID, expectedKeyID, PUB_FILE, REVOCATIONS_KIND, RELEASES_KIND } from './lib/plansig.js';
import { revocationsText } from './lib/revocations.js';
import crypto from 'node:crypto';
import { parseFile as parseReleaseFile, releasesText } from './lib/releases.js';
// The same digest the page computes over the same bytes (shared/ledger.js).
const sha256hex = (str) => crypto.createHash('sha256').update(str, 'utf8').digest('hex');
import { safeFetch } from './lib/netsafe.js';
import { Limiter } from './lib/limiter.js';
import { signRelay } from './lib/signrelay.js';
import { goJSON, sorted, goString } from './lib/gojson.js';
import { decodeRequest, BadJSON } from './lib/request.js';
import { serveFile, serveDir, notFound, httpError, redirect } from './lib/files.js';
import { parseForm, BadForm } from './lib/form.js';
import { PAGE_HEADERS, classicPage, refusedPage, statusPage, missingJobPage } from './lib/pages.js';
import { jobFromForm, postedForm } from '../shared/form-job.js';

export const VERSION = '0.1.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/build_server/ -> the repository root, two levels up. HERE is where
// this server's own files are; REPO is where everything else is reached
// from, and the two stopped being the same folder's parent when the tree
// moved under src/ (2026-09-22).
const REPO = path.dirname(path.dirname(HERE));

/* ---------- flags (Go's flag package: -name value, -name=value, --name) ---------- */

export function parseFlags(argv, home = os.homedir()) {
  const defs = {
    addr: [':8080', 'listen address'],
    redis: ['127.0.0.1:6390', 'Redis address'],
    catalog: [path.join(home, 'projects/installer-builder-runtimes/catalog'), 'runtime catalogue'],
    local: [path.join(home, 'projects/installer-builder-runtimes'), 'our copies of catalogue files (served at /mirror/)'],
    policy: [path.join(HERE, 'policy.json'), 'resolver policy'],
    data: [path.join(HERE, 'data'), 'data folder'],
    keys: ['', 'where the plan signing private key lives (default $TI_KEYS, else ~/.config/tiddlyinstall/keys)'],
    site: [path.join(REPO, 'out'), 'static site to serve at / (tools/build_site.py writes it)'],
    bases: [path.join(REPO, 'src/installers'), 'base installers'],
    public: ['https://tiddlyinstall.warpgate.io', "this server's public URL"],
    workers: [2, 'concurrent jobs (records and builds; packs have one worker of their own)'],
    'redis-db': [0, 'Redis database number (a second instance needs its own)'],
    mirror: ['', "URL of our mirror in plans (default: the policy's mirror_base)"],
    'mirror-last': [false, "list our mirror after the vendors' URLs (for machines that reach us over a slow link)"],
    'trust-proxy': [false, 'take the caller from X-Forwarded-For when the connection comes from loopback (set this only when a reverse proxy is genuinely in front, or every rate limit becomes spoofable)'],
  };
  const out = {};
  for (const [k, [v]] of Object.entries(defs)) out[k] = v;
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') break;
    if (!a.startsWith('-') || a === '-') throw new Error('unexpected argument ' + a);
    a = a.replace(/^--?/, '');
    if (a === 'h' || a === 'help') {
      const lines = Object.entries(defs).map(([k, [v, d]]) => `  -${k}${typeof v === 'boolean' ? '' : ' ' + (typeof v === 'number' ? 'int' : 'string')}\n    \t${d} (default ${JSON.stringify(v)})`);
      throw Object.assign(new Error('Usage of server.js:\n' + lines.join('\n')), { help: true });
    }
    let val = null;
    const eq = a.indexOf('=');
    if (eq >= 0) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    if (!Object.hasOwn(defs, a)) throw new Error('flag provided but not defined: -' + a);
    const d = defs[a][0];
    if (typeof d === 'boolean') {
      out[a] = val === null ? true : /^(1|t|true|TRUE|True)$/.test(val) ? true : /^(0|f|false|FALSE|False)$/.test(val) ? false : (() => { throw new Error('invalid boolean value ' + JSON.stringify(val) + ' for -' + a); })();
      continue;
    }
    if (val === null) {
      if (i + 1 >= argv.length) throw new Error('flag needs an argument: -' + a);
      val = argv[++i];
    }
    if (typeof d === 'number') {
      if (!/^[+-]?\d+$/.test(val)) throw new Error('invalid value ' + JSON.stringify(val) + ' for flag -' + a);
      out[a] = parseInt(val, 10);
    } else {
      out[a] = val;
    }
  }
  return out;
}

/* ---------- small helpers ---------- */

function logf(msg) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  process.stdout.write(`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${msg}\n`);
}

// time.Duration.Round(time.Millisecond).String()
function fmtDur(ms) {
  ms = Math.round(ms);
  if (ms === 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  let s = ms / 1000;
  let out = '';
  if (s >= 3600) { out += Math.floor(s / 3600) + 'h'; s %= 3600; }
  if (out || s >= 60) { out += Math.floor(s / 60) + 'm'; s %= 60; }
  return out + String(Number(s.toFixed(3))) + 's';
}

const bare = (a) => (String(a || '').startsWith('::ffff:') ? String(a).slice(7) : String(a || ''));
const loopback = (a) => a === '127.0.0.1' || a === '::1' || a.startsWith('127.');

// Who to rate-limit and to log.
//
// The documented deployment puts this server on 127.0.0.1 behind Apache,
// and the socket peer is then 127.0.0.1 for everybody: every per-address
// limit becomes one global bucket, and every log line names the proxy.
// So when the peer really is loopback and the operator has said a proxy
// is in front, take the last hop of X-Forwarded-For -- the last, because
// each proxy appends, so the rightmost entry is the one our own proxy
// wrote and the only one a caller could not forge. Without -trust-proxy
// the header is ignored entirely: honouring it on a directly exposed
// server would let anyone reset their own limit with a header.
export function clientIP(req, trustProxy) {
  const peer = bare(req.socket.remoteAddress);
  if (!trustProxy || !loopback(peer)) return peer;
  const xff = String(req.headers['x-forwarded-for'] || '');
  if (xff) {
    const hops = xff.split(',').map((h) => bare(h.trim())).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  const fwd = /for=\"?\[?([^\];,\" ]+)/i.exec(String(req.headers.forwarded || ''));
  return fwd ? bare(fwd[1]) : peer;
}

function writeJSON(res, status, v, headers = {}) {
  res.writeHead(status, Object.assign({}, headers, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }));
  res.end(goJSON(v) + '\n');
}

function apiError(res, status, code, msg) {
  writeJSON(res, status, sorted({ error: msg, code }));
}

// Reads at most `limit` bytes of a request body (Go's io.LimitReader): the
// rest is not read, and the connection is closed after the answer.
function readBody(req, res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const onData = (c) => {
      const take = c.subarray(0, limit - n);
      chunks.push(take);
      n += take.length;
      if (n >= limit) {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.pause();
        res.setHeader('Connection', 'close');
        resolve(Buffer.concat(chunks));
      }
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', reject);
  });
}

// path.Clean, keeping a trailing slash (net/http's cleanPath).
function cleanPath(p) {
  if (p === '') return '/';
  if (p[0] !== '/') p = '/' + p;
  const np = path.posix.normalize(p).replace(/\/+$/, '') || '/';
  return p.length > 1 && p.endsWith('/') && np !== '/' ? np + '/' : np;
}

function decodePath(p) {
  try { return decodeURIComponent(p); } catch (e) { return null; }
}

const BODY_MAX = 4 << 20;
const ICON_MAX = 1 << 20;
const RATE_LIMITED = 'Too many builds from your address; try again in a minute.';

// The body of a 303: a link, for anything that doesn't follow it.
function page303(loc) {
  const h = loc.replace(/[&'<>"]/g, (c) => ({ '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;', '"': '&#34;' }[c]));
  return '<a href="' + h + '">See the build</a>.\n';
}

// tsaURLs are the only timestamp servers /api/tsa forwards to. None of them
// sends CORS headers and most are plain HTTP, so a page can't call them.
const TSA_URLS = {
  digicert: 'http://timestamp.digicert.com',
  sectigo: 'http://timestamp.sectigo.com',
  globalsign: 'http://timestamp.globalsign.com/tsa/r6advanced1',
  sslcom: 'http://ts.ssl.com',
  certum: 'http://time.certum.pl',
};

/* ---------- the server ---------- */

export class Server {
  // o: the flags, plus optional {log}
  constructor(o) {
    this.o = o;
    this.log = o.log || logf;
    this.data = o.data;
    this.local = o.local;
    this.site = o.site;
    this.bases = o.bases;
    this.limiter = new Limiter(20, 60000);
    // The relay caps /api/relay (and /api/tsa) per address, so it can't burn bandwidth.
    this.relayLimiter = new Limiter(30, 60000);
    // Plain file names resolve through their own limiter: each can ask a registry.
    this.nameLimiter = new Limiter(30, 60000);
    this.runtimesBody = null;
  }

  async init() {
    const o = this.o;
    // resedit (src/vendor/, MIT) edits Windows icons in src/shared/icon.js; the page loads
    // it as a classic script that sets globalThis.__TI_RESEDIT.
    if (!globalThis.__TI_RESEDIT) await import(pathToFileURL(path.join(REPO, 'src', 'vendor', 'resedit-bundle.js')).href);
    this.cat = loadCatalog({ dir: o.catalog, policyPath: o.policy, localRoot: o.local, cachePath: path.join(o.data, 'sha-cache.json') });
    if (o.mirror !== '') this.cat.policy.mirror_base = o.mirror;
    if (o['mirror-last']) this.cat.policy.mirror_first = false;
    // The private key is not kept in the data directory or anywhere under
    // the repository: see defaultKeyDir(). The public half is copied into
    // the data directory as well, because that is where the base builds
    // read it from and it is not a secret.
    this.trustProxy = !!o['trust-proxy'];
    const keyDir = o.keys || defaultKeyDir();
    const { signer, created } = loadOrCreate(keyDir, this.log, o.data);
    if (created) this.log(`made a new plan signing key in ${keyDir}; rebuild the bases with ${path.join(o.data, PUB_FILE)}`);
    this.log(`plan signing key ${keyID(signer.pub)} (${signer.publicBase64()})`);
    // Refuse to serve with a key this repository does not expect. A server
    // signing plans with the wrong key produces installers that verify
    // against themselves and against nothing else, which is the failure
    // this pin exists for. Only when the key came from the default
    // directory: a test or a second instance pointed at its own key with
    // --keys is doing that on purpose.
    if (!o.keys && expectedKeyID()) checkKeyID(signer.pub, 'serve');
    this.signer = signer;
    this.q = new JobQueue(o.redis, o['redis-db'], o.workers);
    // Every outgoing fetch a user can influence (sources, packs, registries,
    // the relay) goes through lib/netsafe.js, which only reaches public addresses.
    this.b = new Builder({ cat: this.cat, data: o.data, bases: o.bases, public: o.public, signer,
      takenDown: (e) => this.takenDown(e), revokedFiles: () => this.revokedFiles() });
    this.relayOK = new Set();
    for (const rt of this.cat.runtimes.values()) {
      for (const e of rt.releases) {
        this.relayOK.add(e.url);
        for (const m of e.mirrors || []) this.relayOK.add(m);
        for (const p of e.parts || []) {
          this.relayOK.add(p.url);
          for (const m of p.mirrors || []) this.relayOK.add(m);
        }
      }
    }
  }

  serveWorkers() {
    this.q.serve((j, progress) => this.b.run(j.request, progress), this.log);
  }

  // The runtimes summary, cached until restart.
  runtimesJSON() {
    if (this.runtimesBody === null) this.runtimesBody = goJSON(runtimesSummary(this.cat));
    return this.runtimesBody;
  }

  /* ---------- takedown ---------- */

  takedownPath() { return path.join(this.data, 'takedown.txt'); }
  releasesPath() { return path.join(this.data, 'releases.txt'); }

  takedownList() {
    let text;
    try { text = fs.readFileSync(this.takedownPath(), 'utf8'); } catch (e) { return null; }
    const out = [];
    for (const raw of text.split('\n')) {
      const l = raw.replace(/^[\s\u0085\u00a0]+|[\s\u0085\u00a0]+$/g, '');
      if (l !== '' && !l.startsWith('#')) out.push(l);
    }
    return out.length ? out : null;   // Go's nil slice: "entries": null
  }

  takenDown(entry) {
    return (this.takedownList() || []).includes(entry);
  }

  // A download by its SHA-256. `sha <hash>` names one of our stored files
  // (a source, an icon); `file <hash>` (2026-09-20, design.md 7.1) revokes
  // the bytes themselves wherever they come from, which is how a bad
  // runtime build named by many records at once is reached. A file we do
  // store is refused by either.
  takenDownSha(sha) {
    const list = this.takedownList() || [];
    return list.includes('sha ' + sha) || list.includes('file ' + sha);
  }

  // The SHA-256s the list names, for the resolver: a withdrawn build is
  // treated as a build that does not exist, so a plan is written for the
  // next one rather than for a download the installer will refuse
  // (design.md 7.1). `sha` and `file` both name bytes, so both count.
  revokedFiles() {
    const out = [];
    for (const e of this.takedownList() || []) {
      const m = /^(?:sha|file)[ \t]+([0-9a-fA-F]{64})$/.exec(e);
      if (m) out.push(m[1].toLowerCase());
    }
    return out;
  }

  // sourceKey normalises a source for the takedown list, so owner/repo,
  // https://github.com/owner/repo(.git)(/) and case variants all match.
  static sourceKey(kind, value) {
    let v = String(value).trim().toLowerCase();
    if (kind === 'github') {
      v = v.replace(/^https:\/\//, '').replace(/^http:\/\//, '');
      v = v.replace(/^github\.com\//, '');
      v = v.replace(/\/$/, '').replace(/\.git$/, '');
    }
    return 'source ' + kind + ' ' + v;
  }

  /* ---------- routing ---------- */

  handler() {
    return (req, res) => {
      const start = Date.now();
      const u = req.url || '/';
      const q = u.indexOf('?');
      const rawPath = q >= 0 ? u.slice(0, q) : u;
      res.on('finish', () => {
        const p = decodePath(rawPath) ?? rawPath;
        // Status polls stay out of the log (a status page reloads itself
        // every 3 s); its last view, with the downloads, is logged.
        if (!p.startsWith('/api/jobs/') && p !== '/api/health' && !res.tiQuiet) {
          this.log(`${clientIP(req, this.trustProxy)} ${req.method} ${p} ${fmtDur(Date.now() - start)}`);
        }
      });
      // CORS: every route, every origin; no route uses cookies or credentials.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, ETag');
      res.setHeader('Access-Control-Max-Age', '86400');
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      this.route(req, res, rawPath, q >= 0 ? u.slice(q + 1) : '').catch((e) => {
        this.log('error: ' + (e && e.stack ? e.stack : e));
        if (!res.headersSent) apiError(res, 500, 'internal', 'internal error');
        else res.destroy();
      });
    };
  }

  async route(req, res, rawPath, query) {
    const decoded = decodePath(rawPath);
    if (decoded === null) return httpError(res, 'Bad Request', 400);
    const q = query ? '?' + query : '';
    // Go's mux: /src and /mirror go to their folders' paths...
    if (rawPath === '/src' || rawPath === '/mirror') return redirect(req, res, cleanPath(decoded) + '/' + q);
    // ...and a path that isn't clean (as sent, still escaped) to the clean one.
    const clean = cleanPath(rawPath);
    if (clean !== rawPath) return redirect(req, res, clean + q);
    const params = new URLSearchParams(query);
    const seg = rawPath.split('/').slice(1).map((s) => decodePath(s));
    const m = req.method === 'HEAD' ? 'GET' : req.method;
    const is = (method, ...parts) => {
      if (seg.length !== parts.length) return false;
      for (let i = 0; i < parts.length; i++) {
        if (parts[i] === '*') { if (seg[i] === '' || seg[i] === null) return false; } else if (seg[i] !== parts[i]) return false;
      }
      return true;
    };
    const routes = [
      ['GET', ['api', 'health'], () => this.health(req, res)],
      ['POST', ['api', 'jobs'], () => this.submit(req, res)],
      // The same, for browsers that can't run the page (docs/api.md "Plain form posts").
      ['POST', ['submit'], () => this.submitForm(req, res)],
      // Its address opened directly (a bookmark, a reload of a refused post): the form.
      ['GET', ['submit'], () => redirect(req, res, 'classic', 303)],
      ['GET', ['status', '*'], () => this.status(req, res, seg[1])],
      ['GET', ['classic'], () => this.classic(req, res)],
      ['GET', ['api', 'jobs', '*'], () => this.job(req, res, seg[2])],
      ['GET', ['api', 'records', '*'], () => this.record(req, res, seg[2])],
      ['GET', ['api', 'plan', 'name', '*', '*'], () => this.planByName(req, res, seg[3], seg[4], params)],
      ['GET', ['api', 'plan', '*'], () => this.plan(req, res, seg[2], params)],
      ['GET', ['api', 'pubkey'], () => this.pubkey(req, res)],
      ['GET', ['api', 'catalog', 'runtimes'], () => this.runtimes(req, res)],
      ['GET', ['api', 'catalog', 'archive'], () => this.catalogArchive(req, res)],
      ['GET', ['api', 'catalog', 'attest'], () => this.catalogAttest(req, res)],
      ['GET', ['api', 'takedown'], () => this.takedown(req, res)],
      ['GET', ['api', 'revocations'], () => this.revocations(req, res)],
      ['GET', ['api', 'releases'], () => this.releases(req, res)],
      ['GET', ['api', 'relay'], () => this.relay(req, res, params)],
      ['POST', ['api', 'tsa'], () => this.tsa(req, res, params)],
      ['POST', ['api', 'sign', '*'], () => this.sign(req, res, seg[2])],
      ['GET', ['dl', '*', '*'], () => this.dl(req, res, seg[1], seg[2])],
      ['GET', ['bases', '*'], () => this.base(req, res, seg[1])],
      ['GET', ['icons', '*'], () => this.icon(req, res, seg[1])],
    ];
    const allowed = new Set();
    for (const [method, parts, fn] of routes) {
      if (!is(method, ...parts)) continue;
      if (method === m) return fn();
      allowed.add(method);
    }
    // The rest is GET: stored sources, our mirror, the site.
    if (m === 'GET') {
      if (decoded.startsWith('/src/')) return this.src(req, res, decoded.slice(5));
      if (decoded.startsWith('/mirror/')) return serveDir(req, res, this.local, decoded.slice(8));
      return this.siteFile(req, res, decoded);
    }
    allowed.add('GET');
    const list = [...allowed].flatMap((x) => (x === 'GET' ? ['GET', 'HEAD'] : [x])).sort();
    res.writeHead(405, { Allow: list.join(', '), 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
    res.end('Method Not Allowed\n');
  }

  /* ---------- handlers ---------- */

  async health(req, res) {
    try {
      await this.q.ping();
    } catch (e) {
      return writeJSON(res, 503, sorted({ ok: false, version: VERSION, error: 'queue unavailable' }));
    }
    writeJSON(res, 200, sorted({ ok: true, version: VERSION, workers: this.o.workers, queues: await this.q.depths(),
      time: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }));
  }

  async submit(req, res) {
    if (!this.limiter.allow(clientIP(req, this.trustProxy))) {
      return apiError(res, 429, 'rate_limited', RATE_LIMITED);
    }
    // Up to 1 MB of inline source plus a 1 MB icon in base64.
    let body;
    try {
      body = await readBody(req, res, BODY_MAX);
    } catch (e) {
      return apiError(res, 400, 'bad_request', 'couldn\'t read the request');
    }
    let r;
    try {
      r = decodeRequest(body);
    } catch (e) {
      if (e instanceof BadJSON) return apiError(res, 400, 'bad_json', 'the request isn\'t valid JSON');
      throw e;
    }
    const a = await this.acceptJob(r);
    if (a.error) return apiError(res, a.status, a.code, a.error);
    writeJSON(res, 202, await this.jobView(a.job));
  }

  // A decoded request, checked and queued: {job}, or {status, code, error}.
  // Both ways in (JSON and the plain form) end here, so they meet the same
  // checks, in the same order, with the same answers.
  async acceptJob(r) {
    let cls, png = null;
    try {
      cls = validate(r, this.b.env());
      if (r.icon && r.icon.data) {
        png = iconBytes(r.icon);
        await decodeIconPng(png);   // Go decodes every upload before it is queued
      }
    } catch (e) {
      return { status: 400, code: 'invalid', error: e.message };
    }
    if (this.takenDown(Server.sourceKey(r.source.kind, r.source.value))) {
      return { status: 451, code: 'taken_down', error: 'This source has been taken down.' };
    }
    // The icon is stored now and the job carries only its hash.
    try {
      await this.b.storeIcon(r, png);
    } catch (e) {
      return { status: 500, code: 'store_failed', error: 'couldn\'t store the icon' };
    }
    try {
      return { job: await this.q.submit(cls, r) };
    } catch (e) {
      return { status: 503, code: 'queue_unavailable', error: 'The build queue is unavailable; try again shortly.' };
    }
  }

  /* ---------- plain HTML: the form post, the status page, /classic ---------- */

  // POST /submit: new.html's form (or /classic's) as the browser sends it,
  // urlencoded or multipart (for the icon). src/shared/form-job.js turns the fields
  // into the request src/web_client/new.js would post, which then goes through the JSON
  // path's own decoder and acceptJob. The same rate limit, shared with
  // POST /api/jobs. Answers 303 to the status page, or a page saying why not.
  async submitForm(req, res) {
    const refuse = (status, messages) => {
      res.writeHead(status, PAGE_HEADERS);
      res.end(refusedPage(messages));
    };
    if (!this.limiter.allow(clientIP(req, this.trustProxy))) return refuse(429, [RATE_LIMITED]);
    let body;
    try {
      body = await readBody(req, res, BODY_MAX + 1);
    } catch (e) {
      return refuse(400, ['Couldn\'t read the form.']);
    }
    if (body.length > BODY_MAX) return refuse(413, ['The form is over ' + (BODY_MAX >> 20) + ' MB. The icon can be at most 1 MB.']);
    let form;
    try {
      form = parseForm(req.headers['content-type'], body, { keepFiles: ['icon'] });
    } catch (e) {
      if (!(e instanceof BadForm)) throw e;
      return refuse(e.unsupported ? 415 : 400, ['This isn\'t a form post the server can read (' + e.message + ').']);
    }
    const f = postedForm(form.fields);
    if (f.val('source_kind') === 'local') {
      return refuse(400, ['Files from your computer are packed by the builder page in a current browser; a plain form can\'t send them. ' +
        'Give a GitHub repo, a package name or the address of an archive instead.']);
    }
    const problems = [];
    const icon = { choice: f.val('icon_choice') || 'default' };
    const up = form.files.icon;
    if (up && up.data.length) {
      if (up.data.length > ICON_MAX) problems.push('The icon is over 1 MB. Use a smaller PNG (a 512×512 or 1024×1024 PNG is plenty).');
      else Object.assign(icon, { data: up.data.toString('base64'), filename: up.filename, type: up.type || 'image/png' });
    }
    const { job, problems: all } = jobFromForm(f, { icon, problems });
    if (all.length) return refuse(400, all);
    // Exactly as a JSON post of it would be read.
    const r = decodeRequest(Buffer.from(JSON.stringify(job)));
    const a = await this.acceptJob(r);
    if (a.error) return refuse(a.status, [a.error]);
    const loc = 'status/' + encodeURIComponent(a.job.id);
    res.writeHead(303, { ...PAGE_HEADERS, Location: loc });
    res.end(page303(loc));
  }

  // GET /status/<id>: the job as a page, reloading itself every 3 s until
  // it is done or failed; then the links to the files and the record.
  async status(req, res, id) {
    let j = null;
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
      try { j = await this.q.get(id); } catch (e) { /* as missing */ }
    }
    if (!j) {
      res.writeHead(404, PAGE_HEADERS);
      return res.end(missingJobPage());
    }
    const v = await this.jobView(j);
    if (v.status === 'queued' || v.status === 'running') res.tiQuiet = true;
    res.writeHead(200, PAGE_HEADERS);
    res.end(statusPage(v, j.request || null));
  }

  // GET /classic: a lean form for browsers that can't run the page.
  async classic(req, res) {
    let list = [];
    try { list = JSON.parse(this.runtimesJSON()).runtimes || []; } catch (e) { list = []; }
    res.writeHead(200, PAGE_HEADERS);
    res.end(classicPage(list));
  }

  async jobView(j) {
    const pos = await this.q.position(j);
    const v = { id: j.id, ticket: j.ticket, class: j.class, status: j.status, position: pos,
      eta_seconds: await this.q.eta(j, pos), progress: j.progress, error: j.error ?? null };
    if (j.result) v.result = j.result;
    return sorted(v);
  }

  async job(req, res, id) {
    let j = null;
    try { j = await this.q.get(id); } catch (e) { /* as missing */ }
    if (!j) return apiError(res, 404, 'not_found', 'No such job (jobs are kept for a week).');
    writeJSON(res, 200, await this.jobView(j));
  }

  async record(req, res, h) {
    if (!isHash26(h)) return apiError(res, 400, 'bad_hash', 'not a record hash');
    if (this.takenDown('record ' + h)) return apiError(res, 451, 'taken_down', 'This installer has been taken down.');
    let b;
    try { b = fs.readFileSync(this.b.recordPath(h)); } catch (e) { return apiError(res, 404, 'not_found', 'no such record'); }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Length': b.length });
    res.end(b);
  }

  async plan(req, res, h, params) {
    if (!isHash26(h)) return apiError(res, 400, 'bad_hash', 'not a record hash');
    if (this.takenDown('record ' + h)) return apiError(res, 451, 'taken_down', 'This installer has been taken down.');
    const p = params.get('os');
    const nonce = params.get('nonce') ?? '';
    if (nonce !== '' && !isNonce(nonce)) return apiError(res, 400, 'invalid', 'nonce must be 32 hexadecimal characters');
    let plan;
    try {
      ({ plan } = await this.b.signedPlan(h, p ? [p] : null, nonce));
    } catch (e) {
      if (e.code === 'ENOENT') return apiError(res, 404, 'not_found', 'no such record');
      return apiError(res, 500, 'resolve_failed', e.message);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(plan);
  }

  // GET /api/plan/name/{runtime}/{project} (api.md "Plans by name"): the plan
  // for the synthetic record "install <project> from the <runtime> registry
  // with default settings". The record is stored, so the plan's `record`
  // line names something /api/records serves and the takedown list can name.
  async planByName(req, res, rt, name, params) {
    if (!this.nameLimiter.allow(clientIP(req, this.trustProxy))) {
      return apiError(res, 429, 'rate_limited', 'Too many plans by name from your address; try again in a minute.');
    }
    if (Buffer.byteLength(rt) > 20 || Buffer.byteLength(name) > 100) return apiError(res, 400, 'invalid', 'name too long');
    const nonce = params.get('nonce') ?? '';
    if (nonce !== '' && !isNonce(nonce)) return apiError(res, 400, 'invalid', 'nonce must be 32 hexadecimal characters');
    try { packagePolicyFor(this.cat, rt); } catch (e) { return apiError(res, 404, 'no_registry', e.message); }
    if (name.startsWith('@')) {
      return apiError(res, 400, 'invalid', `scoped package names (${name}) can't be used in a plain file name; make an installer for it with the form instead`);
    }
    let norm;
    try { norm = validPackage(this.cat, rt, name, ''); } catch (e) { return apiError(res, 400, 'invalid', e.message); }
    if (this.takenDown('source package ' + norm.toLowerCase())) return apiError(res, 451, 'taken_down', 'This package has been taken down.');
    // Ask the registry first (the answer is cached for the plan), so names
    // that don't exist never leave a record behind.
    try {
      await this.b.lookupPackage(rt, norm, '');
    } catch (e) {
      if (e.noPackage) return apiError(res, 404, 'no_such_package', e.message);
      return apiError(res, 502, 'registry_failed', e.message);
    }
    let hash;
    try { hash = await this.b.nameRecord(rt, norm); } catch (e) { return apiError(res, 500, 'record_failed', e.message); }
    if (this.takenDown('record ' + hash)) return apiError(res, 451, 'taken_down', 'This installer has been taken down.');
    const p = params.get('os');
    let plan;
    try {
      ({ plan } = await this.b.signedNamePlan(hash, p ? [p] : null, rt, name, nonce));
    } catch (e) {
      if (e.noPackage) return apiError(res, 404, 'no_such_package', e.message);
      return apiError(res, 502, 'resolve_failed', e.message);
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-TI-Record': hash });
    res.end(plan);
  }

  // pubkey publishes the plan signing key (docs/api.md). Bases carry their
  // own copy, baked in at build time; this is for people checking a plan.
  async pubkey(req, res) {
    writeJSON(res, 200, sorted({ alg: 'ed25519', key: this.signer.publicBase64(), id: keyID(this.signer.pub), pem: this.signer.publicPEM() }));
  }

  async runtimes(req, res) {
    const body = this.runtimesJSON();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
    res.end(body);
  }

  // GET /api/catalog/archive and /api/catalog/attest: the catalogue as one
  // file, and the signed statement of its SHA-256. Together they are what a
  // saved copy of the page needs to replace the catalogue built into it with
  // the current one and still be able to prove where it came from -- the
  // attestation is signed with the plan key, so the page checks it against
  // the key it was built with and never has to trust the connection.
  //
  // The archive is the same catalog.gz tools/snapshot.mjs writes and
  // tools/sign_runtime_scripts.mjs signed; deploy.sh puts it in the data
  // folder. Missing means this server was not deployed with one, which is a
  // 404 rather than an error: refreshing is an extra, not the service.
  async catalogArchive(req, res) {
    return serveFile(req, res, path.join(this.data, 'catalog.gz'), {
      'Content-Type': 'application/gzip',
      'Cache-Control': 'public, max-age=300',
    });
  }

  async catalogAttest(req, res) {
    return serveFile(req, res, path.join(this.data, 'rtscripts', 'catalog.txt'), {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    });
  }

  async takedown(req, res) {
    writeJSON(res, 200, { entries: this.takedownList() });
  }

  // GET /api/revocations (design.md 7.1): the takedown list, time-stamped
  // and signed with the plan key, for an installer that carries its own
  // plan and can reach us. It is the same file /api/takedown serves, so
  // there is nothing extra to maintain; `serial` is takedown.txt's
  // modification time, which changes when the list does.
  async revocations(req, res) {
    let serial = 0;
    try { serial = Math.floor(fs.statSync(this.takedownPath()).mtimeMs / 1000); } catch (e) { /* no list yet */ }
    const doc = revocationsText(this.takedownList(), { now: Date.now(), serial });
    const body = this.signer.signStringAs(REVOCATIONS_KIND, doc);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  // GET /api/releases: the release ledger, chained and signed with the
  // plan key (src/shared/ledger.js). What it is for: a copy of the page
  // can check another copy against a record outside both of them, and --
  // because every copy carries the root as of the day it was built --
  // can tell whether this log has been rewritten behind it.
  async releases(req, res) {
    let text = '';
    try { text = fs.readFileSync(this.releasesPath(), 'utf8'); } catch (e) { /* none yet */ }
    const doc = releasesText(parseReleaseFile(text), sha256hex, { now: Date.now() });
    const body = this.signer.signStringAs(RELEASES_KIND, doc);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  // relay fetches catalogue files for pages on hosts without CORS
  // (packed-files.md 4.2). Only URLs the catalogue lists are allowed.
  async relay(req, res, params) {
    if (!this.relayLimiter.allow(clientIP(req, this.trustProxy))) {
      return apiError(res, 429, 'rate_limited', 'Too many relay requests; try again in a minute.');
    }
    const u = params.get('url') ?? '';
    if (!this.relayOK.has(u)) {
      return apiError(res, 403, 'not_in_catalogue', 'The relay only fetches files listed in the runtime catalogue.');
    }
    let up;
    try {
      up = await safeFetch(u);
    } catch (e) {
      return apiError(res, 502, 'upstream', e.message);
    }
    if (up.status !== 200) {
      up.discard();
      return apiError(res, 502, 'upstream', up.statusLine);
    }
    const h = { 'Content-Type': 'application/octet-stream' };
    if (up.headers['content-length']) h['Content-Length'] = up.headers['content-length'];
    res.writeHead(200, h);
    req.on('close', () => up.body.destroy());
    for await (const c of up.body) {
      if (!res.write(c)) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  }

  // tsa relays an RFC 3161 TimeStampReq for browser signing
  // (docs/browser-signing.md 2.4). The request holds only a hash of a
  // signature. Nothing is stored or logged beyond the usual request line.
  async tsa(req, res, params) {
    if (!this.relayLimiter.allow(clientIP(req, this.trustProxy))) {
      return apiError(res, 429, 'rate_limited', 'Too many relay requests; try again in a minute.');
    }
    const name = params.get('name') ?? '';
    const u = Object.hasOwn(TSA_URLS, name) ? TSA_URLS[name] : null;
    if (!u) return apiError(res, 403, 'not_allowed', 'Unknown timestamp server; the relay only forwards to a fixed list.');
    let body;
    try { body = await readBody(req, res, 4097); } catch (e) { body = null; }
    if (!body || body.length < 2 || body.length > 4096 || body[0] !== 0x30) {
      return apiError(res, 400, 'bad_request', 'The body must be one DER TimeStampReq of at most 4 KB.');
    }
    let up;
    try {
      up = await safeFetch(u, { method: 'POST', body, timeout: 30000, headers: { 'Content-Type': 'application/timestamp-query' } });
    } catch (e) {
      return apiError(res, 502, 'upstream', 'The timestamp server did not answer.');
    }
    let out = null;
    try { out = await up.upTo(256 << 10); } catch (e) { out = null; }
    if (up.status !== 200 || !out || !out.length) {
      return apiError(res, 502, 'upstream', 'The timestamp server answered ' + up.statusLine + '.');
    }
    res.writeHead(200, { 'Content-Type': 'application/timestamp-reply', 'Cache-Control': 'no-store', 'Content-Length': out.length });
    res.end(out);
  }

  // sign relays one call to a cloud signing service whose API a browser
  // can't reach (lib/signrelay.js, docs/browser-signing.md 3). The rules
  // that matter -- the per-provider URL allow-list, and that the credential
  // is forwarded and forgotten -- are all in that file.
  async sign(req, res, provider) {
    if (!this.relayLimiter.allow(clientIP(req, this.trustProxy))) {
      return apiError(res, 429, 'rate_limited', 'Too many relay requests; try again in a minute.');
    }
    return signRelay(req, res, provider, { readBody, apiError, writeJSON });
  }

  async dl(req, res, hash, name) {
    if (!isHash26(hash) || /[/\\]/.test(name) || name.startsWith('.')) return notFound(res);
    if (this.takenDown('record ' + hash)) return apiError(res, 451, 'taken_down', 'This installer has been taken down.');
    const p = path.join(this.data, 'dl', hash, name);
    return serveFile(req, res, p, { 'Content-Disposition': 'attachment; filename=' + goQuote(name), 'Content-Type': 'application/octet-stream' });
  }

  // icon serves an uploaded icon by its SHA-256 (records name it in `icon`).
  async icon(req, res, file) {
    const sha = file.endsWith('.png') ? file.slice(0, -4) : null;
    if (sha === null || !isSHA256(sha)) return notFound(res);
    if (this.takenDownSha(sha)) return apiError(res, 451, 'taken_down', 'This icon has been taken down.');
    return serveFile(req, res, this.b.iconPath(sha), { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  }

  async base(req, res, os_) {
    const files = { windows: ['windows/out/base.exe', 'base.exe'], linux: ['unix/out/ti-base.run', 'ti-base.run'], macos: ['unix/out/ti-base-macos.zip', 'ti-base-macos.zip'] };
    const f = Object.hasOwn(files, os_) ? files[os_] : null;
    if (!f) return notFound(res);
    return serveFile(req, res, path.join(this.bases, f[0]), { 'Content-Disposition': 'attachment; filename=' + goQuote(f[1]), 'Content-Type': 'application/octet-stream' });
  }

  // Stored sources: refused when their hash is on the takedown list.
  async src(req, res, rel) {
    const sha = rel.endsWith('.tar.gz') ? rel.slice(0, -7) : rel;
    if (this.takenDownSha(sha)) return httpError(res, 'taken down', 451);
    return serveDir(req, res, path.join(this.data, 'src'), rel);
  }

  // The site's pages and assets, not the rest of the folder. The folder
  // names are the ones tools/build_site.py writes: index.html at the top,
  // and with --multi the repository's own src/web_client/, src/shared/ and src/vendor/.
  async siteFile(req, res, p) {
    // /tiddlyinstall.html is the page itself, under the name it saves
    // as (SAVE_AS in src/web_client/api.js). A link people can read --
    // and the name of the file they end up with, so the two agree. In
    // the one-file build there is no such file on disk; in --multi the
    // pages are separate and index.html is still the one this means.
    if (p === '/tiddlyinstall.html') p = '/';
    const ok = p === '/' || p.startsWith('/web/') || p.startsWith('/shared/') || p.startsWith('/img/') || p.startsWith('/vendor/') ||
      (p.split('/').length === 2 && (p.endsWith('.html') || p.endsWith('.ico')));
    if (!ok) return notFound(res);
    return serveDir(req, res, this.site, p, { index: true });
  }
}

/* ---------- main ---------- */

async function main() {
  let o;
  try {
    o = parseFlags(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(e.message + '\n');
    process.exit(e.help ? 0 : 2);
  }
  const s = new Server(o);
  try {
    await s.init();
  } catch (e) {
    logf(e.message);
    process.exit(1);
  }
  s.serveWorkers();
  // Warm the runtimes summary (hashes our copies the first time).
  setImmediate(() => { try { s.runtimesJSON(); } catch (e) { logf('runtimes summary: ' + e.message); } });
  const srv = http.createServer({ headersTimeout: 10000, requestTimeout: 0 }, s.handler());
  const i = o.addr.lastIndexOf(':');
  const host = o.addr.slice(0, i), port = Number(o.addr.slice(i + 1));
  srv.on('error', (e) => { logf(e.message); process.exit(1); });
  srv.listen(port, host === '' ? undefined : host.replace(/^\[|\]$/g, ''), () => {
    logf(`installer-builder ${VERSION} (node) listening on ${o.addr} (public ${o.public})`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const t = setTimeout(() => process.exit(0), 5000);
    t.unref();
    srv.close();
    await s.q.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
