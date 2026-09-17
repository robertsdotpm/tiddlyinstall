# goenv / gvm / g (2026-09-17)

- **goenv** (`go-nv/goenv`): grepped install scripts for
  `mirror`/`golang.org`/`dl.google` -- no matches. No mirror mechanism.
- **gvm** (`moovweb/gvm`): same grep, same result -- no mirror mechanism.
- **g** (`voidint/g`): documents `G_MIRROR`, with these known-available
  sites listed in its README:
  - `https://golang.google.cn/dl/` (official collector)
  - `https://mirrors.aliyun.com/golang/`
  - `https://mirrors.nju.edu.cn/golang/`
  - `https://mirrors.hust.edu.cn/golang/`
  - `https://mirrors.ustc.edu.cn/golang/`

Every one of these is already accounted for in `catalog/go/mirrors.json`:
aliyun, nju and hust are **confirmed**; `golang.google.cn` and
`mirrors.ustc.edu.cn` were already probed and **rejected** there (both
redirect 302 to `dl.google.com` rather than serving files themselves --
`g`'s README calling `golang.google.cn` a live "collector" site looks
stale, since it's actually just a redirector now). No new host from this
source.

Re-run: `python3 catalog/package-managers/mine_version_managers.py --sources go-managers`
