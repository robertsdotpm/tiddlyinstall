// Playwright's WebKit for tests/browsers/run.mjs: launches it headless and
// serves it on ws://127.0.0.1:PORT/ti (the harness reaches that through
// ssh -L and drives it with tests/browsers/playwright.mjs) until it's
// killed. Installed on a machine as ~/tibrowsers/playwright-<v>/server.mjs
// beside its node_modules, with server.sh setting PLAYWRIGHT_BROWSERS_PATH
// and the Node to use (docs/local/test-vms.md).
//   node server.mjs --port=PORT
import { webkit } from './node_modules/playwright-core/index.mjs';
const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').slice(7));
if (!port) { console.error('usage: server.mjs --port=PORT'); process.exit(2); }
const s = await webkit.launchServer({ host: '127.0.0.1', port, wsPath: '/ti', headless: true });
console.log('listening ' + s.wsEndpoint());
const stop = () => s.close().finally(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
