// A Merkle tree over the runtime install scripts of one runtime, so an
// installer can prove the steps it carries came from our catalogue
// without carrying the catalogue.
//
// Why a tree and not a signature each: the catalogue has 30,828 releases
// (2026-09-23), which is north of a hundred thousand signable targets
// once platforms are counted -- far too much for a page to carry. One
// signed root per runtime covers all of them, and a plan carries a proof
// of about 550 bytes for the target it actually used.
//
// Everything is lowercase hex, and a parent is the hash of its two
// children's hex text concatenated. Not the neatest scheme in bytes, but
// the engines have to verify these: a POSIX shell has `sha256sum` and
// string concatenation and very little else, and NSIS has Sha256File.
// Hex in, hex out, no byte packing to get wrong in four languages.
//
//   leaf(text)   = sha256(text)
//   node(l, r)   = sha256("ti-node\n" + l + r)
//
// The prefix keeps a leaf from being read as an internal node: a leaf's
// text is a canonical target block, which always begins "when<TAB>", and
// never "ti-node".
//
// An odd node at a level is promoted unchanged rather than paired with a
// copy of itself. Duplicating is the commoner choice and is where CVE-
// 2012-2459 came from -- two different leaf lists giving one root. A
// promoted node cannot do that here because the leaf count is fixed by
// the signed root document, which states it.

export const NODE_PREFIX = 'ti-node\n';

export function leafHash(text, sha256hex) {
  return sha256hex(String(text));
}

export function nodeHash(left, right, sha256hex) {
  return sha256hex(NODE_PREFIX + left + right);
}

// Every level, bottom up: level[0] is the leaves, the last is [root].
export function buildLevels(leaves, sha256hex) {
  if (!leaves.length) return [[]];
  const levels = [leaves.slice()];
  let cur = leaves;
  while (cur.length > 1) {
    const next = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1], sha256hex) : cur[i]);
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

export function treeRoot(leaves, sha256hex) {
  const levels = buildLevels(leaves, sha256hex);
  const top = levels[levels.length - 1];
  return top.length ? top[0] : '';
}

// The sibling at each level for leaf `index`, as "L<hex>" or "R<hex>"
// saying which side the sibling is on. A promoted node has no sibling at
// that level and contributes nothing.
export function proofFor(leaves, index, sha256hex) {
  const levels = buildLevels(leaves, sha256hex);
  const out = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const cur = levels[l];
    const pair = i ^ 1;
    if (pair < cur.length) out.push((pair > i ? 'R' : 'L') + cur[pair]);
    i = Math.floor(i / 2);
  }
  return out;
}

// Walk a proof up from a leaf and say what root it reaches.
export function rootFromProof(leaf, proof, sha256hex) {
  let h = leaf;
  for (const step of proof) {
    const side = String(step).charAt(0);
    const sib = String(step).slice(1);
    if (!/^[0-9a-f]{64}$/.test(sib)) return '';
    h = side === 'R' ? nodeHash(h, sib, sha256hex) : nodeHash(sib, h, sha256hex);
  }
  return h;
}
