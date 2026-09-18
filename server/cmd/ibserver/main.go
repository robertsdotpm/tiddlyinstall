// Command ibserver is the Installer Builder backend: the HTTP API
// (docs/api.md), the Asynq workers, and static hosting for the site.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/robertsdotpm/installer-builder/server/internal/build"
	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
	"github.com/robertsdotpm/installer-builder/server/internal/netsafe"
	"github.com/robertsdotpm/installer-builder/server/internal/plansig"
	"github.com/robertsdotpm/installer-builder/server/internal/queue"
)

const version = "0.1.0"

type server struct {
	q       *queue.Queue
	b       *build.Builder
	signer  *plansig.Signer
	cat     *catalog.Catalog
	data    string
	local   string
	site    string
	bases   string
	limiter *limiter
	// relayLimiter caps /api/relay per address, so it can't burn bandwidth.
	relayLimiter *limiter
	runtimes     struct {
		sync.Mutex
		body []byte
	}
	relayOK map[string]bool
}

func main() {
	home, _ := os.UserHomeDir()
	repo := filepath.Join(home, "projects", "installer-builder")
	addr := flag.String("addr", ":8080", "listen address")
	redisAddr := flag.String("redis", "127.0.0.1:6390", "Redis address")
	catDir := flag.String("catalog", filepath.Join(home, "projects/installer-builder-runtimes/catalog"), "runtime catalogue")
	local := flag.String("local", filepath.Join(home, "projects/installer-builder-runtimes"), "our copies of catalogue files (served at /mirror/)")
	policy := flag.String("policy", filepath.Join(repo, "server/policy.json"), "resolver policy")
	data := flag.String("data", filepath.Join(repo, "server/data"), "data folder")
	site := flag.String("site", repo, "static site to serve at /")
	bases := flag.String("bases", filepath.Join(repo, "bases"), "base installers")
	public := flag.String("public", "http://10.0.1.76:8080", "this server's public URL")
	workers := flag.Int("workers", 2, "concurrent jobs")
	redisDB := flag.Int("redis-db", 0, "Redis database number (a second instance needs its own)")
	mirror := flag.String("mirror", "", "URL of our mirror in plans (default: the policy's mirror_base)")
	mirrorLast := flag.Bool("mirror-last", false, "list our mirror after the vendors' URLs (for machines that reach us over a slow link)")
	flag.Parse()

	cat, err := catalog.Load(*catDir, *policy, *local, filepath.Join(*data, "sha-cache.json"))
	if err != nil {
		log.Fatal(err)
	}
	if *mirror != "" {
		cat.Policy.MirrorBase = *mirror
	}
	if *mirrorLast {
		cat.Policy.MirrorFirst = false
	}
	signer, created, err := plansig.LoadOrCreate(*data)
	if err != nil {
		log.Fatalf("plan signing key: %v", err)
	}
	if created {
		log.Printf("made a new plan signing key in %s; rebuild the bases with %s", *data, filepath.Join(*data, plansig.PubFile))
	}
	log.Printf("plan signing key %s (%s)", plansig.KeyID(signer.Pub), signer.PublicBase64())
	q := queue.New(*redisAddr, *redisDB, *workers)
	s := &server{q: q, signer: signer, cat: cat, data: *data, local: *local, site: *site, bases: *bases, limiter: newLimiter(20, time.Minute)}
	// Every outgoing fetch that a user can influence (sources, packs, the
	// relay) goes through a client that only reaches public addresses.
	s.b = &build.Builder{Cat: cat, Data: *data, Bases: *bases, Public: *public, Backend: *public, Signer: signer,
		HTTP: netsafe.Client(10 * time.Minute), TakenDown: s.takenDown}
	s.relayLimiter = newLimiter(30, time.Minute)
	s.relayOK = map[string]bool{}
	for _, rt := range cat.Runtimes {
		for _, e := range rt.Releases {
			s.relayOK[e.URL] = true
			for _, m := range e.Mirrors {
				s.relayOK[m] = true
			}
		}
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go func() {
		if err := q.Serve(ctx, s.b.Run); err != nil {
			log.Printf("workers: %v", err)
		}
	}()
	// Warm the runtimes summary (hashes our copies the first time).
	go s.runtimesJSON()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", s.health)
	mux.HandleFunc("POST /api/jobs", s.submit)
	mux.HandleFunc("GET /api/jobs/{id}", s.job)
	mux.HandleFunc("GET /api/records/{hash}", s.record)
	mux.HandleFunc("GET /api/plan/{hash}", s.plan)
	mux.HandleFunc("GET /api/plan/name/{runtime}/{project}", s.planByName)
	mux.HandleFunc("GET /api/pubkey", s.pubkey)
	mux.HandleFunc("GET /api/catalog/runtimes", s.runtimesHandler)
	mux.HandleFunc("GET /api/takedown", s.takedownHandler)
	mux.HandleFunc("GET /api/relay", s.relay)
	mux.HandleFunc("GET /dl/{hash}/{name}", s.dl)
	mux.HandleFunc("GET /bases/{os}", s.base)
	mux.HandleFunc("GET /icons/{file}", s.icon)
	mux.Handle("GET /src/", http.StripPrefix("/src/", noDirs(s.srcTakedown(http.FileServer(http.Dir(filepath.Join(*data, "src")))))))
	mux.Handle("GET /mirror/", http.StripPrefix("/mirror/", noDirs(http.FileServer(http.Dir(*local)))))
	mux.Handle("GET /", noDirs(siteOnly(http.FileServer(http.Dir(*site)))))

	srv := &http.Server{Addr: *addr, Handler: logReq(cors(mux)), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(sctx)
	}()
	log.Printf("installer-builder %s listening on %s (public %s)", version, *addr, *public)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// Middleware -------------------------------------------------------------

// cors opens every route to every origin; no route uses cookies or
// credentials, so this is safe (plan.md 1.8).
func cors(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Disposition, ETag")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func logReq(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if !strings.HasPrefix(r.URL.Path, "/api/jobs/") && r.URL.Path != "/api/health" {
			log.Printf("%s %s %s %s", clientIP(r), r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

// noDirs stops directory listings.
func noDirs(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// After StripPrefix, "" is the prefix's own folder: never list it.
		if r.URL.Path == "" || strings.HasSuffix(r.URL.Path, "/") && r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		h.ServeHTTP(w, r)
	})
}

// siteOnly serves the site's pages and assets, not the rest of the repo.
func siteOnly(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		ok := p == "/" || strings.HasPrefix(p, "/css/") || strings.HasPrefix(p, "/js/") || strings.HasPrefix(p, "/img/") || strings.HasPrefix(p, "/vendor/") ||
			(strings.Count(p, "/") == 1 && (strings.HasSuffix(p, ".html") || strings.HasSuffix(p, ".ico")))
		if !ok {
			http.NotFound(w, r)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func clientIP(r *http.Request) string {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return h
}

type limiter struct {
	mu     sync.Mutex
	n      int
	window time.Duration
	hits   map[string][]time.Time
}

func newLimiter(n int, window time.Duration) *limiter {
	return &limiter{n: n, window: window, hits: map[string][]time.Time{}}
}

func (l *limiter) allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	var keep []time.Time
	for _, t := range l.hits[ip] {
		if now.Sub(t) < l.window {
			keep = append(keep, t)
		}
	}
	if len(keep) >= l.n {
		l.hits[ip] = keep
		return false
	}
	l.hits[ip] = append(keep, now)
	// Forget addresses that have gone quiet, so the map can't grow forever.
	if len(l.hits) > 10000 {
		for k, ts := range l.hits {
			if len(ts) == 0 || now.Sub(ts[len(ts)-1]) > l.window {
				delete(l.hits, k)
			}
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func apiError(w http.ResponseWriter, status int, code, msg string) {
	writeJSON(w, status, map[string]string{"error": msg, "code": code})
}

// Handlers ---------------------------------------------------------------

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.q.Ping(ctx); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "version": version, "error": "queue unavailable"})
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "version": version, "workers": s.q.Workers,
		"queues": s.q.Depths(ctx), "time": time.Now().UTC().Format(time.RFC3339)})
}

func (s *server) submit(w http.ResponseWriter, r *http.Request) {
	if !s.limiter.allow(clientIP(r)) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many builds from your address; try again in a minute.")
		return
	}
	// Up to 1 MB of inline source plus a 1 MB icon in base64.
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		apiError(w, 400, "bad_request", "couldn't read the request")
		return
	}
	var req build.Request
	if err := json.Unmarshal(body, &req); err != nil {
		apiError(w, 400, "bad_json", "the request isn't valid JSON")
		return
	}
	class, err := req.Validate(s.cat)
	if err != nil {
		apiError(w, 400, "invalid", err.Error())
		return
	}
	if s.takenDown(sourceKey(req.Source.Kind, req.Source.Value)) {
		apiError(w, 451, "taken_down", "This source has been taken down.")
		return
	}
	// The icon is stored now and the job carries only its hash.
	if err := s.b.StoreIcon(&req); err != nil {
		apiError(w, 500, "store_failed", "couldn't store the icon")
		return
	}
	norm, _ := json.Marshal(req)
	j, err := s.q.Submit(r.Context(), class, norm)
	if err != nil {
		apiError(w, 503, "queue_unavailable", "The build queue is unavailable; try again shortly.")
		return
	}
	writeJSON(w, http.StatusAccepted, s.jobView(r.Context(), j))
}

func (s *server) jobView(ctx context.Context, j *queue.Job) map[string]any {
	pos := s.q.Position(ctx, j)
	v := map[string]any{"id": j.ID, "ticket": j.Ticket, "class": j.Class, "status": j.Status,
		"position": pos, "eta_seconds": s.q.ETA(ctx, j, pos), "progress": j.Progress, "error": j.Error}
	if len(j.Result) > 0 {
		v["result"] = j.Result
	}
	return v
}

func (s *server) job(w http.ResponseWriter, r *http.Request) {
	j, err := s.q.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		apiError(w, 404, "not_found", "No such job (jobs are kept for a week).")
		return
	}
	writeJSON(w, 200, s.jobView(r.Context(), j))
}

func (s *server) record(w http.ResponseWriter, r *http.Request) {
	h := r.PathValue("hash")
	if !ibtext.IsHash26(h) {
		apiError(w, 400, "bad_hash", "not a record hash")
		return
	}
	if s.takenDown("record " + h) {
		apiError(w, 451, "taken_down", "This installer has been taken down.")
		return
	}
	b, err := os.ReadFile(s.b.RecordPath(h))
	if err != nil {
		apiError(w, 404, "not_found", "no such record")
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Write(b)
}

func (s *server) plan(w http.ResponseWriter, r *http.Request) {
	h := r.PathValue("hash")
	if !ibtext.IsHash26(h) {
		apiError(w, 400, "bad_hash", "not a record hash")
		return
	}
	if s.takenDown("record " + h) {
		apiError(w, 451, "taken_down", "This installer has been taken down.")
		return
	}
	var plats []string
	if p := r.URL.Query().Get("os"); p != "" {
		plats = []string{p}
	}
	plan, _, err := s.b.SignedPlan(h, plats)
	if err != nil {
		if os.IsNotExist(err) {
			apiError(w, 404, "not_found", "no such record")
			return
		}
		apiError(w, 500, "resolve_failed", err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	io.WriteString(w, plan)
}

// pubkey publishes the plan signing key (docs/api.md). Bases carry their
// own copy, baked in at build time; this is for people checking a plan.
func (s *server) pubkey(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "public, max-age=3600")
	writeJSON(w, 200, map[string]any{"alg": "ed25519", "key": s.signer.PublicBase64(),
		"id": plansig.KeyID(s.signer.Pub), "pem": s.signer.PublicPEM()})
}

// runtimesJSON summarises, per runtime, the newest version for each OS
// range (the form's preview table). Cached until restart.
func (s *server) runtimesJSON() []byte {
	s.runtimes.Lock()
	defer s.runtimes.Unlock()
	if s.runtimes.body != nil {
		return s.runtimes.body
	}
	type row struct {
		Family  string  `json:"family"`
		Arch    string  `json:"arch"`
		Covers  string  `json:"covers"`
		Version *string `json:"version"`
		File    *string `json:"file"`
	}
	type rt struct {
		ID       string `json:"id"`
		Label    string `json:"label"`
		Compiled bool   `json:"compiled"`
		Launch   string `json:"launch"`
		Newest   []row  `json:"newest"`
	}
	var out []rt
	for _, id := range s.cat.Policy.RuntimeIDs() {
		pol := s.cat.Policy.Runtimes[id]
		plan, err := s.cat.Resolve(&catalog.App{RecordHash: "preview", Runtime: id, Launch: pol.Launch})
		if err != nil {
			continue
		}
		e := rt{ID: id, Label: pol.Label, Compiled: pol.Compiled, Launch: pol.Launch}
		var cur *row
		for _, l := range ibtext.Parse(plan) {
			switch l.Key {
			case "when":
				if cur != nil {
					e.Newest = append(e.Newest, *cur)
				}
				cur = &row{Family: l.Val(0), Arch: strings.Fields(l.Val(3))[0]}
			case "covers":
				if cur != nil {
					cur.Covers = l.Val(0)
				}
			case "runtime":
				if cur != nil {
					v := l.Val(1)
					cur.Version = &v
				}
			case "file":
				if cur != nil && cur.File == nil {
					f := l.Val(1)
					cur.File = &f
				}
			}
		}
		if cur != nil {
			e.Newest = append(e.Newest, *cur)
		}
		out = append(out, e)
	}
	s.runtimes.body, _ = json.Marshal(map[string]any{"runtimes": out})
	return s.runtimes.body
}

func (s *server) runtimesHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	w.Write(s.runtimesJSON())
}

func (s *server) takedownList() []string {
	f, err := os.Open(filepath.Join(s.data, "takedown.txt"))
	if err != nil {
		return nil
	}
	defer f.Close()
	var out []string
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		l := strings.TrimSpace(sc.Text())
		if l != "" && !strings.HasPrefix(l, "#") {
			out = append(out, l)
		}
	}
	return out
}

// sourceKey normalises a source for the takedown list, so owner/repo,
// https://github.com/owner/repo(.git)(/) and case variants all match.
func sourceKey(kind, value string) string {
	v := strings.ToLower(strings.TrimSpace(value))
	if kind == "github" {
		v = strings.TrimPrefix(strings.TrimPrefix(v, "https://"), "http://")
		v = strings.TrimPrefix(v, "github.com/")
		v = strings.TrimSuffix(strings.TrimSuffix(v, "/"), ".git")
	}
	return "source " + kind + " " + v
}

// srcTakedown refuses stored sources whose hash is on the takedown list.
func (s *server) srcTakedown(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sha := strings.TrimSuffix(r.URL.Path, ".tar.gz")
		if s.takenDown("sha " + sha) {
			http.Error(w, "taken down", 451)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func (s *server) takenDown(entry string) bool {
	for _, l := range s.takedownList() {
		if l == entry {
			return true
		}
	}
	return false
}

func (s *server) takedownHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"entries": s.takedownList()})
}

// relay fetches catalogue files for pages on hosts without CORS
// (packed-files.md 4.2). Only URLs the catalogue lists are allowed.
func (s *server) relay(w http.ResponseWriter, r *http.Request) {
	if !s.relayLimiter.allow(clientIP(r)) {
		apiError(w, http.StatusTooManyRequests, "rate_limited", "Too many relay requests; try again in a minute.")
		return
	}
	u := r.URL.Query().Get("url")
	if !s.relayOK[u] {
		apiError(w, 403, "not_in_catalogue", "The relay only fetches files listed in the runtime catalogue.")
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "GET", u, nil)
	resp, err := s.b.HTTP.Do(req)
	if err != nil {
		apiError(w, 502, "upstream", err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		apiError(w, 502, "upstream", resp.Status)
		return
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	io.Copy(w, resp.Body)
}

func (s *server) dl(w http.ResponseWriter, r *http.Request) {
	hash, name := r.PathValue("hash"), r.PathValue("name")
	if !ibtext.IsHash26(hash) || strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		http.NotFound(w, r)
		return
	}
	if s.takenDown("record " + hash) {
		apiError(w, 451, "taken_down", "This installer has been taken down.")
		return
	}
	p := filepath.Join(s.data, "dl", hash, name)
	if _, err := os.Stat(p); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", name))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, p)
}

// icon serves an uploaded icon by its SHA-256 (records name it in `icon`).
func (s *server) icon(w http.ResponseWriter, r *http.Request) {
	sha, ok := strings.CutSuffix(r.PathValue("file"), ".png")
	if !ok || !build.IsSHA256(sha) {
		http.NotFound(w, r)
		return
	}
	if s.takenDown("sha " + sha) {
		apiError(w, 451, "taken_down", "This icon has been taken down.")
		return
	}
	p := s.b.IconPath(sha)
	if _, err := os.Stat(p); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, p)
}

func (s *server) base(w http.ResponseWriter, r *http.Request) {
	files := map[string][2]string{
		"windows": {"windows/out/base.exe", "base.exe"},
		"linux":   {"unix/out/ib-base.run", "ib-base.run"},
		"macos":   {"unix/out/ib-base-macos.zip", "ib-base-macos.zip"},
	}
	f, ok := files[r.PathValue("os")]
	if !ok {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", f[1]))
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeFile(w, r, filepath.Join(s.bases, f[0]))
}
