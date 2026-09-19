// CSS :has() for browsers without it (Firefox before 121, Safari before
// 15.4, EdgeHTML). The page's forms show and hide their parts with rules
// like `form:has(#tpl-web:checked) .tpl-web-only`, which such browsers
// drop whole.
//
// Only when CSS.supports('selector(:has(*))') is false: each inline
// <style> is rewritten so that every `X:has(S)` becomes `X.ibhasN`, and a
// script keeps class ibhasN on every ancestor of each element matching S
// (which is what :has means for a descendant S). The rewritten sheet
// replaces the original in place, so the cascade order is unchanged, and
// each replacement is padded to the specificity of the original. :is()
// inside :has() is expanded and :focus-visible becomes :focus, since the
// same browsers lack those too. Browsers with :has() are not touched.
//
//   convertCss(text) -> {css, probes: [{cls, sels}]}   (pure; for tests)
//   installHasShim(doc?) -> boolean                    (true if it ran)

export function needsShim(win) {
  const w = win || window;
  try { return !(w.CSS && w.CSS.supports && w.CSS.supports('selector(:has(*))')); } catch (e) { return true; }
}

// Index of the ')' matching the '(' at s[open], skipping strings.
function closeParen(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { i = s.indexOf(ch, i + 1); if (i < 0) return -1; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// Splits on commas outside parentheses, brackets and strings.
function splitTop(s) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { const j = s.indexOf(ch, i + 1); i = j < 0 ? s.length : j; continue; }
    if (ch === '\\') { i++; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

// One selector with each :is(a, b) expanded into a list of selectors.
function expandIs(sel) {
  const i = sel.indexOf(':is(');
  if (i < 0) return [sel];
  const j = closeParen(sel, i + 3);
  if (j < 0) return [sel];
  const out = [];
  for (const alt of splitTop(sel.slice(i + 4, j))) {
    for (const rest of expandIs(sel.slice(j + 1))) out.push(sel.slice(0, i) + alt + rest);
  }
  return out;
}

// Specificity [ids, classes, types] of a selector without :is/:has.
export function specificity(sel) {
  const sp = [0, 0, 0];
  let i = 0, typeAllowed = true;
  while (i < sel.length) {
    const ch = sel[i];
    if (ch === '#') { sp[0]++; i = skipIdent(sel, i + 1); typeAllowed = false; }
    else if (ch === '.') { sp[1]++; i = skipIdent(sel, i + 1); typeAllowed = false; }
    else if (ch === '[') { sp[1]++; i = sel.indexOf(']', i) + 1 || sel.length; typeAllowed = false; }
    else if (ch === ':') {
      if (sel[i + 1] === ':') { sp[2]++; i = skipIdent(sel, i + 2); }
      else {
        const e = skipIdent(sel, i + 1), name = sel.slice(i + 1, e).toLowerCase();
        if (sel[e] === '(') {
          const c = closeParen(sel, e);
          if (name === 'not') {
            let best = [0, 0, 0];
            for (const a of splitTop(sel.slice(e + 1, c))) best = maxSpec(best, specificity(a));
            add(sp, best);
          } else sp[1]++;
          i = c + 1;
        } else { sp[1]++; i = e; }
      }
      typeAllowed = false;
    } else if (ch === ' ' || ch === '>' || ch === '+' || ch === '~' || ch === '\t' || ch === '\n') { typeAllowed = true; i++; }
    else if (ch === '*') { i++; typeAllowed = false; }
    else if (typeAllowed && /[A-Za-z_-]/.test(ch)) { sp[2]++; i = skipIdent(sel, i); typeAllowed = false; }
    else i++;
  }
  return sp;
}
function skipIdent(s, i) {
  while (i < s.length && /[\w-]|\\/.test(s[i])) i += s[i] === '\\' ? 2 : 1;
  return i;
}
function add(a, b) { a[0] += b[0]; a[1] += b[1]; a[2] += b[2]; }
function maxSpec(a, b) {
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] > b[k] ? a : b;
  return a;
}

// Pieces that always match, adding the given specificity.
function pad(sp) {
  let s = '';
  for (let k = 0; k < sp[0]; k++) s += ':not(#ib-z)';
  for (let k = 0; k < sp[1]; k++) s += ':not(.ib-z)';
  for (let k = 0; k < sp[2]; k++) s += ':not(ib-z)';
  return s;
}

function Converter(first) {
  this.byArg = {};
  this.probes = [];
  this.first = first || 0;
}

// The class standing for :has(arg), and the arg's specificity.
Converter.prototype.probe = function (arg) {
  const key = arg.replace(/\s+/g, ' ').trim();
  let p = this.byArg[key];
  if (!p) {
    const sels = [];
    for (const a of splitTop(key)) for (const e of expandIs(a)) sels.push(e.replace(/:focus-visible\b/g, ':focus'));
    if (sels.some((x) => /^[>+~]/.test(x) || /:has\(/.test(x))) return null;   // relative :has(> x): not supported
    let sp = [0, 0, 0];
    for (const x of sels) sp = maxSpec(sp, specificity(x));
    p = { cls: 'ibhas' + (this.first + this.probes.length), sels, sp };
    this.byArg[key] = p;
    this.probes.push(p);
  }
  return p;
};

// A selector with its :has() replaced; null if it can't be.
Converter.prototype.selector = function (sel) {
  let out = '', i = 0;
  for (;;) {
    const not = sel.indexOf(':not(:has(', i), has = sel.indexOf(':has(', i);
    if (has < 0) { out += sel.slice(i); break; }
    if (not >= 0 && not + 5 === has) {
      const c = closeParen(sel, has + 4);
      const outer = closeParen(sel, not + 4);
      if (c < 0 || outer !== c + 1) return null;                  // :not(:has(a), b): not supported
      const p = this.probe(sel.slice(has + 5, c));
      if (!p) return null;
      const extra = [p.sp[0], Math.max(0, p.sp[1] - 1), p.sp[2]];
      out += sel.slice(i, not) + ':not(.' + p.cls + ')' + pad(extra);
      i = outer + 1;
    } else {
      const c = closeParen(sel, has + 4);
      if (c < 0) return null;
      const p = this.probe(sel.slice(has + 5, c));
      if (!p) return null;
      let cls = '.' + p.cls;
      for (let k = 1; k < p.sp[1]; k++) cls += '.' + p.cls;
      // (a :has() with no class weight, e.g. :has(#x), gets one class too many)
      out += sel.slice(i, has) + cls + pad([p.sp[0], 0, p.sp[2]]);
      i = c + 1;
    }
  }
  return out.replace(/:focus-visible\b/g, ':focus');
};

// Rewrites a block of rules; @media and @supports blocks recursively.
Converter.prototype.rules = function (css) {
  let out = '', i = 0;
  while (i < css.length) {
    const open = findBrace(css, i);
    if (open < 0) { out += css.slice(i); break; }
    const close = matchBrace(css, open);
    if (close < 0) { out += css.slice(i); break; }
    const prelude = css.slice(i, open), body = css.slice(open + 1, close);
    const pt = prelude.trim();
    if (/^@(media|supports|document)\b/i.test(pt)) out += prelude + '{' + this.rules(body) + '}';
    else if (pt[0] === '@' || (pt.indexOf(':has(') < 0 && pt.indexOf(':focus-visible') < 0)) out += prelude + '{' + body + '}';
    else {
      const sels = [];
      for (const s of splitTop(pt)) {
        const c = this.selector(s);
        if (c !== null) sels.push(c);
      }
      if (sels.length) out += prelude.slice(0, prelude.length - prelude.replace(/^\s+/, '').length) + sels.join(',\n') + ' {' + body + '}';
    }
    i = close + 1;
  }
  return out;
};

function findBrace(s, i) {
  for (; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { const j = s.indexOf(ch, i + 1); if (j < 0) return -1; i = j; }
    else if (ch === '{') return i;
  }
  return -1;
}
function matchBrace(s, open) {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") { const j = s.indexOf(ch, i + 1); if (j < 0) return -1; i = j; }
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

// first: the number of the first probe class (ibhas<first>).
export function convertCss(text, first) {
  const c = new Converter(first);
  const css = c.rules(text.replace(/\/\*[\s\S]*?\*\//g, ''));
  return { css, probes: c.probes.map((p) => ({ cls: p.cls, sels: p.sels })) };
}

// Keeps each probe's class on the ancestors of its matches.
function Mirror(doc, probes) {
  this.doc = doc;
  this.probes = probes;
  this.have = probes.map(() => []);
  this.pending = false;
}

Mirror.prototype.update = function () {
  this.pending = false;
  const root = this.doc.documentElement;
  for (let k = 0; k < this.probes.length; k++) {
    const p = this.probes[k], want = [];
    for (const sel of p.sels) {
      let list;
      try { list = this.doc.querySelectorAll(sel); } catch (e) { continue; }
      for (let i = 0; i < list.length; i++) {
        for (let el = list[i].parentElement; el; el = el.parentElement) {
          if (want.indexOf(el) >= 0) break;          // the rest of the chain is in already
          want.push(el);
          if (el === root) break;
        }
      }
    }
    const had = this.have[k];
    for (const el of had) if (want.indexOf(el) < 0) el.classList.remove(p.cls);
    for (const el of want) if (!el.classList.contains(p.cls)) el.classList.add(p.cls);
    this.have[k] = want;
  }
};

Mirror.prototype.schedule = function () {
  if (this.pending) return;
  this.pending = true;
  const self = this;
  Promise.resolve().then(() => self.update());
};

// Makes programmatic changes (el.checked = true, select.value = 'x') visible.
function hookSetter(proto, prop, fn) {
  const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
  if (!d || !d.set || !d.configurable) return;
  Object.defineProperty(proto, prop, {
    configurable: true, enumerable: d.enumerable, get: d.get,
    set(v) { d.set.call(this, v); fn(); },
  });
}

export function installHasShim(doc) {
  doc = doc || document;
  const win = doc.defaultView || window;
  if (!needsShim(win)) return false;
  const probes = [];
  const styles = doc.querySelectorAll('style');
  for (let i = 0; i < styles.length; i++) {
    const el = styles[i];
    const text = el.textContent;
    if (el.hasAttribute('data-ib-has-shim') || text.indexOf(':has(') < 0) continue;
    const conv = convertCss(text, probes.length);
    for (const p of conv.probes) probes.push(p);
    const s = doc.createElement('style');
    s.setAttribute('data-ib-has-shim', '');
    s.textContent = conv.css;
    el.parentNode.insertBefore(s, el.nextSibling);
    if (el.sheet) el.sheet.disabled = true;
  }
  if (!probes.length) return false;
  const m = new Mirror(doc, probes);
  const kick = () => m.schedule();
  for (const ev of ['change', 'input', 'click', 'focusin', 'focusout']) doc.addEventListener(ev, kick, true);
  doc.addEventListener('reset', () => setTimeout(kick, 0), true);
  hookSetter(win.HTMLInputElement && win.HTMLInputElement.prototype, 'checked', kick);
  hookSetter(win.HTMLSelectElement && win.HTMLSelectElement.prototype, 'value', kick);
  hookSetter(win.HTMLSelectElement && win.HTMLSelectElement.prototype, 'selectedIndex', kick);
  hookSetter(win.HTMLOptionElement && win.HTMLOptionElement.prototype, 'selected', kick);
  if (win.MutationObserver) {
    new win.MutationObserver(kick).observe(doc.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['checked', 'selected', 'value', 'id', 'name', 'disabled'],
    });
  }
  m.update();
  win.IB_HAS_SHIM = m;
  return true;
}
