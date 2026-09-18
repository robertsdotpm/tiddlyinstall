package catalog

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"testing/fstest"
)

// Snapshot is the catalogue as one gzipped file, for the offline page
// (plan.md section 1.11): the policy as this server uses it (mirror
// settings included), the OS scale, each folder's recipes and support
// rules, and only the releases the resolver can pick, each with its
// SHA-256 and our copy's path already filled in. LoadSnapshot reads it
// back into a Catalog that resolves as this one does, with no files on
// disk and no local index.
func (c *Catalog) Snapshot() ([]byte, error) {
	if c.Dir == "" {
		return nil, errors.New("snapshot: not loaded from a folder")
	}
	fsys := os.DirFS(c.Dir)
	files := map[string]json.RawMessage{}
	pol, err := json.Marshal(c.Policy)
	if err != nil {
		return nil, err
	}
	files["policy.json"] = pol
	copyFile := func(name string, optional bool) error {
		b, err := fs.ReadFile(fsys, name)
		if optional && errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		var v any // compact it, and check it is JSON
		if err := json.Unmarshal(b, &v); err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		files[name], _ = json.Marshal(v)
		return nil
	}
	if err := copyFile("os_versions.json", false); err != nil {
		return nil, err
	}
	if err := copyFile("compilers_min_os.json", true); err != nil {
		return nil, err
	}
	// Folders can be shared (python and python2), each runtime keeping its
	// own versions: the snapshot's releases are the union.
	kept := map[string][]*Release{}
	seen := map[*Release]bool{}
	for _, id := range c.Policy.RuntimeIDs() {
		rt, pol := c.Runtimes[id], c.Policy.Runtimes[id]
		folder := pol.Folder
		if folder == "" {
			folder = id
		}
		if _, ok := files[path.Join(folder, "install.json")]; !ok {
			if err := copyFile(path.Join(folder, "install.json"), false); err != nil {
				return nil, err
			}
			if err := copyFile(path.Join(folder, "os_support.json"), true); err != nil {
				return nil, err
			}
			kept[folder] = []*Release{}
		}
		for _, e := range rt.Releases {
			if seen[e] || !usable(pol, e) {
				continue
			}
			seen[e] = true
			c.sha(e)
			cp := *e
			cp.Checksum, cp.Runtime, cp.Major = nil, "", "" // the SHA-256 is enough
			kept[folder] = append(kept[folder], &cp)
		}
	}
	for folder, rels := range kept {
		b, err := json.Marshal(rels)
		if err != nil {
			return nil, err
		}
		files[path.Join(folder, "releases.json")] = b
	}
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err := json.NewEncoder(gz).Encode(map[string]any{"ib-catalog-snapshot": 1, "files": files}); err != nil {
		return nil, err
	}
	if err := gz.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// LoadSnapshot reads what Snapshot wrote (gzipped or not).
func LoadSnapshot(data []byte) (*Catalog, error) {
	var r io.Reader = bytes.NewReader(data)
	if bytes.HasPrefix(data, []byte{0x1f, 0x8b}) {
		gz, err := gzip.NewReader(r)
		if err != nil {
			return nil, err
		}
		r = gz
	}
	var snap struct {
		Version int                        `json:"ib-catalog-snapshot"`
		Files   map[string]json.RawMessage `json:"files"`
	}
	if err := json.NewDecoder(r).Decode(&snap); err != nil {
		return nil, fmt.Errorf("catalogue snapshot: %w", err)
	}
	if snap.Version != 1 {
		return nil, fmt.Errorf("catalogue snapshot version %d", snap.Version)
	}
	m := fstest.MapFS{}
	for name, b := range snap.Files {
		m[name] = &fstest.MapFile{Data: b}
	}
	pol, err := ParsePolicy(snap.Files["policy.json"], "snapshot policy.json")
	if err != nil {
		return nil, err
	}
	return load(m, pol)
}
