package catalog

import (
	"encoding/json"
	"errors"
	"io/fs"
	"regexp"
	"strings"
)

// Which OS versions a release runs on. Three sources, most specific first:
// the runtime's os_support.json rules, compilers_min_os.json ranges, then
// the policy's floor for releases nothing describes.

type compRange struct {
	Compiler string
	Versions string
	OS       string
	Arch     []string
	Min      json.RawMessage
	Variants []string // cc toolchains only
}

func loadCompilerMin(fsys fs.FS, name string) ([]compRange, error) {
	var raw struct {
		Compilers []struct {
			Compiler string `json:"compiler"`
			Ranges   []struct {
				Versions string          `json:"versions"`
				OS       string          `json:"os"`
				Arch     json.RawMessage `json:"arch"`
				Min      json.RawMessage `json:"min"`
			} `json:"ranges"`
			Toolchains map[string][]struct {
				Versions string          `json:"versions"`
				OS       string          `json:"os"`
				Arch     json.RawMessage `json:"arch"`
				Min      json.RawMessage `json:"min"`
			} `json:"toolchains"`
		} `json:"compilers"`
	}
	if err := readJSON(fsys, name, &raw); errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, err
	}
	var out []compRange
	for _, c := range raw.Compilers {
		for _, r := range c.Ranges {
			out = append(out, compRange{Compiler: c.Compiler, Versions: r.Versions, OS: r.OS, Arch: strList(r.Arch), Min: r.Min})
		}
		for tc, rs := range c.Toolchains {
			for _, r := range rs {
				out = append(out, compRange{Compiler: c.Compiler + ":" + tc, Versions: r.Versions, OS: r.OS, Arch: strList(r.Arch), Min: r.Min})
			}
		}
	}
	return out, nil
}

// minInt turns a compilers_min_os "min" into an integer on the family's
// scale (0 = no requirement found, -1 = unusable).
func minInt(family, arch string, raw json.RawMessage) int {
	if len(raw) == 0 || string(raw) == "null" {
		return 0
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return verInt(s)
	}
	var m map[string]*string
	if json.Unmarshal(raw, &m) == nil {
		if family == "linux" {
			if g := m["glibc"]; g != nil {
				return verInt(*g)
			}
			return 0
		}
		if v := m[arch]; v != nil {
			return verInt(*v)
		}
	}
	return 0
}

func contains(l []string, s string) bool { return indexOf(l, s) >= 0 }

// variantOK: a rule's variant list matches the release's variant ("\x00null"
// stands for a JSON null, i.e. no variant). Entries may end in * as a glob.
func variantOK(list []string, v *string) bool {
	if len(list) == 0 {
		return true
	}
	for _, x := range list {
		if x == "\x00null" {
			if v == nil {
				return true
			}
			continue
		}
		if v == nil {
			continue
		}
		if x == *v || strings.HasSuffix(x, "*") && strings.HasPrefix(*v, strings.TrimSuffix(x, "*")) {
			return true
		}
	}
	return false
}

func (r *SupportRule) applies(e *Release) bool {
	if r.OS != e.OS {
		return false
	}
	if a := strList(r.Arch); len(a) > 0 && !contains(a, e.Arch) {
		return false
	}
	variants := strList(r.Variant)
	formats := strList(r.Format)
	kinds := strList(r.Kind)
	fileMatch := r.FileMatch
	if r.Match != nil {
		if variants == nil {
			variants = anyList(r.Match["variant"])
		}
		if formats == nil {
			formats = anyList(r.Match["format"])
		}
		if kinds == nil {
			kinds = anyList(r.Match["kind"])
		}
		if fileMatch == "" {
			if s, ok := r.Match["file_match"].(string); ok {
				fileMatch = s
			}
		}
	}
	if !variantOK(variants, e.Variant) {
		return false
	}
	if len(formats) > 0 && !contains(formats, e.Format) {
		return false
	}
	if fileMatch != "" {
		re, err := regexp.Compile(fileMatch)
		if err != nil || !re.MatchString(e.FileName()) {
			return false
		}
	}
	if len(kinds) > 0 && !contains(kinds, e.Kind) {
		return false
	}
	if len(kinds) == 0 && e.Kind == "source" {
		return false
	}
	return Matches(e.V, r.Versions)
}

// runsOn reports whether release e runs on OS o, and the minimum Windows
// build it needs there (0 for none). known is false when no data covers e.
func (c *Catalog) runsOn(rt *Runtime, e *Release, o OSID) (ok bool, minBuild int, known bool) {
	// 1. os_support.json: every applying rule on this OS scale must allow it.
	var hits []SupportRule
	for _, r := range rt.Rules {
		if r.MinOS == nil || !r.applies(e) {
			continue
		}
		if _, onScale := c.OS.Lookup(o.Family, *r.MinOS); !onScale {
			continue
		}
		if (*r.MinOS == "musl") != (o.ID == "musl") {
			continue // musl and glibc rules each speak only for their own libc
		}
		hits = append(hits, r)
	}
	if len(hits) > 0 {
		for _, r := range hits {
			if r.PlanFloor != nil && !*r.PlanFloor {
				continue
			}
			lo, _ := c.OS.Lookup(o.Family, *r.MinOS)
			if o.Int < lo.Int || o.Int == lo.Int && o.Build < lo.Build {
				return false, 0, true
			}
			if r.MaxOS != nil {
				if hi, ok := c.OS.Lookup(o.Family, *r.MaxOS); ok && (o.Int > hi.Int || o.Int == hi.Int && o.Build > hi.Build) {
					return false, 0, true
				}
			}
			// A Windows build number; other shapes (e.g. a macOS point
			// release) aren't on the OS scale and are ignored.
			var mb int
			if json.Unmarshal(r.MinBuild, &mb) == nil && o.Family == "windows" && mb > minBuild {
				minBuild = mb
			}
		}
		return true, minBuild, true
	}
	// 2. compilers_min_os.json.
	pol := c.Policy.Runtimes[rt.ID]
	name := rt.ID
	if pol != nil && pol.Toolchains != nil {
		if tc, ok := pol.Toolchains[e.VariantStr()]; ok {
			name = rt.ID + ":" + tc
		}
	}
	for _, r := range c.compMin {
		if r.Compiler != name || r.OS != e.OS || !Matches(e.V, r.Versions) {
			continue
		}
		if len(r.Arch) > 0 && !contains(r.Arch, e.Arch) {
			continue
		}
		m := minInt(o.Family, e.Arch, r.Min)
		if m == 0 {
			break // listed, but no requirement recorded: fall through to the floor
		}
		return o.Int >= m, 0, true
	}
	// 3. Unknown: assume only recent systems (never musl: glibc builds
	// don't run there).
	if o.ID == "musl" {
		return false, 0, false
	}
	return o.Int >= c.Policy.UnknownFloor[o.Family], 0, false
}
