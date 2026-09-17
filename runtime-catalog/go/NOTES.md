# Go runtime catalog notes

## Sources

- `https://go.dev/dl/?mode=json&include=all` -- primary index for every
  release entry. Covers go1.2.2 through the current stable (go1.27.1 /
  go1.26.8 as of 2026-09-17). Confirmed by diffing against the HTML
  `https://go.dev/dl/` "all releases" listing: both start at go1.2.2.
- `https://raw.githubusercontent.com/golang/website/master/internal/history/release.go`
  -- regex-parsed (not executed) for `released` dates, since the JSON
  index carries no date field. The file itself says older point
  releases often aren't listed individually ("Older releases do not
  have point release information here"), so `released` is `null` for
  most patch releases before ~1.19 and for every pre-checksum-era file
  (go1.2.2 -- go1.4.2, see below). That's allowed by the schema
  (`released` isn't in validate.py's required-fields list).
- HEAD requests to `https://dl.google.com/go/<filename>`, capped at 10
  concurrent, used only to (a) backfill `size` for 134 files across 8
  old stable versions (go1.2.2 through go1.4.2) where the JSON index
  reports size 0, and (b) confirm mirrors. No full files were ever
  downloaded.

## Pre-1.2.2 gap

go1, go1.0.1-3, go1.1, go1.1.1-2, and the initial go1.2 predate Go's
move of binary downloads onto the `golang` GCS bucket / dl.google.com
(they were originally hosted on Google Code downloads). Neither the
JSON index nor the HTML page lists them, guessed dl.google.com
filenames for them 404, and anonymous listing of the `golang` GCS
bucket -- both the XML marker-based API and the JSON `storage/v1`
API -- now returns `403 Access Denied` (bucket listing is no longer
public). Recorded as three gap entries (majors 1.0, 1.1, 1.2) at
`os`/`arch` = `"all"` since no specific platform list could be
confirmed for them either. go1.2.2 onward (the vast majority of Go's
history) is fully covered.

## Arch mapping

- JSON arches `arm`, `arm6`, `armv6l` are all the same 32-bit ARM
  build (Go's default GOARM=6): `arm`/`arm6` is what non-Linux OSes
  (freebsd/netbsd/openbsd/plan9/windows) call it, `armv6l` is what
  Linux calls it. All three map to the catalog's `armv6`.
- Go also ships `mips`, `mipsle` and `mips64` (big-endian) binaries for
  Linux -- 80 files each, 240 total -- but the catalog's fixed ARCH
  enum (SCHEMA.md / validate.py) only has room for `mips64le`. Rather
  than invent an enum value or silently drop them, they were excluded
  from releases.json and are called out here: real official Go
  downloads exist at `https://dl.google.com/go/go<version>.linux-mips.tar.gz`
  (and `-mipsle`, `-mips64`) for any version also present in
  releases.json for `linux`/`mips64le`.
- 2 `go1.4-bootstrap-*.tar.gz` files were excluded: they're a
  bootstrap Go toolchain needed to build very old Go from source, not
  a Go release.

## Checksums and dates

go.dev stopped publishing empty sha256/size fields starting with
go1.5.3ish; files at or before go1.5.2 sometimes have empty `sha256`
in the index (174 files across go1.2.2-go1.5.2) -- left `checksum: null`
per schema ("null if the vendor publishes none"), never computed
locally. A `.sha256` companion-file fallback was tried for a few of
these (`<file>.sha256` next to the download) and got 404 in every case
tried, so it isn't used.

## Darwin dual-target packages (osx10.6 / osx10.8)

go1.2.2 through roughly go1.4.x shipped two macOS builds per
version/arch targeting different minimum OS X versions (e.g.
`go1.2.2.darwin-amd64-osx10.6.tar.gz` and `...-osx10.8.tar.gz`). Both
are kept in releases.json with `variant` set to `osx10.6`/`osx10.8`
and `min_os` set from the filename. download_plan.json picks exactly
one per (major, os, arch) -- the smaller of the two by size, which in
every observed case was the `osx10.8` (newer baseline) build.

## Mirrors

Sampled 5 candidate hosts named in the brief against 6 files spanning
go1.2.2 (old) to go1.27.1 (current), across linux and windows, using a
HEAD request that does **not** follow redirects (so a redirect back to
the canonical host can't masquerade as "confirmed" just because it
resolves to the same bytes):

- **Confirmed** (serve the file directly, size matched every sample):
  `mirrors.aliyun.com/golang/<file>`, `mirrors.nju.edu.cn/golang/<file>`.
  Applied to every matching release entry's `mirrors` array per the
  brief's sampling rule -- not re-HEAD'd per file.
- **Rejected**: `golang.google.cn/dl/<file>` and
  `mirrors.ustc.edu.cn/golang/<file>` both 302-redirect straight to
  `dl.google.com` for every sample file (no independent hosting from
  here); `mirrors.huaweicloud.com/go/<file>` 404'd for every sample
  (wrong path or no longer mirrored there).

Full per-file sample results are in `mirrors.json`.

## download_plan.json

272 entries: newest patch per (major, os, arch) for os in
windows/linux/macos, preferring `kind: archive` over `installer`, and
the smallest candidate by size when a major/os/arch has more than one
archive (only the old darwin dual-target case). 24.0 GB total.

## Mirror hunt (2026-09-17)

Extended the confirmed mirror set beyond aliyun/nju using the sample
rule from `MIRROR-HUNT.md`: 10 files (the original 6 plus aix-ppc64,
darwin-arm64, freebsd-riscv64 and an old osx10.6 dual-target build, to
cover more OS/arch/kind before blanket-applying), HEAD'd with
redirects disabled and a browser User-Agent (curl/urllib's default UA
gets 403'd by some of these). Logic lives in `extra_mirrors.py`
(re-runnable, idempotent, caches its HEAD results in
`extra_mirrors_cache.json`) -- **run it again after `scrape.py`**,
since `scrape.py` rebuilds `releases.json`/`mirrors.json` from its own
hardcoded candidate list (aliyun/ustc/huaweicloud/nju) and would
otherwise wipe this addition.

- **Confirmed and added**: `mirrors.hust.edu.cn/golang/<file>`
  (Huazhong University of Science and Technology, Wuhan). Matched
  dl.google.com's Content-Length on all 10 sample files over both
  `https://` and `http://` (checked http on one file,
  go1.27.1.linux-amd64.tar.gz -- also matched). Additionally
  downloaded `go1.5.3.src.tar.gz` (12 MB) from it in full and verified
  its sha256 against the vendor checksum in releases.json; the file
  was deleted afterwards. Applied to all 6,667 `releases.json` entries
  and all `download_plan*.json` entries (272 + 17) -- every entry
  already had aliyun+nju, so this doesn't change ≥1-mirror coverage
  (100% before and after) but adds a third, differently-operated
  source and one that's confirmed to also work over plain `http://`.

- **Rejected (in China, but not real independent mirrors)**:
  `mirrors.bfsu.edu.cn/golang/` and `mirrors.cloud.tencent.com/go/`
  both 404 for every sample file (not mirrored at that path);
  `studygolang.com/dl/golang/` 303-redirects straight to
  `golang.google.cn` -- itself already a known redirector to
  dl.google.com, so this is two hops of redirect, not a copy.

- **Inconclusive, left unconfirmed rather than added without
  evidence**: `mirrors.tuna.tsinghua.edu.cn/golang/` and
  `mirror.sjtu.edu.cn/golang/` both started returning anti-bot/
  rate-limit block pages (TUNA's "your subnet has sent abnormal
  requests"; SJTU's "Cerberus Challenge") partway through or before
  the sample could be read -- this looks like a network-reputation
  block on this environment's egress IP, not evidence the mirrors
  don't exist. Worth re-trying from a different network rather than
  concluding either way.

- **Outside China (priority 1 in the brief)**: none found. Fetched the
  root/site listings directly (several disable directory indexing or
  block scraping outright) for mirror.dotsrc.org, ftp.jaist.ac.jp,
  mirror.yandex.ru, www.mirrorservice.org, ftp.fau.de,
  ftp.halifax.rwth-aachen.de, mirror.aarnet.edu.au, mirrors.kernel.org,
  mirror.init7.net and ftp.gwdg.de, and grepped/guessed for a
  `golang`/`go` entry on each -- none carry one. Consistent with this
  file's earlier note that Go isn't widely mirrored outside China;
  full detail (which URLs were tried) is in `mirrors.json` under
  `outside_china_checked_2026-09-17`.

- **Wayback Machine**: not checked this run. archive.org's own site
  ("Internet Archive services are temporarily offline") was down for
  both the on-site pages and the CDX API (`web.archive.org/cdx/search/cdx`)
  at the time of this hunt, for both
  `go.googlecode.com/files/go1.0*`/`go1.1*` and
  `storage.googleapis.com/golang/go1.1*`. This is a real outage, not a
  negative finding -- worth retrying later for the go1.0/1.1 gap
  entries per `MIRROR-HUNT.md`'s guidance (no gap entries were added
  or changed this run; nothing was invented in their place).

- **Budget**: used 1 of the 5 permitted web searches (a generic query
  for university/ISP Go mirrors outside China; no new leads). No
  runtime file over 60 MB was downloaded; the only full download was
  the 12 MB sha256-verification sample above, deleted afterwards.

Coverage: `releases.json` and every `download_plan*.json` entry
already had ≥1 mirror (aliyun+nju) before this hunt and still does
after -- unchanged at 100%. What changed is redundancy: every entry
now has a third, independently-operated mirror plus one confirmed to
also serve over plain `http://`.
