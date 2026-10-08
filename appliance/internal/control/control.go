// Package control is the supervisor's loopback HTTP API.
//
// Two audiences:
//
//   - the desktop shell and the installer: GET /v1/status, unauthenticated
//     (loopback only, and it reveals nothing a local user could not see in the
//     service manager) — process states, the console URLs, ready or not;
//   - core: the ops-agent's API, same paths and JSON, behind the same
//     X-Ops-Token, so the console's Infrastructure and System pages work
//     unchanged on the native appliance. Containers are processes.
//
// It listens on 127.0.0.1 only and writes its address to control.json, which
// the shell reads (falling back to the default port).
package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/neubit/vms-appliance/internal/acl"
	"github.com/neubit/vms-appliance/internal/layout"
	"github.com/neubit/vms-appliance/internal/supervise"
	"github.com/neubit/vms-appliance/internal/sysstat"
)

// Supervisor is what the API needs from supervise.Supervisor.
type Supervisor interface {
	Status() []supervise.Status
	Restart(string) error
	Stop(string) error
	Start(string) error
}

// Options configures the server.
type Options struct {
	Sup        Supervisor
	L          layout.Layout
	Ports      layout.Ports
	Token      string // OPS_AGENT_TOKEN
	PGUser     string
	PGPassword string
	Version    string
	UIURL      string // http://127.0.0.1[:port]
	LANURL     string // http://<host>[:port]
	Started    time.Time
	// MaxDumpBytes caps an import (the ops-agent's default: 512 MiB).
	MaxDumpBytes int64
}

// Server serves the API.
type Server struct {
	o       Options
	sampler *sysstat.Sampler
	mux     *http.ServeMux
}

func New(o Options) *Server {
	if o.MaxDumpBytes <= 0 {
		o.MaxDumpBytes = 512 << 20
	}
	s := &Server{o: o, sampler: sysstat.NewSampler(), mux: http.NewServeMux()}
	s.routes()
	return s
}

func (s *Server) Handler() http.Handler { return s.mux }

// File is control.json: where the shell finds this API.
type File struct {
	Addr    string `json:"addr"`
	PID     int    `json:"pid"`
	Version string `json:"version"`
	UIURL   string `json:"ui_url"`
}

// Listen binds 127.0.0.1:port and records the address in control.json.
func (s *Server) Listen(ctx context.Context) error {
	addr := fmt.Sprintf("127.0.0.1:%d", s.o.Ports.Control)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("control API on %s: %w", addr, err)
	}
	b, _ := json.MarshalIndent(File{Addr: ln.Addr().String(), PID: os.Getpid(), Version: s.o.Version, UIURL: s.o.UIURL}, "", "  ")
	if err := layout.WriteFileAtomic(s.o.L.ControlFile(), append(b, '\n'), 0o644); err == nil {
		// Readable by signed-in users, so the desktop app finds this API without
		// elevation. Best effort: the app falls back to the default port.
		_ = acl.ReadOnlyForUsers(s.o.L.ControlFile())
	}
	srv := &http.Server{Handler: s.mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	err = srv.Serve(ln)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (s *Server) routes() {
	m := s.mux
	m.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "service": "neubitvms-svc"})
	})
	m.HandleFunc("GET /readyz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, 200, map[string]any{"status": "ok", "checks": map[string]string{"supervisor": "ok"}})
	})
	m.HandleFunc("GET /v1/status", s.status)
	m.HandleFunc("GET /v1/logs/{name}", s.auth(s.logs))

	// ops-agent compatible
	m.HandleFunc("GET /containers", s.auth(s.containers))
	m.HandleFunc("GET /containers/{name}/logs", s.auth(s.logs))
	m.HandleFunc("POST /containers/{name}/{verb}", s.auth(s.lifecycle))
	m.HandleFunc("POST /services/{name}/scale", s.auth(func(w http.ResponseWriter, _ *http.Request) {
		writeErr(w, http.StatusNotImplemented, "scaling is not implemented: there are no stateless replicas to add")
	}))
	m.HandleFunc("GET /host", s.auth(s.host))
	m.HandleFunc("GET /db/export", s.auth(s.dbExport))
	m.HandleFunc("POST /db/import", s.auth(s.dbImport))
}

func (s *Server) auth(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("X-Ops-Token")
		if s.o.Token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.o.Token)) != 1 {
			writeErr(w, http.StatusUnauthorized, "X-Ops-Token was absent or wrong")
			return
		}
		h(w, r)
	}
}

// ── /v1/status ───────────────────────────────────────────────────────────────

// Status is the shell's view.
type Status struct {
	Version   string             `json:"version"`
	PID       int                `json:"pid"`
	Started   time.Time          `json:"started"`
	DataRoot  string             `json:"data_root"`
	LogDir    string             `json:"log_dir"`
	UIURL     string             `json:"ui_url"`
	LANURL    string             `json:"lan_url"`
	Ready     bool               `json:"ready"`
	Healthy   int                `json:"healthy"`
	Total     int                `json:"total"`
	Processes []supervise.Status `json:"processes"`
}

// Ready: every critical long-running process is healthy. One-shots and
// optional processes (the geocoder waiting for its index) do not hold it back.
func Ready(sts []supervise.Status) (ready bool, healthy, total int) {
	ready = true
	for _, st := range sts {
		if st.OneShot {
			continue
		}
		total++
		if st.State == supervise.StateHealthy {
			healthy++
		} else if st.Critical {
			ready = false
		}
	}
	return ready, healthy, total
}

func (s *Server) status(w http.ResponseWriter, _ *http.Request) {
	sts := s.o.Sup.Status()
	ready, healthy, total := Ready(sts)
	writeJSON(w, 200, Status{
		Version: s.o.Version, PID: os.Getpid(), Started: s.o.Started,
		DataRoot: s.o.L.Root, LogDir: s.o.L.LogDir(), UIURL: s.o.UIURL, LANURL: s.o.LANURL,
		Ready: ready, Healthy: healthy, Total: total, Processes: sts,
	})
}

// ── containers ───────────────────────────────────────────────────────────────

// Container is the ops-agent's container JSON.
type Container struct {
	Name       string   `json:"name"`
	ID         string   `json:"id"`
	Image      string   `json:"image"`
	State      string   `json:"state"`
	Status     string   `json:"status"`
	Health     *string  `json:"health"`
	ExitCode   *int     `json:"exit_code"`
	CreatedAt  *string  `json:"created_at"`
	Service    string   `json:"service"`
	CPUPct     *float64 `json:"cpu_pct"`
	MemUsedMB  *float64 `json:"mem_used_mb"`
	MemLimitMB *float64 `json:"mem_limit_mb"`
}

// ContainerOf maps a process status onto docker's vocabulary. A completed
// one-shot is "exited" with exit_code 0 — exactly what db-init looked like, so
// the watchdog's "an exit 0 one-shot is not a fault" rule still holds.
func ContainerOf(st supervise.Status, ps sysstat.Proc, version string) Container {
	str := func(s string) *string { return &s }
	c := Container{
		Name: st.Name, Service: st.Name, Image: "neubit-vms-native:" + version,
		ExitCode: st.ExitCode, CPUPct: ps.CPUPct, MemUsedMB: ps.MemMB,
	}
	if st.PID > 0 {
		c.ID = strconv.Itoa(st.PID)
	}
	if !st.Started.IsZero() {
		c.CreatedAt = str(st.Started.UTC().Format(time.RFC3339Nano))
	}
	switch st.State {
	case supervise.StateHealthy:
		c.State, c.Health = "running", str("healthy")
		c.ExitCode = nil
	case supervise.StateStarting:
		c.State, c.Health = "running", str("starting")
		c.ExitCode = nil
		if st.OneShot {
			c.Health = nil
		}
	case supervise.StateRestarting:
		c.State, c.Health = "restarting", str("unhealthy")
	case supervise.StateCompleted:
		c.State = "exited"
		if c.ExitCode == nil {
			z := 0
			c.ExitCode = &z
		}
	case supervise.StateStopped:
		c.State = "exited"
	case supervise.StateFailed:
		c.State, c.Health = "dead", str("unhealthy")
	default: // pending, waiting
		c.State = "created"
	}
	c.Status = c.State
	return c
}

func (s *Server) containers(w http.ResponseWriter, _ *http.Request) {
	sts := s.o.Sup.Status()
	pids := make([]int, 0, len(sts))
	for _, st := range sts {
		pids = append(pids, st.PID)
	}
	stats := s.sampler.Procs(pids)
	out := make([]Container, 0, len(sts))
	for _, st := range sts {
		var ps sysstat.Proc
		if st.Running() {
			ps = stats[st.PID]
		}
		out = append(out, ContainerOf(st, ps, s.o.Version))
	}
	writeJSON(w, 200, out)
}

func (s *Server) known(name string) bool {
	_, ok := s.lookup(name)
	return ok
}

func (s *Server) lookup(name string) (supervise.Status, bool) {
	for _, st := range s.o.Sup.Status() {
		if st.Name == name {
			return st, true
		}
	}
	return supervise.Status{}, false
}

func (s *Server) logs(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	st, ok := s.lookup(name)
	if !ok {
		writeErr(w, 404, fmt.Sprintf("no process %q", name))
		return
	}
	tail := 200
	if v, err := strconv.Atoi(r.URL.Query().Get("tail")); err == nil {
		tail = v
	}
	tail = max(1, min(tail, 5000))
	var since time.Time
	if v, err := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64); err == nil && v > 0 {
		since = time.Unix(v, 0)
	}
	lines, err := supervise.Tail(filepath.Join(s.o.L.LogDir(), name+".log"), tail, since)
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	if lines == nil {
		lines = []string{}
	}
	// A process held back by its gate (the geocoder without Java or data) has
	// never run, so it has no log, and "printed nothing" hides the one fact the
	// operator needs. Say why, once: on the first read, not on every poll.
	if len(lines) == 0 && since.IsZero() && st.State == supervise.StateWaiting && st.LastError != "" {
		lines = []string{time.Now().UTC().Format(supervise.TimeLayout) + " [neubitvms-svc] not started: " + st.LastError}
	}
	writeJSON(w, 200, map[string]any{"lines": lines})
}

func (s *Server) lifecycle(w http.ResponseWriter, r *http.Request) {
	name, verb := r.PathValue("name"), r.PathValue("verb")
	var fn func(string) error
	switch verb {
	case "restart":
		fn = s.o.Sup.Restart
	case "stop":
		fn = s.o.Sup.Stop
	case "start":
		fn = s.o.Sup.Start
	default:
		writeErr(w, 404, "unknown action")
		return
	}
	if err := fn(name); err != nil {
		if errors.Is(err, supervise.ErrUnknown) {
			writeErr(w, 404, fmt.Sprintf("no process %q", name))
			return
		}
		writeErr(w, 409, err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "detail": nil})
}

func (s *Server) host(w http.ResponseWriter, _ *http.Request) {
	sts := s.o.Sup.Status()
	running := 0
	for _, st := range sts {
		if st.Running() {
			running++
		}
	}
	h := s.sampler.Host(s.o.L.Root)
	out := map[string]any{"containers_running": running, "containers_total": len(sts), "cpu_count": h.CPUCount}
	put := func(k string, v *float64) {
		if v != nil {
			out[k] = *v
		}
	}
	put("cpu_pct", h.CPUPct)
	put("mem_used_mb", h.MemUsedMB)
	put("mem_total_mb", h.MemTotalMB)
	put("disk_used_gb", h.DiskUsedGB)
	put("disk_total_gb", h.DiskTotalGB)
	writeJSON(w, 200, out)
}

// ── database ─────────────────────────────────────────────────────────────────

func (s *Server) pgArgs(extra ...string) []string {
	return append([]string{"-h", "127.0.0.1", "-p", strconv.Itoa(s.o.Ports.Postgres), "-U", s.o.PGUser, "-d", "neubit_control"}, extra...)
}

func (s *Server) pgEnv() []string {
	return append(os.Environ(), "PGPASSWORD="+s.o.PGPassword, "PGCONNECT_TIMEOUT=10")
}

func (s *Server) dbExport(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 170*time.Second)
	defer cancel()
	// Buffered to a private temp file first, so a pg_dump failure is a clean 502
	// instead of a truncated download that looks like a backup.
	tmp, err := os.CreateTemp(s.o.L.RunDir(), "export-*.sql")
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	cmd := exec.CommandContext(ctx, s.o.L.PGDump(), s.pgArgs("--clean", "--if-exists", "--no-owner", "--no-privileges")...)
	cmd.Env = s.pgEnv()
	cmd.Stdout = tmp
	var stderr strings.Builder
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		writeErr(w, 502, "pg_dump failed: "+trim(stderr.String(), 500))
		return
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/sql")
	_, _ = io.Copy(w, tmp)
}

func (s *Server) dbImport(w http.ResponseWriter, r *http.Request) {
	if r.ContentLength > s.o.MaxDumpBytes {
		writeErr(w, 413, "SQL dump too large")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, s.o.MaxDumpBytes+1))
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	if int64(len(body)) > s.o.MaxDumpBytes {
		writeErr(w, 413, "SQL dump too large")
		return
	}
	if len(body) == 0 {
		writeErr(w, 400, "empty SQL body")
		return
	}
	sql, err := SanitizeDump(body)
	if err != nil {
		writeErr(w, 400, err.Error())
		return
	}
	f, err := os.CreateTemp(s.o.L.RunDir(), "restore-*.sql")
	if err != nil {
		writeErr(w, 502, err.Error())
		return
	}
	path := f.Name()
	defer os.Remove(path) // always: it holds the whole dump
	_, werr := f.Write(sql)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		writeErr(w, 502, "could not stage the dump")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 190*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.o.L.PSQL(), s.pgArgs("-X", "--single-transaction", "-v", "ON_ERROR_STOP=1", "-f", path)...)
	cmd.Env = s.pgEnv()
	out, err := cmd.CombinedOutput()
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
	} else if err != nil {
		writeErr(w, 502, "psql: "+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{"ok": code == 0, "exit_code": code, "output": trimTail(string(out), 2000)})
}

// ── helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr uses FastAPI's {"detail": ...} — what core's client parses.
func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"detail": msg})
}

func trim(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		return s[:n]
	}
	return s
}

func trimTail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}
