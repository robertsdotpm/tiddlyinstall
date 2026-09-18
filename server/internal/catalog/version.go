package catalog

import (
	"regexp"
	"strconv"
	"strings"
)

var preRe = regexp.MustCompile(`^[-_.~]?(a|b|c|rc|alpha|beta|pre|preview|dev)([-_.]?[0-9]|$)`)

// Version is a dotted release number. Pre-releases (anything with letters
// after the numbers, e.g. 3.13.0rc1) are flagged so "newest" skips them.
type Version struct {
	Parts []int
	Pre   bool
	Raw   string
}

func ParseVersion(s string) Version {
	v := Version{Raw: s}
	s = strings.TrimPrefix(strings.TrimPrefix(s, "v"), "go")
	for i, p := range strings.Split(s, ".") {
		n := 0
		j := 0
		for j < len(p) && p[j] >= '0' && p[j] <= '9' {
			j++
		}
		if j > 0 {
			n, _ = strconv.Atoi(p[:j])
		}
		if j < len(p) {
			// Only real pre-release markers count (3.13.0rc1, 1.0.0-beta);
			// build labels such as WinLibs' 16.2.0posix-14.0.0-ucrt-r1 don't.
			if preRe.MatchString(p[j:]) {
				v.Pre = true
			}
			if j == 0 && i > 0 {
				break
			}
		}
		v.Parts = append(v.Parts, n)
		if j < len(p) {
			break
		}
	}
	return v
}

// Cmp compares two versions numerically, padding with zeros.
func Cmp(a, b Version) int {
	n := len(a.Parts)
	if len(b.Parts) > n {
		n = len(b.Parts)
	}
	for i := 0; i < n; i++ {
		x, y := 0, 0
		if i < len(a.Parts) {
			x = a.Parts[i]
		}
		if i < len(b.Parts) {
			y = b.Parts[i]
		}
		if x != y {
			if x < y {
				return -1
			}
			return 1
		}
	}
	// A pre-release sorts before its release.
	if a.Pre != b.Pre {
		if a.Pre {
			return -1
		}
		return 1
	}
	return 0
}

// Matches reports whether v satisfies a Python-style specifier list
// (design.md 1.2): ==, !=, >=, <=, >, <, ~=, and == with a trailing .*
// An empty spec matches everything.
func Matches(v Version, spec string) bool {
	spec = strings.TrimSpace(spec)
	if spec == "" {
		return true
	}
	for _, c := range strings.Split(spec, ",") {
		c = strings.TrimSpace(c)
		if c == "" {
			continue
		}
		op := ""
		for _, o := range []string{"~=", "==", "!=", ">=", "<=", ">", "<"} {
			if strings.HasPrefix(c, o) {
				op = o
				break
			}
		}
		if op == "" {
			op = "=="
		} else {
			c = strings.TrimSpace(c[len(op):])
		}
		if !matchOne(v, op, c) {
			return false
		}
	}
	return true
}

func matchOne(v Version, op, target string) bool {
	if strings.HasSuffix(target, ".*") {
		prefix := ParseVersion(strings.TrimSuffix(target, ".*"))
		in := len(v.Parts) >= len(prefix.Parts)
		for i := range prefix.Parts {
			if !in || v.Parts[i] != prefix.Parts[i] {
				in = false
				break
			}
		}
		if op == "!=" {
			return !in
		}
		return in
	}
	t := ParseVersion(target)
	c := Cmp(v, t)
	switch op {
	case "==":
		// "==3.12" matches 3.12 and 3.12.0 but not 3.12.4 (PEP 440).
		return c == 0
	case "!=":
		return c != 0
	case ">=":
		return c >= 0
	case "<=":
		return c <= 0
	case ">":
		return c > 0
	case "<":
		return c < 0
	case "~=":
		if c < 0 || len(t.Parts) < 2 {
			return c >= 0
		}
		for i := 0; i < len(t.Parts)-1; i++ {
			if i >= len(v.Parts) || v.Parts[i] != t.Parts[i] {
				return false
			}
		}
		return true
	}
	return false
}
