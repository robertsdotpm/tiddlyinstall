// POST /api/sign/<provider>: the relay for cloud signing services whose API
// a browser cannot call (docs/browser-signing.md section 3; design.md 11.1
// item 21). Same shape, same allow-list discipline and the same rate limit
// as /api/tsa in server.js -- and the same promise, only stricter, because
// this one carries a credential and not just a hash.
//
// THE RULE. A credential that passes through here is forwarded and
// forgotten. It arrives in a header of its own, X-IB-Sign-Auth, so that
// there is exactly one line in this file that touches it and no chance of
// it being confused with our own request handling. It is never written to
// disk, never put in a log (server.js logs the address, method and path
// only, and no credential appears in either), never kept in a variable
// beyond the request, and never sent anywhere but the one upstream URL the
// allow-list below permits. If this server ever *held* a publisher's
// credentials we would arguably be operating a signing service under the
// CA/B Forum code-signing baseline requirements; forwarding and forgetting
// is the line, and this file is where it is drawn.
//
// THE ALLOW-LIST. The page sends a whole URL, but only a URL matching one
// fixed pattern per provider is forwarded. The patterns below admit nothing
// but the documented paths of one service each: no host the publisher
// chooses, no path they choose, no query they choose. Anything else is
// refused with 403 and never dialled. That is what keeps this from being an
// open proxy -- lib/netsafe.js would still stop it reaching this machine or
// the LAN, but an open POST proxy to the public internet is not something a
// build server should be either.
//
// Providers a browser CAN call directly are not here, and must not be added:
// SSL.com eSigner, Google Cloud KMS and AWS KMS all send CORS headers, so
// their credentials never leave the browser. DigiCert KeyLocker is not here
// either, and should not be: it authenticates with a client certificate, so
// relaying it would mean uploading a publisher's .p12 and its password for
// this server to hold and use, which is the thing the rule above forbids.
import { safeFetch } from './netsafe.js';

// One pattern per provider. Anchored, no dots outside the literal ones, and
// no wildcards over the path. Adding a provider means adding a pattern here
// and nowhere else.
export const SIGN_RELAYS = {
  // Azure Trusted Signing (was Azure Code Signing; also Artifact Signing).
  // Its preflight answers 405 with no Access-Control-* headers at all, so a
  // page cannot call it. Three documented operations, and nothing else.
  azurets: {
    name: 'Azure Trusted Signing',
    methods: ['POST', 'GET'],
    url: /^https:\/\/[a-z0-9]{2,16}\.codesigning\.azure\.net\/codeSigningAccounts\/[A-Za-z0-9_-]{1,64}\/certificateProfiles\/[A-Za-z0-9_-]{1,64}(?::sign|\/operations\/[A-Za-z0-9_-]{1,64}|\/certificateChain)\?api-version=[0-9]{4}-[0-9]{2}-[0-9]{2}(?:-preview)?$/,
  },
};

// At most this much of a request body is forwarded. A digest is 32 bytes and
// the JSON around it is tiny; 16 KB is already generous.
export const RELAY_BODY_MAX = 16 * 1024;
// And of an answer. Azure's sign status carries a certificate chain.
export const RELAY_REPLY_MAX = 256 * 1024;

export class RelayRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The one place a URL from the page is judged. Exported so the test can
// hammer it directly: tests/sign-test.mjs runs the URLs a hostile page might
// try through it.
export function checkRelay(provider, url, method) {
  const p = Object.hasOwn(SIGN_RELAYS, String(provider)) ? SIGN_RELAYS[provider] : null;
  if (!p) throw new RelayRefused('not_allowed', 'Unknown signing service; the relay only forwards to a fixed list.');
  const u = String(url == null ? '' : url);
  if (u.length > 1024 || !p.url.test(u)) {
    throw new RelayRefused('not_allowed', 'The relay only forwards to ' + p.name + '\'s own signing endpoints.');
  }
  const m = String(method || 'POST').toUpperCase();
  if (!p.methods.includes(m)) throw new RelayRefused('not_allowed', 'The relay does not forward ' + m + ' to ' + p.name + '.');
  return { url: u, method: m, name: p.name };
}

// Headers we pass upstream. Authorization is handled on its own (see the
// rule at the top); everything else the page asks for is dropped unless it
// is on this list, so a page cannot use the relay to put arbitrary headers
// on our server's outgoing connections.
const FORWARD = ['content-type', 'accept'];

function pickHeaders(given) {
  const out = {};
  if (given && typeof given === 'object') {
    for (const k of Object.keys(given)) {
      if (FORWARD.includes(k.toLowerCase()) && typeof given[k] === 'string' && given[k].length < 200) {
        out[k] = given[k];
      }
    }
  }
  return out;
}

// The handler. `h` is the small set of helpers server.js already has
// (readBody, apiError, writeJSON) plus, for the tests only, a `fetch` to use
// instead of safeFetch -- lib/netsafe.js refuses to dial 127.0.0.1, which is
// exactly right in production and exactly wrong for a mock on loopback.
//
// The answer is an envelope, always HTTP 200 when the relay itself worked:
//   {status, headers: {…}, body: <parsed JSON or null>, text: "…"}
// so the page can tell "the relay refused" (a 4xx with {code, error}) from
// "the service refused" (a 200 envelope with status 403 inside it).
export async function signRelay(req, res, provider, h) {
  let target;
  let sent;
  try {
    const raw = await h.readBody(req, res, RELAY_BODY_MAX + 1);
    if (!raw || raw.length > RELAY_BODY_MAX) throw new RelayRefused('bad_request', 'The relay takes one small JSON request.');
    try {
      sent = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch (e) {
      throw new RelayRefused('bad_json', 'The relay takes one small JSON request.');
    }
    if (!sent || typeof sent !== 'object') throw new RelayRefused('bad_json', 'The relay takes one small JSON request.');
    target = checkRelay(provider, sent.url, sent.method);
  } catch (e) {
    if (e instanceof RelayRefused) return h.apiError(res, e.code === 'not_allowed' ? 403 : 400, e.code, e.message);
    return h.apiError(res, 400, 'bad_request', 'couldn\'t read the request');
  }

  const headers = pickHeaders(sent.headers);
  // The one line that touches the credential. It is read from the request,
  // put on the outgoing call, and goes out of scope with this function.
  const auth = req.headers['x-ib-sign-auth'];
  if (typeof auth === 'string' && auth) headers.Authorization = auth;

  let body = null;
  if (target.method !== 'GET' && sent.body != null) {
    body = Buffer.from(typeof sent.body === 'string' ? sent.body : JSON.stringify(sent.body), 'utf8');
    if (body.length > RELAY_BODY_MAX) return h.apiError(res, 400, 'bad_request', 'That request body is too large to relay.');
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json';
  }

  const fetcher = h.fetch || safeFetch;
  let up;
  try {
    up = await fetcher(target.url, { method: target.method, headers, body, timeout: 60000 });
  } catch (e) {
    return h.apiError(res, 502, 'upstream', target.name + ' did not answer.');
  }
  let out;
  try { out = await up.upTo(RELAY_REPLY_MAX); } catch (e) { out = null; }
  const text = out ? out.toString('utf8') : '';
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (e) { /* not JSON; the text goes back as it is */ }

  // Only the headers the caller actually needs. Nothing that could carry a
  // cookie or a token back into the page.
  const back = {};
  if (up.headers['operation-location']) back['operation-location'] = String(up.headers['operation-location']);
  if (up.headers['retry-after']) back['retry-after'] = String(up.headers['retry-after']);

  return h.writeJSON(res, 200, { status: up.status, headers: back, body: parsed, text: parsed === null ? text.slice(0, 4096) : '' },
    { 'Cache-Control': 'no-store' });
}
