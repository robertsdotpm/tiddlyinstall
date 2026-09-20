// Cloud signing services for the editor's Sign panel
// (docs/browser-signing.md section 3; design.md 11.1 item 21).
//
// Since June 2023 a code-signing key must live on a hardware token or in a
// cloud service, so signing means sending a SHA-256 digest to a provider's
// API and getting a signature back. Each provider below is one small
// descriptor: what credentials it needs, how the request is built, how the
// signature and the certificate chain are read out of the answer, and what
// its errors mean in plain words.
//
// web/lib/authenticode.js does everything else. `beginPE` gives the digest,
// `digestSigner(certs, signDigest)` wraps any of these, and `finishPE`
// verifies the signature against the certificate before writing the file,
// so a wrong -- or hostile -- answer cannot produce a broken installer.
//
// NONE OF THESE HAS BEEN RUN AGAINST A LIVE ACCOUNT. Every one is written
// from the provider's published documentation; not one of these services
// can be opened without paying and passing an identity check. The plumbing,
// the error paths and the credential handling are checked against mock
// servers that speak the documented request and response
// (tests/mock-sign-services.mjs, driven from tests/sign-test.mjs). So the
// panel says "not yet tested against a live account" on every provider and
// gives people an address to write to when one breaks.
//
// Two things the panel must say before anyone types a credential:
//
//   where: 'browser'  the page calls the API itself. The credential never
//                     leaves the browser. Only possible where the API sends
//                     CORS headers -- each one below was checked by
//                     preflight, and the result is in `evidence`.
//   where: 'server'   the API sends no CORS headers, so the call goes
//                     through the build server's relay
//                     (server/lib/signrelay.js). The credential passes
//                     through our server, which never logs or stores it.
//                     Relayed providers do not exist in the offline
//                     one-file page: `where === 'server'` is hidden there,
//                     exactly as the timestamp relay is.
//   where: 'paste'    the API cannot be reached from a page at all (mutual
//                     TLS). The page shows the command to run and takes the
//                     answer back.
import { b64, unb64, hex } from './lib/der.js';
import * as X from './lib/cryptox.js';

// Where someone writes when their provider stops working. Every provider is
// written from documentation, so this is the only way we hear that an API
// changed. Either a mailto: or an https: URL; contactLink() renders both.
export const CONTACT = 'mailto:matthew@roberts.pm';

// {href, text} for the panel, or null if CONTACT is ever left unset.
export function contactLink() {
  const c = String(CONTACT);
  if (!/^(mailto:|https:\/\/)/.test(c)) return null;
  return { href: c, text: c.indexOf('mailto:') === 0 ? c.slice(7) : c.replace(/^https:\/\//, '') };
}

// The one sentence a provider carries unless it has been checked against
// something real. A provider that has may set `verified` instead -- but the
// two claims are different and must not be blurred: "checked against a
// vendor sandbox" is not "checked against a live paid account".
export const UNTESTED = 'Not yet tested against a live account: this is written from ' +
  'the provider\'s documentation and checked against a mock of it.';

export class ServiceError extends Error {}

const TE = new TextEncoder();
const utf8 = (s) => TE.encode(String(s));
const b64url = (u8) => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- encodings the panel offers ---------- */

export const DIGEST_ENCODINGS = [
  ['base64', 'Base64'],
  ['base64url', 'Base64 (URL-safe, no padding)'],
  ['hex', 'Hex, lower case'],
  ['HEX', 'Hex, UPPER CASE'],
  ['raw', 'The raw 32 bytes (request body only)'],
];

export function encodeDigest(digest, how) {
  if (how === 'base64url') return b64url(digest);
  if (how === 'hex') return hex(digest);
  if (how === 'HEX') return hex(digest).toUpperCase();
  return b64(digest);
}

// Signature bytes out of whatever the service sent back.
export function decodeSignature(value, how) {
  if (value instanceof Uint8Array) return value;
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new ServiceError('The service sent an empty signature.');
  if (how === 'hex' || how === 'HEX') {
    const t = s.replace(/[\s:]+/g, '');
    if (!/^[0-9a-fA-F]+$/.test(t) || t.length % 2) throw new ServiceError('The signature is not hex: ' + s.slice(0, 40));
    const out = new Uint8Array(t.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(t.substr(2 * i, 2), 16);
    return out;
  }
  let t = s.replace(/\s+/g, '');
  if (how === 'base64url') t = t.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return unb64(t);
  } catch (e) {
    throw new ServiceError('The signature is not base64: ' + s.slice(0, 40));
  }
}

// "a.b.0.c" into a parsed JSON answer. Empty path means the whole value.
export function readPath(obj, path) {
  const p = String(path == null ? '' : path).trim();
  if (!p) return obj;
  let cur = obj;
  const parts = p.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || typeof cur !== 'object') {
      throw new ServiceError('The answer has nothing at "' + parts.slice(0, i + 1).join('.') + '".');
    }
    cur = cur[parts[i]];
  }
  if (cur === undefined) throw new ServiceError('The answer has nothing at "' + p + '".');
  return cur;
}

/* ---------- TOTP (SSL.com eSigner) ---------- */

// eSigner's authorize call takes a six-digit code. The portal gives people a
// TOTP secret, and a code typed by hand can expire between authorize and
// signHash, so a secret is accepted too and the code is computed here.
//
// The encoding is not what you would guess. Authenticator apps hand out
// **base32**; SSL.com hands out **base64** -- 44 characters decoding to 32
// bytes, with `+`, `/` and digits that base32 has no room for, so base32
// cannot even hold it. Assuming base32 was a real bug, found by running
// against SSL.com's sandbox on 2026-09-20 (browser-signing.md 3.3).
//
// Most secrets say which they are by their alphabet, and totpKeys() puts
// the likelier one first; where a string could be either, the caller tries
// both rather than making the user care.
export function base32Decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const t = String(s).toUpperCase().replace(/[\s=-]+/g, '');
  const out = [];
  let bits = 0, acc = 0;
  for (let i = 0; i < t.length; i++) {
    const v = A.indexOf(t.charAt(i));
    if (v < 0) throw new ServiceError('That does not look like a TOTP secret (base32 letters A-Z and digits 2-7).');
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 255); }
  }
  return new Uint8Array(out);
}

// The key bytes a TOTP secret might mean, likeliest first. One entry when
// the alphabet settles it, two when the string is valid as both.
export function totpKeys(secret) {
  const t = String(secret || '').replace(/[\s-]+/g, '');
  if (!t) throw new ServiceError('eSigner needs your one-time code or your TOTP secret.');
  const isB32 = /^[A-Za-z2-7]+=*$/.test(t);
  const isB64 = /^[A-Za-z0-9+/]+=*$/.test(t) && (t.replace(/=+$/, '').length % 4) !== 1;
  const keys = [];
  // A base64 secret is 44 characters for the 32 bytes SSL.com uses, and
  // usually carries + / or a digit base32 has no room for.
  if (isB64 && (!isB32 || t.length % 8 !== 0)) { try { keys.push(unb64(t)); } catch (e) { /* not base64 after all */ } }
  if (isB32) { try { keys.push(base32Decode(t)); } catch (e) { /* not base32 after all */ } }
  if (isB64 && !keys.length) { try { keys.push(unb64(t)); } catch (e) { /* nor base64 */ } }
  if (!keys.length) {
    throw new ServiceError('That is neither a one-time code nor a TOTP secret the page can read ' +
      '(base32, as authenticator apps show it, or base64, as SSL.com gives it).');
  }
  return keys;
}

// RFC 6238, SHA-1, 30-second step, six digits. Checked against the RFC's
// own test vectors in tests/sign-test.mjs.
export async function totp(secret, atMs, digits = 6, step = 30) {
  const key = secret instanceof Uint8Array ? secret : totpKeys(secret)[0];
  let counter = Math.floor((atMs === undefined ? Date.now() : atMs) / 1000 / step);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) { msg[i] = counter & 255; counter = Math.floor(counter / 256); }
  const mac = await X.hmac('SHA-1', key, msg);
  const o = mac[mac.length - 1] & 0x0f;
  const v = (((mac[o] & 0x7f) * 16777216) + (mac[o + 1] * 65536) + (mac[o + 2] * 256) + mac[o + 3]) % Math.pow(10, digits);
  let s = String(v);
  while (s.length < digits) s = '0' + s;
  return s;
}

// The codes to try: the one typed, or one per possible reading of a secret.
async function otpCandidates(value) {
  const v = String(value || '').replace(/\s+/g, '');
  if (!v) throw new ServiceError('eSigner needs your one-time code or your TOTP secret.');
  if (/^\d{6,8}$/.test(v)) return [v];
  const keys = totpKeys(v);
  const out = [];
  for (let i = 0; i < keys.length; i++) out.push(await totp(keys[i]));
  return out;
}

/* ---------- AWS Signature Version 4 ---------- */
//
// AWS KMS is directly callable from a page (the CORS evidence is on the
// descriptor), but every request must be signed with SigV4, and there is no
// way to ask AWS to do it for us. It is about eighty lines, all of it
// hashing and string building on primitives the page already has, and it is
// the only part of any provider here that can be checked exactly without an
// account: tests/sign-test.mjs runs Amazon's own published SigV4 test-suite
// vectors (tests/sigv4-vectors.json) through it. That is why AWS is
// built rather than left to the generic option.

function uriEncode(s, keepSlash) {
  const bytes = utf8(s);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const ch = String.fromCharCode(c);
    if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || (c >= 0x30 && c <= 0x39) ||
        ch === '-' || ch === '.' || ch === '_' || ch === '~' || (keepSlash && ch === '/')) out += ch;
    else out += '%' + (c < 16 ? '0' : '') + c.toString(16).toUpperCase();
  }
  return out;
}

function canonicalQuery(query) {
  const q = String(query || '');
  if (!q) return '';
  const pairs = [];
  const parts = q.split('&');
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i]) continue;
    const eq = parts[i].indexOf('=');
    const k = eq < 0 ? parts[i] : parts[i].slice(0, eq);
    const v = eq < 0 ? '' : parts[i].slice(eq + 1);
    pairs.push([uriEncode(k, false), uriEncode(v, false)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map((p) => p[0] + '=' + p[1]).join('&');
}

// Trim, and collapse runs of whitespace -- including inside quotes, which is
// what Amazon's get-header-value-trim vector expects.
const trimValue = (v) => String(v).trim().replace(/\s+/g, ' ');

// headers: [[name, value], ...]. Duplicate names join with a comma, in the
// order they were given.
function canonicalHeaders(headers) {
  const byName = new Map();
  const order = [];
  for (let i = 0; i < headers.length; i++) {
    const n = String(headers[i][0]).toLowerCase();
    if (!byName.has(n)) { byName.set(n, []); order.push(n); }
    byName.get(n).push(trimValue(headers[i][1]));
  }
  const names = order.slice().sort();
  let canon = '';
  for (let i = 0; i < names.length; i++) canon += names[i] + ':' + byName.get(names[i]).join(',') + '\n';
  return { canon, signed: names.join(';') };
}

const sha256hex = async (bytes) => hex(await X.digest('SHA-256', bytes));

// The pieces, so the test can compare each one with Amazon's vectors.
export async function sigv4Parts(r) {
  const { canon, signed } = canonicalHeaders(r.headers);
  const payload = r.payloadHash || await sha256hex(r.body === undefined || r.body === null ? new Uint8Array(0)
    : (r.body instanceof Uint8Array ? r.body : utf8(r.body)));
  const creq = [r.method, uriEncode(r.path || '/', true), canonicalQuery(r.query), canon, signed, payload].join('\n');
  const date = r.amzDate.slice(0, 8);
  const scope = date + '/' + r.region + '/' + r.service + '/aws4_request';
  const sts = ['AWS4-HMAC-SHA256', r.amzDate, scope, await sha256hex(utf8(creq))].join('\n');
  return { creq, sts, scope, signed, payload };
}

// The Authorization header value. Built on sigv4Parts so the test can check
// the canonical request and the string to sign on their own.
export async function sigv4Sign(r) {
  const p = await sigv4Parts(r);
  let k = utf8('AWS4' + r.secretAccessKey);
  const chain = [r.amzDate.slice(0, 8), r.region, r.service, 'aws4_request'];
  for (let i = 0; i < chain.length; i++) k = await X.hmac('SHA-256', k, utf8(chain[i]));
  const signature = hex(await X.hmac('SHA-256', k, utf8(p.sts)));
  const authorization = 'AWS4-HMAC-SHA256 Credential=' + r.accessKeyId + '/' + p.scope +
    ', SignedHeaders=' + p.signed + ', Signature=' + signature;
  return { creq: p.creq, sts: p.sts, signature, authorization, payloadHash: p.payload };
}

// 20150830T123600Z
export function amzDate(d) {
  return (d || new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/* ---------- reading errors ---------- */

// The plain-words part of whatever a provider sent with a failure. Never
// trusted for anything but showing: it is the provider's text, not ours.
function providerMessage(body) {
  if (!body) return '';
  let m = '';
  if (typeof body === 'string') m = body;
  else if (body.error && typeof body.error === 'object') m = body.error.message || body.error.code || '';
  else if (typeof body.error === 'string') m = body.error_description || body.error;
  else if (body.message) m = body.message;
  else if (body.Message) m = body.Message;
  else if (body.error_description) m = body.error_description;
  else if (Array.isArray(body.errors) && body.errors.length) m = body.errors[0].message || body.errors[0].code || '';
  else if (body.__type) m = body.__type;
  if (!m) { try { m = JSON.stringify(body); } catch (e) { m = ''; } }
  return String(m).replace(/\s+/g, ' ').slice(0, 300);
}

// The shared half of every explain(): what an HTTP status means when a
// signing service returns it.
function commonExplain(name, status, body) {
  const detail = providerMessage(body);
  const tail = detail ? ' ' + name + ' said: ' + detail : '';
  if (status === 0) return 'Couldn\'t reach ' + name + '. Check the address, and that you are online.' + tail;
  if (status === 400) return name + ' refused the request as malformed. That is usually a field filled in wrongly.' + tail;
  if (status === 401) return name + ' did not accept those credentials.' + tail;
  if (status === 403) return name + ' accepted the credentials but will not let them sign with this key. Check the permissions on the key.' + tail;
  if (status === 404) return name + ' has no key or profile by that name. Check the identifiers.' + tail;
  if (status === 429) return name + ' is rate-limiting you. Wait a moment and try again.' + tail;
  if (status >= 500) return name + ' is having trouble (HTTP ' + status + '). It is their end, not yours; try again shortly.' + tail;
  return name + ' answered HTTP ' + status + '.' + tail;
}

/* ---------- the request context ---------- */
//
// Descriptors never call fetch themselves. They call ctx.send(), which the
// panel builds (web/sign-ui.js) and the tests replace with one that points at
// a mock. Every descriptor therefore builds the real production URL, so the
// URLs a credential can be sent to are all visible in this one file.
//
// ctx.send({url, method, headers, body, relay}) resolves to
// {status, headers, text, json}. It never throws for an HTTP status; a
// network failure comes back as status 0.

export function makeSend(opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || (typeof fetch === 'function' ? fetch : null);
  const rewrite = o.rewrite || ((u) => u);
  return async function send(req) {
    // `rewrite` is a test hook, and it applies to the address this code
    // dials. A relayed call dials the build server, not the provider, so the
    // provider's URL goes through untouched -- the relay judges the real one.
    const url = req.relay ? req.url : rewrite(req.url);
    const method = req.method || 'POST';
    const headers = {};
    const given = req.headers || {};
    for (const k in given) if (Object.prototype.hasOwnProperty.call(given, k)) headers[k] = given[k];
    let body = req.body;
    if (body !== undefined && body !== null && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      body = JSON.stringify(body);
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
    }
    if (req.relay) {
      if (!o.relayBase) {
        throw new ServiceError('This provider needs the build server to relay the call, and this page has no build server. ' +
          'Use a build server, or the "Any service that signs a digest" option with a service your browser can call.');
      }
      // The credential goes in a header of its own, so the relay's code
      // makes plain what it forwards and forgets: server/lib/signrelay.js.
      const auth = headers.Authorization;
      delete headers.Authorization;
      const r = await rawSend(fetchImpl, o.relayBase + '/api/sign/' + req.relay, 'POST',
        auth ? { 'Content-Type': 'application/json', 'X-TI-Sign-Auth': auth } : { 'Content-Type': 'application/json' },
        JSON.stringify({ url: url, method: method, headers: headers, body: body === undefined ? null : body }));
      if (r.status !== 200) {
        const why = r.json && r.json.error ? r.json.error : 'HTTP ' + r.status;
        throw new ServiceError('The build server would not relay that call: ' + why);
      }
      const env = r.json || {};
      return { status: env.status || 0, headers: env.headers || {}, text: env.text || '', json: env.body === undefined ? null : env.body };
    }
    return rawSend(fetchImpl, url, method, headers, body);
  };
}

async function rawSend(fetchImpl, url, method, headers, body) {
  if (!fetchImpl) throw new ServiceError('This browser has no fetch(), so it cannot call a signing service.');
  let r;
  try {
    r = await fetchImpl(url, { method: method, headers: headers, body: body, mode: 'cors', credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    // A CORS refusal and a dead network look the same from a page; say both.
    return { status: 0, headers: {}, text: String(e && e.message ? e.message : e), json: null };
  }
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  const h = {};
  if (r.headers && r.headers.forEach) r.headers.forEach((v, k) => { h[String(k).toLowerCase()] = v; });
  return { status: r.status, headers: h, text: text, json: json };
}

/* ---------- field helpers ---------- */

const F = (id, label, extra) => {
  const f = { id: id, label: label, type: 'text', secret: false, optional: false };
  if (extra) for (const k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) f[k] = extra[k];
  return f;
};
const SECRET = (id, label, extra) => F(id, label, Object.assign({ type: 'password', secret: true }, extra || {}));

function need(creds, ids, name) {
  for (let i = 0; i < ids.length; i++) {
    if (!String(creds[ids[i]] || '').trim()) throw new ServiceError(name + ' needs every field above filling in.');
  }
}

const trimmed = (creds, id) => String(creds[id] === undefined || creds[id] === null ? '' : creds[id]).trim();

/* ---------- SSL.com eSigner ---------- */

const SSLCOM_HOSTS = {
  production: { api: 'https://cs.ssl.com', login: 'https://login.ssl.com' },
  sandbox: { api: 'https://cs-try.ssl.com', login: 'https://oauth-sandbox.ssl.com' },
};

const SSLCOM = {
  id: 'sslcom',
  name: 'SSL.com eSigner',
  where: 'browser',
  summary: 'The Cloud Signature Consortium API. The only one of these an individual can readily buy: ' +
    'a certificate plus eSigner, signed for with a one-time code.',
  evidence: 'Directly callable. A CORS preflight to cs.ssl.com/csc/v0/signatures/signHash answers 204 with ' +
    'Access-Control-Allow-Origin: * and a fixed Access-Control-Allow-Headers list that includes Authorization ' +
    'and Content-Type; login.ssl.com/oauth2/token answers the same (checked 2026-09-18 and again 2026-09-20).',
  docs: 'https://www.ssl.com/guide/remote-document-signing-with-esigner-csc-api/',
  verified: 'Checked against SSL.com\'s own sandbox on 2026-09-20 -- the whole flow, ending in a real ' +
    'signature from their HSM over a real Authenticode digest. Not yet used with a paid production ' +
    'account, which is a different thing: the sandbox may not have every option a real one does, and ' +
    'certificates with the malware-scan option may behave differently.',
  certs: 'service',
  fields: [
    F('env', 'Which eSigner', { type: 'select', options: [['production', 'Production (cs.ssl.com)'], ['sandbox', 'Sandbox (cs-try.ssl.com)']], hint: 'The sandbox has published demo credentials and issues test certificates.' }),
    F('clientId', 'API client ID', { hint: 'From "Register an application for the CSC API" in your SSL.com account.' }),
    SECRET('clientSecret', 'API client secret', {
      optional: true,
      hint: 'Leave it empty if your application is registered as a public client. SSL.com\'s guide uses a ' +
        'secret, but their sandbox issues a token from the client id alone (checked 2026-09-20).',
    }),
    F('username', 'eSigner username'),
    SECRET('password', 'eSigner password'),
    SECRET('totp', 'One-time code, or your TOTP secret', {
      hint: 'Six digits as shown by your authenticator, or the secret behind it -- base32 as an authenticator ' +
        'app shows it, or base64 as SSL.com gives it; the page works out which. A secret is safer here: the code ' +
        'is computed the moment it is needed, so it cannot expire mid-signing. Either way it stays in this tab.',
    }),
    F('credentialId', 'Credential ID', { optional: true, hint: 'Optional. Left blank, the page asks eSigner which credentials the account has and uses the only one.' }),
    F('keyType', 'Key type', { type: 'select', options: [['rsa', 'RSA'], ['ec', 'ECDSA (P-256)']] }),
  ],
  explain: (status, body) => commonExplain('SSL.com eSigner', status, body),
  async sign(creds, digest, ctx) {
    need(creds, ['clientId', 'username', 'password', 'totp'], 'eSigner');
    const host = SSLCOM_HOSTS[trimmed(creds, 'env')] || SSLCOM_HOSTS.production;
    const fail = (r) => { throw new ServiceError(SSLCOM.explain(r.status, r.json || r.text)); };

    // The client secret is optional: the sandbox issues a token from the
    // client id alone, so sending an empty one would be worse than sending
    // none (checked 2026-09-20).
    const grant = {
      client_id: trimmed(creds, 'clientId'),
      grant_type: 'password',
      username: trimmed(creds, 'username'),
      password: String(creds.password || ''),
    };
    if (String(creds.clientSecret || '').trim()) grant.client_secret = String(creds.clientSecret).trim();
    const tok = await ctx.send({ url: host.login + '/oauth2/token', body: grant });
    if (tok.status !== 200 || !tok.json || !tok.json.access_token) fail(tok);
    const bearer = { Authorization: 'Bearer ' + tok.json.access_token, 'Content-Type': 'application/json' };

    let credentialID = trimmed(creds, 'credentialId');
    if (!credentialID) {
      // clientData picks which kind of credential is listed, and getting it
      // wrong returns an empty list rather than an error. Code signing is
      // EVCS; asking for DS (the obvious default, and what this code used
      // to send) lists nothing at all on a code-signing account. Found on
      // the sandbox, 2026-09-20. So ask for each in turn.
      let ids = [];
      for (const clientData of ['EVCS', 'DS', null]) {
        const list = await ctx.send({
          url: host.api + '/csc/v0/credentials/list',
          headers: bearer,
          body: clientData ? { clientData: clientData } : {},
        });
        if (list.status !== 200 || !list.json) fail(list);
        ids = list.json.credentialIDs || [];
        if (ids.length) break;
      }
      if (!ids.length) throw new ServiceError('That eSigner account has no signing credentials. Check it has a code-signing certificate issued.');
      if (ids.length > 1) throw new ServiceError('That account has several credentials (' + ids.join(', ') + '). Put the one you want in the Credential ID field.');
      credentialID = ids[0];
    }

    const info = await ctx.send({
      url: host.api + '/csc/v0/credentials/info',
      headers: bearer,
      body: { credentialID: credentialID, certificates: 'chain', certInfo: true },
    });
    if (info.status !== 200 || !info.json) fail(info);
    const chain = (info.json.cert && info.json.cert.certificates) || [];
    if (!chain.length) throw new ServiceError('eSigner did not send a certificate for that credential.');

    const digestB64 = b64(digest);
    // A TOTP secret that could be read as either base32 or base64 gives two
    // codes; try each rather than making the user work out which SSL.com
    // gave them. A code typed by hand gives one.
    const codes = await otpCandidates(creds.totp);
    let auth = null;
    for (let i = 0; i < codes.length; i++) {
      auth = await ctx.send({
        url: host.api + '/csc/v0/credentials/authorize',
        headers: bearer,
        body: { credentialID: credentialID, numSignatures: 1, hash: [digestB64], OTP: codes[i] },
      });
      if (auth.status === 200 && auth.json && auth.json.SAD) break;
    }
    if (auth.status !== 200 || !auth.json || !auth.json.SAD) {
      if (auth.status === 400 || auth.status === 401) {
        throw new ServiceError('eSigner would not authorise the signature; the one-time code is the usual reason. ' +
          'If you gave a secret rather than a code, check you copied all of it, and that this computer\'s clock is right. ' +
          providerMessage(auth.json || auth.text));
      }
      fail(auth);
    }

    const signAlgo = trimmed(creds, 'keyType') === 'ec' ? '1.2.840.10045.4.3.2' : '1.2.840.113549.1.1.11';
    const sig = await ctx.send({
      url: host.api + '/csc/v0/signatures/signHash',
      headers: bearer,
      body: { credentialID: credentialID, SAD: auth.json.SAD, hash: [digestB64], signAlgo: signAlgo },
    });
    if (sig.status !== 200 || !sig.json || !sig.json.signatures || !sig.json.signatures.length) fail(sig);
    return { signature: decodeSignature(sig.json.signatures[0], 'base64'), certs: chain.map((c) => '-----BEGIN CERTIFICATE-----\n' + c + '\n-----END CERTIFICATE-----\n').join('') };
  },
};

/* ---------- Google Cloud KMS ---------- */

const GCPKMS = {
  id: 'gcpkms',
  name: 'Google Cloud KMS',
  where: 'browser',
  summary: 'asymmetricSign on one key version. Cloud KMS holds the key, not the certificate, ' +
    'so give the page your certificate file as well.',
  evidence: 'Directly callable. A CORS preflight to cloudkms.googleapis.com/v1/…:asymmetricSign answers 200, ' +
    'reflects the page\'s Origin and allows the Authorization header (checked 2026-09-18 and again 2026-09-20).',
  docs: 'https://docs.cloud.google.com/kms/docs/reference/rest/v1/projects.locations.keyRings.cryptoKeys.cryptoKeyVersions/asymmetricSign',
  certs: 'file',
  fields: [
    F('keyVersion', 'Key version', { placeholder: 'projects/…/locations/…/keyRings/…/cryptoKeys/…/cryptoKeyVersions/1', hint: 'The full resource name, as "gcloud kms keys versions list" prints it.' }),
    SECRET('accessToken', 'Access token', {
      hint: 'An OAuth token with the cloudkms scope: "gcloud auth print-access-token". It lasts about an hour. ' +
        'Pasting one avoids signing your Google account into this page at all.',
    }),
  ],
  explain: (status, body) => commonExplain('Cloud KMS', status, body),
  async sign(creds, digest, ctx) {
    need(creds, ['keyVersion', 'accessToken'], 'Cloud KMS');
    const name = trimmed(creds, 'keyVersion').replace(/^\/+/, '');
    const r = await ctx.send({
      url: 'https://cloudkms.googleapis.com/v1/' + name + ':asymmetricSign',
      headers: { Authorization: 'Bearer ' + String(creds.accessToken || '').trim(), 'Content-Type': 'application/json' },
      body: { digest: { sha256: b64(digest) } },
    });
    if (r.status !== 200 || !r.json || !r.json.signature) throw new ServiceError(GCPKMS.explain(r.status, r.json || r.text));
    return { signature: decodeSignature(r.json.signature, 'base64') };
  },
};

/* ---------- AWS KMS ---------- */

const AWS_ALGS = [
  ['RSASSA_PKCS1_V1_5_SHA_256', 'RSASSA_PKCS1_V1_5_SHA_256 (RSA, what Authenticode wants)'],
  ['ECDSA_SHA_256', 'ECDSA_SHA_256 (a P-256 key)'],
  ['ECDSA_SHA_384', 'ECDSA_SHA_384 (a P-384 key)'],
];

const AWSKMS = {
  id: 'awskms',
  name: 'AWS KMS',
  where: 'browser',
  summary: 'kms:Sign over the digest. KMS holds the key, not the certificate, so give the page your certificate file as well.',
  evidence: 'Directly callable. A CORS preflight to kms.<region>.amazonaws.com answers 200 with ' +
    'Access-Control-Allow-Origin: * and echoes whatever request headers are asked for, including the ' +
    'authorization, x-amz-date, x-amz-target and x-amz-security-token that SigV4 needs (checked 2026-09-20).',
  docs: 'https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html',
  certs: 'file',
  credsWarning: 'An access key typed into a page is the weak point here. Make one that can do nothing but ' +
    'kms:Sign on this one key ARN -- and, if you can, lock it to your address with aws:SourceIp. ' +
    'It stays in this tab and is cleared when the signing finishes.',
  fields: [
    F('region', 'Region', { placeholder: 'us-east-1' }),
    F('keyId', 'Key ID or ARN', { placeholder: 'arn:aws:kms:us-east-1:111122223333:key/…' }),
    F('accessKeyId', 'Access key ID'),
    SECRET('secretAccessKey', 'Secret access key'),
    SECRET('sessionToken', 'Session token', { optional: true, hint: 'Only for temporary credentials (STS).' }),
    F('algorithm', 'Signing algorithm', { type: 'select', options: AWS_ALGS }),
  ],
  explain(status, body) {
    if (status === 400 && body && body.__type) {
      const t = String(body.__type).replace(/^.*#/, '');
      if (/NotFound/.test(t)) return 'AWS KMS has no key by that ID in that region.';
      if (/Disabled|KMSInvalidState/.test(t)) return 'That AWS KMS key is not in a state where it can sign (disabled, or pending deletion).';
      if (/Incorrect|InvalidKeyUsage/.test(t)) return 'That AWS KMS key cannot sign, or not with that algorithm. It must be an asymmetric SIGN_VERIFY key.';
      if (/Validation/.test(t)) return 'AWS KMS refused the request as malformed: ' + providerMessage(body);
      return 'AWS KMS refused: ' + t + '. ' + providerMessage(body);
    }
    if (status === 403) {
      return 'AWS KMS refused those credentials. Either the signature did not match (check the secret access key, ' +
        'and that this computer\'s clock is right) or the key policy does not allow kms:Sign. ' + providerMessage(body);
    }
    return commonExplain('AWS KMS', status, body);
  },
  async sign(creds, digest, ctx) {
    need(creds, ['region', 'keyId', 'accessKeyId', 'secretAccessKey'], 'AWS KMS');
    const region = trimmed(creds, 'region');
    if (!/^[a-z0-9-]{4,32}$/.test(region)) throw new ServiceError('That is not an AWS region name (something like us-east-1).');
    const host = 'kms.' + region + '.amazonaws.com';
    const body = JSON.stringify({
      KeyId: trimmed(creds, 'keyId'),
      Message: b64(digest),
      MessageType: 'DIGEST',
      SigningAlgorithm: trimmed(creds, 'algorithm') || 'RSASSA_PKCS1_V1_5_SHA_256',
    });
    const date = (ctx && ctx.now ? amzDate(ctx.now()) : amzDate());
    const token = String(creds.sessionToken || '').trim();
    const headers = [
      ['content-type', 'application/x-amz-json-1.1'],
      ['host', host],
      ['x-amz-date', date],
      ['x-amz-target', 'TrentService.Sign'],
    ];
    if (token) headers.push(['x-amz-security-token', token]);
    const signed = await sigv4Sign({
      method: 'POST', path: '/', query: '', headers: headers, body: body,
      region: region, service: 'kms', amzDate: date,
      accessKeyId: trimmed(creds, 'accessKeyId'), secretAccessKey: String(creds.secretAccessKey || '').trim(),
    });
    // host is set by the browser; sending it explicitly is a forbidden header.
    const send = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Date': date,
      'X-Amz-Target': 'TrentService.Sign',
      Authorization: signed.authorization,
    };
    if (token) send['X-Amz-Security-Token'] = token;
    const r = await ctx.send({ url: 'https://' + host + '/', headers: send, body: body });
    if (r.status !== 200 || !r.json || !r.json.Signature) throw new ServiceError(AWSKMS.explain(r.status, r.json || r.text));
    return { signature: decodeSignature(r.json.Signature, 'base64') };
  },
};

/* ---------- Azure Trusted Signing ---------- */

const AZURE_API = '2023-06-15-preview';

const AZURETS = {
  id: 'azurets',
  name: 'Azure Trusted Signing',
  where: 'server',
  summary: 'Microsoft\'s signing service (once Azure Code Signing, now also called Artifact Signing). ' +
    'It signs a digest and hands back the certificate with it. Its certificates last three days, so always timestamp.',
  evidence: 'NOT callable from a page. A CORS preflight to <region>.codesigning.azure.net/…:sign answers ' +
    '405 Method Not Allowed with no Access-Control-* headers at all (checked 2026-09-18 and again 2026-09-20), ' +
    'so the browser refuses the call before it is made. The build server relays it instead.',
  docs: 'https://learn.microsoft.com/en-us/azure/trusted-signing/',
  certs: 'service',
  relayNote: 'Your access token and the digest pass through the build server. It forwards them to ' +
    'codesigning.azure.net and forgets them: nothing is stored, and the token is never written to a log. ' +
    'The token is short-lived (about an hour) and can only sign; it is not your Azure password. ' +
    'If you would rather nothing of yours touched our server, use the paste option instead, or run the relay yourself.',
  fields: [
    F('region', 'Region code', { placeholder: 'eus', hint: 'The short code in your account\'s endpoint: eus, wus2, neu, weu and so on.' }),
    F('account', 'Code signing account name'),
    F('profile', 'Certificate profile name'),
    SECRET('accessToken', 'Access token', {
      hint: 'A bearer token for https://codesigning.azure.net: ' +
        '"az account get-access-token --resource https://codesigning.azure.net --query accessToken -o tsv". ' +
        'The identity needs the "Trusted Signing Certificate Profile Signer" role.',
    }),
    F('algorithm', 'Signature algorithm', { type: 'select', options: [['RS256', 'RS256 (RSA)'], ['PS256', 'PS256 (RSA-PSS)'], ['ES256', 'ES256 (P-256)'], ['ES384', 'ES384 (P-384)']] }),
  ],
  explain(status, body) {
    if (status === 403) {
      return 'Azure accepted the token but refused to sign. The identity usually needs the ' +
        '"Trusted Signing Certificate Profile Signer" role on this certificate profile. ' + providerMessage(body);
    }
    if (status === 401) {
      return 'Azure did not accept that token. It may have expired (they last about an hour), or it may be for the ' +
        'wrong resource: it must be for https://codesigning.azure.net. ' + providerMessage(body);
    }
    return commonExplain('Azure Trusted Signing', status, body);
  },
  base(creds) {
    const region = trimmed(creds, 'region').toLowerCase();
    const account = trimmed(creds, 'account');
    const profile = trimmed(creds, 'profile');
    if (!/^[a-z0-9]{2,16}$/.test(region)) throw new ServiceError('That is not an Azure region code (something like eus or weu).');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(account) || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) {
      throw new ServiceError('Account and profile names are letters, digits, - and _ only.');
    }
    return 'https://' + region + '.codesigning.azure.net/codeSigningAccounts/' + account + '/certificateProfiles/' + profile;
  },
  async sign(creds, digest, ctx) {
    need(creds, ['region', 'account', 'profile', 'accessToken'], 'Azure Trusted Signing');
    const base = AZURETS.base(creds);
    const headers = { Authorization: 'Bearer ' + String(creds.accessToken || '').trim(), 'Content-Type': 'application/json' };
    const fail = (r) => { throw new ServiceError(AZURETS.explain(r.status, r.json || r.text)); };

    const start = await ctx.send({
      relay: 'azurets',
      url: base + ':sign?api-version=' + AZURE_API,
      headers: headers,
      body: { signatureAlgorithm: trimmed(creds, 'algorithm') || 'RS256', digest: b64(digest) },
    });
    if (start.status !== 200 && start.status !== 201 && start.status !== 202) fail(start);
    const opId = (start.json && start.json.operationId) ||
      (start.headers && start.headers['operation-location'] ? String(start.headers['operation-location']).replace(/\?.*$/, '').replace(/^.*\//, '') : '');
    if (!opId) throw new ServiceError('Azure accepted the digest but did not say which operation to ask about.');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(opId)) throw new ServiceError('Azure sent an operation id we will not put in a URL: ' + String(opId).slice(0, 40));

    // Signing is asynchronous. Poll, but not forever.
    const deadline = (ctx && ctx.now ? ctx.now().getTime() : Date.now()) + 120000;
    for (let i = 0; ; i++) {
      const st = await ctx.send({
        relay: 'azurets',
        method: 'GET',
        url: base + '/operations/' + opId + '?api-version=' + AZURE_API,
        headers: { Authorization: headers.Authorization },
      });
      if (st.status !== 200) fail(st);
      const s = String((st.json && st.json.status) || '');
      if (s === 'Succeeded') {
        if (!st.json.signature) throw new ServiceError('Azure says the signing succeeded but sent no signature.');
        const out = { signature: decodeSignature(st.json.signature, 'base64') };
        if (st.json.signingCertificate) out.certs = st.json.signingCertificate;
        return out;
      }
      if (s === 'Failed' || s === 'Canceled' || s === 'TimedOut' || s === 'NotFound') {
        throw new ServiceError('Azure could not sign it: the operation came back "' + s + '". ' + providerMessage(st.json));
      }
      if ((ctx && ctx.now ? ctx.now().getTime() : Date.now()) > deadline) {
        throw new ServiceError('Azure is still working on the signature after two minutes. Try again.');
      }
      await (ctx && ctx.sleep ? ctx.sleep(500) : new Promise((r) => setTimeout(r, 500)));
    }
  },
};

/* ---------- DigiCert KeyLocker ---------- */
//
// This one cannot be a browser call and should not be a relayed one either.
// Software Trust Manager authenticates with an API key AND a client
// authentication certificate (mutual TLS). A page cannot present a client
// certificate from fetch(), and a CORS preflight never carries one -- and
// the preflight is refused outright anyway ("Invalid CORS request", 403).
// Relaying it would mean uploading the .p12 and its password to the build
// server so that the server could do the TLS handshake as you. That is a
// different thing from forwarding a short-lived bearer token: it is handing
// over the whole credential, permanently, and it would put us much closer to
// "operating a signing service" than we want to be. So the page builds the
// commands instead and takes the answer back. Nothing secret is typed here.

const DIGICERT = {
  id: 'digicert',
  name: 'DigiCert KeyLocker (Software Trust Manager)',
  where: 'paste',
  summary: 'Signs a hash, but only over mutual TLS with a client certificate, which no web page can do. ' +
    'The page shows you the commands and finishes the file from what they print.',
  evidence: 'NOT callable from a page, twice over. A CORS preflight to ' +
    'clientauth.one.digicert.com/signingmanager/api/v1/… answers 403 "Invalid CORS request" with no ' +
    'Access-Control-Allow-Origin, and the host asks for a client certificate during the TLS handshake ' +
    '(checked 2026-09-18 and again 2026-09-20). Relaying is deliberately not offered: see the note in the panel.',
  docs: 'https://dev.digicert.com/software-trust-api/tutorials/create-a-keypair-and-sign-a-file-hash.html',
  certs: 'file',
  fields: [
    F('keypairId', 'Keypair ID or alias', { hint: 'From "smctl keypair ls", or the Keypairs page in DigiCert ONE.' }),
    F('sigAlg', 'Signature algorithm', { type: 'select', options: [['SHA256WithRSA', 'SHA256WithRSA'], ['SHA256WithECDSA', 'SHA256WithECDSA'], ['SHA384WithECDSA', 'SHA384WithECDSA']] }),
    F('host', 'API host', { type: 'select', options: [['clientauth.one.digicert.com', 'Production (clientauth.one.digicert.com)'], ['clientauth.demo.one.digicert.com', 'Demo (clientauth.demo.one.digicert.com)']] }),
  ],
  explain: (status, body) => commonExplain('DigiCert', status, body),
  // What to run. digestB64 is the digest the page is waiting to have signed.
  command(creds, digestB64) {
    const host = trimmed(creds, 'host') || 'clientauth.one.digicert.com';
    const kp = trimmed(creds, 'keypairId') || '<keypair-id>';
    const alg = trimmed(creds, 'sigAlg') || 'SHA256WithRSA';
    return [
      '# The simple way, with DigiCert\'s own tool (it holds your credentials already):',
      'smctl sign --keypair-alias ' + kp + ' --input-digest ' + digestB64 + ' --output-format base64',
      '',
      '# Or straight at the API. It needs BOTH your API key and your client',
      '# authentication certificate, which is why a browser cannot do this.',
      'curl -sS --cert $SM_CLIENT_CERT_FILE:$SM_CLIENT_CERT_PASSWORD \\',
      '  -H "x-api-key: $SM_API_KEY" -H "Content-Type: application/json" \\',
      '  -d \'{"hash":"' + digestB64 + '","sig_alg":"' + alg + '"}\' \\',
      '  https://' + host + '/signingmanager/api/v1/keypairs/' + kp + '/sign',
      '# That returns {"id":"…"}. Then read the signature out of it:',
      'curl -sS --cert $SM_CLIENT_CERT_FILE:$SM_CLIENT_CERT_PASSWORD \\',
      '  -H "x-api-key: $SM_API_KEY" \\',
      '  https://' + host + '/signingmanager/api/v1/signatures/<id>',
      '# Paste the "signature" field below, and give the page your certificate',
      '# (smctl certificate ls / download) above.',
    ].join('\n');
  },
};

/* ---------- Any service that signs a digest ---------- */
//
// The one that cannot go stale. Everything above is a guess about somebody
// else's API that we cannot test; this one is whatever the person in front
// of the page tells us it is. It is worth more care than the named ones,
// not less.

const GENERIC = {
  id: 'generic',
  name: 'Any service that signs a digest',
  where: 'browser',
  summary: 'Describe your service and the page will call it: an address, the headers it wants, where the digest ' +
    'goes in the request and where the signature comes back in the answer. Works with anything that signs ' +
    'a SHA-256 digest -- a KMS, an HSM front end, a colleague\'s script, your own relay.',
  evidence: 'Direct: the page calls the address you give it. Whether that works is up to your service -- a browser ' +
    'can only call it if it answers a CORS preflight with Access-Control-Allow-Origin. If it does not, the page ' +
    'says so, and the copy-and-paste option below still works with absolutely anything.',
  docs: '',
  certs: 'either',
  fields: [
    F('url', 'Address', { placeholder: 'https://signing.example.com/sign' }),
    F('method', 'Method', { type: 'select', options: [['POST', 'POST'], ['PUT', 'PUT']] }),
    SECRET('headers', 'Headers', {
      type: 'textarea', optional: true,
      placeholder: 'Authorization: Bearer …\nContent-Type: application/json',
      hint: 'One per line, "Name: value". This is where an API key goes, so it is treated as a secret: ' +
        'never stored, and cleared when the signing finishes.',
    }),
    F('digestEncoding', 'Send the digest as', { type: 'select', options: DIGEST_ENCODINGS }),
    F('bodyTemplate', 'Request body', {
      type: 'textarea', optional: true,
      placeholder: '{"hash": "{{digest}}", "alg": "SHA256WithRSA"}',
      hint: '{{digest}} is replaced by the digest in the encoding above. Leave this empty to send the digest ' +
        'as the whole body (with "The raw 32 bytes", that is the 32 bytes themselves).',
    }),
    F('signaturePath', 'The signature is at', {
      optional: true, placeholder: 'signature',
      hint: 'A path into the JSON answer: "signature", or "signatures.0", or "result.sig". ' +
        'Leave empty if the answer is the signature itself and nothing else.',
    }),
    F('signatureEncoding', 'and is encoded as', { type: 'select', options: [['base64', 'Base64'], ['base64url', 'Base64 (URL-safe)'], ['hex', 'Hex']] }),
    F('certPath', 'The certificate is at', {
      optional: true, placeholder: 'certificateChain',
      hint: 'Optional. A path into the same answer holding your certificate (PEM, or base64 DER, or a list of either). ' +
        'Leave it empty and the page uses the certificate file you give it above.',
    }),
  ],
  explain: (status, body) => commonExplain('Your service', status, body),
  async sign(creds, digest, ctx) {
    const url = trimmed(creds, 'url');
    if (!url) throw new ServiceError('Give the address of the service that signs the digest.');
    if (!/^https:\/\//i.test(url)) {
      if (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)) { /* a local service is fine */ } else {
        throw new ServiceError('The address must be https:// (a page served over https cannot call a plain http:// address anyway).');
      }
    }
    const headers = {};
    const lines = String(creds.headers || '').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const c = line.indexOf(':');
      if (c < 1) throw new ServiceError('Header lines look like "Name: value". This one does not: ' + line.slice(0, 40));
      headers[line.slice(0, c).trim()] = line.slice(c + 1).trim();
    }

    const enc = trimmed(creds, 'digestEncoding') || 'base64';
    const tpl = String(creds.bodyTemplate === undefined || creds.bodyTemplate === null ? '' : creds.bodyTemplate);
    let body;
    if (!tpl.trim()) {
      body = enc === 'raw' ? digest : encodeDigest(digest, enc);
    } else if (enc === 'raw') {
      throw new ServiceError('"The raw 32 bytes" only works as the whole body. Leave the request body empty, or choose another encoding.');
    } else {
      body = tpl.split('{{digest}}').join(encodeDigest(digest, enc));
      if (body === tpl) throw new ServiceError('The request body has no {{digest}} in it, so the digest would never be sent.');
      if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
    }

    const r = await ctx.send({ url: url, method: trimmed(creds, 'method') || 'POST', headers: headers, body: body });
    if (r.status === 0) {
      throw new ServiceError('The browser could not call ' + url + '. Either it is unreachable, or it does not allow ' +
        'calls from a web page (CORS). Browsers do not say which. Try the address in a terminal: if curl works and ' +
        'this does not, it is CORS, and the copy-and-paste option is the way round it. (' + String(r.text).slice(0, 120) + ')');
    }
    if (r.status < 200 || r.status >= 300) throw new ServiceError(GENERIC.explain(r.status, r.json || r.text));

    const sigEnc = trimmed(creds, 'signatureEncoding') || 'base64';
    const sigPath = trimmed(creds, 'signaturePath');
    let raw;
    if (!sigPath) {
      if (sigEnc === 'raw') {
        throw new ServiceError('Raw signature bytes can\'t be read back out of an answer here. ' +
          'Have the service answer with base64 or hex.');
      }
      raw = r.text;
    } else {
      if (!r.json) throw new ServiceError('The answer is not JSON, so there is nothing at "' + sigPath + '". It was: ' + String(r.text).slice(0, 120));
      raw = readPath(r.json, sigPath);
    }
    const out = { signature: decodeSignature(raw, sigEnc) };
    const certPath = trimmed(creds, 'certPath');
    if (certPath) {
      if (!r.json) throw new ServiceError('The answer is not JSON, so there is no certificate at "' + certPath + '".');
      const c = readPath(r.json, certPath);
      out.certs = Array.isArray(c) ? c.map(pemWrap).join('') : pemWrap(c);
    }
    return out;
  },
};

// A certificate from a service: PEM as it stands, base64 DER wrapped.
function pemWrap(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (s.indexOf('-----BEGIN') >= 0) return s.replace(/\s*$/, '\n');
  return '-----BEGIN CERTIFICATE-----\n' + s.replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n') + '-----END CERTIFICATE-----\n';
}

/* ---------- the list ---------- */

export const SERVICES = [SSLCOM, GCPKMS, AWSKMS, AZURETS, DIGICERT, GENERIC];

export function service(id) {
  for (let i = 0; i < SERVICES.length; i++) if (SERVICES[i].id === id) return SERVICES[i];
  return null;
}

// Which providers a page can offer. Relayed ones need a build server, so
// they do not exist in the offline one-file page -- the same rule the
// timestamp relay follows (web/css/style.css .online-only).
export function servicesFor(hasServer) {
  return SERVICES.filter((s) => hasServer || s.where !== 'server');
}

// Where this provider's credentials go, in one sentence, for the panel to
// show BEFORE any field. Never softened.
export function credentialPath(svc) {
  if (svc.where === 'paste') return 'Nothing secret is typed into this page: you run the commands it shows, and paste back the signature.';
  if (svc.where === 'server') {
    return 'These credentials pass through the build server. ' + (svc.relayNote || '');
  }
  return 'These credentials stay in this browser. The page calls ' + svc.name +
    ' directly, so nothing of yours reaches our server -- only the signing service sees them, and only the ' +
    '32-byte digest is sent. They are held in this tab\'s memory, never in storage, and cleared when the signing finishes.';
}

// Everything the panel needs to say about one provider, in order.
export function describe(svc) {
  return {
    summary: svc.summary,
    credentials: credentialPath(svc),
    warning: svc.credsWarning || '',
    evidence: svc.evidence,
    untested: svc.verified || UNTESTED,
    docs: svc.docs,
  };
}
