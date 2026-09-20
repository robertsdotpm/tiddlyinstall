// The build server's plain-HTML path in old browsers (docs/api.md "Plain
// form posts"): shared by tests/browsers/ie.mjs --classic and
// tests/browsers/safari5.mjs --classic. The browser fills and submits the
// server's /classic form and follows the status page to its download
// links; this side then checks what those links give, as a person's
// download would be: its SHA-256 as the page says, read back with
// shared/tifile.js (modes B and C carry the record the page links to; mode A is
// our signed base named for it), and the record's signed plan served. With `out`, the
// files are kept with a builds.json that tests/matrix/run.py reads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readInstaller, recordHash } from '../../shared/tifile.js';

export const MODE_LETTER = { ours: 'A', yours: 'B', unsigned: 'C' };

// What the browsers type into the form: a public repo with nothing to
// install, and a launch command that prints what tests/matrix/run.py looks
// for, so the installer can go through the matrix too.
export function classicFields(label, mode) {
  return {
    app_name: 'Hello classic ' + label,
    source: 'octocat/Hello-World',
    runtime: 'python',
    launch: '{runtime} -c "print(\'hello from python\')"',
    mode,
  };
}

// Links (absolute), SHA-256s and the record named by a finished status page.
export function parseStatus(html, base) {
  const files = [];
  for (const m of html.matchAll(/<tr><td><a href="([^"]+)">([^<]+)<\/a><\/td><td>([^<]*)<\/td><td>[^<]*<\/td><td>([^<]*)<\/td><td class="sha">([0-9a-f]{64})<\/td><\/tr>/g)) {
    files.push({ href: new URL(m[1].replace(/&amp;/g, '&'), base).href, name: m[2], platform: m[3], signed: m[4], sha256: m[5] });
  }
  const rec = /href="\.\.\/api\/records\/([a-z0-9]+)"/.exec(html);
  return { files, record: rec ? rec[1] : null, done: /<span class="ok">Done<\/span>/.test(html), refresh: /http-equiv="refresh"/.test(html) };
}

// Checks a finished job's page and files. statusUrl: the page's absolute
// URL. hrefs: the download links as the browser resolved them, if known.
export async function checkFinished(t, statusUrl, { hrefs = null, name, modeLetter, out } = {}) {
  const html = await (await fetch(statusUrl)).text();
  const st = parseStatus(html, statusUrl);
  t.ok(st.done && !st.refresh, 'the status page says done, and stops reloading', html.slice(0, 200));
  t.ok(st.files.length > 0 && st.record, 'the status page links the files and the record', st.files.length + ' ' + st.record);
  if (hrefs) t.ok(JSON.stringify(hrefs.slice().sort()) === JSON.stringify(st.files.map((f) => f.href).sort()), 'the browser has the same download links', hrefs.join(' '));
  const recText = await (await fetch(new URL('../api/records/' + st.record, statusUrl))).text();
  t.ok(recText.includes('\nname\t' + name + '\n'), 'the record is the form\'s (its name)', recText.slice(0, 200));
  const kept = {};
  for (const f of st.files) {
    const r = await fetch(f.href);
    const data = new Uint8Array(await r.arrayBuffer());
    t.ok(r.status === 200 && /attachment/.test(r.headers.get('content-disposition') || ''), `${f.name}: the link downloads it`, r.status);
    t.ok(crypto.createHash('sha256').update(data).digest('hex') === f.sha256, `${f.name}: its SHA-256 is the page's`);
    const info = await readInstaller(data, f.name);
    if (modeLetter === 'A') {
      // Mode A: our signed base as it is, named for the record, which it
      // fetches from the server when it runs (design.md 3).
      t.ok(info.kind && info.record === null && !info.plan && f.name.includes(st.record), `${f.name}: shared/tifile.js reads it: our base, named for the record, nothing inside (mode A)`, info.kind + ' ' + f.name);
      if (f.platform === 'Windows') t.ok(/TiddlyInstall/.test(f.signed), `${f.name}: signed by TiddlyInstall`, f.signed);
    } else {
      // Modes B and C carry the record; the plan comes from the server
      // when they run (offline ones carry it too).
      t.ok(info.record === recText && await recordHash(info.record) === st.record, `${f.name}: shared/tifile.js reads it back, carrying the record`);
      if (info.plan) t.ok(info.plan.includes('record\t' + st.record + '\n'), `${f.name}: the plan it carries is bound to the record`);
    }
    const plan = await fetch(new URL('../api/plan/' + st.record, statusUrl));
    t.ok(plan.status === 200 && /\nsig\ted25519\t/.test(await plan.text()), `${f.name}: the server has its signed plan`);
    if (out) {
      const dir = path.join(out, 'python', modeLetter);
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, f.name);
      fs.writeFileSync(p, data);
      kept[{ Windows: 'windows', Linux: 'linux', macOS: 'macos' }[f.platform] || f.platform] = p;
    }
  }
  if (out) {
    const bj = path.join(out, 'builds.json');
    const builds = fs.existsSync(bj) ? JSON.parse(fs.readFileSync(bj, 'utf8')) : {};
    builds['python/' + modeLetter] = { status: 'done', record: st.record, files: kept };
    fs.writeFileSync(bj, JSON.stringify(builds, null, 1) + '\n');
  }
  return st;
}
