package catalog

import "testing"

func TestVersions(t *testing.T) {
	for _, c := range []struct {
		v   string
		pre bool
	}{{"3.13.0rc1", true}, {"1.0.0-beta.2", true}, {"16.2.0posix-14.0.0-ucrt-r1", false}, {"3.14.7", false}, {"0.15.0-dev.12", true}, {"26.9.0", false}} {
		if got := ParseVersion(c.v).Pre; got != c.pre {
			t.Errorf("%s: pre=%v", c.v, got)
		}
	}
	for _, c := range []struct {
		v, spec string
		ok      bool
	}{{"3.12.4", ">=3.8, <3.13, !=3.9.0", true}, {"3.9.0", ">=3.8, !=3.9.0", false}, {"3.12.4", "==3.12.*", true},
		{"3.13.0", "~=3.10", true}, {"4.0", "~=3.10", false}, {"1.20.14", "<1.27", true}} {
		if got := Matches(ParseVersion(c.v), c.spec); got != c.ok {
			t.Errorf("%s %s: %v", c.v, c.spec, got)
		}
	}
}

func TestQuoteAppPaths(t *testing.T) {
	for in, want := range map[string]string{
		"{runtime} {app_dir}/index.js":    `{runtime} "{app_dir}/index.js"`,
		`{runtime} "{app_dir}/index.js"`:  `{runtime} "{app_dir}/index.js"`,
		"{app_dir}/hello{exe}":            `"{app_dir}/hello{exe}"`,
		`javac -d "{app_dir}" Hello.java`: `javac -d "{app_dir}" Hello.java`,
		"{runtime} -cp {app_dir} Hello":   `{runtime} -cp "{app_dir}" Hello`,
	} {
		if got := quoteAppPaths(in); got != want {
			t.Errorf("%q: got %q", in, got)
		}
	}
}
