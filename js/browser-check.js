// Says plainly when this browser is too old for the page, instead of the
// page breaking silently. A classic script in plain ES5, run before the
// page's module (tools/build_site.py puts it in <head>), so it works in
// browsers that can't even parse the module.
//
// What's checked is what the page needs (docs/test-results.md, "Browsers"):
// ES modules and modern syntax, Object.hasOwn, CompressionStream and
// DecompressionStream with deflate-raw (installers are zip/deflate),
// Blob.stream, BigInt, WebCrypto (hashes and signing; browsers only offer
// it in a secure context: https, localhost or a file opened from disk), and
// CSS :has() (the forms show and hide their parts with it). Floor found by
// tests/browsers/: Chrome and Edge 105, Firefox 121, Safari 16.4.
//
// Sets <html data-ib-missing="..."> (empty when nothing is missing), for
// the tests, and globalThis.ibMissing.
(function () {
  var missing = [];
  function need(ok, what) { if (!ok) missing.push(what); }
  function syntax(src) { try { new Function(src); return true; } catch (e) { return false; } }
  function construct(C, arg) { try { new C(arg); return true; } catch (e) { return false; } }
  var w = window;

  need('noModule' in document.createElement('script'), 'JavaScript modules');
  need(syntax('var a, b = a?.b ?? 1; a ||= b; try {} catch {}'), 'modern JavaScript syntax (?., ??, ||=)');
  need(typeof w.BigInt === 'function', 'BigInt');
  need(typeof Object.hasOwn === 'function', 'Object.hasOwn');
  need(typeof w.CompressionStream === 'function' && construct(w.CompressionStream, 'deflate-raw'), 'CompressionStream (deflate-raw)');
  need(typeof w.DecompressionStream === 'function' && construct(w.DecompressionStream, 'deflate-raw'), 'DecompressionStream (deflate-raw)');
  need(!!(w.Blob && Blob.prototype.stream), 'Blob.stream');
  // Without a secure context the browser hides WebCrypto however new it is.
  var insecure = !(w.crypto && w.crypto.subtle) && w.isSecureContext === false;
  need(!!(w.crypto && w.crypto.subtle), 'WebCrypto' + (insecure ? ' (not offered at this address)' : ''));
  var css = w.CSS && CSS.supports;
  need(!!css && CSS.supports('selector(:has(a))'), 'CSS :has()');

  w.ibMissing = missing;
  document.documentElement.setAttribute('data-ib-missing', missing.join('; '));
  if (!missing.length) return;

  function show() {
    var box = document.createElement('div');
    box.className = 'ib-too-old';
    box.setAttribute('role', 'alert');
    box.style.cssText = 'margin:12px;padding:12px 16px;border:2px solid #b3261e;border-radius:6px;' +
      'background:#fdecea;color:#410e0b;font:16px/1.4 system-ui,sans-serif';
    var h = document.createElement('strong');
    h.appendChild(document.createTextNode(insecure && missing.length === 1
      ? 'TiddlyInstall can\'t run from this address.' : 'This browser can\'t run TiddlyInstall.'));
    var p = document.createElement('p');
    p.style.margin = '6px 0 0';
    p.appendChild(document.createTextNode('It\'s missing: ' + missing.join('; ') + '. '));
    p.appendChild(document.createTextNode(insecure && missing.length === 1
      ? 'Browsers only offer WebCrypto on https, on localhost, or in a page opened from disk; this page is at ' +
        location.protocol + '//' + location.host + '. Open it from one of those, or save it and open the file.'
      : 'Please use a current Chrome, Edge or Firefox, or Safari 16.4 or later ' +
        '(the oldest that work: Chrome and Edge 105, Firefox 121). On Windows XP to 8.1, Supermium works.'));
    box.appendChild(h);
    box.appendChild(p);
    document.body.insertBefore(box, document.body.firstChild);
  }
  if (document.body) show(); else document.addEventListener('DOMContentLoaded', show);
})();
