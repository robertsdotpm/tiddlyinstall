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
