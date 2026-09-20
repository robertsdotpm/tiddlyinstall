// The signed revocation list, GET /api/revocations (design.md 7.1,
// docs/format.md section 7).
//
// `takedown.txt` in the data folder stays the single source of truth: this
// is the same file, time-stamped and signed with the plan key, for engines
// carrying their own plan. Every entry becomes one `revoke` line with the
// entry's words as its values, so nothing has to be maintained twice and a
// kind added to the file is published without a code change here.
//
// The document is stable for an hour: `issued` is the start of the current
// hour and `expires` an hour later, so the same list signs to the same
// bytes for every request in that hour (and can be cached, by us and by
// whoever carries it). A change to takedown.txt shows at once: it changes
// the `revoke` lines and the `serial`.

export const REVOCATIONS_VERSION = '1';
export const HOUR = 3600;

const rfc3339 = (secs) => new Date(secs * 1000).toISOString().replace(/\.\d+Z$/, 'Z');

// One takedown entry as the values of a `revoke` line, or null if it can't
// be written: entries are split on whitespace, so no value can hold a tab,
// and a line longer than the format's 1000 bytes is left out rather than
// truncated into something that means something else.
export function revokeValues(entry) {
  const vals = String(entry).trim().split(/[ \t]+/).filter((v) => v !== '');
  if (!vals.length) return null;
  const line = ['revoke', ...vals].join('\t');
  if (Buffer.byteLength(line, 'utf8') > 1000) return null;
  return vals;
}

// The unsigned document. `entries` is takedownList()'s array (or null),
// `now` a Date or epoch milliseconds, `serial` a number that changes when
// the list does (the server passes takedown.txt's modification time).
export function revocationsText(entries, { now = Date.now(), serial = 0 } = {}) {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  const issued = Math.floor(Math.floor(ms / 1000) / HOUR) * HOUR;
  let out = 'ti-revocations\t' + REVOCATIONS_VERSION + '\n';
  out += 'issued\t' + rfc3339(issued) + '\n';
  out += 'expires\t' + rfc3339(issued + HOUR) + '\n';
  out += 'serial\t' + String(Math.max(0, Math.trunc(Number(serial) || 0))) + '\n';
  for (const e of entries || []) {
    const vals = revokeValues(e);
    if (vals) out += ['revoke', ...vals].join('\t') + '\n';
  }
  return out;
}
