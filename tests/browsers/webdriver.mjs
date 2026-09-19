// A small W3C WebDriver client: fetch only, no dependencies.
// https://www.w3.org/TR/webdriver2/
//
//   const s = await Session.create('http://127.0.0.1:4444', capabilities);
//   await s.navigate('file:///C:/x/page.html');
//   const v = await s.run('return 1 + 1');            // execute/sync
//   const w = await s.runAsync('arguments[0](2)');    // execute/async
//   await s.delete();
//
// Errors are WebDriverError with the W3C error code (`e.code`, e.g.
// 'session not created') and the driver's message.

export class WebDriverError extends Error {
  constructor(code, message, data) {
    super(code + ': ' + String(message || '').split('\n')[0].slice(0, 500));
    this.code = code;
    this.data = data;
  }
}

// The W3C key for an element reference.
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export async function wd(base, method, path, body, { timeout = 300000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  let res, text;
  try {
    res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    text = await res.text();
  } catch (e) {
    throw new WebDriverError(ctl.signal.aborted ? 'timeout' : 'no connection', `${method} ${path}: ${e.cause ? e.cause.code || e.cause.message : e.message}`);
  } finally {
    clearTimeout(t);
  }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new WebDriverError('bad response', `${method} ${path}: HTTP ${res.status}: ${text.slice(0, 300)}`); }
  const v = json && 'value' in json ? json.value : json;
  // W3C: errors are {value: {error, message}}; the old wire protocol used a
  // non-zero `status`.
  if (v && typeof v === 'object' && v.error) throw new WebDriverError(v.error, v.message, v.data);
  if (json && typeof json.status === 'number' && json.status !== 0) throw new WebDriverError('status ' + json.status, v && v.message);
  if (!res.ok) throw new WebDriverError('http ' + res.status, text.slice(0, 300));
  return json;
}

export async function waitForDriver(base, ms = 30000) {
  let last;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) {
    try { return (await wd(base, 'GET', '/status', undefined, { timeout: 5000 })).value; } catch (e) { last = e; }
  }
  throw new WebDriverError('driver not ready', last ? last.message : 'no answer');
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Session {
  constructor(base, id, capabilities) {
    this.base = base;
    this.id = id;
    this.capabilities = capabilities || {};
  }

  static async create(base, alwaysMatch, { timeout = 180000 } = {}) {
    const j = await wd(base, 'POST', '/session', { capabilities: { alwaysMatch }, desiredCapabilities: alwaysMatch }, { timeout });
    const v = j.value || {};
    const id = v.sessionId || j.sessionId;
    if (!id) throw new WebDriverError('session not created', JSON.stringify(j).slice(0, 300));
    return new Session(base, id, v.capabilities || v);
  }

  get browserVersion() { return this.capabilities.browserVersion || this.capabilities.version || ''; }

  async cmd(method, path, body, opts) {
    return (await wd(this.base, method, `/session/${this.id}${path}`, body, opts)).value;
  }

  setTimeouts(t) { return this.cmd('POST', '/timeouts', t); }
  navigate(url) { return this.cmd('POST', '/url', { url }); }
  url() { return this.cmd('GET', '/url'); }
  title() { return this.cmd('GET', '/title'); }
  run(script, args = []) { return this.cmd('POST', '/execute/sync', { script, args }); }
  runAsync(script, args = [], opts) { return this.cmd('POST', '/execute/async', { script, args }, opts); }

  async find(css) {
    const v = await this.cmd('POST', '/element', { using: 'css selector', value: css });
    return v[ELEMENT] || v.ELEMENT;
  }
  click(el) { return this.cmd('POST', `/element/${el}/click`, {}); }
  // For <input type=file>: the path is on the machine the browser runs on.
  sendKeys(el, text) { return this.cmd('POST', `/element/${el}/value`, { text, value: text.split('') }); }

  async delete() {
    try { await this.cmd('DELETE', '', undefined, { timeout: 60000 }); } catch (e) { /* already gone */ }
  }
}

// Runs `expr` (a JavaScript expression, which may be a promise) in the page
// and returns its value. Built on execute/async, so it works in browsers
// whose execute/sync doesn't await promises. The value must be JSON-able.
export async function evalIn(session, expr, { timeout = 300000 } = {}) {
  const script =
    'var done = arguments[arguments.length - 1];' +
    'try { Promise.resolve(eval(arguments[0])).then(' +
    'function (v) { done({ ok: true, v: v === undefined ? null : v }); },' +
    'function (e) { done({ ok: false, e: String(e && (e.stack || e.message) || e) }); }); }' +
    'catch (e) { done({ ok: false, e: String(e && (e.stack || e.message) || e) }); }';
  const r = await session.runAsync(script, ['(' + expr + ')'], { timeout: timeout + 30000 });
  if (!r || !r.ok) throw new Error('in page: ' + String(r && r.e).slice(0, 600));
  return r.v;
}
