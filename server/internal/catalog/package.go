package catalog

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Package names and versions are pasted into install commands run by
// `cmd /c` and `sh -c` on the user's machine, so whatever a runtime's
// policy allows, they must also fit these: no quotes, spaces, `%`, `$`,
// backticks, `;`, `&`, `|`, `<`, `>` or backslashes.
var (
	pkgNameFloor = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9@/._~-]{0,199}$`)
	pkgVersionRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.*+!_-]{0,63}$`)
	defaultName  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
)

// PackagePolicyFor returns the runtime's package policy, or an error
// saying package sources aren't supported for it.
func (c *Catalog) PackagePolicyFor(runtime string) (*PackagePolicy, error) {
	pol := c.Policy.Runtimes[runtime]
	if pol == nil {
		return nil, fmt.Errorf("unknown runtime %q", runtime)
	}
	if pol.Package == nil {
		return nil, fmt.Errorf("%s has no package registry in Installer Builder yet; use a GitHub repo, a URL or code written here", label(pol, runtime))
	}
	return pol.Package, nil
}

// ValidPackage checks a package name and optional version for a runtime,
// and returns the name as it should be stored (lowercased for registries
// that ignore case).
func (c *Catalog) ValidPackage(runtime, name, version string) (string, error) {
	p, err := c.PackagePolicyFor(runtime)
	if err != nil {
		return "", err
	}
	if p.Lower {
		name = strings.ToLower(name)
	}
	re := defaultName
	if p.Name != "" {
		if re, err = regexp.Compile(p.Name); err != nil {
			return "", fmt.Errorf("policy: bad package name pattern for %s: %v", runtime, err)
		}
	}
	if !pkgNameFloor.MatchString(name) || !re.MatchString(name) || strings.Contains(name, "..") {
		return "", fmt.Errorf("%q isn't a valid %s package name", name, orDefault(p.Registry, runtime))
	}
	if version != "" && !pkgVersionRe.MatchString(version) {
		return "", fmt.Errorf("%q isn't a valid package version", version)
	}
	return name, nil
}

// PackageTokens replaces {package}, {name} and {version} in a package
// policy command. {package} is Spec (or SpecAny with no version), which
// quotes the name and version itself.
func PackageTokens(p *PackagePolicy, name, version string) *strings.Replacer {
	spec := p.SpecAny
	if version != "" && p.Spec != "" {
		spec = p.Spec
	}
	if spec == "" {
		spec = `"{name}"`
	}
	spec = strings.NewReplacer("{name}", name, "{version}", version).Replace(spec)
	return strings.NewReplacer("{package}", spec, "{name}", name, "{version}", version)
}

// PackageProject is the project name for a package: the name itself, or
// for Go module paths its last element (skipping a /vN suffix), which is
// what `go install` names the program.
func PackageProject(p *PackagePolicy, name string) string {
	if p == nil || p.ProjectFrom != "last" {
		return name
	}
	parts := strings.Split(strings.Trim(name, "/"), "/")
	last := parts[len(parts)-1]
	if len(parts) > 1 && regexp.MustCompile(`^v[0-9]+$`).MatchString(last) {
		last = parts[len(parts)-2]
	}
	return last
}

// PackageModule is {module}: the name with - and . as _ (Python's import
// name for most distributions).
func PackageModule(name string) string {
	return strings.NewReplacer("-", "_", ".", "_").Replace(strings.ToLower(name))
}

var binNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`)
var binPathRe = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$`)

// PickBin chooses the program from a registry's bin field (a string, a
// list of names, or a map of name to path): the one named like the
// project, else the first by name. Registry data is untrusted, so names
// and paths that could break out of a command are refused.
func PickBin(v any, project string) (name, path string, err error) {
	type bin struct{ name, path string }
	var bins []bin
	switch t := v.(type) {
	case nil:
		return "", "", nil
	case string:
		bins = append(bins, bin{project, t})
	case []any:
		for _, x := range t {
			if s, ok := x.(string); ok {
				bins = append(bins, bin{s, s})
			}
		}
	case map[string]any:
		for k, x := range t {
			if s, ok := x.(string); ok {
				bins = append(bins, bin{k, s})
			}
		}
	}
	if len(bins) == 0 {
		return "", "", nil
	}
	best := -1
	for i, b := range bins {
		if b.name == project {
			best = i
			break
		}
		if best < 0 || b.name < bins[best].name {
			best = i
		}
	}
	b := bins[best]
	b.path = strings.TrimPrefix(b.path, "./")
	if !binNameRe.MatchString(b.name) || !binPathRe.MatchString(b.path) || strings.Contains(b.path, "..") {
		return "", "", errors.New("the registry's program name or path has characters Installer Builder won't put in a command")
	}
	return b.name, b.path, nil
}

// JSONField follows a dotted path ("info.version") into decoded JSON.
func JSONField(v any, path string) any {
	if path == "" {
		return nil
	}
	for _, k := range strings.Split(path, ".") {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = m[k]
	}
	return v
}
