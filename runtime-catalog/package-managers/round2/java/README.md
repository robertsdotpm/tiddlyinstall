# Java mirror hunt, round 2 (2026-09-17)

Scripts and evidence for extending Java (Zulu/Temurin) mirror coverage
per `catalog/MIRROR-HUNT-2.md`. See `catalog/java/NOTES.md`'s "Mirror
hunt round 2 (2026-09-17)" section for the full writeup; this is just
the re-runnable tooling.

- `probe_static_azul.py` -- stress-samples releases.json's zulu entries
  (spread across major/kind/format/variant/size) and HEAD-checks each
  against `static.azul.com` (an alternate hostname for the same Azul CDN
  origin as `cdn.azul.com`). Read-only, no writes.
- `extra_mirrors_round2.py` -- the actual mirror-hunt logic. Applies
  `static.azul.com` to every zulu entry (verified globally by
  `probe_static_azul.py`'s method) and discovers + HEAD-confirms matches
  against `https://d10.injdk.cn/openjdk/zulu/<major>/` (a real,
  partial/rolling Zulu mirror run by the injdk.cn JDK-aggregator site).
  Writes `round2_java_updates.jsonl` (an `add_mirrors.py`-format updates
  file); does not touch `releases.json` or any `download_plan*.json`
  directly.
- `round2_java_updates.jsonl` -- the generated updates, already applied
  via `python3 catalog/tools/add_mirrors.py
  catalog/package-managers/round2/java/round2_java_updates.jsonl`.
  Re-running `extra_mirrors_round2.py` regenerates it idempotently (no
  duplicate mirrors on re-apply, since `add_mirrors.py` de-dupes).
- `apply_docs.py` -- one-shot script that appended the two new mirrors to
  `catalog/java/mirrors.json` and the NOTES.md section, under
  `catalog/.write.lock`. Safe to leave here for reference; re-running it
  is a no-op (checks for existing entries/section before writing).

## Result

- Zulu: 7,420/7,420 entries now have a mirror (`static.azul.com`, full
  coverage; `d10.injdk.cn` additionally on 101 of them). Previously 0.
- releases.json overall: 192/9,937 (1.9%) -> 7,641/9,937 (76.9%) with
  >=1 mirror.
- download_plan_majors.json: 73/119 (61.3%) -> 98/119 (82.4%) with >=1
  mirror.
- Temurin coverage is unchanged from round 1 (still 221/2,217 mirrored,
  via TUNA/NJU/USTC's latest-per-major-only coverage) -- every Temurin
  lead in this round's task (ISCAS, SJTUG, HUST, Adoptium's own
  Artifactory, Eclipse, JetBrains) was tried and rejected; see NOTES.md
  for why each one didn't pan out.
