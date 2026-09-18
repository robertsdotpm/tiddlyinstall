package catalog

import (
	"encoding/json"
	"strings"

	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

// RuntimesSummary is GET /api/catalog/runtimes (docs/api.md): each
// runtime's label and launch default, and what its newest plan installs
// on each OS it covers.
func (c *Catalog) RuntimesSummary() []byte {
	type row struct {
		Family  string  `json:"family"`
		Arch    string  `json:"arch"`
		Covers  string  `json:"covers"`
		Version *string `json:"version"`
		File    *string `json:"file"`
	}
	type rt struct {
		ID       string `json:"id"`
		Label    string `json:"label"`
		Compiled bool   `json:"compiled"`
		Launch   string `json:"launch"`
		Newest   []row  `json:"newest"`
	}
	var out []rt
	for _, id := range c.Policy.RuntimeIDs() {
		pol := c.Policy.Runtimes[id]
		plan, err := c.Resolve(&App{RecordHash: "preview", Runtime: id, Launch: pol.Launch})
		if err != nil {
			continue
		}
		e := rt{ID: id, Label: pol.Label, Compiled: pol.Compiled, Launch: pol.Launch}
		var cur *row
		for _, l := range ibtext.Parse(plan) {
			switch l.Key {
			case "when":
				if cur != nil {
					e.Newest = append(e.Newest, *cur)
				}
				cur = &row{Family: l.Val(0), Arch: strings.Fields(l.Val(3))[0]}
			case "covers":
				if cur != nil {
					cur.Covers = l.Val(0)
				}
			case "runtime":
				if cur != nil {
					v := l.Val(1)
					cur.Version = &v
				}
			case "file":
				if cur != nil && cur.File == nil {
					f := l.Val(1)
					cur.File = &f
				}
			}
		}
		if cur != nil {
			e.Newest = append(e.Newest, *cur)
		}
		out = append(out, e)
	}
	b, _ := json.Marshal(map[string]any{"runtimes": out})
	return b
}
