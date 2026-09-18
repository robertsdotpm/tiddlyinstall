// Command ibsnapshot writes what the offline page (plan.md section 1.11)
// needs from the catalogue: catalog.gz, the catalogue snapshot the page's
// builder loads (catalog.Snapshot), and runtimes.json, what GET
// /api/catalog/runtimes would answer.
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
	flag.Parse()
	cat, err := catalog.Load(*catDir, *policy, *local, *cache)
	if err != nil {
		log.Fatal(err)
	}
	if *mirror != "" {
		cat.Policy.MirrorBase = *mirror
	}
	snap, err := cat.Snapshot()
	if err != nil {
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
