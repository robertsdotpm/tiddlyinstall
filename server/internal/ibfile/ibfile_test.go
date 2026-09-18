package ibfile

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"io"
	"os"
	"strings"
	"testing"
)

func TestAppendRead(t *testing.T) {
	base := []byte("#!/bin/sh\nexit 0\n")
	var out bytes.Buffer
	pack := []byte("PACKDATA")
	if err := Append(base, []byte("ib-record\t1\n"), []byte("ib-plan\t1\n"), bytes.NewReader(pack), int64(len(pack)), &out); err != nil {
		t.Fatal(err)
	}
	b := out.Bytes()
	if len(Footer(1, 2, 3)) != FooterLen {
		t.Fatal("footer length")
	}
	rec, plan, off, n, err := Read(b)
	if err != nil || string(rec) != "ib-record\t1\n" || string(plan) != "ib-plan\t1\n" || string(b[off:off+n]) != "PACKDATA" {
		t.Fatalf("read back: %q %q %v", rec, plan, err)
	}
	if _, _, _, _, err := Read(base); err == nil {
		t.Fatal("found a block in a plain base")
	}
}

// A fake signed PE: the block sits before the certificate table, padded.
func TestSignedPE(t *testing.T) {
	pe := make([]byte, 512)
	pe[0], pe[1] = 'M', 'Z'
	binary.LittleEndian.PutUint32(pe[0x3c:], 0x80)
	copy(pe[0x80:], "PE\x00\x00")
	binary.LittleEndian.PutUint16(pe[0x80+24:], 0x20b)
	var out bytes.Buffer
	if err := Append(pe, []byte("R"), nil, nil, 0, &out); err != nil {
		t.Fatal(err)
	}
	b := out.Bytes()
	for len(b)%8 != 0 {
		b = append(b, 0)
	}
	certOff := len(b)
	b = append(b, make([]byte, 64)...)
	dd := 0x80 + 24 + 112 + 4*8
	binary.LittleEndian.PutUint32(b[dd:], uint32(certOff))
	binary.LittleEndian.PutUint32(b[dd+4:], 64)
	rec, _, _, _, err := Read(b)
	if err != nil || string(rec) != "R" {
		t.Fatalf("signed read: %q %v", rec, err)
	}
}

func TestMacZip(t *testing.T) {
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	h := &zip.FileHeader{Name: "Install.app/Contents/MacOS/install"}
	h.SetMode(0o755)
	w, _ := zw.CreateHeader(h)
	w.Write([]byte("#!/bin/sh\n"))
	zw.Close()
	var out bytes.Buffer
	if err := MacZip(zb.Bytes(), "install_node_hello_abc.app", map[string][]byte{"record.txt": []byte("R")}, nil, &out); err != nil {
		t.Fatal(err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
	names := map[string]uint32{}
	for _, f := range zr.File {
		names[f.Name] = uint32(f.Mode().Perm())
	}
	if names["install_node_hello_abc.app/Contents/MacOS/install"] != 0o755 {
		t.Fatalf("exec bit lost or not renamed: %v", names)
	}
	if _, ok := names["install_node_hello_abc.app/Contents/Resources/ib/record.txt"]; !ok {
		t.Fatalf("record not added: %v", names)
	}
}

func TestMacZipIcon(t *testing.T) {
	var zb bytes.Buffer
	zw := zip.NewWriter(&zb)
	add := func(name string, mode os.FileMode, data string) {
		h := &zip.FileHeader{Name: name, Method: zip.Deflate}
		h.SetMode(mode)
		w, _ := zw.CreateHeader(h)
		w.Write([]byte(data))
	}
	add("Install.app/Contents/MacOS/install", 0o755, "#!/bin/sh\n")
	add("Install.app/Contents/Info.plist", 0o640, "<plist><dict>\n\t<key>CFBundleName</key><string>Install</string>\n</dict></plist>\n")
	add("Install.app/Contents/_CodeSignature/CodeResources", 0o644, "sig")
	zw.Close()
	checkMacIcon(t, zb.Bytes(), map[string]os.FileMode{"MacOS/install": 0o755, "Info.plist": 0o640})
}

// The real macOS base, read only.
func TestMacZipIconRealBase(t *testing.T) {
	base, err := os.ReadFile("/home/x/projects/installer-builder/bases/unix/out/ib-base-macos.zip")
	if err != nil {
		t.Skip("no real base:", err)
	}
	zr, _ := zip.NewReader(bytes.NewReader(base), int64(len(base)))
	modes := map[string]os.FileMode{}
	for _, f := range zr.File {
		if i := strings.Index(f.Name, ".app/Contents/"); i >= 0 && !strings.Contains(f.Name, "_CodeSignature") {
			modes[f.Name[i+len(".app/Contents/"):]] = f.Mode()
		}
	}
	checkMacIcon(t, base, modes)
}

func checkMacIcon(t *testing.T, base []byte, modes map[string]os.FileMode) {
	t.Helper()
	icns := []byte("icns\x00\x00\x00\x08")
	var out bytes.Buffer
	if err := MacZip(base, "install_x_y.app", map[string][]byte{"record.txt": []byte("R")}, icns, &out); err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(out.Bytes()), int64(out.Len()))
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]*zip.File{}
	for _, f := range zr.File {
		if strings.Contains(f.Name, "_CodeSignature") {
			t.Fatalf("signature kept: %s", f.Name)
		}
		got[strings.TrimPrefix(f.Name, "install_x_y.app/Contents/")] = f
	}
	read := func(n string) string {
		f := got[n]
		if f == nil {
			t.Fatalf("%s missing (have %v)", n, got)
		}
		r, _ := f.Open()
		b, _ := io.ReadAll(r)
		return string(b)
	}
	if read("Resources/AppIcon.icns") != string(icns) {
		t.Fatal("icns wrong")
	}
	if p := read("Info.plist"); !strings.Contains(p, "<key>CFBundleIconFile</key><string>AppIcon</string>") || !strings.Contains(p, "CFBundleName") {
		t.Fatalf("plist: %s", p)
	}
	for n, m := range modes {
		if got[n] == nil || got[n].Mode() != m {
			t.Fatalf("%s: mode %v, want %v", n, got[n].Mode(), m)
		}
	}
	// Without an icon or extras (mode A) the signature and plist stay.
	out.Reset()
	if err := MacZip(base, "a.app", nil, nil, &out); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(out.Bytes(), []byte("_CodeSignature")) {
		t.Fatal("mode A lost its signature")
	}
}
