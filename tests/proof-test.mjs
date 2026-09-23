// The primitives the whole claim rests on: the Merkle tree an installer
// proves its runtime setup against, the hash chain that makes a rewritten
// release ledger visible, and the signature check the Verify page and the
// page's own builder share.
//
//   node tests/proof-test.mjs
//
// Why this exists. Until 2026-09-23 none of src/shared/merkle.js,
// ledger.js or signeddoc.js was named by any test. They were covered
// end to end -- the engines verify real proofs against a real root, on
// every platform -- so the happy path was checked several times over and
// every way they should say *no* was checked nowhere. That is the wrong
// half to leave out: a verifier that accepts everything passes every
// end-to-end test ever written.
//
// So almost everything here is a refusal. The one implementation that
// did have a negative test is the C one (src/installers/windows/
// plugin-src/build.sh edits a byte of a real plan and requires rtverify
// to refuse it); JavaScript is what *produces* every proof and what
// tells a person on the Verify page that their installer is proved.
import crypto from 'node:crypto';
import { NODE_PREFIX, leafHash, nodeHash, buildLevels, treeRoot, proofFor, rootFromProof } from '../src/shared/merkle.js';
import { ZERO_ROOT, entryLine, chainRoots, chainRoot, parseReleases, checkChain, rootAt } from '../src/shared/ledger.js';
import { docSignature, verifyDoc, docField } from '../src/shared/signeddoc.js';
import { canonicalTarget } from '../src/shared/rtscript.js';

let pass = 0, fail = 0;
const ok = (c, m, d) => { if (c) { pass++; console.log('PASS ' + m); } else { fail++; console.log('FAIL ' + m + (d ? '\n     ' + d : '')); } };

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const leaves = (n) => Array.from({ length: n }, (_, i) => sha('when\tlinux\t0\t9999\t*\nfile\tr' + i + '\n'));

/* ---------- merkle: the formulas ---------- */

ok(leafHash('x', sha) === sha('x'), 'leaf(text) is sha256(text)');
ok(nodeHash('a', 'b', sha) === sha(NODE_PREFIX + 'ab'), 'node(l,r) is sha256("ti-node\\n" + l + r)');
ok(NODE_PREFIX === 'ti-node\n', 'the node prefix is exactly "ti-node\\n"');

/* ---------- merkle: a proof reaches the root, and only for its own leaf ---------- */

for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17]) {
  const ls = leaves(n);
  const root = treeRoot(ls, sha);
  let good = 0, crossed = 0;
  for (let i = 0; i < n; i++) {
    const p = proofFor(ls, i, sha);
    if (rootFromProof(ls[i], p, sha) === root) good++;
    // ...and the same proof must not carry any other leaf to the root.
    for (let j = 0; j < n; j++) if (j !== i && rootFromProof(ls[j], p, sha) === root) crossed++;
  }
  ok(good === n, n + ' leaves: every proof reaches the root', good + ' of ' + n);
  ok(crossed === 0, n + ' leaves: no proof carries another leaf to the root', crossed + ' did');
}

/* ---------- merkle: the refusals ---------- */

{
  const ls = leaves(7), root = treeRoot(ls, sha), p = proofFor(ls, 3, sha);
  const bend = (s) => s.slice(0, -1) + (s.slice(-1) === '0' ? '1' : '0');

  ok(rootFromProof(bend(ls[3]), p, sha) !== root, 'a changed leaf does not reach the root');

  const tampered = p.slice(); tampered[0] = tampered[0][0] + bend(tampered[0].slice(1));
  ok(rootFromProof(ls[3], tampered, sha) !== root, 'a changed sibling does not reach the root');

  const flipped = p.map((s) => (s[0] === 'L' ? 'R' : 'L') + s.slice(1));
  ok(rootFromProof(ls[3], flipped, sha) !== root, 'swapping which side each sibling is on does not reach the root');

  ok(rootFromProof(ls[3], p.slice(0, -1), sha) !== root, 'a proof with a step missing does not reach the root');
  ok(rootFromProof(ls[3], [...p, 'L' + ls[0]], sha) !== root, 'a proof with a step added does not reach the root');
  ok(rootFromProof(ls[3], ['Lnothex'], sha) === '', 'a sibling that is not 64 hex characters is refused outright');
  ok(rootFromProof(ls[3], ['L' + ls[0].toUpperCase()], sha) === '', 'and uppercase hex is not accepted either');
}

/* ---------- merkle: CVE-2012-2459 ---------- */
//
// The bug this shape exists to avoid. Where an odd node is paired with a
// *copy of itself*, the leaf list [a,b,c] and the leaf list [a,b,c,c]
// build the same root, so a proof for one is a proof for the other and
// the root no longer says which list it came from. Here an odd node is
// promoted unchanged, so the two differ.
{
  const [a, b, c] = leaves(3);
  ok(treeRoot([a, b, c], sha) !== treeRoot([a, b, c, c], sha),
    '[a,b,c] and [a,b,c,c] do not share a root (CVE-2012-2459)');
  ok(treeRoot([a, b, c], sha) === nodeHash(nodeHash(a, b, sha), c, sha),
    'the odd node is promoted unchanged, not paired with itself');
  const [d, e] = leaves(5).slice(3);
  ok(treeRoot([a, b, c, d, e], sha) !== treeRoot([a, b, c, d, e, e], sha),
    'and the same holds one level up');
}

/* ---------- merkle: what the domain separation actually rests on ---------- */
//
// leaf(text) = sha256(text) and node(l,r) = sha256("ti-node\n" + l + r),
// so a leaf whose *text* began "ti-node\n" would hash as an internal
// node. Nothing in merkle.js stops that: what stops it is that a leaf is
// always a canonical target block, and those begin "when\t". That is a
// property of rtscript.js, so it is checked there rather than assumed.
{
  const blk = 'when\tlinux\t0\t9999\t*\nruntime\tpython\t3.14.7\tamd64\nlaunch\t"{runtime}"\n';
  const canon = canonicalTarget(blk);
  ok(canon.startsWith('when\t'), 'a canonical target block begins "when\\t", so no leaf can look like a node');
  ok(!canon.includes('\nlaunch\t'), 'and the launch line is not in it: the builder wrote that, not us');
}

/* ---------- ledger ---------- */

const entries = [
  { seq: 1, date: '2026-09-20', rev: 'aaaaaaa', sha256: sha('page1') },
  { seq: 2, date: '2026-09-21', rev: 'bbbbbbb', sha256: sha('page2') },
  { seq: 3, date: '2026-09-22', rev: 'ccccccc', sha256: sha('page3'), rtroot: sha('roots') },
];

ok(ZERO_ROOT === '0'.repeat(64), 'root(0) is sixty-four zeros');
ok(chainRoot([], sha) === ZERO_ROOT, 'an empty log chains to root(0)');
{
  let r = ZERO_ROOT;
  for (const e of entries) r = sha(r + '\n' + entryLine(e));
  ok(chainRoot(entries, sha) === r, 'root(n) is sha256(root(n-1) + "\\n" + line(n))');
}
ok(chainRoots(entries, sha).length === entries.length, 'chainRoots gives one root per entry');
ok(rootAt(entries, 2, sha) === chainRoots(entries, sha)[1], 'rootAt(n) is the root as of entry n');

// The point of the chain: a rewrite behind a copy already in the wild.
for (const [field, val] of [['date', '2026-09-99'], ['rev', 'ddddddd'], ['sha256', sha('other')]]) {
  const edited = entries.map((e, i) => (i === 0 ? { ...e, [field]: val } : e));
  ok(chainRoot(edited, sha) !== chainRoot(entries, sha),
    'changing entry 1\'s ' + field + ' changes every root after it');
  ok(rootAt(edited, 3, sha) !== rootAt(entries, 3, sha),
    '...so a page holding the root at 3 can tell (' + field + ')');
}
ok(chainRoot(entries.slice(0, 2).concat(entries[2]), sha) === chainRoot(entries, sha), 'the same entries chain the same way twice');
ok(chainRoot([entries[0], entries[2]], sha) !== chainRoot(entries, sha), 'dropping an entry changes the root');
ok(chainRoot([entries[1], entries[0], entries[2]], sha) !== chainRoot(entries, sha), 'reordering entries changes the root');

// rtroot is optional, and cannot be back-filled quietly.
{
  const withRt = entries.map((e, i) => (i === 0 ? { ...e, rtroot: sha('added later') } : e));
  ok(chainRoot(withRt, sha) !== chainRoot(entries, sha),
    'adding a runtime root to an entry already in the log changes the chain');
  ok(entryLine(entries[0]).split('\t').length === 4, 'an entry with no runtime root is four fields');
  ok(entryLine(entries[2]).split('\t').length === 5, 'and five with one');
}

// checkChain
ok(checkChain(entries, chainRoot(entries, sha), sha).ok, 'a log that states its own root is accepted');
ok(!checkChain(entries, sha('wrong'), sha).ok, 'a log stating a root its entries do not chain to is refused');
ok(!checkChain([entries[0], { ...entries[2] }], '', sha).ok, 'a gap in the sequence numbers is refused');
ok(!checkChain([{ ...entries[0], seq: 2 }], '', sha).ok, 'a log that does not start at 1 is refused');
ok(checkChain(entries, '', sha).ok, 'with no stated root, well-numbered entries are accepted');

// parseReleases
{
  const doc = [
    'ti-releases\t1',
    'release\t1\t2026-09-20\taaaaaaa\t' + sha('page1'),
    'release\t2\t2026-09-21\tbbbbbbb\t' + sha('page2') + '\t' + sha('roots'),
    'release\t3\tshort',                       // too few fields
    'release\tx\t2026-09-22\tccccccc\t' + sha('p'), // seq not a number
    'release\t4\t2026-09-22\tddddddd\tnothex',  // sha not hex
    'note\tsomething else',
  ].join('\n');
  const got = parseReleases(doc);
  ok(got.length === 2, 'parseReleases keeps only well-formed release lines', got.length + ' kept');
  ok(got[1].rtroot === sha('roots'), 'and reads the optional runtime root');
  ok(got[0].rtroot === undefined, 'and leaves it off where there is none');
}

/* ---------- signeddoc ---------- */

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const RAW = publicKey.export({ format: 'jwk' }).x;
const b64bytes = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const verify = (pub, msg, sig) => crypto.verify(null, Buffer.from(msg), pub, Buffer.from(sig));
const sign = (text) => text + 'sig\ted25519\t' +
  crypto.sign(null, Buffer.from(text, 'utf8'), privateKey).toString('base64') + '\n';

const plan = 'ti-plan\t1\nrecord\tabc\nname\tHello\n';
const signedPlan = sign(plan);

ok(verifyDoc(signedPlan, 'ti-plan', publicKey, b64bytes, verify), 'a signed plan verifies');
ok(!verifyDoc(signedPlan, 'ti-revocations', publicKey, b64bytes, verify),
  'and does NOT verify read as a revocation list: the kind prefix is what stops that');
ok(!verifyDoc(sign('ti-revocations\t1\nissued\tx\n'), 'ti-plan', publicKey, b64bytes, verify),
  'nor the other way round');
ok(!verifyDoc(signedPlan.replace('name\tHello', 'name\tEvil'), 'ti-plan', publicKey, b64bytes, verify),
  'a changed body does not verify');
ok(!verifyDoc(signedPlan, 'ti-plan', crypto.generateKeyPairSync('ed25519').publicKey, b64bytes, verify),
  'another key does not verify it');
ok(!verifyDoc(signedPlan, 'ti-plan', null, b64bytes, verify), 'with no key, nothing verifies');
ok(!verifyDoc('', 'ti-plan', publicKey, b64bytes, verify), 'an empty document does not verify');
ok(!verifyDoc(plan, 'ti-plan', publicKey, b64bytes, verify), 'an unsigned document does not verify');
ok(!verifyDoc(signedPlan, 'ti-plan', publicKey, b64bytes, () => { throw new Error('boom'); }),
  'a verifier that throws is a refusal, not an exception');

{
  const flip = (b64) => { const b = Buffer.from(b64, 'base64'); b[0] ^= 1; return b.toString('base64'); };
  const bad = signedPlan.replace(/sig\ted25519\t(\S+)/, (m, s) => 'sig\ted25519\t' + flip(s));
  ok(!verifyDoc(bad, 'ti-plan', publicKey, b64bytes, verify), 'one flipped bit in the signature does not verify');
}

ok(docSignature(plan, 'ti-plan', b64bytes).why === 'no sig line', 'an unsigned document says so');
ok(/not ed25519/.test(docSignature(plan + 'sig\trsa\tAAA\n', 'ti-plan', b64bytes).why), 'a signature type we do not do is named');
ok(/not 64/.test(docSignature(plan + 'sig\ted25519\tAAAA\n', 'ti-plan', b64bytes).why), 'a signature of the wrong length is refused');
ok(/do not start with/.test(docSignature(signedPlan, 'ti-releases', b64bytes).why), 'the wrong kind is named as the reason');
ok(docSignature(signedPlan, 'ti-plan', b64bytes).signed, 'and a good one is accepted');
ok(docField(plan, 'record') === 'abc' && docField(plan, 'nope') === '', 'docField reads a header field, or nothing');
ok(RAW.length > 0, 'the fixture key exists');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
