package catalog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// LocalIndex finds our own copies of catalogue files (the operator's
// runtime downloads) and hashes them, so files the catalogue has no
// checksum for can still be pinned, and so we can serve them as a mirror.
type LocalIndex struct {
	Root      string
	cachePath string
	mu        sync.Mutex
	byName    map[string][]string // file name -> paths relative to Root
	cache     map[string]cacheEnt // relative path -> hash
	loaded    bool
}

type cacheEnt struct {
	Size   int64  `json:"size"`
	MTime  int64  `json:"mtime"`
	SHA256 string `json:"sha256"`
}

func NewLocalIndex(root, cachePath string) *LocalIndex {
	return &LocalIndex{Root: root, cachePath: cachePath}
}

func (l *LocalIndex) load() {
	if l.loaded {
		return
	}
	l.loaded = true
	l.byName = map[string][]string{}
	l.cache = map[string]cacheEnt{}
	if b, err := os.ReadFile(l.cachePath); err == nil {
		json.Unmarshal(b, &l.cache)
	}
	filepath.WalkDir(l.Root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			if n := d.Name(); n == "catalog" || n == "reference" || strings.HasPrefix(n, ".") {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(l.Root, p)
		l.byName[d.Name()] = append(l.byName[d.Name()], rel)
		return nil
	})
}

// Find returns the relative path of our copy of a file with this name and
// size (size 0 = any), or "".
func (l *LocalIndex) Find(name string, size int64) string {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.load()
	for _, rel := range l.byName[name] {
		if size <= 0 {
			return rel
		}
		if st, err := os.Stat(filepath.Join(l.Root, rel)); err == nil && st.Size() == size {
			return rel
		}
	}
	return ""
}

// SHA256 hashes our copy, remembering the result across restarts.
func (l *LocalIndex) SHA256(rel string) (string, int64, error) {
	p := filepath.Join(l.Root, rel)
	st, err := os.Stat(p)
	if err != nil {
		return "", 0, err
	}
	l.mu.Lock()
	l.load()
	if c, ok := l.cache[rel]; ok && c.Size == st.Size() && c.MTime == st.ModTime().Unix() {
		l.mu.Unlock()
		return c.SHA256, c.Size, nil
	}
	l.mu.Unlock()
	f, err := os.Open(p)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", 0, err
	}
	sum := hex.EncodeToString(h.Sum(nil))
	l.mu.Lock()
	l.cache[rel] = cacheEnt{Size: st.Size(), MTime: st.ModTime().Unix(), SHA256: sum}
	b, _ := json.Marshal(l.cache)
	l.mu.Unlock()
	tmp := l.cachePath + ".tmp"
	if os.WriteFile(tmp, b, 0o644) == nil {
		os.Rename(tmp, l.cachePath)
	}
	return sum, st.Size(), nil
}
