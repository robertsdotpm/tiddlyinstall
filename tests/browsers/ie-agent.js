// Drives Internet Explorer through COM automation (InternetExplorer.Application)
// for tests/browsers/ie.mjs, which runs it on a Windows test machine over SSH:
//
//   cscript //nologo //E:JScript ie-agent.js
//
// Windows Script Host JScript (ES3; no JSON object). It reads one command per
// line on stdin and answers each with one line on stdout:
//
//   NAV <url>        navigate, wait for readyState 4     -> OK <json info>
//   EVAL <code>      run <code> (newlines sent as \x01, ASCII only) in the
//                    page as a <script>; the code sets
//                    <html data-ti-out="...">, which is returned -> R <string>
//   DOM              what's on the page, read over COM (works when the
//                    page's scripts don't run)         -> OK <json>
//   SHOT <path>      (unused: no desktop in an SSH session)
//   QUIT             close IE and exit
//
// No IE settings are changed: IE runs as the SSH user, hidden, with
// Silent on (no script-error dialogs).
var ie = null;

function q(s) {
  s = String(s);
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i), n = s.charCodeAt(i);
    if (c === '"' || c === '\\') out += '\\' + c;
    else if (n < 32 || n > 126) { var h = n.toString(16); while (h.length < 4) h = '0' + h; out += '\\u' + h; }
    else out += c;
  }
  return out + '"';
}
function json(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return q(v);
  if (v instanceof Array) { var a = []; for (var i = 0; i < v.length; i++) a.push(json(v[i])); return '[' + a.join(',') + ']'; }
  var parts = [];
  for (var k in v) parts.push(q(k) + ':' + json(v[k]));
  return '{' + parts.join(',') + '}';
}
function say(s) { WScript.StdOut.WriteLine(s); }

function start() {
  if (ie) return;
  ie = new ActiveXObject('InternetExplorer.Application');
  ie.Silent = true;
  ie.Visible = false;
  ie.Width = 1280; ie.Height = 900;
}

// Ready when IE says so; or when the document has been complete for 5 s
// (on Windows Server, IE's Enhanced Security Configuration keeps it Busy).
function waitReady(ms) {
  var end = new Date().getTime() + ms, since = 0;
  while (new Date().getTime() < end) {
    try {
      var done = ie.Document && ie.Document.readyState === 'complete';
      if (done && !ie.Busy && ie.ReadyState === 4) return true;
      if (!done) since = 0; else if (!since) since = new Date().getTime(); else if (new Date().getTime() - since > 5000) return true;
    } catch (e) { since = 0; /* navigating */ }
    WScript.Sleep(100);
  }
  return false;
}

function info(ok) {
  var d = null, r = { ready: ok };
  try { r.url = String(ie.LocationURL); } catch (e) { r.url = ''; }
  try { d = ie.Document; r.title = String(d.title); r.documentMode = d.documentMode; r.readyState = d.readyState; } catch (e) { r.err = String(e.message); }
  return r;
}

function dom() {
  var d = ie.Document, r = {}, h = d.documentElement;
  r.title = String(d.title);
  r.documentMode = d.documentMode;
  r.missing = h.getAttribute('data-ti-missing');
  r.degraded = h.getAttribute('data-ti-degraded');
  r.ready = h.getAttribute('data-ti-ready');
  r.htmlClass = String(h.className);
  var bar = null;
  try { bar = d.querySelector ? d.querySelector('.ti-compat-bar') : null; } catch (e) { bar = null; }
  if (!bar) {
    var divs = d.getElementsByTagName('div');
    for (var i = 0; i < divs.length; i++) if (/\bti-compat-bar\b/.test(divs[i].className)) { bar = divs[i]; break; }
  }
  r.bar = bar ? { text: String(bar.innerText), className: String(bar.className), shown: bar.offsetHeight > 0 } : null;
  // What a person sees: the visible text, and which sections show.
  var body = d.body;
  r.bodyText = body ? String(body.innerText).substring(0, 4000) : '';
  var shown = [], all = d.getElementsByTagName('div');
  for (var j = 0; j < all.length; j++) {
    var p = all[j].getAttribute('data-page');
    if (p) shown.push(p + (all[j].offsetHeight > 0 ? ':shown' : ':hidden'));
  }
  r.sections = shown;
  // Colours of the body text as IE computes them (currentStyle: IE6+).
  try { r.colors = { body: String(body.currentStyle.color) + ' on ' + String(body.currentStyle.backgroundColor) }; } catch (e) { r.colors = null; }
  r.errors = h.getAttribute('data-ti-errors');
  return r;
}

function evalIn(code) {
  var d = ie.Document, h = d.documentElement;
  h.removeAttribute('data-ti-out');
  var s = d.createElement('script');
  s.text = code;
  (d.body || h).appendChild(s);
  var v = h.getAttribute('data-ti-out');
  try { s.parentNode.removeChild(s); } catch (e) { /* gone with a navigation */ }
  h.removeAttribute('data-ti-out');
  return v === null || v === undefined ? 'null' : String(v);
}

while (!WScript.StdIn.AtEndOfStream) {
  var line = WScript.StdIn.ReadLine(), sp = line.indexOf(' ');
  var cmd = sp < 0 ? line : line.substring(0, sp), arg = sp < 0 ? '' : line.substring(sp + 1);
  try {
    if (cmd === 'NAV') { start(); ie.Navigate(arg); WScript.Sleep(300); say('OK ' + json(info(waitReady(300000)))); }
    else if (cmd === 'EVAL') say('R ' + evalIn(arg.split('\x01').join('\n')));
    else if (cmd === 'DOM') say('OK ' + json(dom()));
    else if (cmd === 'VERSION') { var sh = new ActiveXObject('WScript.Shell'), v = ''; try { v = sh.RegRead('HKLM\\SOFTWARE\\Microsoft\\Internet Explorer\\svcVersion'); } catch (e) { v = sh.RegRead('HKLM\\SOFTWARE\\Microsoft\\Internet Explorer\\Version'); } say('OK ' + json({ version: v })); }
    else if (cmd === 'QUIT') { if (ie) { try { ie.Quit(); } catch (e) { /* gone */ } } say('OK {}'); break; }
    else say('ERR ' + json('unknown command ' + cmd));
  } catch (e) {
    say('ERR ' + json(String(e.message || e) + ' (' + (e.number & 0xFFFF) + ')'));
  }
}
