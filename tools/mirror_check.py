#!/usr/bin/env python3
"""Is the mirror whole? Compare a manifest, the local store and every
mirror host, and name every file that is in one and not the others.

usage: mirror_check.py [MANIFEST] [--local DIR] [--hosts FILE] [--host id]
                       [--remote [USER@]HOST:DIR] [--sha] [--quiet]

MANIFEST is a JSON list of {"path", "size", "sha256" (or null), "urls"},
or an object with those under "files" and a "notes" of its own. An entry
may name the hosts it belongs on (`"hosts": ["ovh1"]`); without one it
belongs on every host whose `holds` covers this manifest. Two manifests
exist today, and they are deliberately separate:

  runtime-metadata/store/mirror-manifest.json     what installers download
  runtime-metadata/store/toolchain-manifest.json  what we build them with

The hosts come from runtime-metadata/store/mirror-hosts.json, not from
this file, so a second mirror is a config line rather than a patch. A
host is `ssh` (one walk of the tree answers everything) or `http` (ask
for each file's headers under its `base`).

Keeping a mirror whole is more halves than it looks, and only one of
them is obvious:

  * each mirror host, so the file can be downloaded at install time --
    and with more than one host, a file on one and not the other means
    the plans that name the second fall back to the vendor;
  * the local runtime store, because a mirror URL only reaches a plan
    through LocalIndex (server/lib/catalog.js), which walks *this
    machine's* copies and fills in the release's `local` path. A file
    that is on a mirror host but that this machine has never seen has no
    `local`, so its plans name the vendor alone and the copy is never
    used -- the pull looks like it worked and changes no plan.

So a half-done top-up is silent. This says so instead:

  manifest 1020 files, 128.4 GB (runtime)
  local 1020 present, 0 missing
  ovh1  1020 present, 0 missing
  ok: the manifest, the local store, ovh1 agree on 1020 files

Missing in one place only is the half-done state; missing everywhere is
a file the manifest lists that nobody has fetched yet. Files a host
holds that the manifest doesn't list are reported but are not a fault:
some are deliberate. They are worth knowing about because nothing would
put them back if that host were rebuilt from the manifest.

Sizes are compared always -- that is what LocalIndex matches on, with
the name -- and `--sha` hashes every file everywhere, which is slow and
rarely what you want after mirror_fetch.py, since it verified the hashes
as it fetched.

Exit status is 0 when everything agrees and 1 when it does not, so this
can be a check rather than something to read.
"""
import argparse
import concurrent.futures as cf
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_MANIFEST = os.path.join(HERE, "runtime-metadata/store/mirror-manifest.json")
DEFAULT_HOSTS = os.path.join(HERE, "runtime-metadata/store/mirror-hosts.json")
DEFAULT_LOCAL = os.path.expanduser("~/projects/installer-builder-runtimes")
# The build toolchain is nothing a plan downloads, so its local copies sit
# in a dot folder the resolver's LocalIndex does not walk: it must never be
# able to mistake a .deb for a runtime download.
TOOLCHAIN_LOCAL = os.path.join(DEFAULT_LOCAL, ".mirror")
MANIFESTS = {"runtime": os.path.join(HERE, "runtime-metadata/store/mirror-manifest.json"),
             "toolchain": os.path.join(HERE, "runtime-metadata/store/toolchain-manifest.json")}
UA = {"User-Agent": "installer-builder-mirror-check/1"}

# Asking an ssh host once, rather than once per file: the program goes
# over stdin, so nothing has to survive the remote shell's quoting, and
# it walks the mirror printing "<size> <sha256-or-dash> <path>".
PROBE = r'''
import hashlib, os, sys
root = os.path.expanduser(sys.argv[1])
want_sha = len(sys.argv) > 2 and sys.argv[2] == "1"
for dirpath, dirnames, names in os.walk(root):
    dirnames[:] = [d for d in dirnames if not d.startswith(".")]
    for n in names:
        if n.startswith("."):
            continue
        p = os.path.join(dirpath, n)
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        try:
            size = os.path.getsize(p)
        except OSError:
            continue
        sha = "-"
        if want_sha:
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for b in iter(lambda: f.read(1 << 20), b""):
                    h.update(b)
            sha = h.hexdigest()
        sys.stdout.write("%d %s %s\n" % (size, sha, rel))
'''


def human(n):
    return "%.1f GB" % (n / 1e9) if n >= 1e9 else "%.1f MB" % (n / 1e6)


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def load_manifest(path):
    d = json.load(open(path))
    return d if isinstance(d, list) else d["files"]


def manifest_kind(path):
    """"runtime" or "toolchain", from the file's name, for a host's `holds`."""
    return "toolchain" if "toolchain" in os.path.basename(path) else "runtime"


def load_hosts(path, only, remote, kind):
    if remote:
        ssh, _, root = remote.partition(":")
        return [{"id": ssh, "label": ssh, "kind": "ssh", "ssh": ssh,
                 "root": root or "installer-builder-mirror", "enabled": True}]
    try:
        hosts = json.load(open(path))["hosts"]
    except FileNotFoundError:
        sys.exit("no mirror hosts file at %s (--hosts, or --remote for one off the books)" % path)
    out = []
    for h in hosts:
        if only and h["id"] not in only:
            continue
        if not only and not h.get("enabled", True):
            continue
        if not only and h.get("holds") and kind not in h["holds"]:
            continue
        if h["kind"] == "http" and not h.get("base"):
            print("skipping %s: it has no base URL yet" % h["id"])
            continue
        out.append(h)
    return out


# The mirror serves a file at its path under the base, and a server
# un-escapes a request path once, so a `%` in a file's own name has to be
# written `%25` (the same rule as shared/resolve.js mirrorURL).
def url_for(base, path):
    return base.rstrip("/") + "/" + path.replace("%", "%25")


def look_local(root, entries, want_sha):
    out = {}
    for e in entries:
        p = os.path.join(root, e["path"])
        try:
            size = os.path.getsize(p)
        except OSError:
            out[e["path"]] = None
            continue
        out[e["path"]] = (size, sha256_file(p) if want_sha else "-")
    return out


def look_ssh(host, want_sha):
    """Everything the host holds: {path: (size, sha)}."""
    cmd = ["ssh", host["ssh"], "python3", "-", host.get("root", "."), "1" if want_sha else "0"]
    p = subprocess.run(cmd, input=PROBE, capture_output=True, text=True, timeout=7200)
    if p.returncode != 0:
        sys.exit("could not ask %s: %s" % (host["id"], (p.stderr or "").strip()[-400:]))
    out = {}
    for line in p.stdout.splitlines():
        size, sha, path = line.split(" ", 2)
        out[path] = (int(size), sha)
    return out


def look_http(host, entries, want_sha, jobs=8):
    """Only what the manifest asks about: an HTTP host can't be walked."""
    def one(e):
        u = url_for(host["base"], e["path"])
        try:
            if want_sha:
                with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=300) as r:
                    h = hashlib.sha256()
                    n = 0
                    for b in iter(lambda: r.read(1 << 20), b""):
                        h.update(b)
                        n += len(b)
                    return e["path"], (n, h.hexdigest())
            req = urllib.request.Request(u, headers=UA, method="HEAD")
            with urllib.request.urlopen(req, timeout=120) as r:
                return e["path"], (int(r.headers.get("Content-Length") or 0), "-")
        except (urllib.error.URLError, OSError, ValueError):
            return e["path"], None
    out = {}
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        for path, got in ex.map(one, entries):
            out[path] = got
    return out


def judge(entries, got, want_sha):
    """(missing, wrong) for one place."""
    missing, wrong = [], []
    for e in entries:
        g = got.get(e["path"])
        if g is None:
            missing.append(e["path"])
            continue
        size, sha = g
        if e.get("size") and size != e["size"]:
            wrong.append("%s: %d bytes, the manifest says %d" % (e["path"], size, e["size"]))
        elif want_sha and e.get("sha256") and sha != e["sha256"]:
            wrong.append("%s: sha256 %s, the manifest says %s" % (e["path"], sha[:16], e["sha256"][:16]))
    return missing, wrong


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest", nargs="?", default=DEFAULT_MANIFEST)
    ap.add_argument("--local", default=DEFAULT_LOCAL, help="the runtime store on this machine")
    ap.add_argument("--hosts", default=DEFAULT_HOSTS, help="the mirror hosts file")
    ap.add_argument("--host", action="append", default=[], help="only this host id (repeatable)")
    ap.add_argument("--remote", default="", help="[user@]host:dir, for a host not in the hosts file")
    ap.add_argument("--no-local", action="store_true", help="don't look at the local store")
    ap.add_argument("--sha", action="store_true", help="hash every file everywhere too (slow)")
    ap.add_argument("--quiet", action="store_true", help="only the summary and what is wrong")
    a = ap.parse_args()

    kind = manifest_kind(a.manifest)
    if kind == "toolchain" and a.local == DEFAULT_LOCAL:
        a.local = TOOLCHAIN_LOCAL
    entries = load_manifest(a.manifest)
    total = sum(e.get("size") or 0 for e in entries)
    print("manifest %d files, %s (%s)" % (len(entries), human(total), kind))

    hosts = load_hosts(a.hosts, set(a.host), a.remote, kind)
    width = max([5] + [len(h["id"]) for h in hosts])
    bad = False
    missing = {}                      # place -> [paths]
    extra = {}                        # host id -> [paths it holds that the manifest doesn't list]

    if not a.no_local:
        got = look_local(a.local, entries, a.sha)
        m, w = judge(entries, got, a.sha)
        missing["local"] = m
        print("%-*s %d present, %d missing%s" % (width, "local", len(entries) - len(m), len(m),
                                                 ", %d wrong" % len(w) if w else ""))
        for x in w:
            print("  local wrong: " + x)
        bad = bad or bool(w)

    for h in hosts:
        want = [e for e in entries if not e.get("hosts") or h["id"] in e["hosts"]]
        skipped = len(entries) - len(want)
        if h["kind"] == "ssh":
            held = look_ssh(h, a.sha)
            got = {e["path"]: held.get(e["path"]) for e in want}
            # Extras are what NONE of the manifests this host holds asks
            # for. Checking one manifest must not report the other's files
            # as strays, or the toolchain run calls all 1,020 runtime
            # downloads unexplained.
            asked = set()
            for k in (h.get("holds") or [kind]):
                try:
                    asked |= {e["path"] for e in load_manifest(MANIFESTS[k])}
                except (KeyError, FileNotFoundError):
                    pass
            extra[h["id"]] = sorted(set(held) - asked)
        else:
            got = look_http(h, want, a.sha)
        m, w = judge(want, got, a.sha)
        missing[h["id"]] = m
        print("%-*s %d present, %d missing%s%s%s" % (
            width, h["id"], len(want) - len(m), len(m),
            ", %d wrong" % len(w) if w else "",
            ", %d not for this host" % skipped if skipped else "",
            ", %d not in the manifest" % len(extra[h["id"]]) if extra.get(h["id"]) else ""))
        for x in w:
            print("  %s wrong: %s" % (h["id"], x))
        bad = bad or bool(w)

    def show(title, paths, why):
        if not paths:
            return
        print("\n%s (%d)%s" % (title, len(paths), why))
        for p in (paths if not a.quiet else paths[:10]):
            print("  " + p)
        if a.quiet and len(paths) > 10:
            print("  … and %d more" % (len(paths) - 10))

    places = list(missing)
    everywhere = set(entries[0]["path"] for _ in ()) if not entries else None
    everywhere = set.intersection(*[set(missing[p]) for p in places]) if places else set()
    for place in places:
        only_here = sorted(set(missing[place]) - everywhere)
        if place == "local":
            show("On the mirror hosts but not on this machine", only_here,
                 ": the resolver cannot see them, so no plan names the mirror copy"
                 " and they sit there unused.")
        else:
            others = [p for p in places if p != place]
            show("Missing from %s but present %s" % (place, "elsewhere" if len(others) > 1 else "on " + others[0]),
                 only_here,
                 ": the plans that name %s fall back to the vendor." % place)
    show("In the manifest and nowhere", sorted(everywhere), ": never fetched.")
    for hid, paths in extra.items():
        # Not a fault: things deliberately on a host that no plan downloads
        # (the build toolchain has its own manifest, for instance). Worth
        # naming, because nothing here would put them back if the host were
        # rebuilt -- but not worth failing over, or the check cries wolf and
        # stops being read.
        show("On %s but not in this manifest" % hid, paths,
             ": nothing here would fetch them again if %s were rebuilt." % hid)

    bad = bad or any(missing[p] for p in places)
    if not bad:
        names = ", ".join(["the local store"] * (not a.no_local) + [h["id"] for h in hosts])
        print("\nok: the manifest, %s agree on %d files" % (names, len(entries)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
