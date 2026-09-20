// What we say about a download our mirror has no copy of, in one place,
// because three surfaces say it and they must not drift (as shared/form-job.js
// exists so the form and the server can't drift).
//
// Our mirror exists because an old machine often cannot complete a modern
// TLS handshake to a vendor, so plain `http://` from our own host is the
// only way it can download anything (design.md 1.3). The mirror is filled
// from what the newest plans download, but the form lets a publisher pin a
// version (`select` range or exact) and the resolver will happily choose a
// release nobody mirrored. That plan then carries vendor URLs only, which
// on Windows 7 can mean the download simply fails -- the Ruby 3.2 case in
// docs/test-results.md -- and until now nothing said so anywhere.
//
// Who says it:
//
//   shared/resolve.js   the plan's `note`, which the engines print on the
//                   installer's review screen before anything is downloaded
//   web/build.js     the build page, where the publisher can still choose
//                   another version -- the half that matters most
//
// A mirror is never complete the instant a vendor publishes something, so
// this is permanent, not a stopgap for one gap.

export const MIRROR_GAP_WHY =
  'so it can only be downloaded from the vendor. A computer that cannot reach the vendor directly, '
  + 'such as an old system that cannot make a modern HTTPS connection, may not be able to download it.';

// At most three names, then "and N more": a review screen on an 80-column
// terminal has to stay readable.
export function fileNameList(names) {
  const n = (Array.isArray(names) ? names : []).map((s) => String(s == null ? '' : s)).filter((s) => s !== '');
  if (n.length <= 3) return n.join(', ');
  return n.slice(0, 3).join(', ') + ' and ' + (n.length - 3) + ' more';
}

// The plan's `note` for one target block (shared/resolve.js writeTarget).
export function mirrorGapNote(names) {
  return 'This version is not on the TiddlyInstall mirror (' + fileNameList(names) + '), ' + MIRROR_GAP_WHY;
}

// The build page's line (web/build.js), the same fact told to the person
// who can still act on it.
export function mirrorGapBuildWarning(names) {
  const n = (Array.isArray(names) ? names : []).length;
  return (n === 1 ? 'One file these installers download is not on the TiddlyInstall mirror'
    : n + ' of the files these installers download are not on the TiddlyInstall mirror')
    + ' (' + fileNameList(names) + '), ' + MIRROR_GAP_WHY
    + ' If that matters for who you are sending these to, build again with a version the mirror has:'
    + ' the newest in a range usually is.';
}
