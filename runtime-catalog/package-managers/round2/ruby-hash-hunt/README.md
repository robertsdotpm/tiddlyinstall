# Ruby mirror hunt, round 2b: search by hash (2026-09-20)

Brief: find more download mirrors for **Ruby**, whose offerable entries had the
worst coverage in the catalogue (linux 446 with 0 mirrors, macOS 86 with 0,
Windows 315 with 4, and not one plain-`http://` URL on any platform). The
technique asked for was **searching by content hash** rather than by filename.

Everything here is re-runnable and reads only `../../../ruby/releases.json`.
Writes went through `catalog/tools/add_mirrors.py` (mirrors) and
`write_docs.py` (mirrors.json / NOTES.md, under `catalog/.write.lock`).

## Read this first: the User-Agent

`MIRROR-HUNT.md` says to use a browser-like User-Agent. For Ruby's mirrors that
advice is **actively harmful** and cost earlier rounds three real mirrors:

| host | with `Mozilla/...` | with `installer-builder-catalog/1.0` |
|---|---|---|
| `mirror.sjtu.edu.cn` | 403 / Cerberus WASM challenge | `cerberus-sec: DISABLED`, serves the file |
| `mirrors.tuna.tsinghua.edu.cn` | HEAD ok, every GET 403 "abnormal requests" | GET works |
| `mirrors.bfsu.edu.cn` | same 403 on GET | GET works |
| `mirrors.ustc.edu.cn` | 200 + HTML SPA for **every** path (soft-200) | real file, bogus path 404s |
| `archive.softwareheritage.org` | Anubis bot-check page | JSON API responds |

These gates are built to challenge clients pretending to be browsers and to let
honest self-identifying automation through. Nothing was solved or bypassed.
`probe.py` exports both `UA` and `PLAIN_UA` for this reason.

## Files

- `probe.py` — concurrent HEAD/GET prober. `run(urls, follow=, ua=)` returns
  `(status, content-length, final-host, location, url)` per URL; the final-host
  field is what distinguishes a mirror from a host that proxies or 30x's to the
  vendor. Also usable from the shell: `python3 probe.py head|follow <url>...`.
- `sjtu_probe.py` — per-entry check of SJTU's github-release mirror.
  `sjtu_probe.py ri2` covers the 677 `oneclick/rubyinstaller2` entries,
  `sjtu_probe.py rest` the other 886 (rubyinstaller v1, ruby-builder, rv-ruby,
  homebrew-portable-ruby). Keeps only entries whose final host is
  `s3.jcloud.sjtu.edu.cn` **and** whose final Content-Length equals the
  catalogue's vendor size. Output: `sjtu_ri2_hits.json` (213 hits),
  `sjtu_rest_hits.json` (0 hits — all 886 proxy to GitHub).
- `swh_probe.py` — Software Heritage content lookup by sha256. Resumable: the
  anonymous API allows 120 requests/hour, so it caches every answer in
  `swh_cache.json` and stops cleanly on 429. `--set source|offerable|all`,
  `--max N`.
- `local_hashes.tsv` — sha256 / sha1 / md5 of the 17 Ruby files we hold in
  `~/projects/installer-builder-runtimes/ruby/`, computed locally so the
  binaries could be looked up in caches keyed by a hash the catalogue does not
  record.
- `nixos_offerable_probe.json`, `nixos_source_probe.json`,
  `nixos_source_hits.json` — every `tarballs.nixos.org/sha256/<hex>` lookup.
- `bsd_source_hits.json`, `gentoo_source_hits.json` — per-entry HEAD results for
  the FreeBSD / NetBSD / Gentoo distfile caches.
- `updates_round2_hashhunt.jsonl`, `updates_round2_sjtu_homebrew.jsonl` — the
  exact input handed to `tools/add_mirrors.py`, one line per entry, each
  carrying its own evidence string.
- `write_docs.py` — writes `ruby/mirrors.json` and the `NOTES.md` section under
  `catalog/.write.lock`; idempotent (re-running replaces its own section).

## Result in one line

The hash search returned a clean **negative** for every binary — 580/580
offerable sha256s absent from `tarballs.nixos.org`, 0/28 from Software Heritage
— and the real wins came from fixing the User-Agent: SJTU for 213 RubyInstaller2
files, and TUNA/USTC/BFSU for the portable-ruby bottles over plain http.
