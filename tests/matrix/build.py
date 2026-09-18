#!/usr/bin/env python3
"""Build the test matrix's installers through the real API (docs/plan.md section 3).

usage: build.py [--backend URL] [--runtimes python,node,...] [--modes A,B,C]
                [--platforms windows,linux,macos] [--out DIR]

For each runtime and mode it POSTs the hello-world project from
projects.json, follows the ticket until the job finishes, and downloads the
files to <out>/<runtime>/<mode>/. Mode B files are then signed by a stand-in
publisher (the "Example Publisher TEST" certificate) with osslsigncode, as a
real publisher would after downloading. Writes <out>/builds.json.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
KEYS = HERE.parents[1] / "server" / "data" / "keys"


def api(backend, path, body=None):
    req = urllib.request.Request(backend + path, data=json.dumps(body).encode() if body else None,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def build(backend, runtime, mode, platforms, proj):
    body = {"name": f"Hello {runtime}", "project": proj["project"], "source": {"kind": "inline"},
            "files": proj["files"], "runtime": runtime, "mode": mode, "platforms": platforms,
            "launch": proj["launch"], "console": True, "menu": True}
    if proj.get("install"):
        body["install"] = proj["install"]
    while True:
        try:
            j = api(backend, "/api/jobs", body)
            break
        except urllib.error.HTTPError as e:
            if e.code != 429:
                raise
            print("  rate limited; waiting 20 s", flush=True)
            time.sleep(20)
    print(f"  {runtime} {mode}: ticket {j['ticket']}, {j['position']} ahead", flush=True)
    while j["status"] in ("queued", "running"):
        time.sleep(1)
        j = api(backend, "/api/jobs/" + j["id"])
    return j


def sign_publisher(path):
    signed = path.with_name(path.stem + "_signed" + path.suffix)
    subprocess.run(["osslsigncode", "sign", "-certs", str(KEYS / "pub.crt"), "-key", str(KEYS / "pub.key"),
                    "-n", "Hello (publisher test)", "-in", str(path), "-out", str(signed)],
                   check=True, capture_output=True, env={**os.environ, "PATH": os.path.expanduser("~/.local/bin") + ":" + os.environ["PATH"]})
    signed.replace(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://127.0.0.1:8080")
    ap.add_argument("--runtimes", default="")
    ap.add_argument("--modes", default="A,B,C")
    ap.add_argument("--platforms", default="windows,linux,macos")
    ap.add_argument("--out", default=str(HERE / "out"))
    a = ap.parse_args()
    projects = json.loads((HERE / "projects.json").read_text())["projects"]
    runtimes = a.runtimes.split(",") if a.runtimes else list(projects)
    out = Path(a.out)
    results = json.loads((out / "builds.json").read_text()) if (out / "builds.json").exists() else {}
    for rt in runtimes:
        for mode in a.modes.split(","):
            j = build(a.backend, rt, mode, a.platforms.split(","), projects[rt])
            key = f"{rt}/{mode}"
            if j["status"] != "done":
                print(f"  {key}: FAILED: {j.get('error')}")
                results[key] = {"status": "failed", "error": j.get("error")}
                out.mkdir(parents=True, exist_ok=True)
                (out / "builds.json").write_text(json.dumps(results, indent=1))
                continue
            res = j["result"]
            files = {}
            d = out / rt / mode
            d.mkdir(parents=True, exist_ok=True)
            for f in res["files"]:
                p = d / f["name"]
                urllib.request.urlretrieve(a.backend + f["url"], p)
                if mode == "B" and f["platform"] == "windows":
                    sign_publisher(p)
                files[f["platform"]] = str(p)
            results[key] = {"status": "done", "record": res["record"], "files": files}
            print(f"  {key}: record {res['record']}, {len(files)} files")
            out.mkdir(parents=True, exist_ok=True)
            (out / "builds.json").write_text(json.dumps(results, indent=1))


if __name__ == "__main__":
    sys.exit(main())
