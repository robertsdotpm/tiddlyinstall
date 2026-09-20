#!/usr/bin/env python3
"""Is the mirror whole? Compare the manifest, the local runtime store and
the mirror host, and name every file that is in one and not the others.

usage: mirror_check.py [MANIFEST] [--local DIR] [--remote [USER@]HOST:DIR]
                       [--sha] [--quiet]

Topping up the mirror is two halves, and only one of them is obvious:

  * the mirror host, so the file can be downloaded at install time;
  * the local runtime store, because a mirror URL only reaches a plan
    through LocalIndex (backend/lib/catalog.js), which walks *this
    machine's* copies and fills in the release's `local` path. A file
    that is on the mirror host but that this machine has never seen has
    no `local`, so its plans name the vendor alone and the copy is never
    used -- the pull looks like it worked and changes no plan.

So a half-done top-up is silent. This says so instead:

  manifest 1020 files, 122.4 GB
  local    1020 present, 0 missing
  remote   1020 present, 0 missing
  ok: the manifest, the local store and ovh1.p2pd.net agree on 1020 files

Missing on one side only is the half-done state; missing on both is a
file the manifest lists that nobody has fetched yet. Files on the mirror
host that the manifest doesn't list are reported but are not a fault:
some are deliberate (the build toolchain lives there too). They are
worth knowing about because nothing would put them back if the host were
rebuilt from the manifest. Sizes are compared
always (that is what LocalIndex matches on, with the name); --sha also
hashes every file on both sides, which is slow and rarely what you want
after `mirror_fetch.py`, since it verified the hashes as it fetched.

Exit status is 0 when everything agrees, 1 when it does not, so this can
be a check rather than something to read.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

DEFAULT_MANIFEST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "runtime-catalog/store/mirror-manifest.json")
DEFAULT_LOCAL = os.path.expanduser("~/projects/installer-builder-runtimes")
DEFAULT_REMOTE = "ovh1.p2pd.net:installer-builder-mirror"

# Asking the mirror host once, rather than once per file: the program
# goes over ssh on stdin (so nothing has to survive the remote shell's
# quoting) and walks the mirror, printing "<size> <sha256-or-dash> <path>"
# for every file it holds.
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


def look_remote(remote, want_sha):
    """Everything the mirror host holds: {path: (size, sha)}."""
    host, _, root = remote.partition(":")
    if not root:
        root = "installer-builder-mirror"
    cmd = ["ssh", host, "python3", "-", root, "1" if want_sha else "0"]
    p = subprocess.run(cmd, input=PROBE, capture_output=True, text=True, timeout=7200)
    if p.returncode != 0:
        sys.exit("could not ask %s: %s" % (host, (p.stderr or "").strip()[-400:]))
    out = {}
    for line in p.stdout.splitlines():
        size, sha, path = line.split(" ", 2)
        out[path] = (int(size), sha)
    return out


def judge(entries, got, want_sha):
    """(missing, wrong) for one side."""
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
    ap.add_argument("--remote", default=DEFAULT_REMOTE, help="[user@]host:dir, or '' to skip")
    ap.add_argument("--sha", action="store_true", help="hash every file on both sides too (slow)")
    ap.add_argument("--quiet", action="store_true", help="only the summary and what is wrong")
    a = ap.parse_args()

    entries = json.load(open(a.manifest))
    total = sum(e.get("size") or 0 for e in entries)
    print("manifest %d files, %s" % (len(entries), human(total)))

    local = look_local(a.local, entries, a.sha)
    lm, lw = judge(entries, local, a.sha)
    print("local    %d present, %d missing%s" % (len(entries) - len(lm), len(lm),
                                                 ", %d wrong" % len(lw) if lw else ""))
    rm, rw, extra = [], [], []
    if a.remote:
        held = look_remote(a.remote, a.sha)
        remote = {e["path"]: held.get(e["path"]) for e in entries}
        rm, rw = judge(entries, remote, a.sha)
        extra = sorted(set(held) - {e["path"] for e in entries})
        print("remote   %d present, %d missing%s%s" % (
            len(entries) - len(rm), len(rm),
            ", %d wrong" % len(rw) if rw else "",
            ", %d not in the manifest" % len(extra) if extra else ""))

    only_local = sorted(set(rm) - set(lm))
    only_remote = sorted(set(lm) - set(rm))
    both = sorted(set(lm) & set(rm))

    def show(title, paths, why):
        if not paths:
            return
        print("\n%s (%d)%s" % (title, len(paths), why))
        for p in paths if not a.quiet else paths[:10]:
            print("  " + p)
        if a.quiet and len(paths) > 10:
            print("  … and %d more" % (len(paths) - 10))

    show("On this machine but not on the mirror host", only_local,
         ": install-time downloads will fall back to the vendor.")
    show("On the mirror host but not on this machine", only_remote,
         ": the resolver cannot see them, so no plan names the mirror copy"
         " and the files sit there unused.")
    show("In the manifest and nowhere", both, ": never fetched.")
    # Not a fault: things that are deliberately on the host and are not
    # runtime files a plan downloads (the build toolchain, say). Worth
    # naming, because nothing here would put them back if the host were
    # rebuilt from the manifest -- but not worth failing over, or the
    # check cries wolf and stops being read.
    show("On the mirror host but not in the manifest", extra,
         ": nothing here would fetch them again if the host were rebuilt.")
    for w in lw:
        print("local  wrong: " + w)
    for w in rw:
        print("remote wrong: " + w)

    bad = bool(only_local or only_remote or both or lw or rw)
    if not bad:
        where = a.remote.partition(":")[0] if a.remote else "the local store"
        print("\nok: the manifest, the local store and %s agree on %d files" % (where, len(entries)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
