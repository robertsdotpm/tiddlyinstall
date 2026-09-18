package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/robertsdotpm/installer-builder/server/internal/build"
)

// Plain file names (install_<runtime>_<package>, no record hash) resolve
// through their own limiter: each call can ask a package registry.
var nameLimiter = newLimiter(30, time.Minute)

// planByName answers GET /api/plan/name/{runtime}/{project} (api.md "Plans
// by name"): the plan for the synthetic record "install <project> from the
// <runtime> registry with default settings". The record is stored, so the
// plan's `record` line names something /api/records serves and the
// takedown list can name.
func (s *server) planByName(w http.ResponseWriter, r *http.Request) {
	if !nameLimiter.allow(clientIP(r)) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many plans by name from your address; try again in a minute.")
		return
	}
	rt, name := r.PathValue("runtime"), r.PathValue("project")
	if len(rt) > 20 || len(name) > 100 {
		apiError(w, 400, "invalid", "name too long")
		return
	}
	if _, err := s.cat.PackagePolicyFor(rt); err != nil {
		apiError(w, 404, "no_registry", err.Error())
		return
	}
	if err := build.PlainNameOK(name); err != nil {
		apiError(w, 400, "invalid", err.Error())
		return
	}
	norm, err := s.cat.ValidPackage(rt, name, "")
	if err != nil {
		apiError(w, 400, "invalid", err.Error())
		return
	}
	if s.takenDown("source package " + strings.ToLower(norm)) {
		apiError(w, 451, "taken_down", "This package has been taken down.")
		return
	}
	// Ask the registry first (the answer is cached for the plan), so names
	// that don't exist never leave a record behind.
	if _, err := s.b.LookupPackage(r.Context(), rt, norm, ""); err != nil {
		if errors.Is(err, build.ErrNoPackage) {
			apiError(w, 404, "no_such_package", err.Error())
		} else {
			apiError(w, 502, "registry_failed", err.Error())
		}
		return
	}
	hash, err := s.b.NameRecord(rt, norm)
	if err != nil {
		apiError(w, 500, "record_failed", err.Error())
		return
	}
	if s.takenDown("record " + hash) {
		apiError(w, 451, "taken_down", "This installer has been taken down.")
		return
	}
	var plats []string
	if p := r.URL.Query().Get("os"); p != "" {
		plats = []string{p}
	}
	plan, _, err := s.b.SignedNamePlan(hash, plats, rt, name)
	if err != nil {
		if errors.Is(err, build.ErrNoPackage) {
			apiError(w, 404, "no_such_package", err.Error())
			return
		}
		apiError(w, 502, "resolve_failed", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-IB-Record", hash)
	io.WriteString(w, plan)
}
