#!/usr/bin/env python3
"""A stand-in for the build server (docs/api.md), for testing the front end.

    python3 tests/mock_server.py [port]        # default 8094

Jobs go queued (4 s) -> running (4 s, progress text changes) -> done, with
fake download files. Source "fail/me" makes a job fail; an empty name with
an empty source gets a 400. CORS * on everything.
"""
import hashlib
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

JOBS = {}
LOCK = threading.Lock()
TICKET = [1000]
START = time.time()

CATALOG = {"runtimes": [
    {"id": "python", "label": "Python", "compiled": False, "launch": "{runtime} -m {project}", "newest": [
        {"family": "windows", "arch": "amd64", "covers": "Windows 11, Windows 10, Windows 8.1", "version": "3.14.7",
         "file": "python-3.14.7-embed-amd64.zip"},
        {"family": "windows", "arch": "x86", "covers": "Windows XP", "version": "3.4.4", "file": "python-3.4.4.msi"},
        {"family": "macos", "arch": "amd64", "covers": "macOS 10.14 Mojave", "version": None, "file": None},
    ]},
    {"id": "node", "label": "Node.js", "compiled": False, "launch": "{runtime} {app_dir}", "newest": [
        {"family": "windows", "arch": "amd64", "covers": "Windows 10, Windows 11", "version": "24.8.0", "file": "node.zip"},
        {"family": "linux", "arch": "amd64", "covers": "Linux, glibc 2.28 or later", "version": "24.8.0", "file": "node.tar.xz"},
    ]},
]}


def job_view(j):
    t = time.time() - j["created"]
    v = {k: j[k] for k in ("id", "ticket", "class")}
    v.update(error=None, result=None)
    if j["fail"] and t > 4:
        v.update(status="failed", position=0, eta_seconds=None, progress="Resolving source",
                 error="Repository fail/me was not found on GitHub")
    elif t < 4:
        v.update(status="queued", position=max(0, 2 - int(t / 2)), eta_seconds=round(8 - t), progress="")
    elif t < 8:
        v.update(status="running", position=0, eta_seconds=round(8 - t),
                 progress="Resolving source" if t < 6 else "Publishing settings record")
    else:
        files = []
        for p in j["platforms"]:
            ext = {"windows": ".exe", "linux": ".run", "macos": ".zip"}[p]
            name = "install_%s_%s%s" % (j["runtime"], j["project"], ext)
            body = ("fake %s installer\n" % p).encode()
            files.append({"platform": p, "name": name, "url": "/dl/" + name, "size": 812345,
                          "sha256": hashlib.sha256(body).hexdigest(),
                          "signed": {"A": "TiddlyInstall TEST", "B": "", "C": ""}[j["mode"]]})
        v.update(status="done", position=0, eta_seconds=0, progress="Done",
                 result={"record": "tjfq5rqwnnrxkamzq2x7v4paab", "files": files})
    return v


class H(BaseHTTPRequestHandler):
    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def send(self, code, obj, ctype="application/json"):
        body = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        p = self.path.split("?")[0]
        if p == "/api/health":
            return self.send(200, {"ok": True, "version": "mock", "workers": 1,
                                   "queues": {"record": 0, "build": 0, "pack": 0},
                                   "time": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        if p == "/api/catalog/runtimes":
            return self.send(200, CATALOG)
        if p.startswith("/api/jobs/"):
            with LOCK:
                j = JOBS.get(p[len("/api/jobs/"):])
            if not j:
                return self.send(404, {"error": "no such job", "code": "not_found"})
            return self.send(200, job_view(j))
        if p.startswith("/dl/"):
            return self.send(200, b"fake installer\n", "application/octet-stream")
        if p.startswith("/bases/"):
            return self.send(200, b"#!/bin/sh\necho mock base\n", "application/octet-stream")
        return self.send(404, {"error": "not found", "code": "not_found"})

    def do_POST(self):
        if self.path != "/api/jobs":
            return self.send(404, {"error": "not found", "code": "not_found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self.send(400, {"error": "body is not JSON", "code": "bad_json"})
        src = (req.get("source") or {})
        if not src.get("value") and src.get("kind") != "inline":
            return self.send(400, {"error": "source.value is required", "code": "bad_source"})
        with LOCK:
            TICKET[0] += 1
            jid = "j_mock%d" % TICKET[0]
            JOBS[jid] = {"id": jid, "ticket": TICKET[0], "class": "record" if req.get("mode") == "A" else "build",
                         "created": time.time(), "fail": src.get("value") == "fail/me",
                         "platforms": req.get("platforms") or [], "runtime": req.get("runtime", "x"),
                         "project": (src.get("value") or "app").split("/")[-1], "mode": req.get("mode", "A"),
                         "request": req}
        sys.stderr.write("JOB %s %s\n" % (jid, json.dumps(req)))
        return self.send(202, {"id": jid, "ticket": TICKET[0], "class": JOBS[jid]["class"],
                               "position": 2, "eta_seconds": 8, "status": "queued"})

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.command, self.path))


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8094
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
