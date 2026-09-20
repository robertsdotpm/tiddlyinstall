#!/usr/bin/env python3
# Which mirrors serve each component MSI, confirmed by size (Content-Range of a 1-byte request).
import json, urllib.request, concurrent.futures as cf, re, os
d = json.load(open('msi_hashes.json'))
BASES = ['https://mirrors.huaweicloud.com/python/', 'https://repo.huaweicloud.com/python/',
         'https://registry.npmmirror.com/-/binary/python/', 'https://cdn.npmmirror.com/binaries/python/',
         'https://mirrors.tuna.tsinghua.edu.cn/python/', 'https://mirror.nju.edu.cn/python/',
         'https://mirrors.bfsu.edu.cn/python/', 'http://mirrors.huaweicloud.com/python/', 'http://repo.huaweicloud.com/python/']
OUT = 'mirror_ok.json'
res = json.load(open(OUT)) if os.path.exists(OUT) else {}
def size_of(u):
    try:
        req = urllib.request.Request(u, headers={'Range': 'bytes=0-0', 'User-Agent': 'curl/8'})
        with urllib.request.urlopen(req, timeout=30) as r:
            cr = r.headers.get('Content-Range', '')
            m = re.search(r'/(\d+)$', cr)
            if m: return int(m.group(1))
            return int(r.headers.get('Content-Length') or -1) if r.status == 200 else -1
    except Exception as e:
        return -1
tasks = []
for key, parts in d.items():
    for p, v in parts.items():
        tail = v['url'].split('/ftp/python/')[1]
        for b in BASES:
            u = b + tail
            if u not in res: tasks.append((u, v['size']))
def one(t):
    u, n = t
    return u, size_of(u) == n
with cf.ThreadPoolExecutor(24) as ex:
    for i, (u, ok) in enumerate(ex.map(one, tasks)):
        res[u] = ok
        if i % 500 == 0:
            json.dump(res, open(OUT, 'w'))
            print(i, len(tasks), flush=True)
json.dump(res, open(OUT, 'w'))
import collections
c = collections.Counter((u.split('/python/')[0], ok) for u, ok in res.items())
for k in sorted(c): print(k, c[k])
