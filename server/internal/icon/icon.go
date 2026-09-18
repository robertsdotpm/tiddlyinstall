// Package icon turns the publisher's uploaded PNG into each platform's icon
// (docs/design.md section 4, "Fields in the form"; docs/api.md `icon`):
//
//	Windows  an icon group resource: 16/24/32/48 as 32bpp BMP (XP can't read
//	         PNG icon images) and 64/128/256 as PNG, written into the unsigned
//	         base's resources (pe.go).
//	macOS    an .icns of PNG images ic07-ic10 (128 to 1024), placed in the
//	         .app with CFBundleIconFile set (ibfile.MacZip).
//	Linux    the PNG itself, carried in the pack and named by the record's
//	         `icon` key (docs/format.md section 2).
//
// The layout follows js/icon.js, the browser editor's version, so an icon
// set on the server and one set in the browser look the same. Encoding uses
// image/png, which is deterministic, so the same upload always gives the
// same bytes.
package icon

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/draw"
	"image/png"
	"regexp"

	xdraw "golang.org/x/image/draw"
)

const (
	// MaxBytes is the largest PNG accepted (the browser refuses larger too).
	MaxBytes = 1 << 20
	// MaxSize and MinSize bound the PNG's side in pixels.
	MaxSize = 1024
	MinSize = 16
)

var pngSig = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// Decode checks that b is a real, square PNG of MinSize to MaxSize pixels
// and at most MaxBytes, and decodes it. Anything else is refused: the
// header is read first, so a huge image is rejected before it is decoded.
func Decode(b []byte) (image.Image, error) {
	if len(b) == 0 {
		return nil, errors.New("the icon is empty")
	}
	if len(b) > MaxBytes {
		return nil, fmt.Errorf("the icon is over %d KB", MaxBytes>>10)
	}
	if !bytes.HasPrefix(b, pngSig) {
		return nil, errors.New("the icon must be a PNG")
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("the icon isn't a valid PNG")
	}
	if cfg.Width != cfg.Height {
		return nil, fmt.Errorf("the icon must be square (it is %dx%d)", cfg.Width, cfg.Height)
	}
	if cfg.Width < MinSize || cfg.Width > MaxSize {
		return nil, fmt.Errorf("the icon must be %d to %d pixels across (it is %d)", MinSize, MaxSize, cfg.Width)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		return nil, errors.New("the icon isn't a valid PNG")
	}
	return img, nil
}

// Resize returns img as a size x size non-premultiplied RGBA image.
func Resize(img image.Image, size int) *image.NRGBA {
	b := img.Bounds()
	// Scale in premultiplied RGBA (so transparent pixels don't bleed colour
	// into their neighbours), then convert.
	src := image.NewRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(src, src.Bounds(), img, b.Min, draw.Src)
	var scaled *image.RGBA
	if b.Dx() == size && b.Dy() == size {
		scaled = src
	} else {
		scaled = image.NewRGBA(image.Rect(0, 0, size, size))
		xdraw.CatmullRom.Scale(scaled, scaled.Bounds(), src, src.Bounds(), xdraw.Src, nil)
	}
	out := image.NewNRGBA(scaled.Bounds())
	draw.Draw(out, out.Bounds(), scaled, image.Point{}, draw.Src)
	return out
}

// EncodePNG encodes an image deterministically.
func EncodePNG(img image.Image) []byte {
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		panic(err) // only fails on writer errors, and a bytes.Buffer has none
	}
	return buf.Bytes()
}

// Windows ------------------------------------------------------------------

// BMPSizes are written as 32bpp BMP (for XP), PNGSizes as PNG (Vista and
// later), as in js/icon.js.
var (
	BMPSizes = []int{16, 24, 32, 48}
	PNGSizes = []int{64, 128, 256}
)

// IconImage is one image of a Windows icon.
type IconImage struct {
	Size int    // pixels across
	Data []byte // a BMP DIB (no file header) or a PNG
}

// WindowsImages makes the images of the Windows icon, smallest first.
func WindowsImages(img image.Image) []IconImage {
	var out []IconImage
	for _, s := range BMPSizes {
		out = append(out, IconImage{s, bmpDIB(Resize(img, s))})
	}
	for _, s := range PNGSizes {
		out = append(out, IconImage{s, EncodePNG(Resize(img, s))})
	}
	return out
}

// bmpDIB is a 32bpp bottom-up DIB with an all-zero AND mask: opacity comes
// from the alpha channel. This is what XP reads.
func bmpDIB(m *image.NRGBA) []byte {
	size := m.Rect.Dx()
	const header = 40
	xor := size * size * 4
	andRow := ((size + 31) >> 5) << 2
	and := andRow * size
	out := make([]byte, header+xor+and)
	le := binary.LittleEndian
	le.PutUint32(out[0:], header)
	le.PutUint32(out[4:], uint32(size))
	le.PutUint32(out[8:], uint32(size*2)) // image + mask
	le.PutUint16(out[12:], 1)
	le.PutUint16(out[14:], 32)
	le.PutUint32(out[16:], 0) // BI_RGB
	le.PutUint32(out[20:], uint32(xor+and))
	o := header
	for y := size - 1; y >= 0; y-- {
		row := m.Pix[y*m.Stride : y*m.Stride+size*4]
		for x := 0; x < size; x++ {
			p := row[x*4 : x*4+4]
			out[o], out[o+1], out[o+2], out[o+3] = p[2], p[1], p[0], p[3] // BGRA
			o += 4
		}
	}
	return out
}

func dirEntry(dst []byte, im IconImage) {
	w := byte(im.Size)
	if im.Size >= 256 {
		w = 0 // 0 means 256
	}
	dst[0], dst[1], dst[2], dst[3] = w, w, 0, 0
	binary.LittleEndian.PutUint16(dst[4:], 1)  // planes
	binary.LittleEndian.PutUint16(dst[6:], 32) // bits per pixel
	binary.LittleEndian.PutUint32(dst[8:], uint32(len(im.Data)))
}

// GroupData is the RT_GROUP_ICON resource naming images ids[i].
func GroupData(images []IconImage, ids []uint16) []byte {
	out := make([]byte, 6+14*len(images))
	binary.LittleEndian.PutUint16(out[2:], 1)
	binary.LittleEndian.PutUint16(out[4:], uint16(len(images)))
	for i, im := range images {
		e := out[6+14*i:]
		dirEntry(e, im)
		binary.LittleEndian.PutUint16(e[12:], ids[i])
	}
	return out
}

// ICO is the same images as an .ico file.
func ICO(images []IconImage) []byte {
	var buf bytes.Buffer
	hdr := make([]byte, 6+16*len(images))
	binary.LittleEndian.PutUint16(hdr[2:], 1)
	binary.LittleEndian.PutUint16(hdr[4:], uint16(len(images)))
	off := len(hdr)
	for i, im := range images {
		e := hdr[6+16*i:]
		dirEntry(e, im)
		binary.LittleEndian.PutUint32(e[12:], uint32(off))
		off += len(im.Data)
	}
	buf.Write(hdr)
	for _, im := range images {
		buf.Write(im.Data)
	}
	return buf.Bytes()
}

// macOS --------------------------------------------------------------------

// ICNSTypes are the PNG-based OSTypes written, as in js/icon.js.
var ICNSTypes = []struct {
	Type string
	Size int
}{{"ic07", 128}, {"ic08", 256}, {"ic09", 512}, {"ic10", 1024}}

// ICNS makes an .icns file.
func ICNS(img image.Image) []byte {
	var body bytes.Buffer
	for _, t := range ICNSTypes {
		p := EncodePNG(Resize(img, t.Size))
		var h [8]byte
		copy(h[:], t.Type)
		binary.BigEndian.PutUint32(h[4:], uint32(8+len(p)))
		body.Write(h[:])
		body.Write(p)
	}
	out := make([]byte, 8, 8+body.Len())
	copy(out, "icns")
	binary.BigEndian.PutUint32(out[4:], uint32(8+body.Len()))
	return append(out, body.Bytes()...)
}

var plistIconRe = regexp.MustCompile(`(<key>\s*CFBundleIconFile\s*</key>\s*)<string>[^<]*</string>`)

// SetPlistIcon sets CFBundleIconFile in an XML Info.plist.
func SetPlistIcon(xml []byte, name string) ([]byte, error) {
	if plistIconRe.Match(xml) {
		return plistIconRe.ReplaceAll(xml, []byte("${1}<string>"+name+"</string>")), nil
	}
	i := bytes.Index(xml, []byte("<dict>"))
	if i < 0 {
		return nil, errors.New("Info.plist has no <dict> to add the icon to")
	}
	i += len("<dict>")
	entry := "\n\t<key>CFBundleIconFile</key><string>" + name + "</string>"
	out := append([]byte{}, xml[:i]...)
	out = append(out, entry...)
	return append(out, xml[i:]...), nil
}
