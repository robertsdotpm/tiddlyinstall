// Dialogs that coexist with the hash router.
//
// The obvious way -- <a href="#thing"> plus :target -- does not work in
// this page and never has. router.js reads the hash as a page name and
// sends anything it does not recognise to pages[0], the home page, which
// then hides the page the dialog is inside. Measured 2026-09-22 on the
// Run preview: after clicking it, location.hash was "#run-output", the
// overlay matched :target and computed display:flex, the New page was
// hidden, Home was shown, and the overlay's box was 0x0. It looked wired
// up in the markup and in the CSS, and opened nothing.
//
// So dialogs are opened by script, and the hash is left alone.
//
// The panel keeps its content in normal flow until this runs, and only
// then folds into a dialog with an opener. Not for the no-JavaScript
// case -- that is served the build server's /classic form, which is a
// different page and never had this list -- but so that the content is
// never hidden by markup alone: if this module fails to load, or throws
// before mounting, or the reader is in the moment before the bundle
// runs, the panel is still on the page and still readable. A dialog that
// starts hidden in the HTML is a dialog that is gone for good when the
// script that opens it does not arrive.

const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

// mountDialog({ panel, opener, closers, onOpen })
//   panel   the element holding the content; gets .is-dialog
//   opener  the control that opens it; unhidden here, hidden in the HTML
//   closers extra elements that close it (a x button, a Done button)
// Returns { open, close } for callers that need to drive it.
export function mountDialog(opts) {
  const panel = opts.panel;
  const opener = opts.opener;
  if (!panel || !opener) return null;

  panel.classList.add('is-dialog');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  // reveal:false leaves the opener's visibility to whoever already owns it
  // -- write-editor.js hides .run-link for templates that cannot run, and
  // unhiding it here would quietly undo that.
  if (opts.reveal !== false) opener.hidden = false;
  opener.setAttribute('aria-haspopup', 'dialog');
  opener.setAttribute('aria-expanded', 'false');

  let lastFocus = null;

  function open() {
    lastFocus = document.activeElement;
    panel.hidden = false;
    // The class is separate from .hidden so the open state can be
    // transitioned later without the element being display:none first.
    panel.classList.add('open');
    opener.setAttribute('aria-expanded', 'true');
    if (opts.onOpen) opts.onOpen(panel);
    const first = panel.querySelector(focusable);
    if (first) first.focus();
    document.addEventListener('keydown', onKey, true);
  }

  function close() {
    if (panel.hidden) return;
    panel.classList.remove('open');
    panel.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKey, true);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // Keep Tab inside the dialog: a modal you can tab out of, into a form
    // you cannot see, is worse than no modal.
    const items = Array.prototype.filter.call(panel.querySelectorAll(focusable),
      (el) => el.offsetWidth > 0 || el.offsetHeight > 0);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  opener.addEventListener('click', (e) => { e.preventDefault(); open(); });
  // Clicking the backdrop -- the panel itself, not the dialog box inside.
  panel.addEventListener('click', (e) => { if (e.target === panel) close(); });
  const list = opts.closers || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i]) list[i].addEventListener('click', (e) => { e.preventDefault(); close(); });
  }
  return { open, close };
}
