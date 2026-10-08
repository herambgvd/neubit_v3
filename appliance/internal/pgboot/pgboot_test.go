package pgboot

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var origRun = runCmd

func opts(t *testing.T) Options {
	t.Helper()
	bin := t.TempDir()
	for _, n := range []string{"initdb", "postgres"} {
		if err := os.WriteFile(filepath.Join(bin, exe(n)), nil, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return Options{
		BinDir: bin, DataDir: filepath.Join(t.TempDir(), "pgdata"), Port: 15432,
		User: "neubit", Password: "s3cret", ControlDB: "neubit_control",
		Databases: []string{"neubit_ingest", "neubit_vision"},
	}
}

func TestInitdbIsUTF8BuiltinLocaleAndScramFromTheStart(t *testing.T) {
	args := strings.Join(InitdbArgs(Options{DataDir: "d", User: "neubit"}, "pw"), " ")
	for _, want := range []string{"--encoding=UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8",
		"--auth-host=scram-sha-256", "--auth-local=scram-sha-256", "--pwfile=pw", "--username=neubit"} {
		if !strings.Contains(args, want) {
			t.Errorf("initdb args missing %s: %s", want, args)
		}
	}
	if strings.Contains(args, "s3cret") {
		t.Fatal("password on the command line")
	}
}

func TestOverlayIsLoopbackOnlyAndPreloadsTimescale(t *testing.T) {
	o := RenderOverlay(Options{Port: 15432})
	for _, want := range []string{"listen_addresses = '127.0.0.1'", "port = 15432",
		"shared_preload_libraries = 'timescaledb'", "timescaledb.telemetry_level = off", "timezone = 'UTC'",
		"max_worker_processes = 16", "timescaledb.max_background_workers = 8", "shared_buffers = 1GB"} {
		if !strings.Contains(o, want) {
			t.Errorf("overlay missing %q", want)
		}
	}
	if strings.Contains(RenderHBA(), "trust") || strings.Contains(RenderHBA(), "0.0.0.0") {
		t.Fatal("pg_hba allows more than scram on loopback")
	}
}

func TestDuplicateDatabaseIsFineAnythingElseIsNot(t *testing.T) {
	ok := "ERROR:  42P04: database \"neubit_ingest\" already exists\n"
	if err := ClassifyBootstrap(ok); err != nil {
		t.Fatalf("duplicate database treated as failure: %v", err)
	}
	if ClassifyBootstrap("ERROR:  42501: permission denied to create database\n") == nil {
		t.Fatal("permission error ignored")
	}
	if ClassifyBootstrap("FATAL:  XX000: could not open file\n") == nil {
		t.Fatal("FATAL ignored")
	}
}

func TestBootstrapCreatesControlAndServiceDatabases(t *testing.T) {
	sql := BootstrapSQL(Options{User: "neubit", ControlDB: "neubit_control", Databases: []string{"a_db", "b_db"}})
	if got := strings.Count(sql, "CREATE DATABASE"); got != 3 {
		t.Fatalf("%d creates: %s", got, sql)
	}
	if !strings.Contains(sql, "CREATE DATABASE neubit_control OWNER neubit;") {
		t.Fatal(sql)
	}
}

func TestServiceDatabasesAreReadFromTheDockerStacksList(t *testing.T) {
	// Drift guard: the appliance must create exactly what db-init creates.
	got, err := ServiceDatabases(filepath.Join("..", "..", "..", "deploy", "postgres", "init-service-dbs.sh"))
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(got, ",")
	for _, want := range []string{"neubit_ingest", "neubit_workflow", "neubit_access", "neubit_vision", "neubit_reporting"} {
		if !strings.Contains(joined, want) {
			t.Errorf("%s missing from %v", want, got)
		}
	}
	for _, db := range got {
		if !identRe.MatchString(db) {
			t.Errorf("%q would not pass validation", db)
		}
	}
}

func TestFreshDirectoryRunsInitdbThenConfigThenDatabases(t *testing.T) {
	o := opts(t)
	var calls []string
	runCmd = func(_ context.Context, name string, args []string, stdin string, _ []string) (string, error) {
		calls = append(calls, filepath.Base(name))
		if strings.HasPrefix(filepath.Base(name), "initdb") {
			// Simulate initdb laying down a cluster.
			_ = os.MkdirAll(o.DataDir, 0o700)
			_ = os.WriteFile(filepath.Join(o.DataDir, "PG_VERSION"), []byte("17\n"), 0o600)
			_ = os.WriteFile(filepath.Join(o.DataDir, "postgresql.conf"), []byte("# stock\n"), 0o600)
		}
		return "", nil
	}
	t.Cleanup(func() { runCmd = origRun })
	created, err := EnsureCluster(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if !created || len(calls) != 2 {
		t.Fatalf("created=%v calls=%v", created, calls)
	}
	conf, _ := os.ReadFile(filepath.Join(o.DataDir, "postgresql.conf"))
	if !strings.Contains(string(conf), includeLine) {
		t.Fatal("overlay not included")
	}
	// Second boot: no initdb, include not duplicated.
	calls = nil
	created, err = EnsureCluster(context.Background(), o)
	if err != nil || created || len(calls) != 1 {
		t.Fatalf("second boot created=%v calls=%v err=%v", created, calls, err)
	}
	conf, _ = os.ReadFile(filepath.Join(o.DataDir, "postgresql.conf"))
	if strings.Count(string(conf), includeLine) != 1 {
		t.Fatal("include appended twice")
	}
}

func TestRefusesSomeoneElsesDirectory(t *testing.T) {
	o := opts(t)
	_ = os.MkdirAll(o.DataDir, 0o700)
	_ = os.WriteFile(filepath.Join(o.DataDir, "important.txt"), []byte("x"), 0o600)
	runCmd = func(context.Context, string, []string, string, []string) (string, error) {
		t.Fatal("ran a command against an unrecognised directory")
		return "", nil
	}
	t.Cleanup(func() { runCmd = origRun })
	if _, err := EnsureCluster(context.Background(), o); !errors.Is(err, ErrAmbiguousData) {
		t.Fatalf("err %v", err)
	}
}

func TestRefusesAnotherMajorVersion(t *testing.T) {
	o := opts(t)
	_ = os.MkdirAll(o.DataDir, 0o700)
	_ = os.WriteFile(filepath.Join(o.DataDir, "PG_VERSION"), []byte("16\n"), 0o600)
	if _, err := EnsureCluster(context.Background(), o); !errors.Is(err, ErrVersionMismatch) {
		t.Fatalf("err %v", err)
	}
}

func TestRejectsUnsafeIdentifiersAndPasswords(t *testing.T) {
	o := opts(t)
	o.Databases = []string{"bad; DROP"}
	if _, err := EnsureCluster(context.Background(), o); !errors.Is(err, ErrInvalid) {
		t.Fatal("unsafe identifier accepted")
	}
	o = opts(t)
	o.Password = "a'b"
	if _, err := EnsureCluster(context.Background(), o); !errors.Is(err, ErrInvalid) {
		t.Fatal("quote in password accepted")
	}
}

func TestFailuresDoNotLeakThePassword(t *testing.T) {
	if strings.Contains(scrub("auth failed for s3cret", "s3cret"), "s3cret") {
		t.Fatal("password not scrubbed")
	}
}
