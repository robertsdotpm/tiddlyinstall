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
	PackageCmd string      // for package sources: what to install, e.g. "requests==2.32.3"
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
}

// Recipe support --------------------------------------------------------

var tmpRef = regexp.MustCompile(`\{tmp\}[\\/]+([A-Za-z0-9_.-]+)`)

func (c *Catalog) supported(r *Recipe) bool {
	if indexOf(c.Policy.MethodOrder, r.Method) < 0 || r.Isolation == "impossible" {
		return false
	}
	for _, st := range r.Steps {
		for k := range st {
			switch k {
			case "unpack", "to", "strip_components", "run", "shell", "write", "text", "mkdir":
			default:
				return false
			}
		}
		if s, ok := st["run"].(string); ok {
			for _, m := range tmpRef.FindAllStringSubmatch(s, -1) {
				if contains(c.Policy.ExternalTmpFiles, m[1]) {
					return false
				}
			}
		}
	}
	return true
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
func (c *Catalog) recipeFor(rt *Runtime, e *Release) *Recipe {
	var best *Recipe
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
		if !c.supported(r) {
			continue
		}
		// Most specific first, then preferred method, then better isolation.
		score = score*100 + (10-indexOf(c.Policy.MethodOrder, r.Method))*5
		if r.Isolation == "full" {
			score += 2
		}
		if score > bestScore {
			best, bestScore = r, score
		}
	}
	return best
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

func (c *Catalog) candidates(rt *Runtime, family, machine string) []*Release {
	pol := c.Policy.Runtimes[rt.ID]
	type ranked struct {
		e              *Release
		native         bool
		variant, forms int
	}
	var list []ranked
	for _, e := range rt.Releases {
		if e.OS != family || e.Kind == "source" || e.V.Pre {
			continue
		}
		ok, native := archOK(family, machine, e.Arch)
		if !ok {
			continue
		}
		if pol != nil && len(pol.Kinds) > 0 && !contains(pol.Kinds, e.Kind) {
			continue
		}
		vi := len(pol.Variants)
		if pol != nil {
			if contains(pol.ExcludeVariants, e.VariantStr()) {
				continue
			}
			if i := indexOf(pol.Variants, e.VariantStr()); i >= 0 {
				vi = i
			} else if pol.Only {
				continue
			}
		}
		fi := 0
		if pol != nil && pol.Formats[family] != nil {
			fi = indexOf(pol.Formats[family], e.Format)
			if fi < 0 {
				continue
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
		r := c.recipeFor(rt, e)
		if r == nil || c.sha(e) == "" {
			continue
		}
		pk := &pick{rel: e, recipe: r, minBuild: minBuild, known: known}
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
		for _, machine := range []string{"amd64", "arm64", "x86"} {
			cands := c.candidates(rt, family, machine)
			var cur *block
			flush := func() {
				if cur != nil {
					blocks = append(blocks, *cur)
					cur = nil
				}
			}
			for _, o := range c.OS.ByFamily[family] {
				if !contains(o.Arches, machine) {
					flush()
					continue
				}
				p, cond := c.best(rt, cands, o, app)
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
						cur = &block{family: family, min: o.Int, max: o.Int, minBuild: cond.minBuild, arches: []string{machine}, p: cond,
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
				cur = &block{family: family, min: o.Int, max: o.Int, arches: []string{machine}, p: p, labels: []string{o.Label}}
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
		for _, n := range b.p.needs {
			add(n.p.rel)
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
	return true
}

func versionTokens(v Version) *strings.Replacer {
	get := func(i int) string {
		if i < len(v.Parts) {
			return strconv.Itoa(v.Parts[i])
		}
		return "0"
	}
	return strings.NewReplacer("{version}", v.Raw, "{vmajor}", get(0), "{vminor}", get(1), "{vmm}", get(0)+get(1))
}

var appDirPath = regexp.MustCompile(`\{app_dir\}[^ "]*`)

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
	for _, st := range r.Steps {
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
	// Launch environment (design.md 1.7): the runtime's part from the recipe.
	path := map[string]bool{}
	if l := r.Launch; l != nil {
		for _, k := range sortedKeys(l.Env) {
			if v := l.Env[k]; v == nil {
				w.Add("unset", k)
			} else {
				w.Add("env", k, fix(*v))
			}
		}
		for _, p := range l.PathPrepend {
			path[fix(p)] = true
			w.Add("path", fix(p))
		}
	}
	// Project install.
	install := ""
	switch {
	case pol != nil && pol.InstallCommand[b.family] != "" && (app.Install == "default" || pol.Compiled):
		install = pol.InstallCommand[b.family]
	case app.Install == "default" || pol != nil && pol.Compiled:
		if r.ProjectInstall != nil {
			install = r.ProjectInstall.Command
		}
	case app.Install != "":
		install = app.Install
	}
	if app.PackageCmd != "" && install == "" && r.ProjectInstall != nil {
		install = r.ProjectInstall.Command
	}
	if install != "" {
		if pi := r.ProjectInstall; pi != nil {
			for _, k := range sortedKeys(pi.Env) {
				if v := pi.Env[k]; v == nil {
					w.Add("iunset", k)
				} else {
					w.Add("ienv", k, fix(*v))
				}
			}
			for _, p := range pi.PathPrepend {
				if !path[fix(p)] {
					w.Add("path", fix(p))
				}
			}
		}
		install = strings.ReplaceAll(install, "{package}", app.PackageCmd)
		w.Add("install", fix(install))
	}
	// Launch: the app's command, with {runtime} expanded to the runtime's
	// program and its own flags.
	launch := app.Launch
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
	w.Add("launch", fix(launch))
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
