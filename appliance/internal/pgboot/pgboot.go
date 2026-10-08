// Package pgboot bootstraps the appliance's own PostgreSQL + TimescaleDB cluster
// — what the `postgres` and `db-init` containers do for the Docker stack. It
// never RUNS the postmaster (the supervisor does); it makes the data directory
// right before the postmaster starts:
//
//   - initdb once, with the superuser password from a short-lived private file
//     (never argv or env), scram-sha-256 from the first second;
//   - a generated overlay (neubit.conf, included last) re-asserting every boot:
//     loopback only, the port, TimescaleDB preloaded, logs to stderr, UTC;
//   - pg_hba.conf regenerated every boot: scram-sha-256, loopback only;
//   - the service databases, created offline through `postgres --single` (no
//     socket open, nothing left running) from the SAME list the Docker stack's
//     db-init reads (deploy/postgres/init-service-dbs.sh), so a database added
//     there is created here too.
//
// When the directory is in a state it does not recognise, it refuses rather
// than initdb over someone's data. Modelled on the NVR's pgboot.
package pgboot

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Options describes the cluster.
type Options struct {
	BinDir   string // vendored PostgreSQL bin (initdb.exe, postgres.exe)
	DataDir  string // PGDATA
	Port     int
	User     string
	Password string
	// ControlDB is core's database (POSTGRES_DB in the Docker stack).
	ControlDB string
	// Databases are the per-service databases (init-service-dbs.sh's list).
	Databases []string
	// MaxConnections and SharedBuffers mirror the compose `postgres` command.
	MaxConnections int
	SharedBuffers  string
}

// WantMajor is the PostgreSQL major the payload ships (with TimescaleDB 2.17.2
// built for it). A cluster of another major is refused, never "upgraded".
const WantMajor = 17

var (
	ErrBinariesMissing = errors.New("postgres binaries not found")
	ErrAmbiguousData   = errors.New("postgres data directory is in a state pgboot will not touch")
	ErrVersionMismatch = errors.New("postgres data directory is a different major version")
	ErrInvalid         = errors.New("invalid postgres options")
)

func exe(name string) string {
	if filepath.Separator == '\\' {
		return name + ".exe"
	}
	return name
}

// runner is the process seam for tests.
var runCmd = func(ctx context.Context, name string, args []string, stdin string, env []string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (o Options) validate() error {
	if o.Port <= 0 || o.User == "" || o.Password == "" || o.ControlDB == "" {
		return fmt.Errorf("%w: port, user, password and control database are required", ErrInvalid)
	}
	if strings.ContainsAny(o.Password, "\r\n'") {
		return fmt.Errorf("%w: the password may not contain a quote or newline", ErrInvalid)
	}
	for _, id := range append([]string{o.User, o.ControlDB}, o.Databases...) {
		if !identRe.MatchString(id) {
			return fmt.Errorf("%w: %q is not a plain identifier", ErrInvalid, id)
		}
	}
	return nil
}

var identRe = regexp.MustCompile(`^[a-z_][a-z0-9_]{0,62}$`)

// EnsureCluster makes DataDir a ready-to-start cluster. Idempotent; run on
// every service start. Returns true when it ran initdb.
func EnsureCluster(ctx context.Context, o Options) (bool, error) {
	if err := o.validate(); err != nil {
		return false, err
	}
	initdb := filepath.Join(o.BinDir, exe("initdb"))
	postgres := filepath.Join(o.BinDir, exe("postgres"))
	for _, p := range []string{initdb, postgres} {
		if _, err := os.Stat(p); err != nil {
			return false, fmt.Errorf("%w: %s", ErrBinariesMissing, p)
		}
	}

	created := false
	state, major, err := inspect(o.DataDir)
	if err != nil {
		return false, err
	}
	switch state {
	case dirCluster:
		if major != WantMajor {
			return false, fmt.Errorf("%w: %s is PostgreSQL %d, this release ships %d (dump and restore to move it)",
				ErrVersionMismatch, o.DataDir, major, WantMajor)
		}
	case dirEmpty:
		if err := runInitdb(ctx, initdb, o); err != nil {
			return false, err
		}
		created = true
	default:
		return false, fmt.Errorf("%w: %s exists, is not empty and has no PG_VERSION", ErrAmbiguousData, o.DataDir)
	}

	if err := writeConfig(o); err != nil {
		return created, err
	}
	if err := ensureDatabases(ctx, postgres, o); err != nil {
		return created, err
	}
	return created, nil
}

type dirState int

const (
	dirEmpty dirState = iota
	dirCluster
	dirOther
)

func inspect(dir string) (dirState, int, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return dirEmpty, 0, nil
	}
	if err != nil {
		return dirOther, 0, err
	}
	if len(entries) == 0 {
		return dirEmpty, 0, nil
	}
	b, err := os.ReadFile(filepath.Join(dir, "PG_VERSION"))
	if err != nil {
		return dirOther, 0, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		return dirOther, 0, nil
	}
	return dirCluster, n, nil
}

// InitdbArgs is pure so the flags that fix encoding and collation forever are
// pinned by a test. UTF8 explicitly (Windows would inherit WIN1252); the builtin
// C.UTF-8 provider (PG 17+) sorts identically on Windows and Linux; C messages
// keep logs in English for support.
func InitdbArgs(o Options, pwFile string) []string {
	return []string{
		"--pgdata=" + o.DataDir,
		"--username=" + o.User,
		"--pwfile=" + pwFile,
		"--auth-local=scram-sha-256",
		"--auth-host=scram-sha-256",
		"--encoding=UTF8",
		"--locale-provider=builtin",
		"--builtin-locale=C.UTF-8",
		"--lc-messages=C",
		"--lc-monetary=C",
		"--lc-numeric=C",
		"--lc-time=C",
	}
}

func runInitdb(ctx context.Context, initdb string, o Options) error {
	if err := os.MkdirAll(filepath.Dir(o.DataDir), 0o700); err != nil {
		return err
	}
	dir, err := os.MkdirTemp(filepath.Dir(o.DataDir), ".pgboot-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	pw := filepath.Join(dir, "pw")
	if err := os.WriteFile(pw, []byte(o.Password), 0o600); err != nil {
		return err
	}
	ictx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	out, err := runCmd(ictx, initdb, InitdbArgs(o, pw), "", nil)
	if err != nil {
		return fmt.Errorf("initdb %s: %w: %s", o.DataDir, err, scrub(out, o.Password))
	}
	return nil
}

// RenderOverlay is neubit.conf, included at the end of postgresql.conf so it
// wins. Rewritten every boot: hand edits belong in postgresql.conf.
func RenderOverlay(o Options) string {
	maxConn := o.MaxConnections
	if maxConn <= 0 {
		maxConn = 200
	}
	sb := o.SharedBuffers
	if sb == "" {
		sb = "1GB"
	}
	var b strings.Builder
	b.WriteString("# Neubit VMS appliance overlay - GENERATED on every service start; do not edit.\n")
	b.WriteString("# Local tuning goes in postgresql.conf; this file is included after it.\n\n")
	b.WriteString("listen_addresses = '127.0.0.1'   # never reachable from the LAN\n")
	fmt.Fprintf(&b, "port = %d\n", o.Port)
	fmt.Fprintf(&b, "max_connections = %d\n", maxConn)
	fmt.Fprintf(&b, "shared_buffers = %s\n", sb)
	b.WriteString("work_mem = 8MB\n")
	b.WriteString("maintenance_work_mem = 256MB\n")
	b.WriteString("effective_cache_size = 2GB\n")
	b.WriteString("password_encryption = 'scram-sha-256'\n")
	b.WriteString("ssl = off\n\n")
	b.WriteString("# TimescaleDB: the reporting store's hypertables, compression and rollups.\n")
	b.WriteString("shared_preload_libraries = 'timescaledb'\n")
	b.WriteString("timescaledb.telemetry_level = off\n")
	// The Docker image's timescaledb-tune writes these on first init. A bare
	// initdb leaves max_worker_processes at 8 against Timescale's default 16
	// background workers, so its policy jobs (compression, retention, the
	// reporting rollups) never get a slot: "no available background worker
	// slots". 8 Timescale + 1 launcher + 4 parallel + 3 spare.
	b.WriteString("timescaledb.max_background_workers = 8\n")
	b.WriteString("max_worker_processes = 16\n")
	b.WriteString("max_parallel_workers = 4\n\n")
	b.WriteString("# The supervisor owns the log stream.\n")
	b.WriteString("log_destination = 'stderr'\n")
	b.WriteString("logging_collector = off\n\n")
	b.WriteString("timezone = 'UTC'\n")
	b.WriteString("log_timezone = 'UTC'\n")
	b.WriteString("datestyle = 'ISO, MDY'\n")
	return b.String()
}

// RenderHBA is the whole access policy.
func RenderHBA() string {
	return "# Neubit VMS appliance - GENERATED on every service start; do not edit.\n" +
		"# TYPE  DATABASE  USER  ADDRESS       METHOD\n" +
		"host    all       all   127.0.0.1/32  scram-sha-256\n" +
		"host    all       all   ::1/128       scram-sha-256\n"
}

const includeLine = "include_if_exists = 'neubit.conf'"

func writeConfig(o Options) error {
	if err := writeAtomic(filepath.Join(o.DataDir, "neubit.conf"), RenderOverlay(o)); err != nil {
		return err
	}
	if err := writeAtomic(filepath.Join(o.DataDir, "pg_hba.conf"), RenderHBA()); err != nil {
		return err
	}
	conf := filepath.Join(o.DataDir, "postgresql.conf")
	b, err := os.ReadFile(conf)
	if err != nil {
		return err
	}
	if bytes.Contains(b, []byte(includeLine)) {
		return nil
	}
	b = append(bytes.TrimRight(b, "\r\n"), []byte("\n\n# Neubit VMS appliance overlay (must stay last).\n"+includeLine+"\n")...)
	return writeAtomic(conf, string(b))
}

func writeAtomic(path, s string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(s), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// BootstrapSQL creates every database that does not exist. One statement per
// line: the single-user backend reads statements terminated by newlines.
func BootstrapSQL(o Options) string {
	var lines []string
	for _, db := range append([]string{o.ControlDB}, o.Databases...) {
		lines = append(lines, fmt.Sprintf("CREATE DATABASE %s OWNER %s;", db, o.User))
	}
	return strings.Join(lines, "\n") + "\n"
}

// sqlstate 42P04 duplicate_database: already there, which is the point.
var errLine = regexp.MustCompile(`(?m)^(ERROR|FATAL|PANIC):\s+([0-9A-Z]{5}):?\s*(.*)$`)

func ensureDatabases(ctx context.Context, postgres string, o Options) error {
	args := []string{"--single", "-D", o.DataDir, "-c", "log_error_verbosity=verbose", "-c", "exit_on_error=off", "postgres"}
	sctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	out, err := runCmd(sctx, postgres, args, BootstrapSQL(o), nil)
	if cerr := ClassifyBootstrap(out); cerr != nil {
		return fmt.Errorf("creating databases: %w", cerr)
	}
	if err != nil {
		return fmt.Errorf("single-user backend: %w: %s", err, strings.TrimSpace(scrub(out, o.Password)))
	}
	return nil
}

// ClassifyBootstrap fails on any ERROR other than duplicate_database, and on
// any FATAL or PANIC. The exit code says nothing: ERROR does not stop --single.
func ClassifyBootstrap(log string) error {
	for _, m := range errLine.FindAllStringSubmatch(log, -1) {
		if m[1] == "ERROR" && m[2] == "42P04" {
			continue
		}
		return fmt.Errorf("%s %s: %s", m[1], m[2], strings.TrimSpace(m[3]))
	}
	return nil
}

func scrub(s, secret string) string {
	if secret == "" {
		return s
	}
	return strings.ReplaceAll(s, secret, "********")
}

// ServiceDatabases reads the DATABASES block of deploy/postgres/init-service-dbs.sh
// (shipped in the payload), with that script's own parsing: text after # is a
// comment, blank lines are skipped.
func ServiceDatabases(script string) ([]string, error) {
	f, err := os.Open(script)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []string
	in := false
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !in {
			if strings.HasPrefix(strings.TrimSpace(line), `DATABASES="`) {
				in = true
			}
			continue
		}
		if strings.TrimSpace(line) == `"` {
			break
		}
		db, _, _ := strings.Cut(line, "#")
		db = strings.TrimSpace(db)
		if db != "" {
			out = append(out, db)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("%s: no DATABASES block", script)
	}
	return out, nil
}
