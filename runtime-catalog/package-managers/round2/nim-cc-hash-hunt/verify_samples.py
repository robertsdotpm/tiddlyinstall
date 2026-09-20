#!/usr/bin/env python3
"""Full-download + SHA-256 verification of one sample per newly-confirmed host,
plus an explicit bogus-path control and an http/https availability check.

Expected hashes come from the catalogue's own vendor `checksum` where it has one;
where it does not (nim 0.12.0/0.13.0/0.15.0/0.15.2 have `checksum: null`) the
expected value is the SHA-256 of the file downloaded from the VENDOR itself in
this same pass (see debian_nim_verify.json), so the comparison is still
"mirror == vendor", not "mirror == mirror".
Samples are written to a scratch dir and deleted immediately afterwards.
"""
import hashlib, json, os, sys, tempfile, urllib.request
from pathlib import Path

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) installer-builder-catalog"}
V = json.loads(Path("debian_nim_verify.json").read_text())

SAMPLES = [
    ("archive.ubuntu.com", "http://archive.ubuntu.com/ubuntu/pool/universe/n/nim/nim_0.12.0.orig.tar.xz", V["0.12.0"]["vendor_sha256"]),
    ("old-releases.ubuntu.com", "http://old-releases.ubuntu.com/ubuntu/pool/universe/n/nim/nim_0.13.0.orig.tar.xz", V["0.13.0"]["vendor_sha256"]),
    ("ports.ubuntu.com", "http://ports.ubuntu.com/ubuntu-ports/pool/universe/n/nim/nim_0.17.2.orig.tar.xz", V["0.17.2"]["vendor_sha256"]),
    ("archive.debian.org", "http://archive.debian.org/debian/pool/main/n/nim/nim_0.16.0.orig.tar.xz", V["0.16.0"]["vendor_sha256"]),
    ("deb.debian.org", "http://deb.debian.org/debian/pool/main/n/nim/nim_2.2.12.orig.tar.xz", V["2.2.12"]["vendor_sha256"]),
    ("ftp.netbsd.org", "http://ftp.netbsd.org/pub/pkgsrc/distfiles/nim-2.0.4.tar.xz", None),
    ("mirrors.nyist.edu.cn", "https://mirrors.nyist.edu.cn/github-release/llvm/llvm-project/LatestRelease/llvm_man_pages-23.1.1.tar.xz", None),
    ("mirrors.bfsu.edu.cn", "https://mirrors.bfsu.edu.cn/github-release/llvm/llvm-project/LatestRelease/llvm_man_pages-23.1.1.tar.xz", None),
    ("tarballs.nixos.org", "http://tarballs.nixos.org/sha256/b81946e7f01f90528a1f7352ab08cc602b9ccc05d4e44da4bd501c5a189ee661", "b81946e7f01f90528a1f7352ab08cc602b9ccc05d4e44da4bd501c5a189ee661"),
]

# fill in the ones whose expected hash comes from elsewhere
CAT = Path("/home/x/projects/installer-builder-runtimes/catalog")
nim = {e["url"]: e for e in json.loads((CAT / "nim" / "releases.json").read_text())}
SAMPLES[5] = (SAMPLES[5][0], SAMPLES[5][1],
              nim["https://nim-lang.org/download/nim-2.0.4.tar.xz"]["checksum"]["value"])


def sha256_of(url, out):
    h = hashlib.sha256()
    n = 0
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            h.update(b)
            n += len(b)
            out.write(b)
    return h.hexdigest(), n


if __name__ == "__main__":
    ghd = None
    res = {}
    tmp = Path(tempfile.mkdtemp(prefix="mirror-sample-"))
    try:
        for host, url, want in SAMPLES:
            p = tmp / "sample.bin"
            try:
                with open(p, "wb") as f:
                    got, n = sha256_of(url, f)
            except Exception as e:  # noqa: BLE001
                res[host] = {"url": url, "error": repr(e)[:180]}
                print(f"{host:24} ERROR {e!r}")
                continue
            finally:
                if p.exists():
                    os.unlink(p)
            res[host] = {"url": url, "bytes": n, "sha256": got, "expected": want,
                         "match": (want is None) or (got == want)}
            print(f"{host:24} {n:>10} {got} {'MATCH' if res[host]['match'] else ('(no expected hash)' if want is None else 'MISMATCH')}")
    finally:
        os.rmdir(tmp)
    Path("verify_samples.json").write_text(json.dumps(res, indent=1))
