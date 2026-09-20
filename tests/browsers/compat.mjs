// The tested-browsers summary the page carries (tools/build_site.py embeds
// it as <script id="ti-compat">; web/browser-check.js shows it): the latest
// result of each machine x browser x major version from usage.jsonl.
// run.mjs rewrites it after every run.
//
//   node tests/browsers/compat.mjs     # write tests/browsers/compat.json
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const COMPAT = path.join(HERE, 'compat.json');

// Display order, labels and what each machine is, for matching the
// visitor's OS (os, NT/macOS version, and 1 on the machine to match a
// visitor on that OS family when nothing closer is known).
export const MACHINES = [
  ['xp', 'Windows XP', 'windows', '5.1'], ['vista', 'Windows Vista', 'windows', '6.0'], ['7', 'Windows 7', 'windows', '6.1'],
  ['8.1', 'Windows 8.1', 'windows', '6.3'], ['10', 'Windows 10', 'windows', '10'], ['11', 'Windows 11', 'windows', '11'],
  ['2022', 'Windows Server 2022', 'windows', '10'],
  ['10x86', 'Windows 10 (32-bit)', 'windows', '10'], ['ltsc2021', 'Windows 10 LTSC 2021', 'windows', '10'],
  ['11de', 'Windows 11 (German, non-ASCII user)', 'windows', '11'], ['2025core', 'Windows Server 2025 Core', 'windows', '10'],
  ['centos6', 'CentOS 6', 'linux', ''], ['centos7', 'CentOS 7', 'linux', ''], ['ubuntu1404', 'Ubuntu 14.04', 'linux', ''],
  ['ubuntu1604', 'Ubuntu 16.04', 'linux', ''], ['ubuntu1804', 'Ubuntu 18.04', 'linux', ''], ['rocky8', 'Rocky Linux 8', 'linux', ''],
  ['ubuntu2004', 'Ubuntu 20.04', 'linux', ''], ['ubuntu2204', 'Ubuntu 22.04', 'linux', ''], ['debian12', 'Debian 12', 'linux', '', 1],
  ['alpine', 'Alpine 3.24', 'linux', ''], ['mac', 'macOS 26', 'mac', '26'],
];
export const BROWSERS = [['chrome', 'Chrome'], ['chromium', 'Chromium'], ['edge', 'Edge'], ['opera', 'Opera'], ['brave', 'Brave'], ['vivaldi', 'Vivaldi'],
  ['supermium', 'Supermium'], ['supermium-installed', 'Supermium (older)'], ['firefox', 'Firefox'], ['safari', 'Safari'],
  ['webkitgtk', "WebKitGTK (Safari's engine)"], ['epiphany', 'GNOME Web (Epiphany)'], ['playwright-webkit', "Playwright WebKit (Safari's engine)"],
  ['ie', 'Internet Explorer']];

// Stand-ins for a browser, tested for their engine: not browsers to
// recommend to anyone.
export const PROXIES = ['webkitgtk', 'playwright-webkit'];

// The part of a version that names a release: the major version, but
// major.minor for WebKitGTK, whose major is always 2.
export function majorOf(browser, version) {
  const p = String(version || '').split('.');
  return browser === 'webkitgtk' ? p.slice(0, 2).join('.') : p[0];
}

export function readUsage() {
  const f = path.join(HERE, 'usage.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}

// [machine, browser, version, result, why, date], latest per machine x
// browser x major version. Runs that couldn't be done (error) say nothing
// about the page, so they're left out.
export function summary(usage = readUsage()) {
  const latest = new Map();
  for (const u of usage) {
    if (!u.result || /^error/.test(u.result) || !u.version) continue;
    const major = majorOf(u.browser, u.version);
    latest.set(`${u.machine}/${u.browser}/${major}`, u);
  }
  const order = new Map(MACHINES.map((m, i) => [m[0], i]));
  const rows = [...latest.values()].sort((a, b) => (order.get(a.machine) ?? 99) - (order.get(b.machine) ?? 99) || a.browser.localeCompare(b.browser));
  return {
    generated: new Date().toISOString().slice(0, 10),
    machines: MACHINES,
    browsers: BROWSERS,
    proxies: PROXIES,
    results: rows.map((u) => {
      const [kind, ...rest] = u.result.split(':');
      return [u.machine, u.browser, String(u.version), kind, rest.join(':').trim().slice(0, 160), String(u.time).slice(0, 10)];
    }),
  };
}

export function writeCompat() {
  fs.writeFileSync(COMPAT, JSON.stringify(summary()) + '\n');
  return COMPAT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  console.log('wrote ' + writeCompat());
}
