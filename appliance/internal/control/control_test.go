package control

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/neubit/vms-appliance/internal/layout"
	"github.com/neubit/vms-appliance/internal/supervise"
	"github.com/neubit/vms-appliance/internal/sysstat"
)

type fakeSup struct {
	sts  []supervise.Status
	last string
}

func (f *fakeSup) Status() []supervise.Status { return f.sts }
func (f *fakeSup) Restart(n string) error     { return f.do("restart", n) }
func (f *fakeSup) Stop(n string) error        { return f.do("stop", n) }
func (f *fakeSup) Start(n string) error       { return f.do("start", n) }
func (f *fakeSup) do(v, n string) error {
	for _, s := range f.sts {
		if s.Name == n {
			f.last = v + ":" + n
			return nil
		}
	}
	return supervise.ErrUnknown
}

func server(t *testing.T) (*Server, *fakeSup, layout.Layout) {
	t.Helper()
	l, _ := layout.New(t.TempDir(), t.TempDir())
	sup := &fakeSup{sts: []supervise.Status{
		{Name: "postgres", State: supervise.StateHealthy, PID: 10, Critical: true},
		{Name: "migrate-core", State: supervise.StateCompleted, OneShot: true},
		{Name: "core", State: supervise.StateHealthy, PID: 11, Critical: true},
		{Name: "geocoder", State: supervise.StateWaiting, LastError: "no Java runtime installed"},
	}}
	return New(Options{Sup: sup, L: l, Token: "tok", Version: "1.0.0", Started: time.Now()}), sup, l
}

func do(s *Server, method, path, token string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, nil)
	if token != "" {
		req.Header.Set("X-Ops-Token", token)
	}
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	return rec
}

func TestOpsEndpointsNeedTheToken(t *testing.T) {
	s, _, _ := server(t)
	for _, p := range []string{"/containers", "/host", "/db/export", "/v1/logs/core"} {
		if rec := do(s, "GET", p, ""); rec.Code != 401 {
			t.Errorf("%s without token: %d", p, rec.Code)
		}
		if rec := do(s, "GET", p, "wrong"); rec.Code != 401 {
			t.Errorf("%s wrong token: %d", p, rec.Code)
		}
	}
	// An empty configured token refuses everyone, including an empty header.
	s.o.Token = ""
	if rec := do(s, "GET", "/containers", ""); rec.Code != 401 {
		t.Fatal("empty token accepted")
	}
}

func TestStatusIsOpenAndSaysReady(t *testing.T) {
	s, _, _ := server(t)
	rec := do(s, "GET", "/v1/status", "")
	if rec.Code != 200 {
		t.Fatal(rec.Code)
	}
	var st Status
	_ = json.Unmarshal(rec.Body.Bytes(), &st)
	// The waiting geocoder is optional; the completed migration is not counted.
	if !st.Ready || st.Healthy != 2 || st.Total != 3 {
		t.Fatalf("%+v", st)
	}
}

func TestACriticalProcessNotHealthyMeansNotReady(t *testing.T) {
	ready, _, _ := Ready([]supervise.Status{{Name: "core", State: supervise.StateRestarting, Critical: true}})
	if ready {
		t.Fatal("ready with core restarting")
	}
}

func TestContainersSpeakTheOpsAgentsVocabulary(t *testing.T) {
	s, _, _ := server(t)
	rec := do(s, "GET", "/containers", "tok")
	var cs []Container
	if err := json.Unmarshal(rec.Body.Bytes(), &cs); err != nil {
		t.Fatal(err)
	}
	by := map[string]Container{}
	for _, c := range cs {
		by[c.Name] = c
	}
	if by["core"].State != "running" || *by["core"].Health != "healthy" || by["core"].Service != "core" {
		t.Fatalf("core %+v", by["core"])
	}
	// A finished migration looks like a finished db-init: exited, code 0.
	m := by["migrate-core"]
	if m.State != "exited" || m.ExitCode == nil || *m.ExitCode != 0 {
		t.Fatalf("migration %+v", m)
	}
	if by["geocoder"].State != "created" {
		t.Fatalf("geocoder %+v", by["geocoder"])
	}
}

func TestRestartedProcessIsRestartingAndUnhealthy(t *testing.T) {
	c := ContainerOf(supervise.Status{Name: "vision", State: supervise.StateRestarting}, sysstat.Proc{}, "1")
	if c.State != "restarting" || c.Health == nil || *c.Health != "unhealthy" {
		t.Fatalf("%+v", c)
	}
}

func TestLifecycleAndUnknownNames(t *testing.T) {
	s, sup, _ := server(t)
	if rec := do(s, "POST", "/containers/core/restart", "tok"); rec.Code != 200 || sup.last != "restart:core" {
		t.Fatalf("%d %s", rec.Code, sup.last)
	}
	if rec := do(s, "POST", "/containers/nope/stop", "tok"); rec.Code != 404 {
		t.Fatalf("unknown process: %d", rec.Code)
	}
	if rec := do(s, "POST", "/containers/core/delete", "tok"); rec.Code != 404 {
		t.Fatalf("unknown verb: %d", rec.Code)
	}
	if rec := do(s, "POST", "/services/core/scale", "tok"); rec.Code != 501 {
		t.Fatalf("scale: %d", rec.Code)
	}
}

func TestLogsTailTheProcessLog(t *testing.T) {
	s, _, l := server(t)
	_ = os.MkdirAll(l.LogDir(), 0o755)
	lw, _ := supervise.OpenLog(filepath.Join(l.LogDir(), "core.log"))
	_, _ = lw.Write([]byte("a\nb\nc\n"))
	_ = lw.Close()
	rec := do(s, "GET", "/containers/core/logs?tail=2", "tok")
	var body struct{ Lines []string }
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if len(body.Lines) != 2 || !strings.HasSuffix(body.Lines[1], " c") {
		t.Fatalf("%q", body.Lines)
	}
	if rec := do(s, "GET", "/containers/../secrets/logs", "tok"); rec.Code == 200 {
		t.Fatal("a name outside the process table was served")
	}
}

func TestAHeldProcessSaysWhyInsteadOfAnEmptyLog(t *testing.T) {
	s, _, _ := server(t)
	var body struct{ Lines []string }
	_ = json.Unmarshal(do(s, "GET", "/containers/geocoder/logs", "tok").Body.Bytes(), &body)
	if len(body.Lines) != 1 || !strings.HasSuffix(body.Lines[0], "not started: no Java runtime installed") {
		t.Fatalf("%q", body.Lines)
	}
	body.Lines = nil
	_ = json.Unmarshal(do(s, "GET", "/containers/geocoder/logs?since=1", "tok").Body.Bytes(), &body)
	if len(body.Lines) != 0 {
		t.Fatalf("repeated on a follow-up poll: %q", body.Lines)
	}
}

func TestDumpRefusesShellEscapes(t *testing.T) {
	for _, bad := range []string{"\\! del /q C:\\*\n", "  \\copy x from 'f'\n", "\\i other.sql\n"} {
		if _, err := SanitizeDump([]byte("SELECT 1;\n" + bad)); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestDumpKeepsCopyDataAndRewritesTimeouts(t *testing.T) {
	in := "SET lock_timeout = 0;\nSET statement_timeout = 0;\nSET transaction_timeout = 0;\n" +
		"CREATE EXTENSION IF NOT EXISTS timescaledb WITH SCHEMA public;\n" +
		"COMMENT ON EXTENSION timescaledb IS 'x';\n" +
		"COPY public.t (a) FROM stdin;\n\\! not a command, just data\n\\.\n\\connect neubit_control\n"
	out, err := SanitizeDump([]byte(in))
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, want := range []string{"SET lock_timeout = '120s';", "SET statement_timeout = '300s';", "\\! not a command, just data", "\\connect neubit_control"} {
		if !strings.Contains(s, want) {
			t.Errorf("missing %q in\n%s", want, s)
		}
	}
	for _, gone := range []string{"transaction_timeout", "EXTENSION IF NOT EXISTS timescaledb", "COMMENT ON EXTENSION"} {
		if strings.Contains(s, gone) {
			t.Errorf("kept %q", gone)
		}
	}
}

func TestImportRejectsOversizeAndEmpty(t *testing.T) {
	s, _, _ := server(t)
	s.o.MaxDumpBytes = 4
	req := httptest.NewRequest("POST", "/db/import", strings.NewReader("SELECT 1;"))
	req.Header.Set("X-Ops-Token", "tok")
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize: %d", rec.Code)
	}
	s.o.MaxDumpBytes = 100
	if rec := do(s, "POST", "/db/import", "tok"); rec.Code != 400 {
		t.Fatalf("empty: %d", rec.Code)
	}
}
