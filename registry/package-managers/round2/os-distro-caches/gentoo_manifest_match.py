import json, hashlib
from pathlib import Path
from collections import defaultdict

CATALOG = Path("/home/x/projects/installer-builder-runtimes/catalog")
MANDIR = Path("/tmp/gentoo_manifests")

def parse_manifest(path):
    out = {}
    for line in path.read_text().splitlines():
        parts = line.split()
        if not parts or parts[0] != "DIST":
            continue
        fn = parts[1]
        size = int(parts[2])
        hashes = {}
        i = 3
        while i < len(parts) - 1:
            hashes[parts[i].lower()] = parts[i+1]
            i += 2
        out[fn] = {"size": size, "hashes": hashes}
    return out

manifests = {f.stem: parse_manifest(f) for f in MANDIR.glob("*.manifest")}

def load_releases(rt):
    p = CATALOG / rt / "releases.json"
    return json.loads(p.read_text()) if p.exists() else []

runtimes = ["python","ruby","php","r","node","go","rust","java","dotnet","cc"]
by_fn = defaultdict(list)
for rt in runtimes:
    for e in load_releases(rt):
        fn = e["url"].rsplit("/",1)[-1]
        by_fn[fn].append((rt, e))

def bhash(fn):
    return hashlib.blake2b(fn.encode()).hexdigest()[:2]

total_new_mirror = 0
total_new_corrob = 0
updates = []  # for add_mirrors.py
report = defaultdict(list)

for mpkg, entries in manifests.items():
    for fn, info in entries.items():
        if fn not in by_fn:
            continue
        for rt, e in by_fn[fn]:
            size = e.get("size")
            if size is not None and size != info["size"]:
                continue  # size mismatch -> not same file, skip
            mirror_url = f"https://distfiles.gentoo.org/distfiles/{bhash(fn)}/{fn}"
            already = mirror_url in (e.get("mirrors") or [])
            need_mirror = not already
            # checksum corroboration: only add if our own checksum is missing,
            # or as extra corroboration if algos differ (skip if algo already same and equal - redundant)
            ck = e.get("checksum")
            corrob_algo = None
            corrob_val = None
            if ck is None:
                # no vendor checksum at all -> add corroboration
                if "sha512" in info["hashes"]:
                    corrob_algo, corrob_val = "sha512", info["hashes"]["sha512"]
                elif "sha256" in info["hashes"]:
                    corrob_algo, corrob_val = "sha256", info["hashes"]["sha256"]
            else:
                algo = ck.get("algo")
                if algo in info["hashes"]:
                    match = info["hashes"][algo].lower() == ck.get("value","").lower()
                    report[mpkg].append((fn, rt, e["version"], "HASH_MATCH" if match else "HASH_MISMATCH!!", algo))
                    if not match:
                        continue  # do not treat as same file if hash actively conflicts
            rec = {"fn": fn, "runtime": rt, "version": e["version"], "os": e.get("os"), "arch": e.get("arch"),
                   "variant": e.get("variant"), "url": e["url"], "need_mirror": need_mirror,
                   "corrob_algo": corrob_algo, "corrob_val": corrob_val}
            report[mpkg].append(("MATCH", fn, rt, e["version"], e.get("os"), e.get("arch"), e.get("variant"), need_mirror, corrob_algo is not None))
            if need_mirror:
                u = {"folder": rt, "url": e["url"], "mirror": mirror_url,
                     "evidence": f"Gentoo distfiles ({mpkg} ebuild), hash-addressed layout distfiles/<blake2b(filename)[:2]>/<filename>; size match{' + vendor hash match' if (ck and ck.get('algo') in info['hashes'] and info['hashes'][ck['algo']].lower()==ck.get('value','').lower()) else ''}, 2026-09-17"}
                updates.append(u)
                total_new_mirror += 1
            if corrob_algo:
                u2 = {"folder": rt, "url": e["url"],
                      "checksum_corroboration": {"algo": corrob_algo, "value": corrob_val,
                                                  "source": f"Gentoo {mpkg.replace('_','/')} Manifest (gentoo/gentoo GitHub), 2026-09-17"}}
                updates.append(u2)
                total_new_corrob += 1

print("total new mirror ops:", total_new_mirror)
print("total new corroboration ops:", total_new_corrob)

with open("/tmp/mirrorhunt/gentoo_updates.jsonl","w") as f:
    for u in updates:
        f.write(json.dumps(u)+"\n")

# print concise per-package summary
for mpkg, items in report.items():
    matches = [i for i in items if i[0]=="MATCH"]
    mismatches = [i for i in items if isinstance(i,tuple) and i[0]!="MATCH" and "HASH" in str(i[0])]
    print(f"\n=== {mpkg}: {len(matches)} matched files ===")
    need_mirror_count = sum(1 for i in matches if i[7])
    need_corrob_count = sum(1 for i in matches if i[8])
    print(f"  need_mirror={need_mirror_count} need_corrob={need_corrob_count}")
    for i in mismatches[:5]:
        print("  ", i)
