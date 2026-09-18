package build

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"debug/pe"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"image"
	"image/color"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/robertsdotpm/installer-builder/server/internal/ibfile"
	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
	"github.com/robertsdotpm/installer-builder/server/internal/icon"
	"github.com/robertsdotpm/installer-builder/server/internal/queue"
)

const realBases = "/home/x/projects/installer-builder/bases"

func iconPNG(size int) []byte {
	m := image.NewNRGBA(image.Rect(0, 0, size, size))
	for i := range m.Pix {
		m.Pix[i] = uint8(i)
	}
	m.SetNRGBA(0, 0, color.NRGBA{1, 2, 3, 4})
	return icon.EncodePNG(m)
}

func iconJob(t *testing.T, b *Builder, mode string, png []byte) (Result, string) {
	t.Helper()
	r := Request{Name: "Hello", Runtime: "python", Mode: mode, Platforms: []string{"windows", "linux", "macos"},
		Files: map[string]string{"hello/__main__.py": "print('hi')"}}
	r.Source.Kind = "inline"
	r.Icon = &IconField{Choice: "custom", Data: base64.StdEncoding.EncodeToString(png), Filename: "x.png", Type: "image/png"}
	if _, err := r.Validate(b.Cat); err != nil {
		t.Fatal(err)
	}
	// As the server does on submit: store the icon, queue only its hash.
	if err := b.StoreIcon(&r); err != nil {
		t.Fatal(err)
	}
	if r.Icon.Data != "" || !IsSHA256(r.Icon.SHA256) {
		t.Fatalf("icon not replaced by its hash: %+v", r.Icon)
	}
	raw, _ := json.Marshal(r)
	res, err := b.Run(context.Background(), &queue.Job{Request: raw}, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	var out Result
	json.Unmarshal(res, &out)
	return out, r.Icon.SHA256
}

func TestIconModeC(t *testing.T) {
	if _, err := os.Stat(filepath.Join(realBases, "windows", "out", "base.exe")); err != nil {
		t.Skip("no bases")
	}
	b := testBuilder(t, nil)
	b.Bases = realBases // read only: outputs go under b.Data
	png := iconPNG(300)
	res, sha := iconJob(t, b, "C", png)

	rec, _ := os.ReadFile(b.RecordPath(res.Record))
	if ibtext.Get(ibtext.Parse(string(rec)), "icon") != sha {
		t.Fatalf("record lacks the icon:\n%s", rec)
	}
	if stored, _ := os.ReadFile(b.IconPath(sha)); !bytes.Equal(stored, png) {
		t.Fatal("icon not stored by its hash")
	}
	files := map[string][]byte{}
	for _, f := range res.Files {
		files[f.Platform], _ = os.ReadFile(filepath.Join(b.Data, "dl", res.Record, f.Name))
	}

	// Windows: icon group in the PE, block readable, checksum right.
	exe := files["windows"]
	if _, err := pe.NewFile(bytes.NewReader(exe)); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(exe, []byte(".ibrsrc")) {
		t.Fatal("no icon section")
	}
	off, _ := icon.ChecksumOffset(exe)
	if binary.LittleEndian.Uint32(exe[off:]) != icon.Checksum(exe, off) {
		t.Fatal("PE checksum wrong")
	}
	if got, _, _, _, err := ibfile.Read(exe); err != nil || !bytes.Equal(got, rec) {
		t.Fatalf("metadata block: %v", err)
	}
	base, _ := os.ReadFile(filepath.Join(realBases, "windows", "out", "base.exe"))
	nsisOverlay := base[114176:] // the base's overlay (checked in the icon package too)
	if !bytes.Contains(exe, nsisOverlay) {
		t.Fatal("NSIS overlay not preserved")
	}

	// Linux: the PNG is in the pack under its hash.
	run := files["linux"]
	got, _, packOff, packLen, err := ibfile.Read(run)
	if err != nil || !bytes.Equal(got, rec) || packLen == 0 {
		t.Fatalf("linux block: %v len %d", err, packLen)
	}
	tr := tar.NewReader(bytes.NewReader(run[packOff : packOff+packLen]))
	h, err := tr.Next()
	if err != nil || h.Name != sha {
		t.Fatalf("pack member %v %v", h, err)
	}
	if data, _ := io.ReadAll(tr); !bytes.Equal(data, png) {
		t.Fatal("pack icon differs")
	}

	// macOS: icns and plist.
	z := files["macos"]
	zr, err := zip.NewReader(bytes.NewReader(z), int64(len(z)))
	if err != nil {
		t.Fatal(err)
	}
	var sawIcns, sawPlist bool
	for _, f := range zr.File {
		switch {
		case strings.HasSuffix(f.Name, "/Contents/Resources/AppIcon.icns"):
			r, _ := f.Open()
			d, _ := io.ReadAll(r)
			sawIcns = bytes.HasPrefix(d, []byte("icns"))
		case strings.HasSuffix(f.Name, "/Contents/Info.plist"):
			r, _ := f.Open()
			d, _ := io.ReadAll(r)
			sawPlist = bytes.Contains(d, []byte("<key>CFBundleIconFile</key><string>AppIcon</string>"))
		case strings.HasSuffix(f.Name, "/Contents/MacOS/install"):
			if f.Mode().Perm()&0o111 == 0 {
				t.Fatal("macOS launcher lost its exec bit")
			}
		}
	}
	if !sawIcns || !sawPlist {
		t.Fatalf("macOS icon: icns %v plist %v", sawIcns, sawPlist)
	}
}

// Mode A: the record names the icon, but the files are not changed.
func TestIconModeAUntouched(t *testing.T) {
	if _, err := os.Stat(filepath.Join(realBases, "windows", "out", "base.exe")); err != nil {
		t.Skip("no bases")
	}
	b := testBuilder(t, nil)
	b.Bases = realBases
	res, sha := iconJob(t, b, "A", iconPNG(64))
	rec, _ := os.ReadFile(b.RecordPath(res.Record))
	if ibtext.Get(ibtext.Parse(string(rec)), "icon") != sha {
		t.Fatal("record lacks the icon")
	}
	for _, f := range res.Files {
		d, _ := os.ReadFile(filepath.Join(b.Data, "dl", res.Record, f.Name))
		switch f.Platform {
		case "windows":
			want, _ := os.ReadFile(b.basePath("windows", true))
			if !fileExists(b.basePath("windows", true)) {
				want, _ = os.ReadFile(b.basePath("windows", false))
			}
			if !bytes.Equal(d, want) {
				t.Fatal("mode A exe changed")
			}
		case "linux":
			want, _ := os.ReadFile(b.basePath("linux", false))
			if !bytes.Equal(d, want) {
				t.Fatal("mode A .run changed")
			}
		case "macos":
			if bytes.Contains(d, []byte("AppIcon.icns")) || !bytes.Contains(d, []byte("_CodeSignature")) {
				t.Fatal("mode A zip changed")
			}
		}
	}
}

func TestIconValidate(t *testing.T) {
	b := testBuilder(t, nil)
	mk := func(ic *IconField) error {
		r := Request{Runtime: "python", Mode: "C", Files: map[string]string{"a.py": "x"}, Icon: ic}
		r.Source.Kind = "inline"
		_, err := r.Validate(b.Cat)
		return err
	}
	if err := mk(&IconField{Choice: "terminal"}); err != nil {
		t.Fatal("gallery choice refused:", err)
	}
	if err := mk(&IconField{Data: "data:image/png;base64," + base64.StdEncoding.EncodeToString(iconPNG(32))}); err != nil {
		t.Fatal("data URL refused:", err)
	}
	for name, ic := range map[string]*IconField{
		"not base64": {Data: "!!!"},
		"not png":    {Data: base64.StdEncoding.EncodeToString([]byte("GIF89a......"))},
		"too large":  {Data: strings.Repeat("A", 2<<20)},
		"bad sha":    {SHA256: "../../etc/passwd"},
	} {
		if err := mk(ic); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A hash with no stored icon fails the job, not the server.
	r := Request{Icon: &IconField{SHA256: strings.Repeat("a", 64)}}
	if err := b.loadIcon(&r); err == nil {
		t.Error("missing icon accepted")
	}
}
