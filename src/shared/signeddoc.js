// Checking a document signed with the plan key, in one place.
//
// Plans, the withdrawn-file list, the runtime-script roots and the
// catalogue attestation are all signed the same way and differ only in
// the header their signed bytes must start with -- which is what stops a
// signature over one being read as another (docs/format.md section 7).
//
// It lives here because two callers now need it: the Verify page, which
// checks what someone dropped on it, and local-api, which checks what
// the page itself carries before building from it. A security check with
// two implementations has one that is wrong and nobody knows which.

// The signed bytes are everything before the last line, which must be
// `sig<TAB>ed25519<TAB>...`. Nothing is normalised: the bytes are
// checked exactly as they are.
export function docSignature(text, header, b64bytes) {
  const s = String(text);
  let body = s;
  if (body.endsWith('\n')) body = body.slice(0, -1);
  if (body.endsWith('\r')) body = body.slice(0, -1);
  const cut = body.lastIndexOf('\n');
  const last = cut < 0 ? body : body.slice(cut + 1);
  if (!/^sig\t/.test(last)) return { signed: false, why: 'no sig line' };
  const f = last.split('\t');
  if (f[1] !== 'ed25519') return { signed: false, why: 'signature type "' + f[1] + '" is not ed25519' };
  const signed = s.slice(0, cut + 1);
  if (!signed.startsWith(header + '\t')) return { signed: false, why: 'the signed bytes do not start with ' + header };
  let sig;
  try { sig = b64bytes(f[2]); } catch (e) { return { signed: false, why: 'the signature is not base64' }; }
  if (sig.length !== 64) return { signed: false, why: 'the signature is ' + sig.length + ' bytes, not 64' };
  return { signed: true, sig, bytes: new TextEncoder().encode(signed) };
}

// true only when the document is signed by this key, for this kind.
// Anything else -- no key, no signature, the wrong kind, a signature
// that does not check out -- is false, with no middle answer.
export function verifyDoc(text, kind, pub, b64bytes, ed25519Verify) {
  if (!pub || !text) return false;
  const s = docSignature(text, kind, b64bytes);
  if (!s.signed) return false;
  try { return !!ed25519Verify(pub, s.bytes, s.sig); } catch (e) { return false; }
}

// One field of a signed document's header, or ''.
export function docField(text, key) {
  for (const raw of String(text).split('\n')) {
    const f = raw.replace(/\r$/, '').split('\t');
    if (f[0] === key) return f[1] || '';
  }
  return '';
}
