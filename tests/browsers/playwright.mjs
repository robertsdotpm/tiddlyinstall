// Playwright's WebKit (the WebKit build Playwright ships, patched to be
// driven, and close to current Safari) as one more browser for run.mjs.
// Test-only: playwright-core is in tests/browsers/node_modules (npm install
// in tests/browsers; package.json pins the version), never in the page.
//
// On the machine, ~/ibbrowsers/playwright-<v>/server.sh --port=P runs
// server.mjs there: webkit.launchServer() on ws://127.0.0.1:P/ib, headless.
// run.mjs starts it like a WebDriver driver (Remote.startDriver, so ssh -L
// reaches it on the same port here), and connectPlaywright() connects to it
// and gives back the step interface run.mjs uses for every protocol:
//   js(expr)          evaluate an expression in the page, awaiting a promise
//   b.navigate(url)   b.run(body)   b.runAsync(body)   (function bodies)
//   setFile(css, p)   p is a path on the machine; `local(p)` maps it to the
//                     same file here, which Playwright sends to the browser
// Downloads go through Playwright (the browser writes no file itself):
// each is saved here and copied to the run's download folder on the
// machine, so run.mjs's "saved to disk" steps find it as with other drivers.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const HERE = path.dirname(new URL(import.meta.url).pathname);

// The client must be the same Playwright version as the server.
export function playwrightVersion() {
  try { return createRequire(import.meta.url)('./node_modules/playwright-core/package.json').version; } catch (e) { return null; }
}

export async function connectPlaywright(port, { remote, dl, local, tmp, log = () => {}, ms = 120000 }) {
  let pw;
  try { pw = await import(path.join(HERE, 'node_modules', 'playwright-core', 'index.mjs')); } catch (e) {
    throw new Error('driver: playwright-core is not installed here (cd tests/browsers && npm install): ' + e.message);
  }
  let browser, last;
  for (const end = Date.now() + ms; Date.now() < end && !browser;) {
    try { browser = await pw.webkit.connect(`ws://127.0.0.1:${port}/ib`, { timeout: 15000 }); } catch (e) { last = e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  if (!browser) throw new Error('driver: Playwright: ' + String(last && last.message || last).split('\n')[0]);
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(300000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e).slice(0, 300)));
  // Downloads: saved here, then put in the run's folder on the machine.
  const pending = new Set();
  page.on('download', (d) => {
    const job = (async () => {
      const name = d.suggestedFilename();
      const f = path.join(tmp, 'pwdl-' + name);
      await d.saveAs(f);
      remote.put(f, remote.dir('work', path.basename(dl), name));
      log(`download ${name} (${fs.statSync(f).size} bytes) copied to the machine\n`);
    })().catch((e) => log('download failed: ' + e.message + '\n'));
    pending.add(job);
    job.finally(() => pending.delete(job));
  });

  const js = (expr) => page.evaluate(`(${expr})`);
  const run = (body) => page.evaluate(`(function () { ${body} })()`);
  const runAsync = (body) => page.evaluate(`new Promise(function (done) { (function () { ${body} }).apply(null, [done]); })`);
  const b = {
    navigate: (u) => page.goto(u, { waitUntil: 'load', timeout: 300000 }),
    run, runAsync,
  };
  const setFile = (css, p) => page.setInputFiles(css, local(p));
  return {
    js, b, setFile, errors,
    version: browser.version(),
    userAgent: () => page.evaluate('navigator.userAgent'),
    async close() {
      await Promise.allSettled([...pending]);
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
