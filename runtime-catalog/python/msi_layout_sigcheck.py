#!/usr/bin/env python3
# Re-download every component MSI, check its SHA-256 against msi_hashes.json and
# its Authenticode signature (digest matches, signer CN = Python Software Foundation).
import json, hashlib, os, subprocess, tempfile, urllib.request, concurrent.futures as cf
d = json.load(open('msi_hashes.json'))
OSS = os.path.expanduser('~/.local/bin/osslsigncode')
def one(item):
    key, part, v = item
    with tempfile.NamedTemporaryFile(suffix='.msi') as t:
        with urllib.request.urlopen(v['url'], timeout=120) as r:
            data = r.read()
        t.write(data); t.flush()
        sha = hashlib.sha256(data).hexdigest()
        out = subprocess.run([OSS, 'verify', '-in', t.name], capture_output=True, text=True).stdout
        cur = [l.split()[-1] for l in out.splitlines() if l.startswith('Current DigitalSignature')]
        calc = [l.split()[-1] for l in out.splitlines() if l.startswith('Calculated DigitalSignature')]
        ok = sha == v['sha256'] and cur and cur == calc and 'CN=Python Software Foundation' in out
        return key, part, bool(ok), sha == v['sha256']
items = [(k, p, v) for k, r in d.items() for p, v in r.items()]
res = {}
with cf.ThreadPoolExecutor(8) as ex:
    for k, p, ok, shaok in ex.map(one, items):
        res[f'{k}/{p}'] = ok
        if not ok: print('BAD', k, p, 'sha ok' if shaok else 'sha MISMATCH', flush=True)
json.dump(res, open('sigcheck.json', 'w'), indent=1, sort_keys=True)
print(len(res), 'checked,', sum(1 for v in res.values() if not v), 'bad')
