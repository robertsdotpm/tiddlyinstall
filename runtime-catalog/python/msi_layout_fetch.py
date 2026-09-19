#!/usr/bin/env python3
"""Hash python.org's per-component Windows MSIs (core, exe, lib, tcltk) for
every 3.5+ version/arch the catalogue has a Windows .exe installer for.
Writes msi_hashes.json (resumable). Files for versions our mirror carries
are kept under keep/<arch>/<ver>-msi/."""
import json, hashlib, os, sys, urllib.request, concurrent.futures as cf, threading
CAT = os.path.expanduser('~/projects/installer-builder-runtimes/catalog/python/releases.json')
MIRROR = os.path.expanduser('~/projects/installer-builder-runtimes/python/windows')
OUT = 'msi_hashes.json'
PARTS = ['core', 'exe', 'lib', 'tcltk']
ADIR = {'amd64': 'amd64', 'x86': 'win32', 'arm64': 'arm64'}
def v(s): return tuple(int(x) for x in s.split('.'))
rels = json.load(open(CAT))
jobs = sorted({(r['version'], r['arch']) for r in rels if r['os'] == 'windows' and r['format'] == 'exe'
               and r['arch'] in ADIR and all(p.isdigit() for p in r['version'].split('.')) and v(r['version']) >= (3, 5)},
              key=lambda j: (v(j[0]), j[1]))
keepset = set()
for arch in os.listdir(MIRROR):
    for d in os.listdir(os.path.join(MIRROR, arch)):
        if all(p.isdigit() for p in d.split('.')): keepset.add((d, arch))
done = json.load(open(OUT)) if os.path.exists(OUT) else {}
lock = threading.Lock()
def one(ver, arch, part):
    url = f'https://www.python.org/ftp/python/{ver}/{ADIR[arch]}/{part}.msi'
    keep = (ver, arch) in keepset
    path = f'keep/{arch}/{ver}-msi/{part}.msi'
    h = hashlib.sha256(); n = 0
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            f = None
            if keep:
                os.makedirs(os.path.dirname(path), exist_ok=True); f = open(path + '.tmp', 'wb')
            while True:
                b = r.read(1 << 20)
                if not b: break
                h.update(b); n += len(b)
                if f: f.write(b)
            if f: f.close(); os.replace(path + '.tmp', path)
    except urllib.error.HTTPError as e:
        return {'missing': e.code, 'url': url}
    return {'url': url, 'sha256': h.hexdigest(), 'size': n, 'kept': keep}
def job(j):
    ver, arch = j
    key = f'{ver}/{arch}'
    if key in done and all(p in done[key] for p in PARTS): return
    res = {p: one(ver, arch, p) for p in PARTS}
    with lock:
        done[key] = res
        json.dump(done, open(OUT + '.tmp', 'w'), indent=1, sort_keys=True); os.replace(OUT + '.tmp', OUT)
        print(key, ' '.join(f"{p}={res[p].get('size', res[p].get('missing'))}" for p in PARTS), flush=True)
with cf.ThreadPoolExecutor(6) as ex:
    list(ex.map(job, jobs))
print('total', len(done))
