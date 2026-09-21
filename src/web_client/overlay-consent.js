// Asks, once per session, before catalogue changes found in this browser's
// storage are used (design.md 11.0 item 3; the gate itself is in
// src/web_client/overlay.js, which keeps them out of every build and preview until this
// is answered).
//
// Why: pages opened from disk share one localStorage in Chrome, so another
// local HTML file could plant changes that a saved TiddlyInstall would then
// build with. Changes made here, and changes baked into the page file by
// "Save this page", are the person's own and are never asked about.
//
// The panel goes above the header, like the outage banner, so it shows
// whichever page of the one-file site is open, and lists what the changes
// do with the Runtimes page's own change list (src/web_client/change-list.js).
import { pageUrl } from './api.js';
import { overlayState, answerStored, loadOverlay, hasCatalog, baseFiles } from './overlay.js';
import { el, changeItem } from './change-list.js';

let box = null;
let files = null;

function paint() {
  if (!box) return;
  const st = overlayState();
  const n = st.pending.length;
  if (st.consent !== 'ask' || !n) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  const link = el('a', { href: pageUrl('runtimes.html'), text: 'Sources page' });
  // (replaceChildren would write a "null" of its own, so they are filtered.)
  const kids = [
    el('p', { class: 'overlay-ask-head' },
      el('strong', { text: n + ' catalogue change' + (n === 1 ? '' : 's') + ' found in this browser' }),
      ' - not used yet.'),
    el('p', { class: 'small' },
      'They were saved here by a page on this computer, and they decide what the installers you build download and run. ',
      'Use them only if you made them yourself on the ', link, '.'),
    el('ul', { class: 'rt-change-list' }, ...st.pending.slice(0, 20).map((c) => changeItem(c, { files, badge: '' }))),
    n > 20 ? el('p', { class: 'small muted', text: 'and ' + (n - 20) + ' more.' }) : null,
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'overlay-ask-yes', text: 'Use these changes', onclick: () => answerStored(true) }),
      el('button', { type: 'button', class: 'secondary overlay-ask-no', text: 'Not now', onclick: () => answerStored(false) })),
    el('p', { class: 'small muted', text: 'Either way the answer lasts for this tab only. "Not now" leaves them in this browser, unused; changing the catalogue here replaces them.' })];
  box.replaceChildren(...kids.filter((k) => k));
  box.hidden = false;
}

// Called by every page that can build with the catalogue (src/web_client/new.js,
// src/web_client/build.js, src/web_client/catalog-editor.js); the first call does the work.
export function mountOverlayConsent() {
  if (box) return;
  box = el('div', { class: 'overlay-ask', role: 'region', 'aria-label': 'Catalogue changes found in this browser' });
  box.hidden = true;
  document.body.prepend(box);
  window.addEventListener('ti-overlay-change', paint);
  // Labels for the change list come from the catalogue's shared files, which
  // need no runtime folder unpacked.
  const ready = hasCatalog() ? baseFiles().then((f) => { files = f; }, () => {}) : Promise.resolve();
  ready.then(loadOverlay).then(paint, () => {});
}
