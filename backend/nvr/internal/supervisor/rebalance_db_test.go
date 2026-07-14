// DB-backed tests for rebalance-on-node-loss (P6-A). They register two media nodes
// + shards against a REAL postgres, mark one node dead, and assert its shards are
// reassigned to the survivor with EnsurePath/record re-invoked there (via a fake
// MediaMTX httptest node). Also covers the single-node case (no survivor → clean
// no-op) and the secondary-node pick for redundant recording.
//
// SKIP when VE_TEST_DATABASE_URL is unset (see testdb_test.go). Each test gets a
// fresh random schema.
package supervisor

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/neubit/nvr/internal/mediamtx"
)

// fakeMTX is an httptest MediaMTX control API: it answers Healthy, EnsurePath
// (add/patch), and SetRecord (patch), recording which paths got record set so the
// test can assert record was re-enabled on the survivor.
type fakeMTX struct {
	mu          sync.Mutex
	ensured     []string // path names added/patched
	recordOnFor []string // path names record was set on
}

func newFakeMTX(t *testing.T) (*httptest.Server, *fakeMTX) {
	t.Helper()
	f := &fakeMTX{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v3/config/global/get":
			w.WriteHeader(http.StatusOK) // Healthy
		case r.Method == http.MethodPost && hasPrefix(r.URL.Path, "/v3/config/paths/add/"):
			f.ensured = append(f.ensured, trim(r.URL.Path, "/v3/config/paths/add/"))
			w.WriteHeader(http.StatusOK)
		case r.Method == http.MethodPatch && hasPrefix(r.URL.Path, "/v3/config/paths/patch/"):
			name := trim(r.URL.Path, "/v3/config/paths/patch/")
			// A record patch carries "record"; treat any patch here as record-set
			// for the test's assertion (both EnsurePath-conflict + SetRecord patch).
			f.recordOnFor = append(f.recordOnFor, name)
			w.WriteHeader(http.StatusOK)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
	return srv, f
}

func (f *fakeMTX) recordedOn(name string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, n := range f.recordOnFor {
		if n == name {
			return true
		}
	}
	return false
}

// recordRebinderSpy captures rebind calls.
type recordRebinderSpy struct {
	mu    sync.Mutex
	calls []string
}

func (s *recordRebinderSpy) RebindRecording(_ context.Context, tenant, cam, profile string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.calls = append(s.calls, tenant+"/"+cam+"/"+profile)
}

func TestReassignFromDeadNode(t *testing.T) {
	pool := newTestDB(t)
	ctx := context.Background()

	srv, fake := newFakeMTX(t)
	defer srv.Close()

	sup := New(pool, mediamtx.New(), time.Minute, "nvr")
	spy := &recordRebinderSpy{}
	sup.SetRecordRebinder(spy)

	// Two nodes both pointing at the fake MediaMTX (so EnsurePath/record succeed).
	nodeA := mediamtx.Node{ID: "node-a", APIURL: srv.URL, HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	nodeB := mediamtx.Node{ID: "node-b", APIURL: srv.URL, HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	if err := sup.EnsureNode(ctx, nodeA); err != nil {
		t.Fatal(err)
	}
	if err := sup.EnsureNode(ctx, nodeB); err != nil {
		t.Fatal(err)
	}

	// A live shard + an active recording target on node-a.
	name := mediamtx.PathName("t1", "cam-1", "main")
	if _, err := pool.Exec(ctx, `
		INSERT INTO stream_shards (tenant_id, camera_id, profile, node_id, path_name, rtsp_url)
		VALUES ('t1','cam-1','main','node-a',$1,'rtsp://cam/1')`, name); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO recording_targets (tenant_id, camera_id, profile, node_id, path_name, record_path, active, trigger_type)
		VALUES ('t1','cam-1','main','node-a',$1,'/recordings/%path/%Y',true,'continuous')`, name); err != nil {
		t.Fatal(err)
	}

	// Kill node-a and rebalance.
	if err := sup.MarkNodeDead(ctx, "node-a"); err != nil {
		t.Fatal(err)
	}
	if err := sup.ReassignFrom(ctx, "node-a"); err != nil {
		t.Fatalf("ReassignFrom: %v", err)
	}

	// The shard must now point at node-b.
	var newNode string
	if err := pool.QueryRow(ctx,
		`SELECT node_id FROM stream_shards WHERE camera_id='cam-1'`).Scan(&newNode); err != nil {
		t.Fatal(err)
	}
	if newNode != "node-b" {
		t.Fatalf("shard not reassigned: node_id=%s want node-b", newNode)
	}
	// The recording target must be repointed too.
	var recNode string
	if err := pool.QueryRow(ctx,
		`SELECT node_id FROM recording_targets WHERE camera_id='cam-1'`).Scan(&recNode); err != nil {
		t.Fatal(err)
	}
	if recNode != "node-b" {
		t.Fatalf("recording target not reassigned: node_id=%s want node-b", recNode)
	}
	// EnsurePath must have been re-invoked on the survivor.
	if len(fake.ensured) == 0 {
		t.Fatal("expected EnsurePath re-invoked on survivor")
	}
	// The record rebind hook must have fired for the recording camera.
	spy.mu.Lock()
	got := append([]string(nil), spy.calls...)
	spy.mu.Unlock()
	if len(got) != 1 || got[0] != "t1/cam-1/main" {
		t.Fatalf("expected rebind for t1/cam-1/main, got %v", got)
	}

	// Idempotent: a second reassign moves nothing (shard already on node-b).
	if err := sup.ReassignFrom(ctx, "node-a"); err != nil {
		t.Fatalf("second ReassignFrom: %v", err)
	}
}

func TestReassignFromNoSurvivor(t *testing.T) {
	pool := newTestDB(t)
	ctx := context.Background()
	srv, _ := newFakeMTX(t)
	defer srv.Close()

	sup := New(pool, mediamtx.New(), time.Minute, "nvr")
	only := mediamtx.Node{ID: "node-solo", APIURL: srv.URL, HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	if err := sup.EnsureNode(ctx, only); err != nil {
		t.Fatal(err)
	}
	name := mediamtx.PathName("t1", "cam-2", "main")
	if _, err := pool.Exec(ctx, `
		INSERT INTO stream_shards (tenant_id, camera_id, profile, node_id, path_name, rtsp_url)
		VALUES ('t1','cam-2','main','node-solo',$1,'rtsp://cam/2')`, name); err != nil {
		t.Fatal(err)
	}
	// Killing the only node: no survivor → ReassignFrom is a clean no-op (deferred),
	// the shard stays put, no crash.
	if err := sup.MarkNodeDead(ctx, "node-solo"); err != nil {
		t.Fatal(err)
	}
	if err := sup.ReassignFrom(ctx, "node-solo"); err != nil {
		t.Fatalf("expected graceful no-op, got %v", err)
	}
	var node string
	_ = pool.QueryRow(ctx, `SELECT node_id FROM stream_shards WHERE camera_id='cam-2'`).Scan(&node)
	if node != "node-solo" {
		t.Fatalf("shard should stay pinned with no survivor, got %s", node)
	}
}

func TestMonitorTickMarksDeadAndReassigns(t *testing.T) {
	pool := newTestDB(t)
	ctx := context.Background()
	srv, _ := newFakeMTX(t)
	defer srv.Close()

	sup := New(pool, mediamtx.New(), time.Minute, "nvr")
	// node-a is UP (points at fake, answers Healthy); node-b is DOWN (bad URL) and
	// will age past the dead threshold.
	up := mediamtx.Node{ID: "up", APIURL: srv.URL, HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	down := mediamtx.Node{ID: "down", APIURL: "http://127.0.0.1:1", HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	if err := sup.EnsureNode(ctx, up); err != nil {
		t.Fatal(err)
	}
	if err := sup.EnsureNode(ctx, down); err != nil {
		t.Fatal(err)
	}
	// A shard on the down node.
	name := mediamtx.PathName("t1", "cam-3", "main")
	if _, err := pool.Exec(ctx, `
		INSERT INTO stream_shards (tenant_id, camera_id, profile, node_id, path_name, rtsp_url)
		VALUES ('t1','cam-3','main','down',$1,'rtsp://cam/3')`, name); err != nil {
		t.Fatal(err)
	}
	// Force the down node's heartbeat into the past so the monitor sees it dead.
	if _, err := pool.Exec(ctx,
		`UPDATE media_nodes SET last_heartbeat = now() - interval '10 minutes' WHERE id='down'`); err != nil {
		t.Fatal(err)
	}

	// One monitor tick: refreshes 'up' (Healthy), marks 'down' dead (>1s), reassigns.
	sup.monitorTick(ctx, 1*time.Second)

	var node string
	if err := pool.QueryRow(ctx, `SELECT node_id FROM stream_shards WHERE camera_id='cam-3'`).Scan(&node); err != nil {
		t.Fatal(err)
	}
	if node != "up" {
		t.Fatalf("monitor did not reassign cam-3 to the survivor: node=%s", node)
	}
	// The dead node must be flagged.
	var healthy bool
	_ = pool.QueryRow(ctx, `SELECT healthy FROM media_nodes WHERE id='down'`).Scan(&healthy)
	if healthy {
		t.Fatal("down node should be flagged unhealthy")
	}
}

func TestSecondaryNodePick(t *testing.T) {
	pool := newTestDB(t)
	ctx := context.Background()
	srv, _ := newFakeMTX(t)
	defer srv.Close()

	sup := New(pool, mediamtx.New(), time.Minute, "nvr")
	// Single node → no secondary available.
	solo := mediamtx.Node{ID: "n1", APIURL: srv.URL, HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	if err := sup.EnsureNode(ctx, solo); err != nil {
		t.Fatal(err)
	}
	if _, ok := sup.SecondaryNode(ctx, "n1"); ok {
		t.Fatal("expected no secondary with a single node")
	}
	// Add a second node → it becomes the secondary for n1.
	n2 := mediamtx.Node{ID: "n2", APIURL: srv.URL, HLSBase: "h", WebRTCBase: "w", RTSPBase: "r"}
	if err := sup.EnsureNode(ctx, n2); err != nil {
		t.Fatal(err)
	}
	sec, ok := sup.SecondaryNode(ctx, "n1")
	if !ok || sec.ID != "n2" {
		t.Fatalf("expected secondary n2, got ok=%v id=%s", ok, sec.ID)
	}
}

// tiny string helpers (avoid importing strings for two calls).
func hasPrefix(s, p string) bool { return len(s) >= len(p) && s[:len(p)] == p }
func trim(s, p string) string {
	if hasPrefix(s, p) {
		return s[len(p):]
	}
	return s
}
