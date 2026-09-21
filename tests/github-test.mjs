// GitHub sources, written by the page and by the build server from the
// same code (src/shared/github.js, design.md 11.0).
//
//   node tests/github-test.mjs
//
// The property this exists to protect is the first one checked: **the
// page and the build server must write the same record, byte for byte,
// for the same repository and commit.** They used to derive the install
// rule from different things -- the server downloaded the tarball, the
// page could not -- and one form would then give two records, two appids
// and two install folders. That is the bug of 2026-09-20 in a new place,
// so it is a test and not a comment.
//
// Everything runs against a GitHub API stood up here: the real one allows
// 60 requests an hour per address, and a test suite that eats that
// allowance breaks the next agent's work. The stand-in answers exactly
// what api.github.com answers -- `application/vnd.github.sha` for a
// commit, a `git/trees` document for the file list, and the rate-limit
// headers -- and the address is rewritten in the *transport*, so the
// derivation under test is the shipped one.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Builder } from '../src/build_server/lib/jobs.js';
import { loadCatalog } from '../src/build_server/lib/catalog.js';
import { loadOrCreate } from '../src/build_server/lib/plansig.js';
import { runJob, validate, githubWillAskApi } from '../src/shared/builder.js';
import { browserGet, noNetworkGet, parseRepo, validRef, waitWords, resetSeconds } from '../src/shared/github.js';
import { resolve } from '../src/shared/resolve.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = path.join(process.env.HOME || '', 'projects', 'installer-builder-runtimes');
const BASES = path.join(REPO, 'installer');
const FIXED = new Date('2026-09-21T00:00:00Z');
const COMMIT = 'dae7ef63b4df6eded86637f251fc4e3a06c3b479';

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('PASS ' + name); }
  else { failed++; console.log('FAIL ' + name + (extra !== undefined ? '\n    ' + extra : '')); }
}
const err = async (p) => { try { await p; return '(no error)'; } catch (e) { return e.message; } };

if (!fs.existsSync(path.join(RUNTIMES, 'catalog', 'os_versions.json'))) {
  console.log('SKIP: no runtime catalogue at ' + RUNTIMES);
  process.exit(0);
}

/* ---------- a GitHub API that answers here ---------- */

// What each repository looks like. `tree` is the top level as the API
// gives it: paths with no slash, and `type` telling files from folders.
const REPOS = {
  'psf/requests': {
    'HEAD': COMMIT, 'main': COMMIT, 'v2.32.3': 'a'.repeat(40), [COMMIT]: COMMIT,
    tree: [
      { path: 'requirements.txt', type: 'blob' },
      { path: 'README.md', type: 'blob' },
      { path: 'src', type: 'tree' },
      { path: 'docs', type: 'tree' },
    ],
  },
  // A repository whose *folder* is called requirements.txt, and which has
  // no file a rule names. The server read these names off a tarball,
  // where a folder ends in "/" and so never matched; the API says
  // `type: "tree"` instead, and a folder is not a file a rule is about.
  'octo/foldername': { 'HEAD': 'b'.repeat(40), tree: [{ path: 'requirements.txt', type: 'tree' }, { path: 'go.mod', type: 'blob' }] },
  'octo/node-app': { 'HEAD': 'c'.repeat(40), tree: [{ path: 'package.json', type: 'blob' }, { path: 'index.js', type: 'blob' }] },
  'octo/bare': { 'HEAD': 'd'.repeat(40), tree: [{ path: 'hello.py', type: 'blob' }] },
  'octo/huge': { 'HEAD': 'e'.repeat(40), tree: [{ path: 'requirements.txt', type: 'blob' }], truncated: true },
};

// What the next answer should be instead of the real one: a rate limit, a
// 404, or a dead socket. One shot, so a test sets it and the next call
// gets it.
let nextFault = null;
let calls = [];

function api() {
  return new Promise((done) => {
    const s = http.createServer((req, res) => {
      calls.push(req.url);
      if (nextFault === 'dead') { nextFault = null; req.socket.destroy(); return; }
      if (nextFault === 'ratelimit') {
        nextFault = null;
        res.writeHead(403, { 'content-type': 'application/json',
          'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(FIXED.getTime() / 1000) + 780) });
        return res.end('{"message":"API rate limit exceeded"}');
      }
      let m = /^\/repos\/([^/]+)\/([^/]+)\/commits\/(.+)$/.exec(req.url);
      if (m) {
        const r = REPOS[m[1] + '/' + m[2]];
        const sha = r && Object.prototype.hasOwnProperty.call(r, decodeURIComponent(m[3])) ? r[decodeURIComponent(m[3])] : null;
        if (!sha) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
        res.writeHead(200, { 'content-type': 'application/vnd.github.sha' });
        return res.end(sha);
      }
      m = /^\/repos\/([^/]+)\/([^/]+)\/git\/trees\/([^/?]+)$/.exec(req.url);
      if (m) {
        const r = REPOS[m[1] + '/' + m[2]];
        if (!r) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"Not Found"}'); }
        res.writeHead(200, { 'content-type': 'application/json' });
        // Deliberately not in the order the rule table lists them: the
        // derivation must not depend on what order GitHub answers in.
        return res.end(JSON.stringify({ sha: m[3], truncated: !!r.truncated, tree: r.tree.slice().reverse() }));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"message":"Not Found"}');
    });
    s.listen(0, '127.0.0.1', () => done({ url: 'http://127.0.0.1:' + s.address().port, close: () => s.close() }));
  });
}

const mock = await api();
const toMock = (u) => String(u).replace('https://api.github.com', mock.url);

/* ---------- the two sides ---------- */

const cat = loadCatalog({ dir: path.join(RUNTIMES, 'catalog'), policyPath: path.join(REPO, 'server', 'policy.json'), localRoot: '', cachePath: '/dev/null' });
const BACKEND = 'http://127.0.0.1:1';

// The server's own client, as src/build_server/test/helpers.js shapes it.
async function serverFetch(url, opts = {}) {
  const r = await fetch(toMock(url), { method: opts.method || 'GET', headers: opts.headers, redirect: 'follow' });
  const body = r.body ? Readable.fromWeb(r.body) : Readable.from([]);
  return {
    status: r.status, statusText: r.statusText, statusLine: r.status + ' ' + r.statusText,
    headers: Object.fromEntries(r.headers), body, ok: r.ok,
    async bytes(limit = Infinity) { return Buffer.from(await new Response(Readable.toWeb(body)).arrayBuffer()); },
    async upTo(limit) { const b = Buffer.from(await new Response(Readable.toWeb(body)).arrayBuffer()); return b.subarray(0, limit); },
    discard() { body.resume(); },
  };
}

const data = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ti-gh-'));
const { signer } = loadOrCreate(data, () => {});
const builder = new Builder({ cat, data, bases: BASES, public: BACKEND, signer, fetch: serverFetch });

// The build server's env, with the clock pinned so `created` is the one
// thing that cannot differ by accident.
const serverEnv = () => Object.assign(builder.env(), { now: () => FIXED });

// The page's env (src/web_client/local-api.js env()): the page's own transport, no
// registry client, a plan inside each installer.
const pageEnv = () => ({
  catalog: cat, backend: BACKEND, embedPlan: true, packRuntimes: true, githubWho: 'page',
  base: (plat) => new Uint8Array(fs.readFileSync(path.join(BASES, plat === 'windows' ? 'windows/out/base.exe'
    : plat === 'linux' ? 'unix/out/ti-base.run' : 'unix/out/ti-base-macos.zip'))),
  githubGet: browserGet((u, o) => fetch(toMock(u), o)),
  now: () => FIXED,
});

const body = (o) => Object.assign({
  name: 'Requests', runtime: 'python', mode: 'C', platforms: ['linux'],
  launch: '{runtime} -m requests', source: { kind: 'github', value: 'psf/requests' },
}, o);

/* ---------- 1. the page and the server write the same record ---------- */

{
  const s = await runJob(body({ source: { kind: 'github', value: 'https://github.com/psf/requests.git', ref: 'main' } }), serverEnv());
  const p = await runJob(body({ source: { kind: 'github', value: 'psf/requests', ref: 'main' } }), pageEnv());
  ok(s.record === p.record, 'the page and the build server write byte-identical records for one repo and commit',
    JSON.stringify([s.record, p.record]));
  ok(s.hash === p.hash, 'so the record hash, the appid and the install folder are the same', s.hash + ' vs ' + p.hash);
  ok(s.record.includes('source\tgithub\tpsf/requests\t' + COMMIT + '\n'),
    'the record names the repo and the commit, with no hash field at all', JSON.stringify(s.record.split('\n').find((l) => l.startsWith('source'))));
  ok(!/^source\tgithub\t\S+\t\S+\t/m.test(s.record), 'and nothing after the commit');
  ok(s.record.includes('install\tdefault:requirements\n'),
    'the install rule comes from the repo\'s own files (requirements.txt -> pip -r)',
    JSON.stringify(s.record.split('\n').find((l) => l.startsWith('install'))));

  // The plans as well: the record is the identity, but a plan that
  // differed would still be two installers from one form.
  const sp = resolve(cat, Object.assign({}, s.app, { platforms: ['linux'] }));
  const pp = resolve(cat, Object.assign({}, p.app, { platforms: ['linux'] }));
  ok(sp === pp, 'and the same plan, byte for byte');
  const line = sp.split('\n').find((l) => l.startsWith('source\t'));
  ok(line === 'source\t' + COMMIT + '.tar.gz\t-\t0\ttar.gz\t1',
    'the plan\'s source line has "-" where the hash would be, never an empty field', JSON.stringify(line));
  ok(sp.includes('\nurl\thttps://codeload.github.com/psf/requests/tar.gz/' + COMMIT + '\n'),
    'and one HTTPS address to fetch it from', JSON.stringify(sp.split('\n').filter((l) => l.startsWith('url'))[0]));

  ok(s.source && s.source.commit === COMMIT && s.source.resolved === 'main',
    'the result says what the branch resolved to, so "pinned" is a claim the UI can show', JSON.stringify(s.source));
  ok(p.source && p.source.commit === s.source.commit, 'the page reports it the same way', JSON.stringify(p.source));
}

/* ---------- 2. the rule table, read from the API ---------- */

for (const [repo, runtime, want] of [
  ['octo/node-app', 'node', 'install\tdefault:npm\n'],
  ['octo/bare', 'python', null],
  ['octo/foldername', 'python', null],
]) {
  const r = await runJob(body({ runtime, source: { kind: 'github', value: repo }, launch: '{runtime} x' }), serverEnv());
  const has = /^install\t/m.test(r.record);
  ok(want === null ? !has : r.record.includes(want),
    repo + ' (' + runtime + '): ' + (want === null ? 'no install rule' : want.trim()),
    JSON.stringify(r.record.split('\n').filter((l) => l.startsWith('install'))));
}

/* ---------- 3. no build server, and no network either ---------- */

{
  // A full commit id and an install command are the two things the API
  // would have been asked for. With both, nothing is asked.
  const b = body({ install: '{runtime} -m pip install .', source: { kind: 'github', value: 'psf/requests', ref: COMMIT } });
  ok(githubWillAskApi(b) === false, 'with a commit id and an install command, no API request is needed');
  calls = [];
  const saved = await runJob(JSON.parse(JSON.stringify(b)), Object.assign(pageEnv(), { githubGet: noNetworkGet() }));
  ok(calls.length === 0, 'and none is made', calls.join(' '));
  ok(saved.record.includes('source\tgithub\tpsf/requests\t' + COMMIT + '\n'),
    'a saved copy of the page, with no network at all, still writes the record');
  ok(saved.record.includes('install\t{runtime} -m pip install .\n'), 'with the publisher\'s own install command');
  const server = await runJob(JSON.parse(JSON.stringify(b)), serverEnv());
  ok(server.record === saved.record, 'byte for byte what the build server writes for the same form');

  // Without them, it refuses and says which two fields to fill in.
  const m = await err(runJob(body({ source: { kind: 'github', value: 'psf/requests', ref: 'main' } }),
    Object.assign(pageEnv(), { githubGet: noNetworkGet() })));
  ok(/saved copy/.test(m), 'a saved copy says it contacts nothing rather than pretending the network failed', m);
  ok(/Install command/.test(m) && /commit id/.test(m), 'and names both fields that make the request unnecessary', m);
  ok(/installer itself downloads the repository when it runs/.test(m),
    'and says the installer it would build still works', m);
}

/* ---------- 4. rate limits: legible, never a silent no-rule ---------- */

for (const [who, env, want] of [['the page', pageEnv, /this browser's address/], ['the build server', serverEnv, /shares with everyone using it/]]) {
  nextFault = 'ratelimit';
  const m = await err(runJob(body({ source: { kind: 'github', value: 'psf/requests', ref: 'main' } }), env()));
  ok(/rate-limiting us/.test(m) && /60 requests an hour/.test(m), who + ': a rate limit says what the limit is', m);
  ok(want.test(m), who + ': and whose address it is counted against', m);
  ok(/in about 13 minutes/.test(m), who + ': and when to try again, from x-ratelimit-reset', m);
  ok(/Install command/.test(m), who + ': and how to build now instead', m);
}

{
  // The one thing that must never happen: a rate limit that quietly
  // produces a record with no install rule.
  nextFault = 'ratelimit';
  const m = await err(runJob(body({ source: { kind: 'github', value: 'psf/requests', ref: COMMIT } }), pageEnv()));
  ok(/rate-limiting us/.test(m), 'a rate limit while reading the file list refuses the build', m);
  ok(!/no install/.test(m), 'rather than falling back to no install rule', m);
}

{
  nextFault = 'dead';
  const m = await err(runJob(body({ source: { kind: 'github', value: 'psf/requests', ref: 'main' } }), pageEnv()));
  ok(/Couldn't reach GitHub's API/.test(m), 'an unreachable API says so plainly', m);
  ok(/Install command/.test(m) && /commit id/.test(m), 'and offers the same two fields', m);
}

{
  const m = await err(runJob(body({ source: { kind: 'github', value: 'octo/nope' } }), pageEnv()));
  ok(/GitHub has no octo\/nope/.test(m), 'a repository that is not there says so', m);
  ok(!/commit id/.test(m), 'and does not offer the two fields: pinning a commit that is not there only moves the failure later', m);
  const t = await err(runJob(body({ source: { kind: 'github', value: 'octo/huge' } }), pageEnv()));
  ok(/cut short the file list/.test(t), 'a truncated file list is refused, not treated as a short one', t);
  ok(/Install command/.test(t) && !/commit id/.test(t), 'and offers the one field that settles it', t);
}

/* ---------- 5. what validate() refuses before any of that ---------- */

{
  const v = (o) => { try { validate(body(o), pageEnv()); return '(accepted)'; } catch (e) { return e.message; } };
  ok(/offline installer carries every file/.test(v({ offline: true })),
    'an offline installer with a GitHub source is refused: there is no hash to pack it under', v({ offline: true }));
  ok(/letters, digits/.test(v({ source: { kind: 'github', value: 'psf/requests', ref: 'a/../../b' } })),
    'a ref that would not survive being written into the API address is refused',
    v({ source: { kind: 'github', value: 'psf/requests', ref: 'a/../../b' } }));
  ok(v({ source: { kind: 'github', value: 'psf/requests', ref: 'release/1.0' } }) === '(accepted)', 'a ref with a slash in it is fine');
  // And the refusal the page used to give for GitHub is gone.
  ok(!/needs the build src/build_server/.test(v({})), 'a GitHub source is no longer refused for want of a build server', v({}));
  ok(/plain URL needs the build src/build_server/.test(v({ source: { kind: 'url', value: 'https://example.com/x.tar.gz' } })),
    'a plain URL still is', v({ source: { kind: 'url', value: 'https://example.com/x.tar.gz' } }));
}

/* ---------- 6. the small pieces ---------- */

{
  ok(JSON.stringify(parseRepo('https://github.com/psf/requests.git')) === '{"owner":"psf","repo":"requests"}', 'parseRepo');
  ok(validRef('v1.2.3') && validRef('release/1.0') && !validRef('a/../b') && !validRef('main/') && !validRef('-x'), 'validRef');
  ok(waitWords(30) === 'in under a minute' && waitWords(780) === 'in about 13 minutes' && waitWords(0) === 'in a little while', 'waitWords');
  ok(resetSeconds({ 'retry-after': '90' }, 0) === 90, 'retry-after wins over the reset time');
  ok(resetSeconds({ 'x-ratelimit-reset': '100' }, 40000) === 60, 'and x-ratelimit-reset is an epoch second');
}

/* ---------- 7. --live: the real API, against the real tarball ---------- */

// The stand-in above is only worth as much as its resemblance to GitHub,
// and the thing it stands in for is a *change of derivation*: the build
// server used to read these names off the tarball. So this checks the
// two agree on a real repository -- opt-in, because the real API allows
// 60 requests an hour from one address and an unattended suite that eats
// them breaks whatever runs next.
//
//   node tests/github-test.mjs --live
//
// Run 2026-09-21 against psf/requests at dae7ef6: the API's top level and
// the tarball's agreed exactly, but for `pax_global_header`, which is tar
// metadata rather than a file in the repository and is not a name any
// rule is about.
if (process.argv.includes('--live')) {
  const { readRepo, archiveUrl } = await import('../src/shared/github.js');
  const { tarNamesUnderTop } = await import('../src/build_server/lib/files.js');
  const live = browserGet();
  const r = await readRepo(live, { owner: 'psf', repo: 'requests', ref: 'main', needNames: true });
  ok(/^[0-9a-f]{40}$/.test(r.commit), 'live: main resolves to a commit id', r.commit);
  const res = await fetch(archiveUrl('psf', 'requests', r.commit));
  const tar = tarNamesUnderTop(Buffer.from(await res.arrayBuffer()));
  const top = [...new Set(tar.filter((n) => n && n.indexOf('/') < 0 && n !== 'pax_global_header'))].sort();
  ok(JSON.stringify(top) === JSON.stringify(r.names),
    'live: the API\'s top-level file list is the tarball\'s, which is what the build server used to read',
    JSON.stringify(top) + '\n    ' + JSON.stringify(r.names));
}

mock.close();
fs.rmSync(data, { recursive: true, force: true });
console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
