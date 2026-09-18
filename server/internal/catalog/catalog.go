// Package catalog loads the runtime catalogue (installer-builder-runtimes)
// and resolves plans (docs/format.md section 3) from it. Every runtime is
// handled by the same code: the catalogue's match fields and the policy
// file are the rules, so there is no per-runtime branching here.
package catalog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Release is one downloadable file from <runtime>/releases.json.
type Release struct {
	Runtime  string          `json:"runtime"`
	Major    string          `json:"major"`
	Version  string          `json:"version"`
	OS       string          `json:"os"`
	Arch     string          `json:"arch"`
	Kind     string          `json:"kind"`
	Format   string          `json:"format"`
	Variant  *string         `json:"variant"`
	Libc     *string         `json:"libc"`
	URL      string          `json:"url"`
	Mirrors  []string        `json:"mirrors"`
	Checksum json.RawMessage `json:"checksum"`
	Size     int64           `json:"size"`
	MinOS    json.RawMessage `json:"min_os"`

	Folder string  `json:"-"` // catalogue folder (cc holds llvm, gcc, ...)
	V      Version `json:"-"`
	SHA256 string  `json:"-"`
	Local  string  `json:"-"` // path of our copy, if downloaded
}

func (r *Release) VariantStr() string {
	if r.Variant == nil {
		return ""
	}
	return *r.Variant
}

func (r *Release) FileName() string {
	u := r.URL
	if i := strings.LastIndex(u, "/"); i >= 0 {
		u = u[i+1:]
	}
	u = strings.ReplaceAll(u, "%2B", "+")
	if i := strings.IndexAny(u, "?#"); i >= 0 {
		u = u[:i]
	}
	return u
}

// Step is one install step from install.json.
type Step map[string]any

// Recipe is one entry of <runtime>/install.json "recipes".
type Recipe struct {
	Match          map[string]any `json:"match"`
	Method         string         `json:"method"`
	Steps          []Step         `json:"steps"`
	Executable     string         `json:"executable"`
	Isolation      string         `json:"isolation"`
	Launch         *LaunchSpec    `json:"launch"`
	ProjectInstall *InstallSpec   `json:"project_install"`
	Prerequisites  []string       `json:"prerequisites"`
	index          int
}

type LaunchSpec struct {
	Program     *string            `json:"program"`
	Args        []string           `json:"args"`
	Env         map[string]*string `json:"env"`
	PathPrepend []string           `json:"path_prepend"`
}

type InstallSpec struct {
	Command     string             `json:"command"`
	Env         map[string]*string `json:"env"`
	PathPrepend []string           `json:"path_prepend"`
}

// SupportRule is one rule of <runtime>/os_support.json.
type SupportRule struct {
	Versions  string          `json:"versions"`
	OS        string          `json:"os"`
	Arch      json.RawMessage `json:"arch"`
	MinOS     *string         `json:"min_os"`
	MinBuild  json.RawMessage `json:"min_build"`
	MaxOS     *string         `json:"max_os"`
	Variant   json.RawMessage `json:"variant"`
	Format    json.RawMessage `json:"format"`
	Kind      json.RawMessage `json:"kind"`
	FileMatch string          `json:"file_match"`
	Match     map[string]any  `json:"match"`
	PlanFloor *bool           `json:"plan_floor"`
}

// Runtime holds everything the catalogue knows about one runtime.
type Runtime struct {
	ID       string
	Releases []*Release
	Recipes  []*Recipe
	Rules    []SupportRule
}

type Catalog struct {
	Dir      string
	Runtimes map[string]*Runtime
	Policy   *Policy
	OS       *OSScale
	compMin  []compRange
	local    *LocalIndex
}

// Load reads the catalogue folder, the policy file and our local copies.
func Load(dir, policyPath, localRoot, cachePath string) (*Catalog, error) {
	c := &Catalog{Dir: dir, Runtimes: map[string]*Runtime{}}
	var err error
	if c.Policy, err = LoadPolicy(policyPath); err != nil {
		return nil, err
	}
	if c.OS, err = LoadOSScale(filepath.Join(dir, "os_versions.json")); err != nil {
		return nil, err
	}
	if c.compMin, err = loadCompilerMin(filepath.Join(dir, "compilers_min_os.json")); err != nil {
		return nil, err
	}
	if localRoot != "" {
		c.local = NewLocalIndex(localRoot, cachePath)
	}
	for _, id := range c.Policy.RuntimeIDs() {
		rt := &Runtime{ID: id}
		folder := c.Policy.Runtimes[id].Folder
		if folder == "" {
			folder = id
		}
		if err := readJSON(filepath.Join(dir, folder, "releases.json"), &rt.Releases); err != nil {
			return nil, err
		}
		var inst struct {
			Recipes []*Recipe `json:"recipes"`
		}
		if err := readJSON(filepath.Join(dir, folder, "install.json"), &inst); err != nil {
			return nil, err
		}
		for i, r := range inst.Recipes {
			r.index = i
		}
		rt.Recipes = inst.Recipes
		var sup struct {
			Rules []SupportRule `json:"rules"`
		}
		if p := filepath.Join(dir, folder, "os_support.json"); fileExists(p) {
			if err := readJSON(p, &sup); err != nil {
				return nil, err
			}
			rt.Rules = sup.Rules
		}
		for _, r := range rt.Releases {
			r.Folder = folder
			r.V = ParseVersion(r.Version)
			r.SHA256 = checksumSHA256(r.Checksum)
		}
		c.Runtimes[id] = rt
	}
	return c, nil
}

func readJSON(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, v); err != nil {
		return fmt.Errorf("%s: %w", path, err)
	}
	return nil
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// checksumSHA256 pulls a sha256 out of the catalogue's checksum field, which
// is either {"algo","value"} or a list of them.
func checksumSHA256(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	type ck struct {
		Algo  string `json:"algo"`
		Value string `json:"value"`
	}
	var one ck
	if json.Unmarshal(raw, &one) == nil && strings.EqualFold(one.Algo, "sha256") {
		return strings.ToLower(one.Value)
	}
	var many []ck
	if json.Unmarshal(raw, &many) == nil {
		for _, c := range many {
			if strings.EqualFold(c.Algo, "sha256") {
				return strings.ToLower(c.Value)
			}
		}
	}
	return ""
}

// strList reads a JSON value that may be a string, a list of strings, null or absent.
func strList(raw json.RawMessage) []string {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return []string{s}
	}
	var l []*string
	if json.Unmarshal(raw, &l) == nil {
		var out []string
		for _, x := range l {
			if x == nil {
				out = append(out, "\x00null")
			} else {
				out = append(out, *x)
			}
		}
		return out
	}
	return nil
}

func anyList(v any) []string {
	switch t := v.(type) {
	case nil:
		return nil
	case string:
		return []string{t}
	case []any:
		var out []string
		for _, x := range t {
			if x == nil {
				out = append(out, "\x00null")
			} else {
				out = append(out, fmt.Sprint(x))
			}
		}
		return out
	}
	return nil
}

// OSID is one OS version on a family's scale.
type OSID struct {
	Family string
	ID     string
	Int    int // format.md section 3: major*100+minor
	Build  int // Windows build this id starts at (11 = 22000)
	Arches []string
	Label  string
}

// OSScale lists the OS versions plans are resolved for, newest first.
type OSScale struct {
	ByFamily map[string][]OSID
	byID     map[string]OSID // "windows/7"
}

func verInt(s string) int {
	p := strings.Split(s, ".")
	a, _ := strconv.Atoi(p[0])
	b := 0
	if len(p) > 1 {
		b, _ = strconv.Atoi(p[1])
	}
	return a*100 + b
}

func LoadOSScale(path string) (*OSScale, error) {
	var raw struct {
		Windows []struct {
			ID string `json:"id"`
			NT string `json:"nt"`
		} `json:"windows"`
		MacOS []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"macos"`
		Linux []struct {
			ID      string   `json:"id"`
			Distros []string `json:"distros"`
		} `json:"linux_glibc"`
		Musl []struct {
			ID      string   `json:"id"`
			Distros []string `json:"distros"`
		} `json:"linux_musl"`
	}
	if err := readJSON(path, &raw); err != nil {
		return nil, err
	}
	s := &OSScale{ByFamily: map[string][]OSID{}, byID: map[string]OSID{}}
	// Client Windows versions only; server editions share their NT numbers.
	winLabel := map[string]string{"xp": "Windows XP", "xp-x64": "Windows XP x64", "vista": "Windows Vista", "7": "Windows 7",
		"8": "Windows 8", "8.1": "Windows 8.1", "10": "Windows 10", "11": "Windows 11", "2000": "Windows 2000"}
	for _, w := range raw.Windows {
		o := OSID{Family: "windows", ID: w.ID, Label: winLabel[w.ID]}
		nt := strings.Split(w.NT, ".")
		o.Int = verInt(nt[0] + "." + nt[1])
		if len(nt) > 2 {
			o.Build, _ = strconv.Atoi(nt[2])
		}
		switch w.ID {
		case "xp", "2000":
			o.Arches = []string{"x86"}
		case "xp-x64":
			o.Arches = []string{"amd64"}
		case "10", "11":
			o.Arches = []string{"amd64", "x86", "arm64"}
		default:
			o.Arches = []string{"amd64", "x86"}
		}
		s.byID["windows/"+w.ID] = o
		if o.Label != "" && w.ID != "2000" {
			s.ByFamily["windows"] = append(s.ByFamily["windows"], o)
		}
	}
	for _, m := range raw.MacOS {
		o := OSID{Family: "macos", ID: m.ID, Int: verInt(m.ID), Label: "macOS " + m.ID + " " + m.Name, Arches: []string{"amd64"}}
		if o.Int >= 1100 {
			o.Arches = []string{"arm64", "amd64"}
		}
		s.byID["macos/"+m.ID] = o
		if o.Int >= 1006 {
			s.ByFamily["macos"] = append(s.ByFamily["macos"], o)
		}
	}
	for _, l := range raw.Linux {
		o := OSID{Family: "linux", ID: l.ID, Int: verInt(strings.TrimPrefix(l.ID, "glibc-")),
			Label: "Linux, " + l.ID + " (" + strings.Join(l.Distros, ", ") + ")", Arches: []string{"amd64"}}
		if o.Int >= 217 {
			o.Arches = []string{"amd64", "arm64"}
		}
		s.byID["linux/"+l.ID] = o
		s.ByFamily["linux"] = append(s.ByFamily["linux"], o)
	}
	// musl systems (Alpine) report glibc 0 (format.md section 3), so they
	// sit below every glibc version; only rules written for musl apply.
	for _, m := range raw.Musl {
		o := OSID{Family: "linux", ID: m.ID, Int: 0, Label: "Linux, musl (" + strings.Join(m.Distros, ", ") + ")", Arches: []string{"amd64", "arm64"}}
		s.byID["linux/"+m.ID] = o
		s.ByFamily["linux"] = append(s.ByFamily["linux"], o)
	}
	for f := range s.ByFamily {
		l := s.ByFamily[f]
		sort.SliceStable(l, func(i, j int) bool {
			if l[i].Int != l[j].Int {
				return l[i].Int > l[j].Int
			}
			return l[i].Build > l[j].Build
		})
	}
	return s, nil
}

// Lookup finds an OS id ("7", "10.13", "glibc-2.17") on a family's scale.
func (s *OSScale) Lookup(family, id string) (OSID, bool) {
	o, ok := s.byID[family+"/"+id]
	return o, ok
}
