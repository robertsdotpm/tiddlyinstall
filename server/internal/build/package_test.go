package build

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
)

// testBuilder uses the repo's policy with a registry served by srv.
func testBuilder(t *testing.T, srv *httptest.Server) *Builder {
	t.Helper()
	_, me, _, _ := runtime.Caller(0)
	pol, err := catalog.LoadPolicy(filepath.Join(filepath.Dir(me), "..", "..", "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	cat := &catalog.Catalog{Policy: pol, Runtimes: map[string]*catalog.Runtime{}}
	for id := range pol.Runtimes {
		cat.Runtimes[id] = &catalog.Runtime{ID: id}
	}
	if srv != nil {
		n := pol.Runtimes["node"].Package
		n.Lookup = srv.URL + "/npm/{name}/latest"
		n.LookupVersion = srv.URL + "/npm/{name}/{version}"
		p := pol.Runtimes["python"].Package
		p.Lookup = srv.URL + "/pypi/{name}/json"
		p.LookupVersion = srv.URL + "/pypi/{name}/{version}/json"
	}
	return &Builder{Cat: cat, Data: t.TempDir(), Public: "http://127.0.0.1:1", Backend: "http://127.0.0.1:1", HTTP: http.DefaultClient}
}

func registry() *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/npm/cowsay/latest", "/npm/cowsay/1.6.0":
			w.Write([]byte(`{"name":"cowsay","version":"1.6.0","bin":{"cowsay":"./cli.js","cowthink":"./cli.js"}}`))
		case "/npm/evil/latest":
			w.Write([]byte(`{"version":"1.0.0","bin":{"evil":"x.js\" & calc & \""}}`))
		case "/npm/badver/latest":
			w.Write([]byte(`{"version":"1.0; rm -rf ~"}`))
		case "/npm/@antfu/ni/latest", "/npm/@antfu/ni/30.6.0":
			w.Write([]byte(`{"name":"@antfu/ni","version":"30.6.0","bin":{"na":"bin/na.mjs","ni":"bin/ni.mjs","nr":"bin/nr.mjs"}}`))
		case "/npm/@scope/strbin/latest", "/npm/@scope/strbin/2.0.0":
			w.Write([]byte(`{"version":"2.0.0","bin":"./cli.js"}`))
		case "/npm/@evil/pkg/latest", "/npm/@evil/pkg/1.0.0":
			w.Write([]byte(`{"version":"1.0.0","bin":{"pkg":"$(id).js"}}`))
		case "/npm/@evil/ver/latest":
			w.Write([]byte(`{"version":"1.0\" & calc & \"","bin":"cli.js"}`))
		case "/pypi/httpie/json":
			w.Write([]byte(`{"info":{"version":"3.2.4"}}`))
		default:
			http.NotFound(w, r)
		}
	}))
}

func TestLookupPackage(t *testing.T) {
	srv := registry()
	defer srv.Close()
	b := testBuilder(t, srv)
	ctx := context.Background()

	info, err := b.LookupPackage(ctx, "node", "cowsay", "")
	if err != nil || info.Version != "1.6.0" || info.Bin != "cowsay" || info.BinPath != "cli.js" {
		t.Fatalf("npm cowsay: %+v %v", info, err)
	}
	l, err := PackageLaunch("{runtime} {app_dir}/node_modules/{name}/{bin_path}", "node", b.Cat.Policy.Runtimes["node"].Package, "cowsay", info)
	if err != nil || l != "{runtime} {app_dir}/node_modules/cowsay/cli.js" {
		t.Errorf("launch %q %v", l, err)
	}
	if info, err := b.LookupPackage(ctx, "python", "httpie", ""); err != nil || info.Version != "3.2.4" {
		t.Errorf("pypi httpie: %+v %v", info, err)
	}
	if _, err := b.LookupPackage(ctx, "python", "no-such-thing", ""); !errors.Is(err, ErrNoPackage) {
		t.Errorf("missing package: %v", err)
	}
	// Registry answers are untrusted: nothing unsafe reaches a command.
	if _, err := b.LookupPackage(ctx, "node", "evil", ""); err == nil {
		t.Error("accepted a bin path with shell characters")
	}
	if _, err := b.LookupPackage(ctx, "node", "badver", ""); err == nil {
		t.Error("accepted a version with shell characters")
	}
	// Scoped npm names: the registry is asked at /@scope/name, and the
	// program is the bin named like the unscoped name.
	info, err = b.LookupPackage(ctx, "node", "@antfu/ni", "")
	if err != nil || info.Version != "30.6.0" || info.Bin != "ni" || info.BinPath != "bin/ni.mjs" {
		t.Fatalf("npm @antfu/ni: %+v %v", info, err)
	}
	np := b.Cat.Policy.Runtimes["node"].Package
	l, err = PackageLaunch(np.Launch, "node", np, "@antfu/ni", info)
	if err != nil || l != "{runtime} {app_dir}/node_modules/@antfu/ni/bin/ni.mjs" {
		t.Errorf("scoped launch %q %v", l, err)
	}
	if info, err := b.LookupPackage(ctx, "node", "@scope/strbin", ""); err != nil || info.Bin != "strbin" || info.BinPath != "cli.js" {
		t.Errorf("scoped string bin: %+v %v", info, err)
	}
	for _, evil := range []string{"@evil/pkg", "@evil/ver"} {
		if _, err := b.LookupPackage(ctx, "node", evil, ""); err == nil {
			t.Errorf("%s: accepted shell characters from the registry", evil)
		}
	}
	// No lookup configured (Go): the name is passed through unpinned.
	if info, err := b.LookupPackage(ctx, "go", "golang.org/x/example/hello", ""); err != nil || info.Version != "" {
		t.Errorf("go: %+v %v", info, err)
	}
}

func TestNameRecord(t *testing.T) {
	b := testBuilder(t, nil)
	h1, err := b.NameRecord("python", "Cowsay")
	if err != nil {
		t.Fatal(err)
	}
	h2, err := b.NameRecord("python", "cowsay")
	if err != nil || h1 != h2 {
		t.Fatalf("the same name should give the same record: %s %s %v", h1, h2, err)
	}
	rec, _ := os.ReadFile(b.RecordPath(h1))
	s := string(rec)
	for _, want := range []string{"source\tpackage\tcowsay\n", "launch\t{runtime} -m cowsay\n", "install\tdefault\n", "origin\tname\n"} {
		if !strings.Contains(s, want) {
			t.Errorf("record lacks %q:\n%s", want, s)
		}
	}
	if strings.Contains(s, "created") {
		t.Error("a name record must not carry a timestamp (its hash must be stable)")
	}
	app, _, err := b.LoadApp(h1)
	if err != nil || app.Package != "cowsay" || app.PackageVersion != "" {
		t.Errorf("LoadApp: %+v %v", app, err)
	}
	for _, bad := range [][2]string{{"python", "a;b"}, {"python", "../x"}, {"java", "x"}, {"nope", "x"}} {
		if _, err := b.NameRecord(bad[0], bad[1]); err == nil {
			t.Errorf("accepted %v", bad)
		}
	}
	// Scoped names can't be carried by a file name (PlainNameOK).
	if _, err := b.NameRecord("node", "@antfu/ni"); err == nil {
		t.Error("a plain-name record for a scoped package")
	}
	h3, _ := b.NameRecord("node", "cowsay")
	if h3 == h1 {
		t.Error("different runtimes must give different records")
	}
}

func TestValidateVersion(t *testing.T) {
	b := testBuilder(t, nil)
	r := Request{Runtime: "python", Mode: "C"}
	r.Source.Kind, r.Source.Value, r.Source.Version = "package", "requests", "2.32.3; echo INJECTED #"
	if _, err := r.Validate(b.Cat); err == nil {
		t.Error("accepted a version with shell characters")
	}
	r.Source.Version = "2.32.3"
	if _, err := r.Validate(b.Cat); err != nil {
		t.Error(err)
	}
	r.Runtime = "php"
	if _, err := r.Validate(b.Cat); err == nil {
		t.Error("php has no package policy yet; should be refused")
	}
}

func TestValidateScoped(t *testing.T) {
	b := testBuilder(t, nil)
	r := Request{Runtime: "node", Mode: "C"}
	r.Source.Kind, r.Source.Value = "package", " @Antfu/ni "
	if _, err := r.Validate(b.Cat); err != nil || r.Source.Value != "@antfu/ni" {
		t.Errorf("scoped name: %q %v", r.Source.Value, err)
	}
	for _, bad := range []string{`@antfu/ni" & calc & "`, "@antfu/ni;id", "@antfu/$(id)", "@antfu/ni@1.0.0", "@antfu/../x", "@antfu/ni\\x"} {
		r.Source.Value = bad
		if _, err := r.Validate(b.Cat); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

// The record's install comes from the files the source has.
func TestProjectInstall(t *testing.T) {
	b := testBuilder(t, nil)
	py := b.Cat.Policy.Runtimes["python"]
	_, reqOnly, err := inlineTarball("app", map[string]string{"main.py": "import cowsay", "requirements.txt": "cowsay\n"})
	if err != nil {
		t.Fatal(err)
	}
	data, _, _ := inlineTarball("app", map[string]string{"pyproject.toml": "", "requirements.txt": "", "app/__init__.py": ""})
	proj, _ := tarNames(data)
	for _, tc := range []struct {
		rt, given string
		pkg       bool
		names     []string
		want      string
		err       bool
	}{
		{"python", "", false, reqOnly, "default:requirements", false},
		{"python", "", false, proj, "default:project", false},
		{"python", "", false, []string{"main.py"}, "", false},
		{"python", "", false, []string{"main.py", "setup.cfg"}, "", false},
		{"python", "my own command", false, reqOnly, "my own command", false},
		{"python", "", true, nil, "default", false},
		{"node", "", false, []string{"package.json", "index.js"}, "default:npm", false},
		{"ruby", "", false, []string{"Gemfile"}, "default:bundler", false},
		{"php", "", false, []string{"composer.json", "index.php"}, "", true},
		{"php", "php my-install.php", false, []string{"composer.json"}, "php my-install.php", false},
		{"php", "", false, []string{"index.php"}, "", false},
		{"rust", "", false, nil, "default", false},
	} {
		got, err := projectInstall(b.Cat.Policy.Runtimes[tc.rt], tc.given, tc.pkg, tc.names)
		if got != tc.want || (err != nil) != tc.err {
			t.Errorf("%s %v: %q %v, want %q", tc.rt, tc.names, got, err, tc.want)
		}
	}
	if py.Rule("requirements") == nil {
		t.Error("python has no requirements rule")
	}
}
