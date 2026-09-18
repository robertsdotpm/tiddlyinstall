// Package ibtext reads and writes the line-based formats in docs/format.md
// and computes the hashes that name records and folders.
package ibtext

import (
	"crypto/sha256"
	"encoding/base32"
	"strings"
)

var b32 = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// Hash26 names a record: SHA-256 of its exact bytes, lowercase base32, 26 characters.
func Hash26(b []byte) string {
	s := sha256.Sum256(b)
	return b32.EncodeToString(s[:])[:26]
}

// Hash12 names a folder (design.md 1.1).
func Hash12(s string) string {
	h := sha256.Sum256([]byte(s))
	return b32.EncodeToString(h[:])[:12]
}

// IsHash26 reports whether s looks like a record hash.
func IsHash26(s string) bool {
	if len(s) != 26 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '2' && c <= '7') {
			return false
		}
	}
	return true
}

// Line is one key<TAB>value… line.
type Line struct {
	Key  string
	Vals []string
}

func (l Line) Val(i int) string {
	if i < len(l.Vals) {
		return l.Vals[i]
	}
	return ""
}

// Parse splits a document into lines, skipping blanks and comments.
func Parse(doc string) []Line {
	var out []Line
	for _, raw := range strings.Split(doc, "\n") {
		raw = strings.TrimSuffix(raw, "\r")
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		parts := strings.Split(raw, "\t")
		out = append(out, Line{Key: parts[0], Vals: parts[1:]})
	}
	return out
}

// Get returns the first value of the first line with this key.
func Get(lines []Line, key string) string {
	for _, l := range lines {
		if l.Key == key {
			return l.Val(0)
		}
	}
	return ""
}

// Writer builds a document. Values are cleaned so they can't break the format.
type Writer struct{ b strings.Builder }

func clean(s string) string {
	return strings.NewReplacer("\t", " ", "\r", " ", "\n", " ").Replace(s)
}

func (w *Writer) Add(key string, vals ...string) {
	w.b.WriteString(key)
	for _, v := range vals {
		w.b.WriteByte('\t')
		w.b.WriteString(clean(v))
	}
	w.b.WriteByte('\n')
}

// Raw appends text as-is (used for [target] headers and blank lines).
func (w *Writer) Raw(s string) { w.b.WriteString(s) }

func (w *Writer) String() string { return w.b.String() }
