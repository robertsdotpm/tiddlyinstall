// The one-file site's copy for older browsers (docs/plan.md 1.11, "Older
// browsers"), checked without a browser:
//   - web/browser-check.js and web/page-loader.js parse as ES3, so IE 6-8
//     read them (acorn, ecmaVersion 3: no trailing commas, no keywords as
//     property names);
//   - the ES5 copy (#ti-js-es5: raw deflate, base64) unpacks, is ASCII
//     with no control characters (IE ends a string at a raw NUL), and parses
//     as ES5; so does its inflater (#ti-js-es5-inflate);
//   - the inflater, run as web/page-loader.js runs it with the typed-array
//     methods IE 11 lacks removed, unpacks the copy byte for byte;
//   - the ES2017 code blocks are still there for current browsers.
//
//   node tests/es5-test.mjs [dist/index.html]
//
// Real browsers: tests/browsers/ie.mjs (IE 11, Chromium 49), and
// tests/browser-check-test.mjs runs the copy in Chrome.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || path.join(REPO, 'dist/index.html');
const html = fs.readFileSync(file, 'utf8');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra ? ' -- ' + extra : '')); }
}
function parses(src, ecmaVersion) {
  try { acorn.parse(src, { ecmaVersion, sourceType: 'script', allowReserved: ecmaVersion > 3 }); return ''; } catch (e) {
    const l = src.split('\n')[e.loc.line - 1] || '';
    return e.message + ': ' + l.slice(Math.max(0, e.loc.column - 60), e.loc.column + 60);
  }
}
function block(id) {
  const m = new RegExp('<script([^>]*) id="' + id + '"([^>]*)>\\n?([\\s\\S]*?)\\n?\\s*</script>').exec(html);
  return m ? { attrs: m[1] + m[2], text: m[3] } : null;
}

// The classic scripts every browser parses.
const classic = [];
for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) classic.push(m[1]);
ok(classic.length >= 2, 'found the page\'s classic scripts (' + classic.length + ')');
const check = classic.find((s) => /FEATURES/.test(s) && /data-ti-missing/.test(s));
const loader = classic.find((s) => /ti-js-es5/.test(s) && /TI_PRISTINE/.test(s));
ok(check && !parses(check, 3), 'web/browser-check.js parses as ES3 (IE 6-8)', check ? parses(check, 3) : 'not found');
ok(loader && !parses(loader, 3), 'web/page-loader.js parses as ES3', loader ? parses(loader, 3) : 'not found');
ok(html.indexOf('<meta http-equiv="X-UA-Compatible" content="IE=edge">') > 0 && html.indexOf('X-UA-Compatible') < html.indexOf('<script'),
  'X-UA-Compatible IE=edge comes before any script');
ok(/^<!DOCTYPE html>\n<!-- saved from url=\(0014\)about:internet -->\r\n/.test(html), 'the Mark of the Web (with CRLF) follows the doctype');

// The ES2017 code, for current browsers.
for (const id of ['ti-js-resedit', 'ti-js']) {
  const b = block(id);
  ok(b && /type="text\/x-ti-js"/.test(b.attrs) && b.text.length > 1000, `#${id} is a code block`);
}

// The ES5 copy.
const es5 = block('ti-js-es5');
const inf = block('ti-js-es5-inflate');
ok(es5 && inf, 'the page carries the ES5 copy and its inflater');
if (es5 && inf) {
  const packed = Buffer.from(es5.text.replace(/\s+/g, ''), 'base64');
  const code = zlib.inflateRawSync(packed);
  ok(code.length > 500000, `the ES5 copy unpacks (${packed.length} bytes to ${code.length})`);
  const bad = code.findIndex((c) => c > 0x7e || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d));
  ok(bad < 0, 'the ES5 copy is ASCII, with no control characters', bad >= 0 ? 'byte ' + code[bad] + ' at ' + bad : '');
  const text = code.toString('latin1');
  const e1 = parses(text, 5);
  ok(!e1, 'the ES5 copy parses as ES5', e1);
  ok(/legacy-dom|msSaveOrOpenBlob/.test(text) && /__ti_router/.test(text), 'it holds web/legacy-dom.js and the page');
  const e2 = parses(inf.text, 5);
  ok(!e2, 'its inflater parses as ES5', e2);

  // Unpack as the loader does, with IE 11's typed arrays (no fill or
  // copyWithin until the inflater's own stand-ins).
  const P = Object.getPrototypeOf(Uint8Array.prototype);
  const ctx = { Uint8Array, Uint16Array, Int32Array, Uint32Array, Int8Array, Int16Array, Math, Object, Error, TypeError, RangeError, Array, String, Map, Reflect, Symbol, Function };
  const saved = { fill: P.fill, copyWithin: P.copyWithin };
  delete P.fill; delete P.copyWithin;
  let out = null, err = '';
  try {
    vm.createContext(ctx);
    vm.runInContext(inf.text, ctx);
    out = ctx.__ti_inflate.inflate(new Uint8Array(packed), 'deflate-raw');
  } catch (e) { err = e.stack || String(e); } finally {
    Object.defineProperty(P, 'fill', { value: saved.fill, configurable: true, writable: true });
    Object.defineProperty(P, 'copyWithin', { value: saved.copyWithin, configurable: true, writable: true });
  }
  ok(out && Buffer.from(out).equals(code), 'the ES5 inflater unpacks the copy byte for byte (without fill/copyWithin)', err.slice(0, 400));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
