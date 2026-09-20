#!/usr/bin/env python3
"""Make 32-bit (i386) Linux root filesystems on this machine, without root.

usage: mkroot.py [NAME ...] [--force]

  debian12-i386    Debian 12 i386, glibc 2.36  (Docker Hub, i386/debian:12)
  debian12-i386-libs  the same, plus libatomic1 (a plan prerequisite)
  alpine324-i386   Alpine 3.24 x86, musl       (dl-cdn.alpinelinux.org)

The roots land in $TI_ROOTS (default ~/.local/share/ti-testroots/<name>) and
are entered by tests/arch/sandbox.py with bubblewrap. Nothing here needs sudo:
the tarballs are unpacked with --no-same-owner into a user directory, and
bubblewrap maps the caller to uid 0 inside a user namespace.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOTS = Path(os.environ.get("TI_ROOTS", Path.home() / ".local/share/ti-testroots"))
ALPINE = "https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/x86/alpine-minirootfs-3.24.2-x86.tar.gz"
REGISTRY = "https://registry-1.docker.io/v2"
DEBIAN_REPO, DEBIAN_TAG = "i386/debian", "12"
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def get(url, headers=None, binary=False):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read() if binary else json.load(r)


def untar(path_or_bytes, dest):
    """Unpack as an unprivileged user: no ownership, no device nodes."""
    kw = dict(name=path_or_bytes) if isinstance(path_or_bytes, (str, Path)) else dict(fileobj=path_or_bytes)
    with tarfile.open(mode="r:*", **kw) as t:
        members = [m for m in t.getmembers() if not m.isdev() and not m.name.startswith("dev/")]
        for m in members:
            m.uid = os.getuid()
            m.gid = os.getgid()
            m.uname = m.gname = ""
        try:
            t.extractall(dest, members=members, filter="tar")
        except TypeError:          # Python < 3.12 has no filter=
            t.extractall(dest, members=members)


def make_alpine(dest):
    print(f"alpine324-i386: fetching {ALPINE}", flush=True)
    tmp = dest.parent / ".alpine.tar.gz"
    urllib.request.urlretrieve(ALPINE, tmp)
    untar(tmp, dest)
    tmp.unlink()
    return "alpine 3.24 musl x86"


def make_debian(dest):
    print(f"debian12-i386: fetching {DEBIAN_REPO}:{DEBIAN_TAG} from Docker Hub", flush=True)
    tok = get(f"https://auth.docker.io/token?service=registry.docker.io&scope=repository:{DEBIAN_REPO}:pull")["token"]
    h = {"Authorization": "Bearer " + tok, "Accept": ACCEPT}
    man = get(f"{REGISTRY}/{DEBIAN_REPO}/manifests/{DEBIAN_TAG}", h)
    if "manifests" in man:                       # an index: take the 386 image
        picks = [m for m in man["manifests"] if m.get("platform", {}).get("architecture") == "386"]
        if not picks:
            sys.exit("no linux/386 manifest in the index")
        man = get(f"{REGISTRY}/{DEBIAN_REPO}/manifests/{picks[0]['digest']}", h)
    for layer in man["layers"]:
        print(f"  layer {layer['digest']} ({layer['size'] // 1024} kB)", flush=True)
        blob = f"{REGISTRY}/{DEBIAN_REPO}/blobs/{layer['digest']}"
        req = urllib.request.Request(blob, headers={"Authorization": "Bearer " + tok})
        with urllib.request.urlopen(req, timeout=300) as r:
            import io
            untar(io.BytesIO(r.read()), dest)
    return "debian 12 glibc x86"


def make_debian_libs(dest):
    """Debian 12 i386 with the library prerequisites a plan may ask for.

    The plain root is deliberately minimal, so a plan's `need` block fires
    and the unattended install stops with the command to run -- that is the
    failure path. This one has the libraries, so the same plan installs:
    both halves of the check get tested. libatomic1 is the interesting one,
    because Rust's 32-bit x86 plan needs it and its 64-bit sibling does
    not (docs/design.md 1.11, "32-bit Linux").
    """
    make_debian(dest)
    return "debian 12 glibc x86 +libatomic1"


MAKERS = {"debian12-i386": make_debian, "debian12-i386-libs": make_debian_libs,
          "alpine324-i386": make_alpine}

# What the `.run` engine looks for on a Linux machine: a downloader (curl or
# wget), a SHA-256 tool, and the unpackers for the formats the catalogue
# uses. A minimal Debian image has none of the downloaders, so the root is
# given them the way a real machine would have them -- from the
# distribution, inside the sandbox, as root.
PROVISION = {
    "debian12-i386": (
        # APT::Sandbox::User=root: apt normally drops to uid 42 (_apt) to
        # fetch, and an unprivileged user namespace maps only one uid.
        "apt-get -o APT::Sandbox::User=root -qq update && "
        "DEBIAN_FRONTEND=noninteractive apt-get -o APT::Sandbox::User=root -qq install -y --no-install-recommends "
        "curl wget ca-certificates xz-utils bzip2 unzip file procps && "
        "apt-get -qq clean && rm -rf /var/lib/apt/lists/* && ldconfig && "
        "echo PROVISIONED"
    ),
    "debian12-i386-libs": None,        # set below: the plain root's line plus libatomic1
    "alpine324-i386": (
        "apk add --no-cache curl wget ca-certificates xz bzip2 unzip file coreutils >/dev/null && "
        "echo PROVISIONED"
    ),
}
PROVISION["debian12-i386-libs"] = PROVISION["debian12-i386"].replace(
    "curl wget ca-certificates", "curl wget ca-certificates libatomic1")

# uid 1000 inside the sandbox, so a cell installs as a normal user does.
USER_LINE = "ti:x:1000:1000:test:/home/ti:/bin/sh\n"
GROUP_LINE = "ti:x:1000:\n"


def settle(d):
    """Things the image has no reason to carry but a machine always has."""
    etc = d / "etc"
    etc.mkdir(exist_ok=True)
    # The host's own upstream servers. /etc/resolv.conf is a stub pointing at
    # systemd-resolved on 127.0.0.53, which is this machine's loopback and
    # means nothing inside the sandbox, so prefer the real list beside it.
    ns = []
    for host in (Path("/run/systemd/resolve/resolv.conf"), Path("/etc/resolv.conf")):
        if not host.exists():
            continue
        ns = [l for l in host.read_text().splitlines()
              if l.startswith("nameserver") and "127.0.0." not in l]
        if ns:
            break
    (etc / "resolv.conf").write_text("\n".join(ns or ["nameserver 1.1.1.1", "nameserver 8.8.8.8"]) + "\n")
    for name, line in (("passwd", USER_LINE), ("group", GROUP_LINE)):
        p = etc / name
        text = p.read_text() if p.exists() else ""
        if ":1000:" not in text:
            p.write_text(text + line)
    (d / "home/ti").mkdir(parents=True, exist_ok=True)
    (d / "ibsrc").mkdir(exist_ok=True)


def provision(name, d):
    """Install what the engine needs, in the root itself, as root."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import sandbox
    (d / ".ti-root").write_text("provisioning\n")      # so run_script will enter it
    rc, out, err = sandbox.run_script(
        name, PROVISION[name], copy=False, uid=0, timeout=1200,
        env={"HOME": "/root", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"})
    if "PROVISIONED" not in out:
        sys.exit(f"{name}: provisioning failed (rc {rc})\n{out[-2000:]}\n{err[-2000:]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("names", nargs="*", default=list(MAKERS))
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()
    ROOTS.mkdir(parents=True, exist_ok=True)
    for n in a.names or list(MAKERS):
        if n not in MAKERS:
            sys.exit(f"unknown root: {n}")
        d = ROOTS / n
        if (d / ".ti-root").exists() and not a.force:
            print(f"{n}: already there ({d})")
            continue
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
        what = MAKERS[n](d)
        if not (d / "bin/sh").exists():
            sys.exit(f"{n}: no /bin/sh in the root")
        settle(d)
        provision(n, d)
        (d / ".ti-root").write_text(what + "\n")
        print(f"{n}: done ({d})")
    subprocess.run(["du", "-sh", *[str(ROOTS / n) for n in (a.names or list(MAKERS))]])


if __name__ == "__main__":
    main()
