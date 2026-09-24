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
// Everything build_site.py opens, not the three that were easy to name.
// The prebuilt bases matter most: they are binaries the guard never
// stat'd, so editing base.nsi and rebuilding the page without rebuilding
// base.exe shipped the unfixed Windows engine with every suite green --
// which is exactly the failure this file exists to stop, one level down.
// src/build_server/data is deliberately not here as a whole: it holds
// live server state and would cry stale on every run. The two files the
// page actually bakes in are named individually.
const SOURCES = [
  'src/web_client', 'src/shared', 'tools/build_site.py',
  'src/installers/windows/out', 'src/installers/unix/out',
  'src/vendor/resedit-bundle.js',
  'src/build_server/data/plan-signing-key.pub',
  'src/build_server/data/rtscripts',
  'tests/browsers/compat.json',
  'LICENSE',
];

// ...skip: directories not to walk into. staleBase walks an engine tree
// that contains the built base, and a base is always newer than itself.
function newest(p, acc, ...skip) {
  if (skip.includes(p)) return acc;
  let st;
  try { st = fs.statSync(p); } catch { return acc; }
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) acc = newest(path.join(p, e), acc, ...skip);
    return acc;
  }
  return st.mtimeMs > acc.ms ? { ms: st.mtimeMs, file: p } : acc;
}

// The bases are built things too, and nothing was watching *them*.
//
// SOURCES above makes the page newer than src/installers/*/out, which
// catches a page built before a base. It cannot catch a base built before
// its own engine: change ti-engine.sh, rebuild the page, and the page is
// happily newer than a ti-base.run that predates the edit -- so the page
// ships an engine nobody built. That is the same bug one level further
// down, and it happened on 2026-09-25: base.exe had the new download
// spread and ti-base.run, from the day before, did not.
//
// macOS is built on a Mac (tools/build_macos_base.sh), so its zip is
// often older than the engine on purpose. It is listed anyway -- an
// engine change that has not reached the Mac is exactly the thing worth
// being told about -- and TI_ALLOW_STALE=1 is the way past it.
const BASES = [
  { out: 'src/installers/windows/out/base.exe', from: ['src/installers/windows'] },
  { out: 'src/installers/unix/out/ti-base.run', from: ['src/installers/unix'] },
  { out: 'src/installers/unix/out/ti-base-macos.zip', from: ['src/installers/unix'] },
];

// Returns null when every base is newer than the engine it is built from,
// or a description of the first that is not.
export function staleBase(repo) {
  for (const b of BASES) {
    let st;
    try { st = fs.statSync(path.join(repo, b.out)); } catch { continue; }  // not built here
    let acc = { ms: 0, file: null };
    for (const src of b.from) acc = newest(path.join(repo, src), acc, path.join(repo, 'src/installers/windows/out'), path.join(repo, 'src/installers/unix/out'));
    if (acc.file && acc.ms > st.mtimeMs) {
      return { base: b.out, newer: path.relative(repo, acc.file), seconds: Math.round((acc.ms - st.mtimeMs) / 1000) };
    }
  }
  return null;
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
  const b = staleBase(repo);
  if (b) {
    const mins = Math.round(b.seconds / 60);
    console.error(`STALE  ${b.base} is older than ${b.newer} by ` +
      (mins >= 1 ? `${mins} min` : `${b.seconds}s`) + `.
       The page bakes this base in, so testing it would measure an engine
       nobody built. Rebuild the base first:
         src/installers/windows/build.sh   (Windows)
         src/installers/unix/make_run.sh   (Linux)
         tools/build_macos_base.sh         (macOS, on the Mac)
       then rebuild the page.
       (set TI_ALLOW_STALE=1 if you really mean to test the old base)`);
    process.exit(2);
  }
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
