// Copy to clipboard, for the browsers this page supports.
//
// navigator.clipboard is not the main path here, it is the lucky one: it
// exists only in a secure context, and this page is normally served over
// plain http on a LAN (policy.mirror_base, docs/design.md 11.2) where
// window.isSecureContext is false and navigator.clipboard is undefined.
// Firefox 52 and IE 11, both inside the browser floor, never have it at
// all. So the textarea + execCommand('copy') path below is the one that
// actually runs most of the time, and it is written to be the default
// rather than a grudging fallback.

function viaTextarea(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  // Off-screen but focusable: display:none or visibility:hidden cannot be
  // selected, and a textarea at the top of the viewport scrolls the page.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  // Whatever the reader had selected is theirs; put it back afterwards.
  const sel = typeof document.getSelection === 'function' ? document.getSelection() : null;
  const prev = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
  let ok = false;
  try {
    ta.select();
    if (ta.setSelectionRange) ta.setSelectionRange(0, ta.value.length);
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  document.body.removeChild(ta);
  if (sel && prev) {
    try { sel.removeAllRanges(); sel.addRange(prev); } catch (e) { /* nothing to restore */ }
  }
  return ok;
}

// Resolves true when the text is on the clipboard, false when it is not.
// Never rejects: a copy button that throws is worse than one that says no.
export function copyText(text) {
  const s = String(text == null ? '' : text);
  const c = globalThis.navigator && navigator.clipboard;
  if (c && c.writeText && globalThis.isSecureContext) {
    return c.writeText(s).then(function () { return true; }, function () { return viaTextarea(s); });
  }
  return Promise.resolve(viaTextarea(s));
}

// Element.closest is in the floor (Firefox 52, Chrome 58) but not IE 11,
// which reaches this through the ES5 copy, so walk up by hand.
function copyTargetFor(el) {
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    if (n.hasAttribute && n.hasAttribute('data-copy')) return n;
  }
  return null;
}

// One delegated listener for every [data-copy] button, including ones
// rendered later (the downloads table is redrawn on every poll).
export function mountCopyButtons(root) {
  const host = root || document;
  if (host.tiCopyMounted) return;
  host.tiCopyMounted = true;
  host.addEventListener('click', function (e) {
    const btn = copyTargetFor(e.target);
    if (!btn) return;
    e.preventDefault();
    const was = btn.getAttribute('data-copy-label') || btn.textContent;
    btn.setAttribute('data-copy-label', was);
    copyText(btn.getAttribute('data-copy')).then(function (ok) {
      // Say which happened. "Copy" that silently did nothing is the
      // failure this whole file exists to avoid.
      btn.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      btn.classList.add(ok ? 'copied' : 'copy-failed');
      if (!ok) return;
      setTimeout(function () {
        btn.textContent = was;
        btn.classList.remove('copied');
      }, 1600);
    });
  });
}
