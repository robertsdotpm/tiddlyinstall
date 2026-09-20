#!/usr/bin/env python3
"""Add relocatable macOS Ruby builds to releases.json (installer-builder, 2026-09-19).

ruby-builder's macOS tarballs link Homebrew's libraries by absolute path
(/opt/homebrew/opt/openssl@3/...), so they only run where Homebrew is. These
builds are made to run from any folder, with OpenSSL, libyaml, libffi and zlib
built in and their own CA bundle (libexec/cert.pem, used through a hook in
openssl.rb unless SSL_CERT_FILE is set):

- rv-ruby (github.com/spinel-coop/rv-ruby, BSD-2-Clause build scripts, Ruby's
  own licence for Ruby): variant "rv-ruby". Every stable Ruby 3.2+ in each
  dated release; arm64 needs macOS 14 (arm64_sonoma), x86_64 macOS 15 (the
  "ventura" asset's binaries say 15.0), read from LC_BUILD_VERSION. The full
  standard library and bundled gems.
- Homebrew's portable Ruby (github.com/Homebrew/homebrew-portable-ruby, archived
  2025-09; now homebrew-core's portable-ruby, whose bottles need a ghcr.io token):
  variant "homebrew-portable", only its last release with published digests,
  3.4.5, for Macs older than rv-ruby's floor: x86_64 from 10.11 (el_capitan),
  arm64 from 11.3 (arm64_big_sur). Homebrew strips most bundled gems (csv,
  bigdecimal, minitest, rexml, net-smtp...): apps that use them list them in
  their Gemfile, as Ruby 3.4 already warns.

SHA-256: the digest GitHub publishes for each release asset. Data:
portable_ruby.json, written by `--fetch` (GitHub API); without it the saved
data is used, so the merge is reproducible.

    python3 portable_ruby.py [--fetch]   # rewrites releases.json; idempotent
"""
import json
import os
import re
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REL = os.path.join(HERE, 'releases.json')
DATA = os.path.join(HERE, 'portable_ruby.json')
VARIANTS = ('rv-ruby', 'homebrew-portable')
RV_REPO = 'spinel-coop/rv-ruby'
HB_REPO = 'Homebrew/homebrew-portable-ruby'
RV_ARCH = {'arm64_sonoma': 'arm64', 'ventura': 'amd64'}
HB_ARCH = {'arm64_big_sur': 'arm64', 'el_capitan': 'amd64'}
HB_VERSIONS = ('3.4.5',)


def gh(path):
    req = urllib.request.Request('https://api.github.com/' + path, headers={'Accept': 'application/vnd.github+json'})
    tok = os.environ.get('GITHUB_TOKEN')
    if tok:
        req.add_header('Authorization', 'Bearer ' + tok)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def fetch():
    rv = gh('repos/%s/releases?per_page=1' % RV_REPO)[0]
    assets = []
    for a in rv['assets']:
        m = re.match(r'^ruby-(\d+\.\d+\.\d+)\.(arm64_sonoma|ventura)\.tar\.gz$', a['name'])
        if m and a.get('digest', '').startswith('sha256:'):
            assets.append({'variant': 'rv-ruby', 'version': m.group(1), 'arch': RV_ARCH[m.group(2)], 'platform': m.group(2),
                           'url': a['browser_download_url'], 'size': a['size'], 'sha256': a['digest'][7:],
                           'released': a['updated_at'][:10], 'tag': rv['tag_name']})
    for v in HB_VERSIONS:
        rel = gh('repos/%s/releases/tags/%s' % (HB_REPO, v))
        for a in rel['assets']:
            m = re.match(r'^portable-ruby-(\d+\.\d+\.\d+)\.(arm64_big_sur|el_capitan)\.bottle\.tar\.gz$', a['name'])
            if m and a.get('digest', '').startswith('sha256:'):
                assets.append({'variant': 'homebrew-portable', 'version': m.group(1), 'arch': HB_ARCH[m.group(2)],
                               'platform': m.group(2), 'url': a['browser_download_url'], 'size': a['size'],
                               'sha256': a['digest'][7:], 'released': rel['published_at'][:10], 'tag': rel['tag_name']})
    assets.sort(key=lambda a: (a['variant'], [int(x) for x in a['version'].split('.')], a['arch']))
    json.dump({'fetched': 'GitHub API', 'rv_release': rv['tag_name'], 'assets': assets}, open(DATA, 'w'), indent=1)
    open(DATA, 'a').write('\n')


def main():
    if '--fetch' in sys.argv or not os.path.exists(DATA):
        fetch()
    data = json.load(open(DATA))
    rels = [r for r in json.load(open(REL)) if r.get('variant') not in VARIANTS]
    for a in data['assets']:
        major = '.'.join(a['version'].split('.')[:2])
        if a['variant'] == 'rv-ruby':
            src = 'https://github.com/%s/releases/tag/%s' % (RV_REPO, a['tag'])
            note = ('rv-ruby: a relocatable build (runs from any folder; OpenSSL, libyaml, libffi built in; its own CA bundle), '
                    'standard library and bundled gems complete. Not an official ruby-lang.org binary.')
        else:
            src = 'https://github.com/%s/releases/tag/%s' % (HB_REPO, a['tag'])
            note = ("Homebrew's portable Ruby (a relocatable build, OpenSSL and libyaml built in, its own CA bundle); most bundled "
                    'gems are left out (csv, bigdecimal, minitest, rexml, net-smtp...), so apps list them in their Gemfile. '
                    'Not an official ruby-lang.org binary.')
        rels.append({
            'runtime': 'ruby', 'languages': ['ruby'], 'major': major, 'version': a['version'],
            'os': 'macos', 'arch': a['arch'], 'kind': 'archive', 'format': 'tar.gz', 'variant': a['variant'], 'libc': None,
            'url': a['url'], 'mirrors': [],
            'checksum': {'algo': 'sha256', 'value': a['sha256'], 'source': 'GitHub release asset digest (%s)' % src},
            'size': a['size'], 'released': a['released'], 'min_os': None, 'metadata_source': src,
            'notes': note + ' Asset ' + a['platform'] + '.',
        })
    # Appended after scrape.py's entries (their order is scrape.py's).
    open(REL, 'w').write(json.dumps(rels, indent=1, ensure_ascii=False))
    print('%d portable macOS Ruby releases merged (%s)' % (len(data['assets']), ', '.join(sorted({a['variant'] for a in data['assets']}))))


if __name__ == '__main__':
    main()
