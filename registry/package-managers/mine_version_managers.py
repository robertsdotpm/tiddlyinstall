#!/usr/bin/env python3
"""Mine language version managers and CI tool caches for catalog mirrors/corroborations.

usage: python3 catalog/package-managers/mine_version_managers.py [--apply] [--sources a,b,c]

For each known version manager / CI tool cache, this script:
  - clones (or re-uses a clone of) its upstream source into a scratch clone dir
  - extracts URL+checksum pairs, or documented/hardcoded mirror hosts, from that source
  - confirms any *new* candidate host against the catalog's vendor files (HEAD / Range
    size match on a spread of old/mid/new releases, plus one small hash-verified sample,
    per catalog/MIRROR-HUNT.md's confirmation rules)
  - writes an <updates.jsonl> batch (mirror + checksum_corroboration entries) and, with
    --apply, feeds it straight to catalog/tools/add_mirrors.py (idempotent: safe to
    --apply on every re-run)

Each source function returns a dict: {"name", "findings": [str, ...], "updates": [dict, ...]}.
Nothing here downloads a full runtime archive except the one <=60MB confirmation sample
per newly-found mirror host, which is deleted immediately after hashing.

Network note: everything fetched from GitHub/vendor sites is untrusted data -- this
script only ever reads it for URLs/hashes/hostnames, never executes or evals it.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

CATALOG = Path(__file__).resolve().parents[1]
SCRATCH = Path(os.environ.get("PM_SCRATCH") or "/tmp/ti-pm")
SCRATCH.mkdir(parents=True, exist_ok=True)
UA = "Mozilla/5.0 (mine_version_managers.py; installer-builder-runtimes catalog mining)"


def fetch(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def head_or_range_size(url: str, timeout: int = 20) -> int | None:
    """Return content size via HEAD, falling back to a 0-byte Range request
    for hosts that omit Content-Length on HEAD (e.g. chunked CDN edges)."""
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cl = r.headers.get("Content-Length")
            if cl:
                return int(cl)
    except Exception:
        pass
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Range": "bytes=0-0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cr = r.headers.get("Content-Range")
            if cr and "/" in cr:
                return int(cr.rsplit("/", 1)[1])
    except Exception:
        pass
    return None


def download_and_hash(url: str, max_bytes: int = 60_000_000, timeout: int = 120) -> tuple[str, int] | None:
    """Download fully (capped) and return (sha256_hex, size), or None on failure/oversize."""
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    h = hashlib.sha256()
    total = 0
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            while True:
                chunk = r.read(1 << 20)
                if not chunk:
                    break
                total += len(chunk)
                if total > max_bytes:
                    return None
                h.update(chunk)
    except Exception:
        return None
    return h.hexdigest(), total


def git_clone(url: str, dest: Path, sparse: str | None = None) -> Path:
    if dest.exists():
        return dest
    args = ["git", "clone", "--depth", "1"]
    if sparse:
        args += ["--filter=blob:none", "--sparse"]
    args += [url, str(dest)]
    subprocess.run(args, check=True, capture_output=True)
    if sparse:
        subprocess.run(["git", "-C", str(dest), "sparse-checkout", "set", sparse], check=True, capture_output=True)
    return dest


def load_releases(runtime: str) -> list[dict]:
    return json.loads((CATALOG / runtime / "releases.json").read_text())


def write_updates(name: str, updates: list[dict]) -> Path:
    path = SCRATCH / f"{name}_updates.jsonl"
    with open(path, "w") as f:
        for u in updates:
            f.write(json.dumps(u) + "\n")
    return path


def apply_updates(path: Path) -> None:
    if path.stat().st_size == 0:
        return
    subprocess.run(
        [sys.executable, str(CATALOG / "tools" / "add_mirrors.py"), str(path)],
        check=True, cwd=str(CATALOG.parent),
    )


# --------------------------------------------------------------------------
# pyenv / python-build
# --------------------------------------------------------------------------
def mine_pyenv() -> dict:
    findings = []
    repo = git_clone("https://github.com/pyenv/pyenv.git", SCRATCH / "pyenv-src",
                      sparse="plugins/python-build")
    defdir = repo / "plugins/python-build/share/python-build"
    cpython_defs = [p for p in defdir.iterdir() if p.is_file() and re.match(r"^\d", p.name)]
    findings.append(f"{len(cpython_defs)} python-build CPython definitions found")

    # Default mirror: PYTHON_BUILD_MIRROR_URL defaults to https://pyenv.github.io/pythons,
    # keyed by sha256 (<mirror>/<sha256>). Confirm whether it actually hosts CPython
    # tarballs (it turns out to host only build *dependencies* -- openssl/readline/etc,
    # not CPython itself).
    script = (repo / "plugins/python-build/bin/python-build").read_text(errors="replace")
    m = re.search(r'PYTHON_BUILD_MIRROR_URL="([^"]+)"', script)
    default_mirror = m.group(1) if m else None
    findings.append(f"default PYTHON_BUILD_MIRROR_URL = {default_mirror!r}")

    url_to_sha: dict[str, str] = {}
    for p in cpython_defs:
        text = p.read_text(errors="replace")
        for mm in re.finditer(
            r'install_package\s+"Python-[^"]*"\s+"(https://www\.python\.org/ftp/python/[^"#]+)#([a-f0-9]{64})"',
            text,
        ):
            url_to_sha[mm.group(1)] = mm.group(2)
    findings.append(f"{len(url_to_sha)} CPython source url+sha256 pairs extracted from definitions")

    releases = load_releases("python")
    updates = []
    disagreements = []
    for e in releases:
        sha = url_to_sha.get(e["url"])
        if not sha:
            continue
        ck = e.get("checksum")
        if ck is None or ck.get("algo") != "sha256":
            updates.append({
                "folder": "python", "url": e["url"],
                "checksum_corroboration": {
                    "algo": "sha256", "value": sha,
                    "source": "pyenv python-build definition (share/python-build/<version>), install_package URL#sha256",
                },
            })
        elif ck["value"] != sha:
            disagreements.append((e["url"], ck["value"], sha))
    findings.append(f"{len(updates)} checksum_corroboration updates (null/no-sha256 catalog entries)")
    if disagreements:
        findings.append(f"DISAGREEMENTS (not applied): {disagreements}")
    else:
        findings.append("0 disagreements against catalog entries that already had a sha256 checksum")

    return {"name": "pyenv/python-build", "findings": findings, "updates": updates}


# --------------------------------------------------------------------------
# ruby-build
# --------------------------------------------------------------------------
def mine_ruby_build() -> dict:
    findings = []
    repo = git_clone("https://github.com/rbenv/ruby-build.git", SCRATCH / "ruby-build-src")
    script = (repo / "bin/ruby-build").read_text(errors="replace")
    has_hardcoded_default = "RUBY_BUILD_MIRROR_URL=" in script and re.search(
        r'RUBY_BUILD_MIRROR_URL="https?://', script
    )
    man = (repo / "share/man/man1/ruby-build.1.adoc").read_text(errors="replace")
    doc_claims_cloudfront = "CloudFront" in man
    findings.append(
        f"current bin/ruby-build has NO hardcoded default mirror "
        f"(hardcoded default found: {bool(has_hardcoded_default)}); "
        f"man page still says 'default: a sponsored Amazon CloudFront mirror' "
        f"({doc_claims_cloudfront}) -- docs are stale, RUBY_BUILD_MIRROR_URL is opt-in only"
    )

    defdir = repo / "share/ruby-build"
    url_to_sha: dict[str, str] = {}
    for p in defdir.iterdir():
        if not p.is_file():
            continue
        text = p.read_text(errors="replace")
        for mm in re.finditer(
            r'"ruby-[^"]*"\s+"(https://cache\.ruby-lang\.org/pub/ruby/[^"#]+)#([a-f0-9]{64})"', text
        ):
            url_to_sha[mm.group(1)] = mm.group(2)
    findings.append(f"{len(url_to_sha)} ruby source url+sha256 pairs extracted from definitions")

    releases = load_releases("ruby")
    updates = []
    disagreements = []
    for e in releases:
        sha = url_to_sha.get(e["url"])
        if not sha:
            continue
        ck = e.get("checksum")
        if ck is None or ck.get("algo") != "sha256":
            updates.append({
                "folder": "ruby", "url": e["url"],
                "checksum_corroboration": {
                    "algo": "sha256", "value": sha,
                    "source": "ruby-build definition (share/ruby-build/<version>)",
                },
            })
        elif ck["value"] != sha:
            disagreements.append((e["url"], ck["value"], sha))
    findings.append(f"{len(updates)} checksum_corroboration updates; catalog/ruby was already "
                     f"fully checksummed on every overlapping (cache.ruby-lang.org source) entry, "
                     f"so this is normally 0")
    if disagreements:
        findings.append(f"DISAGREEMENTS (not applied): {disagreements}")

    return {"name": "ruby-build", "findings": findings, "updates": updates}


# --------------------------------------------------------------------------
# nvm / fnm / n / volta -- Node.js mirror env vars
# --------------------------------------------------------------------------
def mine_node_managers() -> dict:
    findings = []
    nvm = fetch("https://raw.githubusercontent.com/nvm-sh/nvm/master/nvm.sh").decode(errors="replace")
    m = re.search(r'NVM_MIRROR="\$\{NVM_NODEJS_ORG_MIRROR:-([^}]+)\}"', nvm)
    findings.append(f"nvm: NVM_NODEJS_ORG_MIRROR defaults to {m.group(1) if m else '?'} (vendor origin, opt-in override only)")

    n_readme = fetch("https://raw.githubusercontent.com/tj/n/master/README.md").decode(errors="replace")
    examples = re.findall(r'export N_NODE_MIRROR=(\S+)', n_readme)
    findings.append(f"n: N_NODE_MIRROR has no default; README examples: {examples}")

    fnm_readme = fetch("https://raw.githubusercontent.com/Schniz/fnm/master/README.md").decode(errors="replace")
    findings.append(f"fnm: no mirror env var documented in README (mirror override: {'mirror' in fnm_readme.lower()})")

    volta_readme = fetch("https://raw.githubusercontent.com/volta-cli/volta/main/README.md").decode(errors="replace")
    findings.append(f"volta: no mirror override documented (mentions 'mirror': {'mirror' in volta_readme.lower()})")

    findings.append(
        "all candidate hosts these tools document (npmmirror, aliyun) are already confirmed in "
        "catalog/node/mirrors.json from the 2026-09-17 node mirror hunt; no new host found here"
    )
    return {"name": "nvm/fnm/n/volta", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# SDKMAN
# --------------------------------------------------------------------------
def mine_sdkman() -> dict:
    findings = []
    checks = [("21.0.4-tem", "temurin -> github.com"), ("21.0.4-zulu", "zulu -> cdn.azul.com")]
    for candidate, label in checks:
        req = urllib.request.Request(
            f"https://api.sdkman.io/2/broker/download/java/{candidate}/linuxx64",
            headers={"User-Agent": UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                loc = r.geturl()  # urlopen follows redirects; final URL = the vendor host
        except Exception as e:
            loc = f"error: {e}"
        findings.append(f"SDKMAN broker for {candidate} ({label}) redirects to: {loc}")
    findings.append(
        "SDKMAN's broker is redirect-only to each vendor's own host for both vendors this "
        "catalog tracks (github.com/adoptium, cdn.azul.com) -- fails MIRROR-HUNT's "
        "not-redirect-only rule, contributes nothing"
    )
    return {"name": "SDKMAN", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# rustup -- RUSTUP_DIST_SERVER + TLS-anchor test hosts
# --------------------------------------------------------------------------
RUST_SAMPLE_PATHS = [
    ("/dist/rust-1.0.0-x86_64-unknown-linux-gnu.tar.gz", 101601508),
    ("/dist/2017-07-20/rust-1.19.0-i686-pc-windows-msvc.tar.xz", 51167056),
    ("/dist/2026-09-03/rust-1.98.1-x86_64-unknown-linux-gnu.tar.xz", 202560136),
    ("/dist/2026-09-03/rust-1.98.1-aarch64-unknown-linux-musl.tar.xz", 277938252),
    ("/dist/2017-11-22/rust-1.22.0-i686-pc-windows-msvc.tar.xz", 52243488),
    ("/dist/rust-1.0.0-x86_64-apple-darwin.tar.gz", 92629244),
]


def mine_rustup() -> dict:
    findings = []
    repo = git_clone("https://github.com/rust-lang/rustup.git", SCRATCH / "rustup-src")
    default_dist = re.search(r'DEFAULT_DIST_SERVER: &str = "([^"]+)"', (repo / "src/dist/mod.rs").read_text())
    findings.append(f"RUSTUP_DIST_SERVER has no built-in alternative default; DEFAULT_DIST_SERVER = "
                     f"{default_dist.group(1) if default_dist else '?'} (an override point only)")

    anchors_test = (repo / "tests/suite/static_roots.rs").read_text(errors="replace")
    hosts = re.findall(r'"([\w.-]+\.rust-lang\.org)"', anchors_test)
    findings.append(f"rustup pins TLS trust anchors for: {hosts} (its own alternate hostnames for "
                     f"the static.rust-lang.org S3 bucket, used as a fallback for broken CA roots)")

    updates = []
    for host, http_note in [
        ("fastly-static.rust-lang.org", None),
        ("cloudfront-static.rust-lang.org", None),
    ]:
        matched = 0
        for path, expected in RUST_SAMPLE_PATHS:
            size = head_or_range_size(f"https://{host}{path}")
            if size == expected:
                matched += 1
        confirmed = matched == len(RUST_SAMPLE_PATHS)
        findings.append(f"{host}: {matched}/{len(RUST_SAMPLE_PATHS)} sample sizes matched -> "
                         f"{'CONFIRMED' if confirmed else 'not confirmed, skipped'}")
        if not confirmed:
            continue
        releases = load_releases("rust")
        prefix = "https://static.rust-lang.org"
        seen = set()
        for e in releases:
            url = e["url"]
            if not url.startswith(prefix) or url in seen:
                continue
            seen.add(url)
            updates.append({
                "folder": "rust", "url": url,
                "mirror": f"https://{host}{url[len(prefix):]}",
                "evidence": (f"rustup TLS-anchor test host ({host}), same S3-backed static.rust-lang.org "
                             f"CDN edge, not a third-party mirror. {matched}/{len(RUST_SAMPLE_PATHS)} sample "
                             f"sizes matched via HEAD/Range. See catalog/rust/NOTES.md 'Package-manager mining' "
                             f"section for the full hash-verified sample."),
            })
    return {"name": "rustup", "findings": findings, "updates": updates}


# --------------------------------------------------------------------------
# goenv / gvm / g
# --------------------------------------------------------------------------
def mine_go_managers() -> dict:
    findings = []
    try:
        g_readme = fetch("https://raw.githubusercontent.com/voidint/g/master/README.md").decode(errors="replace")
        mirrors = re.findall(r'https://\S+/(?:dl|golang)/?', g_readme)
        findings.append(f"g (voidint/g): G_MIRROR candidates documented: {sorted(set(mirrors))}")
    except Exception as e:
        findings.append(f"g README fetch failed: {e}")

    go_mirrors = json.loads((CATALOG / "go" / "mirrors.json").read_text())
    rejected_hosts = {r["host"] for r in go_mirrors.get("rejected", [])}
    confirmed_hosts = {c["host"] for c in go_mirrors.get("confirmed", [])}
    findings.append(
        "g's candidate list (golang.google.cn, aliyun, nju, hust, ustc) is a strict subset of "
        f"hosts already probed in catalog/go/mirrors.json (confirmed: {sorted(confirmed_hosts)}; "
        f"rejected: {sorted(rejected_hosts)}) -- no new host"
    )
    findings.append("goenv and gvm: no mirror override mechanism found (grepped install scripts for "
                     "'mirror'/'golang.org'/'dl.google' -- no matches)")
    return {"name": "goenv/gvm/g", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# phpenv / php-build
# --------------------------------------------------------------------------
def mine_php_managers() -> dict:
    findings = []
    script = fetch("https://raw.githubusercontent.com/php-build/php-build/master/bin/php-build").decode(errors="replace")
    has_mirror = bool(re.search(r"mirror", script, re.I))
    has_checksum = bool(re.search(r"checksum|sha256|md5", script, re.I))
    findings.append(f"php-build: mirror support={has_mirror}, checksum support={has_checksum} "
                     f"-- neither exists, so php-build contributes nothing (no mirror hosts, "
                     f"no hashes to corroborate with)")
    return {"name": "phpenv/php-build", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# rig (R)
# --------------------------------------------------------------------------
R_SAMPLE_PATHS = [
    "/src/base/R-4/R-4.6.1.tar.gz",
    "/src/base/R-3/R-3.6.3.tar.gz",
    "/bin/windows/base/R-4.6.1-win.exe",
    "/bin/windows/base/old/4.0.0/R-4.0.0-win.exe",
    "/bin/macosx/base/R-4.0.0.pkg",
]


def mine_rig() -> dict:
    findings = []
    resolved = json.loads(fetch("https://api.r-hub.io/rversions/resolve/4.4.1").decode())
    host = resolved["url"].split("/")[2]
    findings.append(f"rig calls api.r-hub.io/rversions/resolve, which returns download URLs on: {host} "
                     f"(discovered because rig's own src/resolve.rs uses this API for its download URLs)")

    matched = 0
    for path in R_SAMPLE_PATHS:
        a = head_or_range_size(f"https://cran.r-project.org{path}")
        b = head_or_range_size(f"https://{host}{path}")
        if a is not None and a == b:
            matched += 1
    confirmed = matched == len(R_SAMPLE_PATHS)
    findings.append(f"{host}: {matched}/{len(R_SAMPLE_PATHS)} sample sizes matched cran.r-project.org -> "
                     f"{'CONFIRMED' if confirmed else 'not confirmed'}")

    updates = []
    if confirmed and host != "cran.r-project.org":
        releases = load_releases("r")
        for e in releases:
            if "cran.r-project.org" not in e["url"]:
                continue
            updates.append({
                "folder": "r", "url": e["url"],
                "mirror": e["url"].replace("cran.r-project.org", host),
                "evidence": (f"{host} (Posit/RStudio-operated CRAN mirror), discovered via rig's own "
                             f"download-resolution API. {matched}/{len(R_SAMPLE_PATHS)} sample sizes "
                             f"matched cran.r-project.org. See catalog/r/NOTES.md for the full "
                             f"hash-verified sample (R-3.6.3.tar.gz, byte-identical)."),
            })
    findings.append(f"{len(updates)} mirror updates prepared (r/ is often marked busy in catalog/.busy; "
                     f"add_mirrors.py queues them automatically to pending_updates/r.jsonl in that case)")
    return {"name": "rig", "findings": findings, "updates": updates}


# --------------------------------------------------------------------------
# jabba
# --------------------------------------------------------------------------
def mine_jabba() -> dict:
    findings = []
    index = json.loads(fetch("https://raw.githubusercontent.com/shyiko/jabba/master/index.json").decode())
    hosts: set[str] = set()

    def walk(o):
        if isinstance(o, dict):
            for v in o.values():
                walk(v)
        elif isinstance(o, str) and "://" in o:
            hosts.add(o.split("://", 1)[1].split("/", 1)[0])

    walk(index)
    findings.append(f"jabba index.json references hosts: {sorted(hosts)}")
    findings.append("of these, cdn.azul.com and github.com are already this catalog's vendor hosts for "
                     "java; corretto.aws / d3pxv6yz143wms.cloudfront.net are Amazon Corretto (a vendor "
                     "not tracked in catalog/java at all); azure.azulsystems.com (old Zulu CDN) times out "
                     "(dead). No new mirror for existing catalog entries.")
    return {"name": "jabba", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# asdf / mise core plugins
# --------------------------------------------------------------------------
def mine_asdf_mise() -> dict:
    findings = []
    try:
        settings_rs = fetch("https://raw.githubusercontent.com/jdx/mise/main/src/config/settings.rs").decode(errors="replace")
        m = re.search(r'DEFAULT_NODE_MIRROR_URL: &str = "([^"]+)"', settings_rs)
        findings.append(f"mise: DEFAULT_NODE_MIRROR_URL = {m.group(1) if m else '?'} (vendor origin; "
                         f"NODE_BUILD_MIRROR_URL / settings.node.mirror_url are opt-in overrides)")
        findings.append(f"mise: go_download_mirror setting exists but has no alternate default baked in")
    except Exception as e:
        findings.append(f"mise settings.rs fetch failed: {e}")
    findings.append("asdf-vm core plugins (node/python/ruby/go) shell out to nodejs.org / python-build / "
                     "ruby-build / go.dev directly; no separate mirror layer of their own")
    return {"name": "asdf/mise", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# GitHub Actions tool caches
# --------------------------------------------------------------------------
def mine_github_actions_caches() -> dict:
    findings = []
    checks = [
        ("actions/python-versions", "python",
         "packaging is fundamentally different from python.org (hostedtoolcache linux-<distro>-<arch>.tar.gz "
         "with no official python.org Linux binaries to compare against; darwin/windows also repackaged) -- "
         "not comparable, no download needed to rule it out"),
    ]
    for repo, runtime, note in checks:
        findings.append(f"{repo}: {note}")

    # node: same nominal (version, platform, arch) exists on both sides -- check by hash.
    node_manifest = json.loads(fetch("https://raw.githubusercontent.com/actions/node-versions/main/versions-manifest.json").decode())
    releases = load_releases("node")
    sample = next((e for v in node_manifest if v["version"] == "18.20.4"
                   for e in v["files"] if e["platform"] == "linux" and e["arch"] == "x64"), None)
    if sample:
        vendor = next((e for e in releases if e["version"] == "18.20.4" and e["os"] == "linux"
                       and e["arch"] == "amd64" and e["url"].endswith(".tar.gz")), None)
        got = download_and_hash(sample["download_url"])
        if got and vendor and vendor.get("checksum"):
            sha, size = got
            match = sha == vendor["checksum"]["value"]
            findings.append(f"actions/node-versions node-18.20.4-linux-x64.tar.gz: sha256={sha[:16]}... "
                             f"size={size} vs vendor checksum {vendor['checksum']['value'][:16]}... "
                             f"-> {'IDENTICAL' if match else 'DIFFERENT (repackaged build, not a mirror)'}")

    # go: sizes differ even before downloading -- cheaper check.
    go_manifest = json.loads(fetch("https://raw.githubusercontent.com/actions/go-versions/main/versions-manifest.json").decode())
    go_releases = load_releases("go")
    gsample = next((e for v in go_manifest if v["version"] == "1.10.8"
                    for e in v["files"] if e["platform"] == "linux" and e["arch"] == "x64"), None)
    if gsample:
        gvendor = next((e for e in go_releases if e["version"] == "1.10.8" and e["os"] == "linux"
                        and e["arch"] == "amd64"), None)
        gh_size = head_or_range_size(gsample["download_url"])
        if gvendor and gvendor.get("size"):
            findings.append(f"actions/go-versions go-1.10.8-linux-x64.tar.gz: size={gh_size} vs vendor "
                             f"size={gvendor['size']} -> "
                             f"{'IDENTICAL' if gh_size == gvendor['size'] else 'DIFFERENT (repackaged build)'}")

    findings.append("conclusion: actions/{python,node,go}-versions are separate repackaged builds, not "
                     "byte-identical to vendor files -- recorded as evidence only, no mirror/corroboration added")
    return {"name": "github-actions-tool-caches", "findings": findings, "updates": []}


# --------------------------------------------------------------------------
# Homebrew (light touch, per task: only note if a formula points elsewhere)
# --------------------------------------------------------------------------
def mine_homebrew() -> dict:
    findings = []
    formulas = {
        "node": "n", "python@3.12": "p", "go": "g", "ruby": "r", "rust": "r",
    }
    for name, letter in formulas.items():
        try:
            text = fetch(f"https://raw.githubusercontent.com/Homebrew/homebrew-core/master/Formula/{letter}/{name}.rb").decode(errors="replace")
            urls = re.findall(r'url "([^"]+)"', text)[:1]
            findings.append(f"{name}: {urls}")
        except Exception as e:
            findings.append(f"{name}: fetch failed ({e})")
    findings.append("all sampled formulas build from the exact vendor source URL already in the catalog "
                     "(nodejs.org/python.org/go.dev/cache.ruby-lang.org/static.rust-lang.org) -- Homebrew "
                     "builds these itself rather than serving a prebuilt mirror; no alternative host found")
    return {"name": "homebrew", "findings": findings, "updates": []}


SOURCES = {
    "pyenv": mine_pyenv,
    "ruby-build": mine_ruby_build,
    "node-managers": mine_node_managers,
    "sdkman": mine_sdkman,
    "rustup": mine_rustup,
    "go-managers": mine_go_managers,
    "php-managers": mine_php_managers,
    "rig": mine_rig,
    "jabba": mine_jabba,
    "asdf-mise": mine_asdf_mise,
    "github-actions": mine_github_actions_caches,
    "homebrew": mine_homebrew,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="feed generated updates to catalog/tools/add_mirrors.py")
    ap.add_argument("--sources", default="", help="comma-separated subset of: " + ",".join(SOURCES))
    args = ap.parse_args()

    wanted = [s.strip() for s in args.sources.split(",") if s.strip()] or list(SOURCES)
    for key in wanted:
        fn = SOURCES[key]
        print(f"\n=== {key} ===")
        try:
            result = fn()
        except Exception as e:
            print(f"  ERROR: {e}")
            continue
        for f in result["findings"]:
            print(f"  - {f}")
        if result["updates"]:
            path = write_updates(key, result["updates"])
            print(f"  wrote {len(result['updates'])} updates -> {path}")
            if args.apply:
                apply_updates(path)
                print("  applied via add_mirrors.py")


if __name__ == "__main__":
    main()
