// Command ibmeta prints the metadata block the server's reader finds in an
// installer (.exe or .run), signed or not. For tests.
//
//	ibmeta FILE   ->  record <sha256> <len> plan <len> pack <len>
package main

import (
	"crypto/sha256"
	"fmt"
	"os"

	"github.com/robertsdotpm/installer-builder/server/internal/ibfile"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: ibmeta FILE")
		os.Exit(2)
	}
	b, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	record, plan, _, packLen, err := ibfile.Read(b)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ibmeta:", err)
		os.Exit(1)
	}
	off, size := ibfile.CertTable(b)
	fmt.Printf("record %x %d plan %d pack %d certtable %d %d\n", sha256.Sum256(record), len(record), len(plan), packLen, off, size)
}
