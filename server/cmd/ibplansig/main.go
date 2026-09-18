// Command ibplansig signs and checks plan files with the server's plan
// signing key (docs/format.md "Plan signature"). For tests and for operators;
// the server signs plans itself.
//
//	ibplansig -data DIR sign plan.txt > signed.txt   (makes the key if DIR has none)
//	ibplansig -pub FILE verify signed.txt [record]   (FILE: plan-signing-key.pub)
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/robertsdotpm/installer-builder/server/internal/plansig"
)

func main() {
	data := flag.String("data", "", "data folder holding plan-signing-key.pem (sign)")
	pubFile := flag.String("pub", "", "public key file, base64 (verify)")
	flag.Parse()
	args := flag.Args()
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: ibplansig -data DIR sign PLAN | ibplansig -pub FILE verify PLAN [RECORD]")
		os.Exit(2)
	}
	doc, err := os.ReadFile(args[1])
	if err != nil {
		fail(err)
	}
	switch args[0] {
	case "sign":
		s, _, err := plansig.LoadOrCreate(*data)
		if err != nil {
			fail(err)
		}
		out, err := s.Sign(doc)
		if err != nil {
			fail(err)
		}
		os.Stdout.Write(out)
	case "verify":
		b, err := os.ReadFile(*pubFile)
		if err != nil {
			fail(err)
		}
		pub, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(b)))
		if err != nil || len(pub) != ed25519.PublicKeySize {
			fail(fmt.Errorf("%s: not a base64 Ed25519 public key", *pubFile))
		}
		if len(args) > 2 {
			_, err = plansig.VerifyFor(pub, doc, args[2])
		} else {
			_, err = plansig.Verify(pub, doc)
		}
		if err != nil {
			fail(err)
		}
		fmt.Printf("ok (key %s, record %s)\n", plansig.KeyID(pub), plansig.RecordOf(doc))
	default:
		fail(fmt.Errorf("unknown command %q", args[0]))
	}
}

func fail(err error) {
	fmt.Fprintln(os.Stderr, "ibplansig:", err)
	os.Exit(1)
}
