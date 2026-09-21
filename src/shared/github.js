// Reading a GitHub repository's shape from the GitHub API, the same code in
// the page and on the build server (design.md 11.0, "GitHub sources without
// a build server").
//
// Two things have to be known before a record can be written for a GitHub
// source: **which commit** it names, and **what is at the top of it**, from
// which the install rule is chosen (`requirements.txt` -> pip,
// `package.json` -> npm, `Gemfile` -> bundler; docs/format.md
// "`install default:<rule>`").
//
// The build server used to learn both by downloading the repo's tarball,
// which a browser cannot do -- codeload.github.com sends no CORS headers,
// and sends none by design. If the server kept deriving them that way and
// the page derived them some other way, one form would give two records
// for one repo: two hashes, two appids, two install folders. So **both
// sides read them from the API**, which is browser-reachable, and this
// file is the one derivation.
//
// Confirmed from a real browser, not from documentation (2026-09-21,
// headless Chrome, page served over http://127.0.0.1): api.github.com
// answers cross-origin with `access-control-allow-origin: *` on 200 and on
// 404, and lists the rate-limit headers in `access-control-expose-headers`,
// so a page can read `x-ratelimit-remaining` and `x-ratelimit-reset` and
// say when to try again. codeload.github.com fails with a CORS TypeError in
// the same page, as registry/cors.json already recorded for
// github.com. Recorded there too, under `api.github.com`.
//
// **Rate limits are the thing that will bite.** Unauthenticated the API
// allows 60 requests an hour per internet address. From the page that is
// the user's own address and is mostly plenty; on the build server it is
// one address shared by everybody, and it will run out. Nothing here ever
// falls back to "no install rule" -- a refusal that says what to do
// instead is the whole of the graceful path, and the caller supplies the
// sentence about whose address ran out.
//
// The transport differs (the browser's fetch, the server's public-only
// client), so the caller passes a `get`; everything derived from what
// comes back is here.

// owner/repo, with or without the github.com address and a .git suffix.
export const githubRe = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

// A full commit id, which is the only ref that needs no lookup -- and so
// the only one a page with no network at all can pin (design.md 11.0).
export const commitRe = /^[0-9a-f]{40}$/;

// A branch, tag or commit as a path segment we are willing to build:
// letters, digits and `. _ - /`, no `..`, no leading or trailing slash.
// Not a URL escape, deliberately: an escaped `/` is not the same ref to
// GitHub, and a ref we cannot write literally is one we refuse.
export const refRe = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,119}$/;

export const GITHUB_API = 'https://api.github.com';

export function validRef(ref) {
  const s = String(ref || '');
  return refRe.test(s) && s.indexOf('..') < 0 && s.charAt(s.length - 1) !== '/';
}

// parseRepo("https://github.com/psf/requests.git") -> {owner, repo}
export function parseRepo(value) {
  const m = githubRe.exec(String(value || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Where an engine fetches the source. HTTPS only, because an unpinned
// source has nothing else identifying its bytes (format.md, "Sources
// without a stored hash"), and codeload rather than the github.com
// redirect to it, so the review screen names the host that actually
// serves the file.
export function archiveUrl(owner, repo, commit) {
  return 'https://codeload.github.com/' + owner + '/' + repo + '/tar.gz/' + commit;
}

// The name the plan gives the download. It has no SHA-256 to be named
// after, so it is named after the commit, which is what identifies it.
export function archiveName(commit) {
  return commit + '.tar.gz';
}

// Everything that went wrong talking to the API, told apart so a caller
// can say something useful. `kind` is one of:
//   'ratelimit'  the hourly allowance is gone; `seconds` until it resets
//   'notfound'   no such repository, or no such branch/tag/commit in it
//   'empty'      the repository has no commits
//   'truncated'  the answer was cut short, so the file list is incomplete
//   'offline'    the API could not be reached at all
//   'nonetwork'  nothing was tried: this copy of the page does not make
//                network requests (a saved one-file copy)
//   'http'       any other answer, or one that could not be read
export class GitHubError extends Error {
  constructor(kind, message, info) {
    super(message);
    this.kind = kind;
    this.github = true;
    if (info) for (const k of Object.keys(info)) this[k] = info[k];
  }
}

// The browser's transport: fetch, and the few headers we read back.
// `get(url, accept)` -> {status, headers, text}, headers lowercase.
export function browserGet(fetchFn) {
  const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
  return async function (url, accept) {
    if (!f) throw new GitHubError('offline', 'this browser has no fetch()');
    let r;
    try {
      r = await f(url, { headers: { Accept: accept } });
    } catch (e) {
      // A CORS refusal and a dead network are the same TypeError here.
      throw new GitHubError('offline', String((e && e.message) || e));
    }
    const h = {};
    for (const k of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'retry-after']) {
      const v = r.headers && r.headers.get ? r.headers.get(k) : null;
      if (v != null) h[k] = String(v);
    }
    let text = '';
    try { text = await r.text(); } catch (e) { text = ''; }
    return { status: r.status, headers: h, text };
  };
}

// A transport that makes no request at all, for a saved copy of the
// page. The standing promise there is that nothing but a package
// registry lookup ever leaves it (src/web_client/local-api.js), and a GitHub
// installer does not need one: a full commit id and an install command
// are the two things the API would have been asked for, and both can be
// typed. So the refusal names them rather than pretending the network
// failed.
export function noNetworkGet() {
  return async function () {
    throw new GitHubError('nonetwork', 'this saved copy of the page does not contact anything');
  };
}

const num = (v) => { const n = Number(v); return isFinite(n) ? n : NaN; };

// How long until the allowance comes back, in seconds, from whichever
// header says: `retry-after` (secondary limits) or `x-ratelimit-reset`
// (an epoch second). Zero when neither does.
export function resetSeconds(headers, nowMs) {
  const h = headers || {};
  const ra = num(h['retry-after']);
  if (ra >= 0) return Math.ceil(ra);
  const reset = num(h['x-ratelimit-reset']);
  if (reset > 0) return Math.max(0, Math.ceil(reset - (nowMs || Date.now()) / 1000));
  return 0;
}

// "in about 12 minutes" / "in under a minute": what a person waits.
export function waitWords(seconds) {
  if (!(seconds > 0)) return 'in a little while';
  if (seconds < 60) return 'in under a minute';
  const m = Math.ceil(seconds / 60);
  return 'in about ' + m + ' minute' + (m === 1 ? '' : 's');
}

function fail(res, what, nowMs) {
  const h = res.headers || {};
  const limited = (res.status === 403 || res.status === 429) &&
    (h['x-ratelimit-remaining'] === '0' || h['retry-after'] !== undefined);
  if (limited) {
    const seconds = resetSeconds(h, nowMs);
    throw new GitHubError('ratelimit', 'GitHub is rate-limiting us: its API allows ' +
      (h['x-ratelimit-limit'] || '60') + ' requests an hour from one internet address.',
      { seconds, wait: waitWords(seconds), limit: h['x-ratelimit-limit'] || '60' });
  }
  if (res.status === 404) throw new GitHubError('notfound', 'GitHub has no ' + what + ' (or it is private).');
  if (res.status === 409) throw new GitHubError('empty', 'GitHub says ' + what + ' has no commits yet.');
  if (res.status === 451) throw new GitHubError('http', 'GitHub has made ' + what + ' unavailable.');
  throw new GitHubError('http', 'GitHub answered ' + res.status + ' for ' + what + '.');
}

async function call(get, url, accept, what, nowMs) {
  const res = await get(url, accept);
  if (!res || typeof res.status !== 'number') throw new GitHubError('http', 'GitHub: unreadable answer for ' + what + '.');
  if (res.status !== 200) fail(res, what, nowMs);
  return res;
}

// The commit a branch, tag or commit id names. `Accept:
// application/vnd.github.sha` makes the answer the 40 characters and
// nothing else -- one request, and no JSON to disagree about.
export async function resolveCommit(get, owner, repo, ref, nowMs) {
  const where = owner + '/' + repo + ' at ' + ref;
  const res = await call(get, GITHUB_API + '/repos/' + owner + '/' + repo + '/commits/' + ref,
    'application/vnd.github.sha', where, nowMs);
  const sha = String(res.text || '').trim().toLowerCase();
  if (!commitRe.test(sha)) throw new GitHubError('http', 'GitHub returned an unexpected commit id for ' + where + '.');
  return sha;
}

// The names at the top of the repository at that commit: what the install
// rule is chosen from. Non-recursive, so this is the top level and nothing
// below it, which is exactly the set docs/format.md's rule table names --
// and which is why `truncated` is a refusal rather than a shrug: a
// truncated answer is a *shorter* list, and a shorter list silently picks
// a different rule.
//
// Folders are left out. The build server read these names from the
// tarball, where a folder is an entry ending in `/` and so never equal to
// `requirements.txt`; here a folder of that name would be, and a folder is
// not a file a rule can be about.
export async function topNames(get, owner, repo, commit, nowMs) {
  const where = owner + '/' + repo + ' at ' + commit;
  const res = await call(get, GITHUB_API + '/repos/' + owner + '/' + repo + '/git/trees/' + commit,
    'application/vnd.github+json', where + "'s file list", nowMs);
  let doc;
  try { doc = JSON.parse(res.text); } catch (e) { doc = null; }
  if (!doc || !Array.isArray(doc.tree)) throw new GitHubError('http', "GitHub's file list for " + where + ' could not be read.');
  if (doc.truncated) {
    throw new GitHubError('truncated', 'GitHub cut short the file list for ' + where +
      ', so which files are at the top of it cannot be known from here.');
  }
  const names = [];
  for (const e of doc.tree) {
    if (!e || typeof e.path !== 'string' || e.path === '' || e.path.indexOf('/') >= 0) continue;
    if (e.type === 'tree' || e.type === 'commit') continue;   // folders and submodules
    names.push(e.path);
  }
  // Sorted so the same repository always gives the same list, whatever
  // order the API happened to answer in. Nothing downstream depends on the
  // order -- the rule is chosen by set membership -- and that is the point:
  // it stays true if something ever does.
  names.sort();
  return names;
}

// readRepo: the commit and (when asked for) the top-level file names.
//
//   o.owner, o.repo   the repository
//   o.ref             branch, tag or commit id; '' or 'HEAD' for the
//                     default branch
//   o.needNames       false when the publisher gave an install command, so
//                     nothing has to be read off the files. With a full
//                     commit id as well, this makes **no API request at
//                     all**, which is what lets a saved copy of the page
//                     with no network build a GitHub installer.
//
// Returns {owner, repo, origin, commit, ref, resolved, names, project}.
// `resolved` is the ref it had to look up, or '' when the ref was already
// a commit id -- the UI says which, because "pinned to main" is not a pin.
export async function readRepo(get, o) {
  const owner = o.owner, repo = o.repo;
  const given = String(o.ref || '').trim();
  const ref = given === '' ? 'HEAD' : given;
  const nowMs = o.nowMs;
  const asCommit = commitRe.test(ref.toLowerCase()) ? ref.toLowerCase() : '';
  const commit = asCommit || await resolveCommit(get, owner, repo, ref, nowMs);
  const names = o.needNames ? await topNames(get, owner, repo, commit, nowMs) : [];
  return {
    owner, repo, origin: owner + '/' + repo, commit, ref,
    resolved: asCommit ? '' : ref, names, project: repo.toLowerCase(),
  };
}

// Whether readRepo would have to reach the network at all.
export function needsApi(ref, needNames) {
  const s = String(ref || '').trim().toLowerCase();
  return !!needNames || !commitRe.test(s);
}
