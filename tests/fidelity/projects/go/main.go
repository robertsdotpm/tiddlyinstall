// Fidelity check: what real Go apps rely on (docs/test-results.md, "Real-app fidelity").
// Prints one "FID <ok|fail|skip> <check>[: detail]" line per check, then "FID end".
package main

import (
	"crypto/tls"
	"fmt"
	"net/http"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"golang.org/x/text/language"
	"golang.org/x/text/message"
)

func check(name string, fn func() (string, error)) {
	d, err := fn()
	if err != nil {
		fmt.Printf("FID fail %s: %s\n", name, strings.Join(strings.Fields(err.Error()), " "))
		return
	}
	fmt.Printf("FID ok %s: %s\n", name, d)
}

func main() {
	fmt.Printf("FID start go %s %s/%s\n", runtime.Version(), runtime.GOOS, runtime.GOARCH)
	check("https", func() (string, error) {
		c := &http.Client{Timeout: 60 * time.Second}
		r, err := c.Get("https://proxy.golang.org/golang.org/x/text/@v/list")
		if err != nil {
			return "", err
		}
		r.Body.Close()
		if r.StatusCode != 200 {
			return "", fmt.Errorf("HTTP %d", r.StatusCode)
		}
		// tls.VersionName is Go 1.21+; Windows 7 gets Go 1.20.
		names := map[uint16]string{tls.VersionTLS12: "TLS 1.2", tls.VersionTLS13: "TLS 1.3"}
		return names[r.TLS.Version], nil
	})
	check("module-dependency", func() (string, error) {
		p := message.NewPrinter(language.German)
		s := p.Sprintf("%d", 1234567)
		if s != "1.234.567" {
			return "", fmt.Errorf("got %q", s)
		}
		return "golang.org/x/text " + s, nil
	})
	check("os-exec", func() (string, error) {
		name, args := "sh", []string{"-c", "echo hi"}
		if runtime.GOOS == "windows" {
			name, args = "cmd", []string{"/c", "echo hi"}
		}
		out, err := exec.Command(name, args...).Output()
		return strings.TrimSpace(string(out)), err
	})
	check("cgo", func() (string, error) { return cgoCheck() })
	fmt.Println("FID end")
}
