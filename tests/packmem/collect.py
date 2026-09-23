#!/usr/bin/env python3
"""Serves the measurement page and collects what it reports.

    python3 tests/packmem/collect.py --port 8099 --dir tests/packmem/out

- `GET /packmem.html` (and the ES5 page) from --dir.
- `POST /r` takes one JSON event from the page and appends it to
  `<--runs>/<run>.jsonl`, printing it as it arrives.
- `GET /ping` for a machine to check it can reach us.
- `GET /done?run=NAME` says whether that run has ended.

The page is served over plain HTTP because most of the test VMs cannot
reverse-tunnel (docs/local/test-vms.md), which means it is not a secure context
and `crypto.subtle` is absent. That is not a gap in the measurement: the
bundle's own cryptox.js falls back to the pure-JavaScript SHA-256, which is
what those browsers would use anyway, and the memory shape of the hash is
reported separately (`--secure` serves over an SSH reverse tunnel where one
is possible).
"""
import argparse
import json
import os
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

ARGS = None
LOCK = threading.Lock()
ENDED = set()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="text/plain"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n).decode("utf-8", "replace")
        self._send(204)
        try:
            ev = json.loads(raw)
        except Exception:
            ev = {"raw": raw}
        run = re.sub(r"[^\w.-]", "_", str(ev.get("run") or "run"))
        with LOCK:
            os.makedirs(ARGS.runs, exist_ok=True)
            with open(os.path.join(ARGS.runs, run + ".jsonl"), "a") as f:
                f.write(json.dumps(ev) + "\n")
            if ev.get("what") == "begin":
                ENDED.discard(run)
            if ev.get("what") == "end":
                ENDED.add(run)
        print(json.dumps(ev), flush=True)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path.endswith(".html"):
            print(f"# GET {self.path[:120]} from {self.client_address[0]}"
                  f" ({self.headers.get('User-Agent','')[:80]})", flush=True)
        if path == "/ping":
            return self._send(200, b"ok")
        if path == "/reset":
            m = re.search(r"run=([^&]*)", self.path)
            run = re.sub(r"[^\w.-]", "_", m.group(1)) if m else ""
            with LOCK:
                ENDED.discard(run)
                try:
                    os.remove(os.path.join(ARGS.runs, run + ".jsonl"))
                except OSError:
                    pass
            return self._send(200, b"ok")
        if path == "/done":
            m = re.search(r"run=([^&]*)", self.path)
            run = re.sub(r"[^\w.-]", "_", m.group(1)) if m else ""
            return self._send(200, b"yes" if run in ENDED else b"no")
        name = os.path.basename(path)
        p = os.path.join(ARGS.dir, name)
        if not name or not os.path.isfile(p):
            return self._send(404, b"no")
        with open(p, "rb") as f:
            body = f.read()
        ctype = "text/html; charset=utf-8" if name.endswith(".html") else "application/octet-stream"
        self._send(200, body, ctype)


def main():
    global ARGS
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--dir", default=os.path.join(HERE, "out"))
    ap.add_argument("--runs", default=os.path.join(HERE, "runs"))
    ARGS = ap.parse_args()
    os.makedirs(ARGS.runs, exist_ok=True)
    srv = ThreadingHTTPServer(("0.0.0.0", ARGS.port), H)
    print(f"packmem collector on 0.0.0.0:{ARGS.port}, serving {ARGS.dir}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
