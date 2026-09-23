// Headless Chrome over the DevTools protocol, for the tests that run on
// this machine (tests/offline-test.mjs, tests/sign-ui-test.mjs). Needs
// Node's WebSocket (node --experimental-websocket on Node 20).
//
//   const c = await launchChrome({ profile: dir, downloads: dir });
//   await c.js('1 + 1');   // Runtime.evaluate, awaiting promises
//   c.errors               // exceptions the page threw
//   c.requests             // URLs it requested
//   await c.close();
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Which browser. Every suite here launches through this one function, so
// TI_BROWSER runs the whole lot against another Chromium without touching
// any of them: TI_BROWSER=brave-browser node --experimental-websocket
// tests/offline-test.mjs. Brave is the one that matters in practice --
// it ships different download, shields and storage behaviour from
// Chrome's, and a download that fails there fails for a real share of
// the people this is built for.
export async function launchChrome({ profile, downloads, binary, port } = {}) {
  binary = binary || process.env.TI_BROWSER || 'google-chrome';
  port = port || 9300 + Math.floor(Math.random() * 600);
  const proc = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + port, '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  const c = await connectCdp(`http://127.0.0.1:${port}`);
  c.proc = proc;
  const close = c.close;
  let killed = false;
  const kill = (signal) => { if (!killed) { killed = true; try { proc.kill(signal); } catch (e) { /* gone */ } } };
  // A test that throws before close() used to leave the browser running.
  // Twenty-odd of them accumulate over an afternoon's work and then the
  // next run fails on a port that is already taken or a node id from
  // somebody else's document -- which looks exactly like a flaky test
  // and is not one (2026-09-23).
  const onExit = () => kill();
  process.once('exit', onExit);
  c.close = async (signal) => {
    process.removeListener('exit', onExit);
    await close();
    kill(signal);
    await sleep(300);
  };
  await c.cdp('Runtime.enable');
  await c.cdp('Network.enable');
  await c.cdp('Page.enable');
  if (downloads) await c.cdp('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
  return c;
}

// Connects to the first page target of a Chrome at `base` (its
// --remote-debugging-port, possibly through a tunnel).
export async function connectCdp(base, { tries = 75 } = {}) {
  let ws, seq = 0, last = '';
  const pending = new Map(), errors = [], requests = [];
  for (let i = 0; i < tries && !ws; i++) {
    try {
      const page = (await (await fetch(base + '/json/list')).json()).find((x) => x.type === 'page');
      if (page) {
        const sock = new WebSocket(page.webSocketDebuggerUrl.replace(/^ws:\/\/[^/]+/, base.replace(/^http/, 'ws')));
        await new Promise((r, j) => { sock.onopen = r; sock.onerror = j; });
        ws = sock;
      }
    } catch (e) { last = e.cause ? e.cause.code || e.cause.message : e.message || String(e && e.type); }
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error('Chrome did not start' + (last ? ' (' + last + ')' : ''));
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
    if (d.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(d.params.exceptionDetails).slice(0, 400));
    if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url);
  };
  const cdp = (method, params = {}) => new Promise((res, rej) => {
    const n = ++seq;
    pending.set(n, (d) => (d.error ? rej(new Error(method + ': ' + JSON.stringify(d.error))) : res(d.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  async function js(expr) {
    const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  }
  async function waitFor(expr, what, ms = 120000) {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
      const v = await js(expr);
      if (v) return v;
    }
    throw new Error('timed out waiting for ' + what + (errors.length ? '; page errors: ' + errors.join(' | ') : ''));
  }
  async function setFile(sel, file) {
    const doc = await cdp('DOM.getDocument', { depth: 1 });
    const q = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: sel });
    await cdp('DOM.setFileInputFiles', { nodeId: q.nodeId, files: [file] });
  }
  async function close() { try { ws.close(); } catch (e) { /* closed */ } }
  return { cdp, js, waitFor, setFile, errors, requests, close };
}
