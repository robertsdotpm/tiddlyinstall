// The DOM and platform pieces Internet Explorer 10 and 11 and Chrome 49 lack, for
// the one-file site's ES5 copy only (tools/es5/build-es5.mjs puts it after
// core-js's language polyfills and before the page's code; the ES2017 page
// never loads it). Plain ES5, each piece added only where missing or broken.
// Written for this project; no dependencies. docs/plan.md 1.11, "Older
// browsers".
//
// Random numbers: IE 11 has them as msCrypto.getRandomValues, which is
// exposed as crypto.getRandomValues. msCrypto.subtle is not exposed: it is
// IE's pre-standard WebCrypto (events, not promises), so the page's own
// JavaScript crypto (js/cryptox.js) does the hashing and signing. Without
// either, crypto.getRandomValues stays missing and everything that needs
// random numbers stays off (js/sign-ui.js offers no signing then); nothing
// here makes them up.
(function () {
  var w = window, d = document;
  function def(obj, name, fn) {
    if (obj && !(name in obj)) Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
  }

  /* ---------- crypto.getRandomValues from msCrypto (IE 11) ---------- */
  if (!w.crypto && w.msCrypto && w.msCrypto.getRandomValues) {
    var ms = w.msCrypto;
    w.crypto = { getRandomValues: function (a) { return ms.getRandomValues(a); } };
  }

  /* ---------- dataset (IE 10) ---------- */
  // Each read gives an object with a property per data-* attribute the
  // element has, read and written through to the attribute. A new key set
  // on it isn't kept (there is no Proxy), so the page adds data-* with
  // setAttribute (js/catalog-editor.js el()).
  var HP = w.HTMLElement && HTMLElement.prototype;
  if (HP && !('dataset' in d.documentElement)) {
    var camel = function (s) { return s.replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); };
    Object.defineProperty(HP, 'dataset', {
      configurable: true,
      get: function () {
        var el = this, o = {}, a = el.attributes;
        var prop = function (attr) {
          Object.defineProperty(o, camel(attr.slice(5)), {
            enumerable: true, configurable: true,
            get: function () { return el.getAttribute(attr); },
            set: function (v) { el.setAttribute(attr, String(v)); },
          });
        };
        for (var i = 0; i < a.length; i++) if (a[i].name.indexOf('data-') === 0) prop(a[i].name);
        return o;
      },
    });
  }

  /* ---------- the hidden property (IE 10) ---------- */
  // IE 10 knows no hidden attribute; the page's CSS hides [hidden]
  // (tools/build_site.py legacy_css), so the property sets the attribute.
  if (HP && !('hidden' in d.documentElement)) {
    Object.defineProperty(HP, 'hidden', {
      configurable: true,
      get: function () { return this.hasAttribute('hidden'); },
      set: function (v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); },
    });
  }

  /* ---------- Blob parts that are typed arrays (IE 10) ---------- */
  // IE 10's Blob takes ArrayBuffers but throws InvalidStateError for typed
  // arrays; each such part becomes a copy of the bytes it views.
  var NativeBlob = w.Blob, viewsOK = true;
  try { new NativeBlob([new Uint8Array(1)]); } catch (e) { viewsOK = false; }
  if (NativeBlob && !viewsOK) {
    var BlobFix = function Blob(parts, opts) {
      var p = [];
      for (var i = 0; parts && i < parts.length; i++) {
        var x = parts[i];
        p.push(x && !(x instanceof ArrayBuffer) && x.buffer instanceof ArrayBuffer && typeof x.byteOffset === 'number'
          ? x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) : x);
      }
      return opts === undefined ? new NativeBlob(p) : new NativeBlob(p, opts);
    };
    BlobFix.prototype = NativeBlob.prototype;
    w.Blob = BlobFix;
  }

  /* ---------- Event and CustomEvent constructors (IE 11) ---------- */
  function ctorWorks(C) { try { new C('x'); return true; } catch (e) { return false; } }
  if (!ctorWorks(w.Event)) {
    var NativeEvent = w.Event;
    var Ev = function Event(type, init) {
      init = init || {};
      var e = d.createEvent('Event');
      e.initEvent(type, !!init.bubbles, !!init.cancelable);
      return e;
    };
    if (NativeEvent) Ev.prototype = NativeEvent.prototype;
    w.Event = Ev;
  }
  if (!ctorWorks(w.CustomEvent)) {
    var NativeCustom = w.CustomEvent;
    var CEv = function CustomEvent(type, init) {
      init = init || {};
      var e = d.createEvent('CustomEvent');
      e.initCustomEvent(type, !!init.bubbles, !!init.cancelable, init.detail === undefined ? null : init.detail);
      return e;
    };
    if (NativeCustom) CEv.prototype = NativeCustom.prototype;
    w.CustomEvent = CEv;
  }

  /* ---------- Element: matches, closest, ChildNode and ParentNode ---------- */
  var EP = w.Element && Element.prototype;
  if (EP) {
    def(EP, 'matches', EP.msMatchesSelector || EP.webkitMatchesSelector);
    def(EP, 'closest', function (sel) {
      for (var el = this; el && el.nodeType === 1; el = el.parentNode) if (el.matches(sel)) return el;
      return null;
    });
  }
  function nodes(args) {
    var f = d.createDocumentFragment();
    for (var i = 0; i < args.length; i++) f.appendChild(typeof args[i] === 'string' ? d.createTextNode(args[i]) : args[i]);
    return f;
  }
  // ':scope' in querySelector(All) (IE 11 throws SyntaxError): the element
  // gets a unique attribute for the call, and :scope becomes a selector for it.
  var scopeOk = true;
  try { d.documentElement.querySelector(':scope > body'); } catch (e) { scopeOk = false; }
  if (!scopeOk && EP) {
    var seq = 0;
    var scoped = function (native) {
      return function (sel) {
        if (!/:scope\b/.test(sel)) return native.call(this, sel);
        var mark = 'data-ib-scope-' + (++seq);
        this.setAttribute(mark, '');
        try { return native.call(this, sel.replace(/:scope\b/g, '[' + mark + ']')); } finally { this.removeAttribute(mark); }
      };
    };
    EP.querySelector = scoped(EP.querySelector);
    EP.querySelectorAll = scoped(EP.querySelectorAll);
  }

  var kinds = [w.Element, w.CharacterData, w.DocumentType];
  for (var k = 0; k < kinds.length; k++) {
    var P = kinds[k] && kinds[k].prototype;
    if (!P) continue;
    def(P, 'remove', function () { if (this.parentNode) this.parentNode.removeChild(this); });
    def(P, 'before', function () { if (this.parentNode) this.parentNode.insertBefore(nodes(arguments), this); });
    def(P, 'after', function () { if (this.parentNode) this.parentNode.insertBefore(nodes(arguments), this.nextSibling); });
    def(P, 'replaceWith', function () { if (this.parentNode) this.parentNode.replaceChild(nodes(arguments), this); });
  }
  var parents = [w.Element, w.Document, w.DocumentFragment];
  for (var j = 0; j < parents.length; j++) {
    var PP = parents[j] && parents[j].prototype;
    if (!PP) continue;
    def(PP, 'append', function () { this.appendChild(nodes(arguments)); });
    def(PP, 'prepend', function () { this.insertBefore(nodes(arguments), this.firstChild); });
  }

  /* ---------- classList.toggle(name, force) (IE 11 ignores force) ---------- */
  if (w.DOMTokenList) {
    var probe = d.createElement('div');
    if (probe.classList && probe.classList.toggle('a', false) !== false) {
      var toggle = DOMTokenList.prototype.toggle;
      DOMTokenList.prototype.toggle = function (name, force) {
        if (arguments.length < 2) return toggle.call(this, name);
        if (force) this.add(name); else this.remove(name);
        return !!force;
      };
    }
  }

  /* ---------- location.origin (IE 11 on file://) ---------- */
  try {
    if (!w.location.origin) w.location.origin = w.location.protocol + '//' + w.location.host;
  } catch (e) { /* read-only: left as it is */ }

  /* ---------- downloads: <a download> with a blob: URL (IE 11) ---------- */
  // IE has no download attribute; navigator.msSaveOrOpenBlob saves a Blob
  // under a name. createObjectURL remembers each Blob by its URL, and a click
  // (a person's, or the page's own a.click()) on a download link to one saves
  // it that way instead of navigating to the blob: URL, which IE refuses.
  var saveBlob = w.navigator.msSaveOrOpenBlob || w.navigator.msSaveBlob;
  if (saveBlob && w.URL && URL.createObjectURL && !('download' in d.createElement('a'))) {
    // a.download = name would only set an expando: reflect it to the attribute.
    Object.defineProperty(HTMLAnchorElement.prototype, 'download', {
      configurable: true,
      get: function () { return this.getAttribute('download') || ''; },
      set: function (v) { this.setAttribute('download', v); },
    });
    var blobs = {}, create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    URL.createObjectURL = function (b) { var u = create.call(URL, b); blobs[u] = b; return u; };
    URL.revokeObjectURL = function (u) { delete blobs[u]; return revoke.call(URL, u); };
    d.addEventListener('click', function (e) {
      var a = e.target;
      while (a && a.nodeName !== 'A') a = a.parentNode;
      if (!a || !a.getAttribute('download')) return;
      var b = blobs[a.getAttribute('href')];
      if (!b) return;
      e.preventDefault();
      // Looked up at the call, so a test can capture what's saved.
      (w.navigator.msSaveOrOpenBlob || w.navigator.msSaveBlob).call(w.navigator, b, a.getAttribute('download'));
    }, true);
  }

  /* ---------- fetch, over XMLHttpRequest (IE 11) ---------- */
  // What the page asks of it: GET/POST with headers and a string, Blob or
  // typed-array body; ok, status, headers.get, json(), text(), arrayBuffer(),
  // blob(); an AbortController signal. No streaming.
  if (!w.fetch) {
    var Resp = function (xhr, url) {
      this.status = xhr.status;
      this.ok = xhr.status >= 200 && xhr.status < 300;
      this.statusText = xhr.statusText;
      this.url = url;
      this._buf = xhr.response;
      var raw = xhr.getAllResponseHeaders() || '', h = {};
      raw.replace(/^([^:\r\n]+):\s*(.*)$/gm, function (_, k, v) { h[k.toLowerCase()] = v; return _; });
      this.headers = { get: function (k) { k = String(k).toLowerCase(); return k in h ? h[k] : null; }, has: function (k) { return String(k).toLowerCase() in h; } };
    };
    Resp.prototype.arrayBuffer = function () { return Promise.resolve(this._buf); };
    Resp.prototype.text = function () { var b = this._buf; return Promise.resolve(new TextDecoder().decode(new Uint8Array(b))); };
    Resp.prototype.json = function () { return this.text().then(JSON.parse); };
    Resp.prototype.blob = function () { return Promise.resolve(new Blob([this._buf])); };
    w.fetch = function (input, init) {
      init = init || {};
      var url = typeof input === 'string' ? input : input.url;
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open(init.method || 'GET', url, true);
        xhr.responseType = 'arraybuffer';
        var hs = init.headers || {};
        if (typeof hs.forEach === 'function' && !(hs instanceof Array)) hs.forEach(function (v, k) { xhr.setRequestHeader(k, v); });
        else for (var k in hs) if (Object.prototype.hasOwnProperty.call(hs, k)) xhr.setRequestHeader(k, hs[k]);
        if (init.credentials === 'include') xhr.withCredentials = true;
        xhr.onload = function () { resolve(new Resp(xhr, url)); };
        xhr.onerror = function () { reject(new TypeError('Failed to fetch')); };
        xhr.ontimeout = xhr.onerror;
        var sig = init.signal;
        if (sig) {
          if (sig.aborted) { reject(new Error('The operation was aborted.')); return; }
          sig.addEventListener('abort', function () { xhr.abort(); var e = new Error('The operation was aborted.'); e.name = 'AbortError'; reject(e); });
        }
        var body = init.body;
        if (body instanceof ArrayBuffer || (body && body.buffer instanceof ArrayBuffer)) body = new Blob([body]);
        xhr.send(body === undefined ? null : body);
      });
    };
  }

  /* ---------- RadioNodeList (IE 11) ---------- */
  // form.elements[name] for a group of radios is an HTMLCollection in IE,
  // with no value; the page tests `instanceof RadioNodeList` and reads
  // .value. A group of radios is what that name means here.
  if (!w.RadioNodeList && w.HTMLCollection) {
    w.RadioNodeList = function RadioNodeList() { throw new TypeError('Illegal constructor'); };
    w.RadioNodeList.prototype = HTMLCollection.prototype;
    if (!('value' in HTMLCollection.prototype)) {
      Object.defineProperty(HTMLCollection.prototype, 'value', {
        configurable: true,
        get: function () { for (var i = 0; i < this.length; i++) if (this[i].checked) return this[i].value; return ''; },
        set: function (v) { for (var i = 0; i < this.length; i++) if (this[i].value === String(v)) { this[i].checked = true; return; } },
      });
    }
  }
})();
