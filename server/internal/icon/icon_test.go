package icon

import (
	"bytes"
	"debug/pe"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func pngDecodeConfig(b []byte) (image.Config, error) { return png.DecodeConfig(bytes.NewReader(b)) }

// appendBlock stands in for ibfile.Append (which imports this package).
func appendBlock(b []byte, rec string) []byte {
	return append(append(append([]byte{}, b...), rec...), fmt.Sprintf("IBMETA1 %012d %012d %012d %s\n", len(rec), 0, 0, strings.Repeat(" ", 63-47))...)
}

// testPNG makes a w x h PNG with a transparent border and a gradient.
func testPNG(w, h int) []byte {
	m := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			a := uint8(255)
			if x < w/8 || y < h/8 {
				a = 0
			}
			m.SetNRGBA(x, y, color.NRGBA{uint8(x * 255 / w), uint8(y * 255 / h), 200, a})
		}
	}
	return EncodePNG(m)
}

func TestDecode(t *testing.T) {
	if _, err := Decode(testPNG(256, 256)); err != nil {
		t.Fatalf("good PNG refused: %v", err)
	}
	if _, err := Decode(testPNG(1024, 1024)); err != nil {
		t.Fatalf("1024 PNG refused: %v", err)
	}
	var jb, gb bytes.Buffer
	jpeg.Encode(&jb, image.NewRGBA(image.Rect(0, 0, 64, 64)), nil)
	gif.Encode(&gb, image.NewPaletted(image.Rect(0, 0, 64, 64), color.Palette{color.Black}), nil)
	good := testPNG(64, 64)
	bad := map[string][]byte{
		"empty":      nil,
		"jpeg":       jb.Bytes(),
		"gif":        gb.Bytes(),
		"not square": testPNG(64, 32),
		"too big":    testPNG(1025, 1025),
		"too small":  testPNG(8, 8),
		"truncated":  good[:len(good)-20],
		"over 1 MB":  append(append([]byte{}, good...), make([]byte, MaxBytes)...),
		"header only": func() []byte {
			b := append([]byte{}, good[:33]...) // signature + IHDR
			return b
		}(),
	}
	for name, b := range bad {
		if _, err := Decode(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

// makePE builds a small PE32 with .text and .rsrc (an icon group 103 of one
// image, and a manifest) followed by an overlay, like an NSIS stub.
func makePE(t *testing.T) (file []byte, overlay []byte, rsrcRaw, rsrcLen uint32) {
	t.Helper()
	le := binary.LittleEndian
	const (
		peOff    = 0x80
		fileAl   = 0x200
		secAl    = 0x1000
		textRaw  = 0x400
		rsrcVA   = 0x2000
		rsrcFile = 0x600
	)
	oldIcon := bytes.Repeat([]byte{0xAB}, 300)
	group := GroupData([]IconImage{{32, oldIcon}}, []uint16{1})
	root := &resNode{children: []*resNode{
		{id: rtIcon, children: []*resNode{{id: 1, children: []*resNode{{id: 1033, leaf: &resLeaf{data: oldIcon}}}}}},
		{id: rtGroupIcon, children: []*resNode{{id: 103, children: []*resNode{{id: 1033, leaf: &resLeaf{data: group}}}}}},
		{id: 24, children: []*resNode{{id: 1, children: []*resNode{{id: 1033, leaf: &resLeaf{data: []byte("<assembly/>")}}}}}},
		{name: []uint16{'M', 'Y'}, children: []*resNode{{id: 7, children: []*resNode{{id: 1033, leaf: &resLeaf{data: []byte("named")}}}}}},
	}}
	root.sortChildren()
	rsrc := root.serialize(rsrcVA)
	rsrcRawSize := align(uint32(len(rsrc)), fileAl)

	b := make([]byte, rsrcFile+rsrcRawSize)
	b[0], b[1] = 'M', 'Z'
	le.PutUint32(b[0x3c:], peOff)
	copy(b[peOff:], "PE\x00\x00")
	coff := b[peOff+4:]
	le.PutUint16(coff[0:], 0x14c)
	le.PutUint16(coff[2:], 2)
	le.PutUint16(coff[16:], 224)
	le.PutUint16(coff[18:], 0x102)
	opt := b[peOff+24:]
	le.PutUint16(opt[0:], 0x10b)
	le.PutUint32(opt[4:], 0x200)                                   // SizeOfCode
	le.PutUint32(opt[8:], rsrcRawSize)                             // SizeOfInitializedData
	le.PutUint32(opt[16:], 0x1000)                                 // entry point
	le.PutUint32(opt[28:], 0x400000)                               // ImageBase
	le.PutUint32(opt[32:], secAl)                                  //
	le.PutUint32(opt[36:], fileAl)                                 //
	le.PutUint16(opt[40:], 4)                                      // OS version
	le.PutUint16(opt[48:], 4)                                      // subsystem version
	le.PutUint32(opt[56:], rsrcVA+align(uint32(len(rsrc)), secAl)) // SizeOfImage
	le.PutUint32(opt[60:], 0x400)                                  // SizeOfHeaders
	le.PutUint16(opt[68:], 2)                                      // GUI
	le.PutUint32(opt[92:], 16)
	le.PutUint32(opt[96+8*2:], rsrcVA)
	le.PutUint32(opt[96+8*2+4:], uint32(len(rsrc)))
	sec := b[peOff+24+224:]
	copy(sec, ".text")
	le.PutUint32(sec[8:], 0x10)
	le.PutUint32(sec[12:], 0x1000)
	le.PutUint32(sec[16:], 0x200)
	le.PutUint32(sec[20:], textRaw)
	le.PutUint32(sec[36:], 0x60000020)
	sec = sec[40:]
	copy(sec, ".rsrc")
	le.PutUint32(sec[8:], uint32(len(rsrc)))
	le.PutUint32(sec[12:], rsrcVA)
	le.PutUint32(sec[16:], rsrcRawSize)
	le.PutUint32(sec[20:], rsrcFile)
	le.PutUint32(sec[36:], 0x40000040)
	b[textRaw] = 0xC3 // ret
	copy(b[rsrcFile:], rsrc)

	overlay = []byte("\xef\xbe\xad\xdeNullsoftInst")
	for i := 0; i < 5000; i++ {
		overlay = append(overlay, byte(i*7))
	}
	return append(b, overlay...), overlay, rsrcFile, rsrcRawSize
}

// checkIconPE checks an edited PE: the given overlay is intact right after
// the section data, the old section bytes are where they were, the icon
// groups name the new images, and the checksum is right.
func checkIconPE(t *testing.T, orig, out []byte, overlayLen int) {
	t.Helper()
	le := binary.LittleEndian
	h0, secs0, err := readHeaders(orig)
	if err != nil {
		t.Fatal(err)
	}
	h, secs, err := readHeaders(out)
	if err != nil {
		t.Fatal(err)
	}
	if h.nsec != h0.nsec+1 {
		t.Fatalf("sections: %d -> %d", h0.nsec, h.nsec)
	}
	// Old section data unchanged, in place.
	for i, s := range secs0 {
		if s.rawSize == 0 {
			continue
		}
		if !bytes.Equal(orig[s.raw:s.raw+s.rawSize], out[s.raw:s.raw+s.rawSize]) {
			t.Fatalf("section %d changed", i)
		}
		if secs[i] != s {
			t.Fatalf("section %d header changed", i)
		}
	}
	// The overlay is unchanged and follows the new section.
	ns := secs[len(secs)-1]
	end := ns.raw + ns.rawSize
	if ns.rawSize%h.fileAlign != 0 || !bytes.Equal(out[end:end+uint32(overlayLen)], orig[len(orig)-overlayLen:]) {
		t.Fatal("overlay changed or misplaced")
	}
	if (end-uint32(len(orig)-overlayLen))%512 != 0 {
		t.Fatal("overlay moved by a non-multiple of 512")
	}
	// Checksum.
	off := h.opt + 64
	if got, want := le.Uint32(out[off:]), Checksum(out, off); got != want || got == 0 {
		t.Fatalf("checksum %#x, want %#x", got, want)
	}
	// Go's own PE parser accepts it.
	f, err := pe.NewFile(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("debug/pe: %v", err)
	}
	if f.Sections[len(f.Sections)-1].Name != newSecName {
		t.Fatalf("last section %q", f.Sections[len(f.Sections)-1].Name)
	}
	// Resources: groups name images of the expected sizes and formats.
	rva, _ := h.dir(out, dirResource)
	if rva != ns.va {
		t.Fatalf("resource directory at %#x, new section at %#x", rva, ns.va)
	}
	root, err := parseRes(out, secs, rva)
	if err != nil {
		t.Fatal(err)
	}
	icons := map[uint32][]byte{}
	for _, n := range root.find(rtIcon).children {
		l := n.children[0].leaf
		d, _ := rvaSlice(out, secs, l.rva)
		icons[n.id] = d[:l.size]
	}
	want := append(append([]int{}, BMPSizes...), PNGSizes...)
	groups := root.find(rtGroupIcon)
	if groups == nil || len(groups.children) == 0 {
		t.Fatal("no icon group")
	}
	for _, g := range groups.children {
		for _, lang := range g.children {
			d, _ := rvaSlice(out, secs, lang.leaf.rva)
			d = d[:lang.leaf.size]
			n := int(le.Uint16(d[4:]))
			if n != len(want) {
				t.Fatalf("group %d has %d images", g.id, n)
			}
			for i := 0; i < n; i++ {
				e := d[6+14*i:]
				size := int(e[0])
				if size == 0 {
					size = 256
				}
				img := icons[uint32(le.Uint16(e[12:]))]
				if size != want[i] || int(le.Uint32(e[8:])) != len(img) {
					t.Fatalf("image %d: size %d len %d", i, size, len(img))
				}
				isPNG := bytes.HasPrefix(img, pngSig)
				if isPNG != (size >= 64) {
					t.Fatalf("size %d: PNG=%v", size, isPNG)
				}
				if !isPNG && int(le.Uint32(img[4:])) != size {
					t.Fatalf("BMP width %d, want %d", le.Uint32(img[4:]), size)
				}
			}
		}
	}
}

func TestSetExeIconSynthetic(t *testing.T) {
	orig, overlay, _, _ := makePE(t)
	img, _ := Decode(testPNG(512, 512))
	out, err := SetExeIcon(orig, WindowsImages(img))
	if err != nil {
		t.Fatal(err)
	}
	checkIconPE(t, orig, out, len(overlay))

	// Unchanged resources keep their data, by their old RVAs.
	h, secs, _ := readHeaders(out)
	rva, _ := h.dir(out, dirResource)
	root, _ := parseRes(out, secs, rva)
	m := root.find(24).children[0].children[0].leaf
	d, _ := rvaSlice(out, secs, m.rva)
	if string(d[:m.size]) != "<assembly/>" || m.rva >= rva {
		t.Fatalf("manifest lost: %q at %#x", d[:m.size], m.rva)
	}
	if root.children[0].name == nil {
		t.Fatal("named type not first")
	}
	if g := root.find(rtGroupIcon).children[0]; g.id != 103 || g.children[0].id != 1033 {
		t.Fatalf("group id/lang changed: %d/%d", g.id, g.children[0].id)
	}

	// Then the metadata block, and the checksum over the whole file.
	p := filepath.Join(t.TempDir(), "x.exe")
	os.WriteFile(p, appendBlock(out, "ib-record\t1\n"), 0o644)
	if err := FixChecksumFile(p); err != nil {
		t.Fatal(err)
	}
	final, _ := os.ReadFile(p)
	off, _ := ChecksumOffset(final)
	if binary.LittleEndian.Uint32(final[off:]) != Checksum(final, off) {
		t.Fatal("final checksum wrong")
	}
	if !bytes.Equal(final[len(out):len(out)+12], []byte("ib-record\t1\n")) {
		t.Fatal("metadata block moved")
	}

	// A signed file is refused.
	signed := append([]byte{}, orig...)
	binary.LittleEndian.PutUint32(signed[h.dirs+8*dirSecurity:], uint32(len(orig)))
	binary.LittleEndian.PutUint32(signed[h.dirs+8*dirSecurity+4:], 8)
	if _, err := SetExeIcon(append(signed, make([]byte, 8)...), WindowsImages(img)); err == nil {
		t.Fatal("signed PE accepted")
	}
	// So is garbage.
	if _, err := SetExeIcon([]byte("MZ not really"), WindowsImages(img)); err == nil {
		t.Fatal("garbage accepted")
	}
}

// The checksum matches a known value: pefile's for the real base (checked
// by pefileCheck below) and Microsoft's algorithm on a tiny input.
func TestChecksumSmall(t *testing.T) {
	b := []byte{1, 0, 2, 0, 0xff, 0xff, 3}
	// words: 1, 2, 0xffff, 3 (odd byte) = 0x10005 -> fold 0x0006; + len 7
	if got := Checksum(b, 1000); got != 0x6+7 {
		t.Fatalf("got %#x", got)
	}
}

const realBase = "/home/x/projects/installer-builder/bases/windows/out/base.exe"

func TestSetExeIconRealBase(t *testing.T) {
	orig, err := os.ReadFile(realBase) // read only; the edited copy goes to a temp dir
	if err != nil {
		t.Skip("no real base:", err)
	}
	h, secs, err := readHeaders(orig)
	if err != nil {
		t.Fatal(err)
	}
	var dataEnd uint32
	for _, s := range secs {
		if s.raw+s.rawSize > dataEnd {
			dataEnd = s.raw + s.rawSize
		}
	}
	overlayLen := len(orig) - int(dataEnd)
	img, _ := Decode(testPNG(1024, 1024))
	out, err := SetExeIcon(orig, WindowsImages(img))
	if err != nil {
		t.Fatal(err)
	}
	checkIconPE(t, orig, out, overlayLen)
	_ = h

	p := filepath.Join(t.TempDir(), "base-icon.exe")
	os.WriteFile(p, appendBlock(out, "ib-record\t1\nname\tx\n"), 0o644)
	if err := FixChecksumFile(p); err != nil {
		t.Fatal(err)
	}
	final, _ := os.ReadFile(p)
	if d := os.Getenv("IB_KEEP_ICON_EXE"); d != "" {
		os.WriteFile(d, final, 0o644)
	}
	pefileCheck(t, p, overlayLen)
}

// pefileCheck cross-checks with Python's pefile when it can be imported
// (PYTHONPATH may point at its wheel).
func pefileCheck(t *testing.T, path string, overlayLen int) {
	if exec.Command("python3", "-c", "import pefile").Run() != nil {
		t.Log("pefile not available; skipping the cross-check")
		return
	}
	script := `
import sys, pefile
p = pefile.PE(sys.argv[1])
assert p.OPTIONAL_HEADER.CheckSum == p.generate_checksum(), (hex(p.OPTIONAL_HEADER.CheckSum), hex(p.generate_checksum()))
sizes = []
for t in p.DIRECTORY_ENTRY_RESOURCE.entries:
    if t.id == 14:
        for g in t.directory.entries:
            for l in g.directory.entries:
                d = p.get_data(l.data.struct.OffsetToData, l.data.struct.Size)
                n = int.from_bytes(d[4:6], 'little')
                sizes = [d[6+14*i] or 256 for i in range(n)]
print(sizes, p.get_overlay_data_start_offset())
`
	out, err := exec.Command("python3", "-c", script, path).CombinedOutput()
	if err != nil {
		t.Fatalf("pefile: %v\n%s", err, out)
	}
	if !strings.HasPrefix(string(out), "[16, 24, 32, 48, 64, 128, 256]") {
		t.Fatalf("pefile sees: %s", out)
	}
	t.Logf("pefile: %s", strings.TrimSpace(string(out)))
}

func TestICNSAndPlist(t *testing.T) {
	img, _ := Decode(testPNG(100, 100))
	b := ICNS(img)
	if string(b[:4]) != "icns" || int(binary.BigEndian.Uint32(b[4:])) != len(b) {
		t.Fatal("bad icns header")
	}
	o := 8
	for _, want := range ICNSTypes {
		n := int(binary.BigEndian.Uint32(b[o+4:]))
		if string(b[o:o+4]) != want.Type || !bytes.HasPrefix(b[o+8:], pngSig) {
			t.Fatalf("chunk %s", b[o:o+4])
		}
		cfg, err := pngDecodeConfig(b[o+8 : o+n])
		if err != nil || cfg.Width != want.Size {
			t.Fatalf("%s: %v %d", want.Type, err, cfg.Width)
		}
		o += n
	}
	if o != len(b) {
		t.Fatal("trailing bytes")
	}
	// Deterministic.
	if !bytes.Equal(b, ICNS(img)) {
		t.Fatal("not deterministic")
	}

	p, err := SetPlistIcon([]byte("<plist><dict>\n\t<key>A</key><string>b</string>\n</dict></plist>"), "AppIcon")
	if err != nil || !bytes.Contains(p, []byte("<key>CFBundleIconFile</key><string>AppIcon</string>")) {
		t.Fatalf("add: %s %v", p, err)
	}
	p2, _ := SetPlistIcon(p, "Other")
	if bytes.Count(p2, []byte("CFBundleIconFile")) != 1 || !bytes.Contains(p2, []byte("<string>Other</string>")) {
		t.Fatalf("replace: %s", p2)
	}
	if _, err := SetPlistIcon([]byte("bplist00"), "x"); err == nil {
		t.Fatal("binary plist accepted")
	}
}
