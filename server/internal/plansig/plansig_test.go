package plansig

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const plan = "ib-plan\t1\nrecord\ttjfq5rqwnnrxk3m9q2x7v4p8ab\nname\tHello\n\n[target]\nwhen\tlinux\t0\t9999\t*\nlaunch\techo hi\n"

func newSigner(t *testing.T) (*Signer, string) {
	t.Helper()
	dir := t.TempDir()
	s, created, err := LoadOrCreate(dir)
	if err != nil || !created {
		t.Fatalf("create: %v %v", created, err)
	}
	return s, dir
}

func TestKeyFiles(t *testing.T) {
	s, dir := newSigner(t)
	st, err := os.Stat(filepath.Join(dir, KeyFile))
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("private key mode: %v %v", st.Mode().Perm(), err)
	}
	pub, _ := os.ReadFile(filepath.Join(dir, PubFile))
	if string(pub) != s.PublicBase64()+"\n" || len(s.PublicBase64()) != 44 {
		t.Fatalf("public key file %q", pub)
	}
	// A second start loads the same key and doesn't make a new one.
	s2, created, err := LoadOrCreate(dir)
	if err != nil || created || !bytes.Equal(s2.Pub, s.Pub) {
		t.Fatalf("reload: %v %v", created, err)
	}
	// The public key file is rewritten from the private key if it drifts.
	os.WriteFile(filepath.Join(dir, PubFile), []byte("junk\n"), 0o644)
	if _, _, err := LoadOrCreate(dir); err != nil {
		t.Fatal(err)
	}
	if pub, _ := os.ReadFile(filepath.Join(dir, PubFile)); string(pub) != s.PublicBase64()+"\n" {
		t.Fatalf("public key not restored: %q", pub)
	}
	if !strings.Contains(s.PublicPEM(), "MCowBQYDK2VwAyEA") {
		t.Fatalf("PEM prefix: %s", s.PublicPEM())
	}
	if len(KeyID(s.Pub)) != 16 {
		t.Fatal("key id")
	}
}

func TestSignVerify(t *testing.T) {
	s, _ := newSigner(t)
	signed, err := s.Sign([]byte(plan))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(signed, []byte(plan)) {
		t.Fatal("the plan's bytes changed")
	}
	last := strings.Split(strings.TrimSuffix(string(signed), "\n"), "\n")
	line := last[len(last)-1]
	if !strings.HasPrefix(line, "sig\ted25519\t") || len(line) != len("sig\ted25519\t")+88 || !bytes.HasSuffix(signed, []byte("\n")) {
		t.Fatalf("signature line %q", line)
	}
	// The signature is plain Ed25519 over the plan's bytes: check it
	// without this package, as the engines do.
	sig, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(line, "sig\ted25519\t"))
	if !ed25519.Verify(s.Pub, []byte(plan), sig) {
		t.Fatal("not a signature over the plan's bytes")
	}
	msg, err := VerifyFor(s.Pub, signed, "tjfq5rqwnnrxk3m9q2x7v4p8ab")
	if err != nil || string(msg) != plan {
		t.Fatalf("verify: %v", err)
	}
	// CRLF on the signature line is tolerated; the signed bytes aren't touched.
	if _, err := Verify(s.Pub, append(bytes.Clone(bytes.TrimSuffix(signed, []byte("\n"))), '\r', '\n')); err != nil {
		t.Fatalf("CRLF: %v", err)
	}
	// So is a missing final newline.
	if _, err := Verify(s.Pub, bytes.TrimSuffix(signed, []byte("\n"))); err != nil {
		t.Fatalf("no final newline: %v", err)
	}
	if _, err := s.Sign(signed); err == nil {
		t.Fatal("signed twice")
	}
	if _, err := s.Sign([]byte("ib-record\t1\n")); err == nil {
		t.Fatal("signed a record")
	}
}

func TestNoFinalNewline(t *testing.T) {
	s, _ := newSigner(t)
	signed, _ := s.Sign([]byte(strings.TrimSuffix(plan, "\n")))
	if !bytes.HasPrefix(signed, []byte(plan)) {
		t.Fatal("the newline before sig must be added (and signed)")
	}
	if _, err := Verify(s.Pub, signed); err != nil {
		t.Fatal(err)
	}
}

func TestRejects(t *testing.T) {
	s, _ := newSigner(t)
	other, _ := newSigner(t)
	signed, _ := s.Sign([]byte(plan))

	cases := map[string][]byte{
		"tampered url":    bytes.Replace(signed, []byte("echo hi"), []byte("echo HI"), 1),
		"dropped line":    bytes.Replace(signed, []byte("name\tHello\n"), nil, 1),
		"added line":      bytes.Replace(signed, []byte("[target]\n"), []byte("[target]\nstep\trun\tevil\n"), 1),
		"text after sig":  append(append([]byte{}, signed...), "launch\tevil\n"...),
		"blank after sig": append(append([]byte{}, signed...), '\n'),
		"flipped sig bit": func() []byte {
			b := append([]byte{}, signed...)
			i := bytes.LastIndex(b, []byte("\t")) + 5
			if b[i] == 'A' {
				b[i] = 'B'
			} else {
				b[i] = 'A'
			}
			return b
		}(),
	}
	for name, doc := range cases {
		if _, err := Verify(s.Pub, doc); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := Verify(other.Pub, signed); !errors.Is(err, ErrBadSig) {
		t.Errorf("another key: %v", err)
	}
	if _, err := Verify(s.Pub, []byte(plan)); !errors.Is(err, ErrUnsigned) {
		t.Errorf("unsigned: %v", err)
	}
	if _, err := VerifyFor(s.Pub, signed, "aaaaaaaaaaaaaaaaaaaaaaaaaa"); err == nil {
		t.Error("record binding not checked")
	}
	// A validly signed plan for another record is refused: replaying one
	// app's plan for another installer doesn't work.
	p2, _ := s.Sign([]byte(strings.Replace(plan, "tjfq5rqwnnrxk3m9q2x7v4p8ab", "bbbbbbbbbbbbbbbbbbbbbbbbbb", 1)))
	if _, err := VerifyFor(s.Pub, p2, "tjfq5rqwnnrxk3m9q2x7v4p8ab"); err == nil {
		t.Error("replayed plan accepted")
	}
	// Non-canonical S (S + L) is refused.
	sig, _ := base64.StdEncoding.DecodeString(string(signed[bytes.LastIndex(signed, []byte("\t"))+1 : len(signed)-1]))
	addL(sig[32:])
	bad := append(append([]byte{}, signed[:bytes.LastIndex(signed, []byte("\t"))+1]...), base64.StdEncoding.EncodeToString(sig)+"\n"...)
	if _, err := Verify(s.Pub, bad); err == nil {
		t.Error("S >= L accepted")
	}
}

// addL adds the group order L to a little-endian 32-byte scalar.
func addL(s []byte) {
	l, _ := hex.DecodeString("edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010")
	c := 0
	for i := 0; i < 32; i++ {
		v := int(s[i]) + int(l[i]) + c
		s[i], c = byte(v), v>>8
	}
}

func TestRecordOf(t *testing.T) {
	if RecordOf([]byte(plan)) != "tjfq5rqwnnrxk3m9q2x7v4p8ab" {
		t.Fatal("record")
	}
	if RecordOf([]byte("ib-plan\t1\n\n[target]\nrecord\tx\n")) != "" {
		t.Fatal("a record line inside a target block is not the header's")
	}
}
