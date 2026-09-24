// The release ledger: which bytes of this page we have published, when.
//
// Why it is a chain and not a list. A list we serve, of hashes we chose,
// signed by a key we hold, says only "we say so" -- we could rewrite it
// tomorrow and nobody could tell. The chain makes a rewrite *visible*,
// but only to someone holding an older root to compare against, and that
// is the part this project gets for free: the application is one HTML
// file that people save and pass on, so every copy in the wild carries
// the root as of the day it was built. Rewriting history means
// contradicting files other people already hold.
//
// root(0) is 64 zeros. root(n) = sha256(root(n-1) + "\n" + line(n)),
// where line(n) is the entry's own text, tab separated:
//
//   <seq>\t<iso date>\t<git rev>\t<sha256 of the page>
//
// The roots are derived, never stored, so the file cannot disagree with
// itself. A page cannot contain its own hash, so the root baked into a
// page is the one *before* its own entry -- entry n is written after
// page n exists, which is the same reason a transparency log's tree head
// never covers the entry being added.
//
// `sha256hex` is passed in: the page has its own implementation and the
// server has node's, and both have to agree to the byte.

export const ZERO_ROOT = '0'.repeat(64);

export function entryLine(e) {
  const base = [e.seq, e.date, e.rev, e.sha256];
  // The runtime-script roots as of this release, when there were any.
  // Optional, so entries written before this field still chain to the
  // same roots they always did -- an append-only log cannot go back and
  // add a field to what is already in it.
  //
  // Why it is here at all: the tree is signed with a key we hold, so we
  // could re-sign a changed tree and nothing in the signature would say
  // so. Putting its root in the chain means changing it contradicts
  // every copy of the page already in the wild, which is the one thing
  // we cannot do quietly.
  if (e.rtroot) base.push(e.rtroot);
  return base.join('\t');
}

// Every root from the first entry to the last, in order.
export function chainRoots(entries, sha256hex) {
  const out = [];
  let root = ZERO_ROOT;
  for (const e of entries) {
    root = sha256hex(root + '\n' + entryLine(e));
    out.push(root);
  }
  return out;
}

export function chainRoot(entries, sha256hex) {
  const roots = chainRoots(entries, sha256hex);
  return roots.length ? roots[roots.length - 1] : ZERO_ROOT;
}

// `release` lines out of a ti-releases document, in file order. Anything
// that is not a well-formed release line is ignored rather than guessed
// at: a line we cannot read is not an entry we can chain.
export function parseReleases(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const f = raw.replace(/\r$/, '').split('\t');
    if (f[0] !== 'release' || f.length < 5) continue;
    const seq = Number(f[1]);
    if (!isFinite(seq) || seq < 1) continue;
    if (!/^[0-9a-f]{64}$/.test(f[4])) continue;
    const e = { seq, date: f[2], rev: f[3], sha256: f[4] };
    if (f.length > 5 && /^[0-9a-f]{64}$/.test(f[5])) e.rtroot = f[5];
    out.push(e);
  }
  return out;
}

// Does this document's own `root` match what its entries chain to, and
// are the sequence numbers 1..n with no gaps? Returns { ok, why, root }.
export function checkChain(entries, stated, sha256hex) {
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].seq !== i + 1) {
      return { ok: false, why: 'the entries are not numbered 1 to ' + entries.length +
        ' (entry ' + (i + 1) + ' says ' + entries[i].seq + ')', root: '' };
    }
  }
  const root = chainRoot(entries, sha256hex);
  // A ledger with no `root` line of its own is accepted, and that is
  // deliberate (tests/proof-test.mjs). The audit called it fail-open,
  // but `stated` is only the document's own convenience copy: the check
  // a rewritten log has to defeat is in verify.js, which compares the
  // root computed here against the one baked into this page on the day
  // it was built. Making the absence fatal would refuse older ledgers
  // and gain nothing.
  if (stated && stated !== root) {
    return { ok: false, why: 'the root it states is not what its own entries chain to', root };
  }
  return { ok: true, why: '', root };
}

// Is `root`, which some older copy of the page carries, the root this
// log had at that point? If the log has been rewritten behind that
// copy's back, it will not be.
export function rootAt(entries, seq, sha256hex) {
  if (!seq || seq < 1 || seq > entries.length) return '';
  return chainRoots(entries.slice(0, seq), sha256hex).pop() || '';
}
