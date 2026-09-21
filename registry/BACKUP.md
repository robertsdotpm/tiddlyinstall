# Runtime catalog backup

Metadata copy of `~/projects/installer-builder-runtimes/catalog/` (the working
copy lives there, next to ~108 GB of downloaded runtimes, which are not in git).
Start with `README.md` here.

- `store/` holds the runtimes store's own manifest, mirror list and README
  (the operator-tested Windows Python builds are described in
  `store/TESTED-WINDOWS.md`).
- Excluded as regenerable: request caches (`*cache*.json`), Rust's raw channel
  manifests (`rust/.cache/`), run logs, lock and queue files.

Refresh from the working copy:

```sh
rsync -a --delete \
  --exclude '.cache/' --exclude '*cache*.json' --exclude '*.log' --exclude '*.tmp' --exclude '*.part' \
  --exclude '*.pid' --exclude '*.dbg' --exclude '.write.lock' --exclude '.busy' --exclude 'pending_updates/' --exclude '__pycache__/' \
  --exclude 'store/' --exclude 'BACKUP.md' \
  ~/projects/installer-builder-runtimes/catalog/ registry/
cp ~/projects/installer-builder-runtimes/{manifest.json,mirrors.json,README.md,TESTED-WINDOWS.md} registry/store/
```

Added 2026-09-18:

- `store/sha256-local.json`: SHA-256 and size of our local copy of every
  file the catalogue has no published checksum for (278 files, 58.6 GB
  hashed). These are the only pins for those files; plans use them.
- `store/mirror-manifest.json`: every file in the runtimes store with its
  download URLs and SHA-256 (published, or `sha256_local` from above).
  `tools/mirror_fetch.py` uses it to fill a mirror from vendor URLs (ovh1).
- `store/mirror-nourl.json`: files with no public URL, copied by rsync.
