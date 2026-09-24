// An HTTP client that only talks to public internet addresses (the Go
// server's netsafe package), so a user-supplied URL (a source tarball, a
// redirect from one, a registry answer) can't reach this machine or the LAN
// (SSRF). Every connection is checked: an IP literal before it is dialled,
// a host name through a DNS lookup that drops private answers, and the
// socket's peer once it connects. Redirects are followed here, each hop
// checked the same way.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';

export class BlockedError extends Error {
  constructor(what) {
    super('address not allowed' + (what ? ': ' + what : ''));
    this.code = 'EBLOCKED';
  }
}

function v4Bytes(s) {
  return s.split('.').map(Number);
}

// IPv6 text to 16 bytes (net.isIP has already accepted it).
function v6Bytes(s) {
  s = s.replace(/%.*$/, '');
  const m = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    s = s.slice(0, m.index) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  let words;
  if (s.includes('::')) {
    const [l, r] = s.split('::');
    const left = l ? l.split(':') : [];
    const right = r ? r.split(':') : [];
    words = [...left, ...new Array(8 - left.length - right.length).fill('0'), ...right];
  } else {
    words = s.split(':');
  }
  return words.flatMap((w) => { const n = parseInt(w, 16); return [(n >> 8) & 255, n & 255]; });
}

// Go's netip: a.Unmap().IsGlobalUnicast() && !IsPrivate() && !IsLoopback()
// && !IsLinkLocalUnicast() && not CGNAT && !IsUnspecified() && !IsMulticast().
// Stricter than Go in one place: 0.0.0.0/8 ("this network") is refused too.
// Credentials belong to the origin they were meant for.
//
// signrelay.js puts a publisher's bearer token in these headers and says
// it is "never sent anywhere but the one upstream URL the allow-list
// permits". The allow-list judges the first URL; these headers used to
// follow up to ten redirects wherever they led, so any upstream able to
// answer with a Location could collect the token. Dropping them when the
// origin changes is what every browser does, and it is what makes that
// sentence true.
//
// Exported because a control that cannot be called on its own tends not
// to be tested: safeFetch refuses private addresses, so a live two-hop
// test of this cannot be written against loopback.
export const CREDENTIAL_HEADERS = ['authorization', 'x-ti-sign-auth', 'cookie', 'proxy-authorization'];

export const originOf = (u) => { try { return new URL(u).origin; } catch (e) { return ''; } };

export function acrossRedirect(headers, fromOrigin, toUrl) {
  if (originOf(toUrl) === fromOrigin) return headers;
  const out = {};
  for (const k of Object.keys(headers)) {
    if (CREDENTIAL_HEADERS.indexOf(k.toLowerCase()) < 0) out[k] = headers[k];
  }
  return out;
}

export function isPublic(addr) {
  addr = String(addr || '');
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  let kind = net.isIP(addr);
  let b;
  if (kind === 6) {
    b = v6Bytes(addr);
    const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255;
    if (mapped) { b = b.slice(12); kind = 4; }
  } else if (kind === 4) {
    b = v4Bytes(addr);
  } else {
    return false;
  }
  if (kind === 4) {
    const [x, y] = b;
    if (x === 0) return false;                               // unspecified, "this network"
    if (x === 127) return false;                             // loopback
    if (x >= 224 && x <= 239) return false;                  // multicast
    if (x === 255 && y === 255 && b[2] === 255 && b[3] === 255) return false; // broadcast
    if (x === 169 && y === 254) return false;                // link-local
    if (x === 10 || (x === 172 && (y & 0xf0) === 16) || (x === 192 && y === 168)) return false; // private
    if (x === 100 && (y & 0xc0) === 64) return false;        // CGNAT 100.64.0.0/10
    return true;
  }
  if (b.every((x) => x === 0)) return false;                 // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return false; // ::1
  if (b[0] === 0xff) return false;                           // multicast
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if ((b[0] & 0xfe) === 0xfc) return false;                  // fc00::/7 private
  return true;
}

// A DNS lookup that only answers public addresses.
function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const opts = typeof options === 'number' ? { family: options } : (options || {});
  dns.lookup(hostname, { all: true, family: opts.family || 0, hints: opts.hints, verbatim: true }, (err, addrs) => {
    if (err) return callback(err);
    const ok = addrs.filter((a) => isPublic(a.address));
    if (!ok.length) return callback(new BlockedError(hostname));
    if (opts.all) return callback(null, ok);
    return callback(null, ok[0].address, ok[0].family);
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// A response: status, statusText, `status` line as Go prints it, headers,
// and the body stream with helpers. The timeout (Go's Client.Timeout)
// covers the body too.
class SafeResponse {
  constructor(res, url, done) {
    this.status = res.statusCode;
    this.statusText = res.statusMessage || '';
    this.statusLine = res.statusCode + ' ' + (res.statusMessage || '');
    this.headers = res.headers;
    this.body = res;
    this.url = url;
    this.ok = res.statusCode >= 200 && res.statusCode < 300;
    res.on('end', done);
    res.on('close', done);
  }

  // The body, at most `limit` bytes; more is an error (err.tooLarge).
  async bytes(limit = Infinity) {
    const chunks = [];
    let n = 0;
    for await (const c of this.body) {
      n += c.length;
      if (n > limit) {
        this.body.destroy();
        const e = new Error('download too large');
        e.tooLarge = true;
        throw e;
      }
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  // Up to `limit` bytes, silently truncated (Go's io.LimitReader).
  async upTo(limit) {
    const chunks = [];
    let n = 0;
    for await (const c of this.body) {
      const take = Math.min(c.length, limit - n);
      if (take > 0) chunks.push(c.subarray(0, take));
      n += take;
      if (n >= limit) { this.body.destroy(); break; }
    }
    return Buffer.concat(chunks);
  }

  discard() { this.body.resume(); }
}

// safeFetch(url, {method, headers, body, timeout}) -> SafeResponse. Throws
// BlockedError (err.code 'EBLOCKED') for non-public addresses.
export async function safeFetch(url, opts = {}) {
  const timeout = opts.timeout ?? 10 * 60 * 1000;
  const ac = new AbortController();
  let timer = null;
  const done = () => { if (timer) { clearTimeout(timer); timer = null; } };
  if (timeout > 0 && Number.isFinite(timeout)) {
    timer = setTimeout(() => ac.abort(new Error('timeout awaiting response (Client.Timeout exceeded)')), timeout);
    timer.unref?.();
  }
  let method = (opts.method || 'GET').toUpperCase();
  let body = opts.body ?? null;
  let current = String(url);
  // Credentials belong to the origin they were meant for. The signing
  // relay puts a publisher's bearer token in these headers and its own
  // comment says it is "never sent anywhere but the one upstream URL the
  // allow-list permits" -- but the allow-list judges the first URL, and
  // these headers used to follow up to ten redirects wherever they led.
  // Dropping them when the origin changes is what every browser does,
  // and it is what makes that sentence true.
  let headers = Object.assign({}, opts.headers || {});
  let origin = originOf(current);
  try {
    for (let hop = 0; ; hop++) {
      const res = await request(current, method, headers, body, ac.signal);
      if (REDIRECTS.has(res.statusCode) && res.headers.location) {
        res.resume();
        if (hop >= 9) throw new Error('stopped after 10 redirects');
        current = new URL(res.headers.location, current).toString();
        headers = acrossRedirect(headers, origin, current);
        origin = originOf(current);
        if (res.statusCode !== 307 && res.statusCode !== 308 && method !== 'GET' && method !== 'HEAD') {
          method = 'GET';
          body = null;
        }
        continue;
      }
      return new SafeResponse(res, current, done);
    }
  } catch (e) {
    done();
    throw e;
  }
}

function request(url, method, headers, body, signal) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad URL: ' + url)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('unsupported protocol scheme "' + u.protocol.replace(/:$/, '') + '"'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublic(host)) return reject(new BlockedError(host));
    const mod = u.protocol === 'https:' ? https : http;
    const h = Object.assign({ 'User-Agent': 'installer-builder/0.1' }, headers);
    if (body != null) h['Content-Length'] = String(body.length);
    const req = mod.request(u, { method, headers: h, lookup: safeLookup, agent: false, signal }, resolve);
    let connected = false;
    const connectTimer = setTimeout(() => { if (!connected) req.destroy(new Error('dial timeout')); }, 30000);
    connectTimer.unref?.();
    req.on('socket', (s) => {
      const check = () => {
        connected = true;
        clearTimeout(connectTimer);
        // Belt and braces: the peer we actually reached.
        if (!isPublic(s.remoteAddress)) req.destroy(new BlockedError(s.remoteAddress));
      };
      if (s.connecting === false && s.remoteAddress) check();
      else s.once('connect', check);
    });
    req.on('error', (e) => { clearTimeout(connectTimer); reject(e); });
    req.on('response', () => clearTimeout(connectTimer));
    if (body != null) req.end(body); else req.end();
  });
}
