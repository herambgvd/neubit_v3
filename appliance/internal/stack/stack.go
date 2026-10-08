// Package stack is the native appliance's equivalent of deploy/docker-compose.yml:
// every process, its command, environment, dependencies and health check.
//
// Environment values follow the compose file service by service. Where native
// differs from Docker it says so here, and only through configuration the
// services already read (docs/WINDOWS_NATIVE_APPLIANCE.md §2):
//
//   - no Redis: VE_REDIS_URL is empty and core's limiter is per-process;
//   - no Celery: the workflow API runs its sweeps (VE_WORKFLOW_SCHEDULER=inline);
//   - migrations are their own one-shot processes, run before their service
//     (python -m kernel.migrate replaces the bash entrypoints);
//   - every address is 127.0.0.1 and the trusted proxy is loopback.
package stack

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/neubit/vms-appliance/internal/layout"
	"github.com/neubit/vms-appliance/internal/secrets"
	"github.com/neubit/vms-appliance/internal/supervise"
)

// Input is everything the process table is computed from.
type Input struct {
	L        layout.Layout
	Cfg      layout.Config
	Ports    layout.Ports
	Secrets  map[string]string
	SelfExe  string // neubitvms-svc.exe, for the processes it serves itself
	Gateway  string // rendered traefik.yml
	NATSConf string // rendered nats.conf
	Hostname string // what LAN clients call this machine
}

// ControlDB is core's database (POSTGRES_DB in the compose file).
const ControlDB = "neubit_control"

const (
	// loopback is where every internal listener binds: nothing but the
	// gateway is reachable from the LAN.
	loopback      = "127.0.0.1"
	kernelMigrate = "kernel.migrate"
	readingWriter = "reading-writer"
	// stmtTimeout bounds a query the way compose does for the request paths.
	stmtTimeout = "VE_DB_STATEMENT_TIMEOUT_MS=30000"
)

func (in Input) dbEnv(db string) string { return "VE_DATABASE_URL=" + in.dbURL(db) }

func (in Input) natsEnv(user, passKey string) string {
	return "VE_NATS_URL=" + in.natsURL(user, passKey)
}

func (in Input) dbURL(db string) string {
	u := url.URL{
		Scheme: "postgresql+asyncpg",
		User:   url.UserPassword(in.Secrets["POSTGRES_USER"], in.Secrets["POSTGRES_PASSWORD"]),
		Host:   fmt.Sprintf("%s:%d", loopback, in.Ports.Postgres),
		Path:   "/" + db,
	}
	return u.String()
}

func (in Input) natsURL(user, passKey string) string {
	u := url.URL{
		Scheme: "nats",
		User:   url.UserPassword(user, in.Secrets[passKey]),
		Host:   fmt.Sprintf("%s:%d", loopback, in.Ports.NATS),
	}
	return u.String()
}

func loop(port int) string { return fmt.Sprintf("http://127.0.0.1:%d", port) }

// publicBase is how a browser on the LAN reaches the console.
func (in Input) publicBase() string {
	h := in.Cfg.AdvertiseHost
	if h == "" {
		h = in.Hostname
	}
	if h == "" {
		h = "localhost"
	}
	if in.Ports.UI == 80 {
		return "http://" + h
	}
	return fmt.Sprintf("http://%s:%d", h, in.Ports.UI)
}

// pathEnv puts the runtimes the services shell out to first: ffmpeg (vision
// snapshots), poppler's pdftoppm (core floor plans), the Postgres client tools.
func (in Input) pathEnv() string {
	sys := os.Getenv("SystemRoot")
	parts := []string{
		filepath.Dir(in.L.Python()),
		filepath.Join(filepath.Dir(in.L.Python()), "Scripts"),
		in.L.FFmpegBin(), in.L.PopplerBin(), in.L.PGBin(),
	}
	if sys != "" {
		parts = append(parts, filepath.Join(sys, "System32"), sys)
	}
	return "PATH=" + strings.Join(parts, string(os.PathListSeparator))
}

// common is the shared .env of the compose file, natively.
func (in Input) common() []string {
	s := in.Secrets
	env := []string{
		in.pathEnv(),
		"PYTHONUNBUFFERED=1",
		"PYTHONDONTWRITEBYTECODE=1",
		"PYTHONUTF8=1", // Windows would default stdio and open() to the ANSI code page
		"VE_ENV=" + in.Cfg.RuntimeEnv,
		"VE_JWT_SECRET=" + s["VE_JWT_SECRET"],
		"VE_SECRETS_KEY=" + s["VE_SECRETS_KEY"],
		"VE_REDIS_URL=",
		"VE_RATE_LIMIT_BACKEND=memory",
		`VE_TRUSTED_PROXY_CIDRS=["127.0.0.1/32"]`,
		fmt.Sprintf(`VE_CORS_ORIGINS=[%q]`, in.publicBase()),
		"VE_STORAGE_BACKEND=local",
		"VE_STORAGE_LOCAL_DIR=" + in.L.Storage(),
		"VE_CORE_URL=" + loop(in.Ports.Core),
		"VE_LOG_FORMAT=text",
	}
	for _, k := range []string{"VE_BOOTSTRAP_ADMIN_EMAIL", "VE_BOOTSTRAP_ADMIN_PASSWORD", "VE_LICENSE_TOKEN"} {
		if v := s[k]; v != "" {
			env = append(env, k+"="+v)
		}
	}
	return env
}

func (in Input) python(name, dir string, args []string, extra ...string) supervise.Proc {
	return supervise.Proc{
		Name:    name,
		Exe:     in.L.Python(),
		Args:    args,
		Dir:     dir,
		Env:     append(in.common(), extra...),
		LogFile: filepath.Join(in.L.LogDir(), name+".log"),
	}
}

func uvicorn(port int) []string {
	// Never --workers or --reload on Windows: both switch asyncio to the selector
	// loop, which cannot run subprocesses (vision's ffmpeg snapshots).
	return []string{"-m", "uvicorn", "app.main:app", "--host", loopback,
		"--port", fmt.Sprint(port), "--timeout-graceful-shutdown", "10", "--no-access-log"}
}

// Procs is the process table, in display order.
func Procs(in Input) []supervise.Proc {
	l, p := in.L, in.Ports
	svc := l.ServiceDir

	var procs []supervise.Proc
	add := func(pr supervise.Proc) { procs = append(procs, pr) }

	// ── foundations ──
	add(supervise.Proc{
		Name: "postgres", Exe: l.Postgres(), Args: []string{"-D", l.PGData()},
		Env:      []string{in.pathEnv()},
		Health:   pgReady(l, p.Postgres, in.Secrets["POSTGRES_USER"]),
		Critical: true, LogFile: filepath.Join(l.LogDir(), "postgres.log"),
	})
	natsEnv := []string{}
	for _, u := range secrets.NATSUsers {
		natsEnv = append(natsEnv, "NATS_PASS_"+u+"="+in.Secrets["NATS_PASS_"+u])
	}
	add(supervise.Proc{
		Name: "nats", Exe: l.NATSServer(), Args: []string{"-c", in.NATSConf},
		Env:      natsEnv,
		Health:   httpOK(loop(p.NATSMonitor) + "/healthz"),
		Critical: true, LogFile: filepath.Join(l.LogDir(), "nats.log"),
	})

	// ── migrations (one-shot, before their service) ──
	mig := func(name, service, db string, args ...string) {
		pr := in.python(name, svc(service), args, in.dbEnv(db))
		pr.OneShot = true
		pr.DependsOn = []string{"postgres"}
		add(pr)
	}
	mig("migrate-core", "core", ControlDB, "-m", kernelMigrate, "0001", "--widen-version-table")
	mig("migrate-ingest", "ingest", "neubit_ingest", "-m", "alembic", "upgrade", "head")
	mig("migrate-workflow", "workflow", "neubit_workflow", "-m", "alembic", "upgrade", "head")
	mig("migrate-access", "access", "neubit_access", "-m", kernelMigrate, "0001_access_baseline")
	mig("migrate-vision", "vision", "neubit_vision", "-m", kernelMigrate, "0001_vision_baseline")
	// reporting-migrate's three steps, each its own one-shot so a failure names
	// the step (ensure_db → alembic → apply the reconciled policies).
	reportingEnv := append([]string{in.dbEnv("neubit_reporting")}, readingsPolicyEnv()...)
	rdb := in.python("reporting-db", svc("reporting"), []string{"-m", "reporting.ensure_db"}, reportingEnv...)
	rdb.OneShot, rdb.DependsOn = true, []string{"postgres"}
	add(rdb)
	rmig := in.python("reporting-migrate", svc("reporting"), []string{"-m", "alembic", "upgrade", "head"}, reportingEnv...)
	rmig.OneShot, rmig.DependsOn = true, []string{"reporting-db"}
	add(rmig)
	rapply := in.python("reporting-apply", svc("reporting"), []string{"-m", "reporting.apply"}, reportingEnv...)
	rapply.OneShot, rapply.DependsOn = true, []string{"reporting-migrate"}
	add(rapply)

	// ── services ──
	api := func(name, service string, port int, deps []string, critical bool, extra ...string) {
		pr := in.python(name, svc(service), uvicorn(port), extra...)
		pr.DependsOn = deps
		pr.Health = httpOK(loop(port) + "/health")
		pr.Critical = critical
		add(pr)
	}
	api("core", "core", p.Core, []string{"migrate-core", "nats"}, true,
		in.dbEnv(ControlDB),
		in.natsEnv("core", "NATS_PASS_CORE"),
		"OPS_AGENT_URL="+loop(p.Control),
		"OPS_AGENT_TOKEN="+in.Secrets["OPS_AGENT_TOKEN"],
		// First-run setup only from this computer: the console answers on the
		// LAN before anyone owns it. Relies on VE_TRUSTED_PROXY_CIDRS above.
		"VE_SETUP_LOCAL_ONLY=true",
		stmtTimeout,
		"VE_READING_WRITER_URL="+loop(p.ReadingWriter),
	)
	api("ingest", "ingest", p.Ingest, []string{"migrate-ingest", "nats"}, false,
		in.dbEnv("neubit_ingest"),
		in.natsEnv("ingest", "NATS_PASS_INGEST"),
		"VE_DB_STATEMENT_TIMEOUT_MS=15000",
		"VE_INGEST_PUBLIC_BASE_URL="+in.publicBase(),
	)
	api("workflow", "workflow", p.Workflow, []string{"migrate-workflow", "nats"}, false,
		in.dbEnv("neubit_workflow"),
		in.natsEnv("workflow", "NATS_PASS_WORKFLOW"),
		"VE_DB_STATEMENT_TIMEOUT_MS=15000",
		"VE_WORKFLOW_INLINE_CORRELATION=1",
		"VE_WORKFLOW_SCHEDULER=inline",
	)
	api("access", "access", p.Access, []string{"migrate-access", "nats"}, false,
		in.dbEnv("neubit_access"),
		in.natsEnv("access", "NATS_PASS_ACCESS"),
		stmtTimeout,
		"VE_ACCESS_RECONCILE_SCHEDULER=1",
	)
	recordings := in.Cfg.RecordingsDir
	if recordings == "" {
		recordings = filepath.Join(l.Root, "recordings")
	}
	nvr := in.Cfg.NVRURL
	if nvr == "" {
		nvr = "http://127.0.0.1:8000"
	}
	nvrHost := loopback
	if u, err := url.Parse(nvr); err == nil && u.Hostname() != "" {
		nvrHost = u.Hostname()
	}
	api("vision", "vision", p.Vision, []string{"migrate-vision", "nats"}, true,
		in.dbEnv("neubit_vision"),
		in.natsEnv("vision", "NATS_PASS_VISION"),
		stmtTimeout,
		"VE_NVR_URL="+nvr,
		"VE_MEDIAMTX_RTSP_BASE=rtsp://"+nvrHost+":8554",
		"VE_FEDERATION_LABEL=Neubit VMS",
		"VE_MEDIA_TOKEN_TTL_SEC=300",
		"VE_RECORDINGS_DIR="+recordings,
		"VE_DOWNLOADS_DIR="+l.Downloads(),
		"VE_ENFORCE_H264_WEB=true",
	)
	api(readingWriter, readingWriter, p.ReadingWriter, []string{"reporting-apply", "nats"}, false,
		append([]string{
			in.dbEnv("neubit_reporting"),
			in.natsEnv(readingWriter, "NATS_PASS_READING_WRITER"),
			"VE_DB_STATEMENT_TIMEOUT_MS=60000",
		}, readingsPolicyEnv()...)...,
	)

	// ── web ──
	web := func(name, app string, port int, critical bool) {
		add(supervise.Proc{
			Name: name, Exe: l.Node(), Args: []string{l.WebServer(app)},
			Dir: filepath.Dir(l.WebServer(app)),
			Env: []string{
				"PORT=" + fmt.Sprint(port), "HOSTNAME=127.0.0.1",
				"NODE_ENV=production", "NEXT_TELEMETRY_DISABLED=1",
			},
			Health:   httpBelow500(loop(port) + "/"),
			Critical: critical, LogFile: filepath.Join(l.LogDir(), name+".log"),
		})
	}
	web("frontend", "frontend", p.Frontend, true)
	web("admin", "admin", p.Admin, false)

	// ── map data (served by this binary; geocoder only once its index exists) ──
	add(supervise.Proc{
		Name: "tiles", Exe: in.SelfExe,
		Args:    []string{"serve-tiles", "--dir", l.TilesDir(), "--port", fmt.Sprint(p.Tiles)},
		Health:  httpOK(loop(p.Tiles) + "/tiles-health"),
		LogFile: filepath.Join(l.LogDir(), "tiles.log"),
	})
	add(supervise.Proc{
		Name: "geocoder", Exe: l.Java(),
		Args: []string{"-Xmx1g", "-jar", l.PhotonJar(), "-data-dir", l.GeocoderDir(),
			"-listen-ip", loopback, "-listen-port", fmt.Sprint(p.Geocoder)},
		Dir:     l.GeocoderDir(),
		Gate:    geocoderReady(l),
		Health:  httpBelow500(loop(p.Geocoder) + "/api?q=a&limit=1"),
		LogFile: filepath.Join(l.LogDir(), "geocoder.log"),
	})

	// ── the one LAN-facing process ──
	add(supervise.Proc{
		Name: "gateway", Exe: l.Traefik(), Args: []string{"--configFile=" + in.Gateway},
		DependsOn: []string{"core", "frontend"},
		Health:    httpOK(fmt.Sprintf("http://127.0.0.1:%d/ping", p.UI)),
		Critical:  true, LogFile: filepath.Join(l.LogDir(), "gateway.log"),
	})
	return procs
}

// readingsPolicyEnv is the compose file's reporting retention/compression policy.
func readingsPolicyEnv() []string {
	return []string{
		"VE_READINGS_CHUNK_INTERVAL=1 day",
		"VE_READINGS_COMPRESS_AFTER=7 days",
		"VE_READINGS_1M_COMPRESS_AFTER=30 days",
		"VE_READINGS_1H_COMPRESS_AFTER=365 days",
		"VE_READINGS_RETENTION=90 days",
		"VE_READINGS_1M_RETENTION=400 days",
		"VE_READINGS_1H_RETENTION=1825 days",
	}
}

func geocoderReady(l layout.Layout) func() error {
	return func() error {
		if _, err := os.Stat(l.Java()); err != nil {
			return errors.New("no Java runtime installed (the geocoder is optional)")
		}
		if _, err := os.Stat(l.PhotonJar()); err != nil {
			return errors.New("photon.jar is not installed (the geocoder is optional)")
		}
		if _, err := os.Stat(filepath.Join(l.GeocoderDir(), "photon_data")); err != nil {
			return errors.New("no place-search index yet (downloads in the background, or copy photon_data in)")
		}
		return nil
	}
}

var client = &http.Client{Timeout: 3 * time.Second}

func probe(ctx context.Context, u string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return 0, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

func httpOK(u string) func(context.Context) error {
	return func(ctx context.Context) error {
		code, err := probe(ctx, u)
		if err != nil {
			return err
		}
		if code != http.StatusOK {
			return fmt.Errorf("%s answered %d", u, code)
		}
		return nil
	}
}

// httpBelow500 treats any non-5xx answer as up: Next answers the root with a
// redirect, and a 503 while it is still compiling means not yet.
func httpBelow500(u string) func(context.Context) error {
	return func(ctx context.Context) error {
		code, err := probe(ctx, u)
		if err != nil {
			return err
		}
		if code >= 500 {
			return fmt.Errorf("%s answered %d", u, code)
		}
		return nil
	}
}

// pgReady runs pg_isready: the server is accepting connections, which is what
// compose's healthcheck asked too.
func pgReady(l layout.Layout, port int, user string) func(context.Context) error {
	isready := filepath.Join(l.PGBin(), "pg_isready.exe")
	return func(ctx context.Context) error {
		cmd := exec.CommandContext(ctx, isready, "-h", loopback, "-p", fmt.Sprint(port), "-U", user, "-d", "postgres")
		if out, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("pg_isready: %s", strings.TrimSpace(string(out)))
		}
		return nil
	}
}
