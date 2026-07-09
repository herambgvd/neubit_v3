// DB-backed tests for the ANR engine (P6-A). They exercise gap detection, the
// ANRJob lifecycle (queued→running→done), the anr.request publish, and the
// anr.result close — against a REAL postgres so the SQL (partial-unique dedupe,
// interval math) is verified, not mocked.
//
// They SKIP when VE_TEST_DATABASE_URL is unset, so `go test ./...` on a laptop with
// no DB still passes; the Docker verify sets it to the compose postgres and runs
// them for real. Each test gets its own random schema (dropped on cleanup) so runs
// are isolated + parallel-safe.
package anr

import (
	"context"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// capBus captures published subjects+payloads without a broker.
type capBus struct {
	subjects []string
	payloads []map[string]any
}

func (c *capBus) Publish(subj string, payload map[string]any) error {
	c.subjects = append(c.subjects, subj)
	c.payloads = append(c.payloads, payload)
	return nil
}

// seedSegments inserts recording_segments rows at the given start offsets so
// DetectGap has a timeline to scan.
func seedSegments(t *testing.T, pool *pgxpool.Pool, tenant, cam, profile string, starts []time.Time) {
	t.Helper()
	ctx := context.Background()
	for i, s := range starts {
		path := "/recordings/cameras/" + tenant + "/" + cam + "/" + profile + "/" + s.Format("2006-01-02_15-04-05") + "-000000.mp4"
		_, err := pool.Exec(ctx, `
			INSERT INTO recording_segments (path, tenant_id, camera_id, profile, started_at)
			VALUES ($1,$2,$3,$4,$5) ON CONFLICT (path) DO NOTHING`,
			path, tenant, cam, profile, s)
		if err != nil {
			t.Fatalf("seed segment %d: %v", i, err)
		}
	}
}

func TestDetectGap(t *testing.T) {
	pool := newTestDB(t)
	e := New(pool, &capBus{}, "nvr", Config{MinGap: 2 * time.Minute, MaxGap: 24 * time.Hour})
	ctx := context.Background()
	base := time.Date(2026, 7, 9, 10, 0, 0, 0, time.UTC)

	// Continuous 1-min segments 10:00..10:03, THEN a 30-min outage, then recovery
	// at 10:33 (a fabricated gap).
	starts := []time.Time{
		base, base.Add(1 * time.Minute), base.Add(2 * time.Minute), base.Add(3 * time.Minute),
		base.Add(33 * time.Minute), base.Add(34 * time.Minute),
	}
	seedSegments(t, pool, "t1", "cam-1", "main", starts)

	gap, ok, err := e.DetectGap(ctx, "t1", "cam-1", "main")
	if err != nil {
		t.Fatalf("DetectGap: %v", err)
	}
	if !ok {
		t.Fatal("expected a gap to be detected")
	}
	// Gap is 10:03 → 10:33 (the hole between the last pre-outage seg and recovery).
	if !gap.From.Equal(base.Add(3 * time.Minute)) {
		t.Fatalf("gap.From = %v, want %v", gap.From, base.Add(3*time.Minute))
	}
	if !gap.To.Equal(base.Add(33 * time.Minute)) {
		t.Fatalf("gap.To = %v, want %v", gap.To, base.Add(33*time.Minute))
	}
}

func TestDetectGapNoGap(t *testing.T) {
	pool := newTestDB(t)
	e := New(pool, &capBus{}, "nvr", Config{MinGap: 2 * time.Minute})
	ctx := context.Background()
	base := time.Date(2026, 7, 9, 10, 0, 0, 0, time.UTC)
	// Unbroken 1-min segments — every hole is <= MinGap → no backfill.
	seedSegments(t, pool, "t1", "cam-ok", "main", []time.Time{
		base, base.Add(time.Minute), base.Add(2 * time.Minute), base.Add(3 * time.Minute),
	})
	if _, ok, err := e.DetectGap(ctx, "t1", "cam-ok", "main"); err != nil || ok {
		t.Fatalf("expected no gap, got ok=%v err=%v", ok, err)
	}
}

func TestOpenJobLifecycleAndDedupe(t *testing.T) {
	pool := newTestDB(t)
	bus := &capBus{}
	e := New(pool, bus, "nvr", Config{})
	ctx := context.Background()
	from := time.Date(2026, 7, 9, 10, 3, 0, 0, time.UTC)
	to := time.Date(2026, 7, 9, 10, 33, 0, 0, time.UTC)

	id, err := e.OpenJob(ctx, "t1", "cam-1", "main", from, to, "/recordings/%path/%Y")
	if err != nil {
		t.Fatalf("OpenJob: %v", err)
	}
	if id == 0 {
		t.Fatal("expected a job id")
	}

	// It should be RUNNING and an anr.request published with the gap window.
	jobs, err := e.ListJobs(ctx, "t1", "cam-1", 10)
	if err != nil {
		t.Fatalf("ListJobs: %v", err)
	}
	if len(jobs) != 1 || jobs[0].Status != "running" {
		t.Fatalf("expected 1 running job, got %+v", jobs)
	}
	if len(bus.subjects) != 1 || bus.subjects[0] != "tenant.t1.vms.anr.request" {
		t.Fatalf("expected anr.request publish, got %v", bus.subjects)
	}
	if bus.payloads[0]["job_id"] != id {
		t.Fatalf("request job_id = %v, want %d", bus.payloads[0]["job_id"], id)
	}

	// Opening the SAME window again is deduped (partial-unique on queued|running).
	id2, err := e.OpenJob(ctx, "t1", "cam-1", "main", from, to, "/recordings/%path/%Y")
	if err != nil {
		t.Fatalf("OpenJob dedupe: %v", err)
	}
	if id2 != 0 {
		t.Fatalf("expected dedupe (id2=0), got %d", id2)
	}
	if len(bus.subjects) != 1 {
		t.Fatalf("dedupe must not re-publish; got %d publishes", len(bus.subjects))
	}

	// Close it via the result path → done + count recorded + completed_at set.
	if err := e.CloseJob(ctx, id, "done", 30, ""); err != nil {
		t.Fatalf("CloseJob: %v", err)
	}
	jobs, _ = e.ListJobs(ctx, "t1", "cam-1", 10)
	if jobs[0].Status != "done" || jobs[0].BackfilledSegments != 30 || jobs[0].CompletedAt == nil {
		t.Fatalf("job not closed as expected: %+v", jobs[0])
	}

	// After close, the same window can be opened again (dedupe only blocks ACTIVE).
	id3, err := e.OpenJob(ctx, "t1", "cam-1", "main", from, to, "/recordings/%path/%Y")
	if err != nil || id3 == 0 {
		t.Fatalf("expected a fresh job after close, got id=%d err=%v", id3, err)
	}
}

func TestHandleResultClosesJob(t *testing.T) {
	pool := newTestDB(t)
	e := New(pool, &capBus{}, "nvr", Config{})
	ctx := context.Background()
	from := time.Now().UTC().Add(-time.Hour)
	to := time.Now().UTC().Add(-30 * time.Minute)
	id, err := e.OpenJob(ctx, "t1", "cam-9", "main", from, to, "")
	if err != nil {
		t.Fatalf("OpenJob: %v", err)
	}
	// Simulate the vision fulfiller's anr.result envelope (numbers arrive as float64
	// over JSON — HandleResult must coerce).
	env := envelopeWith(map[string]any{
		"job_id":              float64(id),
		"status":              "done",
		"backfilled_segments": float64(12),
	})
	if err := e.HandleResult(ctx, env); err != nil {
		t.Fatalf("HandleResult: %v", err)
	}
	jobs, _ := e.ListJobs(ctx, "t1", "cam-9", 10)
	if jobs[0].Status != "done" || jobs[0].BackfilledSegments != 12 {
		t.Fatalf("HandleResult did not close job: %+v", jobs[0])
	}
}
