// Compression for the whole page: native CompressionStream and
// DecompressionStream where the browser has them, else the plain
// JavaScript in src/web_client/lib/inflate.js and src/web_client/lib/deflate.js.
//
//   inflate(u8, format) -> Promise<Uint8Array>
//   deflate(u8, format) -> Promise<Uint8Array>
//     format: 'gzip' | 'deflate' (zlib) | 'deflate-raw'
//
// The native path is used when the stream classes exist, accept the format
// (Chrome 80-102 lack 'deflate-raw') and Blob streams work. If it throws,
// the plain one is tried, and the native error is reported if both fail.
// globalThis.TI_PURE_JS = true forces the plain path (for tests).
import { inflate as pureInflate, crc32, adler32 } from './inflate.js';
import { deflate as pureDeflate } from './deflate.js';

export { crc32, adler32 };

const G = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;

function nativeStream(Cls, format) {
  if (G.TI_PURE_JS || typeof G[Cls] !== 'function' || typeof Blob === 'undefined' ||
      typeof Blob.prototype.stream !== 'function' || typeof Response === 'undefined') return null;
  try { return new G[Cls](format); } catch (e) { return null; }       // format not supported
}

// Response.arrayBuffer() would buffer the whole stream before anyone
// could object to its size, so with a ceiling we read it ourselves and
// stop at the first chunk that crosses it. Deflate reaches 1032:1, so a
// megabyte of attacker-chosen input is a gigabyte of memory in the
// process that accepted it.
async function through(u8, stream, maxOut) {
  const s = new Blob([u8]).stream().pipeThrough(stream);
  if (!(maxOut > 0)) return new Uint8Array(await new Response(s).arrayBuffer());
  const rd = s.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    n += value.length;
    if (n > maxOut) {
      try { await rd.cancel(); } catch (e) { /* already gone */ }
      throw new Error('inflate: the compressed data expands past the limit this caller allowed');
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function run(Cls, u8, format, pure, maxOut) {
  const s = nativeStream(Cls, format);
  if (!s) return pure(u8, format, 0, maxOut);
  try {
    return await through(u8, s, maxOut);
  } catch (e) {
    // A refusal is the answer, not a reason to try the other path: the
    // pure one would spend the same memory reaching the same verdict.
    if (/expands past the limit/.test(String(e && e.message))) throw e;
    try { return pure(u8, format, 0, maxOut); } catch (e2) { throw e; }
  }
}

export function inflate(u8, format, maxOut) { return run('DecompressionStream', u8, format, pureInflate, maxOut); }
export function deflate(u8, format) { return run('CompressionStream', u8, format, pureDeflate); }

// Which path a format would take here (for tests and the diagnostics line).
export function nativeFor(format) {
  return { inflate: !!nativeStream('DecompressionStream', format), deflate: !!nativeStream('CompressionStream', format) };
}
