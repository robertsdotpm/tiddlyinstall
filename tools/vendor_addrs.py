#!/usr/bin/env python3
"""Which download hosts answer plain HTTP when addressed by IP, and at what addresses.

Writes `vendor_addrs` into the build server's policy.json. `resolve.js`
turns it into the plan's `addr` lines, and the engines use those when a
download fails -- see ti_get_by_addr in the unix engine.

Why this exists at all. Every download URL in the catalogue is a name,
so a machine whose DNS does not work fails all of them, and our own
mirror is not the safety net it looks like: 1,256 files against the
catalogue's 82,105. The note in resolve.js said vendor addresses "would
be URLs that cannot work", which was measured -- but against
`https://<address>/`, where the certificate cannot match the address and
most hosts want SNI besides. Asking the same host over plain HTTP with
the name in a Host: header is a different question, and on 2026-09-25
21 hosts carrying 43.8% of the catalogue's URLs answered it.

Two rules this keeps:

  * A host is listed only if it was proven, not assumed. The probe asks
    for a real file from the catalogue and requires 200 or 206; a
    redirect to https, a 4xx, or a host that refuses port 80 is left
    out, so a failure in the field is a genuine one and not a guess.
  * Plain HTTP is sound here only because every file is checked against
    the SHA-256 in the signed plan. This must never be used for anything
    without one -- the same rule base.nsi states for downloads: "a file
    with no SHA-256 must come over HTTPS".

    tools/vendor_addrs.py [--write] [--registry DIR] [--policy FILE]

Without --write it prints what it found and changes nothing.
"""
import argparse, json, os, re, socket, subprocess, sys
from collections import Counter
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)


def catalogue_urls(registry):
    """host -> (url count, the smallest file's url) for every download host."""
    count, sample = Counter(), {}

    def walk(o):
        if isinstance(o, dict):
            u, sz = o.get('url'), o.get('size')
            if isinstance(u, str) and u.startswith('http'):
                m = re.match(r'https?://([^/]+)', u)
                if m:
                    h = m.group(1)
                    count[h] += 1
                    s = sz if isinstance(sz, int) else 1 << 40
                    if h not in sample or s < sample[h][1]:
                        sample[h] = (u, s)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    for root, _, files in os.walk(registry):
        for fn in files:
            if not fn.endswith('.json'):
                continue
            try:
                with open(os.path.join(root, fn)) as fh:
                    walk(json.load(fh))
            except Exception:
                continue
    return count, sample


def addresses(host):
    """Every A and AAAA for host, deduplicated, in a stable order."""
    out = []
    for fam in (socket.AF_INET, socket.AF_INET6):
        try:
            for info in socket.getaddrinfo(host, 80, fam, socket.SOCK_STREAM):
                ip = info[4][0]
                if ip not in out:
                    out.append(ip)
        except OSError:
            pass
    return out


def probe(host, url, timeout=15):
    """Does `host` serve this file over plain HTTP, addressed by IP?"""
    ips = addresses(host)
    if not ips:
        return host, 'NOADDR', []
    path = re.sub(r'^https?://[^/]+', '', url) or '/'
    v4 = [i for i in ips if ':' not in i]
    if not v4:
        return host, 'NOADDR', []
    at = v4[0]
    cmd = ['curl', '-sS', '-o', os.devnull, '-w', '%{http_code}',
           '--max-time', str(timeout), '-H', 'Host: ' + host,
           '-r', '0-1023', 'http://%s%s' % (at, path)]
    try:
        code = subprocess.run(cmd, capture_output=True, text=True,
                              timeout=timeout + 10).stdout.strip()
    except Exception:
        return host, 'NOANSWER', ips
    if code in ('200', '206'):
        return host, 'WORKS', ips
    if code.startswith('30'):
        return host, 'REDIR', ips
    return host, ('NOANSWER' if code == '000' else 'HTTP' + code), ips


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--registry', default=os.path.join(REPO, 'registry'))
    ap.add_argument('--policy', default=os.path.join(REPO, 'src/build_server/policy.json'))
    ap.add_argument('--write', action='store_true')
    ap.add_argument('--jobs', type=int, default=10)
    a = ap.parse_args()

    count, sample = catalogue_urls(a.registry)
    if not count:
        print('no download URLs found under %s' % a.registry, file=sys.stderr)
        return 2
    hosts = [h for h, _ in count.most_common() if h in sample]
    print('%d download hosts, %d URLs' % (len(hosts), sum(count.values())))

    with ThreadPoolExecutor(max_workers=a.jobs) as ex:
        results = list(ex.map(lambda h: probe(h, sample[h][0]), hosts))

    works, total_ok = {}, 0
    for host, verdict, ips in sorted(results, key=lambda r: -count[r[0]]):
        if verdict == 'WORKS':
            works[host] = ips
            total_ok += count[host]
            print('  WORKS  %-34s %7d urls  %s' % (host, count[host], ' '.join(ips[:4])))
    print('%d hosts, %d of %d URLs (%.1f%%)'
          % (len(works), total_ok, sum(count.values()),
             100.0 * total_ok / sum(count.values())))

    if not a.write:
        print('\n(--write not given; policy.json untouched)')
        return 0
    # Keep the file's own shape: one-space indent, keys in the order they
    # were written. Rewriting it sorted turned a 148-line change into a
    # 4,000-line one, which is the kind of diff nobody reads.
    with open(a.policy) as fh:
        pol = json.load(fh, object_pairs_hook=__import__('collections').OrderedDict)
    pol['vendor_addrs'] = works
    with open(a.policy, 'w') as fh:
        json.dump(pol, fh, indent=1)
        fh.write('\n')
    print('\nwrote %d hosts to %s' % (len(works), a.policy))
    return 0


if __name__ == '__main__':
    sys.exit(main())
