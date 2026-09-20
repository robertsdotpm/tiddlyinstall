(function () {
  var E = []; window.__tiErrors = E;
  window.onerror = function (m, u, l) { E.push(String(m) + ' @' + String(u || '').slice(-40) + ':' + l); };
  var B = 'http://127.0.0.1:38517/r', seq = 0;
  function send(k, v) {
    var s = String(v), n = 0, i;
    for (i = 0; i < s.length || i === 0; i += 1500, n++) {
      (new Image()).src = B + '?k=' + encodeURIComponent(k) + '&n=' + n + '&q=' + (seq++) + '&v=' + encodeURIComponent(s.slice(i, i + 1500));
    }
  }
  send('start', navigator.userAgent);
  function cs(e, p) { try { return window.getComputedStyle(e, null)[p]; } catch (x) { return '?'; } }
  function cls(e, c) { return (' ' + e.className + ' ').indexOf(' ' + c + ' ') >= 0; }
  function report(tag) {
    try {
      var d = document, h = d.documentElement, all = d.getElementsByTagName('*'), bar = null, pages = [], i;
      for (i = 0; i < all.length; i++) {
        if (!bar && cls(all[i], 'ti-compat-bar')) bar = all[i];
        if (cls(all[i], 'ti-page')) pages.push(all[i].getAttribute('data-page') + ':' + (all[i].offsetHeight > 0 ? 'shown' : 'hidden'));
      }
      var body = d.body, txt = body ? (body.innerText || body.textContent || '') : '';
      var links = [];
      if (bar) { var as = bar.getElementsByTagName('a'); for (i = 0; i < as.length; i++) links.push((as[i].innerText || as[i].textContent) + ' -> ' + as[i].href); }
      var h1 = d.getElementsByTagName('h1')[0];
      send('state-' + tag, [
        'missing=' + h.getAttribute('data-ti-missing'), 'ready=' + h.getAttribute('data-ti-ready'), 'degraded=' + h.getAttribute('data-ti-degraded'),
        'htmlclass=' + h.className, 'errattr=' + h.getAttribute('data-ti-errors'),
        'bar=' + (bar ? bar.className : 'none'), 'barbox=' + (bar ? bar.offsetWidth + 'x' + bar.offsetHeight + ' display=' + cs(bar, 'display') + ' bg=' + cs(bar, 'backgroundColor') : ''),
        'bartext=' + (bar ? (bar.innerText || bar.textContent || '') : ''), 'barlinks=' + links.join(' ; '),
        'pages=' + pages.join(','), 'h1=' + (h1 ? (h1.innerText || h1.textContent) + ' ' + cs(h1, 'color') : 'none'),
        'body=' + txt.length + ' chars, ' + cs(body, 'color') + ' on ' + cs(body, 'backgroundColor') + ', font ' + cs(body, 'fontFamily'),
        'htmlbg=' + cs(h, 'backgroundColor'),
        'bodystart=' + txt.replace(/\s+/g, ' ').slice(0, 400),
        'scripts=' + d.getElementsByTagName('script').length + ' ES5copy=' + (window.tiCompat ? window.tiCompat.es5 : 'no tiCompat'),
        'errors=' + E.join(' | ')
      ].join('\n'));
    } catch (e) { send('reporterr', String(e && e.message || e)); }
  }
  window.setTimeout(function () { report('5s'); }, 5000);
  window.setTimeout(function () { report('20s'); }, 20000);
})();
