// Runs a Node test as a browser without the modern features would: no
// CompressionStream/DecompressionStream, no crypto.subtle, no BigInt. The
// page's code must then take its plain-JavaScript paths (js/zlib.js,
// js/cryptox.js), and anything still calling the native API fails loudly.
//
//   node --import ./tests/no-native.mjs tests/sign-test.mjs
//
// crypto.getRandomValues stays: every browser the page supports has it.
globalThis.IB_PURE_JS = true;
globalThis.IB_NO_NATIVE = true;
delete globalThis.CompressionStream;
delete globalThis.DecompressionStream;
Object.defineProperty(globalThis.crypto, 'subtle', { get() { return undefined; }, configurable: true });
delete globalThis.BigInt;
if (typeof BigInt !== 'undefined' || globalThis.crypto.subtle || typeof DecompressionStream !== 'undefined') {
  throw new Error('no-native.mjs: could not remove the native features');
}
console.log('(no-native: CompressionStream, DecompressionStream, crypto.subtle and BigInt removed)');
