// The one-file site (tools/build_site.py) has the pages as sections: #<page>
// [&<params>] shows one (#new, #build&job=local-1). Links between pages
// were rewritten to that form when the file was made, and api.js's
// pageUrl() makes the same form.
import { apiLocal, apiReady } from './api.js';

export function startRouter() {
  const pages = Array.from(document.querySelectorAll('.ib-page'));
  if (!pages.length) return;
  // Mode A needs a build server: with none, Unsigned is chosen instead.
  const modeFits = () => {
    const ours = document.getElementById('mode-ours');
    const unsigned = document.getElementById('mode-unsigned');
    if (apiLocal() && ours && ours.checked && unsigned) {
      unsigned.checked = true;
      unsigned.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };
  apiReady().then(modeFits);
  window.addEventListener('ib-api-change', modeFits);

  function show() {
    const h = location.hash.slice(1);
    let name = h.split('&')[0];
    if (/^(job|ticket)=/.test(name)) name = 'build';       // an old-style build link
    const page = pages.find((p) => p.dataset.page === name) || pages[0];
    pages.forEach((p) => { p.hidden = p !== page; });
    document.title = page.dataset.title;
    document.querySelectorAll('.site-header nav a').forEach((a) => {
      if (a.getAttribute('href') === '#' + page.dataset.page) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    // "Write an app" links open the form on "I'll write it here".
    const write = document.getElementById('src-write');
    if (page.dataset.page === 'new' && write && /(^|&)write(&|$)/.test(h)) {
      write.checked = true;
      write.dispatchEvent(new Event('change', { bubbles: true }));
    }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', show);
  show();
}
