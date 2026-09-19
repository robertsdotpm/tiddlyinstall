// The few newer built-ins the page uses, for older browsers (Firefox 52 ESR,
// Chrome 49-, Safari 12, EdgeHTML 18). Each is added only when missing, so
// modern browsers keep their own. Runs first in the one-file page.
// Written for this project; no dependencies.

(function () {
  const G = typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : window;
  if (typeof globalThis === 'undefined') G.globalThis = G;           // Chrome 71, Firefox 65, Safari 12.1

  const def = (obj, name, fn) => {
    if (obj && !(name in obj)) Object.defineProperty(obj, name, { value: fn, configurable: true, writable: true });
  };

  def(Object, 'hasOwn', (o, k) => Object.prototype.hasOwnProperty.call(o, k));      // Chrome 93, Firefox 92
  def(Object, 'fromEntries', (it) => {                                              // Chrome 73, Firefox 63
    const o = {};
    for (const kv of it) o[kv[0]] = kv[1];
    return o;
  });

  function flat(depth) {                                                            // Chrome 69, Firefox 62
    const d = depth === undefined ? 1 : Number(depth);
    const out = [];
    (function walk(a, n) {
      for (let i = 0; i < a.length; i++) {
        if (!(i in a)) continue;
        if (Array.isArray(a[i]) && n > 0) walk(a[i], n - 1); else out.push(a[i]);
      }
    })(this, d);
    return out;
  }
  def(Array.prototype, 'flat', flat);
  def(Array.prototype, 'flatMap', function (fn, thisArg) {
    return flat.call(Array.prototype.map.call(this, fn, thisArg), 1);
  });

  // An array of the matches (an array is iterable, which is all the page needs).
  def(String.prototype, 'matchAll', function (re) {                                 // Chrome 73, Firefox 67
    if (!(re instanceof RegExp)) re = new RegExp(re, 'g');
    else if (!re.global) throw new TypeError('matchAll needs a global regular expression');
    const r = new RegExp(re.source, re.flags), s = String(this), out = [];
    for (let m; (m = r.exec(s));) {
      out.push(m);
      if (m[0] === '') r.lastIndex++;
    }
    return out;
  });

  if (typeof Element !== 'undefined') {
    def(Element.prototype, 'replaceChildren', function () {                         // Chrome 86, Firefox 78, Safari 14
      while (this.firstChild) this.removeChild(this.firstChild);
      for (let i = 0; i < arguments.length; i++) {
        const k = arguments[i];
        this.appendChild(typeof k === 'string' ? document.createTextNode(k) : k);
      }
    });
    def(Element.prototype, 'toggleAttribute', function (name, force) {              // Chrome 69, Firefox 63
      const on = force === undefined ? !this.hasAttribute(name) : !!force;
      if (on) this.setAttribute(name, ''); else this.removeAttribute(name);
      return on;
    });
  }

  // Blob/File reading (Chrome 76, Firefox 69, Safari 14): FileReader instead.
  if (typeof Blob !== 'undefined' && typeof FileReader !== 'undefined') {
    const read = (blob, how) => new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error);
      fr[how](blob);
    });
    def(Blob.prototype, 'arrayBuffer', function () { return read(this, 'readAsArrayBuffer'); });
    def(Blob.prototype, 'text', function () { return read(this, 'readAsText'); });
  }

  // UTF-8 only, as the page uses them (EdgeHTML has neither). Invalid input
  // decodes to U+FFFD and a leading BOM is dropped, like the real ones.
  if (typeof G.TextEncoder === 'undefined') {
    G.TextEncoder = function TextEncoder() {};
    G.TextEncoder.prototype.encoding = 'utf-8';
    G.TextEncoder.prototype.encode = function (str) {
      const s = String(str === undefined ? '' : str), out = [];
      for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
          c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
        } else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
        else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
      return new Uint8Array(out);
    };
  }
  if (typeof G.TextDecoder === 'undefined') {
    G.TextDecoder = function TextDecoder(label) {
      if (label !== undefined && !/^\s*utf-?8\s*$/i.test(label)) throw new RangeError('This TextDecoder only knows UTF-8');
    };
    G.TextDecoder.prototype.encoding = 'utf-8';
    G.TextDecoder.prototype.decode = function (buf) {
      const b = buf === undefined ? new Uint8Array(0) : buf instanceof Uint8Array ? buf
        : ArrayBuffer.isView(buf) ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) : new Uint8Array(buf);
      let s = '', i = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? 3 : 0;
      const chunk = [];
      const flush = () => { s += String.fromCharCode.apply(null, chunk); chunk.length = 0; };
      // The WHATWG UTF-8 decoder, step for step.
      let need = 0, seen = 0, cp = 0, lo = 0x80, hi = 0xbf;
      const emit = (c) => {
        if (c >= 0x10000) { c -= 0x10000; chunk.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); } else chunk.push(c);
        if (chunk.length > 8000) flush();
      };
      for (; i < b.length; i++) {
        const x = b[i];
        if (!need) {
          if (x < 0x80) emit(x);
          else if (x >= 0xc2 && x <= 0xdf) { need = 1; cp = x & 31; }
          else if (x >= 0xe0 && x <= 0xef) { if (x === 0xe0) lo = 0xa0; if (x === 0xed) hi = 0x9f; need = 2; cp = x & 15; }
          else if (x >= 0xf0 && x <= 0xf4) { if (x === 0xf0) lo = 0x90; if (x === 0xf4) hi = 0x8f; need = 3; cp = x & 7; }
          else emit(0xfffd);
          continue;
        }
        if (x < lo || x > hi) {
          need = seen = cp = 0; lo = 0x80; hi = 0xbf;
          emit(0xfffd);
          i--;                       // this byte starts again
          continue;
        }
        lo = 0x80; hi = 0xbf;
        cp = (cp << 6) | (x & 63);
        if (++seen === need) { emit(cp); need = seen = cp = 0; }
      }
      if (need) emit(0xfffd);
      flush();
      return s;
    };
  }

  def(Promise.prototype, 'finally', function (fn) {                                 // Chrome 63, Firefox 58
    return this.then((v) => Promise.resolve(fn()).then(() => v), (e) => Promise.resolve(fn()).then(() => { throw e; }));
  });

  // AbortController (Chrome 66, Firefox 57, Safari 12.1): a stand-in whose
  // abort() only marks the signal; fetch then runs to its own end.
  if (typeof AbortController === 'undefined') {
    G.AbortController = function () {
      const listeners = [];
      this.signal = {
        aborted: false,
        addEventListener(t, f) { if (t === 'abort') listeners.push(f); },
        removeEventListener(t, f) { const i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
      };
      this.abort = () => {
        if (this.signal.aborted) return;
        this.signal.aborted = true;
        listeners.forEach((f) => { try { f(); } catch (e) { /* ignore */ } });
      };
    };
  }
})();
