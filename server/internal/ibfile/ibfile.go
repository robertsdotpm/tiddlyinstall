// Package ibfile writes and reads the metadata block of docs/format.md
// section 4, and edits the macOS base (a .zip of an .app).
package ibfile

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/robertsdotpm/installer-builder/server/internal/icon"
)

const FooterLen = 64

// Footer returns the 64-byte footer for the given section lengths.
func Footer(record, plan, pack int64) []byte {
	s := fmt.Sprintf("IBMETA1 %012d %012d %012d ", record, plan, pack)
	s += strings.Repeat(" ", FooterLen-1-len(s)) + "\n"
	return []byte(s)
}

// CertTable returns the file offset and size of a PE's certificate table,
// or 0, 0 when the file isn't a PE or isn't signed.
func CertTable(b []byte) (off, size int64) {
	if len(b) < 0x40 || b[0] != 'M' || b[1] != 'Z' {
		return 0, 0
	}
	pe := int64(binary.LittleEndian.Uint32(b[0x3c:]))
	if pe+24 > int64(len(b)) || string(b[pe:pe+4]) != "PE\x00\x00" {
		return 0, 0
	}
	opt := pe + 24
	var dd int64
	switch binary.LittleEndian.Uint16(b[opt:]) {
	case 0x10b:
		dd = opt + 96
	case 0x20b:
		dd = opt + 112
	default:
		return 0, 0
	}
	e := dd + 4*8
	if e+8 > int64(len(b)) {
		return 0, 0
	}
	return int64(binary.LittleEndian.Uint32(b[e:])), int64(binary.LittleEndian.Uint32(b[e+4:]))
}

// Append adds record, plan and pack after the base (modes B and C). It
// refuses a signed base: the block must go in before the publisher signs.
func Append(base, record, plan []byte, pack io.Reader, packLen int64, out io.Writer) error {
	if off, _ := CertTable(base); off != 0 {
		return errors.New("base is signed; append to the unsigned base")
	}
	if _, _, _, _, err := Read(base); err == nil {
		return errors.New("base already has a metadata block")
	}
	for _, p := range [][]byte{base, record, plan} {
		if _, err := out.Write(p); err != nil {
			return err
		}
	}
	if pack != nil {
		if n, err := io.Copy(out, pack); err != nil || n != packLen {
			return fmt.Errorf("pack: wrote %d of %d bytes: %v", n, packLen, err)
		}
	}
	_, err := out.Write(Footer(int64(len(record)), int64(len(plan)), packLen))
	return err
}

// Read finds the metadata block. packOff is the pack's offset in b.
func Read(b []byte) (record, plan []byte, packOff, packLen int64, err error) {
	end := int64(len(b))
	if off, _ := CertTable(b); off != 0 && off <= end {
		end = off
		for i := 0; i < 7 && end > 0 && b[end-1] == 0; i++ {
			end--
		}
	}
	if end < FooterLen {
		return nil, nil, 0, 0, errors.New("no metadata block")
	}
	f := string(b[end-FooterLen : end])
	if !strings.HasPrefix(f, "IBMETA1 ") {
		return nil, nil, 0, 0, errors.New("no metadata block")
	}
	fields := strings.Fields(f)
	if len(fields) < 4 {
		return nil, nil, 0, 0, errors.New("bad footer")
	}
	var n [3]int64
	for i := range n {
		if n[i], err = strconv.ParseInt(fields[i+1], 10, 64); err != nil {
			return nil, nil, 0, 0, errors.New("bad footer")
		}
	}
	start := end - FooterLen - n[0] - n[1] - n[2]
	if start < 0 {
		return nil, nil, 0, 0, errors.New("bad footer lengths")
	}
	record = b[start : start+n[0]]
	plan = b[start+n[0] : start+n[0]+n[1]]
	return record, plan, start + n[0] + n[1], n[2], nil
}

// PackFile is one file for a pack: its content comes from Path.
type PackFile struct {
	SHA256 string
	Path   string
	Size   int64
}

// PackSize is the exact length WritePack will produce.
func PackSize(files []PackFile) int64 {
	var n int64
	for _, f := range files {
		n += 512 + (f.Size+511)/512*512
	}
	return n + 1024
}

// WritePack writes a ustar tar whose members are named by their SHA-256.
func WritePack(files []PackFile, out io.Writer) error {
	tw := tar.NewWriter(out)
	seen := map[string]bool{}
	for _, f := range files {
		if seen[f.SHA256] {
			continue
		}
		seen[f.SHA256] = true
		h := &tar.Header{Name: f.SHA256, Mode: 0o644, Size: f.Size, ModTime: time.Unix(0, 0), Format: tar.FormatUSTAR, Typeflag: tar.TypeReg}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		r, err := os.Open(f.Path)
		if err != nil {
			return err
		}
		_, err = io.Copy(tw, r)
		r.Close()
		if err != nil {
			return err
		}
	}
	return tw.Close()
}

// DedupPack drops repeated files so PackSize and WritePack agree.
func DedupPack(files []PackFile) []PackFile {
	seen := map[string]bool{}
	var out []PackFile
	for _, f := range files {
		if !seen[f.SHA256] {
			seen[f.SHA256] = true
			out = append(out, f)
		}
	}
	return out
}

// The app icon in a macOS bundle, and the CFBundleIconFile value naming it.
const (
	MacIconName = "AppIcon"
	MacIconPath = "Contents/Resources/AppIcon.icns"
)

// MacZip rewrites the macOS base zip: the .app folder is renamed to
// newApp (mode A puts the record hash in this name) and extra files are
// added under <newApp>/Contents/Resources/ib/. Entries are copied raw, so
// Unix permissions and symlinks are kept. Adding files invalidates the
// base's signature, and macOS reports an app with a broken signature as
// "damaged" (worse than unsigned), so the old signature is dropped then;
// a mode B publisher signs the result themselves.
//
// A non-nil icns is written to Contents/Resources/AppIcon.icns and
// Info.plist's CFBundleIconFile is set to it. That changes the bundle too,
// so the signature is dropped as well.
func MacZip(base []byte, newApp string, extra map[string][]byte, icns []byte, out io.Writer) error {
	zr, err := zip.NewReader(bytes.NewReader(base), int64(len(base)))
	if err != nil {
		return err
	}
	oldApp := ""
	for _, f := range zr.File {
		if i := strings.Index(f.Name, ".app/"); i >= 0 {
			oldApp = f.Name[:i+4]
			break
		}
	}
	if oldApp == "" {
		return errors.New("no .app in the macOS base")
	}
	modified := len(extra) > 0 || icns != nil
	plistDone := false
	zw := zip.NewWriter(out)
	for _, f := range zr.File {
		if modified && strings.HasPrefix(f.Name, oldApp+"/Contents/_CodeSignature/") {
			continue
		}
		if icns != nil && f.Name == oldApp+"/"+MacIconPath {
			continue // replaced below
		}
		h := f.FileHeader
		if strings.HasPrefix(h.Name, oldApp) {
			h.Name = newApp + strings.TrimPrefix(h.Name, oldApp)
		}
		if icns != nil && f.Name == oldApp+"/Contents/Info.plist" {
			// Rewritten, so recompressed; the header (mode, time) is kept.
			rc, err := f.Open()
			if err != nil {
				return err
			}
			plist, err := io.ReadAll(io.LimitReader(rc, 1<<20))
			rc.Close()
			if err != nil {
				return err
			}
			if plist, err = icon.SetPlistIcon(plist, MacIconName); err != nil {
				return err
			}
			h.Method = zip.Deflate
			h.CRC32, h.CompressedSize, h.UncompressedSize, h.CompressedSize64, h.UncompressedSize64 = 0, 0, 0, 0, 0
			w, err := zw.CreateHeader(&h)
			if err != nil {
				return err
			}
			if _, err := w.Write(plist); err != nil {
				return err
			}
			plistDone = true
			continue
		}
		r, err := f.OpenRaw()
		if err != nil {
			return err
		}
		w, err := zw.CreateRaw(&h)
		if err != nil {
			return err
		}
		if _, err := io.Copy(w, r); err != nil {
			return err
		}
	}
	if icns != nil {
		if !plistDone {
			return errors.New("no Contents/Info.plist in the macOS base to set the icon in")
		}
		h := &zip.FileHeader{Name: newApp + "/" + MacIconPath, Method: zip.Deflate}
		h.SetMode(0o644)
		h.Modified = time.Unix(0, 0).UTC()
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if _, err := w.Write(icns); err != nil {
			return err
		}
	}
	names := make([]string, 0, len(extra))
	for n := range extra {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		h := &zip.FileHeader{Name: newApp + "/Contents/Resources/ib/" + n, Method: zip.Deflate}
		h.SetMode(0o644)
		h.Modified = time.Unix(0, 0).UTC()
		w, err := zw.CreateHeader(h)
		if err != nil {
			return err
		}
		if _, err := w.Write(extra[n]); err != nil {
			return err
		}
	}
	return zw.Close()
}

// SHA256File hashes a file.
func SHA256File(path string) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

// WriteAtomic writes a file via a temporary name.
func WriteAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
