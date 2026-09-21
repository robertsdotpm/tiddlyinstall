// The one-file site's scripts must run in the page's oldest browsers
// (docs/plan.md 1.11: Firefox 52 ESR, Chrome 58+, Safari 12, EdgeHTML 18).
// This parses every script in dist/index.html as an ES2017 classic script
// (acorn, ecmaVersion 2017, which also rejects newer regular expression
// syntax) and fails on anything newer. It also looks for built-ins newer
// than that floor which web/polyfills.js does not add, and -- since it
// already has the built page split into markup and scripts -- for em and
// en dashes, which the operator does not want and which have now been
// removed three times.
//
//   node tests/es2017-test.mjs [dist/index.html]
//
// acorn is a dev-only dependency (tests/package.json); the page has none.
import fs from 'node:fs';
import path from 'node:path';
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

// Executable scripts: no type, or a JavaScript type, and the page's code
// blocks (type text/x-ti-js, run by web/page-loader.js). Data blocks are
// skipped, and so is the ES5 copy (tests/es5-test.mjs checks it).
const scripts = [];
const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
for (let m; (m = re.exec(html));) {
  const attrs = m[1] || '';
  const type = (/\btype="([^"]*)"/.exec(attrs) || [])[1];
  if (type === 'module') { scripts.push({ attrs, src: m[2], module: true }); continue; }
  if (type && !/javascript|ecmascript|^text\/x-ti-js$/i.test(type)) continue;
  if (/\bsrc=/.test(attrs)) continue;
  scripts.push({ attrs, src: m[2], line: html.slice(0, m.index).split('\n').length });
}
ok(scripts.length >= 3, 'found the page\'s scripts (' + scripts.length + ')');
ok(!scripts.some((s) => s.module), 'no <script type="module"> (Firefox 52 has no modules)');

const lineOf = (s, pos) => s.slice(0, pos).split('\n').length;
for (const s of scripts) {
  const label = 'script at line ' + s.line + ' (' + (s.src.length / 1024).toFixed(0) + ' KB)';
  try {
    acorn.parse(s.src, { ecmaVersion: 2017, sourceType: 'script' });
    ok(true, label + ' parses as ES2017');
  } catch (e) {
    const l = s.src.split('\n')[e.loc.line - 1] || '';
    ok(false, label + ' parses as ES2017', e.message + ': ' + l.trim().slice(Math.max(0, e.loc.column - 60), e.loc.column + 60));
  }
}

// Built-ins newer than the floor. Polyfilled ones (web/polyfills.js) are
// fine; so is anything behind a feature test, listed in ALLOWED.
const NEW_METHODS = ['replaceAll', 'findLast', 'findLastIndex', 'allSettled', 'structuredClone', 'randomUUID', 'showPicker',
  'toSorted', 'toReversed', 'toSpliced', 'groupBy', 'trimStart', 'trimEnd', 'at', 'hasIndices', 'withResolvers', 'transferToImageBitmap'];
const NEW_GLOBALS = ['BigInt', 'WeakRef', 'FinalizationRegistry', 'AggregateError', 'structuredClone', 'queueMicrotask', 'BigInt64Array', 'BigUint64Array'];
// [global or method, where it may appear]: feature-tested uses.
const ALLOWED = [
  ['BigInt', 'resedit'],                 // pe-library, only for PE32+ 64-bit fields, behind typeof BigInt checks
  ['BigUint64Array', 'resedit'],
];
const main = scripts.reduce((a, b) => (b.src.length > a.src.length ? b : a));
const vendor = scripts.find((s) => /__TI_RESEDIT/.test(s.src) && s !== main);
const found = [];
for (const [name, s] of [['main', main], ['resedit', vendor]]) {
  if (!s) continue;
  const ast = acorn.parse(s.src, { ecmaVersion: 'latest', sourceType: 'script' });
  (function walk(n, parent) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'MemberExpression' && !n.computed && NEW_METHODS.includes(n.property.name) &&
        parent && parent.type === 'CallExpression' && parent.callee === n) {
      found.push([n.property.name, name, lineOf(s.src, n.start)]);
    }
    if (n.type === 'Identifier' && NEW_GLOBALS.includes(n.name) &&
        !(parent && parent.type === 'MemberExpression' && parent.property === n && !parent.computed) &&
        !(parent && parent.type === 'Property' && parent.key === n)) {
      found.push([n.name, name, lineOf(s.src, n.start)]);
    }
    for (const k in n) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((x) => walk(x, n)); else if (v && typeof v.type === 'string') walk(v, n);
    }
  })(ast, null);
}
const bad = found.filter(([what, where]) => !ALLOWED.some(([w, s]) => w === what && s === where));
ok(!bad.length, 'no built-ins newer than the floor outside feature tests and web/polyfills.js',
  bad.slice(0, 20).map(([w, s, l]) => w + ' (' + s + ' line ' + l + ')').join(', '));

/* ---------- em and en dashes ---------- */

// The operator does not want them on the page, and they have been removed
// three times: first the literal characters, then the &mdash; entities a
// grep for the characters never saw. So this looks for every spelling of
// both, on the built page rather than in the sources, which is the one
// place they all end up whichever way they were written.
//
// The markup is the page with its <script> elements taken out: the data
// blocks are the runtime catalogue and the base installers, and what is
// in those is not ours to rewrite. The executable scripts are checked
// too, since a dash in a string (web/sign-ui.js had one) reaches the page
// just the same.
const DASHES = [
  ['\u2014', 'em dash'], ['\u2013', 'en dash'],
  ['&mdash;', '&mdash;'], ['&ndash;', '&ndash;'],
  ['&#8212;', '&#8212;'], ['&#8211;', '&#8211;'],
  ['&#x2014;', '&#x2014;'], ['&#x2013;', '&#x2013;'],
  ['&#X2014;', '&#X2014;'], ['&#X2013;', '&#X2013;']
];
function dashesIn(where, text) {
  const out = [];
  for (const [needle, name] of DASHES) {
    for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
      out.push(where + ' ' + name + ': ...' + text.slice(Math.max(0, i - 45), i + needle.length + 25).replace(/\s+/g, ' ') + '...');
    }
  }
  return out;
}
const markup = html.replace(/<script(\s[^>]*)?>[\s\S]*?<\/script>/gi, '');
const dashes = dashesIn('markup', markup);
for (const s of scripts) dashes.push(...dashesIn('script at line ' + s.line, s.src));
ok(!dashes.length, 'no em or en dashes on the page, in any spelling (write a plain "-")',
  dashes.slice(0, 8).join('\n      ') + (dashes.length > 8 ? '\n      ... and ' + (dashes.length - 8) + ' more' : ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
