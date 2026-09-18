package catalog

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

// System-wide prerequisites (docs/format.md, "Prerequisites"): things a
// runtime needs that can't live in the app's own folders, such as the
// VC++ redistributable, a distribution's shared library, or Xcode's
// Command Line Tools. They are policy data: which runtime releases need
// what (RuntimePolicy.Needs), how the engine checks for each, and how it
// installs one that is missing. Nothing here is per-runtime.

// prereqUse is one prerequisite a pick needs.
type prereqUse struct {
	id  string
	p   *Prerequisite
	why string
}

var (
	// Package names go into a root shell command.
	pkgListRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+_:-]*( [A-Za-z0-9][A-Za-z0-9.+_:-]*)*$`)
	pkgMgrs   = []string{"apt-get", "dnf", "yum", "zypper", "apk", "pacman"}
	sha256Re  = regexp.MustCompile(`^[0-9a-f]{64}$`)
	prereqID  = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
)

// validatePrereqs checks the policy's prerequisites and every runtime's
// references to them, so a typo fails at load, not in a user's install.
func (p *Policy) validatePrereqs() error {
	for id, q := range p.Prerequisites {
		if !prereqID.MatchString(id) {
			return fmt.Errorf("prerequisite %q: bad id", id)
		}
		switch q.OS {
		case "windows", "linux", "macos":
		default:
			return fmt.Errorf("prerequisite %s: os must be windows, linux or macos", id)
		}
		if q.Label == "" {
			return fmt.Errorf("prerequisite %s: no label", id)
		}
		if len(q.Checks) == 0 {
			return fmt.Errorf("prerequisite %s: no checks (the engine must be able to tell it is there)", id)
		}
		for _, c := range q.Checks {
			if err := validCheck(q.OS, c); err != nil {
				return fmt.Errorf("prerequisite %s: %v", id, err)
			}
		}
		for m, pk := range q.Packages {
			if q.OS != "linux" {
				return fmt.Errorf("prerequisite %s: packages are for linux only", id)
			}
			if indexOf(pkgMgrs, m) < 0 {
				return fmt.Errorf("prerequisite %s: unknown package manager %q", id, m)
			}
			if !pkgListRe.MatchString(pk) {
				return fmt.Errorf("prerequisite %s: bad package list %q", id, pk)
			}
		}
		if (q.File != nil) != (q.Run != "") {
			return fmt.Errorf("prerequisite %s: file and run go together", id)
		}
		if f := q.File; f != nil {
			if q.OS != "windows" {
				return fmt.Errorf("prerequisite %s: file/run are for windows only", id)
			}
			if f.Name == "" || strings.ContainsAny(f.Name, `/\:*?"<>|`) {
				return fmt.Errorf("prerequisite %s: bad file name %q", id, f.Name)
			}
			if !sha256Re.MatchString(f.SHA256) || f.Size <= 0 {
				return fmt.Errorf("prerequisite %s: file needs a lowercase sha256 and a size", id)
			}
		}
		if q.Run == "" && len(q.Packages) == 0 && q.How == "" {
			return fmt.Errorf("prerequisite %s: no way to install it (run, packages) and no how", id)
		}
	}
	for rid, rp := range p.Runtimes {
		for _, n := range rp.Needs {
			if len(n.Prerequisites) == 0 {
				return fmt.Errorf("runtime %s: a needs entry names no prerequisites", rid)
			}
			for _, id := range n.Prerequisites {
				if p.Prerequisites[id] == nil {
					return fmt.Errorf("runtime %s needs unknown prerequisite %q", rid, id)
				}
			}
		}
	}
	return nil
}

func validCheck(osName string, c []string) error {
	if len(c) == 0 {
		return fmt.Errorf("empty check")
	}
	for _, v := range c {
		if v == "" && c[0] != "reg" || strings.ContainsAny(v, "\t\r\n") {
			return fmt.Errorf("check %v: empty field or control character", c)
		}
	}
	switch c[0] {
	case "reg":
		if osName != "windows" || len(c) < 4 || len(c) > 5 || c[1] != "32" && c[1] != "64" ||
			!strings.HasPrefix(c[2], `HKLM\`) && !strings.HasPrefix(c[2], `HKCU\`) {
			return fmt.Errorf("check %v: want [reg, 32|64, HKLM\\key, value, min]", c)
		}
		if len(c) == 5 && c[4] != "" {
			if _, err := strconv.Atoi(c[4]); err != nil {
				return fmt.Errorf("check %v: min must be a number", c)
			}
		}
	case "file":
		if len(c) != 2 {
			return fmt.Errorf("check %v: want [file, path]", c)
		}
	case "lib", "cmd":
		if osName == "windows" || len(c) != 2 || !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]*$`).MatchString(c[1]) {
			return fmt.Errorf("check %v: want [lib|cmd, name] (not on windows)", c)
		}
	default:
		return fmt.Errorf("unknown check kind %q", c[0])
	}
	return nil
}

// prereqsFor lists the prerequisites a runtime release needs on one OS
// version, in policy order, each once.
func (c *Catalog) prereqsFor(rt *Runtime, e *Release, o OSID) []prereqUse {
	pol := c.Policy.Runtimes[rt.ID]
	if pol == nil {
		return nil
	}
	var out []prereqUse
	seen := map[string]bool{}
	for _, n := range pol.Needs {
		if len(n.Variants) > 0 && indexOf(n.Variants, e.VariantStr()) < 0 {
			continue
		}
		if n.Versions != "" && !Matches(e.V, n.Versions) {
			continue
		}
		if n.MinOS > 0 && o.Int < n.MinOS || n.MaxOS > 0 && o.Int > n.MaxOS {
			continue
		}
		for _, id := range n.Prerequisites {
			q := c.Policy.Prerequisites[id]
			if q == nil || q.OS != o.Family || seen[id] {
				continue
			}
			if q.Arch != "" && q.Arch != e.Arch {
				continue
			}
			seen[id] = true
			out = append(out, prereqUse{id, q, n.Why})
		}
	}
	return out
}

// allPrereqs: the pick's own prerequisites, then its companions', each once.
func (pk *pick) allPrereqs() []prereqUse {
	var out []prereqUse
	seen := map[string]bool{}
	add := func(l []prereqUse) {
		for _, u := range l {
			if !seen[u.id] {
				seen[u.id] = true
				out = append(out, u)
			}
		}
	}
	add(pk.prereqs)
	for _, n := range pk.needs {
		add(n.p.prereqs)
	}
	return out
}

func samePrereqs(a, b *pick) bool {
	x, y := a.allPrereqs(), b.allPrereqs()
	if len(x) != len(y) {
		return false
	}
	for i := range x {
		if x[i].id != y[i].id || x[i].why != y[i].why {
			return false
		}
	}
	return true
}

// prereqURLs: the prerequisite file's download locations, with our mirror
// first or last as for runtime files.
func (c *Catalog) prereqURLs(f *PrereqFile) []string {
	mirror := ""
	if f.Local != "" && c.Policy.MirrorBase != "" {
		mirror = strings.TrimRight(c.Policy.MirrorBase, "/") + "/" + strings.ReplaceAll(f.Local, "\\", "/")
	}
	var out []string
	seen := map[string]bool{}
	add := func(u string) {
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}
	if c.Policy.MirrorFirst {
		add(mirror)
	}
	for _, u := range f.URLs {
		add(u)
	}
	add(mirror)
	return out
}

func (c *Catalog) prereqFileRef(f *PrereqFile) FileRef {
	r := FileRef{Name: f.Name, SHA256: f.SHA256, Size: f.Size, URLs: c.prereqURLs(f)}
	if f.Local != "" && c.local != nil && fileExists(filepath.Join(c.local.Root, f.Local)) {
		r.Local = filepath.Join(c.local.Root, f.Local)
	}
	return r
}

// writeNeeds writes a block's `need` entries (format.md, "Prerequisites").
func (c *Catalog) writeNeeds(w *ibtext.Writer, uses []prereqUse) {
	for _, u := range uses {
		q := u.p
		w.Add("need", u.id, q.Label)
		if u.why != "" {
			w.Add("nwhy", u.why)
		}
		for _, ch := range q.Checks {
			w.Add("ncheck", ch...)
		}
		if f := q.File; f != nil {
			w.Add("nfile", f.Name, f.SHA256, strconv.FormatInt(f.Size, 10))
			for _, url := range c.prereqURLs(f) {
				w.Add("nurl", url)
			}
		}
		if q.Run != "" {
			w.Add("nrun", q.Run)
			if len(q.OK) > 0 {
				codes := make([]string, len(q.OK))
				for i, n := range q.OK {
					codes[i] = strconv.Itoa(n)
				}
				w.Add("nok", strings.Join(codes, " "))
			}
		}
		for _, m := range pkgMgrs {
			if pk := q.Packages[m]; pk != "" {
				w.Add("npkg", m, pk)
			}
		}
		if q.Start != "" {
			w.Add("nstart", q.Start)
		}
		if q.How != "" {
			w.Add("nhow", q.How)
		}
	}
}
