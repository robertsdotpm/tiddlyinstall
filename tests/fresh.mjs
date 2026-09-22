// Refuse to test a page that is older than the code it was built from.
//
// Why this exists: on 2026-09-22 four suites reported 1,373 passes against
// out/index.html while three changes sat unbuilt in src/. Every suite
// defaults to out/, nothing rebuilds it, and a stale page fails nothing --
// it just answers questions about yesterday. That is this project's oldest
// bug wearing a new hat (CLAUDE.md: "a broken measurement and a clean
// result look identical"), and it was caught only because an assertion
// that was *meant* to fail did. An assertion that happened to pass would
// have been reported as success.
//
// So: compare the page's mtime against everything it is built from, and
// stop rather than measure the wrong bytes. TI_ALLOW_STALE=1 overrides it
// for the rare case where you mean it.
import fs from 'node:fs';
import path from 'node:path';

// What build_site.py reads. registry/ is deliberately absent: the
// catalogue is snapshotted and cached on purpose (tools/deploy.sh), so
// treating it as a source would cry stale on every cached build.
const SOURCES = ['src/web_client', 'src/shared', 'tools/build_site.py'];

function newest(p, acc) {
  let st;
  try { st = fs.statSync(p); } catch { return acc; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) acc = newest(path.join(p, e), acc);
    return acc;
  }
  return st.mtimeMs > acc.ms ? { ms: st.mtimeMs, file: p } : acc;
}

// Returns null when fresh, or a description of what is newer than the page.
export function stalePage(page, repo) {
  let pageSt;
  try { pageSt = fs.statSync(page); } catch { return null; }   // missing: let the suite say so
  let acc = { ms: 0, file: null };
  for (const s of SOURCES) acc = newest(path.join(repo, s), acc);
  if (!acc.file || acc.ms <= pageSt.mtimeMs) return null;
  return { page, newer: path.relative(repo, acc.file), seconds: Math.round((acc.ms - pageSt.mtimeMs) / 1000) };
}

// Call at the top of a suite, before anything is measured.
export function assertFresh(page, repo) {
  if (process.env.TI_ALLOW_STALE === '1') return;
  const s = stalePage(page, repo);
  if (!s) return;
  const mins = Math.round(s.seconds / 60);
  console.error(`STALE  ${path.relative(repo, s.page)} is older than ${s.newer} by ` +
    (mins >= 1 ? `${mins} min` : `${s.seconds}s`) + `.
       Testing it would measure the previous build, not your changes.
       Rebuild first:  python3 tools/build_site.py --catalog ~/.cache/tiddlyinstall -o out
       or point the suite at a build you just made:  --page <dir>/index.html
       (set TI_ALLOW_STALE=1 if you really mean to test the old page)`);
  process.exit(2);
}
