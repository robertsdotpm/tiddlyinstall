// Command ibresolve prints the plan the resolver makes for a runtime, for
// checking the catalogue and the policy by eye.
package main

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
)

func main() {
	cat := flag.String("catalog", os.ExpandEnv("$HOME/projects/installer-builder-runtimes/catalog"), "catalogue folder")
	local := flag.String("local", os.ExpandEnv("$HOME/projects/installer-builder-runtimes"), "our copies of catalogue files")
	cache := flag.String("cache", "sha-cache.json", "hash cache")
	policy := flag.String("policy", "policy.json", "policy file")
	rt := flag.String("runtime", "python", "runtime id")
	sel := flag.String("select", "newest", "newest, asyncio, range, exact")
	rng := flag.String("range", "", "version range")
	plats := flag.String("platforms", "windows,macos,linux", "")
	pkg := flag.String("package", "", "a package source: registry name (no lookup is done)")
	pkgVer := flag.String("version", "", "the package's version")
	install := flag.String("install", "", `project install: "", "default" or a command`)
	flag.Parse()
	c, err := catalog.Load(*cat, *policy, *local, *cache)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	app := &catalog.App{RecordHash: "testtesttesttesttesttestte", Name: "Hello", Project: "hello", Runtime: *rt,
		Select: *sel, Range: *rng, Launch: c.Policy.Runtimes[*rt].Launch, Console: true, Menu: true,
		Platforms: strings.Split(*plats, ","), Install: *install}
	if *pkg != "" {
		name, err := c.ValidPackage(*rt, *pkg, *pkgVer)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		p := c.Policy.Runtimes[*rt].Package
		app.Package, app.PackageVersion = name, *pkgVer
		app.Project = catalog.PackageProject(p, name)
		app.Launch = strings.NewReplacer("{name}", name, "{module}", catalog.PackageModule(name), "{bin}", app.Project).Replace(p.Launch)
	}
	plan, err := c.Resolve(app)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(plan)
}
