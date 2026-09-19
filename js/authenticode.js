// Authenticode signing of a PE file in the browser (docs/browser-signing.md).
//
//   beginPE(file)            strip any old signature, pad to 8, hash; build the
//                            content and the signed attributes -> digest D
//   <signer signs D>         WebCrypto with a .pfx key, or any remote service
//   finishPE(state, sig, certs, {timestamp})
//                            SignedData + optional RFC 3161 timestamp, written
//                            as the certificate table; checksum fixed
//
// signPE() does all three with a signer {sign({data, digest}) -> bytes, certs}.
import * as der from './der.js';
import { peInfo, peChecksum } from './ibfile.js';
import { verifyWith, orderChain, ecdsaRawToDer, curveBytes, nameString } from './x509.js';
import * as X from './cryptox.js';

export const OID = {
  signedData: '1.2.840.113549.1.7.2',
  spcIndirectData: '1.3.6.1.4.1.311.2.1.4',
  spcPeImageData: '1.3.6.1.4.1.311.2.1.15',
  spcSpOpusInfo: '1.3.6.1.4.1.311.2.1.12',
  spcStatementType: '1.3.6.1.4.1.311.2.1.11',
  individualCodeSigning: '1.3.6.1.4.1.311.2.1.21',
  rfc3161Countersign: '1.3.6.1.4.1.311.3.3.1',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
};

const sha256 = (b) => X.digest('SHA-256', b);

export class SignError extends Error {}

// The file without its signature, padded to 8 bytes, with directory 4
// cleared: the bytes the new signature goes after. Returns {bytes, pe, hadSignature}.
export function unsignedPE(u8) {
  const pe = peInfo(u8);
  if (!pe) throw new SignError('This is not a Windows program (no PE header).');
  if (pe.certDirOff == null) throw new SignError('This PE file has no certificate directory entry.');
  let end = u8.length;
  const hadSignature = !!(pe.certOffset && pe.certSize);
  if (hadSignature) {
    if (pe.certOffset + pe.certSize !== u8.length) {
      throw new SignError('The existing signature is not at the end of the file, so it can\'t be replaced safely.');
    }
    end = pe.certOffset;
  }
  const padded = (end + 7) & ~7;
  const out = new Uint8Array(padded);
  out.set(u8.subarray(0, end));
  out.fill(0, pe.certDirOff, pe.certDirOff + 8);        // directory 4: offset and size
  return { bytes: out, pe, hadSignature };
}

// The Authenticode hash: everything but the checksum, directory 4 and the
// certificate table (the file here has none), in file order.
export async function peHash(unsigned, pe) {
  const c = pe.checksumOff, d = pe.certDirOff;
  const n = unsigned.length;
  const buf = new Uint8Array(n - 12);
  buf.set(unsigned.subarray(0, c), 0);
  buf.set(unsigned.subarray(c + 4, d), c);
  buf.set(unsigned.subarray(d + 8), d - 4);
  return sha256(buf);
}

export function spcIndirectDataContent(hash) {
  const obsolete = der.ctx(0, der.ctx(2, der.ctxPrim(0, der.bmpBytes('<<<Obsolete>>>'))));
  return der.seq(
    der.seq(der.oid(OID.spcPeImageData), der.seq(der.bits(new Uint8Array(0)), obsolete)),
    der.seq(der.algId(OID.sha256), der.octets(hash)),
  );
}

const attr = (o, ...values) => der.seq(der.oid(o), der.setOf(values));

// SpcSpOpusInfo: optional program name (shown by UAC) and a URL.
function opusInfo(name, url) {
  const parts = [];
  if (name) parts.push(der.ctx(0, der.ctxPrim(0, der.bmpBytes(name))));
  if (url) parts.push(der.ctx(1, der.ctxPrim(0, new TextEncoder().encode(url))));
  return der.seq(...parts);
}

// Step 1. opts: {programName, url, signingTime (Date, or false for none)}.
// Returns the state finishPE needs; state.digest is what a service signs,
// state.toBeSigned is what a WebCrypto key signs (it hashes it itself).
export async function beginPE(u8, opts = {}) {
  const { bytes, pe, hadSignature } = unsignedPE(u8);
  const hash = await peHash(bytes, pe);
  const content = spcIndirectDataContent(hash);
  // The Authenticode quirk: the digest covers the content without its
  // outer SEQUENCE tag and length.
  const cn = der.decode(content);
  const md = await sha256(cn.value);
  const attrs = [
    attr(OID.contentType, der.oid(OID.spcIndirectData)),
    attr(OID.spcStatementType, der.seq(der.oid(OID.individualCodeSigning))),
    attr(OID.spcSpOpusInfo, opusInfo(opts.programName, opts.url)),
    attr(OID.messageDigest, der.octets(md)),
  ];
  if (opts.signingTime !== false) attrs.push(attr(OID.signingTime, der.time(opts.signingTime || new Date())));
  const toBeSigned = der.setOf(attrs);
  return { unsigned: bytes, pe, hadSignature, hash, content, toBeSigned, digest: await sha256(toBeSigned) };
}

/* ---------- RFC 3161 ---------- */

export async function timestampRequest(signature) {
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  nonce[0] &= 0x7f;
  const imprint = await sha256(signature);
  const req = der.seq(
    der.int(1),
    der.seq(der.algId(OID.sha256), der.octets(imprint)),
    der.int(nonce),
    der.bool(true),
  );
  return { req, nonce, imprint };
}

const PKI_STATUS = ['granted', 'grantedWithMods', 'rejection', 'waiting', 'revocationWarning', 'revocationNotification'];

// Checks a TimeStampResp against the request. Returns {token (ContentInfo
// DER), genTime, tsa}.
export function parseTimestampResponse(resp, { nonce, imprint }) {
  let r;
  try { r = der.decode(resp); } catch (e) { throw new SignError('The timestamp server sent something that is not a timestamp response.'); }
  const status = Number(der.readInt(r.kid(0).kid(0)));
  if (status > 1) {
    let why = PKI_STATUS[status] || 'status ' + status;
    const text = r.kid(0).kids[1];
    if (text && text.tag === 0x30 && text.kids[0]) why += ': ' + der.readStr(text.kids[0]).slice(0, 200);
    throw new SignError('The timestamp server refused: ' + why);
  }
  const token = r.kids[1];
  if (!token) throw new SignError('The timestamp response has no token.');
  const sd = token.kid(1).kid(0);
  const eci = sd.kids.find((k) => k.tag === 0x30 && k.kids[0] && k.kids[0].tag === 0x06);
  if (!eci || der.readOid(eci.kid(0)) !== OID.tstInfo) throw new SignError('The timestamp token has no TSTInfo.');
  const tst = der.decode(der.readOctets(eci.kid(1).kid(0)));
  const mi = tst.kid(2);
  if (der.readOid(mi.kid(0).kid(0)) !== OID.sha256 || !der.eqBytes(der.readOctets(mi.kid(1)), imprint)) {
    throw new SignError('The timestamp is for a different signature.');
  }
  const genTime = der.readTime(tst.kid(4));
  const rest = tst.kids.slice(5);
  const n = rest.find((k) => k.tag === 0x02);
  if (nonce && (!n || !der.eqBytes(der.readUint(n), der.readUint(der.decode(der.int(nonce)))))) {
    throw new SignError('The timestamp response does not match the request (nonce).');
  }
  // The TSA's own name, from its signer certificate if present.
  let tsa = '';
  const tsaName = rest.find((k) => k.cls === 2 && k.num === 0);
  const gn = tsaName && tsaName.kids[0];
  if (gn && gn.cls === 2 && gn.num === 4) {
    try {
      const name = nameString(gn.kid(0));
      tsa = (/(?:^|, )CN=([^,]+)/.exec(name) || /(?:^|, )O=([^,]+)/.exec(name) || [0, name])[1];
    } catch (e) { /* leave it blank */ }
  }
  return { token: token.raw.slice(), genTime, tsa };
}

// timestamp: async (TimeStampReq DER) -> TimeStampResp DER.
export async function rfc3161Attribute(signature, timestamp) {
  const q = await timestampRequest(signature);
  const resp = await timestamp(q.req);
  const t = parseTimestampResponse(resp, q);
  return { attr: attr(OID.rfc3161Countersign, t.token), genTime: t.genTime, tsa: t.tsa };
}

/* ---------- assembly ---------- */

// Step 3. sig: the signature over state.toBeSigned (RSA PKCS#1 v1.5, or
// ECDSA as DER or r||s). certs: parsed certificates (x509.parseCert); the
// one the signature verifies with is the signer. opts.timestamp: optional
// async (req) -> resp. Returns {file, signer, timestamp}.
export async function finishPE(state, sig, certs, opts = {}) {
  let signer = null;
  for (const c of certs) {
    if (await verifyWith(c, state.toBeSigned, sig)) { signer = c; break; }
  }
  if (!signer) throw new SignError('The signature does not verify with any of the certificates given. Check that the signature is for this digest and that the certificate belongs to the key.');
  const chain = orderChain(signer, certs);

  let sigAlg, sigValue = sig;
  if (signer.keyType === 'rsa') sigAlg = der.algId(OID.rsaEncryption);
  else {
    sigAlg = der.algId(OID.ecdsaSha256, null);
    // r||s is exactly twice the curve size; DER never is.
    if (sig.length === 2 * curveBytes(signer.curve)) sigValue = ecdsaRawToDer(sig);
  }

  let ts = null;
  const unsigned = [];
  if (opts.timestamp) {
    ts = await rfc3161Attribute(sigValue, opts.timestamp);
    unsigned.push(ts.attr);
  }

  const signerInfo = der.seq(
    der.int(1),
    der.seq(signer.issuerRaw, signer.serialRaw),
    der.algId(OID.sha256),
    der.retag(state.toBeSigned, 0xa0),
    sigAlg,
    der.octets(sigValue),
    ...(unsigned.length ? [der.retag(der.setOf(unsigned), 0xa1)] : []),
  );
  const signedData = der.seq(
    der.int(1),
    der.set(der.algId(OID.sha256)),
    der.seq(der.oid(OID.spcIndirectData), der.ctx(0, state.content)),
    der.ctx(0, ...chain.map((c) => c.der)),
    der.set(signerInfo),
  );
  const pkcs7 = der.seq(der.oid(OID.signedData), der.ctx(0, signedData));

  const pad = (8 - (pkcs7.length % 8)) % 8;
  const tableLen = 8 + pkcs7.length + pad;
  const base = state.unsigned;
  const out = new Uint8Array(base.length + tableLen);
  out.set(base);
  const dv = new DataView(out.buffer);
  dv.setUint32(base.length, tableLen, true);          // dwLength
  dv.setUint16(base.length + 4, 0x0200, true);        // WIN_CERT_REVISION_2_0
  dv.setUint16(base.length + 6, 0x0002, true);        // WIN_CERT_TYPE_PKCS_SIGNED_DATA
  out.set(pkcs7, base.length + 8);
  dv.setUint32(state.pe.certDirOff, base.length, true);
  dv.setUint32(state.pe.certDirOff + 4, tableLen, true);
  dv.setUint32(state.pe.checksumOff, peChecksum(out, state.pe.checksumOff), true);
  return { file: out, signer, chain, timestamp: ts && { genTime: ts.genTime, tsa: ts.tsa } };
}

// A signer for a key loaded from a .pfx (pkcs12.openPfx's result).
export function pfxSigner(p) {
  return {
    certs: p.chain,
    async sign({ data }) {
      const s = await X.sign(p.key, data);
      return p.algorithm.name === 'ECDSA' ? ecdsaRawToDer(s) : s;
    },
  };
}

// A signer for any service that signs a SHA-256 digest (a cloud KMS, an
// HSM, a signing service's sign-hash call, or a person pasting the result
// back): signDigest(digest) returns the signature, RSA PKCS#1 v1.5 or
// ECDSA (DER or r||s). certs: the certificate chain, parsed.
export function digestSigner(certs, signDigest) {
  return { certs, sign: ({ digest }) => signDigest(digest) };
}

// All three steps with one signer {certs, sign({data, digest})}.
export async function signPE(u8, signer, opts = {}) {
  const state = await beginPE(u8, opts);
  const sig = await signer.sign({ data: state.toBeSigned, digest: state.digest });
  return finishPE(state, sig, signer.certs, opts);
}

/* ---------- reading a signature back (for display and tests) ---------- */

// {signed, signer (subject), digest (hex, the PE hash in the signature),
//  timestamped} or {signed: false}.
export function describeSignature(u8) {
  const pe = peInfo(u8);
  if (!pe || !pe.certOffset || !pe.certSize) return { signed: false };
  const t = u8.subarray(pe.certOffset + 8, pe.certOffset + pe.certSize);
  const ci = der.parse(t, 0, t.length);
  const sd = ci.kid(1).kid(0);
  const content = sd.kid(2).kid(1).kid(0);
  const digest = der.hex(der.readOctets(content.kid(1).kid(1)));
  const si = sd.kids[sd.kids.length - 1].kid(0);
  const ua = si.ctx(1);
  const timestamped = !!(ua && ua.kids.some((a) => der.readOid(a.kid(0)) === OID.rfc3161Countersign));
  return { signed: true, digest, timestamped, pkcs7Length: ci.end };
}
