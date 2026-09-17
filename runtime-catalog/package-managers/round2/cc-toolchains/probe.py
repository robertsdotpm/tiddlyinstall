#!/usr/bin/env python3
"""Re-runnable probes behind the cc (C/C++ toolchain) round-2 mirror hunt,
2026-09-17. Read-only: HEAD/GET only, no full downloads except the two
explicitly-commented small samples (both well under the 60MB cap, and both
already deleted after use in the original run). Prints one line of result
per check; does not write to the catalog itself (see update_notes.py and
cc_round2_updates.jsonl for the write side, applied via
catalog/tools/add_mirrors.py).
"""
import urllib.request
import urllib.error

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 installer-builder-catalog")


class NoRedirect(urllib.request.HTTPErrorProcessor):
    def http_response(self, request, response):
        return response
    https_response = http_response


_no_redirect_opener = urllib.request.build_opener(NoRedirect)


def head(url, extra_headers=None, method="HEAD", follow_redirects=True):
    """GET is used for the actual confirmation checks (HEAD alone is not
    trustworthy evidence here -- see the TUNA note below: it returns a
    bare 200 with no Content-Length and no body on HEAD even for a path
    that 403s on GET, so HEAD-only success proves nothing)."""
    req = urllib.request.Request(url, method=method, headers={"User-Agent": UA, **(extra_headers or {})})
    opener = urllib.request.urlopen if follow_redirects else _no_redirect_opener.open
    try:
        with opener(req, timeout=15) as r:
            return r.status, r.headers.get("Content-Length"), r.headers.get("Location")
    except urllib.error.HTTPError as e:
        return e.code, None, e.headers.get("Location") if e.headers else None
    except Exception as e:
        return f"ERROR:{e}", None, None


CHECKS = [
    # (label, url, expected)
    ("SourceForge control: real public file (7-Zip 23.01), project page",
     "https://downloads.sourceforge.net/project/sevenzip/7-Zip/23.01/7z2301-x64.exe", "should be 200 if SF reachable"),
    ("SourceForge control: named mirror host for the same real file",
     "https://netcologne.dl.sourceforge.net/project/sevenzip/7-Zip/23.01/7z2301-x64.exe", "should be 200 if SF reachable"),
    ("SourceForge: mingw-w64 project page",
     "https://sourceforge.net/projects/mingw-w64/files/", "unreachable in the 2026-09-17 run (403)"),

    ("ISCAS github-release: llvm 20.1.6 windows/amd64 archive (CONFIRMED)",
     "https://mirror.iscas.ac.cn/github-release/llvm/llvm-project/LatestRelease/clang%2Bllvm-20.1.6-x86_64-pc-windows-msvc.tar.xz",
     "200, Content-Length 939427316"),
    ("ISCAS github-release: llvm 20.1.6 linux/arm64 archive (CONFIRMED)",
     "https://mirror.iscas.ac.cn/github-release/llvm/llvm-project/LatestRelease/LLVM-20.1.6-Linux-ARM64.tar.xz",
     "200, Content-Length 1860540860"),
    ("ISCAS github-release: llvm 20.1.6 win64.exe (rejected -- pruned)",
     "https://mirror.iscas.ac.cn/github-release/llvm/llvm-project/LatestRelease/LLVM-20.1.6-win64.exe",
     "404 in the 2026-09-17 run"),
    ("ISCAS github-release: winlibs_mingw root (absent)",
     "https://mirror.iscas.ac.cn/github-release/brechtsanders/winlibs_mingw/", "404"),
    ("ISCAS github-release: w64devkit root (absent)",
     "https://mirror.iscas.ac.cn/github-release/skeeto/w64devkit/", "404"),

    ("HUST github-release: llvm-project dir exists but unlistable via plain HTTP (JS-rendered)",
     "https://mirrors.hust.edu.cn/github-release/llvm/llvm-project/", "200 (app shell, no file links)"),
    ("HUST github-release: w64devkit root (absent)",
     "https://mirrors.hust.edu.cn/github-release/skeeto/w64devkit/", "404"),

    ("LLVM's own prereleases.llvm.org (same vendor, not an independent mirror)",
     "https://prereleases.llvm.org/", "200, gzip body (same sniff-the-magic-bytes gotcha as releases.llvm.org)"),
]


def main():
    for label, url, expected in CHECKS:
        status, length, _ = head(url, method="GET" if "SourceForge" not in label else "HEAD")
        print(f"[{status}] len={length}  {label}\n    url: {url}\n    expected: {expected}\n")

    print("--- SJTUG github-release/llvm/llvm-project/: bare redirect to github.com, not a mirror "
          "(redirect following disabled to see the Location header) ---")
    status, _, loc = head("https://mirrors.sjtug.sjtu.edu.cn/github-release/llvm/llvm-project/",
                           method="GET", follow_redirects=False)
    print(f"[{status}] Location: {loc}")

    print("\n--- TUNA github-release/llvm/llvm-project/: GET is blocked (403); oddly HEAD alone "
          "returns a bare 200 with no Content-Length/body, which is NOT usable evidence of any "
          "file's presence or size -- included to document the asymmetry, not as a mirror lead ---")
    get_status, _, _ = head("https://mirrors.tuna.tsinghua.edu.cn/github-release/llvm/llvm-project/",
                             method="GET")
    head_status, head_len, _ = head("https://mirrors.tuna.tsinghua.edu.cn/github-release/llvm/llvm-project/",
                                     method="HEAD")
    print(f"GET -> [{get_status}]   HEAD -> [{head_status}] len={head_len}")

    print("\n--- winlibs.com: confirm every download link points at github.com (not an independent host) ---")
    req = urllib.request.Request("https://winlibs.com/", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode("utf-8", "replace")
    import re
    links = re.findall(r'href="([^"]*download[^"]*)"', body)
    non_github = [l for l in links if l.startswith("http") and "github.com" not in l]
    print(f"{len(links)} download links found; {len(non_github)} do NOT point at github.com")
    for l in non_github[:10]:
        print("  non-github:", l)

    print("\n--- MSYS2: confirm mingw-w64-gcc is MSYS2's own build, not a WinLibs repackage ---")
    req = urllib.request.Request("https://repo.msys2.org/mingw/mingw64/", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode("utf-8", "replace")
    gcc_files = sorted(set(re.findall(r'mingw-w64-x86_64-gcc-[0-9][^"<]*\.pkg\.tar\.zst', body)))[:5]
    print("sample mingw-w64-gcc packages (MSYS2's own versioning/packaging):", gcc_files)

    print("\n--- install-llvm-action: confirm it downloads straight from github.com (no independent cache) ---")
    req = urllib.request.Request(
        "https://raw.githubusercontent.com/KyleMayes/install-llvm-action/master/index.ts",
        headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        body = r.read().decode("utf-8", "replace")
    for line in body.splitlines():
        if "github.com/llvm" in line or "downloadTool" in line:
            print("  ", line.strip())


if __name__ == "__main__":
    main()
