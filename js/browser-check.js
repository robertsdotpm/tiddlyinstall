// Tells people plainly what this browser can and can't do with the page,
// instead of it breaking silently. A classic script in plain ES5, run before
// the page's module (tools/build_site.py puts it in <head>), so it works in
// browsers that can't even parse the module.
//
// FEATURES below is the one list of what the page needs. Each feature is
// native (the browser has it), fallback (it doesn't, and the page carries a
// slower stand-in: set `fallback` to what that means for the person) or
// missing. A missing `required` feature means the page can't work here.
// The stand-ins are js/zlib.js and js/cryptox.js (with the plain-JavaScript
// modules under them), js/has-shim.js and js/polyfills.js (docs/plan.md
// 1.11); what is left without one is ES2017 syntax, getRandomValues, and the
// optional folder picking and SVG icons.
//
// Shows, when anything isn't native, a slim bar under the header naming
// the practical effect, and the browsers our tests found work on this OS
// (tests/browsers/, embedded at build time as <script id="ib-compat">).
// "Details" lists every feature and the tested machine x browser matrix,
// with the visitor's nearest row marked. The bar can be dismissed, per
// browser version, unless the page can't work at all.
//
// For the tests: <html data-ib-missing="..."> (required features missing;
// empty when none), data-ib-degraded (every feature not native), and
// globalThis.ibCompat {features, env, missing, degraded}.
(function () {
  var w = window, doc = document;

  function syntax(src) { try { new Function(src); return true; } catch (e) { return false; } }
  function construct(C, arg) { try { new C(arg); return true; } catch (e) { return false; } }
  var subtle = w.crypto && w.crypto.subtle;
  function hex(h) { var u = new Uint8Array(h.length / 2); for (var i = 0; i < u.length; i++) u[i] = parseInt(h.substr(i * 2, 2), 16); return u; }
  // Importing a known-good public key tells whether an algorithm is there,
  // without the cost of generating keys at startup.
  function canImport(key, alg) {
    if (!subtle) return false;
    return subtle.importKey('raw', key, alg, false, ['verify']).then(function () { return true; }, function () { return false; });
  }

  // id, name, test (sync: true/false; async: returns a promise of
  // true/false), required, effect when missing, fallback (null, or what
  // the page's stand-in means for the person).
  var FEATURES = [
    { id: 'syntax', name: 'JavaScript of 2017 (async functions)', required: true, effect: 'the page can\'t start',
      test: function () { return syntax('async function f(a, ...b) { for (const c of a) await c; return class {}; }'); } },
    { id: 'random', name: 'crypto.getRandomValues', required: true, effect: 'can\'t sign installers or make keys',
      test: function () { return !!(w.crypto && w.crypto.getRandomValues); } },
    { id: 'compress', name: 'CompressionStream (deflate-raw)', required: true, effect: 'can\'t build installers',
      fallback: 'compressing is done by the page\'s own JavaScript (slower)',
      test: function () { return typeof w.CompressionStream === 'function' && construct(w.CompressionStream, 'deflate-raw') && !!(w.Blob && Blob.prototype.stream); } },
    { id: 'decompress', name: 'DecompressionStream (deflate-raw)', required: true, effect: 'can\'t open installers or the runtimes catalogue',
      fallback: 'unpacking is done by the page\'s own JavaScript (slower)',
      test: function () { return typeof w.DecompressionStream === 'function' && construct(w.DecompressionStream, 'deflate-raw') && !!(w.Blob && Blob.prototype.stream); } },
    { id: 'webcrypto', name: 'WebCrypto (crypto.subtle)', required: true, effect: 'can\'t hash, build or sign installers',
      fallback: 'hashing and signing use the page\'s own JavaScript (slower: a large RSA key can take seconds)' +
        (w.isSecureContext === false ? '; browsers keep WebCrypto to https, localhost and pages opened from disk' : ''),
      test: function () { return !!subtle; } },
    { id: 'has', name: 'CSS :has()', required: true, effect: 'the forms can\'t show their parts (the code editor stays hidden)',
      fallback: 'a small script keeps the forms\' sections in step',
      test: function () { return !!(w.CSS && CSS.supports && CSS.supports('selector(:has(a))')); } },
    { id: 'builtins', name: 'Newer built-ins (Object.hasOwn, Array.flat, replaceChildren)', required: true, effect: 'the page can\'t start',
      fallback: 'the page adds its own',
      test: function () { return typeof Object.hasOwn === 'function' && !![].flat && !!(w.Element && Element.prototype.replaceChildren); } },
    { id: 'readfile', name: 'Reading files (Blob.arrayBuffer)', required: true, effect: 'can\'t read the files you pick',
      fallback: 'files are read with FileReader',
      test: function () { return !!(w.Blob && Blob.prototype.arrayBuffer); } },
    { id: 'textcodec', name: 'TextEncoder and TextDecoder', required: true, effect: 'the page can\'t start',
      fallback: 'the page carries its own UTF-8 encoder',
      test: function () { return typeof w.TextEncoder === 'function' && typeof w.TextDecoder === 'function'; } },
    { id: 'ed25519', name: 'WebCrypto Ed25519', required: false, effect: 'can\'t make or use Ed25519 PGP keys',
      fallback: 'Ed25519 PGP keys use the page\'s own JavaScript',
      test: function () { return canImport(hex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'), { name: 'Ed25519' }); } },
    { id: 'ecdsa', name: 'WebCrypto ECDSA P-256', required: false, effect: 'can\'t sign with EC (P-256) certificates',
      fallback: 'EC certificates sign with the page\'s own JavaScript',
      test: function () {
        return canImport(hex('04' + '6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296' +
          '4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5'), { name: 'ECDSA', namedCurve: 'P-256' });
      } },
    { id: 'folder', name: 'Folder picking (webkitdirectory)', required: false, effect: 'can\'t pick a folder of code; add the files one by one',
      test: function () { return 'webkitdirectory' in doc.createElement('input'); } },
    { id: 'canvas', name: 'OffscreenCanvas and createImageBitmap', required: false, effect: 'icons must be PNG (SVG, JPEG and others need these)',
      test: function () { return typeof w.OffscreenCanvas === 'function' && typeof w.createImageBitmap === 'function'; } },
  ];

  /* ---------- this browser, OS and CPU ---------- */

  function parseUA(ua) {
    var m, env = { browser: '', version: '', os: '', osVersion: '', cpu: '' };
    if ((m = /Edg(?:e|A|iOS)?\/([\d.]+)/.exec(ua))) { env.browser = 'Edge'; env.version = m[1]; }
    else if ((m = /(?:Firefox|FxiOS)\/([\d.]+)/.exec(ua))) { env.browser = 'Firefox'; env.version = m[1]; }
    else if ((m = /(?:OPR|Opera)\/([\d.]+)/.exec(ua))) { env.browser = 'Opera'; env.version = m[1]; }
    else if ((m = /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua))) { env.browser = /Chromium\//.test(ua) ? 'Chromium' : 'Chrome'; env.version = m[1]; }
    else if ((m = /Version\/([\d.]+).*Safari\//.exec(ua))) { env.browser = 'Safari'; env.version = m[1]; }
    else if ((m = /(?:MSIE |Trident\/.*rv:)([\d.]+)/.exec(ua))) { env.browser = 'Internet Explorer'; env.version = m[1]; }
    if ((m = /Windows NT ([\d.]+)/.exec(ua))) { env.os = 'Windows'; env.osVersion = m[1]; }
    else if ((m = /Android ([\d.]+)/.exec(ua))) { env.os = 'Android'; env.osVersion = m[1]; }
    else if ((m = /(?:iPhone|iPad).*OS ([\d_]+)/.exec(ua))) { env.os = 'iOS'; env.osVersion = m[1].replace(/_/g, '.'); }
    else if ((m = /Mac OS X ([\d_.]+)/.exec(ua))) { env.os = 'macOS'; env.osVersion = m[1].replace(/_/g, '.'); }
    else if (/CrOS/.test(ua)) env.os = 'ChromeOS';
    else if (/Linux|X11/.test(ua)) env.os = 'Linux';
    env.cpu = /Win64|x64|WOW64|x86_64|amd64/i.test(ua) ? 'x86-64' : /aarch64|arm64/i.test(ua) ? 'ARM64' : /arm/i.test(ua) ? 'ARM' : /i[3-6]86|Win32/.test(ua) ? 'x86' : '';
    return env;
  }

  var env = parseUA(navigator.userAgent || '');
  // Client hints, where the browser has them: truer OS version (Windows 11
  // says "Windows NT 10.0" in its user agent) and the CPU.
  function hints() {
    var ch = navigator.userAgentData;
    if (!ch || !ch.getHighEntropyValues) return null;
    return ch.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']).then(function (h) {
      var brands = (h.fullVersionList || []).filter(function (b) { return !/Not.?A.?Brand|^Chromium$/i.test(b.brand); });
      if (brands.length) { env.browser = brands[0].brand.replace(/^Google /, '').replace(/^Microsoft /, ''); env.version = brands[0].version; }
      if (h.platform || ch.platform) env.os = (h.platform || ch.platform).replace(/^Chrome OS$/, 'ChromeOS');
      if (h.platformVersion) {
        env.osVersion = h.platformVersion;
        if (env.os === 'Windows') env.osVersion = parseInt(h.platformVersion, 10) >= 13 ? '11' : parseInt(h.platformVersion, 10) > 0 ? '10' : env.osVersion;
      }
      if (h.architecture) env.cpu = h.architecture === 'x86' ? (h.bitness === '64' ? 'x86-64' : 'x86') : h.architecture === 'arm' ? (h.bitness === '64' ? 'ARM64' : 'ARM') : h.architecture;
    }, function () {});
  }

  /* ---------- running the checks ---------- */

  var status = {}, pending = [];
  function set(f, ok) { status[f.id] = ok ? 'native' : f.fallback ? 'fallback' : 'missing'; }
  for (var i = 0; i < FEATURES.length; i++) {
    (function (f) {
      var r;
      try { r = f.test(); } catch (e) { r = false; }
      if (r && typeof r.then === 'function') {
        status[f.id] = 'checking';
        pending.push(r.then(function (ok) { set(f, ok); }, function () { set(f, false); }));
      } else set(f, r);
    })(FEATURES[i]);
  }
  var h = hints();
  if (h) pending.push(h);

  function missing() { return FEATURES.filter(function (f) { return f.required && status[f.id] === 'missing'; }); }
  function degraded() { return FEATURES.filter(function (f) { return status[f.id] === 'missing' || status[f.id] === 'fallback'; }); }
  function names(list) { return list.map(function (f) { return f.name; }).join('; '); }
  function mark() {
    doc.documentElement.setAttribute('data-ib-missing', names(missing()));
    doc.documentElement.setAttribute('data-ib-degraded', degraded().map(function (f) { return f.id; }).join(' '));
    w.ibMissing = missing().map(function (f) { return f.name; });
    w.ibCompat = { features: FEATURES, status: status, env: env, missing: w.ibMissing, degraded: degraded().map(function (f) { return f.id; }) };
  }
  mark();   // the synchronous verdict at once; the tests wait for data-ib-ready

  /* ---------- tested browsers (tests/browsers/, embedded at build) ---------- */

  var compat = null;
  function loadCompat() {
    if (compat) return compat;
    try { var el = doc.getElementById('ib-compat'); if (el) compat = JSON.parse(el.textContent) || null; } catch (e) { compat = null; }
    return compat;
  }
  // The tested machine nearest this visitor's OS.
  function nearestMachine(c) {
    var ms = c.machines, v = env.osVersion, best = null;
    for (var i = 0; i < ms.length; i++) {
      var m = ms[i];
      if (env.os === 'Windows' && m[2] === 'windows' && m[3] === (v === '10.0' ? '10' : v) && m[0] !== '2022') best = best || m;
      if (env.os === 'macOS' && m[2] === 'mac') best = m;
      if ((env.os === 'Linux' || env.os === 'ChromeOS') && m[2] === 'linux' && (m[4] || !best)) best = m;
    }
    return best;
  }
  function browserId(name) {
    var n = String(name).toLowerCase();
    return /edge/.test(n) ? 'edge' : /firefox/.test(n) ? 'firefox' : /supermium/.test(n) ? 'supermium' : /opera|opr/.test(n) ? 'opera' : /safari/.test(n) ? 'safari' : /chromium/.test(n) ? 'chromium' : /chrome/.test(n) ? 'chrome' : n;
  }
  function label(list, id) { for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i][1]; return id; }
  function passingOn(c, m) {
    var seen = {}, out = [];
    for (var i = c.results.length - 1; i >= 0; i--) {
      var r = c.results[i];
      if (r[0] === m[0] && r[3] === 'pass' && !seen[r[1]]) { seen[r[1]] = 1; out.unshift(label(c.browsers, r[1]) + ' ' + r[2].split('.')[0]); }
    }
    return out;
  }

  /* ---------- the bar and its details ---------- */

  var CSS_TEXT =
    '.ib-compat-bar{margin:0;padding:8px 16px;border-bottom:1px solid #d9b44a;background:#fff8e1;color:#3d2e00;font:14px/1.4 system-ui,sans-serif}' +
    '.ib-compat-bar.ib-too-old{border-bottom:2px solid #b3261e;background:#fdecea;color:#410e0b}' +
    '.ib-compat-bar button{font:inherit;margin-left:8px;padding:1px 8px;cursor:pointer}' +
    '.ib-compat-bar .ib-compat-details{margin-top:8px;max-height:60vh;overflow:auto;background:#fff;color:#222;padding:8px;border:1px solid #ccc}' +
    '.ib-compat-bar table{border-collapse:collapse;font-size:13px;margin:4px 0 10px}' +
    '.ib-compat-bar th,.ib-compat-bar td{border:1px solid #ddd;padding:2px 6px;text-align:left;vertical-align:top}' +
    '.ib-compat-bar tr.ib-you td,.ib-compat-bar tr.ib-you th{background:#e3f2fd}.ib-compat-bar td.ib-you{outline:2px solid #1565c0}' +
    '.ib-c-native,.ib-c-pass{color:#1b5e20}.ib-c-fallback{color:#8a6d00}.ib-c-missing,.ib-c-fail{color:#b3261e}.ib-c-unsupported{color:#6d4c41}';

  function el(tag, attrs, text) {
    var e = doc.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    if (text !== undefined) e.appendChild(doc.createTextNode(text));
    return e;
  }
  function dismissKey() { return 'ib-compat-dismissed:' + env.browser + ' ' + String(env.version).split('.')[0] + ':' + degraded().map(function (f) { return f.id + '=' + status[f.id]; }).join(','); }
  function dismissed() { try { return w.localStorage.getItem(dismissKey()) === '1'; } catch (e) { return false; } }

  function summaryText() {
    var miss = missing(), deg = degraded();
    var effects = [], seen = {};
    for (var i = 0; i < deg.length; i++) {
      var f = deg[i], e = status[f.id] === 'fallback' ? f.fallback : f.effect;
      if (!seen[e]) { seen[e] = 1; effects.push(e); }
    }
    var head = miss.length ? 'This browser can\'t run TiddlyInstall: ' : 'This browser can run TiddlyInstall, with limits: ';
    var text = head + effects.join('; ') + '.';
    var c = loadCompat(), m = c && nearestMachine(c), ok = m ? passingOn(c, m) : [];
    if (ok.length) text += ' Tested on ' + m[1] + ' and working: ' + ok.join(', ') + '.';
    else if (miss.length) text += ' Please use Firefox 52 or later, Chrome or Edge 109 or later, Opera 95 or later, or Safari 12 or later (not yet tested); on Windows XP and Vista, Firefox 52 ESR or Supermium; on Windows 7 and 8.1, Chrome 109, Firefox 115 ESR, Opera 95 or Supermium (and Edge 109 on 8.1); on CentOS 6 and Ubuntu 14.04, their own Firefox.';
    return text;
  }

  function featureTable() {
    var t = el('table'), tr = el('tr');
    tr.appendChild(el('th', {}, 'Feature')); tr.appendChild(el('th', {}, 'Here')); tr.appendChild(el('th', {}, 'Without it'));
    t.appendChild(tr);
    for (var i = 0; i < FEATURES.length; i++) {
      var f = FEATURES[i], s = status[f.id];
      tr = el('tr');
      tr.appendChild(el('td', {}, f.name + (f.required ? '' : ' (optional)')));
      tr.appendChild(el('td', { 'class': 'ib-c-' + s }, { native: '✓ native', fallback: '~ fallback', missing: '✗ missing', checking: '…' }[s] || s));
      tr.appendChild(el('td', {}, s === 'fallback' ? f.fallback : f.effect));
      t.appendChild(tr);
    }
    return t;
  }

  function matrix() {
    var c = loadCompat();
    if (!c || !c.results || !c.results.length) return el('p', {}, 'No test results were built into this copy of the page.');
    var cols = [], used = {};
    for (var i = 0; i < c.results.length; i++) used[c.results[i][1]] = 1;
    for (i = 0; i < c.browsers.length; i++) if (used[c.browsers[i][0]]) cols.push(c.browsers[i]);
    var you = nearestMachine(c), youB = browserId(env.browser);
    var t = el('table', { 'class': 'ib-compat-matrix' }), tr = el('tr');
    tr.appendChild(el('th', {}, 'Tested on'));
    for (i = 0; i < cols.length; i++) tr.appendChild(el('th', {}, cols[i][1]));
    t.appendChild(tr);
    for (var j = 0; j < c.machines.length; j++) {
      var m = c.machines[j], cells = [], any = false;
      for (i = 0; i < cols.length; i++) {
        var rs = c.results.filter(function (r) { return r[0] === m[0] && r[1] === cols[i][0]; });
        cells.push(rs);
        if (rs.length) any = true;
      }
      if (!any) continue;
      var isYou = you && you[0] === m[0];
      tr = el('tr', isYou ? { 'class': 'ib-you', 'data-machine': m[0] } : { 'data-machine': m[0] });
      tr.appendChild(el('th', {}, m[1] + (isYou ? ' (nearest to you)' : '')));
      for (i = 0; i < cols.length; i++) {
        var td = el('td', isYou && cols[i][0] === youB ? { 'class': 'ib-you' } : {});
        for (var k = 0; k < cells[i].length; k++) {
          var r = cells[i][k], sym = { pass: '✓', fail: '✗', unsupported: 'too old' }[r[3]] || r[3];
          var line = el('div', { 'class': 'ib-c-' + r[3], title: r[2] + ', ' + r[5] + (r[4] ? ': ' + r[4] : '') }, sym + ' ' + r[2].split('.')[0]);
          td.appendChild(line);
        }
        tr.appendChild(td);
      }
      t.appendChild(tr);
    }
    return t;
  }

  var bar = null;
  function render() {
    mark();
    doc.documentElement.setAttribute('data-ib-ready', '1');
    var deg = degraded(), miss = missing();
    if (!deg.length || (!miss.length && dismissed())) { if (bar) bar.hidden = true; return; }
    if (!bar) {
      var st = el('style', {}, CSS_TEXT);
      (doc.head || doc.documentElement).appendChild(st);
      bar = el('div', { 'class': 'ib-compat-bar', role: miss.length ? 'alert' : 'status' });
      var header = doc.querySelector('header.site-header');
      if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
      else doc.body.insertBefore(bar, doc.body.firstChild);
    }
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    bar.hidden = false;
    bar.className = 'ib-compat-bar' + (miss.length ? ' ib-too-old' : '');
    bar.appendChild(el('span', { 'class': 'ib-compat-text' }, summaryText()));
    var more = el('button', { type: 'button', 'class': 'ib-compat-more', 'aria-expanded': 'false' }, 'Details');
    bar.appendChild(more);
    if (!miss.length) {
      var close = el('button', { type: 'button', 'class': 'ib-compat-dismiss' }, 'Dismiss');
      close.onclick = function () { try { w.localStorage.setItem(dismissKey(), '1'); } catch (e) { /* no storage: hide for now */ } bar.hidden = true; };
      bar.appendChild(close);
    }
    var box = null;
    more.onclick = function () {
      if (box) { box.parentNode.removeChild(box); box = null; more.setAttribute('aria-expanded', 'false'); return; }
      box = el('div', { 'class': 'ib-compat-details' });
      function words(a) { return a.filter(function (x) { return !!x; }).join(' '); }
      box.appendChild(el('p', {}, 'This browser: ' + words([env.browser, env.version]) + ' on ' + (words([env.os, env.osVersion]) || 'an unknown OS') + (env.cpu ? ', ' + env.cpu : '') + '.'));
      box.appendChild(featureTable());
      var c = loadCompat();
      box.appendChild(el('p', {}, 'Where the page was tested (tests/browsers/' + (c && c.generated ? ', results up to ' + c.generated : '') + '); hover a result for its date and reason:'));
      box.appendChild(matrix());
      bar.appendChild(box);
      more.setAttribute('aria-expanded', 'true');
    };
  }

  // After parsing: the data block is at the end of the body.
  function whenReady() {
    if (doc.readyState !== 'loading') render(); else doc.addEventListener('DOMContentLoaded', render);
  }
  if (pending.length && w.Promise) Promise.all(pending).then(whenReady, whenReady);
  else whenReady();
})();
