package catalog

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

// realCatalog loads the runtime catalogue this repo is built against, with
// the repo's policy. Tests that need it skip when it isn't checked out.
func realCatalog(t *testing.T) *Catalog {
	t.Helper()
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, "projects", "installer-builder-runtimes", "catalog")
	if _, err := os.Stat(dir); err != nil {
		t.Skip("runtime catalogue not found")
	}
	_, me, _, _ := runtime.Caller(0)
	policy := filepath.Join(filepath.Dir(me), "..", "..", "policy.json")
	// Some releases' checksums come from our own copies (catalog.sha); use
	// a scratch copy of the server's hash cache so nothing is rehashed.
	cache := filepath.Join(t.TempDir(), "sha-cache.json")
	if b, err := os.ReadFile(filepath.Join(filepath.Dir(me), "..", "..", "data", "sha-cache.json")); err == nil {
		os.WriteFile(cache, b, 0o644)
	}
	c, err := Load(dir, policy, filepath.Dir(dir), cache)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

// block returns the lines of the first plan block whose covers line
// contains label.
func blockOf(t *testing.T, plan, label string) []ibtext.Line {
	t.Helper()
	var cur []ibtext.Line
	found := false
	for _, l := range ibtext.Parse(plan) {
		if l.Key == "when" {
			if found {
				return cur
			}
			cur = nil
		}
		if l.Key == "covers" && strings.Contains(l.Val(0), label) {
			found = true
		}
		cur = append(cur, l)
	}
	if !found {
		t.Fatalf("no block covering %q in plan:\n%s", label, plan)
	}
	return cur
}

func keys(ls []ibtext.Line, k string) []string {
	var out []string
	for _, l := range ls {
		if l.Key == k {
			out = append(out, strings.Join(l.Vals, "\t"))
		}
	}
	return out
}

func resolve(t *testing.T, c *Catalog, app *App) string {
	t.Helper()
	if app.RecordHash == "" {
		app.RecordHash = "testtesttesttesttesttestte"
	}
	if app.Project == "" {
		app.Project = "hello"
	}
	p, err := c.Resolve(app)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// The embeddable Python without pip serves apps that install nothing; the
// get-pip recipe, with get-pip.py as an extra plan file, serves the rest.
func TestPipRecipeOnlyWhenInstalling(t *testing.T) {
	c := realCatalog(t)
	plain := blockOf(t, resolve(t, c, &App{Runtime: "python", Launch: "{runtime} -m hello", Platforms: []string{"windows"}}), "Windows 10")
	for _, f := range keys(plain, "file") {
		if strings.HasPrefix(f, "get-pip") {
			t.Errorf("an app with nothing to install got get-pip.py: %s", f)
		}
	}
	if s := strings.Join(keys(plain, "step"), "\n"); !strings.Contains(s, "write\t{runtime_dir}\\python3") || !strings.Contains(s, "{app_dir}") {
		t.Errorf("no-install app should get the ._pth recipe with {app_dir}; steps:\n%s", s)
	}

	for _, app := range []*App{
		{Runtime: "python", Launch: "{runtime} -m cowsay", Package: "cowsay", Platforms: []string{"windows"}},
		{Runtime: "python", Launch: "{runtime} -m hello", Install: "default", Platforms: []string{"windows"}},
	} {
		b := blockOf(t, resolve(t, c, app), "Windows 10")
		files := keys(b, "file")
		if len(files) != 2 || !strings.HasPrefix(files[0], "python\t") || !strings.HasPrefix(files[1], "get-pip\tget-pip.py\t") {
			t.Fatalf("want the runtime then get-pip.py, got %q", files)
		}
		// Order: runtime file, its steps, get-pip file, copy into {tmp},
		// then the step that runs it.
		var seq []string
		for _, l := range b {
			if l.Key == "file" || l.Key == "step" {
				seq = append(seq, l.Key+"\t"+strings.Join(l.Vals, "\t"))
			}
		}
		all := strings.Join(seq, "\n")
		iGP := strings.Index(all, "file\tget-pip")
		iCopy := strings.Index(all, `copy /y "{file}" "{tmp}\get-pip.py"`)
		iRun := strings.Index(all, `"{tmp}\get-pip.py" --no-warn`)
		iPth := strings.Index(all, "import site")
		if !(iPth >= 0 && iPth < iGP && iGP < iCopy && iCopy < iRun) {
			t.Errorf("steps out of order:\n%s", all)
		}
		if strings.Contains(all, "3XX") || !strings.Contains(all, `python314._pth`) {
			t.Errorf("python3XX._pth not replaced by the version's name:\n%s", all)
		}
	}
}

// Each Python minor gets the get-pip.py made for it.
func TestGetPipPerVersion(t *testing.T) {
	c := realCatalog(t)
	want := map[string]string{
		"3.8":  "6ed6e98282a504ee0a6632856e16c39f222d313fc38be33de216d4afb6ac12f7",
		"3.9":  "95c0ae79ccf9ac1e47e4187f49081d6ae1f45997afd4549e14f37337cbcfd766",
		"3.13": "fb24e693bab954209a063d90953621412ccad4a500905a726286e038f508ddf6",
	}
	for minor, sha := range want {
		plan := resolve(t, c, &App{Runtime: "python", Select: "range", Range: "==" + minor + ".*", Package: "cowsay",
			Launch: "{runtime} -m cowsay", Platforms: []string{"windows"}})
		b := blockOf(t, plan, "Windows 10")
		files := keys(b, "file")
		if strings.Contains(files[0], "-embed-") {
			if len(files) < 2 || !strings.Contains(files[1], sha) {
				t.Errorf("Python %s: want get-pip.py %s, got %q", minor, sha, files)
			}
		} else if !strings.Contains(strings.Join(keys(b, "step"), "\n"), "ensurepip") {
			// The full installer brings pip itself (ensurepip).
			t.Errorf("Python %s: %q has neither get-pip.py nor ensurepip", minor, files)
		}
	}
	_, refs, err := c.ResolveFiles(&App{RecordHash: "testtesttesttesttesttestte", Project: "cowsay", Runtime: "python",
		Package: "cowsay", Launch: "x", Platforms: []string{"windows"}})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range refs {
		if f.Name == "get-pip.py" && f.SHA256 == want["3.13"] && len(f.URLs) > 0 {
			found = true
		}
	}
	if !found {
		t.Error("ResolveFiles doesn't list get-pip.py for offline packs")
	}
}

// Package installs come from the policy, with {package} quoted and pinned.
func TestPackageInstallCommands(t *testing.T) {
	c := realCatalog(t)
	for _, tc := range []struct {
		rt, name, version, label string
		install, launch          string
	}{
		{"python", "httpie", "3.2.4", "glibc-2.39", `-m pip install --no-warn-script-location --disable-pip-version-check "httpie==3.2.4"`, `-m httpie`},
		{"python", "httpie", "", "glibc-2.39", ` "httpie"`, ``},
		{"node", "cowsay", "1.6.0", "glibc-2.39", `npm-cli.js" install --prefix "{app_dir}" --no-audit --no-fund --no-update-notifier "cowsay@1.6.0"`, ``},
		{"ruby", "cowsay", "0.3.0", "glibc-2.39", `/bin/gem" install --no-document --install-dir "{app_dir}/gems" --bindir "{app_dir}/gems/bin" "cowsay" --version "0.3.0"`, ``},
		{"go", "golang.org/x/example/hello", "", "glibc-2.39", `/bin/go" install "golang.org/x/example/hello@latest"`, ``},
		{"rust", "ripgrep", "14.1.1", "glibc-2.39", `/bin/cargo" install --locked --root "{app_dir}" "ripgrep@14.1.1"`, ``},
		{"dotnet", "dotnetsay", "", "glibc-2.39", `tool install --tool-path "{app_dir}/bin" "dotnetsay"`, ``},
	} {
		p := c.Policy.Runtimes[tc.rt].Package
		launch := strings.NewReplacer("{name}", tc.name, "{module}", PackageModule(tc.name), "{bin}", PackageProject(p, tc.name), "{bin_path}", "cli.js").Replace(p.Launch)
		plan := resolve(t, c, &App{Runtime: tc.rt, Package: tc.name, PackageVersion: tc.version, Project: PackageProject(p, tc.name),
			Launch: launch, Install: "default", Platforms: []string{"linux"}})
		b := blockOf(t, plan, tc.label)
		ins := keys(b, "install")
		if len(ins) != 1 || !strings.Contains(ins[0], tc.install) {
			t.Errorf("%s %s: install %q, want it to contain %q", tc.rt, tc.name, ins, tc.install)
		}
		if tc.launch != "" && !strings.Contains(strings.Join(keys(b, "launch"), ""), tc.launch) {
			t.Errorf("%s: launch %q", tc.rt, keys(b, "launch"))
		}
	}
}

// Ruby gems go to the app's GEM_HOME: the policy's env replaces the
// recipe's "unset GEM_HOME" for install and launch alike.
func TestPackageEnvOverridesRecipe(t *testing.T) {
	c := realCatalog(t)
	plan := resolve(t, c, &App{Runtime: "ruby", Package: "cowsay", Launch: "{runtime} {app_dir}/gems/bin/cowsay", Platforms: []string{"linux"}})
	b := blockOf(t, plan, "glibc-2.39")
	for _, k := range []string{"unset", "iunset"} {
		for _, v := range keys(b, k) {
			if v == "GEM_HOME" || v == "GEM_PATH" {
				t.Errorf("%s %s left in the plan", k, v)
			}
		}
	}
	for _, k := range []string{"env", "ienv"} {
		if !contains(keys(b, k), "GEM_HOME\t{app_dir}/gems") {
			t.Errorf("%s GEM_HOME not set: %q", k, keys(b, k))
		}
	}
	// Without a package source the recipe's environment is unchanged.
	plain := blockOf(t, resolve(t, c, &App{Runtime: "ruby", Launch: "{runtime} x.rb", Platforms: []string{"linux"}}), "glibc-2.39")
	if !contains(keys(plain, "unset"), "GEM_HOME") {
		t.Error("the recipe's unset GEM_HOME is gone for a non-package app")
	}
}

func TestPackageUnsupportedRuntime(t *testing.T) {
	c := realCatalog(t)
	for _, rt := range []string{"java", "php", "zig", "cc"} {
		if _, err := c.ValidPackage(rt, "anything", ""); err == nil {
			t.Errorf("%s: package sources should be refused", rt)
		}
	}
}

// Names and versions end up in cmd /c and sh -c command lines.
func TestValidPackageRefusesInjection(t *testing.T) {
	c := realCatalog(t)
	good := []struct{ rt, name, ver string }{
		{"python", "requests", "2.32.3"}, {"python", "Zope.Interface", ""}, {"python", "backports.zoneinfo", "0.2.1"},
		{"node", "cowsay", "1.6.0"}, {"ruby", "cowsay", "0.3.0"}, {"rust", "ripgrep", "14.1.1"},
		{"go", "golang.org/x/tools/cmd/stringer", "v0.30.0"}, {"python", "pip", "25.*"}, {"python", "x", "1.0rc1+local.2"},
	}
	for _, g := range good {
		if _, err := c.ValidPackage(g.rt, g.name, g.ver); err != nil {
			t.Errorf("%s %s %s: %v", g.rt, g.name, g.ver, err)
		}
	}
	bad := []struct{ rt, name, ver string }{
		{"python", "requests", `2.32.3; echo INJECTED #`}, {"python", `requests"`, ""}, {"python", "a b", ""},
		{"python", "requests", "1.0 && calc"}, {"python", "requests", "%PATH%"}, {"python", "$(id)", ""},
		{"python", "requests", "`id`"}, {"node", "@scope/pkg", ""}, {"node", "../../etc", ""},
		{"go", "golang.org/x/../../evil", ""}, {"go", "golang.org/x/tools;rm", ""}, {"python", "-e", ""},
		{"python", "requests", "1|x"}, {"python", "requests", "1>x"}, {"ruby", "cowsay\\x", ""},
		{"python", strings.Repeat("a", 300), ""},
	}
	for _, b := range bad {
		if _, err := c.ValidPackage(b.rt, b.name, b.ver); err == nil {
			t.Errorf("accepted %s %q %q", b.rt, b.name, b.ver)
		}
	}
	if n, _ := c.ValidPackage("python", "Requests", ""); n != "requests" {
		t.Errorf("PyPI names should be lowercased, got %q", n)
	}
}

func TestPackageHelpers(t *testing.T) {
	p := &PackagePolicy{ProjectFrom: "last"}
	for in, want := range map[string]string{"golang.org/x/example/hello": "hello", "github.com/a/tool/v2": "tool", "example.com/x": "x"} {
		if got := PackageProject(p, in); got != want {
			t.Errorf("PackageProject(%s) = %s", in, got)
		}
	}
	if PackageModule("typing-extensions") != "typing_extensions" || PackageModule("zope.interface") != "zope_interface" {
		t.Error("PackageModule")
	}
	pp := &PackagePolicy{Spec: `"{name}=={version}"`, SpecAny: `"{name}"`}
	if s := PackageTokens(pp, "requests", "2.1").Replace("pip install {package}"); s != `pip install "requests==2.1"` {
		t.Error(s)
	}
	if s := PackageTokens(pp, "requests", "").Replace("pip install {package}"); s != `pip install "requests"` {
		t.Error(s)
	}
	for _, tc := range []struct {
		v             any
		name, path    string
		wantErr, none bool
	}{
		{v: "./cli.js", name: "cowsay", path: "cli.js"},
		{v: map[string]any{"cowthink": "./cli.js", "cowsay": "./cli.js"}, name: "cowsay", path: "cli.js"},
		{v: map[string]any{"b": "b.js", "a": "a.js"}, name: "a", path: "a.js"},
		{v: []any{"rg"}, name: "rg", path: "rg"},
		{v: map[string]any{"cowsay": "../../../x.js"}, wantErr: true},
		{v: map[string]any{"cowsay": `x.js" & calc & "`}, wantErr: true},
		{v: map[string]any{"a b": "x.js"}, wantErr: true},
		{v: nil, none: true},
	} {
		n, p, err := PickBin(tc.v, "cowsay")
		if tc.wantErr != (err != nil) || !tc.wantErr && !tc.none && (n != tc.name || p != tc.path) || tc.none && n != "" {
			t.Errorf("PickBin(%v) = %q %q %v", tc.v, n, p, err)
		}
	}
}
