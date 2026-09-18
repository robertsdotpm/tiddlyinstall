package build

import (
	"strings"
	"testing"

	"github.com/robertsdotpm/installer-builder/server/internal/plansig"
)

func TestAddRequestLine(t *testing.T) {
	plan := "ib-plan\t1\nrecord\tabc\n\n[target]\nwhen\tlinux\t0\t9999\t*\n"
	got, err := AddRequestLine(plan, "name", "python", "Some.Pkg")
	if err != nil || got != "ib-plan\t1\nrequest\tname\tpython\tSome.Pkg\nrecord\tabc\n\n[target]\nwhen\tlinux\t0\t9999\t*\n" {
		t.Fatalf("%q %v", got, err)
	}
	// Tabs and newlines in a value can't add lines or fields.
	got, _ = AddRequestLine(plan, "name", "python", "a\tb\nlaunch\tevil")
	if strings.Count(got, "\n") != strings.Count(plan, "\n")+1 {
		t.Fatalf("value broke the format: %q", got)
	}
	if _, err := AddRequestLine("ib-record\t1\n", "name"); err == nil {
		t.Fatal("added to a record")
	}
	// The line is inside the signature.
	s, _, err := plansig.LoadOrCreate(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, _ := AddRequestLine(plan, "name", "python", "requests")
	signed, _ := s.SignString(p)
	tampered := strings.Replace(signed, "requests", "evil", 1)
	if _, err := plansig.Verify(s.Pub, []byte(tampered)); err == nil {
		t.Fatal("request line not covered by the signature")
	}
}
