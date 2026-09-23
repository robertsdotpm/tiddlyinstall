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
    if (key === 'launch' || key === RTSIG_KEY || key === 'sig') continue;
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
