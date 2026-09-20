// Mock cloud signing services: one per API shape in js/sign-services.js.
//
// None of the real services can be opened without paying and passing an
// identity check, so none of them can be called from a test. What can be
// tested is everything between the panel and the wire: that each descriptor
// builds the request the provider documents, reads the signature and the
// certificate back out of the documented answer, turns each documented
// failure into plain words, and never puts a credential anywhere it should
// not be. These servers speak exactly the documented request and response,
// check the credentials they were told to expect, and sign with a real key
// so the result goes on to make a real Authenticode file that osslsigncode
// verifies.
//
// A mock proves the plumbing, not the provider. If a real API differs from
// its documentation, only someone with an account will find out -- which is
// why the panel carries a contact address.
//
// Every credential here is generated at run time by the caller
// (tests/sign-test.mjs). Nothing in this file is a real secret, and no real
// secret is ever written to a file.
import http from 'node:http';
import crypto from 'node:crypto';

const json = (res, status, body, headers) => {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, headers || {}));
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve) => {
    const c = [];
    req.on('data', (x) => c.push(x));
    req.on('end', () => resolve(Buffer.concat(c)));
  });
}

// RFC 6238, independently of js/sign-services.js, so the two are not the
// same code checking itself.
function totpNow(secretBase32, atMs) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, acc = 0;
  const bytes = [];
  for (const ch of secretBase32.toUpperCase().replace(/[\s=]/g, '')) {
    acc = (acc << 5) | A.indexOf(ch);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255); }
  }
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(Math.floor((atMs || Date.now()) / 1000 / 30) / 4294967296), 0);
  msg.writeUInt32BE(Math.floor((atMs || Date.now()) / 1000 / 30) % 4294967296, 4);
  const mac = crypto.createHmac('sha1', Buffer.from(bytes)).update(msg).digest();
  const o = mac[19] & 0xf;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}

// AWS SigV4, independently again: the mock recomputes the signature from the
// request it received and refuses one that doesn't match, so the page's
// SigV4 is checked end to end and not only against the vectors.
function sigv4Check(req, body, creds) {
  const auth = req.headers.authorization || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return 'the Authorization header is not a SigV4 one: ' + auth.slice(0, 80);
  const [, akid, date, region, service, signedHeaders, signature] = m;
  if (akid !== creds.accessKeyId) return 'wrong access key id';
  const amzDate = req.headers['x-amz-date'] || '';
  if (amzDate.slice(0, 8) !== date) return 'x-amz-date does not match the credential scope';
  // The request was signed for the real AWS address and then rewritten to
  // this mock, so recompute against the address it was signed for, not the
  // one it arrived at. Everything else is exactly what came over the wire.
  const realHost = 'kms.' + creds.region + '.amazonaws.com';
  const canonHeaders = signedHeaders.split(';')
    .map((h) => h + ':' + String(h === 'host' ? realHost : req.headers[h]).trim().replace(/\s+/g, ' ') + '\n').join('');
  const creq = ['POST', '/', '', canonHeaders, signedHeaders, crypto.createHash('sha256').update(body).digest('hex')].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, `${date}/${region}/${service}/aws4_request`,
    crypto.createHash('sha256').update(creq).digest('hex')].join('\n');
  let k = Buffer.from('AWS4' + creds.secretAccessKey, 'utf8');
  for (const p of [date, region, service, 'aws4_request']) k = crypto.createHmac('sha256', k).update(p).digest();
  const want = crypto.createHmac('sha256', k).update(sts).digest('hex');
  if (want !== signature) return 'the SigV4 signature does not match what this request should produce';
  if (service !== 'kms') return 'wrong service in the credential scope: ' + service;
  return null;
}

// opts:
//   sign(digestBytes, which)  -> Buffer signature (the caller's openssl key)
//   certsB64                  -> [base64 DER, ...] chain the services hand back
//   creds                     -> the credentials each mock expects (made fresh
//                                by the caller; never a real one)
//   fail                      -> optional {provider: {status, body}} to force
//                                a failure, for the error-path tests
export async function startMockServices(opts) {
  const state = { fail: opts.fail || {}, calls: [], azureOps: new Map() };
  const C = opts.creds;
  const sign = opts.sign;
  const certsB64 = opts.certsB64 || [];

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const raw = await readBody(req);
    const text = raw.toString('utf8');
    let body = null;
    try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
    // What was sent, so the test can assert no credential went into a URL.
    state.calls.push({ path: p, query: u.search, method: req.method, headers: req.headers, body, text });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS' });
      return res.end();
    }

    const forced = (who) => {
      const f = state.fail[who];
      if (!f) return false;
      json(res, f.status, f.body);
      return true;
    };

    /* ----- SSL.com eSigner (CSC API) ----- */
    if (p === '/sslcom/login/oauth2/token') {
      if (forced('sslcom-token')) return;
      if (!body || body.grant_type !== 'password') return json(res, 400, { error: 'unsupported_grant_type' });
      if (body.client_id !== C.sslcom.clientId || body.client_secret !== C.sslcom.clientSecret) {
        return json(res, 401, { error: 'invalid_client', error_description: 'Client authentication failed' });
      }
      if (body.username !== C.sslcom.username || body.password !== C.sslcom.password) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Bad credentials' });
      }
      return json(res, 200, { access_token: 'mock-access-token', token_type: 'Bearer', expires_in: 3600 });
    }
    if (p.startsWith('/sslcom/api/csc/v0/')) {
      if (req.headers.authorization !== 'Bearer mock-access-token') return json(res, 401, { error: 'invalid_token' });
      if (p.endsWith('/credentials/list')) {
        if (forced('sslcom-list')) return;
        return json(res, 200, { credentialIDs: state.fail['sslcom-many'] ? ['one', 'two'] : [C.sslcom.credentialId] });
      }
      if (p.endsWith('/credentials/info')) {
        if (body.credentialID !== C.sslcom.credentialId) return json(res, 404, { error: 'no such credential' });
        return json(res, 200, { cert: { status: 'valid', certificates: certsB64 }, key: { algo: ['1.2.840.113549.1.1.1'], len: 3072 }, multisign: 5 });
      }
      if (p.endsWith('/credentials/authorize')) {
        if (forced('sslcom-authorize')) return;
        const want = totpNow(C.sslcom.totpSecret);
        if (String(body.OTP) !== want) return json(res, 400, { error: 'invalid_otp', error_description: 'The one-time password is not valid' });
        if (!Array.isArray(body.hash) || body.hash.length !== 1) return json(res, 400, { error: 'invalid_request', error_description: 'hash must be a list' });
        state.sad = 'mock-SAD-' + body.hash[0];
        return json(res, 200, { SAD: state.sad, expiresIn: 300 });
      }
      if (p.endsWith('/signatures/signHash')) {
        if (forced('sslcom-sign')) return;
        if (body.SAD !== state.sad) return json(res, 400, { error: 'invalid_sad' });
        if (body.signAlgo !== '1.2.840.113549.1.1.11' && body.signAlgo !== '1.2.840.10045.4.3.2') {
          return json(res, 400, { error: 'invalid_request', error_description: 'unknown signAlgo' });
        }
        const sig = await sign(Buffer.from(body.hash[0], 'base64'), 'sslcom');
        return json(res, 200, { signatures: [sig.toString('base64')] });
      }
      return json(res, 404, { error: 'not found' });
    }

    /* ----- Google Cloud KMS ----- */
    if (p.startsWith('/gcpkms/v1/') && p.endsWith(':asymmetricSign')) {
      if (forced('gcpkms')) return;
      if (req.headers.authorization !== 'Bearer ' + C.gcpkms.accessToken) {
        return json(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } });
      }
      const name = p.slice('/gcpkms/v1/'.length, -':asymmetricSign'.length);
      if (name !== C.gcpkms.keyVersion) {
        return json(res, 404, { error: { code: 404, status: 'NOT_FOUND', message: 'CryptoKeyVersion not found.' } });
      }
      if (!body || !body.digest || !body.digest.sha256) return json(res, 400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'digest.sha256 is required' } });
      const sig = await sign(Buffer.from(body.digest.sha256, 'base64'), 'gcpkms');
      return json(res, 200, { name, signature: sig.toString('base64'), protectionLevel: 'HSM' });
    }

    /* ----- AWS KMS ----- */
    if (p === '/awskms/' || p === '/awskms') {
      if (forced('awskms')) return;
      if (req.headers['x-amz-target'] !== 'TrentService.Sign') {
        return json(res, 400, { __type: 'UnknownOperationException' });
      }
      const why = sigv4Check(req, raw, C.awskms);
      if (why) return json(res, 403, { __type: 'IncompleteSignatureException', message: why });
      if (body.MessageType !== 'DIGEST') return json(res, 400, { __type: 'ValidationException', message: 'MessageType must be DIGEST' });
      if (body.KeyId !== C.awskms.keyId) return json(res, 400, { __type: 'NotFoundException', message: 'Key ' + body.KeyId + ' does not exist' });
      const sig = await sign(Buffer.from(body.Message, 'base64'), 'awskms');
      return json(res, 200, { KeyId: body.KeyId, Signature: sig.toString('base64'), SigningAlgorithm: body.SigningAlgorithm });
    }

    /* ----- Azure Trusted Signing ----- */
    if (p.startsWith('/azurets/codeSigningAccounts/')) {
      if (req.headers.authorization !== 'Bearer ' + C.azurets.accessToken) {
        return json(res, 401, { error: { code: 'Unauthorized', message: 'The access token is invalid.' } });
      }
      if (!u.searchParams.get('api-version')) return json(res, 400, { error: { code: 'BadRequest', message: 'api-version is required' } });
      if (p.endsWith(':sign')) {
        if (forced('azurets')) return;
        if (!body || !body.digest || !body.signatureAlgorithm) {
          return json(res, 400, { error: { code: 'BadRequest', message: 'digest and signatureAlgorithm are required' } });
        }
        const id = 'op-' + crypto.randomBytes(6).toString('hex');
        // Asynchronous, as documented: the first poll is still running.
        state.azureOps.set(id, { polls: 0, digest: Buffer.from(body.digest, 'base64') });
        return json(res, 202, { operationId: id, status: 'InProgress' },
          { 'Operation-Location': 'https://eus.codesigning.azure.net/codeSigningAccounts/a/certificateProfiles/p/operations/' + id + '?api-version=2023-06-15-preview' });
      }
      const m = /\/operations\/([^/?]+)$/.exec(p);
      if (m) {
        if (forced('azurets-status')) return;
        const op = state.azureOps.get(m[1]);
        if (!op) return json(res, 404, { error: { code: 'NotFound', message: 'No such operation' } });
        op.polls++;
        if (op.polls < 2) return json(res, 200, { operationId: m[1], status: 'InProgress' });
        if (state.fail['azurets-failed']) return json(res, 200, { operationId: m[1], status: 'Failed', error: { code: 'SigningFailed', message: 'The certificate profile is not ready.' } });
        const sig = await sign(op.digest, 'azurets');
        return json(res, 200, {
          operationId: m[1], status: 'Succeeded',
          signature: sig.toString('base64'),
          signingCertificate: certsB64.map((c) => '-----BEGIN CERTIFICATE-----\n' + c.replace(/(.{64})/g, '$1\n').replace(/\n?$/, '\n') + '-----END CERTIFICATE-----\n').join(''),
        });
      }
      return json(res, 404, { error: { code: 'NotFound', message: 'no such path' } });
    }

    /* ----- "Any service that signs a digest" -----
       Four shapes on purpose, because the point of the generic option is
       that it bends to whatever someone already has. */
    if (p === '/generic/json-base64') {
      if (forced('generic')) return;
      if (req.headers['x-api-key'] !== C.generic.apiKey) return json(res, 401, { message: 'bad api key' });
      const sig = await sign(Buffer.from(body.hash, 'base64'), 'generic');
      return json(res, 200, { result: { sig: sig.toString('base64') } });
    }
    if (p === '/generic/json-hex') {
      const sig = await sign(Buffer.from(body.digest_hex, 'hex'), 'generic');
      return json(res, 200, { signatures: [sig.toString('hex')] });
    }
    if (p === '/generic/raw-body') {
      // The digest as the whole body, the signature as the whole answer.
      const sig = await sign(raw, 'generic');
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      return res.end(sig.toString('base64'));
    }
    if (p === '/generic/with-cert') {
      // This one answers with the certificate chain as well, so it signs
      // with the same key that chain belongs to.
      const sig = await sign(Buffer.from(body.hash, 'base64'), 'generic-with-cert');
      return json(res, 200, { sig: sig.toString('base64'), chain: certsB64 });
    }
    if (p === '/generic/not-json') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*' });
      return res.end('<html>a login page, not a signing service</html>');
    }

    json(res, 404, { error: 'no such mock endpoint: ' + p });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const origin = 'http://127.0.0.1:' + port;

  // Production URLs to this mock. Descriptors always build the real URL, so
  // the set of addresses a credential can be sent to stays visible in
  // js/sign-services.js and nowhere else; this is the only place it is bent.
  const MAP = [
    [/^https:\/\/login\.ssl\.com/, origin + '/sslcom/login'],
    [/^https:\/\/oauth-sandbox\.ssl\.com/, origin + '/sslcom/login'],
    [/^https:\/\/cs(-try)?\.ssl\.com/, origin + '/sslcom/api'],
    [/^https:\/\/cloudkms\.googleapis\.com/, origin + '/gcpkms'],
    [/^https:\/\/kms\.[a-z0-9-]+\.amazonaws\.com/, origin + '/awskms'],
    [/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net/, origin + '/azurets'],
  ];
  const rewrite = (url) => {
    for (const [re, to] of MAP) if (re.test(url)) return url.replace(re, to);
    return url;
  };

  return {
    port,
    origin,
    rewrite,
    calls: state.calls,
    setFail(f) { state.fail = f || {}; },
    close: () => new Promise((r) => server.close(r)),
  };
}
