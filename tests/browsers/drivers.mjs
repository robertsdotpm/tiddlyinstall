// Chrome and Edge update themselves (on Windows 10, 11 and Server 2022),
// and then their driver no longer matches. When a session fails that way,
// ensureDriver() fetches the matching driver from the vendor, checks its
// Authenticode signature here, installs it on the machine next to the old
// one, and updates the machine's browsers.json. Only for Windows 10 and
// later, where the auto-updating browsers are; a 32-bit machine's entry
// (its driverSource names win32: Windows 10 x86) gets the win32 driver.
//
//   chromedriver   Chrome for Testing: the exact version, else the latest patch of its build
//                  https://googlechromelabs.github.io/chrome-for-testing/
//   msedgedriver   https://msedgedriver.microsoft.com/<version>/edgedriver_win64.zip
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { OSSL } from './steps.mjs';

const CFT = 'https://googlechromelabs.github.io/chrome-for-testing/latest-patch-versions-per-build-with-downloads.json';
const SIGNERS = { chromedriver: /Google LLC/, msedgedriver: /Microsoft Corporation/ };

// The browser version a driver's "only supports" error reports, or null.
export function mismatch(message) {
  const m = /only supports .*version (\d+)[\s\S]*?Current browser version is ([\d.]+)/i.exec(message || '');
  return m ? { supports: m[1], browser: m[2] } : null;
}

async function download(url, file) {
  const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

function unzipOne(zip, name, dir) {
  const r = spawnSync('unzip', ['-o', '-j', zip, '*' + name, '-d', dir], { encoding: 'utf8' });
  const f = path.join(dir, name);
  if (r.status !== 0 || !fs.existsSync(f)) throw new Error(`unzip ${name}: ${r.stderr || r.stdout}`);
  return f;
}

function authenticode(file, kind) {
  if (!OSSL) throw new Error('osslsigncode not found; not installing an unchecked driver');
  const r = spawnSync(OSSL, ['verify', '-in', file, '-CAfile', '/etc/ssl/certs/ca-certificates.crt'], { encoding: 'utf8' });
  const out = r.stdout + r.stderr;
  if (!/Signature verification: ok/.test(out) || !SIGNERS[kind].test(out)) throw new Error(`${path.basename(file)}: Authenticode check failed: ${out.slice(-400)}`);
  return 'Authenticode ' + SIGNERS[kind].source + ', chain ok (osslsigncode)';
}

export async function ensureDriver(remote, entry, message, tmp) {
  const mm = mismatch(message);
  if (!mm || !remote.win || !['chromedriver', 'msedgedriver'].includes(entry.driverKind)) return null;
  const v = mm.browser;
  let url;
  if (entry.driverKind === 'chromedriver') {
    // The exact version first (the JSON index lags new releases), then the
    // latest patch of the same build.
    url = `https://storage.googleapis.com/chrome-for-testing-public/${v}/win64/chromedriver-win64.zip`;
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(60000) }).catch(() => null);
    if (!head || !head.ok) {
      const build = v.split('.').slice(0, 3).join('.');
      const j = await (await fetch(CFT, { signal: AbortSignal.timeout(60000) })).json();
      const b = j.builds[build];
      url = b && (b.downloads.chromedriver || []).find((d) => d.platform === 'win64')?.url;
      if (!url) throw new Error(`no Chrome for Testing chromedriver for ${v}`);
    }
  } else {
    const plat = /win32/.test(entry.driverSource || '') ? 'win32' : 'win64';
    url = `https://msedgedriver.microsoft.com/${v}/edgedriver_${plat}.zip`;
  }
  console.log(`[${remote.name}] ${entry.id} is now ${v}; fetching ${url}`);
  const zip = path.join(tmp, 'driver.zip');
  await download(url, zip);
  const exe = unzipOne(zip, entry.driverKind + '.exe', path.join(tmp, 'drv'));
  const verified = authenticode(exe, entry.driverKind);
  const dir = remote.dir('drivers', `${entry.driverKind}-${v}`);
  remote.mkdir(dir);
  remote.put(exe, dir + '\\' + entry.driverKind + '.exe');
  // Update the machine's manifest.
  const man = remote.readManifest();
  const e = man.browsers.find((b) => b.id === entry.id);
  Object.assign(e, { version: v, driver: dir + '\\' + entry.driverKind + '.exe', driverVersion: v, driverSource: url, driverVerified: verified });
  man.updated = new Date().toISOString();
  const f = path.join(tmp, 'browsers.json');
  fs.writeFileSync(f, JSON.stringify(man, null, 1));
  remote.put(f, remote.dir('browsers.json'));
  return e;
}
