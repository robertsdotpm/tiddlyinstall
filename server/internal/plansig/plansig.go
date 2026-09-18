// Package plansig signs install plans with the backend's long-lived
// Ed25519 key, so a plan fetched over plain HTTP (old machines, design.md
// 1.3) can't be swapped or edited on the way (docs/format.md section 3.2).
//
// A signed plan is the plan's exact bytes followed by one last line:
//
//	sig<TAB>ed25519<TAB><base64 of the 64-byte signature>\n
//
// The signature (RFC 8032 Ed25519, no prehash, no context) covers every
// byte before that line, starting with the `ib-plan` header and ending
// with the newline just before `sig`. The plan's `record` line is inside
// the signed bytes, which is what binds a plan to one record: engines
// refuse a plan whose `record` isn't the record they are installing.
package plansig

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"strings"
)

// File names in the data folder.
const (
	KeyFile = "plan-signing-key.pem" // PKCS#8 private key, mode 0600
	PubFile = "plan-signing-key.pub" // base64 of the raw 32-byte public key; bases are built with it
)

const sigPrefix = "sig\ted25519\t"

// Signer holds the key.
type Signer struct {
	priv ed25519.PrivateKey
	Pub  ed25519.PublicKey
}

// LoadOrCreate reads the key from dir, or makes one if there is none. The
// public key file is (re)written from the private key every time, so it
// can't drift from it.
func LoadOrCreate(dir string) (s *Signer, created bool, err error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, false, err
	}
	kp := filepath.Join(dir, KeyFile)
	b, err := os.ReadFile(kp)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		_, priv, gerr := ed25519.GenerateKey(rand.Reader)
		if gerr != nil {
			return nil, false, gerr
		}
		der, merr := x509.MarshalPKCS8PrivateKey(priv)
		if merr != nil {
			return nil, false, merr
		}
		f, oerr := os.OpenFile(kp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if oerr != nil {
			// Another process made it first: use theirs.
			if errors.Is(oerr, fs.ErrExist) {
				return LoadOrCreate(dir)
			}
			return nil, false, oerr
		}
		werr := pem.Encode(f, &pem.Block{Type: "PRIVATE KEY", Bytes: der})
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr != nil {
			os.Remove(kp)
			return nil, false, werr
		}
		s, created = &Signer{priv: priv, Pub: priv.Public().(ed25519.PublicKey)}, true
	case err != nil:
		return nil, false, err
	default:
		if st, serr := os.Stat(kp); serr == nil && st.Mode().Perm()&0o077 != 0 {
			log.Printf("plansig: WARNING: %s is readable by other users (mode %v); chmod 600 it", kp, st.Mode().Perm())
		}
		blk, _ := pem.Decode(b)
		if blk == nil || blk.Type != "PRIVATE KEY" {
			return nil, false, fmt.Errorf("%s: not a PEM private key", kp)
		}
		k, perr := x509.ParsePKCS8PrivateKey(blk.Bytes)
		if perr != nil {
			return nil, false, fmt.Errorf("%s: %w", kp, perr)
		}
		priv, ok := k.(ed25519.PrivateKey)
		if !ok {
			return nil, false, fmt.Errorf("%s: not an Ed25519 key", kp)
		}
		s = &Signer{priv: priv, Pub: priv.Public().(ed25519.PublicKey)}
	}
	pub := []byte(s.PublicBase64() + "\n")
	pp := filepath.Join(dir, PubFile)
	if old, _ := os.ReadFile(pp); !bytes.Equal(old, pub) {
		if err := os.WriteFile(pp+".tmp", pub, 0o644); err != nil {
			return nil, false, err
		}
		if err := os.Rename(pp+".tmp", pp); err != nil {
			return nil, false, err
		}
	}
	return s, created, nil
}

// PublicBase64 is the raw 32-byte public key in standard base64 (44 characters).
func (s *Signer) PublicBase64() string { return base64.StdEncoding.EncodeToString(s.Pub) }

// PublicPEM is the public key as a SubjectPublicKeyInfo PEM (what openssl reads).
func (s *Signer) PublicPEM() string {
	der, _ := x509.MarshalPKIXPublicKey(s.Pub)
	return string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
}

// KeyID is a short fingerprint for logs and error messages: the first 16
// hex digits of the SHA-256 of the raw public key.
func KeyID(pub ed25519.PublicKey) string {
	h := sha256.Sum256(pub)
	return hex.EncodeToString(h[:8])
}

// Sign returns plan with its signature line appended. The plan must be an
// ib-plan and not already signed; a missing final newline is added first
// (it is part of the signed bytes).
func (s *Signer) Sign(plan []byte) ([]byte, error) {
	if !bytes.HasPrefix(plan, []byte("ib-plan\t")) {
		return nil, errors.New("plansig: not an ib-plan")
	}
	if _, _, signed := Split(plan); signed {
		return nil, errors.New("plansig: already signed")
	}
	out := make([]byte, 0, len(plan)+1+len(sigPrefix)+89)
	out = append(out, plan...)
	if len(out) > 0 && out[len(out)-1] != '\n' {
		out = append(out, '\n')
	}
	sig := ed25519.Sign(s.priv, out)
	out = append(out, sigPrefix...)
	out = append(out, base64.StdEncoding.EncodeToString(sig)...)
	out = append(out, '\n')
	return out, nil
}

// SignString is Sign for strings.
func (s *Signer) SignString(plan string) (string, error) {
	b, err := s.Sign([]byte(plan))
	return string(b), err
}

// Split finds the signature line. ok is false when the last line isn't a
// `sig` line (an unsigned plan). The last line is what follows the last
// newline, once one final "\n" (or "\r\n") is set aside.
func Split(doc []byte) (msg []byte, sigLine string, ok bool) {
	end := len(doc)
	if end > 0 && doc[end-1] == '\n' {
		end--
		if end > 0 && doc[end-1] == '\r' {
			end--
		}
	}
	nl := bytes.LastIndexByte(doc[:end], '\n')
	if nl < 0 {
		return doc, "", false
	}
	last := string(doc[nl+1 : end])
	if last != "sig" && !strings.HasPrefix(last, "sig\t") {
		return doc, "", false
	}
	return doc[:nl+1], last, true
}

// Errors from Verify.
var (
	ErrUnsigned = errors.New("the plan is not signed")
	ErrBadSig   = errors.New("the plan's signature does not verify")
)

// Verify checks a signed plan against pub and returns the signed bytes
// (the plan without its signature line).
func Verify(pub ed25519.PublicKey, doc []byte) ([]byte, error) {
	msg, line, ok := Split(doc)
	if !ok {
		return nil, ErrUnsigned
	}
	if !strings.HasPrefix(line, sigPrefix) {
		return nil, fmt.Errorf("%w: unknown signature type %q", ErrBadSig, line)
	}
	b64 := line[len(sigPrefix):]
	sig, err := base64.StdEncoding.Strict().DecodeString(b64)
	if err != nil || len(sig) != ed25519.SignatureSize || len(b64) != 88 {
		return nil, fmt.Errorf("%w: malformed signature", ErrBadSig)
	}
	if !bytes.HasPrefix(msg, []byte("ib-plan\t")) {
		return nil, fmt.Errorf("%w: signed bytes are not an ib-plan", ErrBadSig)
	}
	if !ed25519.Verify(pub, msg, sig) {
		return nil, ErrBadSig
	}
	return msg, nil
}

// VerifyFor is Verify plus the record binding: the plan's header `record`
// line must be exactly record.
func VerifyFor(pub ed25519.PublicKey, doc []byte, record string) ([]byte, error) {
	msg, err := Verify(pub, doc)
	if err != nil {
		return nil, err
	}
	if got := RecordOf(msg); got != record {
		return nil, fmt.Errorf("the plan is for record %q, not %q", got, record)
	}
	return msg, nil
}

// RecordOf returns the value of the plan header's first `record` line.
func RecordOf(plan []byte) string {
	for _, raw := range strings.Split(string(plan), "\n") {
		raw = strings.TrimSuffix(raw, "\r")
		if raw == "[target]" {
			break
		}
		if v, ok := strings.CutPrefix(raw, "record\t"); ok {
			v, _, _ = strings.Cut(v, "\t")
			return v
		}
	}
	return ""
}
