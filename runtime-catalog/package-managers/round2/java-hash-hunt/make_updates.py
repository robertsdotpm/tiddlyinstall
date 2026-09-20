#!/usr/bin/env python3
"""Build java_hash_hunt_updates.jsonl from this round's probe results.

Sources (all produced by probe.py / bazel_mirror.py in this folder):
  azul_embedded_results.json  static.azul.com/zulu-embedded/bin/  (300 entries)
  azul_http_results.json      plain-http spread sample on both Azul hostnames
  nix_zulu_results.json       tarballs.nixos.org hits among zulu entries
  bazel_results.json          mirror.bazel.build/openjdk/ Zulu mirror

Nothing is written to the catalogue here; feed the .jsonl to
catalog/tools/add_mirrors.py (which takes catalog/.write.lock itself).
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
CATALOG = HERE.parents[2]
DATE = "2026-09-20"
OUT = HERE / "java_hash_hunt_updates.jsonl"

rel = json.loads((CATALOG / "java" / "releases.json").read_text())
zulu = [e for e in rel if e["url"].startswith("https://cdn.azul.com/")]

rows = []


def add(url, mirror, evidence):
    rows.append({"folder": "java", "url": url, "mirror": mirror, "evidence": evidence})


# 1. static.azul.com for the zulu-embedded path (the /zulu/bin/ prefix was done in round 2)
emb = json.loads((HERE / "azul_embedded_results.json").read_text())
ev_emb = (f"static.azul.com/zulu-embedded/bin/, {DATE}: HEAD Content-Length == the real vendor "
          f"Content-Length on all 300 zulu-embedded entries (296 first pass; 4 re-checked singly -- "
          f"2 timeouts, 2 stale rounded `size` fields in releases.json); bogus file and bogus "
          f"directory both 404; 21,377,456 B sample downloaded in full and sha256-verified. Detail: "
          f"package-managers/round2/java-hash-hunt/README.md")
for r in emb:
    add(r["url"], r["mirror"], ev_emb)

# 2. plain http:// on both Azul hostnames, for every zulu entry
ev_http = (f"plain http:// on the Azul CDN, {DATE}: 32/32 HEADs (16-file spread sample x 2 hosts, "
           f"redirects disabled) returned 200 with Content-Length == vendor size and no redirect; "
           f"bogus paths 404; one 21,377,456 B file downloaded in full over http from each host and "
           f"sha256-verified. Applied by scheme/host substitution. Detail: "
           f"package-managers/round2/java-hash-hunt/README.md")
for e in zulu:
    path = e["url"].split("https://cdn.azul.com", 1)[1]
    add(e["url"], "http://cdn.azul.com" + path, ev_http)
    add(e["url"], "http://static.azul.com" + path, ev_http)

# 3. mirror.bazel.build
bz = json.loads((HERE / "bazel_results.json").read_text())
ev_bz = (f"mirror.bazel.build/openjdk/ (Bazel project's Azul Zulu mirror), {DATE}: file listed in "
         f"the mirror's own index.html; the sha256 in that version directory's SHA256SUM equals the "
         f"catalogue's vendor sha256 (23/23 agreed); HEAD with redirects disabled returned 200 with "
         f"Content-Length == the real cdn.azul.com Content-Length. Bogus file and bogus directory "
         f"both 404. Sample zulu8.21.0.1-jdk8.0.131-win_x64.zip (76,357,880 B) downloaded in full "
         f"and sha256-verified against the catalogue checksum. http:// 301-redirects to https on "
         f"this host, so no plaintext URL is recorded.")
for r in bz["rows"]:
    if r["sha256_agrees"] and r["https_code"] == 200:
        add(r["url"], r["mirror"], ev_bz)

# 4. tarballs.nixos.org (hash-addressed) -- zulu entries, not probed in round 2
nx = json.loads((HERE / "nix_zulu_results.json").read_text())
ev_nx = (f"tarballs.nixos.org (Nix fetchurl fallback cache, content-addressed: the URL key IS the "
         f"vendor sha256), {DATE}: HEAD on https://tarballs.nixos.org/sha256/<vendor sha256> for all "
         f"7,720 zulu entries; 18 present, all with Content-Length == vendor size. Bogus hash 404s. "
         f"Host was already hash-verified for java in round 2 (temurin sample).")
for r in nx:
    if r.get("match"):
        add(r["url"], r["mirror"], ev_nx)

OUT.write_text("".join(json.dumps(r) + "\n" for r in rows))
print(f"{len(rows)} update lines -> {OUT}")
from collections import Counter
print(Counter(r["mirror"].split("/")[2] + " (" + r["mirror"].split(":")[0] + ")" for r in rows))
