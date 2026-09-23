#!/usr/bin/env node
// Sign the runtime install scripts: one Merkle root per runtime, covering
// every release the catalogue can resolve.
//
//   node tools/sign_runtime_scripts.mjs [--catalog DIR] [--out DIR] [--runtimes a,b]
//
// What this is for. A `[target]` block of a plan, minus its `launch`
// line, is catalogue data: the file, its SHA-256, the mirrors, the unpack
// and run steps, where the interpreter lands. It does not depend on the
// app being installed -- two unrelated Python apps resolved on 2026-09-23
// produced byte-identical blocks. So it can be signed before anyone asks
// for it, which is how an installer built in a browser, holding no key
// and reaching no server, can still show that the runtime steps are ours.
//
// One signature per target would be ~8,800 signatures. One Merkle root
// per runtime covers them all, and a plan carries a ~900-byte proof for
// the target it used (src/shared/merkle.js).
//
// The leaves are *sorted*, and the sorted list ships beside the root.
// The page therefore never has to enumerate releases in the same order
// this tool did -- it hashes its own target, finds it in the list and
// walks the tree. An enumeration that silently drifted would otherwise
// break every proof at once, and look like nothing until someone ran an
// installer.
//
// What it cannot resolve, it counts and prints. A version this tool
// cannot reach is a version whose script ships unsigned, and that has to
// be visible here rather than discovered by a person pinning it.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { loadSnapshot, resolve, loadRuntimes, catalogRuntimeIDs } from '../src/shared/resolve.js';
import { canonicalTarget, targetBlocks } from '../src/shared/rtscript.js';
import { leafHash, treeRoot } from '../src/shared/merkle.js';
import { loadOrCreate, defaultKeyDir } from '../src/build_server/lib/plansig.js';
import { revocationsText } from '../src/build_server/lib/revocations.js';

const RTSCRIPTS_KIND = 'ti-rtscripts';
const REVOCATIONS_KIND = 'ti-revocations';
const CATALOG_KIND = 'ti-catalog-attest';
const PLATFORMS = ['windows', 'linux', 'macos'];
const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const catDir = arg('--catalog', path.join(process.env.HOME, '.cache/tiddlyinstall'));
const outDir = arg('--out', 'src/build_server/data/rtscripts');
const only = arg('--runtimes', '');

const bytes = new Uint8Array(fs.readFileSync(path.join(catDir, 'catalog.gz')));
const cat = await loadSnapshot(bytes);
const raw = JSON.parse(zlib.gunzipSync(Buffer.from(bytes)).toString('utf8'));
// The key lives outside the repository (plansig.js defaultKeyDir).
// This said 'src/build_server/data' until 2026-09-23, and when the key
// moved it did not fail -- loadOrCreate *creates* a key where it finds
// none, so it quietly minted a new one, signed 8,891 runtime scripts
// with it, and left its public half where build.sh bakes bases from.
// Every base built after that carried a key nothing had signed with.
const { signer } = loadOrCreate(defaultKeyDir(), () => {});

const ids = catalogRuntimeIDs(cat).filter((r) => !only || only.split(',').includes(r));
fs.mkdirSync(outDir, { recursive: true });

const rfc3339 = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');
const roots = [];
let grand = 0, grandMissed = 0;

for (const rt of ids) {
  await loadRuntimes(cat, [rt]);
  const rel = raw.files[rt + '/releases.json'];
  const arr = Array.isArray(rel) ? rel : (rel && rel.releases) || [];
  const versions = [...new Set(arr.map((r) => r.version).filter(Boolean))];
  const leaves = new Set();
  let missed = 0;
  // `newest` as well as every pinned version: what a build with no
  // version chosen resolves to is the commonest script of all, and it is
  // not always identical to the newest pinned one.
  const wants = [{ select: 'newest' }, ...versions.map((v) => ({ select: 'exact', range: v }))];
  for (const w of wants) {
    for (const plat of PLATFORMS) {
      let plan;
      try {
        plan = resolve(cat, Object.assign({ name: 'x', project: 'x', runtime: rt, platforms: [plat],
          launch: '{runtime}', mode: 'C', root: 'user' }, w));
      } catch (e) { missed++; continue; }
      for (const b of targetBlocks(plan)) {
        const c = canonicalTarget(b);
        // A `fail` target has nothing to install and nothing to vouch for.
        if (c.indexOf('\nfile\t') < 0 && c.indexOf('file\t') !== 0) continue;
        leaves.add(leafHash(c, sha256hex));
      }
    }
  }
  const sorted = [...leaves].sort();
  if (!sorted.length) { console.log(`${rt.padEnd(9)} nothing to sign`); continue; }
  const root = treeRoot(sorted, sha256hex);
  fs.writeFileSync(path.join(outDir, rt + '.leaves'), sorted.join('\n') + '\n');
  roots.push({ rt, root, count: sorted.length });
  grand += sorted.length;
  grandMissed += missed;
  console.log(`${rt.padEnd(9)} ${String(sorted.length).padStart(5)} scripts  root ${root.slice(0, 16)}  ${missed ? missed + ' unresolvable' : ''}`);
}

// One signed document naming every root, so an engine checks one
// signature however many runtimes it knows about.
let doc = RTSCRIPTS_KIND + '\t1\n';
doc += 'issued\t' + rfc3339() + '\n';
for (const r of roots) doc += 'root\t' + r.rt + '\t' + r.root + '\t' + r.count + '\n';
const signed = signer.signStringAs(RTSCRIPTS_KIND, doc);
fs.writeFileSync(path.join(outDir, 'roots.txt'), signed);

/* ---------- the other two documents the page carries ---------- */

// Everything a page carries and acts on should be checkable against the
// key it already has. The runtime scripts were the part that decides
// what *runs*; these two decide what is *offered* and what is *refused*,
// and were carried unsigned until 2026-09-23.
//
// Signed here rather than captured from a running server at deploy time:
// this pass already holds the key, and a build that has to reach a
// server to sign is a build that quietly does something else when the
// server is not there.

// The withdrawn-file list, in the same `ti-revocations` shape the server
// serves at /api/revocations, so an engine and a page read one format.
const takedownPath = path.join('src/build_server/data', 'takedown.txt');
let takedown = [];
let serial = 0;
try {
  takedown = fs.readFileSync(takedownPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && l[0] !== '#');
  serial = Math.floor(fs.statSync(takedownPath).mtimeMs / 1000);
} catch (e) { /* no list yet: a signed empty one still says "we looked" */ }
const revDoc = signer.signStringAs(REVOCATIONS_KIND, revocationsText(takedown, { now: Date.now(), serial }));
fs.writeFileSync(path.join(outDir, 'revocations.txt'), revDoc);

// The catalogue: its digest and when it was signed. Not the catalogue
// itself -- 2.1 MB, and the page already has it. What this adds is a
// dated statement that the bytes in the page are the bytes we published,
// checkable with the key the page carries.
const catSha = crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex');
let catDoc = CATALOG_KIND + '\t1\n';
catDoc += 'issued\t' + rfc3339() + '\n';
catDoc += 'sha256\t' + catSha + '\n';
catDoc += 'bytes\t' + bytes.length + '\n';
fs.writeFileSync(path.join(outDir, 'catalog.txt'), signer.signStringAs(CATALOG_KIND, catDoc));

console.log('---');
console.log(`${grand} signed runtime scripts across ${roots.length} runtimes`);
console.log(`withdrawn-file list signed: ${takedown.length} entr${takedown.length === 1 ? 'y' : 'ies'}, serial ${serial}`);
console.log(`catalogue attested: ${catSha.slice(0, 16)} (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
console.log(`leaf lists ${Math.round(grand * 65 / 1024)} KB, proof depth ${Math.ceil(Math.log2(Math.max(2, grand)))} steps`);
if (grandMissed) console.log(`${grandMissed} version/platform pairs could not be resolved and are NOT signed`);
console.log(`roots.txt written, signed as ${RTSCRIPTS_KIND}`);
