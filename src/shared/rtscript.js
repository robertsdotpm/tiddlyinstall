// The runtime install script: the part of a plan we wrote, as against the
// part the person building it wrote.
//
// A `[target]` block is almost entirely catalogue data -- which file, its
// SHA-256, the mirrors, how to unpack it, what to run afterwards, where
// the interpreter ends up, what to clear from the environment. None of it
// depends on the app being installed. Two unrelated Python apps resolved
// on 2026-09-23 produced byte-identical blocks but for one line.
//
// That one line is `launch`, which ends with the user's own arguments.
// So: everything except `launch` is ours and can be signed in advance,
// per runtime release and platform, before anybody asks for it. The
// signature travels in the plan as an `rtsig` line and is checked by the
// installer against the key it already carries -- which is how an
// installer built in a browser, with no key and no server, can still say
// the runtime steps came from us.
//
// What is deliberately outside the signature: `launch`, the plan header
// (the app's name, where it installs, the record it answers) and the
// app's own source. We did not write those and should not vouch for them.

// Lines that are not part of what was signed. `launch` is the user's.
// `rtproof` and `rtroots` are the proof itself, which cannot be inside
// the thing it proves -- the signer hashed these blocks before either
// line existed. `sig` is the plan's own signature, which trails the last
// target and is not part of it.
export const NOT_SIGNED = ['launch', 'rtproof', 'rtroots', 'rtsig', 'sig'];
export const RTSIG_KEY = 'rtsig';

// The signable text of one target block, given the block exactly as the
// resolver wrote it (starting at its `when` line, no leading "[target]").
// Trailing whitespace is dropped so that a block written with or without
// a final newline signs the same.
export function canonicalTarget(block) {
  const keep = [];
  for (const raw of String(block).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    const key = line.split('\t')[0];
    if (NOT_SIGNED.indexOf(key) >= 0) continue;
    keep.push(line);
  }
  return keep.join('\n') + '\n';
}

// Every target block of a plan, in order, as written (without the
// "[target]" line itself). Used by the engines and the Verify page to
// re-derive what was signed.
export function targetBlocks(planText) {
  const parts = String(planText).split('\n[target]\n');
  return parts.slice(1);
}

// The signed roots document and one runtime's sorted leaf hashes, for
// the resolver to write proofs from. Same shape as setRevoked(): it goes
// on the catalogue, because it decides what gets written into a plan and
// the page and the server have to agree.
export function setRtScripts(cat, roots, leaves, sha256hex) {
  cat.rtscripts = (roots && leaves && leaves.length)
    ? { roots: String(roots), leaves, sha256hex }
    : null;
  return cat;
}

// The root this document states for a runtime, or ''.
export function rootFor(rootsDoc, runtime) {
  for (const raw of String(rootsDoc).split('\n')) {
    const f = raw.replace(/\r$/, '').split('\t');
    if (f[0] === 'root' && f[1] === runtime && /^[0-9a-f]{64}$/.test(f[2] || '')) return f[2];
  }
  return '';
}
