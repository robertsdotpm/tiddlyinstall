// Command ibsnapshot writes what the offline page (plan.md section 1.11)
// needs from the catalogue: catalog.gz, the catalogue snapshot the page's
// builder loads (catalog.Snapshot), and runtimes.json, what GET
// /api/catalog/runtimes would answer.
//
// It also writes the oracle cases for js/resolve.js (tests/resolve-test.mjs):
// -cases resolves them from the snapshot read back with LoadSnapshot, so
// both sides read the same data; -folder-cases from the catalogue folder
// with no local copies, as a Node server would load it. -from reuses a
// snapshot already written instead of loading the full catalogue.
package main

import (
	"flag"
	"log"
	"os"
	"path/filepath"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
)

func main() {
	home, _ := os.UserHomeDir()
	repo := filepath.Join(home, "projects", "installer-builder")
	catDir := flag.String("catalog", filepath.Join(home, "projects/installer-builder-runtimes/catalog"), "runtime catalogue")
	local := flag.String("local", filepath.Join(home, "projects/installer-builder-runtimes"), "our copies of catalogue files")
	policy := flag.String("policy", filepath.Join(repo, "server/policy.json"), "resolver policy")
	cache := flag.String("cache", filepath.Join(repo, "server/data/sha-cache.json"), "hash cache")
	mirror := flag.String("mirror", "", "URL of our mirror in plans (default: the policy's mirror_base)")
	out := flag.String("o", ".", "output folder")
	from := flag.String("from", "", "use this snapshot instead of loading the catalogue (writes no catalog.gz)")
	cases := flag.String("cases", "", "also write resolver test cases, resolved from the snapshot, to this file")
	folderCases := flag.String("folder-cases", "", "also write test cases resolved from -catalog with no local copies to this file")
	flag.Parse()

	var snap []byte
	var err error
	if *from != "" {
		if snap, err = os.ReadFile(*from); err != nil {
			log.Fatal(err)
		}
	} else {
		cat, err := catalog.Load(*catDir, *policy, *local, *cache)
		if err != nil {
			log.Fatal(err)
		}
		if *mirror != "" {
			cat.Policy.MirrorBase = *mirror
		}
		if snap, err = cat.Snapshot(); err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(*out, "catalog.gz"), snap, 0o644); err != nil {
			log.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(*out, "runtimes.json"), cat.RuntimesSummary(), 0o644); err != nil {
			log.Fatal(err)
		}
		log.Printf("catalog.gz %d KB, runtimes.json written to %s", len(snap)>>10, *out)
	}
	if *cases != "" {
		cat, err := catalog.LoadSnapshot(snap)
		if err != nil {
			log.Fatal(err)
		}
		writeCases(cat, *cases)
	}
	if *folderCases != "" {
		cat, err := catalog.Load(*catDir, *policy, "", "")
		if err != nil {
			log.Fatal(err)
		}
		if *mirror != "" {
			cat.Policy.MirrorBase = *mirror
		}
		writeCases(cat, *folderCases)
	}
}
