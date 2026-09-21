// The one-file site's ES5 copy, for browsers that can't parse its ES2017
// script (Internet Explorer 10 and 11, Chrome 49 on Windows XP; docs/plan.md 1.11,
// "Older browsers"). Called by tools/build_site.py; build-time only: Babel and
// core-js live in tools/es5/node_modules (npm install there) and only their
// output goes into the page.
//
//   node tools/es5/build-es5.mjs --out OUT.js [--inflate IN.js --inflate-out OUT.js] SCRIPT.js...
//
// SCRIPTs are classic scripts, run in order (the resedit bundle, then the
// page's joined modules). Babel's preset-env rewrites their syntax to ES5 for
// the targets below, async functions through its inlined regenerator; the
// built-ins the code uses (Babel's "usage" analysis: Promise, Map, Symbol,
// iterators, typed-array methods, ...) come from core-js, built by
// core-js-builder for the same targets with only those modules. Then
// src/web_client/legacy-dom.js, the DOM and platform pieces core-js doesn't cover.
// Output: core-js polyfills, legacy-dom.js, the scripts.
//
// --inflate: src/web_client/lib/inflate.js already joined as a classic script by
// build_site.py; written out as ES5 on its own, so the loader can unpack the
// compressed ES5 copy with it before anything else of that copy runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import babel from '@babel/core';
import presetEnv from '@babel/preset-env';
import builder from 'core-js-builder';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
// IE 10 too since the catalogue unpacks a folder at a time (2026-09-19):
// core-js adds what it lacks (Map, Set, WeakMap, Uint8ClampedArray, ...) and
// src/web_client/legacy-dom.js its dataset. Before that its IE 10 mode took 137 s to
// start and ran out of memory building (docs/plan.md 1.11).
export const TARGETS = { ie: '10', chrome: '49' };

const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(k); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = opt('--out');
const inflateIn = opt('--inflate');
const inflateOut = opt('--inflate-out');
if (!out || !argv.length) { console.error('usage: build-es5.mjs --out OUT.js SCRIPT.js...'); process.exit(2); }

const COREJS = JSON.parse(fs.readFileSync(path.join(HERE, 'node_modules', 'core-js', 'package.json'), 'utf8')).version;

function transform(code, usage) {
  const r = babel.transformSync(code, {
    babelrc: false, configFile: false, sourceType: 'script', compact: true, comments: false,
    // Babel's helpers are inlined once at the top of each program.
    presets: [[presetEnv, {
      targets: TARGETS, bugfixes: true, modules: false,
      ...(usage ? { useBuiltIns: 'usage', corejs: COREJS } : {}),
    }]],
  });
  return r.code;
}

// "usage" puts require("core-js/modules/NAME.js") (sourceType script) or
// import "core-js/modules/NAME.js" lines in; they name the polyfills needed.
const REQ = /(?:require\(|import\s*)"core-js\/modules\/([\w.-]+?)(?:\.js)?"\)?;?/g;
const modules = new Set();
const parts = [];
for (const f of argv) {
  const code = transform(fs.readFileSync(f, 'utf8'), true);
  parts.push(code.replace(REQ, (_, m) => { modules.add(m); return ''; }));
}
// The legacy DOM pieces use some built-ins themselves.
const legacyDom = fs.readFileSync(path.join(REPO, 'src', 'web_client', 'legacy-dom.js'), 'utf8');
const legacyEs5 = transform(legacyDom, true).replace(REQ, (_, m) => { modules.add(m); return ''; });

// Every module the code uses, for the targets (the builder drops those the
// targets all have), in core-js's own order.
const polyfills = await builder({ modules: [...modules], targets: TARGETS, format: 'bundle', minify: true, summary: { console: { size: false, modules: false } } });

const js = polyfills + '\n' + legacyEs5 + '\n' + parts.join('\n;\n') + '\n';
fs.writeFileSync(out, js);
console.log(`es5: ${modules.size} core-js modules (${(polyfills.length / 1024).toFixed(0)} KB), code ${(js.length / 1024).toFixed(0)} KB`);

if (inflateIn) {
  // Only syntax: inflate.js uses no built-in IE 11 and Chrome 49 lack
  // (checked by tests/es5-test.mjs, which runs it with those removed).
  const code = transform(fs.readFileSync(inflateIn, 'utf8'), false);
  fs.writeFileSync(inflateOut, code + '\n');
}
