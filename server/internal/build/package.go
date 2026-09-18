package build

// Package sources (design.md 1.7 "Packages", format.md section 2):
// registry lookups, launch defaults, and the synthetic records behind
// plain file names (install_<runtime>_<package>, api.md "Plans by name").

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
)

// ErrNoPackage: the registry says there is no such package (or version).
var ErrNoPackage = errors.New("no such package")

// PkgInfo is what a registry lookup found.
type PkgInfo struct {
	Name, Version string
	Bin, BinPath  string // the program to launch, if the registry says
}

type lookupEntry struct {
	at  time.Time
	doc any
	err error
}

var lookupCache = struct {
	sync.Mutex
	m map[string]lookupEntry
}{m: map[string]lookupEntry{}}

// registryJSON fetches registry metadata, cached for ten minutes so plain
// names can't be used to hammer a registry through us. The answer is
// untrusted data: only a version and a program name are taken from it,
// and both are checked before use.
func (b *Builder) registryJSON(ctx context.Context, tmpl, name, version string) (any, error) {
	u := strings.NewReplacer("{name}", url.PathEscape(name), "{version}", url.PathEscape(version)).Replace(tmpl)
	u = strings.ReplaceAll(u, "%2F", "/") // Go module paths keep their slashes
	lookupCache.Lock()
	if e, ok := lookupCache.m[u]; ok && time.Since(e.at) < 10*time.Minute {
		lookupCache.Unlock()
		return e.doc, e.err
	}
	lookupCache.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
	req.Header.Set("Accept", "application/json")
	// crates.io refuses requests without a User-Agent naming the client.
	req.Header.Set("User-Agent", "installer-builder/0.1 (+"+b.Public+")")
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var doc any
	switch {
	case resp.StatusCode == 404 || resp.StatusCode == 410:
		err = ErrNoPackage
	case resp.StatusCode != 200:
		return nil, fmt.Errorf("package registry: %s", resp.Status)
	default:
		err = json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(&doc)
		if err != nil {
			return nil, fmt.Errorf("package registry: unreadable answer: %v", err)
		}
	}
	lookupCache.Lock()
	lookupCache.m[u] = lookupEntry{time.Now(), doc, err}
	lookupCache.Unlock()
	return doc, err
}

// LookupPackage checks a package in its registry, pins the newest version
// when none is given, and finds its program when the policy says where.
// A runtime whose policy has no lookup (Go, .NET) returns the input as is:
// the package manager checks the name at install time.
func (b *Builder) LookupPackage(ctx context.Context, runtime, name, version string) (*PkgInfo, error) {
	p, err := b.Cat.PackagePolicyFor(runtime)
	if err != nil {
		return nil, err
	}
	info := &PkgInfo{Name: name, Version: version}
	if p.Lookup == "" {
		return info, nil
	}
	var doc any
	if version == "" || p.LookupVersion == "" {
		if doc, err = b.registryJSON(ctx, p.Lookup, name, ""); err != nil {
			return nil, lookupErr(err, p, name, "")
		}
		if version == "" {
			v, _ := catalog.JSONField(doc, p.VersionField).(string)
			if _, err := b.Cat.ValidPackage(runtime, name, v); err != nil || v == "" {
				return nil, fmt.Errorf("%s gave no usable version for %s", orDefault(p.Registry, "The registry"), name)
			}
			info.Version = v
		}
	}
	if p.LookupVersion != "" && (version != "" || p.BinField != "") {
		if doc, err = b.registryJSON(ctx, p.LookupVersion, name, info.Version); err != nil {
			return nil, lookupErr(err, p, name, info.Version)
		}
	}
	if p.BinField != "" {
		project := catalog.PackageProject(p, name)
		info.Bin, info.BinPath, err = catalog.PickBin(catalog.JSONField(doc, p.BinField), project)
		if err != nil {
			return nil, fmt.Errorf("%s %s: %v", name, info.Version, err)
		}
	}
	return info, nil
}

func lookupErr(err error, p *catalog.PackagePolicy, name, version string) error {
	if errors.Is(err, ErrNoPackage) {
		if version != "" {
			return fmt.Errorf("%s has no %s %s: %w", orDefault(p.Registry, "the registry"), name, version, ErrNoPackage)
		}
		return fmt.Errorf("%s has no package named %s: %w", orDefault(p.Registry, "the registry"), name, ErrNoPackage)
	}
	return err
}

// PackageLaunch expands the server-side launch tokens: {name}, {module},
// and, when info is known, {bin} and {bin_path}. With info nil the last
// two are left for the plan (plain-name records).
func PackageLaunch(launch, runtime string, p *catalog.PackagePolicy, name string, info *PkgInfo) (string, error) {
	project := catalog.PackageProject(p, name)
	r := []string{"{name}", name, "{module}", catalog.PackageModule(name)}
	if info != nil {
		bin := orDefault(info.Bin, project)
		r = append(r, "{bin}", bin)
		if strings.Contains(launch, "{bin_path}") {
			if info.BinPath == "" {
				return "", fmt.Errorf("%s doesn't say which program %s runs; give a launch command", orDefault(p.Registry, "The registry"), name)
			}
			r = append(r, "{bin_path}", info.BinPath)
		}
	}
	return strings.NewReplacer(r...).Replace(launch), nil
}

// preparePackage finishes a package app for a plan: a record without a
// pinned version (plain names) gets today's newest, and launch tokens the
// record left open are filled in.
func (b *Builder) preparePackage(ctx context.Context, app *catalog.App) error {
	p, err := b.Cat.PackagePolicyFor(app.Runtime)
	if err != nil {
		return err
	}
	if app.PackageVersion != "" && !strings.Contains(app.Launch, "{bin") {
		return nil
	}
	info, err := b.LookupPackage(ctx, app.Runtime, app.Package, app.PackageVersion)
	if err != nil {
		return err
	}
	app.PackageVersion = info.Version
	app.Launch, err = PackageLaunch(app.Launch, app.Runtime, p, app.Package, info)
	return err
}

// NameRecord makes (or finds) the record behind a plain file name,
// install_<runtime>_<package>: the package from the runtime's registry with
// every setting at its default. Its bytes depend only on the runtime, the
// name and this server's URL, so the same name always gives the same record
// hash, which the takedown list and the transparency screen can name. It
// pins no version: each plan names the registry's newest at the time.
func (b *Builder) NameRecord(runtime, name string) (string, error) {
	name, err := b.Cat.ValidPackage(runtime, name, "")
	if err != nil {
		return "", err
	}
	p, _ := b.Cat.PackagePolicyFor(runtime)
	project := catalog.PackageProject(p, name)
	launch, err := PackageLaunch(p.Launch, runtime, p, name, nil)
	if err != nil {
		return "", err
	}
	var w ibtext.Writer
	w.Add("ib-record", "1")
	w.Add("name", project)
	w.Add("project", project)
	w.Add("runtime", runtime)
	w.Add("select", "newest")
	w.Add("source", "package", name)
	w.Add("launch", launch)
	w.Add("install", "default")
	w.Add("console", "1")
	w.Add("menu", "1")
	w.Add("desktop", "0")
	w.Add("root", "user")
	w.Add("rootname", "ib")
	w.Add("platforms", "windows linux macos")
	w.Add("backend", b.Backend)
	w.Add("origin", "name")
	rec := []byte(w.String())
	hash := ibtext.Hash26(rec)
	return hash, b.storeRecord(hash, rec)
}
