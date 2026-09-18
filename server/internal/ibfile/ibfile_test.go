package ibfile

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
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
	if err := MacZip(zb.Bytes(), "install_node_hello_abc.app", map[string][]byte{"record.txt": []byte("R")}, &out); err != nil {
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
