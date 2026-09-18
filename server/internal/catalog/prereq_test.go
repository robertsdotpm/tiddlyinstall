package catalog

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

// blockFor returns the lines of the block an engine would pick for this
// machine (the first whose when matches), or nil.
func blockFor(plan, family string, ver int, arch string) []ibtext.Line {
	var cur []ibtext.Line
	in, match := false, false
	for _, raw := range strings.Split(plan, "\n") {
		if raw == "[target]" {
			if match {
				return cur
			}
			cur, in = nil, true
			continue
		}
		if !in || raw == "" {
			continue
		}
		p := strings.Split(raw, "\t")
		l := ibtext.Line{Key: p[0], Vals: p[1:]}
		if l.Key == "when" && l.Val(0) == family {
			lo, _ := strconv.Atoi(l.Val(1))
			hi, _ := strconv.Atoi(l.Val(2))
			if ver >= lo && ver <= hi {
				for _, a := range strings.Fields(l.Val(3)) {
					if a == arch || a == "*" {
						match = true
					}
				}
			}
		}
		cur = append(cur, l)
	}
	if match {
		return cur
	}
	return nil
}

// PHP on Windows gets the VC++ redistributable for its own architecture,
// checked by registry, written before the runtime's file.
func TestPHPWindowsNeedsVCRedist(t *testing.T) {
	c := realCatalog(t)
	plan := resolve(t, c, &App{Runtime: "php", Launch: "{runtime} {app_dir}/index.php", Platforms: []string{"windows"}})
	cases := []struct {
		ver        int
		arch, need string
		view, key  string
	}{
		{603, "amd64", "vcredist-x64", "64", `Runtimes\x64`},
		{1000, "amd64", "vcredist-x64", "64", `Runtimes\x64`},
		{603, "x86", "vcredist-x86", "32", `Runtimes\x86`},
		{601, "amd64", "vcredist-x64", "64", `Runtimes\x64`},
	}
	for _, tc := range cases {
		b := blockFor(plan, "windows", tc.ver, tc.arch)
		if b == nil {
			t.Fatalf("no block for windows %d %s", tc.ver, tc.arch)
		}
		needs := keys(b, "need")
		if len(needs) != 1 || !strings.HasPrefix(needs[0], tc.need+"\t") {
			t.Fatalf("windows %d %s: needs %q, want %s", tc.ver, tc.arch, needs, tc.need)
		}
		chk := keys(b, "ncheck")
		if len(chk) != 1 || !strings.HasPrefix(chk[0], "reg\t"+tc.view+"\tHKLM\\") || !strings.Contains(chk[0], tc.key+"\tMinor\t44") {
			t.Errorf("windows %d %s: check %q", tc.ver, tc.arch, chk)
		}
		if run := keys(b, "nrun"); len(run) != 1 || run[0] != `"{file}" /install /quiet /norestart` {
			t.Errorf("nrun %q", run)
		}
		if ok := keys(b, "nok"); len(ok) != 1 || ok[0] != "0 1638 3010" {
			t.Errorf("nok %q", ok)
		}
		nf := keys(b, "nfile")
		if len(nf) != 1 || !strings.HasPrefix(nf[0], "vc_redist.") {
			t.Fatalf("nfile %q", nf)
		}
		urls := keys(b, "nurl")
		if len(urls) < 2 || !strings.Contains(urls[0], "/mirror/msvc-redist/windows/") {
			t.Errorf("nurl %q: want our mirror first", urls)
		}
		// Prerequisites come before the first file, so an older engine that
		// doesn't know them can't attach their lines to a file.
		iNeed, iFile := -1, -1
		for i, l := range b {
			if l.Key == "need" && iNeed < 0 {
				iNeed = i
			}
			if l.Key == "file" && iFile < 0 {
				iFile = i
			}
		}
		if !(iNeed >= 0 && iNeed < iFile) {
			t.Errorf("need at %d, first file at %d", iNeed, iFile)
		}
	}
	// PHP 5.6 (VC11) on Vista: not this redistributable.
	if b := blockFor(plan, "windows", 600, "amd64"); b == nil || len(keys(b, "need")) != 0 {
		t.Errorf("Vista block should have no need: %v", keys(b, "need"))
	}
}

// Offline packs carry the prerequisite's installer too.
func TestPrereqFileIsPacked(t *testing.T) {
	c := realCatalog(t)
	_, files, err := c.ResolveFiles(&App{RecordHash: "testtesttesttesttesttestte", Project: "hello", Runtime: "php",
		Launch: "{runtime} {app_dir}/index.php", Platforms: []string{"windows"}})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, f := range files {
		if f.Name == "vc_redist.x64.exe" {
			found = true
			if f.SHA256 != "cc0ff0eb1dc3f5188ae6300faef32bf5beeba4bdd6e8e445a9184072096b713b" || f.Local == "" {
				t.Errorf("vc_redist.x64.exe: %+v", f)
			}
		}
	}
	if !found {
		t.Error("vc_redist.x64.exe not among the plan's files")
	}
}

// Linux prerequisites are distro packages with a check; only the releases
// that need them get them.
func TestLinuxNeeds(t *testing.T) {
	c := realCatalog(t)
	node := resolve(t, c, &App{Runtime: "node", Launch: "{runtime} {app_dir}", Platforms: []string{"linux"}})
	b := blockFor(node, "linux", 235, "amd64")
	if n := keys(b, "need"); len(n) != 1 || !strings.HasPrefix(n[0], "libatomic\t") {
		t.Fatalf("node on glibc 2.35: needs %q", n)
	}
	if ch := keys(b, "ncheck"); len(ch) != 1 || ch[0] != "lib\tlibatomic.so.1" {
		t.Errorf("check %q", ch)
	}
	pk := strings.Join(keys(b, "npkg"), "\n")
	for _, want := range []string{"apt-get\tlibatomic1", "dnf\tlibatomic", "apk\tlibatomic", "zypper\tlibatomic1"} {
		if !strings.Contains(pk, want) {
			t.Errorf("npkg lacks %q:\n%s", want, pk)
		}
	}
	// Node 17 (glibc 2.17) doesn't link libatomic.
	if b := blockFor(node, "linux", 217, "amd64"); len(keys(b, "need")) != 0 {
		t.Errorf("node on glibc 2.17 got %q", keys(b, "need"))
	}

	rust := resolve(t, c, &App{Runtime: "rust", Launch: "{app_dir}/target/release/hello", Platforms: []string{"linux", "macos"}})
	if n := keys(blockFor(rust, "linux", 235, "amd64"), "ncheck"); len(n) != 1 || n[0] != "cmd\tcc" {
		t.Errorf("rust linux checks %q", n)
	}
	mac := blockFor(rust, "macos", 1500, "arm64")
	if n := keys(mac, "need"); len(n) != 1 || !strings.HasPrefix(n[0], "xcode-clt\t") {
		t.Fatalf("rust macOS needs %q", n)
	}
	if len(keys(mac, "npkg")) != 0 || len(keys(mac, "nstart")) != 1 || len(keys(mac, "nhow")) != 1 {
		t.Errorf("xcode-clt: want nstart and nhow, no packages")
	}

	r := resolve(t, c, &App{Runtime: "r", Launch: "{runtime} {app_dir}/main.R", Platforms: []string{"linux"}})
	var ids []string
	for _, n := range keys(blockFor(r, "linux", 235, "amd64"), "need") {
		ids = append(ids, strings.SplitN(n, "\t", 2)[0])
	}
	if strings.Join(ids, ",") != "libblas,libgomp,libdeflate" {
		t.Errorf("R on Ubuntu 22.04 needs %v", ids)
	}
}

// min_os/max_os split blocks: a prerequisite limited to old Windows puts
// Windows 10 in a block of its own without it.
func TestNeedOSBoundsSplitBlocks(t *testing.T) {
	c := realCatalog(t)
	pol := *c.Policy.Runtimes["php"]
	pol.Needs = append([]NeedRule(nil), pol.Needs...)
	pol.Needs[0].MaxOS = 603
	saved := c.Policy.Runtimes["php"]
	c.Policy.Runtimes["php"] = &pol
	defer func() { c.Policy.Runtimes["php"] = saved }()
	plan := resolve(t, c, &App{Runtime: "php", Launch: "{runtime} {app_dir}/index.php", Platforms: []string{"windows"}})
	if n := keys(blockFor(plan, "windows", 1000, "amd64"), "need"); len(n) != 0 {
		t.Errorf("Windows 10 got %q", n)
	}
	if n := keys(blockFor(plan, "windows", 603, "amd64"), "need"); len(n) != 1 {
		t.Errorf("Windows 8.1 got %q", n)
	}
	b10 := blockFor(plan, "windows", 1000, "amd64")
	if w := keys(b10, "when"); len(w) != 1 || !strings.HasPrefix(w[0], "windows\t1000\t") {
		t.Errorf("Windows 10 block starts at %q", w)
	}
}

// Policy mistakes fail at load.
func TestPrereqPolicyValidation(t *testing.T) {
	_, me, _, _ := runtime.Caller(0)
	good, err := os.ReadFile(filepath.Join(filepath.Dir(me), "..", "..", "policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := LoadPolicy(filepath.Join(filepath.Dir(me), "..", "..", "policy.json")); err != nil {
		t.Fatalf("the repo's policy: %v", err)
	}
	// Compacted, so the patterns don't depend on how the file is laid out.
	var cb bytes.Buffer
	if err := json.Compact(&cb, good); err != nil {
		t.Fatal(err)
	}
	good = cb.Bytes()
	bad := map[string][2]string{
		"unknown prerequisite": {`"prerequisites":["libatomic"]`, `"prerequisites":["libatomicc"]`},
		"shell in a package":   {`"apt-get":"libatomic1"`, `"apt-get":"libatomic1; rm -rf /"`},
		"unknown check":        {`["lib","libatomic.so.1"]`, `["exec","true"]`},
		"lib check on windows": {`["reg","64","HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64","Minor","44"]`, `["lib","x"]`},
		"bad sha":              {`"sha256":"cc0ff0eb`, `"sha256":"CC0ff0eb`},
		"bad registry root":    {`"HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x86"`, `"HKXX\\SOFTWARE"`},
	}
	for name, r := range bad {
		s := string(good)
		if !strings.Contains(s, r[0]) {
			t.Fatalf("%s: %q not in policy.json", name, r[0])
		}
		p := filepath.Join(t.TempDir(), "policy.json")
		os.WriteFile(p, []byte(strings.Replace(s, r[0], r[1], 1)), 0o644)
		if _, err := LoadPolicy(p); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
