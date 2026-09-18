package main

// Oracle cases for js/resolve.js: apps covering every runtime, select
// mode, install kind, package source, platform subset and flag, each with
// the plan (or error) the Go resolver gives; plus the runtimes summary and
// the package helpers. tests/resolve-test.mjs requires identical results.

import (
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"os"
	"sort"
	"strings"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

type srcJSON struct {
	Name   string   `json:"name"`
	SHA256 string   `json:"sha256"`
	Size   int64    `json:"size"`
	Format string   `json:"format"`
	Strip  int      `json:"strip"`
	URLs   []string `json:"urls"`
}

type appJSON struct {
	RecordHash     string   `json:"recordHash"`
	Name           string   `json:"name"`
	Project        string   `json:"project"`
	Runtime        string   `json:"runtime"`
	Select         string   `json:"select"`
	Range          string   `json:"range"`
	Launch         string   `json:"launch"`
	Install        string   `json:"install"`
	Console        bool     `json:"console"`
	Menu           bool     `json:"menu"`
	Desktop        bool     `json:"desktop"`
	Root           string   `json:"root"`
	RootName       string   `json:"rootName"`
	Platforms      []string `json:"platforms"`
	Source         *srcJSON `json:"source"`
	Package        string   `json:"package"`
	PackageVersion string   `json:"packageVersion"`
}

func (a appJSON) app() *catalog.App {
	x := &catalog.App{RecordHash: a.RecordHash, Name: a.Name, Project: a.Project, Runtime: a.Runtime, Select: a.Select,
		Range: a.Range, Launch: a.Launch, Install: a.Install, Console: a.Console, Menu: a.Menu, Desktop: a.Desktop,
		Root: a.Root, RootName: a.RootName, Platforms: a.Platforms, Package: a.Package, PackageVersion: a.PackageVersion}
	if s := a.Source; s != nil {
		x.Source = &catalog.SourceFile{Name: s.Name, SHA256: s.SHA256, Size: s.Size, Format: s.Format, Strip: s.Strip, URLs: s.URLs}
	}
	return x
}

type fileJSON struct {
	Name   string   `json:"name"`
	SHA256 string   `json:"sha256"`
	Size   int64    `json:"size"`
	URLs   []string `json:"urls"`
}

type gen struct {
	cat   *catalog.Catalog
	cases []map[string]any
	n     int
}

func (g *gen) resolve(note string, a appJSON) {
	g.n++
	if a.RecordHash == "" {
		a.RecordHash = ibtext.Hash26([]byte(fmt.Sprint("case ", g.n)))
	}
	c := map[string]any{"kind": "resolve", "note": note, "app": a}
	plan, files, err := g.cat.ResolveFiles(a.app())
	if err != nil {
		c["error"] = err.Error()
	} else {
		c["plan"] = plan
		fl := []fileJSON{}
		for _, f := range files {
			fl = append(fl, fileJSON{f.Name, f.SHA256, f.Size, f.URLs})
		}
		c["files"] = fl
	}
	g.cases = append(g.cases, c)
}

func (g *gen) add(c map[string]any, err error) {
	if err != nil {
		c["error"] = err.Error()
	}
	g.cases = append(g.cases, c)
}

// versionSpecs: range specs from a runtime's own versions, some matching
// nothing, some malformed.
func versionSpecs(rt *catalog.Runtime) []string {
	var vs []catalog.Version
	seen := map[string]bool{}
	if rt != nil {
		for _, e := range rt.Releases {
			if !seen[e.Version] {
				seen[e.Version] = true
				vs = append(vs, catalog.ParseVersion(e.Version))
			}
		}
	}
	sort.SliceStable(vs, func(i, j int) bool { return catalog.Cmp(vs[i], vs[j]) > 0 })
	specs := []string{"==999", ">=999.1", "garbage!!", "", "  ,  ", ">=", "<0", "~=1", "==1.*,!=1.*"}
	if len(vs) == 0 {
		return specs
	}
	pick := []catalog.Version{vs[0], vs[len(vs)/3], vs[len(vs)/2], vs[len(vs)-1]}
	for _, v := range pick {
		mm := v.Raw
		if len(v.Parts) >= 2 {
			mm = fmt.Sprintf("%d.%d", v.Parts[0], v.Parts[1])
		}
		specs = append(specs, "=="+v.Raw, v.Raw, ">="+v.Raw, "<"+v.Raw, "!="+v.Raw, "~="+mm, fmt.Sprintf("==%d.*", v.Parts[0]),
			" >= "+mm+" , < "+fmt.Sprint(v.Parts[0]+1), "<="+mm+",>=0.1")
	}
	return specs
}

var pkgNames = map[string][]string{
	"python": {"requests", "Black"}, "python2": {"virtualenv"}, "node": {"left-pad", "@scope/tool"},
	"ruby": {"rake"}, "dotnet": {"dotnet-ef"}, "go": {"github.com/user/tool/v2", "golang.org/x/tools/cmd/stringer"},
	"rust": {"ripgrep"},
}

func writeCases(cat *catalog.Catalog, file string) {
	g := &gen{cat: cat}
	rnd := rand.New(rand.NewSource(1))
	src := &srcJSON{Name: "app-1.0.tar.gz", SHA256: strings.Repeat("ab", 32), Size: 12345, Format: "tar.gz", Strip: 1,
		URLs: []string{"https://example.com/app-1.0.tar.gz", "http://10.0.0.1/app.tar.gz"}}
	platformSets := [][]string{nil, {"windows"}, {"macos"}, {"linux"}, {"linux", "macos"}, {"windows", "linux", "macos"}, {"bogus"}, {}}
	for _, id := range cat.Policy.RuntimeIDs() {
		pol := cat.Policy.Runtimes[id]
		base := appJSON{Name: "Test " + id, Project: "proj", Runtime: id, Select: "newest", Launch: pol.Launch, Console: true, Menu: true}
		if base.Launch == "" {
			base.Launch = "{runtime} main"
		}
		g.resolve("base", base)
		a := base
		a.Select = "asyncio"
		g.resolve("asyncio", a)
		specs := versionSpecs(cat.Runtimes[id])
		for _, s := range specs {
			for _, sel := range []string{"range", "exact"} {
				a := base
				a.Select, a.Range = sel, s
				g.resolve(sel+" "+s, a)
			}
		}
		a = base
		a.Select, a.Range = "bogus", ">=1"
		g.resolve("unknown select", a)
		installs := []string{"", "default", `"{runtime}" -m build --out {app_dir}/out "{app_dir}/x y" {env:JAVA_HOME}{env:GEM_HOME}{env:NOPE}`,
			"make {project}{exe} {data_dir}/c", "default:nope"}
		for _, r := range pol.InstallRules {
			installs = append(installs, "default:"+r.ID)
		}
		for _, in := range installs {
			a := base
			a.Install = in
			g.resolve("install "+in, a)
			a.Select, a.Range = "range", specs[len(specs)-9]
			g.resolve("install+range "+in, a)
		}
		launches := []string{"", "{runtime} {app_dir}/main.py --x", `"{app_dir}/bin/app" {runtime} {version}`, `{app_dir}\x{exe} {env:JAVA_HOME} {env:PATH}`}
		for _, l := range launches {
			a := base
			a.Launch = l
			g.resolve("launch "+l, a)
		}
		for i, ps := range platformSets {
			a := base
			a.Platforms = ps
			g.resolve(fmt.Sprint("platforms ", i), a)
		}
		flags := []func(*appJSON){
			func(a *appJSON) { a.Console = false },
			func(a *appJSON) { a.Menu, a.Desktop = false, true },
			func(a *appJSON) { a.Root, a.RootName = "system", "myib" },
			func(a *appJSON) { a.Root, a.RootName, a.Console, a.Menu, a.Desktop = "user", "", false, false, false },
			func(a *appJSON) { a.Name, a.Project = "Tab\there\nnewline\r", "p q" },
			func(a *appJSON) { a.Source = src },
			func(a *appJSON) { a.RecordHash = "preview" },
		}
		for i, f := range flags {
			a := base
			f(&a)
			g.resolve(fmt.Sprint("flags ", i), a)
		}
		// Package sources, where the policy has a package section (and one
		// where it doesn't, which resolves as a plain app).
		names := pkgNames[id]
		if pol.Package == nil {
			names = []string{"something"}
		}
		for _, n := range names {
			for _, ver := range []string{"", "1.2.3"} {
				for _, in := range []string{"", "default", "custom {package} {name}", "default:nope"} {
					a := base
					a.Package, a.PackageVersion, a.Install, a.Project = n, ver, in, n
					if pol.Package != nil {
						a.Launch = pol.Package.Launch
						if a.Launch == "" {
							a.Launch = "{runtime} -m {project}"
						}
					}
					g.resolve("package "+n+" "+ver+" "+in, a)
				}
			}
			a := base
			a.Package, a.Platforms, a.Select, a.Range = n, []string{"windows"}, "range", specs[len(specs)-7]
			g.resolve("package windows range", a)
		}
		// Combinations.
		for i := 0; i < 40; i++ {
			a := base
			switch rnd.Intn(4) {
			case 1:
				a.Select = "asyncio"
			case 2, 3:
				a.Select, a.Range = []string{"range", "exact"}[rnd.Intn(2)], specs[rnd.Intn(len(specs))]
			}
			a.Install = installs[rnd.Intn(len(installs))]
			a.Launch = launches[rnd.Intn(len(launches))]
			a.Platforms = platformSets[rnd.Intn(len(platformSets))]
			flags[rnd.Intn(len(flags))](&a)
			if rnd.Intn(3) == 0 && pol.Package != nil {
				a.Package = names[rnd.Intn(len(names))]
				if rnd.Intn(2) == 0 {
					a.PackageVersion = "0.9"
				}
			}
			g.resolve(fmt.Sprint("combo ", i), a)
		}
	}
	for _, id := range []string{"nope", "", "constructor", "__proto__", "toString", "Python", "python "} {
		g.resolve("unknown runtime", appJSON{Runtime: id, Select: "newest"})
	}

	// Package helpers.
	ids := append(cat.Policy.RuntimeIDs(), "nope", "constructor")
	names := []string{"requests", "Requests", "@scope/tool", "@Scope/Tool", "left-pad", "a..b", "a b", "", "x", "github.com/user/tool/v2",
		"github.com/User/Tool", "rip_grep", strings.Repeat("a", 120), "naïve", "İx", "-bad", "a;b", "a/b", "golang.org/x/tools/cmd/stringer", "\"q\""}
	for _, rt := range ids {
		for _, n := range names {
			v, err := cat.ValidPackage(rt, n, "")
			g.add(map[string]any{"kind": "validPackage", "runtime": rt, "name": n, "version": "", "result": v}, err)
		}
		for _, ver := range []string{"1.2.3", "1.0.0-beta.1", "bad version", "1;2", "*", "\t", "=1"} {
			v, err := cat.ValidPackage(rt, "requests", ver)
			g.add(map[string]any{"kind": "validPackage", "runtime": rt, "name": "requests", "version": ver, "result": v}, err)
		}
		p, err := cat.PackagePolicyFor(rt)
		g.add(map[string]any{"kind": "packagePolicyFor", "runtime": rt, "has": p != nil}, err)
		if p == nil {
			continue
		}
		for _, n := range append(names, "/github.com/a/b/v3/", "x/v2", "v2", "@scope", "@/x") {
			g.add(map[string]any{"kind": "packageProject", "runtime": rt, "name": n, "result": catalog.PackageProject(p, n)}, nil)
		}
		inputs := []string{"{package} {name} {version} {name}{version} {{name}}", p.Launch}
		for _, f := range []string{"windows", "linux", "macos"} {
			inputs = append(inputs, p.Install[f])
		}
		for _, in := range inputs {
			for _, nv := range [][2]string{{"requests", ""}, {"@s/t", "1.0"}, {"{version}", "{name}"}} {
				g.add(map[string]any{"kind": "packageTokens", "runtime": rt, "name": nv[0], "version": nv[1], "input": in,
					"result": catalog.PackageTokens(p, nv[0], nv[1]).Replace(in)}, nil)
			}
		}
	}
	for _, n := range append(names, "Zope.Interface", "ΣΑΣ") {
		g.add(map[string]any{"kind": "packageProject", "runtime": "", "name": n, "result": catalog.PackageProject(nil, n)}, nil)
		g.add(map[string]any{"kind": "packageModule", "name": n, "result": catalog.PackageModule(n)}, nil)
	}
	bins := []string{`null`, `"bin/cli.js"`, `"./bin/cli.js"`, `["b", "a", 3]`, `["proj", "a"]`, `{"b": "./b.js", "a": "a.js"}`,
		`{"proj": "p.js", "a": "a.js"}`, `{"x": 1}`, `[]`, `"../evil"`, `{"bad name": "x"}`, `"a b"`, `42`, `{"a": "x/../y"}`, `["-x"]`}
	for _, b := range bins {
		var v any
		json.Unmarshal([]byte(b), &v)
		for _, project := range []string{"proj", "a"} {
			name, path, err := catalog.PickBin(v, project)
			g.add(map[string]any{"kind": "pickBin", "v": json.RawMessage(b), "project": project, "name": name, "path": path}, err)
		}
	}
	docs := []string{`{"info": {"version": "1.2", "n": null}, "a": [1]}`, `{"version": "3"}`, `[1, 2]`, `"s"`, `null`}
	for _, d := range docs {
		var v any
		json.Unmarshal([]byte(d), &v)
		for _, p := range []string{"", "info.version", "version", "info", "a.0", "info.n", "info.version.x", "missing", "."} {
			g.add(map[string]any{"kind": "jsonField", "v": json.RawMessage(d), "path": p, "result": catalog.JSONField(v, p)}, nil)
		}
	}
	for _, t := range []string{"", "abc", "preview/app", "ünïcode ☃ 𝄞", strings.Repeat("x", 1000)} {
		g.add(map[string]any{"kind": "hash", "text": t, "hash26": ibtext.Hash26([]byte(t)), "hash12": ibtext.Hash12(t)}, nil)
	}
	b, err := json.Marshal(map[string]any{"cases": g.cases, "summary": json.RawMessage(cat.RuntimesSummary())})
	if err != nil {
		log.Fatal(err)
	}
	if err := os.WriteFile(file, b, 0o644); err != nil {
		log.Fatal(err)
	}
	log.Printf("%d cases written to %s", len(g.cases), file)
}
