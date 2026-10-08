package stack

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/neubit/vms-appliance/internal/layout"
	"github.com/neubit/vms-appliance/internal/secrets"
	"github.com/neubit/vms-appliance/internal/supervise"
)

func input(t *testing.T) Input {
	t.Helper()
	l, err := layout.New(t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	sec := map[string]string{"POSTGRES_USER": "neubit", "POSTGRES_PASSWORD": "pw", "VE_JWT_SECRET": "j",
		"VE_SECRETS_KEY": "k", "OPS_AGENT_TOKEN": "tok"}
	for _, u := range secrets.NATSUsers {
		sec["NATS_PASS_"+u] = "n-" + u
	}
	return Input{L: l, Cfg: layout.DefaultConfig(), Ports: layout.DefaultPorts(), Secrets: sec,
		SelfExe: "svc.exe", Gateway: "traefik.yml", NATSConf: "nats.conf", Hostname: "vms01"}
}

func byName(ps []supervise.Proc) map[string]supervise.Proc {
	m := map[string]supervise.Proc{}
	for _, p := range ps {
		m[p.Name] = p
	}
	return m
}

func env(p supervise.Proc, key string) (string, bool) {
	for _, kv := range p.Env {
		if k, v, ok := strings.Cut(kv, "="); ok && k == key {
			return v, true
		}
	}
	return "", false
}

func TestTheTableIsAValidGraph(t *testing.T) {
	// New rejects unknown dependencies and cycles: the table must pass it.
	if _, err := supervise.New(Procs(input(t)), slog.New(slog.NewTextHandler(io.Discard, nil))); err != nil {
		t.Fatal(err)
	}
}

// checkNativeAPI: no Redis, the gateway as the only trusted proxy, loopback
// only, and one uvicorn process.
func checkNativeAPI(t *testing.T, name string, p supervise.Proc) {
	t.Helper()
	if v, _ := env(p, "VE_REDIS_URL"); v != "" {
		t.Errorf("%s has a Redis URL", name)
	}
	if v, _ := env(p, "VE_TRUSTED_PROXY_CIDRS"); v != `["127.0.0.1/32"]` {
		t.Errorf("%s trusted proxy %s", name, v)
	}
	if !strings.Contains(strings.Join(p.Args, " "), "--host 127.0.0.1") {
		t.Errorf("%s does not bind loopback: %v", name, p.Args)
	}
	for _, a := range p.Args {
		if a == "--workers" || a == "--reload" {
			t.Errorf("%s uses %s (selector loop: no subprocesses on Windows)", name, a)
		}
	}
}

func TestNoRedisNoCeleryAndLoopbackOnly(t *testing.T) {
	ps := byName(Procs(input(t)))
	for _, name := range []string{"core", "ingest", "workflow", "access", "vision", "reading-writer"} {
		checkNativeAPI(t, name, ps[name])
	}
	if v, _ := env(ps["workflow"], "VE_WORKFLOW_SCHEDULER"); v != "inline" {
		t.Fatal("workflow sweeps not inline")
	}
	for name := range ps {
		if strings.Contains(name, "celery") || strings.Contains(name, "redis") || strings.Contains(name, "ops-agent") {
			t.Errorf("unexpected process %s", name)
		}
	}
}

func TestEveryServiceStartsAfterItsMigration(t *testing.T) {
	ps := byName(Procs(input(t)))
	want := map[string]string{
		"core": "migrate-core", "ingest": "migrate-ingest", "workflow": "migrate-workflow",
		"access": "migrate-access", "vision": "migrate-vision", "reading-writer": "reporting-apply",
	}
	for svc, mig := range want {
		if !contains(ps[svc].DependsOn, mig) {
			t.Errorf("%s does not wait for %s", svc, mig)
		}
		if !ps[mig].OneShot {
			t.Errorf("%s is not a one-shot", mig)
		}
	}
}

func TestEachServiceGetsItsOwnDatabaseAndBusUser(t *testing.T) {
	ps := byName(Procs(input(t)))
	dbs := map[string]string{"core": "/neubit_control", "ingest": "/neubit_ingest", "workflow": "/neubit_workflow",
		"access": "/neubit_access", "vision": "/neubit_vision", "reading-writer": "/neubit_reporting"}
	for svc, db := range dbs {
		v, _ := env(ps[svc], "VE_DATABASE_URL")
		if !strings.HasSuffix(v, db) || !strings.HasPrefix(v, "postgresql+asyncpg://neubit:pw@127.0.0.1:15432") {
			t.Errorf("%s db url %s", svc, v)
		}
	}
	n, _ := env(ps["vision"], "VE_NATS_URL")
	if n != "nats://vision:n-VISION@127.0.0.1:14222" {
		t.Errorf("vision nats %s", n)
	}
	tok, _ := env(ps["core"], "OPS_AGENT_TOKEN")
	url, _ := env(ps["core"], "OPS_AGENT_URL")
	if tok != "tok" || url != "http://127.0.0.1:18079" {
		t.Errorf("core ops agent %s %s", url, tok)
	}
}

func TestCriticalSetAndGatewayLast(t *testing.T) {
	ps := byName(Procs(input(t)))
	for _, n := range []string{"postgres", "nats", "core", "vision", "frontend", "gateway"} {
		if !ps[n].Critical {
			t.Errorf("%s should be critical", n)
		}
	}
	if ps["geocoder"].Critical || ps["geocoder"].Gate == nil {
		t.Error("the geocoder is optional and gated on its index")
	}
	if !contains(ps["gateway"].DependsOn, "core") || !contains(ps["gateway"].DependsOn, "frontend") {
		t.Error("gateway opens before the console can answer")
	}
}

func TestPublicBaseFollowsThePort(t *testing.T) {
	in := input(t)
	if in.publicBase() != "http://vms01" {
		t.Fatal(in.publicBase())
	}
	in.Ports.UI = 8090
	in.Cfg.AdvertiseHost = "vms.example.local"
	if in.publicBase() != "http://vms.example.local:8090" {
		t.Fatal(in.publicBase())
	}
}

func TestPasswordsWithReservedCharactersAreEscaped(t *testing.T) {
	in := input(t)
	in.Secrets["POSTGRES_PASSWORD"] = "a@b/c"
	if !strings.Contains(in.dbURL("x"), "a%40b%2Fc@127.0.0.1") {
		t.Fatal(in.dbURL("x"))
	}
}

func contains(s []string, v string) bool {
	for _, x := range s {
		if x == v {
			return true
		}
	}
	return false
}

func TestEveryOneShotIsHiddenOnTheSystemPage(t *testing.T) {
	// Drift guard: core's System page lists "services"; a finished migration
	// would show as an exited one at the top of it, like an outage.
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "backend", "core", "app", "system", "router.py"))
	if err != nil {
		t.Fatal(err)
	}
	src := string(b)
	start := strings.Index(src, "_HIDDEN_SERVICES = {")
	end := strings.Index(src[start:], "}")
	hidden := src[start : start+end]
	for _, p := range Procs(input(t)) {
		if p.OneShot && !strings.Contains(hidden, `"`+p.Name+`"`) {
			t.Errorf("one-shot %s is not in core's _HIDDEN_SERVICES", p.Name)
		}
	}
}

// The appliance answers on the LAN before anyone owns it, so first-run setup
// is kept to this computer. Off, whoever reaches /setup first owns the system.
func TestCoreKeepsFirstRunSetupToThisComputer(t *testing.T) {
	if v, _ := env(byName(Procs(input(t)))["core"], "VE_SETUP_LOCAL_ONLY"); v != "true" {
		t.Fatalf("VE_SETUP_LOCAL_ONLY=%q", v)
	}
}
