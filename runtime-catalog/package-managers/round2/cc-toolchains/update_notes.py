#!/usr/bin/env python3
"""One-shot, lock-safe append of the round-2 (2026-09-17) cc mirror-hunt
findings to catalog/cc/mirrors.json and catalog/cc/NOTES.md.

Run once. Idempotent guard: checks for the ISCAS entry / section heading
before appending, so a second run is a no-op.
"""
import fcntl
import json
import os
import tempfile
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[3]
LOCK = CATALOG / ".write.lock"
MIRRORS = CATALOG / "cc" / "mirrors.json"
NOTES = CATALOG / "cc" / "NOTES.md"

NEW_MIRROR_ENTRY = {
    "runtime": "llvm",
    "name": "ISCAS (Institute of Software, Chinese Academy of Sciences) github-release mirror",
    "region": "China",
    "operator": "Institute of Software, Chinese Academy of Sciences",
    "base": "https://mirror.iscas.ac.cn/github-release/llvm/llvm-project/LatestRelease/",
    "full_or_partial": "partial -- single stale snapshot, not rolling",
    "confirmed_on": [
        "https://github.com/llvm/llvm-project/releases/download/llvmorg-20.1.6/clang%2Bllvm-20.1.6-x86_64-pc-windows-msvc.tar.xz",
        "https://github.com/llvm/llvm-project/releases/download/llvmorg-20.1.6/LLVM-20.1.6-Linux-ARM64.tar.xz"
    ],
    "does_not_cover": (
        "The other 5 llvm-20.1.6 releases.json entries (LLVM-20.1.6-win32.exe, "
        "-win64.exe, -woa64.exe, LLVM-20.1.6-Linux-X64.tar.xz, "
        "clang+llvm-20.1.6-armv7a-linux-gnueabihf.tar.gz) all 404 on this host even "
        "though some appear as metadata-only rows (.sig/.jsonl present, archive itself "
        "gone) in its own directory listing -- confirmed absent by direct HEAD, not "
        "inferred from the listing. No other llvm-project version has any directory "
        "here (the mirror is frozen on its one 'LatestRelease' sync from 30-May-2025, "
        "predating the catalog's newest recorded release 23.1.1 by four majors). "
        "brechtsanders/winlibs_mingw and skeeto/w64devkit are both 404 at the "
        "github-release root -- this host does not carry either project at all."
    ),
    "protocols": {
        "https": True,
        "http": "not tried (https sufficient to confirm)"
    },
    "method": (
        "HEAD, exact Content-Length match against the GitHub release asset, per-entry "
        "(this is a partial/rolling-style mirror so every candidate in the release was "
        "HEAD-checked individually rather than applied by template; 2 of 7 matched)."
    ),
    "hash_verified_sample": (
        "Neither matched asset has a GitHub API digest (both predate GitHub's digest "
        "rollout, same as the existing releases.json checksum:null for these rows). "
        "Downloaded a same-release sibling file instead as infrastructure "
        "corroboration -- cmake-20.1.6.src.tar.xz, 8644 bytes -- confirmed against the "
        "GitHub API's recorded size for that exact asset (GitHub also reports no "
        "digest for it)."
    ),
    "source_list": "found via targeted probing of known China github-release mirror front-ends (same family as the already-confirmed NJU mirror), not a web search",
    "date_checked": "2026-09-17"
}

NOTES_SECTION = """

## Mirror hunt round 2 (2026-09-17)

Task: extend WinLibs, LLVM prebuilt-binary, and w64devkit coverage (round 1
left these as GitHub-release-only / canonical, at 192/1416 = 13.6%
releases.json and 47/182 = 25.8% download_plan_majors.json). Result: **one**
new confirmed mirror, worth very little coverage -- see below for why the
round-1 rejections all still hold and one new one was found.

### Confirmed

- **ISCAS github-release mirror** (`mirror.iscas.ac.cn/github-release/`):
  a real, distinct China mirror (Institute of Software, Chinese Academy of
  Sciences) not previously tested. Its `llvm/llvm-project/` tree holds only
  one directory, `LatestRelease/`, frozen at the moment it was last synced
  (30-May-2025, llvmorg-20.1.6) -- it is not rolling and not full even for
  that one release: HEAD-checking all 7 releases.json rows for 20.1.6
  individually found only 2 actually present (windows/amd64 archive,
  linux/arm64 archive; both exact Content-Length matches), the other 5 are
  404 even though the mirror's own directory listing shows stale
  `.sig`/`.jsonl` sidecar rows for some of them (their real archives were
  evidently pruned after the fact -- a reminder that a directory listing on
  a partial mirror is not evidence by itself, only the per-file HEAD is).
  It does not carry winlibs_mingw or w64devkit at all (404 at
  `github-release/brechtsanders/` and `github-release/skeeto/`). Recorded
  in `mirrors.json`; applied via `tools/add_mirrors.py` directly to the 2
  matching releases.json entries (not a template -- see round-1 note on
  partial mirrors). Net effect: releases.json 192->194 (13.6%->13.7%);
  download_plan_majors.json unchanged (20.1.6 isn't the newest 20.x patch,
  so it was never in that plan to begin with).

### Rejected / confirmed still blocked

- **SourceForge, all forms** (project pages, `downloads.sourceforge.net`
  direct links, `use_mirror=` redirector links, and named
  `<mirror>.dl.sourceforge.net` hosts): tested against a definitely-real,
  definitely-public file (7-Zip 23.01) as a control, not just the WinLibs/
  mingw-w64 guesses -- every form is unreachable from this network
  (403 on the sourceforge.net-family hosts, `000`/connection failure on
  `netcologne.dl.sourceforge.net`). This is a network-level block on the
  whole SourceForge distribution infrastructure from this environment, not
  a per-URL Cloudflare challenge on project pages as round 1 described --
  so the round-1 "try a direct mirror link" and "try a named mirror host"
  leads are now confirmed dead ends here, not just untried. This closes out
  both the WinLibs-on-SourceForge lead and the mingw-w64 "Toolchains
  targetting Win64/Win32" SourceForge-folder lead the brief asked about --
  neither could be reached to even identify folder names, so no gaps.json
  entries were guessed at, per instructions.
- **winlibs.com**: every download link on the page points straight at
  `github.com/brechtsanders/winlibs_mingw/releases/download/...` -- it's a
  front-end for the same GitHub releases already canonical, not an
  independent host.
- **MSYS2**: `packages.msys2.org`/`repo.msys2.org` build their own
  `mingw-w64-gcc` package (currently 13.3.0-1, 14.2.0-1, ... as
  `.pkg.tar.zst`) from source under MSYS2's own versioning and packaging --
  confirmed it is not a repackage of WinLibs' prebuilt archives, so it's
  out of scope rather than a mirror.
- **TUNA github-release** (`mirrors.tuna.tsinghua.edu.cn/github-release/`):
  re-tried with a fuller browser-header set (Accept, Accept-Language,
  Referer) beyond round 1's plain UA swap -- still a flat 403 regardless of
  path. Confirms round 1: this is a network-level bot-mitigation block on
  this environment, independent of URL or headers.
- **SJTUG** (`mirrors.sjtug.sjtu.edu.cn/github-release/`): its
  `github-release/<owner>/<repo>/` path is a bare 301 redirect straight to
  `github.com/<owner>/<repo>` -- not a mirror at all under the round-1 rule
  ("merely redirects to the vendor's own host is NOT a mirror"), so
  rejected without further testing of winlibs/w64devkit paths on this host.
- **HUST** (`mirrors.hust.edu.cn/github-release/`): does list `llvm/`,
  `llvm-project/`, and `niXman/mingw-builds-binaries/` as top-level folders
  (interesting -- niXman/mingw-builds-binaries is the actively-maintained
  GitHub successor to the old SourceForge mingw-builds project, a
  plausible lead for a *different* runtime/gap than this task's scope), but
  the actual file listing is rendered client-side by a Docusaurus
  "fancyindex" React bundle -- a plain HEAD/GET on any directory returns
  the app shell with no `<a>` file links, and guessed file paths (mirroring
  ISCAS's and NJU's naming conventions) all 404. Left unconfirmed rather
  than guessed at; a real browser or the site's own JSON API (not found in
  one look at the bundle's script tag) would be needed to enumerate it.
- **`prereleases.llvm.org`**: exists and is gzip-transparent like
  `releases.llvm.org` (same gotcha noted in the main NOTES.md), but it's
  LLVM's own subdomain (same vendor, same infrastructure family) holding a
  sparse, non-contiguous set of old version directories (4.0.1, 5.x, 6.x,
  7.x, 8.x, 10.x-12.x, 15.0.0, 16.0.0, 18.1.0 -- not 3.x, not most others)
  that looks like a leftover RC/staging area rather than a maintained
  mirror. Not counted as a new mirror (same-vendor host, not independent),
  and its version set doesn't fill any of the catalog's actual gaps.
- **`install-llvm-action`** (KyleMayes): read `index.ts` directly --
  it downloads straight from
  `https://github.com/llvm/llvm-project/releases/download/llvmorg-<version>/...`
  via `@actions/tool-cache`. No independent host or cache; not a mirror
  lead.
- **w64devkit**: still not found anywhere outside the canonical GitHub
  release (absent on ISCAS and HUST's `github-release/skeeto/`, same as
  NJU/TUNA/USTC in round 1).

### Budget used

2 direct-URL probing passes (curl, no browser automation) across the hosts
above; 0 of the allotted 4 web searches were needed -- every host/path
this pass tested was either named in the task brief or discovered by
walking a mirror's own directory listing (ISCAS's `github-release/` root,
HUST's), not by searching.

Re-run `python3 catalog/cc/extra_mirrors.py` after any future `scrape.py`
run as before; this round's one new mirror was applied directly via
`tools/add_mirrors.py` (see `cc_round2_updates.jsonl` in this folder) and
is independent of that script.
"""


def atomic_write_text(path: Path, text: str):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(tmp, path)


def atomic_write_json(path: Path, data):
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    with os.fdopen(fd, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def main():
    with open(LOCK, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)

        mirrors = json.loads(MIRRORS.read_text())
        already = any(
            m.get("base", "").startswith("https://mirror.iscas.ac.cn/github-release/")
            for m in mirrors["confirmed"]
        )
        if not already:
            mirrors["confirmed"].append(NEW_MIRROR_ENTRY)
            atomic_write_json(MIRRORS, mirrors)
            print("mirrors.json: appended ISCAS entry")
        else:
            print("mirrors.json: ISCAS entry already present, skipped")

        notes = NOTES.read_text()
        if "Mirror hunt round 2 (2026-09-17)" not in notes:
            atomic_write_text(NOTES, notes.rstrip("\n") + "\n" + NOTES_SECTION.lstrip("\n"))
            print("NOTES.md: appended round-2 section")
        else:
            print("NOTES.md: round-2 section already present, skipped")


if __name__ == "__main__":
    main()
