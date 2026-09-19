// Compression for the whole page: native CompressionStream and
// DecompressionStream where the browser has them, else the plain
// JavaScript in js/inflate.js and js/deflate.js.
//
//   inflate(u8, format) -> Promise<Uint8Array>
//   deflate(u8, format) -> Promise<Uint8Array>
//     format: 'gzip' | 'deflate' (zlib) | 'deflate-raw'
//
// The native path is used when the stream classes exist, accept the format
// (Chrome 80-102 lack 'deflate-raw') and Blob streams work. If it throws,
// the plain one is tried, and the native error is reported if both fail.
// globalThis.IB_PURE_JS = true forces the plain path (for tests).
import { inflate as pureInflate, crc32, adler32 } from './inflate.js';
import { deflate as pureDeflate } from './deflate.js';

export { crc32, adler32 };

const G = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;

function nativeStream(Cls, format) {
  if (G.IB_PURE_JS || typeof G[Cls] !== 'function' || typeof Blob === 'undefined' ||
      typeof Blob.prototype.stream !== 'function' || typeof Response === 'undefined') return null;
  try { return new G[Cls](format); } catch (e) { return null; }       // format not supported
}

async function through(u8, stream) {
  const s = new Blob([u8]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function run(Cls, u8, format, pure) {
  const s = nativeStream(Cls, format);
  if (!s) return pure(u8, format);
  try {
    return await through(u8, s);
  } catch (e) {
    try { return pure(u8, format); } catch (e2) { throw e; }
  }
}

export function inflate(u8, format) { return run('DecompressionStream', u8, format, pureInflate); }
export function deflate(u8, format) { return run('CompressionStream', u8, format, pureDeflate); }

// Which path a format would take here (for tests and the diagnostics line).
export function nativeFor(format) {
  return { inflate: !!nativeStream('DecompressionStream', format), deflate: !!nativeStream('CompressionStream', format) };
}
