package catalog

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// A snapshot must resolve exactly as the catalogue it came from, for
// every runtime and every way of choosing a version.
func TestSnapshotResolvesTheSame(t *testing.T) {
	home, _ := os.UserHomeDir()
	root := filepath.Join(home, "projects", "installer-builder-runtimes")
	if _, err := os.Stat(filepath.Join(root, "catalog")); err != nil {
		t.Skip("no catalogue:", err)
	}
	_, me, _, _ := runtime.Caller(0)
	server := filepath.Join(filepath.Dir(me), "..", "..")
	full, err := Load(filepath.Join(root, "catalog"), filepath.Join(server, "policy.json"), root, filepath.Join(server, "data", "sha-cache.json"))
	if err != nil {
		t.Fatal(err)
	}
	full.Policy.MirrorBase = "http://mirror.example/mirror"
	snap, err := full.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("snapshot: %d KB gzipped", len(snap)>>10)
	small, err := LoadSnapshot(snap)
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range full.Policy.RuntimeIDs() {
		pol := full.Policy.Runtimes[id]
		apps := []*App{
			{Select: "newest"},
			{Select: "asyncio"},
			{Select: "newest", Install: "default"},
			{Select: "range", Range: ">=1,<3.9"},
			{Select: "range", Range: "<1"},
		}
		for _, a := range apps {
			a.RecordHash, a.Name, a.Project, a.Runtime, a.Launch = "testtesttesttesttesttestte", "Hello", "hello", id, pol.Launch
			a.Console, a.Menu = true, true
			a.Platforms = []string{"windows", "macos", "linux"}
			b := *a
			want, errW := full.Resolve(a)
			got, errG := small.Resolve(&b)
			if (errW == nil) != (errG == nil) || want != got {
				t.Errorf("%s %s %s: plans differ (errors %v / %v)", id, a.Select, a.Range, errW, errG)
			}
		}
	}
}
