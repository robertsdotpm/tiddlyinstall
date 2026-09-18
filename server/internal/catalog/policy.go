package catalog

import (
	"encoding/json"
	"os"
	"sort"
)

// Policy is the resolver's data: preferences the catalogue doesn't record,
// such as which variant of a runtime to install for an app. It's a JSON
// file (server/policy.json), so changing a preference never means changing
// code.
type Policy struct {
	// URL prefix of our own copy of catalogue files (plain HTTP, and by IP
	// address where possible: design.md 1.3). Tried first when MirrorFirst.
	MirrorBase  string `json:"mirror_base"`
	MirrorFirst bool   `json:"mirror_first"`
	// Recipes whose steps use one of these {tmp} files need a download the
	// recipe doesn't describe, so they're skipped.
	ExternalTmpFiles []string `json:"external_tmp_files"`
	// Preferred install methods, best first.
	MethodOrder []string                  `json:"method_order"`
	Runtimes    map[string]*RuntimePolicy `json:"runtimes"`
	// Versions with no OS support data are assumed to run only on these
	// OS versions and newer.
	UnknownFloor map[string]int `json:"unknown_floor"`
}

type RuntimePolicy struct {
	Folder string `json:"folder"` // catalogue folder, if not the runtime id
	Label  string `json:"label"`
	// Variants in order of preference; "" means no variant. Variants not
	// listed are allowed after the listed ones unless Only is set.
	Variants        []string            `json:"variants"`
	Only            bool                `json:"only"`
	ExcludeVariants []string            `json:"exclude_variants"`
	Formats         map[string][]string `json:"formats"` // per OS family, best first
	Kinds           []string            `json:"kinds"`
	Compiled        bool                `json:"compiled"`
	// Source files that mean the project must be installed with the
	// runtime's package manager (otherwise the source just runs).
	InstallFiles []string `json:"install_files"`
	// Replacement project install commands per OS family, when the
	// catalogue's default doesn't suit a simple project.
	InstallCommand map[string]string `json:"install_command"`
	// Per-OS version choices for select=asyncio (design.md 1.2).
	Asyncio map[string]string `json:"asyncio"`
	// compilers_min_os.json toolchain name for each variant (cc only).
	Toolchains map[string]string `json:"toolchains"`
	// Other catalogue runtimes this one needs, per OS family: installed
	// alongside as extra plan files, with their bin folder on PATH (e.g.
	// Nim on Windows needs a C compiler).
	Requires map[string][]Requirement `json:"requires"`
	// Launch default per the form (design.md section 4).
	Launch string `json:"launch"`
}

type Requirement struct {
	Runtime string `json:"runtime"`
	Bin     string `json:"bin"` // folder inside it to put on PATH, e.g. "bin"
}

func LoadPolicy(path string) (*Policy, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	p := &Policy{}
	if err := json.Unmarshal(b, p); err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Policy) RuntimeIDs() []string {
	var ids []string
	for id := range p.Runtimes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

func indexOf(l []string, s string) int {
	for i, x := range l {
		if x == s {
			return i
		}
	}
	return -1
}
