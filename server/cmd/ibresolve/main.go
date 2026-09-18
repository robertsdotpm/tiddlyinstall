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
	flag.Parse()
	c, err := catalog.Load(*cat, *policy, *local, *cache)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	app := &catalog.App{RecordHash: "testtesttesttesttesttestte", Name: "Hello", Project: "hello", Runtime: *rt,
		Select: *sel, Range: *rng, Launch: c.Policy.Runtimes[*rt].Launch, Console: true, Menu: true,
		Platforms: strings.Split(*plats, ",")}
	plan, err := c.Resolve(app)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Print(plan)
}
