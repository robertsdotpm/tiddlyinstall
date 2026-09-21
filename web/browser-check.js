// Tells people plainly what this browser can and can't do with the page,
// instead of it breaking silently. A classic script in plain ES5, run before
// the page's module (tools/build_site.py puts it in <head>), so it works in
// browsers that can't even parse the module.
//
// FEATURES below is the one list of what the page needs. Each feature is
// native (the browser has it), fallback (it doesn't, and the page carries a
// slower stand-in: set `fallback` to what that means for the person) or
// missing. A missing `required` feature means the page can't work here.
// The stand-ins are web/lib/zlib.js and web/lib/cryptox.js (with the plain-JavaScript
// modules under them), web/has-shim.js and web/polyfills.js (docs/plan.md
// 1.11); what is left without one is ES2017 syntax, getRandomValues, and the
// optional folder picking and SVG icons.
//
// Shows, when anything isn't native, a slim bar under the header naming
// the practical effect, and the browsers our tests found work on this OS
// (tests/browsers/, embedded at build time as <script id="ti-compat">).
// "Details" lists every feature and the tested machine x browser matrix,
// with the visitor's nearest row marked. The bar can be dismissed, per
// browser version, unless the page can't work at all.
//
// For the tests: <html data-ti-missing="..."> (required features missing;
// empty when none), data-ti-degraded (every feature not native), and
// globalThis.tiCompat {features, env, missing, degraded}.
//
// Written to parse and run in Internet Explorer 6 and later (ES3: no
// trailing commas, reserved words quoted as property names, no Array
// filter/map, attachEvent where there's no addEventListener), since it is
// what tells those browsers what to use instead. Browsers that can't parse
// ES2017 but can run the page's ES5 copy (IE 10 and 11, Chrome 49) get it through
// web/page-loader.js, which runs it when this sets window.TI_ES5_OK.
(function () {
  var w = window, doc = document;

  // IE 6-8 style HTML5 elements only when each was created once before the
  // body is parsed; then the static pages lay out as they should.
  var H5 = ['header', 'nav', 'main', 'footer', 'section', 'article', 'aside'];
  for (var h5 = 0; h5 < H5.length; h5++) doc.createElement(H5[h5]);

  function grep(list, fn) { var out = []; for (var i = 0; i < list.length; i++) if (fn(list[i])) out.push(list[i]); return out; }
  function each(list, fn) { var out = []; for (var i = 0; i < list.length; i++) out.push(fn(list[i])); return out; }

  function syntax(src) { try { new Function(src); return true; } catch (e) { return false; } }
  function construct(C, arg) { try { new C(arg); return true; } catch (e) { return false; } }
  var subtle = w.crypto && w.crypto.subtle;
  // What the page's ES5 copy needs (keep in step with web/legacy-dom.js and
  // tools/es5/build-es5.mjs's targets): IE 10 and 11, Chrome 49 and later.
  // IE 10's missing Map comes from core-js and its dataset from
  // web/legacy-dom.js (since the catalogue unpacks a folder at a time; before,
  // IE 10 ran out of memory building); IE 9 lacks typed arrays and Blob.
  function es5Capable() {
    try {
      return !!(w.Uint8Array && w.Blob && w.FileReader && w.JSON && w.atob && doc.addEventListener && w.XMLHttpRequest &&
        Object.defineProperty && w.HTMLElement && doc.documentElement.classList && w.getComputedStyle &&
        ('download' in doc.createElement('a') || w.navigator.msSaveOrOpenBlob));
    } catch (e) { return false; }
  }
  var ES5 = es5Capable();
  w.TI_ES5_OK = ES5;
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
      fallback: ES5 ? 'the page runs its copy for older browsers (slower to start)' : null,
      test: function () { return syntax('async function f(a, ...b) { for (const c of a) await c; return class {}; }'); } },
    { id: 'random', name: 'crypto.getRandomValues', required: false, effect: 'can\'t sign installers or make keys (no secure random numbers); building and editing work',
      fallback: w.msCrypto && w.msCrypto.getRandomValues ? 'random numbers come from msCrypto (Internet Explorer\'s name for it)' : null,
      test: function () { return !!(w.crypto && w.crypto.getRandomValues); } },
    // IE 10: without it core-js can't add methods to the browser's typed
    // arrays, so the ES5 copy uses core-js's own, in plain JavaScript.
    { id: 'protos', name: 'Object.setPrototypeOf', required: false, effect: 'the page\'s copy for older browsers would be very slow',
      fallback: 'typed arrays run on the page\'s own JavaScript: a build takes minutes and a lot of memory, and a Node.js one may not finish',
      test: function () { return typeof Object.setPrototypeOf === 'function' || '__proto__' in {}; } },
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
    // Phones and tablets have the property but, mostly, no folder picker:
    // caniuse gives one on Safari from iOS/iPadOS 18.4 and Chrome on Android
    // from 147; other phone browsers pick files, not a folder. Where it's
    // missing the page hides "Pick a folder" (html.ti-no-folder).
    // On a phone that is how phones are, not a limit of the browser, so it
    // counts as "not used here" ('na') and raises no bar (design.md 11.0
    // item 5): the page quietly offers the archive picker instead. On a
    // desktop browser without it, it is still a missing feature.
    { id: 'folder', name: 'Folder picking (webkitdirectory)', required: false, effect: 'can\'t pick a folder of code; pick a .zip or .tar of it instead',
      na: 'phones and tablets pick files, not folders; the page doesn\'t offer it here',
      test: function () {
        if (!('webkitdirectory' in doc.createElement('input'))) return env.mobile ? 'na' : false;
        if (!env.mobile) return true;
        if (env.os === 'iOS' || env.os === 'iPadOS') return atLeast(env.osVersion, [18, 4]) || 'na';
        return (env.os === 'Android' && env.browser === 'Chrome' && atLeast(env.version, [147])) || 'na';
      } },
    // iOS before 13 has no <a download>: a blob link opens instead of saving.
    { id: 'download', name: 'Saving files (<a download>)', required: false,
      effect: 'can\'t save the installers it makes, or this page: on iPhone and iPad that needs iOS 13 or later; or use a computer',
      test: function () { return 'download' in doc.createElement('a') || !!w.navigator.msSaveOrOpenBlob; } },
    { id: 'canvas', name: 'OffscreenCanvas and createImageBitmap', required: false, effect: 'icons must be PNG (SVG, JPEG and others need these)',
      test: function () { return typeof w.OffscreenCanvas === 'function' && typeof w.createImageBitmap === 'function'; } }
  ];

  /* ---------- this browser, OS and CPU ---------- */

  function parseUA(ua) {
    var m, env = { browser: '', version: '', os: '', osVersion: '', cpu: '' };
    if ((m = /Edg(?:e|A|iOS)?\/([\d.]+)/.exec(ua))) { env.browser = 'Edge'; env.version = m[1]; }
    else if ((m = /(?:Firefox|FxiOS)\/([\d.]+)/.exec(ua))) { env.browser = 'Firefox'; env.version = m[1]; }
    else if ((m = /(?:OPR|Opera)\/([\d.]+)/.exec(ua))) { env.browser = 'Opera'; env.version = m[1]; }
    else if ((m = /SamsungBrowser\/([\d.]+)/.exec(ua))) { env.browser = 'Samsung Internet'; env.version = m[1]; }
    else if ((m = /(?:Chrome|CriOS)\/([\d.]+)/.exec(ua))) { env.browser = /Chromium\//.test(ua) ? 'Chromium' : 'Chrome'; env.version = m[1]; }
    // Safari's engine on Linux (WebKitGTK: MiniBrowser, GNOME Web) says Safari, with a made-up version.
    else if ((m = /Version\/([\d.]+).*Safari\//.exec(ua))) { env.browser = /X11|Linux/.test(ua) && !/Android/.test(ua) ? 'WebKitGTK' : 'Safari'; env.version = env.browser === 'Safari' ? m[1] : ''; }
    else if ((m = /(?:MSIE |Trident\/.*rv:)([\d.]+)/.exec(ua))) { env.browser = 'Internet Explorer'; env.version = m[1]; }
    if ((m = /Windows NT ([\d.]+)/.exec(ua))) { env.os = 'Windows'; env.osVersion = m[1]; }
    else if ((m = /Android ([\d.]+)/.exec(ua))) { env.os = 'Android'; env.osVersion = m[1]; }
    else if ((m = /(?:iPhone|iPad).*OS ([\d_]+)/.exec(ua))) { env.os = 'iOS'; env.osVersion = m[1].replace(/_/g, '.'); }
    else if ((m = /Mac OS X ([\d_.]+)/.exec(ua))) { env.os = 'macOS'; env.osVersion = m[1].replace(/_/g, '.'); }
    else if (/CrOS/.test(ua)) env.os = 'ChromeOS';
    else if (/Linux|X11/.test(ua)) env.os = 'Linux';
    // iPadOS 13 and later says it's a Mac; a Mac has no touch screen.
    if (env.os === 'macOS' && navigator.maxTouchPoints > 1) {
      env.os = 'iPadOS';
      env.osVersion = (m = /Version\/([\d.]+)/.exec(ua)) ? m[1] : '';
    }
    // A phone or tablet: its user agent or client hints say so.
    env.mobile = /Android|iPhone|iPad|iPod|Mobile/.test(ua) || env.os === 'iPadOS' ||
      !!(navigator.userAgentData && navigator.userAgentData.mobile);
    env.cpu = /Win64|x64|WOW64|x86_64|amd64/i.test(ua) ? 'x86-64' : /aarch64|arm64/i.test(ua) ? 'ARM64' : /arm/i.test(ua) ? 'ARM' : /i[3-6]86|Win32/.test(ua) ? 'x86' : '';
    return env;
  }

  // True when version string v ("18.4.1", "147.0.1") is at least [major, minor].
  function atLeast(v, min) {
    var p = String(v || '').split('.');
    for (var i = 0; i < min.length; i++) {
      var n = parseInt(p[i], 10) || 0;
      if (n !== min[i]) return n > min[i];
    }
    return true;
  }
  var env = parseUA(navigator.userAgent || '');
  if (navigator.brave && env.browser === 'Chrome') env.browser = 'Brave';   // its user agent is Chrome's
  // Client hints, where the browser has them: truer OS version (Windows 11
  // says "Windows NT 10.0" in its user agent) and the CPU.
  function hints() {
    var ch = navigator.userAgentData;
    if (!ch || !ch.getHighEntropyValues) return null;
    return ch.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'fullVersionList']).then(function (h) {
      var brands = grep(h.fullVersionList || [], function (b) { return !/Not.?A.?Brand|^Chromium$/i.test(b.brand); });
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
  // A test answers true (native), false (missing, or the page's stand-in),
  // or 'na': the feature doesn't apply on this device, so it is not a limit.
  function set(f, ok) { status[f.id] = ok === 'na' && f.na ? 'na' : ok ? 'native' : f.fallback ? 'fallback' : 'missing'; }
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

  function missing() { return grep(FEATURES, function (f) { return f.required && status[f.id] === 'missing'; }); }
  function degraded() { return grep(FEATURES, function (f) { return status[f.id] === 'missing' || status[f.id] === 'fallback'; }); }
  function names(list) { return each(list, function (f) { return f.name; }).join('; '); }
  function ids(list) { return each(list, function (f) { return f.id; }).join(' '); }
  // Classes on <html> for the stylesheet (web/css/style.css, "Phones and small
  // screens"): ti-mobile, ti-no-folder, ti-no-download.
  function htmlClass(name, on) {
    var el = doc.documentElement, c = ' ' + el.className + ' ', has = c.indexOf(' ' + name + ' ') >= 0;
    if (on && !has) el.className = (el.className ? el.className + ' ' : '') + name;
    if (!on && has) el.className = c.replace(' ' + name + ' ', ' ').replace(/^\s+|\s+$/g, '');
  }
  function mark() {
    htmlClass('ti-mobile', !!env.mobile);
    htmlClass('ti-no-folder', status.folder !== 'native');
    htmlClass('ti-no-download', status.download === 'missing');
    doc.documentElement.setAttribute('data-ti-missing', names(missing()));
    doc.documentElement.setAttribute('data-ti-degraded', ids(degraded()));
    w.ibMissing = each(missing(), function (f) { return f.name; });
    w.tiCompat = { features: FEATURES, status: status, env: env, missing: w.ibMissing, degraded: each(degraded(), function (f) { return f.id; }), es5: status.syntax === 'fallback' };
  }
  mark();   // the synchronous verdict at once; the tests wait for data-ti-ready

  /* ---------- tested browsers (tests/browsers/, embedded at build) ---------- */

  var compat = null;
  function loadCompat() {
    if (compat) return compat;
    try { var el = doc.getElementById('ti-compat'); if (el && w.JSON) compat = JSON.parse(el.text || el.textContent) || null; } catch (e) { compat = null; }
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
    return /edge/.test(n) ? 'edge' : /firefox/.test(n) ? 'firefox' : /supermium/.test(n) ? 'supermium' : /opera|opr/.test(n) ? 'opera' : /brave/.test(n) ? 'brave' : /webkitgtk/.test(n) ? 'webkitgtk' : /safari/.test(n) ? 'safari' : /chromium/.test(n) ? 'chromium' : /chrome/.test(n) ? 'chrome' : /internet explorer/.test(n) ? 'ie' : n;
  }
  function label(list, id) { for (var i = 0; i < list.length; i++) if (list[i][0] === id) return list[i][1]; return id; }

  /* ---------- what to use instead ---------- */

  // Where to get each browser (compat.json's ids); Firefox's link depends
  // on the version that still runs on that OS.
  function getUrl(id, version) {
    var major = parseInt(version, 10);
    if (/^supermium/.test(id)) return 'https://github.com/win32ss/supermium/releases';
    if (id === 'firefox') return major <= 52 ? 'https://ftp.mozilla.org/pub/firefox/releases/52.9.0esr/' : major <= 115 ? 'https://www.mozilla.org/firefox/all/#product-desktop-esr' : 'https://www.mozilla.org/firefox/';
    if (id === 'chrome') return 'https://www.google.com/chrome/';
    if (id === 'edge') return 'https://www.microsoft.com/edge';
    if (id === 'opera') return 'https://www.opera.com/';
    if (id === 'brave' || id === 'vivaldi') return id === 'brave' ? 'https://brave.com/download/' : 'https://vivaldi.com/download/';
    return null;
  }
  // Phones and tablets: none is in the matrix below.
  var PHONES = 'No phone or tablet is in the table below. The page was checked at phone sizes (320 to 768 px) in Chrome\'s phone emulation, ' +
    'in Chrome 113 on Android (an emulator) and in Safari\'s engine (WebKitGTK), not on real phones: it lays out, builds unsigned installers and signs. ' +
    'The installers are for Windows, Linux and macOS, so they are saved to copy to a computer.';
  // Used when this copy of the page has no test results for the visitor's OS.
  var GENERAL = 'Firefox 52 or later, Chrome 58 or later, Safari 12 or later, or Edge; on Windows XP and Vista, Supermium or Firefox 52 ESR; ' +
    'on Windows 7 and 8.1, Chrome 109, Firefox 115 ESR or Supermium';

  // The browsers that passed on machine m, the newest of each (Supermium
  // and its older install are one), with where to get each. Not Internet
  // Explorer, nor any that passed only on the page's ES5 copy (Chrome 49),
  // nor stand-ins tested for their engine (compat.json's proxies: WebKitGTK):
  // they work, but are no browser to move to.
  function suggestions(c, m) {
    var best = {}, order = [], i;
    for (i = 0; i < c.results.length; i++) {
      var r = c.results[i], fam = r[1].replace(/-installed$/, '');
      if (r[0] !== m[0] || r[3] !== 'pass' || fam === 'ie' || /ES5/.test(r[4]) || ('|' + (c.proxies || []).join('|') + '|').indexOf('|' + fam + '|') >= 0) continue;
      if (!best[fam]) order.push(fam);
      if (!best[fam] || parseInt(r[2], 10) > parseInt(best[fam][2], 10)) best[fam] = r;
    }
    return each(order, function (fam) {
      return { id: fam, name: label(c.browsers, fam) + ' ' + best[fam][2].split('.')[0], url: getUrl(fam, best[fam][2]) };
    });
  }

  /* ---------- the bar and its details ---------- */

  var CSS_TEXT =
    '.ti-compat-bar{margin:0;padding:8px 16px;border-bottom:1px solid #d9b44a;background:#fff8e1;color:#3d2e00;font:14px/1.4 system-ui,sans-serif}' +
    '.ti-compat-bar.ti-too-old{border-bottom:2px solid #b3261e;background:#fdecea;color:#410e0b}' +
    '.ti-compat-bar a{color:#0b4bb3}' +
    '.ti-compat-bar button{font:inherit;margin-left:8px;padding:1px 8px;cursor:pointer}' +
    '.ti-compat-bar .ti-compat-details{margin-top:8px;max-height:60vh;overflow:auto;background:#fff;color:#222;padding:8px;border:1px solid #ccc}' +
    '.ti-compat-bar table{border-collapse:collapse;font-size:13px;margin:4px 0 10px}' +
    '.ti-compat-bar th,.ti-compat-bar td{border:1px solid #ddd;padding:2px 6px;text-align:left;vertical-align:top}' +
    '.ti-compat-bar tr.ti-you td,.ti-compat-bar tr.ti-you th{background:#e3f2fd}.ti-compat-bar td.ti-you{outline:2px solid #1565c0}' +
    '@media (max-width:768px),(pointer:coarse){.ti-compat-bar button{min-height:40px;margin:6px 8px 0 0;padding:4px 12px}}' +
    '.ti-c-native,.ti-c-pass{color:#1b5e20}.ti-c-fallback{color:#8a6d00}.ti-c-missing,.ti-c-fail{color:#b3261e}.ti-c-unsupported{color:#6d4c41}';

  function el(tag, attrs, text) {
    var e = doc.createElement(tag);
    for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      if (k === 'class') e.className = attrs[k];      // IE 7 and before: className only
      else e.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) e.appendChild(doc.createTextNode(text));
    return e;
  }
  function show(e, on) { e.style.display = on ? '' : 'none'; if ('hidden' in e) e.hidden = !on; }
  // IE 8 and before keep table rows added outside a tbody out of sight.
  function table(attrs) { var t = el('table', attrs || {}), b = el('tbody'); t.appendChild(b); return { t: t, add: function (r) { b.appendChild(r); } }; }
  function dismissKey() { return 'ti-compat-dismissed:' + env.browser + ' ' + String(env.version).split('.')[0] + ':' + each(degraded(), function (f) { return f.id + '=' + status[f.id]; }).join(','); }
  function dismissed() { try { return w.localStorage.getItem(dismissKey()) === '1'; } catch (e) { return false; } }

  // The bar's text, and the browsers to suggest ({name, url}).
  function summary() {
    var miss = missing(), deg = degraded();
    var effects = [], seen = {};
    for (var i = 0; i < deg.length; i++) {
      var f = deg[i], e = status[f.id] === 'fallback' ? f.fallback : f.effect;
      if (!seen[e]) { seen[e] = 1; effects.push(e); }
    }
    var text = miss.length
      ? 'This browser can\'t run TiddlyInstall: it lacks ' + names(miss) + ', so the page can\'t start. The pages still read; to build or sign installers, use another browser.'
      : 'This browser can run TiddlyInstall, with limits: ' + effects.join('; ') + '.';
    var c = loadCompat(), m = c && c.results && nearestMachine(c), sug = m ? suggestions(c, m) : [];
    if (sug.length) text += ' Tested on ' + m[1] + ' and working: ' + each(sug, function (s) { return s.name; }).join(', ') + '.';
    else if (miss.length) text += ' Please use ' + GENERAL + '.';
    return { text: text, links: grep(sug, function (s) { return !!s.url; }) };
  }

  function featureTable() {
    var t = table(), tr = el('tr');
    tr.appendChild(el('th', {}, 'Feature')); tr.appendChild(el('th', {}, 'Here')); tr.appendChild(el('th', {}, 'Without it'));
    t.add(tr);
    var SYM = { 'native': '✓ native', 'fallback': '~ fallback', 'missing': '✗ missing', 'na': '- not used here', 'checking': '…' };
    for (var i = 0; i < FEATURES.length; i++) {
      var f = FEATURES[i], s = status[f.id];
      tr = el('tr');
      tr.appendChild(el('td', {}, f.name + (f.required ? '' : ' (optional)')));
      tr.appendChild(el('td', { 'class': 'ti-c-' + s }, SYM[s] || s));
      tr.appendChild(el('td', {}, s === 'fallback' ? f.fallback : s === 'na' ? f.na : f.effect));
      t.add(tr);
    }
    return t.t;
  }

  function matrix() {
    var c = loadCompat();
    if (!c || !c.results || !c.results.length) return el('p', {}, 'No test results were built into this copy of the page.');
    var cols = [], used = {};
    for (var i = 0; i < c.results.length; i++) used[c.results[i][1]] = 1;
    for (i = 0; i < c.browsers.length; i++) if (used[c.browsers[i][0]]) cols.push(c.browsers[i]);
    var you = nearestMachine(c), youB = browserId(env.browser);
    var t = table({ 'class': 'ti-compat-matrix' }), tr = el('tr');
    tr.appendChild(el('th', {}, 'Tested on'));
    for (i = 0; i < cols.length; i++) tr.appendChild(el('th', {}, cols[i][1]));
    t.add(tr);
    for (var j = 0; j < c.machines.length; j++) {
      var m = c.machines[j], cells = [], any = false;
      for (i = 0; i < cols.length; i++) {
        var rs = [];
        for (var q = 0; q < c.results.length; q++) if (c.results[q][0] === m[0] && c.results[q][1] === cols[i][0]) rs.push(c.results[q]);
        cells.push(rs);
        if (rs.length) any = true;
      }
      if (!any) continue;
      var isYou = you && you[0] === m[0];
      tr = el('tr', isYou ? { 'class': 'ti-you', 'data-machine': m[0] } : { 'data-machine': m[0] });
      tr.appendChild(el('th', {}, m[1] + (isYou ? ' (nearest to you)' : '')));
      for (i = 0; i < cols.length; i++) {
        var td = el('td', isYou && cols[i][0] === youB ? { 'class': 'ti-you' } : {});
        for (var k = 0; k < cells[i].length; k++) {
          var r = cells[i][k], sym = { pass: '✓', fail: '✗', unsupported: 'too old', partial: '~' }[r[3]] || r[3];
          td.appendChild(el('div', { 'class': 'ti-c-' + r[3], title: r[2] + ', ' + r[5] + (r[4] ? ': ' + r[4] : '') }, sym + ' ' + r[2].split('.')[0]));
        }
        tr.appendChild(td);
      }
      t.add(tr);
    }
    return t.t;
  }

  // The build server's simple form (GET /classic: plain HTML, no
  // JavaScript), for browsers that can't run the page: this page's server
  // when it came from one, else the build server this copy was made for.
  function classicUrl() {
    var proto = String(w.location && w.location.protocol);
    if (proto === 'http:' || proto === 'https:') return 'classic';
    var blk = doc.getElementById('ti-offline'), m = blk && /"backend"\s*:\s*"(https?:\/\/[^"\\]+)"/.exec(blk.text || blk.textContent || '');
    return m ? m[1].replace(/\/+$/, '') + '/classic' : null;
  }

  var bar = null;
  function addStyle(text) {
    var st = el('style', { type: 'text/css' });
    (doc.getElementsByTagName('head')[0] || doc.documentElement).appendChild(st);
    if (st.styleSheet) st.styleSheet.cssText = text;          // IE 8 and before
    else st.appendChild(doc.createTextNode(text));
  }
  // Browsers without attribute selectors (IE 6, and any IE in quirks mode)
  // show [hidden] elements: the other sections' forms would show under the
  // home page. When the page can't start, nothing else will hide them.
  function hideHidden() {
    var all = doc.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var e = all[i], cs = e.currentStyle;
      if (cs && cs.display !== 'none' && e.getAttribute('hidden') !== null) e.style.display = 'none';
    }
  }
  function render() {
    // The ES5 copy is a stand-in only if this copy of the page has it.
    if (status.syntax === 'fallback' && !doc.getElementById('ti-js-es5')) status.syntax = 'missing';
    mark();
    if (missing().length) { try { hideHidden(); } catch (e) { /* cosmetic */ } }
    doc.documentElement.setAttribute('data-ti-ready', '1');
    var deg = degraded(), miss = missing();
    if (!deg.length || (!miss.length && dismissed())) { if (bar) show(bar, false); return; }
    if (!bar) {
      addStyle(CSS_TEXT);
      bar = el('div', { 'class': 'ti-compat-bar', role: miss.length ? 'alert' : 'status' });
      var header = doc.getElementsByTagName('header')[0];
      if (header && header.parentNode) header.parentNode.insertBefore(bar, header.nextSibling);
      else doc.body.insertBefore(bar, doc.body.firstChild);
    }
    while (bar.firstChild) bar.removeChild(bar.firstChild);
    show(bar, true);
    bar.className = 'ti-compat-bar' + (miss.length ? ' ti-too-old' : '');
    var sum = summary();
    bar.appendChild(el('span', { 'class': 'ti-compat-text' }, sum.text));
    if (sum.links.length) {
      var get = el('span', { 'class': 'ti-compat-get' }, ' Get: ');
      for (var i = 0; i < sum.links.length; i++) {
        if (i) get.appendChild(doc.createTextNode(', '));
        get.appendChild(el('a', { href: sum.links[i].url, rel: 'noopener noreferrer', target: '_blank' }, sum.links[i].name));
      }
      bar.appendChild(get);
    }
    var classic = miss.length ? classicUrl() : null;
    if (classic) {
      var simple = el('span', { 'class': 'ti-compat-classic' }, ' Or build installers with ');
      simple.appendChild(el('a', { href: classic }, 'the build server\'s simple form'));
      simple.appendChild(doc.createTextNode(', which works in this browser.'));
      bar.appendChild(simple);
    }
    var more = el('button', { type: 'button', 'class': 'ti-compat-more', 'aria-expanded': 'false' }, 'Details');
    bar.appendChild(more);
    if (!miss.length) {
      var close = el('button', { type: 'button', 'class': 'ti-compat-dismiss' }, 'Dismiss');
      close.onclick = function () { try { w.localStorage.setItem(dismissKey(), '1'); } catch (e) { /* no storage: hide for now */ } show(bar, false); };
      bar.appendChild(close);
    }
    var box = null;
    more.onclick = function () {
      if (box) { box.parentNode.removeChild(box); box = null; more.setAttribute('aria-expanded', 'false'); return; }
      box = el('div', { 'class': 'ti-compat-details' });
      function words(a) { return grep(a, function (x) { return !!x; }).join(' '); }
      box.appendChild(el('p', {}, 'This browser: ' + words([env.browser, env.version]) + ' on ' + (words([env.os, env.osVersion]) || 'an unknown OS') + (env.cpu ? ', ' + env.cpu : '') +
        (env.mobile ? ', a phone or tablet' : '') + '.'));
      if (env.mobile) box.appendChild(el('p', {}, PHONES));
      box.appendChild(featureTable());
      var c = loadCompat();
      box.appendChild(el('p', {}, 'Where the page was tested (tests/browsers/' + (c && c.generated ? ', results up to ' + c.generated : '') + '); hover a result for its date and reason:'));
      box.appendChild(matrix());
      bar.appendChild(box);
      more.setAttribute('aria-expanded', 'true');
    };
  }

  // After parsing: the data blocks are at the end of the body. Called from
  // <head> (later: when the async checks finish), where old IE may already
  // say "interactive", so only a later call trusts readyState.
  function whenReady(later) {
    if (doc.readyState === 'complete' || (later === true && doc.readyState !== 'loading')) render();
    else if (doc.addEventListener) doc.addEventListener('DOMContentLoaded', render, false);
    else w.attachEvent('onload', render);                     // IE 8 and before
  }
  function after() { whenReady(true); }
  if (pending.length && w.Promise) Promise.all(pending).then(after, after);
  else whenReady(false);
})();
