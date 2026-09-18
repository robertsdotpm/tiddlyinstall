// Command ibmissing lists files that plans for one OS family download but
// that have no copy in our mirror (so old machines on plain HTTP can't get them).
package main

import (
	"encoding/json"
	"os"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
)

func main() {
	c, err := catalog.Load(os.Getenv("HOME")+"/projects/installer-builder-runtimes/catalog", "policy.json", os.Getenv("HOME")+"/projects/installer-builder-runtimes", "data/sha-cache.json")
	if err != nil {
		panic(err)
	}
	var out []catalog.FileRef
	for _, id := range c.Policy.RuntimeIDs() {
		_, files, err := c.ResolveFiles(&catalog.App{RecordHash: "x", Runtime: id, Launch: "x", Platforms: []string{os.Args[1]}})
		if err != nil {
			panic(err)
		}
		for _, f := range files {
			if f.Local == "" {
				out = append(out, f)
			}
		}
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
