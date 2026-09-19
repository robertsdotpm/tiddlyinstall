// Starts the one-file page's code (tools/build_site.py puts this last in
// <body>, after the data blocks). Plain ES3, like js/browser-check.js, so
// that every browser parses it and none meets a syntax error.
//
// The page's code is in data blocks, not scripts, so a browser that can't
// parse it never tries:
//   #ib-js-resedit, #ib-js   the resedit bundle and the page (ES2017)
//   #ib-js-es5               both as ES5, with polyfills, raw-deflated and
//                            base64'd (tools/es5/build-es5.mjs; may be absent)
//   #ib-js-es5-inflate       js/inflate.js as ES5, to unpack it
// A browser that parses ES2017 runs the first two (every current browser;
// the same probe as browser-check.js). One that doesn't but can run the ES5
// copy (browser-check.js decides: window.IB_ES5_OK, IE 11 and Chrome 49)
// runs that. Anything older runs nothing, and browser-check.js's bar says
// what to use instead; the page's static text still reads.
(function () {
  var w = window, d = document;
  function block(id) { var e = d.getElementById(id); return e ? e.text : null; }
  function run(code) {
    var s = d.createElement('script');
    s.text = code;
    d.body.appendChild(s);
    d.body.removeChild(s);
  }
  var modern = false;
  try { new Function('async function f(a, ...b) { for (const c of a) await c; return class {}; }'); modern = true; } catch (e) { modern = false; }
  var es5 = modern ? null : block('ib-js-es5');
  if (!modern && !(es5 && w.IB_ES5_OK === true)) return;

  // The page exactly as loaded, for "Save this page", before any script
  // changes it (the Mark of the Web lets IE run a copy opened from disk).
  w.IB_PRISTINE = '<!DOCTYPE html>\n<!-- saved from url=(0014)about:internet -->\r\n' + d.documentElement.outerHTML;
  w.IB_ES5 = !modern;
  if (modern) {
    run(block('ib-js-resedit'));
    run(block('ib-js'));
    return;
  }
  // Unpack the ES5 copy: base64, raw deflate, ASCII text.
  run(block('ib-js-es5-inflate'));
  var bin = w.atob(es5.replace(/\s+/g, ''));
  var u8 = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  var out = w.__ib_inflate.inflate(u8, 'deflate-raw'), parts = [];
  for (var j = 0; j < out.length; j += 0x8000) parts.push(String.fromCharCode.apply(null, out.subarray(j, j + 0x8000)));
  run(parts.join(''));
})();
