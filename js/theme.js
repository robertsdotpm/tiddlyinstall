// Light or dark, and the button in the header that switches it.
//
// With nothing chosen the page follows the system (css/style.css,
// "prefers-color-scheme"); the button writes <html data-theme="light|dark">,
// which the stylesheet's :not([data-theme="light"]) and [data-theme="dark"]
// rules pick up, and remembers it in this browser. ?theme=dark on the URL
// sets it for one visit, for screenshots and the test rigs.
//
// A classic script in plain ES3, in <head> (tools/build_site.py inlines it
// there for the one-file site, beside js/browser-check.js): it must run
// before the first paint so a chosen theme doesn't flash, and it must parse
// in the browsers that can't read the page's modules, which still get the
// header and the button. The attribute goes on before js/page-loader.js
// takes IB_PRISTINE, so "Save this page" keeps the theme you were reading in.
(function () {
  var KEY = 'ib-theme';
  var h = document.documentElement;

  function sysDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch (e) { return false; }
  }
  function now() {
    var set = h.getAttribute('data-theme');
    return set ? set === 'dark' : sysDark();
  }
  function paint() {
    var b = document.getElementById('theme-btn');
    if (!b) return;
    var dark = now();
    // The button says what it will do, not what is on. innerHTML with a
    // literal, since IE 8 has no textContent.
    b.innerHTML = dark ? 'Light' : 'Dark';
    b.setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
  }

  var q = /[?&]theme=(dark|light)/.exec(location.search);
  if (q) h.setAttribute('data-theme', q[1]);
  else {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
    if (saved === 'dark' || saved === 'light') h.setAttribute('data-theme', saved);
  }

  function wire() {
    var b = document.getElementById('theme-btn');
    paint();
    if (!b || b.getAttribute('data-wired')) return;
    b.setAttribute('data-wired', '1');
    b.onclick = function () {
      var next = now() ? 'light' : 'dark';
      h.setAttribute('data-theme', next);
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
      paint();
    };
  }

  if (document.readyState === 'loading') {
    if (document.addEventListener) document.addEventListener('DOMContentLoaded', wire, false);
    else if (document.attachEvent) document.attachEvent('onreadystatechange', function () { if (document.readyState !== 'loading') wire(); });
  } else wire();
}());
