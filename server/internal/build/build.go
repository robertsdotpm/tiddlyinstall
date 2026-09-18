// Package build turns a form submission into a record and installer files
// (plan.md sections 1.1 and 1.8). The bases are never rebuilt here: mode A
// renames our signed base, modes B and C append a metadata block.
package build

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/robertsdotpm/installer-builder/server/internal/catalog"
	"github.com/robertsdotpm/installer-builder/server/internal/ibfile"
	"github.com/robertsdotpm/installer-builder/server/internal/ibtext"
	"github.com/robertsdotpm/installer-builder/server/internal/queue"
)

// Request is the body of POST /api/jobs (docs/api.md).
type Request struct {
	Name   string `json:"name"`
	Source struct {
		Kind    string `json:"kind"`
		Value   string `json:"value"`
		Ref     string `json:"ref"`
		Version string `json:"version"`
	} `json:"source"`
	Runtime   string            `json:"runtime"`
	Select    string            `json:"select"`
	Range     string            `json:"range"`
	Launch    string            `json:"launch"`
	Install   string            `json:"install"`
	Console   *bool             `json:"console"`
	Menu      *bool             `json:"menu"`
	Desktop   bool              `json:"desktop"`
	Root      string            `json:"root"`
	RootName  string            `json:"rootname"`
	Platforms []string          `json:"platforms"`
	Mode      string            `json:"mode"`
	Offline   bool              `json:"offline"`
	Files     map[string]string `json:"files"`
}

var (
	safeName   = regexp.MustCompile(`[^a-z0-9_.-]+`)
	projectRe  = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
	githubRe   = regexp.MustCompile(`^(?:https?://github\.com/)?([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?/?$`)
	platformOK = map[string]bool{"windows": true, "linux": true, "macos": true}
)

// Validate checks a request before it is queued, and picks its class.
func (r *Request) Validate(cat *catalog.Catalog) (class string, err error) {
	if cat.Runtimes[r.Runtime] == nil {
		return "", fmt.Errorf("unknown runtime %q", r.Runtime)
	}
	switch r.Mode {
	case "A", "B", "C":
	default:
		return "", errors.New("mode must be A, B or C")
	}
	if r.Offline && r.Mode == "A" {
		return "", errors.New("offline installers can't be signed by Installer Builder (design.md section 3); choose mode B or C")
	}
	if len(r.Platforms) == 0 {
		r.Platforms = []string{"windows", "linux", "macos"}
	}
	for _, p := range r.Platforms {
		if !platformOK[p] {
			return "", fmt.Errorf("unknown platform %q", p)
		}
	}
	switch r.Select {
	case "", "newest", "asyncio":
	case "range", "exact":
		if strings.TrimSpace(r.Range) == "" {
			return "", errors.New("a version range is needed")
		}
	default:
		return "", fmt.Errorf("unknown version choice %q", r.Select)
	}
	if len(r.Name) > 80 || len(r.Launch) > 400 || len(r.Install) > 400 || len(r.Range) > 100 {
		return "", errors.New("a field is too long")
	}
	switch r.Source.Kind {
	case "inline":
		total := 0
		if len(r.Files) == 0 || len(r.Files) > 200 {
			return "", errors.New("inline source needs 1 to 200 files")
		}
		for p, c := range r.Files {
			total += len(c)
			if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "..") || strings.ContainsAny(p, "\\:\x00") {
				return "", fmt.Errorf("bad file name %q", p)
			}
		}
		if total > 1<<20 {
			return "", errors.New("inline source is limited to 1 MB")
		}
	case "github":
		if !githubRe.MatchString(strings.TrimSpace(r.Source.Value)) {
			return "", errors.New("GitHub source must be owner/repo or a github.com URL")
		}
	case "url":
		if !strings.HasPrefix(r.Source.Value, "https://") && !strings.HasPrefix(r.Source.Value, "http://") {
			return "", errors.New("source URL must be http(s)")
		}
	case "package":
		if !projectRe.MatchString(r.Source.Value) {
			return "", errors.New("bad package name")
		}
	default:
		return "", errors.New("source kind must be github, package, url or inline")
	}
	if r.Offline {
		return "pack", nil
	}
	if r.Mode == "A" {
		return "record", nil
	}
	return "build", nil
}

// Builder holds what jobs need.
type Builder struct {
	Cat     *catalog.Catalog
	Data    string // data folder: records/, src/, dl/, cache/
	Bases   string // repo's bases/ folder
	Public  string // this server's URL, e.g. http://10.0.1.76:8080
	HTTP    *http.Client
	Backend string // written into records so online installers find us
}

// Result is what a finished job returns (docs/api.md).
type Result struct {
	Record string       `json:"record"`
	Files  []ResultFile `json:"files"`
}

type ResultFile struct {
	Platform string `json:"platform"`
	Name     string `json:"name"`
	URL      string `json:"url"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
	Signed   string `json:"signed"`
	Offline  bool   `json:"offline"`
}

// Run is the queue handler.
func (b *Builder) Run(ctx context.Context, j *queue.Job, progress func(string)) (json.RawMessage, error) {
	var r Request
	if err := json.Unmarshal(j.Request, &r); err != nil {
		return nil, err
	}
	if _, err := r.Validate(b.Cat); err != nil {
		return nil, err
	}
	progress("Resolving the source")
	src, project, installNeeded, err := b.source(ctx, &r)
	if err != nil {
		return nil, err
	}
	pol := b.Cat.Policy.Runtimes[r.Runtime]
	launch := r.Launch
	if launch == "" {
		launch = pol.Launch
	}
	install := r.Install
	if install == "" && (installNeeded || pol.Compiled) {
		install = "default"
	}
	name := r.Name
	if name == "" {
		name = project
	}
	console := r.Console == nil || *r.Console
	menu := r.Menu == nil || *r.Menu

	progress("Writing the record")
	var w ibtext.Writer
	w.Add("ib-record", "1")
	w.Add("name", name)
	w.Add("project", project)
	w.Add("runtime", r.Runtime)
	w.Add("select", orDefault(r.Select, "newest"))
	if r.Range != "" {
		w.Add("range", r.Range)
	}
	switch r.Source.Kind {
	case "inline":
		w.Add("source", "inline", src.SHA256)
	case "github":
		w.Add("source", "github", src.origin, src.commit, src.SHA256)
	case "url":
		w.Add("source", "url", r.Source.Value, src.SHA256)
	case "package":
		w.Add("source", "package", r.Source.Value, r.Source.Version)
	}
	w.Add("launch", launch)
	if install != "" {
		w.Add("install", install)
	}
	w.Add("console", b01(console))
	w.Add("menu", b01(menu))
	w.Add("desktop", b01(r.Desktop))
	w.Add("root", orDefault(r.Root, "user"))
	w.Add("rootname", orDefault(r.RootName, "ib"))
	w.Add("platforms", strings.Join(r.Platforms, " "))
	w.Add("backend", b.Backend)
	w.Add("created", time.Now().UTC().Format(time.RFC3339))
	record := []byte(w.String())
	hash := ibtext.Hash26(record)
	if err := b.storeRecord(hash, record); err != nil {
		return nil, err
	}

	res := Result{Record: hash}
	stem := "install_" + r.Runtime + "_" + safeName.ReplaceAllString(strings.ToLower(project), "-")
	if r.Mode == "A" {
		stem += "_" + hash
	}
	for _, plat := range r.Platforms {
		progress("Building the " + plat + " installer")
		f, err := b.output(ctx, &r, plat, stem, hash, record, progress)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", plat, err)
		}
		res.Files = append(res.Files, *f)
	}
	return json.Marshal(res)
}

// Records ----------------------------------------------------------------

func (b *Builder) RecordPath(hash string) string {
	return filepath.Join(b.Data, "records", hash+".txt")
}

func (b *Builder) storeRecord(hash string, rec []byte) error {
	p := b.RecordPath(hash)
	if old, err := os.ReadFile(p); err == nil {
		if !bytes.Equal(old, rec) {
			// A truncated-hash collision: refuse (design.md section 4).
			return errors.New("record hash collision; change any field and try again")
		}
		return nil
	}
	return ibfile.WriteAtomic(p, rec)
}

// LoadApp reads a stored record into what the resolver needs.
func (b *Builder) LoadApp(hash string) (*catalog.App, []byte, error) {
	rec, err := os.ReadFile(b.RecordPath(hash))
	if err != nil {
		return nil, nil, err
	}
	lines := ibtext.Parse(string(rec))
	g := func(k string) string { return ibtext.Get(lines, k) }
	app := &catalog.App{RecordHash: hash, Name: g("name"), Project: g("project"), Runtime: g("runtime"),
		Select: g("select"), Range: g("range"), Launch: g("launch"), Install: g("install"),
		Console: g("console") == "1", Menu: g("menu") == "1", Desktop: g("desktop") == "1",
		Root: g("root"), RootName: g("rootname"), Platforms: strings.Fields(g("platforms"))}
	for _, l := range lines {
		if l.Key != "source" {
			continue
		}
		switch l.Val(0) {
		case "inline":
			app.Source = b.srcFile(l.Val(1), 1)
		case "github":
			app.Source = b.srcFile(l.Val(3), 1)
			if app.Source != nil {
				app.Source.URLs = append(app.Source.URLs, "https://codeload.github.com/"+l.Val(1)+"/tar.gz/"+l.Val(2))
			}
		case "url":
			app.Source = b.srcFile(l.Val(2), -1)
			if app.Source != nil {
				app.Source.URLs = append(app.Source.URLs, l.Val(1))
			}
		case "package":
			app.PackageCmd = l.Val(1)
			if v := l.Val(2); v != "" {
				app.PackageCmd += "==" + v
			}
		}
	}
	return app, rec, nil
}

// Plan resolves the current plan for a stored record.
func (b *Builder) Plan(hash string, platforms []string) (string, []catalog.FileRef, error) {
	app, _, err := b.LoadApp(hash)
	if err != nil {
		return "", nil, err
	}
	if platforms != nil {
		app.Platforms = platforms
	}
	return b.Cat.ResolveFiles(app)
}

// Sources ----------------------------------------------------------------

type source struct {
	catalog.SourceFile
	origin, commit string
}

func (b *Builder) srcPath(sha string) string {
	return filepath.Join(b.Data, "src", sha+".tar.gz")
}

// srcFile describes a stored source archive (strip -1 = work it out).
func (b *Builder) srcFile(sha string, strip int) *catalog.SourceFile {
	p := b.srcPath(sha)
	st, err := os.Stat(p)
	if err != nil {
		return nil
	}
	if strip < 0 {
		strip = topFolder(p)
	}
	return &catalog.SourceFile{Name: sha + ".tar.gz", SHA256: sha, Size: st.Size(), Format: "tar.gz", Strip: strip,
		URLs: []string{strings.TrimRight(b.Public, "/") + "/src/" + sha + ".tar.gz"}}
}

func (b *Builder) source(ctx context.Context, r *Request) (*source, string, bool, error) {
	pol := b.Cat.Policy.Runtimes[r.Runtime]
	switch r.Source.Kind {
	case "inline":
		project := projectName(r)
		data, names, err := inlineTarball(project, r.Files)
		if err != nil {
			return nil, "", false, err
		}
		sha := sha256hex(data)
		if err := ibfile.WriteAtomic(b.srcPath(sha), data); err != nil {
			return nil, "", false, err
		}
		return &source{SourceFile: catalog.SourceFile{SHA256: sha}}, project, anyOf(names, pol.InstallFiles), nil
	case "github":
		m := githubRe.FindStringSubmatch(strings.TrimSpace(r.Source.Value))
		owner, repo := m[1], m[2]
		ref := orDefault(r.Source.Ref, "HEAD")
		commit, err := b.githubCommit(ctx, owner, repo, ref)
		if err != nil {
			return nil, "", false, err
		}
		data, err := b.fetch(ctx, "https://codeload.github.com/"+owner+"/"+repo+"/tar.gz/"+commit, 200<<20)
		if err != nil {
			return nil, "", false, err
		}
		sha := sha256hex(data)
		if err := ibfile.WriteAtomic(b.srcPath(sha), data); err != nil {
			return nil, "", false, err
		}
		names, _ := tarNames(data)
		project := strings.ToLower(repo)
		return &source{SourceFile: catalog.SourceFile{SHA256: sha}, origin: owner + "/" + repo, commit: commit}, project, anyOf(names, pol.InstallFiles), nil
	case "url":
		data, err := b.fetch(ctx, r.Source.Value, 200<<20)
		if err != nil {
			return nil, "", false, err
		}
		if !bytes.HasPrefix(data, []byte{0x1f, 0x8b}) {
			return nil, "", false, errors.New("source URL must be a .tar.gz for now")
		}
		sha := sha256hex(data)
		if err := ibfile.WriteAtomic(b.srcPath(sha), data); err != nil {
			return nil, "", false, err
		}
		names, _ := tarNames(data)
		return &source{SourceFile: catalog.SourceFile{SHA256: sha}}, projectName(r), anyOf(names, pol.InstallFiles), nil
	case "package":
		return &source{}, strings.ToLower(r.Source.Value), true, nil
	}
	return nil, "", false, errors.New("unknown source kind")
}

func projectName(r *Request) string {
	p := strings.ToLower(safeName.ReplaceAllString(strings.ToLower(r.Name), "_"))
	p = strings.Trim(p, "_.-")
	if r.Source.Kind == "url" {
		base := path.Base(r.Source.Value)
		base = strings.TrimSuffix(strings.TrimSuffix(base, ".gz"), ".tar")
		if p == "" {
			p = safeName.ReplaceAllString(strings.ToLower(base), "_")
		}
	}
	if p == "" {
		p = "app"
	}
	if len(p) > 40 {
		p = p[:40]
	}
	return p
}

// inlineTarball packs site-written files deterministically under project/.
func inlineTarball(project string, files map[string]string) ([]byte, []string, error) {
	var names []string
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	var buf bytes.Buffer
	gz, _ := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	gz.ModTime = time.Unix(0, 0)
	tw := tar.NewWriter(gz)
	dirs := map[string]bool{}
	for _, n := range names {
		parts := strings.Split(n, "/")
		for i := 1; i < len(parts); i++ {
			d := strings.Join(parts[:i], "/")
			if !dirs[d] {
				dirs[d] = true
				tw.WriteHeader(&tar.Header{Name: project + "/" + d + "/", Mode: 0o755, Typeflag: tar.TypeDir, ModTime: time.Unix(0, 0), Format: tar.FormatUSTAR})
			}
		}
		c := []byte(files[n])
		mode := int64(0o644)
		if strings.HasPrefix(files[n], "#!") {
			mode = 0o755
		}
		if err := tw.WriteHeader(&tar.Header{Name: project + "/" + n, Mode: mode, Size: int64(len(c)), ModTime: time.Unix(0, 0), Format: tar.FormatUSTAR}); err != nil {
			return nil, nil, err
		}
		tw.Write(c)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes(), names, nil
}

func tarNames(gzData []byte) ([]string, error) {
	gz, err := gzip.NewReader(bytes.NewReader(gzData))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	var out []string
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		n := h.Name
		if i := strings.Index(n, "/"); i >= 0 {
			n = n[i+1:]
		}
		out = append(out, n)
	}
	return out, nil
}

func topFolder(p string) int {
	b, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	gz, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		return 0
	}
	tr := tar.NewReader(gz)
	top := ""
	for {
		h, err := tr.Next()
		if err != nil {
			break
		}
		t := strings.SplitN(strings.TrimPrefix(h.Name, "./"), "/", 2)[0]
		if top == "" {
			top = t
		} else if t != top {
			return 0
		}
	}
	if top == "" {
		return 0
	}
	return 1
}

func anyOf(names, want []string) bool {
	for _, n := range names {
		if contains(want, n) {
			return true
		}
	}
	return false
}

func (b *Builder) githubCommit(ctx context.Context, owner, repo, ref string) (string, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", "https://api.github.com/repos/"+owner+"/"+repo+"/commits/"+ref, nil)
	req.Header.Set("Accept", "application/vnd.github.sha")
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GitHub: %s/%s at %s: %s", owner, repo, ref, resp.Status)
	}
	sha := strings.TrimSpace(string(body))
	if len(sha) != 40 {
		return "", errors.New("GitHub returned an unexpected commit id")
	}
	return sha, nil
}

func (b *Builder) fetch(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := b.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("%s: %s", url, resp.Status)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("download too large")
	}
	return data, nil
}

// Outputs ----------------------------------------------------------------

func (b *Builder) basePath(plat string, signed bool) string {
	switch plat {
	case "windows":
		if signed {
			return filepath.Join(b.Bases, "windows", "out", "base-signed.exe")
		}
		return filepath.Join(b.Bases, "windows", "out", "base.exe")
	case "linux":
		return filepath.Join(b.Bases, "unix", "out", "ib.run")
	default:
		return filepath.Join(b.Bases, "unix", "out", "Install.zip")
	}
}

var extFor = map[string]string{"windows": ".exe", "linux": ".run", "macos": ".zip"}

func (b *Builder) output(ctx context.Context, r *Request, plat, stem, hash string, record []byte, progress func(string)) (*ResultFile, error) {
	name := stem + extFor[plat]
	out := filepath.Join(b.Data, "dl", name)
	signedBy := ""
	signed := r.Mode == "A" && plat == "windows"
	basePath := b.basePath(plat, signed)
	if signed && !fileExists(basePath) {
		basePath, signed = b.basePath(plat, false), false
	}
	base, err := os.ReadFile(basePath)
	if err != nil {
		return nil, fmt.Errorf("base installer missing: %w", err)
	}
	var buf bytes.Buffer
	switch {
	case plat == "macos":
		extra := map[string][]byte{}
		if r.Mode != "A" {
			extra["record.txt"] = record
			if r.Offline {
				plan, files, err := b.Plan(hash, []string{plat})
				if err != nil {
					return nil, err
				}
				extra["plan.txt"] = []byte(plan)
				if err := b.addPackFiles(ctx, files, extra, progress); err != nil {
					return nil, err
				}
			}
		}
		if err := ibfile.MacZip(base, stem+".app", extra, &buf); err != nil {
			return nil, err
		}
		if r.Mode == "A" {
			signedBy = "ad-hoc (test)"
		}
	case r.Mode == "A":
		buf.Write(base)
		if signed {
			signedBy = "Installer Builder TEST"
		}
	default:
		var plan []byte
		var pack io.Reader
		var packLen int64
		if r.Offline {
			p, files, err := b.Plan(hash, []string{plat})
			if err != nil {
				return nil, err
			}
			plan = []byte(p)
			pf, err := b.packFiles(ctx, files, progress)
			if err != nil {
				return nil, err
			}
			pr, pw := io.Pipe()
			go func() { pw.CloseWithError(ibfile.WritePack(pf, pw)) }()
			pack, packLen = pr, ibfile.PackSize(pf)
		}
		// Built straight to disk: offline packs can be large.
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return nil, err
		}
		f, err := os.Create(out + ".tmp")
		if err != nil {
			return nil, err
		}
		err = ibfile.Append(base, record, plan, pack, packLen, f)
		f.Close()
		if err != nil {
			return nil, err
		}
		if err := os.Rename(out+".tmp", out); err != nil {
			return nil, err
		}
		return b.describe(plat, name, out, signedBy, r.Offline)
	}
	if err := ibfile.WriteAtomic(out, buf.Bytes()); err != nil {
		return nil, err
	}
	return b.describe(plat, name, out, signedBy, r.Offline)
}

func (b *Builder) describe(plat, name, path, signed string, offline bool) (*ResultFile, error) {
	sha, size, err := ibfile.SHA256File(path)
	if err != nil {
		return nil, err
	}
	return &ResultFile{Platform: plat, Name: name, URL: "/dl/" + name, Size: size, SHA256: sha, Signed: signed, Offline: offline}, nil
}

// packFiles finds a local copy of every file a plan needs, downloading and
// checking any we don't have.
func (b *Builder) packFiles(ctx context.Context, files []catalog.FileRef, progress func(string)) ([]ibfile.PackFile, error) {
	var out []ibfile.PackFile
	for _, f := range files {
		p := f.Local
		if p == "" {
			p = filepath.Join(b.Data, "cache", f.SHA256)
			if !fileExists(p) {
				progress("Downloading " + f.Name)
				if err := b.download(ctx, f, p); err != nil {
					return nil, err
				}
			}
		}
		out = append(out, ibfile.PackFile{SHA256: f.SHA256, Path: p, Size: f.Size})
	}
	return ibfile.DedupPack(out), nil
}

func (b *Builder) addPackFiles(ctx context.Context, files []catalog.FileRef, extra map[string][]byte, progress func(string)) error {
	pf, err := b.packFiles(ctx, files, progress)
	if err != nil {
		return err
	}
	for _, f := range pf {
		data, err := os.ReadFile(f.Path)
		if err != nil {
			return err
		}
		extra["pack/"+f.SHA256] = data
	}
	return nil
}

func (b *Builder) download(ctx context.Context, f catalog.FileRef, dst string) error {
	var last error
	for _, u := range f.URLs {
		req, _ := http.NewRequestWithContext(ctx, "GET", u, nil)
		resp, err := b.HTTP.Do(req)
		if err != nil {
			last = err
			continue
		}
		if resp.StatusCode != 200 {
			resp.Body.Close()
			last = fmt.Errorf("%s: %s", u, resp.Status)
			continue
		}
		os.MkdirAll(filepath.Dir(dst), 0o755)
		tmp, _ := os.Create(dst + ".tmp")
		h := sha256.New()
		_, err = io.Copy(io.MultiWriter(tmp, h), resp.Body)
		resp.Body.Close()
		tmp.Close()
		if err == nil && hex.EncodeToString(h.Sum(nil)) == f.SHA256 {
			return os.Rename(dst+".tmp", dst)
		}
		os.Remove(dst + ".tmp")
		last = fmt.Errorf("%s: checksum mismatch or read error", u)
	}
	return fmt.Errorf("couldn't download %s: %v", f.Name, last)
}

// Helpers ----------------------------------------------------------------

func sha256hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func contains(l []string, s string) bool {
	for _, x := range l {
		if x == s {
			return true
		}
	}
	return false
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func b01(v bool) string {
	if v {
		return "1"
	}
	return "0"
}
