// Checks the Go toolchain: a module dependency downloaded through the
// proxy at install time, and `go install` into a folder of our own.
package main

import (
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"rsc.io/quote"
)

func say(state, name, detail string) {
	fmt.Printf("TOOL %s %s: %s\n", state, name, detail)
}

func run(prog string, env []string, args ...string) (string, error) {
	cmd := exec.Command(prog, args...)
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	s := strings.Join(strings.Fields(string(out)), " ")
	if err != nil {
		return "", fmt.Errorf("%v: %s", err, s)
	}
	if len(s) > 120 {
		s = s[:120]
	}
	return s, nil
}

// A built program cannot find the toolchain that built it, so the record's
// launch command passes {runtime_dir} as the first argument.
func goBin() string {
	if len(os.Args) < 2 || os.Args[1] == "" {
		return ""
	}
	name := "go"
	if runtime.GOOS == "windows" {
		name = "go.exe"
	}
	return filepath.Join(os.Args[1], "bin", name)
}

func main() {
	// At run time the app has none of the install step's Go environment, so
	// anything the toolchain is asked to do here would write into the user's
	// home ($HOME/go, $HOME/.cache/go-build, the telemetry folder the
	// recipe's XDG_CONFIG_HOME keeps out at install time). Point all of it
	// at one throwaway folder for the whole run.
	sand, serr := ioutil.TempDir("", "toolgoenv")
	if serr == nil {
		defer os.RemoveAll(sand)
		for k, v := range map[string]string{
			"GOPATH": filepath.Join(sand, "gopath"), "GOMODCACHE": filepath.Join(sand, "gopath", "pkg", "mod"),
			"GOCACHE": filepath.Join(sand, "go-build"), "GOENV": "off", "GOTOOLCHAIN": "local", "GOFLAGS": "",
			"XDG_CONFIG_HOME": filepath.Join(sand, "config"), "APPDATA": filepath.Join(sand, "config"),
			"LOCALAPPDATA": filepath.Join(sand, "localconfig"), "HOME": sand, "USERPROFILE": sand,
		} {
			os.Setenv(k, v)
		}
	}

	say("ok", "module-download", "rsc.io/quote says: "+quote.Hello())

	g := goBin()
	if g == "" {
		say("skip", "go-version", "the launch command passed no runtime folder")
	} else if out, err := run(g, nil, "version"); err != nil {
		say("fail", "go-version", err.Error())
	} else {
		say("ok", "go-version", out)
	}

	if g == "" {
		say("skip", "go-install", "the launch command passed no runtime folder")
	} else {
		dir, err := ioutil.TempDir("", "toolgo")
		if err != nil {
			say("fail", "go-install", err.Error())
		} else {
			defer os.RemoveAll(dir)
			// `go install <path>@<version>` outside a module needs Go 1.16;
			// older toolchains report it, and the cell says so.
			// Everything the toolchain would otherwise write into the
			// user's home ($HOME/go, $HOME/.cache/go-build) goes into this
			// throwaway folder instead: at run time the app has none of the
			// install step's Go environment.
			_, err = run(g, []string{"GOBIN=" + dir}, "install", "rsc.io/2fa@v1.2.0")
			if err != nil {
				say("fail", "go-install", err.Error())
			} else {
				names, _ := filepath.Glob(filepath.Join(dir, "*"))
				say("ok", "go-install", fmt.Sprintf("%d program(s) in GOBIN", len(names)))
			}
		}
	}

	say("ok", "stdlib", "go "+runtime.Version()+" on "+runtime.GOOS+"/"+runtime.GOARCH)
	fmt.Println("TOOL runtime go " + runtime.Version())
	fmt.Println("TOOL end")
}
