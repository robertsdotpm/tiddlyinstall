// The signed release ledger, GET /api/releases.
//
// `releases.txt` in the data folder is the single source of truth, one
// line per published page, appended by tools/deploy.sh once it has proved
// the page it served was built from HEAD. This is that file, chained,
// time-stamped and signed with the plan key, so a copy of the page can
// check another copy against something outside both of them.
//
// The chain, and why it is worth having, is in src/shared/ledger.js.
import { entryLine, chainRoot } from '../../shared/ledger.js';

export const RELEASES_VERSION = '1';

const rfc3339 = (secs) => new Date(secs * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

// One line of releases.txt to an entry, or null. Anything unreadable is
// dropped rather than guessed at: a line we cannot parse is not an entry
// we can chain, and a chain with a guess in it is worth nothing.
export function parseLine(line) {
  const f = String(line).replace(/\r$/, '').split('\t');
  if (f.length < 4) return null;
  const seq = Number(f[0]);
  if (!isFinite(seq) || seq < 1 || Math.trunc(seq) !== seq) return null;
  if (!/^[0-9a-f]{64}$/.test(f[3])) return null;
  if (f[1].indexOf('\t') >= 0 || f[2].indexOf('\t') >= 0) return null;
  return { seq, date: f[1], rev: f[2], sha256: f[3] };
}

export function parseFile(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (raw.trim() === '' || raw.startsWith('#')) continue;
    const e = parseLine(raw);
    if (e) out.push(e);
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// The unsigned document. `issued` is the whole minute, so the same
// ledger signs to the same bytes for a request a second later; there is
// no expiry, because a ledger can only ever grow and an old copy of it
// is still true about everything it names.
export function releasesText(entries, sha256hex, { now = Date.now() } = {}) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const issued = Math.floor(Math.floor(ms / 1000) / 60) * 60;
  let out = 'ti-releases\t' + RELEASES_VERSION + '\n';
  out += 'issued\t' + rfc3339(issued) + '\n';
  out += 'count\t' + entries.length + '\n';
  out += 'root\t' + chainRoot(entries, sha256hex) + '\n';
  for (const e of entries) out += 'release\t' + entryLine(e) + '\n';
  return out;
}
