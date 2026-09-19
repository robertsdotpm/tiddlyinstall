// For the Chrome page tests: makes Chrome look like an older browser, so the
// page takes its plain-JavaScript and shim paths. Before any page script runs
// (CDP Page.addScriptToEvaluateOnNewDocument), it removes DecompressionStream,
// CompressionStream, crypto.subtle and BigInt, and makes CSS.supports say
// there is no :has().
//
//   import { noNativeArg, disableNative, nativeState } from './no-native-browser.mjs';
//   if (noNativeArg) await disableNative(cdp);   // before navigating
//
// Tests take --no-native to run this way.

export const noNativeArg = process.argv.includes('--no-native');

export const NO_NATIVE_SOURCE = `(function () {
  try { delete window.DecompressionStream; delete window.CompressionStream; } catch (e) {}
  try { Object.defineProperty(window.crypto, 'subtle', { get: function () { return undefined; }, configurable: true }); } catch (e) {}
  try { delete window.BigInt; } catch (e) {}
  if (window.CSS && CSS.supports) {
    var supports = CSS.supports.bind(CSS);
    CSS.supports = function (a, b) {
      if (arguments.length === 1) return /:has\\(/.test(a) ? false : supports(a);
      return supports(a, b);
    };
  }
  window.IB_TEST_NO_NATIVE = true;
})();`;

// cdp: (method, params) => Promise, as tests/browsers/cdp.mjs gives.
export async function disableNative(cdp) {
  await cdp('Page.enable', {});
  return cdp('Page.addScriptToEvaluateOnNewDocument', { source: NO_NATIVE_SOURCE });
}

// An expression for js(): what the page sees and which paths it took.
export const nativeState = `JSON.stringify({
  noNative: !!window.IB_TEST_NO_NATIVE,
  subtle: !!(window.crypto && crypto.subtle),
  decompress: typeof DecompressionStream !== 'undefined',
  bigint: typeof BigInt !== 'undefined',
  hasShim: !!document.querySelector('style[data-ib-has-shim]'),
})`;

// Checks with a test's ok(): in --no-native mode the natives are gone and the
// :has() stand-in is running; otherwise the page is untouched.
export async function checkNativeState(ok, js) {
  const s = JSON.parse(await js(nativeState));
  if (noNativeArg) {
    ok(s.noNative && !s.subtle && !s.decompress && !s.bigint && s.hasShim,
      'no-native mode: crypto.subtle, DecompressionStream and BigInt are gone and the :has() stand-in runs', JSON.stringify(s));
  } else {
    ok(!s.hasShim, 'native mode: the :has() stand-in stays off (the browser has :has())', JSON.stringify(s));
  }
}

// The :has() rules at work, in either mode: choosing things in the New
// installer form, by click and from script, shows and hides what the CSS
// says. (In --no-native mode this is the stand-in in js/has-shim.js.)
export async function checkHasRules(ok, js) {
  const disp = (sel) => js(`getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display`);
  const mode = noNativeArg ? 'stand-in' : 'native :has()';
  const tick = () => js('new Promise((r) => setTimeout(r, 50))');
  await js(`document.getElementById('src-write').click()`);
  await tick();
  ok(await disp('.src-write-only') === 'block', mode + ': clicking "Write the code here" shows the editor block');
  await js(`document.getElementById('tpl-script').checked = true`);
  await tick();
  ok(await disp('.tpl-script-only') === 'block', mode + ': a template chosen from script shows its part');
  await js(`document.getElementById('tpl-web').click()`);
  await tick();
  ok(await disp('.tpl-script-only') === 'none', mode + ': choosing another template hides the first one\'s part');
  const pick = (v) => js(`(function () { const s = document.getElementById('runtime'); s.value = '${v}'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await pick('node');
  await tick();
  ok(await disp('.entry-node') === 'block' && await disp('.entry-python') === 'none', mode + ': choosing Node.js shows its entry notes, not Python\'s');
  await pick('python2');
  await tick();
  ok(await disp('.entry-python') === 'block' && await disp('.entry-node') === 'none', mode + ': Python 2 matches the :is() rule for Python');
}
