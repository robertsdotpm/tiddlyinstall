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
	// recipe doesn't describe, so they're skipped, unless the runtime's
	// policy says where to get the file (extra_files).
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
	// Variants to leave out on one OS family only, e.g. macOS Ruby builds
	// that link Homebrew libraries by absolute path.
	ExcludeVariantsOn map[string][]string `json:"exclude_variants_on"`
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
	// Files a recipe names as {tmp}/<name> that the catalogue doesn't
	// download (e.g. get-pip.py), keyed by that name. With an entry here
	// such a recipe is usable: the plan downloads the file as an extra
	// `file` (pinned by URL and SHA-256) and copies it into {tmp} before
	// the recipe step that needs it.
	ExtraFiles map[string]*ExtraFile `json:"extra_files"`
	// How to install a project from this runtime's package registry
	// (record source `package`). Nil: package sources are refused.
	Package *PackagePolicy `json:"package"`
}

// ExtraFile is one {tmp} file a recipe needs, per runtime version.
type ExtraFile struct {
	// "install": a recipe needing this file is only used for apps that
	// install a project or package (it's how the runtime gets its package
	// manager), and is then preferred over an equally specific recipe
	// that doesn't need it. "" : always usable.
	For     string        `json:"for"`
	Sources []ExtraSource `json:"sources"`
}

type ExtraSource struct {
	Versions string   `json:"versions"` // runtime version range this copy is for
	URLs     []string `json:"urls"`     // tried in order; the first should be immutable
	SHA256   string   `json:"sha256"`
	Size     int64    `json:"size"`
}

// source finds the copy of an extra file for a runtime version.
func (f *ExtraFile) source(v Version) *ExtraSource {
	for i := range f.Sources {
		if Matches(v, f.Sources[i].Versions) {
			return &f.Sources[i]
		}
	}
	return nil
}

// PackagePolicy says how a runtime installs a package by name
// (design.md 1.7, "Packages"). Commands use the plan tokens plus
// {package} (Spec or SpecAny, filled in by the server).
type PackagePolicy struct {
	Registry string `json:"registry"` // display name, e.g. "PyPI"
	// Package names allowed (a Go regexp). Names go into shell commands,
	// so this must never allow quotes, spaces or shell metacharacters.
	Name string `json:"name"`
	// {package} with and without a pinned version; {name} and {version}.
	Spec    string `json:"spec"`
	SpecAny string `json:"spec_any"`
	// Registry metadata, fetched by the server when a record is made or a
	// plain-name plan is resolved (never by the installer). Lookup is the
	// newest release's JSON ({name}); LookupVersion one release's
	// ({name}, {version}). VersionField and BinField are dotted paths into
	// that JSON. BinField may name a string, a list of names, or a map of
	// name to path (npm's "bin").
	Lookup        string `json:"lookup"`
	LookupVersion string `json:"lookup_version"`
	VersionField  string `json:"version_field"`
	BinField      string `json:"bin_field"`
	// Install command per OS family.
	Install map[string]string `json:"install"`
	// Environment per OS family, merged over the recipe's: Env over the
	// launch environment (and so install's too), IEnv over the project
	// install environment. A null value unsets the variable.
	Env  map[string]map[string]*string `json:"env"`
	IEnv map[string]map[string]*string `json:"ienv"`
	// Default launch command. Besides the plan tokens: {bin} (the
	// package's program name from BinField, else the project name),
	// {bin_path} (its path inside the package), {module} (the name with
	// - and . as _). The server expands these three.
	Launch string `json:"launch"`
	// "last": the project name is the last path element of the package
	// name (Go module paths), skipping a /vN major-version suffix.
	ProjectFrom string `json:"project_from"`
	// Lowercase names before use (registries that ignore case).
	Lower bool `json:"lower"`
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
