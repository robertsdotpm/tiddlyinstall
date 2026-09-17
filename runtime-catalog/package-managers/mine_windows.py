#!/usr/bin/env python3
"""Mine Windows package-manager manifests (winget-pkgs, Scoop buckets,
Chocolatey community packages) for mirror URLs and checksum corroboration
of the runtimes in ../<runtime>/releases.json.

Python 3 stdlib only, plus the `git` CLI (network access required for
cloning/fetching the source repos). Re-runnable and idempotent: existing
clones are updated in place, and catalog updates go through
tools/add_mirrors.py, which dedupes.

Usage:
    python3 mine_windows.py [--scratch DIR] [--skip-clone] [--no-apply]

    --scratch DIR   Where to clone/keep the source repos (default:
                     a "sources" directory next to this script).
    --skip-clone    Reuse whatever is already in --scratch instead of
                     cloning/fetching (useful when iterating on parsing).
    --no-apply      Write catalog/package-managers/*.json evidence and the
                     updates.jsonl files, but don't call add_mirrors.py.

What it does, per source:

  winget-pkgs (github.com/microsoft/winget-pkgs)
    Sparse, blobless clone of the manifest directories for the package
    ids in PKGID_TO_FOLDER. Parses every *.installer.yaml with a small
    regex parser (no PyYAML dependency) for InstallerUrl/InstallerSha256/
    Architecture.

  Scoop buckets (ScoopInstaller/Main, Versions, Java, PHP, Extras)
    Sparse, blobless clone of bucket/ for Main/Java/PHP/Extras (current
    state only); a full clone of Versions (history is cheap there and
    the whole point of that bucket is old pinned majors). For a curated
    list of Main-bucket files that track compiler/toolchain majors
    (llvm.json, gcc.json, mingw*.json, rust*.json, python.json, ruby.json,
    r.json, nodejs.json, php*.json, go.json) it also walks the FULL git
    history with `git show <commit>:<path>` (not diff-parsing) to recover
    every version's url+hash that was ever committed, since Scoop manifests
    only keep the latest version in the working tree.

  Chocolatey community (chocolatey-community/chocolatey-packages)
    That repo's packages use an AU (AutoUpdate) template where the actual
    download URL is resolved dynamically at publish time, so the checked-in
    update.ps1/chocolateyInstall.ps1 has no literal URL. But packages that
    verify a remote binary commit a legal/VERIFICATION*.txt with the
    resolved URL and checksum for whatever version was last published --
    walking that file's git history recovers every version's evidence
    without downloading any .nupkg.

Matching (against every runtime's releases.json):
  1. Exact primary-`url` match.
  2. Else same folder + same filename, different host => mirror candidate
     (HEAD-confirmed: Content-Length must equal the catalog entry's `size`,
     or the catalog's own primary URL's HEAD/ranged-GET size if `size` is
     null -- Azure Blob Storage omits Content-Length on HEAD, so a 1-byte
     Range GET is used as a fallback to read Content-Range's total).
  3. Otherwise unmatched (recorded, not an error -- winget/scoop track much
     more than this catalog: previews, hosting bundles, unrelated tools
     that happen to be written in Go/Rust, IDEs, etc).

Where a matched entry's catalog `checksum` is null, the manifest hash is
added as a `checksum_corroboration`. Where the catalog already has a
same-algorithm checksum, agreement is just noted; a DISAGREEMENT is never
applied -- it's recorded in the evidence file and must be reported to the
operator.

Output:
  catalog/package-managers/winget.json
  catalog/package-managers/scoop.json
  catalog/package-managers/chocolatey.json
    Flat evidence arrays: one record per manifest installer/version/arch,
    with the match result.
  catalog/package-managers/*_updates.jsonl
    The mirror/checksum_corroboration lines fed to add_mirrors.py.
"""
import argparse
import json
import re
import subprocess
import sys
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parent
FOLDERS = ["python", "node", "java", "dotnet", "go", "rust", "php", "r", "ruby", "cc"]
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) installer-builder-runtimes mirror-hunt"
TODAY = "2026-09-17"

PKGID_TO_FOLDER = [
    ("Python.Python", "python"),
    ("OpenJS.NodeJS", "node"),
    ("EclipseAdoptium.Temurin", "java"),
    ("Azul.Zulu", "java"),
    ("Microsoft.DotNet", "dotnet"),
    ("GoLang.Go", "go"),
    ("Rustlang.Rust", "rust"),
    ("PHP.PHP", "php"),
    ("RProject.R", "r"),
    ("RubyInstallerTeam", "ruby"),
    ("LLVM.LLVM", "cc"),
    ("BrechtSanders.WinLibs", "cc"),
]

WINGET_SPARSE_PATHS = [
    "manifests/p/Python/Python", "manifests/o/OpenJS/NodeJS",
    "manifests/e/EclipseAdoptium", "manifests/a/Azul/Zulu",
    "manifests/m/Microsoft/DotNet", "manifests/g/GoLang/Go",
    "manifests/r/Rustlang/Rust", "manifests/p/PHP/PHP",
    "manifests/r/RProject/R", "manifests/r/RubyInstallerTeam",
    "manifests/l/LLVM/LLVM", "manifests/b/BrechtSanders/WinLibs",
]

SCOOP_STEM_TO_FOLDER = {
    r'^python(\d+)?$|^python-(alpha|beta|pre|rc)$': 'python',
    r'^nodejs': 'node',
    r'^temurin': 'java',
    r'^zulu(\d+)?-(jdk|jre)$|^zulu-(jdk|jre)$|^zulufx': 'java',
    r'^dotnet(\d+)?-sdk$|^dotnet-sdk|^dotnet-nightly$': 'dotnet',
    r'^go(\d+)?$': 'go',
    r'^rust$|^rust-msvc$|^rust-gnu$|^rust-nightly$|^rust-msvc-nightly$': 'rust',
    r'^php(\d.*)?(-nts)?$': 'php',
    r'^r$|^r-patched$': 'r',
    r'^ruby(\d+)?$': 'ruby',
    r'^llvm(-arm64)?$': 'cc',
    r'^gcc$|^gcc\d+$': 'cc',
    r'^mingw': 'cc',
    r'^w64devkit$': 'cc',
    r'^vcredist': 'cc',
}
_SCOOP_COMPILED = [(re.compile(p), f) for p, f in SCOOP_STEM_TO_FOLDER.items()]

# Main-bucket files worth walking full git history for (they only keep the
# LATEST version of their major in the working tree).
SCOOP_MAIN_HISTORY_FILES = [
    "bucket/llvm.json", "bucket/llvm-arm64.json", "bucket/gcc.json",
    "bucket/mingw.json", "bucket/mingw-winlibs.json", "bucket/mingw-nuwen.json",
    "bucket/mingw-mstorsjo-llvm-msvcrt.json", "bucket/mingw-mstorsjo-llvm-ucrt.json",
    "bucket/r.json", "bucket/python.json", "bucket/ruby.json",
    "bucket/rust.json", "bucket/rust-gnu.json", "bucket/rust-msvc.json",
    "bucket/nodejs.json", "bucket/php.json", "bucket/php-nts.json", "bucket/go.json",
]

CHOCO_PKG_TO_FOLDER = {
    "nodejs": "node", "nodejs.install": "node",
    "ruby": "ruby", "ruby.install": "ruby", "ruby.portable": "ruby",
    "php": "php", "php-legacy": "php",
    "vcredist140": "cc", "vcredist2017": "cc", "vcredist2015": "cc",
    "vcredist2013": "cc", "vcredist2012": "cc", "vcredist2010": "cc",
    "vcredist2008": "cc", "vcredist2005": "cc", "vcredist-aio": "cc",
    "DotNet4.0": "dotnet",
    "python": "python", "python2": "python", "python3": "python",
}


def run(cmd, cwd=None, timeout=None):
    return subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)


def sh(cmd, cwd=None):
    print("+", " ".join(cmd), f"(cwd={cwd})" if cwd else "", file=sys.stderr)
    subprocess.run(cmd, cwd=cwd, check=True)


# --------------------------------------------------------------------------
# Cloning
# --------------------------------------------------------------------------

def clone_or_update_sparse(url, dest, sparse_paths, unshallow=False):
    if not dest.exists():
        sh(["git", "clone", "--filter=blob:none", "--sparse", "--depth", "1", url, str(dest)])
        sh(["git", "sparse-checkout", "set", *sparse_paths], cwd=dest)
    else:
        sh(["git", "fetch", "origin"], cwd=dest)
        sh(["git", "reset", "--hard", "origin/HEAD"], cwd=dest)
    if unshallow:
        shallow = (dest / ".git" / "shallow").exists()
        if shallow:
            sh(["git", "fetch", "--unshallow"], cwd=dest)


def clone_or_update_full(url, dest):
    if not dest.exists():
        sh(["git", "clone", "--filter=blob:none", url, str(dest)])
    else:
        sh(["git", "fetch", "origin"], cwd=dest)
        sh(["git", "reset", "--hard", "origin/HEAD"], cwd=dest)


def do_clones(scratch):
    clone_or_update_sparse("https://github.com/microsoft/winget-pkgs.git",
                            scratch / "wpkgs", WINGET_SPARSE_PATHS)
    for repo in ["Main", "Java", "PHP", "Extras"]:
        clone_or_update_sparse(f"https://github.com/ScoopInstaller/{repo}.git",
                                scratch / f"scoop-{repo}", ["bucket"],
                                unshallow=(repo == "Main"))
    clone_or_update_full("https://github.com/ScoopInstaller/Versions.git", scratch / "scoop-Versions")
    clone_or_update_full("https://github.com/chocolatey-community/chocolatey-packages.git",
                          scratch / "choco-community")


# --------------------------------------------------------------------------
# winget-pkgs parsing
# --------------------------------------------------------------------------

def folder_for_pkgid(pkg_id):
    for prefix, folder in PKGID_TO_FOLDER:
        if pkg_id.startswith(prefix):
            return folder
    return None


def parse_winget_installer_yaml(text, fallback_id):
    pkg_id = fallback_id
    m = re.search(r'^PackageIdentifier:\s*(\S+)', text, re.M)
    if m:
        pkg_id = m.group(1)
    version = None
    m = re.search(r'^PackageVersion:\s*[\'"]?([^\'"\n]+)', text, re.M)
    if m:
        version = m.group(1).strip()
    top_itype = None
    m = re.search(r'^InstallerType:\s*(\S+)', text, re.M)
    if m:
        top_itype = m.group(1)
    idx = text.find('\nInstallers:')
    if idx == -1:
        return []
    body = text[idx:]
    out = []
    for block in re.split(r'\n(?=- )', body):
        if not block.strip().startswith('-'):
            continue
        arch_m = re.search(r'^\s*-?\s*Architecture:\s*(\S+)', block, re.M)
        url_m = re.search(r'^\s*InstallerUrl:\s*(\S+)', block, re.M)
        sha_m = re.search(r'^\s*InstallerSha256:\s*([0-9A-Fa-f]{64})', block, re.M)
        itype_m = re.search(r'^\s*InstallerType:\s*(\S+)', block, re.M)
        if not url_m:
            continue
        out.append({
            "manager": "winget", "package_id": pkg_id, "version": version,
            "arch": arch_m.group(1) if arch_m else None, "url": url_m.group(1),
            "hash_algo": "sha256" if sha_m else None,
            "hash_value": sha_m.group(1).lower() if sha_m else None,
            "installer_type": itype_m.group(1) if itype_m else top_itype,
            "folder_guess": folder_for_pkgid(pkg_id),
        })
    return out


def parse_winget(scratch):
    root = scratch / "wpkgs"
    records, seen = [], set()
    for f in root.glob("**/*.installer.yaml"):
        try:
            text = f.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        for r in parse_winget_installer_yaml(text, f.name.replace(".installer.yaml", "")):
            key = (r["package_id"], r["version"], r["arch"], r["url"], r["hash_value"])
            if key in seen:
                continue
            seen.add(key)
            r["source_ref"] = str(f.relative_to(root))
            records.append(r)
    return records


# --------------------------------------------------------------------------
# Scoop parsing
# --------------------------------------------------------------------------

def scoop_folder_for_stem(stem):
    for pat, folder in _SCOOP_COMPILED:
        if pat.match(stem):
            return folder
    return None


def _clean_url(u):
    if isinstance(u, list):
        u = u[0] if u else None
    return u.split('#')[0] if u else None


def scoop_extract(obj):
    out = []
    if not isinstance(obj, dict):
        return out
    if 'url' in obj:
        u = _clean_url(obj.get('url'))
        h = obj.get('hash')
        h = h[0] if isinstance(h, list) else h
        if u:
            out.append((None, u, h))
    arch = obj.get('architecture')
    if isinstance(arch, dict):
        for a, sub in arch.items():
            if not isinstance(sub, dict):
                continue
            u = _clean_url(sub.get('url'))
            h = sub.get('hash')
            h = h[0] if isinstance(h, list) else h
            if u:
                out.append((a, u, h))
    return out


def norm_hash(h):
    if not h:
        return None, None
    if ':' in h:
        algo, val = h.split(':', 1)
        return algo.lower(), val.lower()
    algo = {32: 'md5', 40: 'sha1', 64: 'sha256', 128: 'sha512'}.get(len(h), 'unknown')
    return algo, h.lower()


def parse_scoop_current(scratch):
    records = []
    for bucket in ["Main", "Java", "PHP", "Extras", "Versions"]:
        root = scratch / f"scoop-{bucket}" / "bucket"
        if not root.exists():
            continue
        for f in root.glob("*.json"):
            folder = scoop_folder_for_stem(f.stem)
            if not folder:
                continue
            try:
                data = json.loads(f.read_text(encoding="utf-8", errors="replace"))
            except Exception:
                continue
            version = data.get("version") if isinstance(data, dict) else None
            for arch, url, h in scoop_extract(data):
                algo, val = norm_hash(h)
                records.append({
                    "manager": "scoop", "package_id": f"{bucket}/{f.stem}", "version": version,
                    "arch": arch, "url": url, "hash_algo": algo, "hash_value": val,
                    "folder_guess": folder, "source_ref": f"HEAD {bucket}/bucket/{f.name}",
                })
    return records


def parse_scoop_main_history(scratch):
    repo = scratch / "scoop-Main"
    records, seen = [], set()
    for relpath in SCOOP_MAIN_HISTORY_FILES:
        stem = Path(relpath).stem
        folder = scoop_folder_for_stem(stem)
        if not folder:
            continue
        out = run(["git", "log", "--format=%H|%ad", "--date=short", "--", relpath], cwd=repo)
        commits = [l.split("|", 1) for l in out.stdout.splitlines() if l.strip()]
        for commit, date in commits:
            show = run(["git", "show", f"{commit}:{relpath}"], cwd=repo)
            if show.returncode != 0:
                continue
            try:
                data = json.loads(show.stdout)
            except Exception:
                continue
            version = data.get("version") if isinstance(data, dict) else None
            for arch, url, h in scoop_extract(data):
                algo, val = norm_hash(h)
                key = (folder, url, algo, val)
                if key in seen:
                    continue
                seen.add(key)
                records.append({
                    "manager": "scoop", "package_id": f"Main/{stem}", "version": version,
                    "arch": arch, "url": url, "hash_algo": algo, "hash_value": val,
                    "folder_guess": folder,
                    "source_ref": f"git history {commit[:10]} ({date}) Main/{relpath}",
                })
        print(f"  {relpath}: {len(commits)} commits walked", file=sys.stderr)
    return records


# --------------------------------------------------------------------------
# Chocolatey (community) VERIFICATION.txt history
# --------------------------------------------------------------------------

_URL_RE = re.compile(r'<(\bhttps?://[^\s<>]+)>')
_CHK_RE = re.compile(r'Checksum:\s*<([0-9A-Fa-f]{32,128})>')
_CHKTYPE_RE = re.compile(r'following\s+(\w+)\s+checksum', re.I)
_BIT_URL_RE = re.compile(r'\d+-Bit:\s*<(https?://[^\s<>]+)>')


def parse_verification_text(text):
    bit_urls = _BIT_URL_RE.findall(text)
    urls = bit_urls or _URL_RE.findall(text)
    checksums = _CHK_RE.findall(text)
    algo_m = _CHKTYPE_RE.search(text)
    return urls, checksums, (algo_m.group(1).lower() if algo_m else "sha256")


def parse_choco_verification_history(scratch):
    repo = scratch / "choco-community"
    records, seen = [], set()
    paths = run(["git", "ls-tree", "-r", "--name-only", "HEAD"], cwd=repo).stdout.splitlines()
    targets = [p for p in paths if re.search(r'legal/VERIFICATION.*\.txt$', p)
               and any(f"/{pkg}/" in p for pkg in CHOCO_PKG_TO_FOLDER)]
    for relpath in targets:
        pkg = next(p for p in CHOCO_PKG_TO_FOLDER if f"/{p}/" in relpath)
        folder = CHOCO_PKG_TO_FOLDER[pkg]
        out = run(["git", "log", "--format=%H|%ad", "--date=short", "--", relpath], cwd=repo)
        commits = [l.split("|", 1) for l in out.stdout.splitlines() if l.strip()]
        for commit, date in commits:
            show = run(["git", "show", f"{commit}:{relpath}"], cwd=repo)
            if show.returncode != 0:
                continue
            urls, checksums, algo = parse_verification_text(show.stdout)
            for i, u in enumerate(urls):
                h = checksums[i] if i < len(checksums) else (checksums[0] if len(checksums) == 1 else None)
                if not h:
                    continue
                key = (folder, u, h.lower())
                if key in seen:
                    continue
                seen.add(key)
                records.append({
                    "manager": "chocolatey-community", "package_id": pkg, "version": None, "arch": None,
                    "url": u, "hash_algo": algo, "hash_value": h.lower(), "folder_guess": folder,
                    "source_ref": f"git history {commit[:10]} ({date}) {relpath}",
                })
        print(f"  {relpath}: {len(commits)} commits", file=sys.stderr)
    return records


# --------------------------------------------------------------------------
# Catalog matching
# --------------------------------------------------------------------------

def load_catalog():
    by_url, by_fname = {}, defaultdict(list)
    for folder in FOLDERS:
        entries = json.loads((CATALOG / folder / "releases.json").read_text())
        for e in entries:
            by_url[e["url"]] = (folder, e)
            fn = urlparse(e["url"]).path.rsplit("/", 1)[-1].lower()
            by_fname[(folder, fn)].append(e)
    return by_url, by_fname


def match_records(records, by_url, by_fname):
    evidence, mirror_candidates, corroborations, disagreements = [], defaultdict(set), [], []
    for r in records:
        folder, url = r.get("folder_guess"), r.get("url")
        algo, val = r.get("hash_algo"), r.get("hash_value")
        ev = dict(r)
        if not url or not folder:
            ev["match_type"] = "skipped_no_folder_or_url"
            evidence.append(ev)
            continue
        fn = urlparse(url).path.rsplit("/", 1)[-1].lower()
        entry, mfolder, match_type = None, None, None
        if url in by_url:
            mfolder, entry = by_url[url]
            match_type = "exact_url"
        else:
            cands = by_fname.get((folder, fn), [])
            if cands:
                entry, mfolder = cands[0], folder
                match_type = ("filename_match_diff_host_candidate_mirror"
                              if urlparse(entry["url"]).netloc != urlparse(url).netloc
                              else "filename_match_same_host_diff_path")
        if entry is None:
            ev["match_type"] = "unmatched"
            evidence.append(ev)
            continue
        ev["matched_folder"], ev["matched_url"], ev["match_type"] = mfolder, entry["url"], match_type
        if match_type == "filename_match_diff_host_candidate_mirror":
            mirror_candidates[(mfolder, entry["url"])].add(url)
        if not val:
            ev["action"] = "no_hash"
        else:
            cs = entry.get("checksum")
            src = f"{r.get('manager')} {r.get('package_id')} {r.get('version') or ''} ({r.get('source_ref')})".strip()
            if cs is None:
                corroborations.append({"folder": mfolder, "url": entry["url"],
                    "checksum_corroboration": {"algo": algo, "value": val, "source": src}})
                ev["action"] = "checksum_corroboration_added"
            elif cs.get("algo") == algo:
                if cs.get("value", "").lower() == val.lower():
                    ev["action"] = "agrees_with_vendor_checksum"
                else:
                    ev["action"] = "DISAGREEMENT"
                    disagreements.append({"folder": mfolder, "url": entry["url"], "vendor": cs,
                                           "found": {"algo": algo, "value": val}, "source": src})
            else:
                ev["action"] = f"vendor_checksum_algo_{cs.get('algo')}_not_compared"
        evidence.append(ev)
    return evidence, mirror_candidates, corroborations, disagreements


# --------------------------------------------------------------------------
# Mirror confirmation (HEAD / ranged-GET size match)
# --------------------------------------------------------------------------

def _one_head(url, timeout):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        cl = resp.headers.get("Content-Length")
        return resp.status, int(cl) if cl else None


def _ranged_size(url, timeout):
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": UA, "Range": "bytes=0-0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        cr = resp.headers.get("Content-Range")
        if cr and "/" in cr:
            return resp.status, int(cr.rsplit("/", 1)[-1])
        cl = resp.headers.get("Content-Length")
        return resp.status, int(cl) if cl else None


def head_size(url, timeout=20, retries=3):
    for _ in range(retries):
        try:
            status, size = _one_head(url, timeout)
            if size is None and status == 200:
                try:
                    status, size = _ranged_size(url, timeout)
                except Exception:
                    pass
            return status, size
        except urllib.error.HTTPError as e:
            return e.code, None
        except Exception:
            continue
    return None, None


def confirm_mirrors(mirror_candidates, by_url):
    import concurrent.futures
    confirmed = []  # (folder, entry_url, mirror_url, size)

    def check(item):
        (folder, entry_url), urls = item
        _, entry = by_url.get(entry_url, (None, None))
        if entry is None:
            return []
        vendor_size = entry.get("size")
        if vendor_size is None:
            _, vendor_size = head_size(entry_url)
        out = []
        for u in urls:
            status, size = head_size(u)
            if vendor_size is not None and size == vendor_size:
                out.append((folder, entry_url, u, size))
        return out

    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        for res in ex.map(check, mirror_candidates.items()):
            confirmed.extend(res)
    return confirmed


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def write_evidence(name, evidence):
    out = CATALOG / "package-managers" / f"{name}.json"
    out.write_text(json.dumps(evidence, indent=1))
    print(f"wrote {out} ({len(evidence)} records)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scratch", default=str(HERE / "sources"))
    ap.add_argument("--skip-clone", action="store_true")
    ap.add_argument("--no-apply", action="store_true")
    args = ap.parse_args()
    scratch = Path(args.scratch)
    scratch.mkdir(parents=True, exist_ok=True)

    if not args.skip_clone:
        do_clones(scratch)

    print("parsing winget-pkgs manifests...", file=sys.stderr)
    winget_records = parse_winget(scratch)
    print(f"  {len(winget_records)} installer records", file=sys.stderr)

    print("parsing scoop bucket manifests (current state)...", file=sys.stderr)
    scoop_records = parse_scoop_current(scratch)
    print("walking scoop Main-bucket history...", file=sys.stderr)
    scoop_records += parse_scoop_main_history(scratch)
    print(f"  {len(scoop_records)} scoop records total", file=sys.stderr)

    print("walking chocolatey-community VERIFICATION.txt history...", file=sys.stderr)
    choco_records = parse_choco_verification_history(scratch)
    print(f"  {len(choco_records)} chocolatey records", file=sys.stderr)

    by_url, by_fname = load_catalog()

    all_updates = []
    all_disagreements = []
    for name, records in [("winget", winget_records), ("scoop", scoop_records), ("chocolatey", choco_records)]:
        evidence, mirror_cands, corrobs, disagreements = match_records(records, by_url, by_fname)
        confirmed = confirm_mirrors(mirror_cands, by_url)
        mirror_updates = [{"folder": f, "url": eu, "mirror": m,
                            "evidence": f"{name} manifest URL; HEAD/ranged-GET size match ({sz} bytes) {TODAY}"}
                           for f, eu, m, sz in confirmed]
        write_evidence(name, evidence)
        (CATALOG / "package-managers" / f"{name}_updates.jsonl").write_text(
            "\n".join(json.dumps(u) for u in (mirror_updates + corrobs)) + "\n" if (mirror_updates or corrobs) else "")
        all_updates += mirror_updates + corrobs
        all_disagreements += disagreements
        print(f"{name}: {Counter(e['match_type'] for e in evidence)}", file=sys.stderr)
        print(f"{name}: {len(mirror_updates)} mirrors confirmed, {len(corrobs)} corroborations, "
              f"{len(disagreements)} disagreements", file=sys.stderr)

    if all_disagreements:
        (CATALOG / "package-managers" / "disagreements.json").write_text(json.dumps(all_disagreements, indent=1))
        print(f"** {len(all_disagreements)} checksum DISAGREEMENTS found -- see "
              f"catalog/package-managers/disagreements.json -- NOT applied **", file=sys.stderr)

    combined = CATALOG / "package-managers" / "all_updates.jsonl"
    combined.write_text("\n".join(json.dumps(u) for u in all_updates) + "\n" if all_updates else "")
    print(f"{len(all_updates)} total update lines written to {combined}", file=sys.stderr)

    if not args.no_apply and all_updates:
        sh(["python3", str(CATALOG / "tools" / "add_mirrors.py"), str(combined)])


if __name__ == "__main__":
    main()
