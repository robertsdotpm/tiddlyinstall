package catalog

import (
	"fmt"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

// App is what the resolver needs from a record (docs/format.md section 2).
type App struct {
	RecordHash string
	Name       string
	Project    string
	Runtime    string
	Select     string // newest, asyncio, range, exact
	Range      string
	Launch     string
	Install    string // "" none, "default" catalogue command, else a command
	Console    bool
	Menu       bool
	Desktop    bool
	Root       string
	RootName   string
	Platforms  []string
	Source     *SourceFile // nil for package sources
	// Package sources (record `source package <name> <version>`): the
	// registry name and, if pinned, the version. Both are checked with
	// ValidPackage before they get here.
	Package        string
	PackageVersion string
}

// needsInstall: the app installs a project or package, so it needs the
// runtime's package manager (design.md 1.7).
func (a *App) needsInstall() bool {
	return a.Package != "" || a.Install != ""
}

// SourceFile is the project's source archive.
type SourceFile struct {
	Name   string
	SHA256 string
	Size   int64
	Format string
	Strip  int
	URLs   []string
}

// pick is one resolved choice for an OS version and machine architecture.
type pick struct {
	rel      *Release
	recipe   *Recipe
	minBuild int
	known    bool
	needs    []companion // other runtimes this one needs on this OS
	extras   []extraUse  // policy extra_files the recipe's steps name
	prereqs  []prereqUse // system-wide prerequisites (policy needs)
}

// extraUse is one policy extra file (e.g. get-pip.py) a recipe needs.
type extraUse struct {
	name string // the {tmp} file name
	src  *ExtraSource
}

// Recipe support --------------------------------------------------------

var tmpRef = regexp.MustCompile(`\{tmp\}[\\/]+([A-Za-z0-9_.-]+)`)

// supported says whether the engines can run a recipe for this release.
// A step naming a {tmp} file the catalogue doesn't download makes the
// recipe usable only when the runtime's policy pins that file
// (extra_files); those files are returned. prefer: the recipe needs a
// package-manager file and the app installs something, so it wins over an
// equally specific recipe without it.
func (c *Catalog) supported(rt *Runtime, r *Recipe, e *Release, install bool) (ok bool, extras []extraUse, prefer bool) {
	if indexOf(c.Policy.MethodOrder, r.Method) < 0 || r.Isolation == "impossible" {
		return false, nil, false
	}
	pol := c.Policy.Runtimes[rt.ID]
	seen := map[string]bool{}
	deferred := false
	for _, st := range r.Steps {
		for k := range st {
			switch k {
			case "unpack", "to", "strip_components", "run", "shell", "write", "text", "mkdir":
			default:
				return false, nil, false
			}
		}
		s, _ := st["run"].(string)
		for _, m := range tmpRef.FindAllStringSubmatch(s, -1) {
			if !contains(c.Policy.ExternalTmpFiles, m[1]) {
				continue
			}
			var ef *ExtraFile
			if pol != nil {
				ef = pol.ExtraFiles[m[1]]
			}
			if ef == nil {
				return false, nil, false
			}
			src := ef.source(e.V)
			if src == nil || src.SHA256 == "" || len(src.URLs) == 0 {
				return false, nil, false
			}
			if ef.For == "install" {
				if !install {
					return false, nil, false
				}
				prefer = true
			}
			deferred = true
			if !seen[m[1]] {
				seen[m[1]] = true
				extras = append(extras, extraUse{m[1], src})
			}
		}
		// Steps from the first one needing an extra file on run after the
		// extra files are fetched (writeTarget), when the runtime's own
		// download is gone: they can't use {file} or unpack it.
		if deferred && (st["unpack"] != nil || strings.Contains(s, "{file}")) {
			return false, nil, false
		}
	}
	return true, extras, prefer
}

// usesExtra: a recipe step names one of the pick's extra files.
func usesExtra(st Step, extras []extraUse) bool {
	s, _ := st["run"].(string)
	for _, m := range tmpRef.FindAllStringSubmatch(s, -1) {
		for _, x := range extras {
			if x.name == m[1] {
				return true
			}
		}
	}
	return false
}

func matchField(m map[string]any, key, val string) (ok bool, specific bool) {
	v, present := m[key]
	if !present || v == nil {
		return true, false
	}
	for _, x := range anyList(v) {
		for _, alt := range strings.Split(x, "|") {
			if alt == val || strings.HasSuffix(alt, "*") && strings.HasPrefix(val, strings.TrimSuffix(alt, "*")) {
				return true, true
			}
		}
	}
	return false, true
}

// recipeFor finds the most specific supported recipe for a release.
// install: the app installs a project or package (App.needsInstall).
func (c *Catalog) recipeFor(rt *Runtime, e *Release, install bool) (*Recipe, []extraUse) {
	var best *Recipe
	var bestExtras []extraUse
	bestScore := -1
	libc := ""
	if e.Libc != nil {
		libc = *e.Libc
	}
	for _, r := range rt.Recipes {
		score := 0
		ok := true
		for _, f := range [][2]string{{"os", e.OS}, {"kind", e.Kind}, {"format", e.Format}, {"arch", e.Arch}, {"libc", libc}} {
			m, spec := matchField(r.Match, f[0], f[1])
			if !m {
				ok = false
				break
			}
			if spec {
				score++
			}
		}
		if !ok {
			continue
		}
		if v, present := r.Match["variant"]; present {
			if !variantOK(anyList(v), e.Variant) {
				continue
			}
			if v != nil {
				score++
			}
		}
		if vs, _ := r.Match["versions"].(string); vs != "" {
			if !Matches(e.V, vs) {
				continue
			}
			score++
		}
		ok, extras, prefer := c.supported(rt, r, e, install)
		if !ok {
			continue
		}
		// Most specific first, then preferred method, then better
		// isolation, then (for apps that install something) the recipe
		// that brings a package manager.
		score = score*100 + (10-indexOf(c.Policy.MethodOrder, r.Method))*5
		if r.Isolation == "full" {
			score += 2
		}
		if prefer {
			score++
		}
		if score > bestScore {
			best, bestExtras, bestScore = r, extras, score
		}
	}
	return best, bestExtras
}

// Candidates -----------------------------------------------------------

func archOK(family, machine, rel string) (ok bool, native bool) {
	if rel == machine || rel == "any" {
		return true, true
	}
	if family == "macos" && rel == "universal" {
		return true, true
	}
	if family == "windows" && machine == "amd64" && rel == "x86" {
		return true, false
	}
	return false, false
}

func (c *Catalog) selectFor(app *App, osid string) string {
	switch app.Select {
	case "range", "exact":
		return app.Range
	case "asyncio":
		if p := c.Policy.Runtimes[app.Runtime]; p != nil && p.Asyncio != nil {
			if s, ok := p.Asyncio[osid]; ok {
				return s
			}
		}
	}
	return ""
}

// sha fills in the checksum from our own copy when the catalogue has none,
// and remembers our copy for the mirror URL.
func (c *Catalog) sha(e *Release) string {
	if c.local != nil && e.Local == "" {
		e.Local = c.local.Find(e.FileName(), e.Size)
	}
	if e.SHA256 != "" {
		return e.SHA256
	}
	if c.local != nil && e.Local != "" {
		if s, size, err := c.local.SHA256(e.Local); err == nil {
			e.SHA256 = s
			if e.Size == 0 {
				e.Size = size
			}
		}
	}
	return e.SHA256
}

// usable reports whether the policy lets the resolver pick a release on
// any machine of its OS family (candidates, and what Snapshot keeps).
func usable(pol *RuntimePolicy, e *Release) bool {
	if e.Kind == "source" || e.V.Pre {
		return false
	}
	if pol == nil {
		return true
	}
	if len(pol.Kinds) > 0 && !contains(pol.Kinds, e.Kind) {
		return false
	}
	if contains(pol.ExcludeVariants, e.VariantStr()) || contains(pol.ExcludeVariantsOn[e.OS], e.VariantStr()) {
		return false
	}
	if pol.Only && indexOf(pol.Variants, e.VariantStr()) < 0 {
		return false
	}
	return pol.Formats[e.OS] == nil || indexOf(pol.Formats[e.OS], e.Format) >= 0
}

func (c *Catalog) candidates(rt *Runtime, family, machine string) []*Release {
	pol := c.Policy.Runtimes[rt.ID]
	type ranked struct {
		e              *Release
		native         bool
		variant, forms int
	}
	var list []ranked
	for _, e := range rt.Releases {
		if e.OS != family || !usable(pol, e) {
			continue
		}
		ok, native := archOK(family, machine, e.Arch)
		if !ok {
			continue
		}
		vi, fi := len(pol.Variants), 0
		if pol != nil {
			if i := indexOf(pol.Variants, e.VariantStr()); i >= 0 {
				vi = i
			}
			if pol.Formats[family] != nil {
				fi = indexOf(pol.Formats[family], e.Format)
			}
		}
		list = append(list, ranked{e, native, vi, fi})
	}
	sort.SliceStable(list, func(i, j int) bool {
		a, b := list[i], list[j]
		if a.native != b.native {
			return a.native
		}
		if d := Cmp(a.e.V, b.e.V); d != 0 {
			return d > 0
		}
		if a.variant != b.variant {
			return a.variant < b.variant
		}
		return a.forms < b.forms
	})
	out := make([]*Release, len(list))
	for i, r := range list {
		out[i] = r.e
	}
	return out
}

// best finds the newest installable release for one OS version and arch.
// A choice that needs a newer Windows build than the OS version starts at
// is returned as cond, with the unconditional fallback as p.
func (c *Catalog) best(rt *Runtime, cands []*Release, o OSID, app *App) (p, cond *pick) {
	spec := c.selectFor(app, o.ID)
	for _, e := range cands {
		if !Matches(e.V, spec) {
			continue
		}
		ok, minBuild, known := c.runsOn(rt, e, o)
		if !ok {
			continue
		}
		r, extras := c.recipeFor(rt, e, app.needsInstall())
		if r == nil || c.sha(e) == "" {
			continue
		}
		pk := &pick{rel: e, recipe: r, minBuild: minBuild, known: known, extras: extras, prereqs: c.prereqsFor(rt, e, o)}
		if !c.attachNeeds(rt, pk, o) {
			continue
		}
		if minBuild > o.Build && minBuild > 0 {
			if cond == nil {
				cond = pk
			}
			continue
		}
		return pk, cond
	}
	return nil, cond
}

// attachNeeds finds the companion runtimes (policy "requires") for a pick
// on one OS version, built for the same architecture as the pick.
func (c *Catalog) attachNeeds(rt *Runtime, pk *pick, o OSID) bool {
	pol := c.Policy.Runtimes[rt.ID]
	if pol == nil {
		return true
	}
	for _, req := range pol.Requires[o.Family] {
		crt := c.Runtimes[req.Runtime]
		if crt == nil {
			return false
		}
		var native []*Release
		for _, e := range c.candidates(crt, o.Family, pk.rel.Arch) {
			if e.Arch == pk.rel.Arch || e.Arch == "any" || e.Arch == "universal" {
				native = append(native, e)
			}
		}
		cp, _ := c.best(crt, native, o, &App{Runtime: req.Runtime})
		if cp == nil {
			return false
		}
		pk.needs = append(pk.needs, companion{req, cp})
	}
	return true
}

// Plans ----------------------------------------------------------------

type block struct {
	family   string
	min, max int
	minBuild int
	arches   []string
	p        *pick
	labels   []string
}

type companion struct {
	req Requirement
	p   *pick
}

// FileRef is a file a plan downloads, for packing (packed-files.md).
type FileRef struct {
	Name   string
	SHA256 string
	Size   int64
	Local  string // absolute path of our copy, or ""
	URLs   []string
}

// Resolve builds the plan text for an app.
func (c *Catalog) Resolve(app *App) (string, error) {
	p, _, err := c.ResolveFiles(app)
	return p, err
}

// ResolveFiles builds the plan and lists the files it downloads.
func (c *Catalog) ResolveFiles(app *App) (string, []FileRef, error) {
	rt := c.Runtimes[app.Runtime]
	if rt == nil {
		return "", nil, fmt.Errorf("unknown runtime %q", app.Runtime)
	}
	var blocks []block
	for _, family := range []string{"windows", "macos", "linux"} {
		if len(app.Platforms) > 0 && !contains(app.Platforms, family) {
			continue
		}
		// A runtime may be provided by another on this family (policy via).
		frt := rt
		if v := c.Policy.Runtimes[app.Runtime].Via[family]; v != "" && c.Runtimes[v] != nil {
			frt = c.Runtimes[v]
		}
		for _, machine := range []string{"amd64", "arm64", "x86"} {
			cands := c.candidates(frt, family, machine)
			var cur *block
			flush := func() {
				if cur != nil {
					blocks = append(blocks, *cur)
					cur = nil
				}
			}
			// A block reaches up to just below the next newer OS version, and
			// the newest is open-ended, so point releases (macOS 26.2 is
			// 2602) and future versions are covered.
			top := func(o OSID) int {
				hi := 9999
				for _, n := range c.OS.ByFamily[family] {
					if n.Int > o.Int && n.Int-1 < hi {
						hi = n.Int - 1
					}
				}
				return hi
			}
			for _, o := range c.OS.ByFamily[family] {
				if !contains(o.Arches, machine) {
					flush()
					continue
				}
				p, cond := c.best(frt, cands, o, app)
				if cond != nil && (p == nil || cond.rel != p.rel) {
					// Needs a newer build than this OS version starts at: a
					// block of its own, checked before the fallback.
					if cur != nil && samePick(cur.p, cond) && cur.minBuild <= cond.minBuild {
						cur.min = o.Int
						cur.labels = append(cur.labels, o.Label+" (build "+strconv.Itoa(cond.minBuild)+"+)")
						if cur.minBuild < cond.minBuild {
							cur.minBuild = cond.minBuild
						}
					} else {
						flush()
						cur = &block{family: family, min: o.Int, max: top(o), minBuild: cond.minBuild, arches: []string{machine}, p: cond,
							labels: []string{o.Label + " (build " + strconv.Itoa(cond.minBuild) + "+)"}}
					}
					flush()
				}
				if cur != nil && samePick(cur.p, p) {
					cur.min = o.Int
					cur.labels = append(cur.labels, o.Label)
					if o.ID == "10" && cur.minBuild >= 22000 {
						cur.minBuild = 0 // the block now covers 10 as well as 11
					}
					continue
				}
				flush()
				cur = &block{family: family, min: o.Int, max: top(o), arches: []string{machine}, p: p, labels: []string{o.Label}}
				if o.ID == "11" {
					cur.minBuild = o.Build
				}
			}
			flush()
		}
	}
	var files []FileRef
	seen := map[string]bool{}
	add := func(e *Release) {
		if seen[e.SHA256] {
			return
		}
		seen[e.SHA256] = true
		f := FileRef{Name: e.FileName(), SHA256: e.SHA256, Size: e.Size, URLs: append([]string{e.URL}, e.Mirrors...)}
		if e.Local != "" && c.local != nil {
			f.Local = filepath.Join(c.local.Root, e.Local)
		}
		files = append(files, f)
	}
	for _, b := range blocks {
		if b.p == nil {
			continue
		}
		add(b.p.rel)
		for _, x := range b.p.extras {
			if !seen[x.src.SHA256] {
				seen[x.src.SHA256] = true
				files = append(files, FileRef{Name: x.name, SHA256: x.src.SHA256, Size: x.src.Size, URLs: x.src.URLs})
			}
		}
		for _, n := range b.p.needs {
			add(n.p.rel)
		}
		for _, u := range b.p.allPrereqs() {
			if f := u.p.File; f != nil && !seen[f.SHA256] {
				seen[f.SHA256] = true
				files = append(files, c.prereqFileRef(f))
			}
		}
	}
	return c.write(app, rt, blocks), files, nil
}

func samePick(a, b *pick) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	if a.rel != b.rel || a.recipe != b.recipe || len(a.needs) != len(b.needs) {
		return false
	}
	for i := range a.needs {
		if a.needs[i].p.rel != b.needs[i].p.rel {
			return false
		}
	}
	return samePrereqs(a, b)
}

func versionTokens(v Version) *strings.Replacer {
	get := func(i int) string {
		if i < len(v.Parts) {
			return strconv.Itoa(v.Parts[i])
		}
		return "0"
	}
	// "3XX" is the catalogue's spelling for the embeddable Python's
	// python3XX._pth ("replace python3XX with the version's own name",
	// python/install.json notes): the same as {vmm}.
	return strings.NewReplacer("{version}", v.Raw, "{vmajor}", get(0), "{vminor}", get(1), "{vmm}", get(0)+get(1),
		get(0)+"XX", get(0)+get(1))
}

var envRef = regexp.MustCompile(`\{env:[A-Za-z_][A-Za-z0-9_]*\}`)

var appDirPath = regexp.MustCompile(`\{app_dir\}[^ "]*`)

// quoteAppPaths quotes bare {app_dir}/... paths in an app's own commands:
// install roots can contain spaces (macOS "Application Support").
func quoteAppPaths(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range appDirPath.FindAllStringIndex(s, -1) {
		b.WriteString(s[last:m[0]])
		if m[0] > 0 && s[m[0]-1] == '"' {
			b.WriteString(s[m[0]:m[1]])
		} else {
			b.WriteString(`"` + s[m[0]:m[1]] + `"`)
		}
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

func (c *Catalog) write(app *App, rt *Runtime, blocks []block) string {
	var w ibtext.Writer
	w.Add("ib-plan", "1")
	w.Add("record", app.RecordHash)
	w.Add("name", app.Name)
	w.Add("project", app.Project)
	w.Add("appid", ibtext.Hash12(app.RecordHash+"/app"))
	w.Add("runtime", app.Runtime)
	w.Add("console", b01(app.Console))
	w.Add("menu", b01(app.Menu))
	w.Add("desktop", b01(app.Desktop))
	w.Add("root", orDefault(app.Root, "user"))
	w.Add("rootname", orDefault(app.RootName, "ib"))
	if s := app.Source; s != nil {
		w.Add("source", s.Name, s.SHA256, strconv.FormatInt(s.Size, 10), s.Format, strconv.Itoa(s.Strip))
		for _, u := range s.URLs {
			w.Add("url", u)
		}
	}
	pol := c.Policy.Runtimes[app.Runtime]
	label := app.Runtime
	if pol != nil && pol.Label != "" {
		label = pol.Label
	}
	for _, b := range blocks {
		w.Raw("\n[target]\n")
		w.Add("when", b.family, strconv.Itoa(b.min), strconv.Itoa(b.max), strings.Join(b.arches, " "))
		if b.minBuild > 0 {
			w.Add("minbuild", strconv.Itoa(b.minBuild))
		}
		w.Add("covers", strings.Join(b.labels, ", "))
		if b.p == nil {
			w.Add("fail", fmt.Sprintf("No %s release in the catalogue runs on %s (%s).", label, strings.Join(b.labels, ", "), b.arches[0]))
			continue
		}
		c.writeTarget(&w, app, pol, b)
	}
	return w.String()
}

func (c *Catalog) writeTarget(w *ibtext.Writer, app *App, pol *RuntimePolicy, b block) {
	e, r := b.p.rel, b.p.recipe
	win := b.family == "windows"
	exeExt := ""
	if win {
		exeExt = ".exe"
	}
	vt := versionTokens(e.V)
	fix := func(s string) string {
		s = vt.Replace(s)
		s = strings.ReplaceAll(s, "{exe}", exeExt)
		if win {
			s = appDirPath.ReplaceAllStringFunc(s, func(p string) string { return strings.ReplaceAll(p, "/", `\`) })
		}
		return s
	}
	w.Add("runtime", app.Runtime, e.Version)
	if !b.p.known {
		w.Add("note", "Not confirmed to run on every OS version in this range; chosen by the catalogue's default floor.")
	}
	// System-wide prerequisites first: engines check (and if need be
	// install) them before anything else.
	c.writeNeeds(w, b.p.allPrereqs())
	w.Add("file", app.Runtime, e.FileName(), e.SHA256, strconv.FormatInt(e.Size, 10))
	seen := map[string]bool{}
	addURL := func(u string) {
		if u != "" && !seen[u] {
			seen[u] = true
			w.Add("url", u)
		}
	}
	mirror := ""
	if e.Local != "" && c.Policy.MirrorBase != "" {
		mirror = strings.TrimRight(c.Policy.MirrorBase, "/") + "/" + strings.ReplaceAll(e.Local, "\\", "/")
	}
	if c.Policy.MirrorFirst {
		addURL(mirror)
	}
	addURL(e.URL)
	for _, m := range e.Mirrors {
		addURL(m)
	}
	// Last resort for old machines: our mirror over plain HTTP by IP
	// address (design.md 1.3).
	addURL(mirror)
	// Recipe steps. From the first step that needs an extra file (policy
	// extra_files, e.g. get-pip.py) on, steps wait: each extra file is
	// fetched as a `file` of its own and copied to {tmp}/<name>, where the
	// recipe expects it, and the waiting steps follow under the last one.
	// They only use {runtime_dir} and {tmp} (supported() checks), so
	// which file they sit under doesn't matter; {dir} is pinned to the
	// runtime's folder.
	step := func(st Step, fix func(string) string) {
		switch {
		case st["unpack"] != nil:
			f := fmt.Sprint(st["unpack"])
			if f == "7z-sfx" {
				f = "7z"
			}
			strip := 0
			if n, ok := st["strip_components"].(float64); ok {
				strip = int(n)
			}
			to, _ := st["to"].(string)
			w.Add("step", "unpack", f, fix(orDefault(to, "{dir}")), strconv.Itoa(strip))
		case st["run"] != nil:
			w.Add("step", "run", fix(fmt.Sprint(st["run"])))
		case st["write"] != nil:
			w.Add("step", "write", fix(fmt.Sprint(st["write"])), fix(fmt.Sprint(st["text"])))
		case st["mkdir"] != nil:
			w.Add("step", "mkdir", fix(fmt.Sprint(st["mkdir"])))
		}
	}
	split := len(r.Steps)
	for i, st := range r.Steps {
		if usesExtra(st, b.p.extras) {
			split = i
			break
		}
	}
	for _, st := range r.Steps[:split] {
		step(st, fix)
	}
	if len(b.p.extras) > 0 {
		for _, x := range b.p.extras {
			w.Add("file", strings.TrimSuffix(x.name, filepath.Ext(x.name)), x.name, x.src.SHA256, strconv.FormatInt(x.src.Size, 10))
			for _, u := range x.src.URLs {
				w.Add("url", u)
			}
			if win {
				w.Add("step", "run", `copy /y "{file}" "{tmp}\`+x.name+`" >nul`)
			} else {
				w.Add("step", "run", `cp "{file}" "{tmp}/`+x.name+`"`)
			}
		}
		later := func(s string) string { return fix(strings.ReplaceAll(s, "{dir}", "{runtime_dir}")) }
		for _, st := range r.Steps[split:] {
			step(st, later)
		}
	}
	// Companion runtimes (policy "requires"): their own files and folders,
	// with their bin folder on PATH for install and launch.
	var compPath []string
	for _, n := range b.p.needs {
		ce := n.p.rel
		cvt := versionTokens(ce.V)
		cfix := func(s string) string {
			return fix(cvt.Replace(strings.ReplaceAll(s, "{runtime_dir}", "{dir}")))
		}
		w.Add("file", n.req.Runtime, ce.FileName(), ce.SHA256, strconv.FormatInt(ce.Size, 10))
		cm := ""
		if ce.Local != "" && c.Policy.MirrorBase != "" {
			cm = strings.TrimRight(c.Policy.MirrorBase, "/") + "/" + strings.ReplaceAll(ce.Local, "\\", "/")
		}
		cseen := map[string]bool{}
		for _, u := range append(append([]string{cm, ce.URL}, ce.Mirrors...), cm) {
			if u != "" && !cseen[u] {
				cseen[u] = true
				w.Add("url", u)
			}
		}
		for _, st := range n.p.recipe.Steps {
			switch {
			case st["unpack"] != nil:
				f := fmt.Sprint(st["unpack"])
				if f == "7z-sfx" {
					f = "7z"
				}
				strip := 0
				if x, ok := st["strip_components"].(float64); ok {
					strip = int(x)
				}
				to, _ := st["to"].(string)
				w.Add("step", "unpack", f, cfix(orDefault(to, "{dir}")), strconv.Itoa(strip))
			case st["run"] != nil:
				w.Add("step", "run", cfix(fmt.Sprint(st["run"])))
			}
		}
		sep := "/"
		if win {
			sep = `\`
		}
		bin := "{dir:" + n.req.Runtime + "}"
		if n.req.Bin != "" {
			bin += sep + n.req.Bin
		}
		compPath = append(compPath, bin)
	}
	if r.Executable != "" {
		w.Add("exe", fix(r.Executable))
	}
	for _, p := range compPath {
		w.Add("path", p)
	}
	// Package sources: the runtime's package policy (design.md 1.7,
	// "Packages") adds to the recipe's environment and replaces its
	// project install command.
	var pkg *PackagePolicy
	if app.Package != "" && pol != nil {
		pkg = pol.Package
	}
	launchEnv := map[string]*string{}
	installEnv := map[string]*string{}
	if l := r.Launch; l != nil {
		mergeEnv(launchEnv, l.Env)
	}
	if pi := r.ProjectInstall; pi != nil {
		mergeEnv(installEnv, pi.Env)
	}
	if pkg != nil {
		mergeEnv(launchEnv, pkg.Env[b.family])
		mergeEnv(installEnv, pkg.Env[b.family])
		mergeEnv(installEnv, pkg.IEnv[b.family])
	}
	// Launch environment (design.md 1.7): the runtime's part from the recipe.
	path := map[string]bool{}
	for _, k := range sortedKeys(launchEnv) {
		if v := launchEnv[k]; v == nil {
			w.Add("unset", k)
		} else {
			w.Add("env", k, fix(*v))
		}
	}
	if l := r.Launch; l != nil {
		for _, p := range l.PathPrepend {
			path[fix(p)] = true
			w.Add("path", fix(p))
		}
	}
	// {env:NAME} in the app's own commands takes the value the plan gives
	// NAME (e.g. JAVA_HOME, which differs between JDK layouts).
	envVals := map[string]string{}
	for _, m := range []map[string]*string{launchEnv, installEnv} {
		for k, v := range m {
			if v != nil {
				envVals[k] = fix(*v)
			}
		}
	}
	expandEnv := func(s string) string {
		return envRef.ReplaceAllStringFunc(s, func(m string) string {
			return envVals[m[5:len(m)-1]]
		})
	}
	// Project install.
	install := ""
	switch {
	case pkg != nil && (app.Install == "" || app.Install == "default"):
		install = pkg.Install[b.family]
		if install == "" {
			w.Add("fail", fmt.Sprintf("Installing %s packages isn't supported on %s yet.", label(pol, app.Runtime), b.family))
		}
	case strings.HasPrefix(app.Install, "default:"):
		// The policy rule the server chose from the source's files
		// (RuntimePolicy.InstallRules).
		id := strings.TrimPrefix(app.Install, "default:")
		switch rule := pol.Rule(id); {
		case rule == nil:
			w.Add("fail", fmt.Sprintf("This installer asks for a %s project install (%q) that Installer Builder doesn't know.", label(pol, app.Runtime), id))
		case rule.Unsupported != "":
			w.Add("fail", rule.Unsupported)
		case rule.Command[b.family] != "":
			install = rule.Command[b.family]
		case r.ProjectInstall != nil:
			// Like plain "default": the recipe's command, or none.
			install = r.ProjectInstall.Command
		}
	case pol != nil && pol.InstallCommand[b.family] != "" && (app.Install == "default" || pol.Compiled):
		install = pol.InstallCommand[b.family]
	case app.Install == "default" || pol != nil && pol.Compiled:
		if r.ProjectInstall != nil {
			install = r.ProjectInstall.Command
		}
	case app.Install != "":
		install = quoteAppPaths(app.Install)
	}
	if install != "" {
		for _, k := range sortedKeys(installEnv) {
			if v := installEnv[k]; v == nil {
				w.Add("iunset", k)
			} else {
				w.Add("ienv", k, fix(*v))
			}
		}
		if pi := r.ProjectInstall; pi != nil {
			for _, p := range pi.PathPrepend {
				if !path[fix(p)] {
					w.Add("path", fix(p))
				}
			}
		}
		if pkg != nil {
			install = PackageTokens(pkg, app.Package, app.PackageVersion).Replace(install)
		}
		w.Add("install", fix(expandEnv(install)))
	}
	// Launch: the app's command, with {runtime} expanded to the runtime's
	// program and its own flags.
	launch := quoteAppPaths(app.Launch)
	if l := r.Launch; l != nil && l.Program != nil {
		rc := `"` + fix(*l.Program) + `"`
		for _, a := range l.Args {
			if strings.ContainsAny(a, " \\/") {
				a = `"` + a + `"`
			}
			rc += " " + fix(a)
		}
		launch = strings.ReplaceAll(launch, "{runtime}", rc)
	}
	w.Add("launch", fix(expandEnv(launch)))
}

// mergeEnv copies src over dst (a nil value means unset).
func mergeEnv(dst, src map[string]*string) {
	for k, v := range src {
		dst[k] = v
	}
}

func label(pol *RuntimePolicy, id string) string {
	if pol != nil && pol.Label != "" {
		return pol.Label
	}
	return id
}

func sortedKeys(m map[string]*string) []string {
	var k []string
	for x := range m {
		k = append(k, x)
	}
	sort.Strings(k)
	return k
}

func b01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
