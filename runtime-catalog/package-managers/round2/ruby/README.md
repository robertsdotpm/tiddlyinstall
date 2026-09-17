# Ruby mirror hunt, round 2 (2026-09-17)

Targeted round 1's stated gap: RubyInstaller (both generations) and
ruby/ruby-builder binaries, essentially unmirrored outside one narrow NJU
exception. Full narrative (every lead tried, what was rejected and why) is
in `catalog/ruby/NOTES.md`'s "Mirror hunt round 2" section and
`catalog/ruby/mirrors.json`'s `round2_rejected` / `round2_no_mirror_found` /
`round2_checksum_corroboration` keys.

**Result**: no new `mirrors` entries (every RubyInstaller/ruby-builder lead
was dead, out of scope, or blocked by a bot-check this environment can't
solve -- see NOTES.md). One useful side finding: Chocolatey's
`ruby.install` package bundles the exact upstream RubyInstaller2 `.exe`
inside its `.nupkg` rather than downloading it, which isn't usable as a
`mirrors` URL (the URL serves a zip, not the file) but is a legitimate
`checksum_corroboration` source.

`mine_chocolatey.py` -- mines `ruby.install` nupkgs for that corroboration.
Re-runnable and idempotent (dedup happens in `add_mirrors.py`).

```
python3 mine_chocolatey.py                       # dry run, curated 10-version sample
python3 mine_chocolatey.py --apply                # sample + write via add_mirrors.py
python3 mine_chocolatey.py --all --apply          # mine every published version (~39, ~1.5GB)
python3 mine_chocolatey.py --versions 3.2.3.1,3.3.0.1 --apply   # specific versions
```

Already applied: 20 corroborations from 10 versions (2.2.6 through
3.4.4.1), 0 mismatches, 14 on entries that had no vendor checksum before.
~29 published `ruby.install` versions remain unmined if more coverage is
wanted later.
