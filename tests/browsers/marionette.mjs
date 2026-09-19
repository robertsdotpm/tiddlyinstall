// A small client for Firefox's own Marionette protocol, for a Firefox no
// geckodriver runs beside: Firefox 52 on Windows XP (every geckodriver
// release either won't load there, needing Vista's ktmw32.dll or other newer
// entry points, or panics on its first request). geckodriver is itself a
// translator to this protocol, so this does its job for the few commands
// the harness uses.
//
// Firefox started with -marionette listens on the port in its prefs
// (marionette.defaultPrefs.port up to 54, marionette.port after); each
// message is `<length>:<json>`. The server speaks first with
// {applicationType, marionetteProtocol}; a command is [0, id, name, params]
// and its answer [1, id, error, result].
//
//   const s = await MarionetteSession.connect('127.0.0.1', 2828);
//   await s.navigate(url); await s.run('return 1'); await s.delete();
//
// It has the methods of webdriver.mjs's Session that run.mjs uses, so
// evalIn() works on it unchanged.
import net from 'node:net';
import { WebDriverError, sleep } from './webdriver.mjs';

const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

export class MarionetteSession {
  constructor(sock) {
    this.sock = sock;
    this.seq = 0;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.hello = null;
    this.capabilities = {};
    this.closed = null;
    sock.on('data', (d) => { this.buf = Buffer.concat([this.buf, d]); this.drain(); });
    const gone = (why) => {
      this.closed = why;
      for (const [, p] of this.pending) p.reject(new WebDriverError('no connection', 'Marionette: ' + why));
      this.pending.clear();
    };
    sock.on('error', (e) => gone(e.message));
    sock.on('close', () => gone('connection closed'));
  }

  drain() {
    for (;;) {
      const colon = this.buf.indexOf(0x3a);
      if (colon < 0) return;
      const n = Number(this.buf.subarray(0, colon).toString());
      if (this.buf.length < colon + 1 + n) return;
      const msg = JSON.parse(this.buf.subarray(colon + 1, colon + 1 + n).toString('utf8'));
      this.buf = this.buf.subarray(colon + 1 + n);
      if (!Array.isArray(msg)) { this.hello = msg; if (this.onHello) this.onHello(msg); continue; }
      const [, id, err, result] = msg;
      const p = this.pending.get(id);
      if (!p) continue;
      this.pending.delete(id);
      if (err) p.reject(new WebDriverError(err.error || 'marionette error', err.message || JSON.stringify(err)));
      else p.resolve(result);
    }
  }

  // Connects (retrying while Firefox starts) and opens a session.
  static async connect(host, port, { ms = 120000, capabilities = {} } = {}) {
    let last = '';
    for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
      const sock = net.connect(port, host);
      const s = new MarionetteSession(sock);
      try {
        await new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('no greeting in 15 s')), 15000);
          s.onHello = () => { clearTimeout(t); res(); };
          sock.once('error', (e) => { clearTimeout(t); rej(e); });
          sock.once('close', () => { clearTimeout(t); rej(new Error('closed before the greeting')); });
        });
        const r = await s.cmd('newSession', { capabilities });
        s.id = r.sessionId;
        s.capabilities = r.capabilities || r.value || {};
        return s;
      } catch (e) {
        last = e.code || e.message;
        sock.destroy();
      }
    }
    throw new WebDriverError('driver not ready', 'Marionette on port ' + port + ': ' + last);
  }

  cmd(name, params = {}, { timeout = 330000 } = {}) {
    if (this.closed) return Promise.reject(new WebDriverError('no connection', 'Marionette: ' + this.closed));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new WebDriverError('timeout', name)); }, timeout);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      const body = Buffer.from(JSON.stringify([0, id, name, params]), 'utf8');
      this.sock.write(Buffer.concat([Buffer.from(body.length + ':'), body]));
    });
  }

  get browserVersion() { return this.capabilities.browserVersion || ''; }

  // Firefox 52 takes {script, "page load", implicit} in ms, or the legacy
  // {type, ms} one at a time; run.mjs falls back to the latter itself.
  async setTimeouts(t) {
    if (t.type) return this.cmd('timeouts', t);
    const o = {};
    if (t.script !== undefined) o.script = t.script;
    if (t.pageLoad !== undefined) o['page load'] = t.pageLoad;
    return this.cmd('timeouts', o);
  }
  async navigate(url) { await this.cmd('get', { url }); }
  async run(script, args = []) { return (await this.cmd('executeScript', { script, args })).value; }
  async runAsync(script, args = [], opts) { return (await this.cmd('executeAsyncScript', { script, args }, opts)).value; }
  async find(css) {
    const v = (await this.cmd('findElement', { using: 'css selector', value: css })).value;
    return v[ELEMENT] || v.ELEMENT;
  }
  // For <input type=file>: Firefox 52 takes the text as an array of characters.
  sendKeys(el, text) { return this.cmd('sendKeysToElement', { id: el, value: text.split('') }); }

  async delete() {
    try { await this.cmd('deleteSession', {}, { timeout: 30000 }); } catch (e) { /* gone */ }
    this.sock.destroy();
  }
}
