#!/usr/bin/env python3
"""Add the msi-layout releases to releases.json (installer-builder, 2026-09-19).

python.org's Windows .exe installers for 3.5+ are WiX bundles of component
MSIs, published beside them: <version>/<amd64|win32|arm64>/core.msi,
exe.msi, lib.msi, tcltk.msi, ... An administrative install of core, exe,
lib and tcltk (`msiexec /a ... TARGETDIR=`) gives the full Python (tkinter,
pip via ensurepip, venv, IDLE) in a folder, registering nothing: the
install.json recipe with id msi-layout.

Each release is core.msi; exe.msi, lib.msi and tcltk.msi are its `parts`
(name, url, mirrors, sha256, size), which the resolver downloads as extra
files for the recipe's {tmp}\\<name> steps. Data: msi_layout.json, made
from the output of three helpers run in a scratch folder:
msi_layout_fetch.py (msi_hashes.json: SHA-256 and size of every file;
python.org publishes no checksums for these), msi_layout_mirrors.py
(mirror_ok.json: which mirrors serve each file, by size) and
msi_layout_sigcheck.py (sigcheck.json: each file downloaded again, its
SHA-256 compared and its Authenticode signature by the Python Software
Foundation checked with osslsigncode).

    python3 msi_layout.py        # rewrites releases.json; idempotent
"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
REL = os.path.join(HERE, 'releases.json')
data = json.load(open(os.path.join(HERE, 'msi_layout.json')))['releases']
rels = [r for r in json.load(open(REL)) if r.get('variant') != 'msi-layout']
out, n = [], 0
for r in rels:
    out.append(r)
    if r['os'] != 'windows' or r['format'] != 'exe':
        continue
    key = r['version'] + '/' + r['arch']
    d = data.get(key)
    if not d or not all(p in d and d[p]['signature_ok'] for p in ('core.msi', 'exe.msi', 'lib.msi', 'tcltk.msi')):
        continue
    core = d['core.msi']
    adir = core['url'].rsplit('/', 2)[-2]
    out.append({
        'runtime': 'python', 'languages': ['python'], 'major': r['major'], 'version': r['version'],
        'os': 'windows', 'arch': r['arch'], 'kind': 'installer', 'format': 'msi', 'variant': 'msi-layout', 'libc': None,
        'url': core['url'], 'mirrors': [core['url']] + core['mirrors'],
        'checksum': {'algo': 'sha256', 'value': core['sha256'],
                     'source': 'computed 2026-09-19 (python.org publishes no checksums for component MSIs); Authenticode signature by the Python Software Foundation checked (msi_layout.json)'},
        'size': core['size'], 'released': r.get('released'), 'min_os': None,
        'metadata_source': 'https://www.python.org/ftp/python/%s/%s/' % (r['version'], adir),
        'notes': 'The component MSIs of python-%s-%s.exe: core.msi here, the rest in parts (install.json recipe msi-layout).' % (r['version'], r['arch']),
        'parts': [{'name': p, 'url': d[p]['url'], 'mirrors': [d[p]['url']] + d[p]['mirrors'], 'sha256': d[p]['sha256'], 'size': d[p]['size']}
                  for p in ('exe.msi', 'lib.msi', 'tcltk.msi')],
    })
    n += 1
with open(REL + '.tmp', 'w') as f:
    f.write(json.dumps(out, indent=1, ensure_ascii=False))
os.replace(REL + '.tmp', REL)
print('msi-layout releases:', n)
