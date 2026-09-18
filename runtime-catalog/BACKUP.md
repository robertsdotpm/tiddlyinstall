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
  ~/projects/installer-builder-runtimes/catalog/ runtime-catalog/
cp ~/projects/installer-builder-runtimes/{manifest.json,mirrors.json,README.md,TESTED-WINDOWS.md} runtime-catalog/store/
```
