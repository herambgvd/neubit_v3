// Package anr is the nvr's ANR (Automatic Network Replenishment / edge-recording
// backfill) engine (P6-A). When a continuously-recording camera comes back after
// an outage, its edge SD-card/onboard NVR often holds the footage the NVR missed;
// ANR pulls that gap window and lands the segments on the recordings volume so
// they flow through the normal segment tracker → Recording rows.
//
// ── Where the edge footage comes from (nvr ↔ vision split) ─────────────────────
// The Go nvr does NOT hold device credentials or the brand drivers — those live
// in the Python `vision` control-plane (app/vms/drivers: ONVIF Profile-G /
// Hikvision / CP-Plus footage search + replay, i.e. the P4-B search). So the split
// is deliberately:
//
//	nvr  — DETECTS the gap + owns the ANRJob ledger + orchestration. On a gap it
//	       creates a job (queued) and publishes `tenant.<id>.vms.anr.request` on
//	       NATS with {camera_id, profile, gap_from, gap_to, record_path}.
//	vision — a worker subscribes to anr.request, resolves the camera's device creds,
//	       calls driver.search_recordings + get_playback_uri over the gap window,
//	       ffmpeg-pulls the replay RTSP into <record_path>/cameras/<t>/<c>/<p>/…mp4
//	       on the SHARED recordings volume, then publishes
//	       `tenant.<id>.vms.anr.result` {job_id, backfilled_segments, status, error}.
//	nvr  — the result consumer closes the ANRJob (done|failed + count); the pulled
//	       segments are already being picked up by the P3-A segment tracker (same
//	       on-disk layout) → emitted as recording.segment → Recording rows in vision.
//
// This keeps credentials + drivers on ONE side (vision), reuses the P4-B footage
// search verbatim, and needs no HTTP call from Go into vision. The gap-detection +
// job lifecycle + request/result wiring are all nvr-side and fully unit-tested
// with a fabricated gap; the actual edge pull requires a real device (flagged).
//
// Gap detection: the segment tracker (P3-A) records every finalized segment's
// (camera, start). DetectGap compares the newest run of consecutive segments and,
// when a continuous-recording camera has a hole larger than MinGap between the last
// segment before the outage and the first segment after recovery, opens a job for
// that window. A camera-reconnect NATS signal from vision can also drive it.
package anr

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/neubit/gokernel/events"

	"github.com/neubit/nvr/internal/pgstore"
	"github.com/neubit/nvr/internal/store"
)

// Publisher is the subset of the NATS bus the worker needs (Publish only) — an
// interface so tests capture the emitted anr.request without a broker.
type Publisher interface {
	Publish(subj string, payload map[string]any) error
}

// Job is one ANR backfill of a detected recording gap.
type Job struct {
	ID                 int64      `json:"id"`
	TenantID           string     `json:"tenant_id"`
	CameraID           string     `json:"camera_id"`
	Profile            string     `json:"profile"`
	GapFrom            time.Time  `json:"gap_from"`
	GapTo              time.Time  `json:"gap_to"`
	Status             string     `json:"status"` // queued|running|done|failed
	BackfilledSegments int        `json:"backfilled_segments"`
	Error              string     `json:"error,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	CompletedAt        *time.Time `json:"completed_at,omitempty"`
}

// Config tunes the ANR engine.
type Config struct {
	// MinGap is the smallest recording hole worth backfilling (default 2m) — a
	// blip shorter than this is ignored (matches gvd_nvr's 120s floor).
	MinGap time.Duration
	// MaxGap caps how far back a single ANR job reaches (default 24h) — a longer
	// gap is truncated to the most recent MaxGap window (bounded work).
	MaxGap time.Duration
	// RecordPathTemplate is the MediaMTX-style record path the fulfiller writes
	// pulled segments under (so they match the segment tracker's layout).
	RecordPathTemplate string
	// Tick is the gap-detector sweep interval (default 30s).
	Tick time.Duration
}

// Engine owns the ANRJob ledger + gap detection + the request/result wiring.
type Engine struct {
	db  *pgxpool.Pool
	st  store.Store // persistence seam — recording-target reads route through here
	bus Publisher
	src string
	cfg Config
}

// New builds the ANR engine.
func New(db *pgxpool.Pool, bus Publisher, source string, cfg Config) *Engine {
	if cfg.MinGap <= 0 {
		cfg.MinGap = 2 * time.Minute
	}
	if cfg.MaxGap <= 0 {
		cfg.MaxGap = 24 * time.Hour
	}
	if cfg.Tick <= 0 {
		cfg.Tick = 30 * time.Second
	}
	return &Engine{db: db, st: pgstore.New(db), bus: bus, src: source, cfg: cfg}
}

// Start launches the gap-detection sweep loop (stops when ctx is cancelled). Each
// tick it looks for continuous-recording cameras with a fresh recording gap and
// opens an ANR job for any it finds.
func (e *Engine) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(e.cfg.Tick)
		defer t.Stop()
		log.Printf("ANR engine started (min-gap=%s, max-gap=%s, tick=%s)", e.cfg.MinGap, e.cfg.MaxGap, e.cfg.Tick)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				e.sweep(ctx)
			}
		}
	}()
}

// sweep scans every active continuous recording target for a gap and opens a job
// for each new one. Best-effort: a bad row / down NATS is logged, never fatal.
func (e *Engine) sweep(ctx context.Context) {
	all, err := e.st.ListRecordingTargets(ctx)
	if err != nil {
		log.Printf("anr sweep: list targets: %v", err)
		return
	}
	type tgt struct{ tenant, cam, profile, recPath string }
	var targets []tgt
	for _, rt := range all {
		if !rt.Active || rt.TriggerType != "continuous" {
			continue
		}
		targets = append(targets, tgt{tenant: rt.TenantID, cam: rt.CameraID, profile: rt.Profile, recPath: rt.RecordPath})
	}

	for _, t := range targets {
		gap, ok, err := e.DetectGap(ctx, t.tenant, t.cam, t.profile)
		if err != nil {
			log.Printf("anr sweep: detect gap %s/%s: %v", t.cam, t.profile, err)
			continue
		}
		if !ok {
			continue
		}
		if _, err := e.OpenJob(ctx, t.tenant, t.cam, t.profile, gap.From, gap.To, t.recPath); err != nil {
			log.Printf("anr sweep: open job %s/%s: %v", t.cam, t.profile, err)
		}
	}
}

// Gap is a detected recording hole [From, To).
type Gap struct {
	From time.Time
	To   time.Time
}

// DetectGap inspects the recording_segments ledger for the camera and returns the
// most recent gap larger than MinGap between consecutive segments, capped to
// MaxGap. ok=false means no backfill-worthy gap. It only considers a gap "closed"
// (i.e. the camera has recovered and is recording again) when there is a segment
// AFTER the hole — an ongoing outage (no newer segment) is not yet actionable.
func (e *Engine) DetectGap(ctx context.Context, tenant, cam, profile string) (Gap, bool, error) {
	// Pull the recent segment starts (ascending). We only need enough history to
	// find the latest hole; MaxGap*a-few bounds it. started_at may be NULL for a
	// segment whose filename didn't parse — those are skipped.
	rows, err := e.db.Query(ctx, `
		SELECT started_at FROM recording_segments
		WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3 AND started_at IS NOT NULL
		ORDER BY started_at ASC`,
		tenant, cam, profile)
	if err != nil {
		return Gap{}, false, err
	}
	defer rows.Close()
	var starts []time.Time
	for rows.Next() {
		var t time.Time
		if err := rows.Scan(&t); err == nil {
			starts = append(starts, t)
		}
	}
	if err := rows.Err(); err != nil {
		return Gap{}, false, err
	}
	if len(starts) < 2 {
		return Gap{}, false, nil
	}

	// Walk from newest backwards; the first hole > MinGap is the outage to backfill
	// (there IS a segment after it, so the camera has recovered).
	for i := len(starts) - 1; i >= 1; i-- {
		hole := starts[i].Sub(starts[i-1])
		if hole > e.cfg.MinGap {
			from := starts[i-1]
			to := starts[i]
			// Cap the window to the most recent MaxGap so a long outage stays bounded.
			if to.Sub(from) > e.cfg.MaxGap {
				from = to.Add(-e.cfg.MaxGap)
			}
			return Gap{From: from, To: to}, true, nil
		}
	}
	return Gap{}, false, nil
}

// OpenJob creates a queued ANRJob for a gap and publishes the anr.request event a
// vision worker fulfils. The partial-unique index (queued|running) makes a
// duplicate open for the SAME window a no-op — OpenJob returns the existing job's
// id (0 + nil when it was deduped and we couldn't fetch it, which is harmless).
func (e *Engine) OpenJob(ctx context.Context, tenant, cam, profile string, from, to time.Time, recPath string) (int64, error) {
	if profile == "" {
		profile = "main"
	}
	var id int64
	err := e.db.QueryRow(ctx, `
		INSERT INTO anr_jobs (tenant_id, camera_id, profile, gap_from, gap_to, status)
		VALUES ($1,$2,$3,$4,$5,'queued')
		ON CONFLICT (tenant_id, camera_id, profile, gap_from, gap_to)
		WHERE status IN ('queued','running') DO NOTHING
		RETURNING id`,
		tenant, cam, profile, from, to).Scan(&id)
	if err == pgx.ErrNoRows {
		// A job for this window is already queued/running — dedupe, nothing to do.
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("open anr job: %w", err)
	}

	// Move to running as we dispatch (the fulfiller streams; there's no waiting
	// state to model on the nvr side beyond queued→running).
	if _, err := e.db.Exec(ctx,
		`UPDATE anr_jobs SET status='running', updated_at=now() WHERE id=$1`, id); err != nil {
		log.Printf("anr: mark job %d running: %v", id, err)
	}

	// Publish the backfill request for a vision worker (it has the device creds +
	// drivers). Graceful: a no-op bus (NATS disabled) leaves the job running —
	// visible + retriable — rather than failing hard.
	tid := tenant
	subj := events.Subject(&tid, "vms", "anr.request")
	payload := map[string]any{
		"job_id":      id,
		"camera_id":   cam,
		"profile":     profile,
		"gap_from":    from.UTC().Format(time.RFC3339Nano),
		"gap_to":      to.UTC().Format(time.RFC3339Nano),
		"record_path": recPath,
	}
	if err := e.bus.Publish(subj, payload); err != nil {
		log.Printf("anr: publish request for job %d: %v", id, err)
	}
	log.Printf("ANR job %d opened: camera=%s gap=%s→%s (%.0fs) — request published",
		id, cam, from.Format(time.RFC3339), to.Format(time.RFC3339), to.Sub(from).Seconds())
	return id, nil
}

// CloseJob finalizes a job from a vision anr.result: status done|failed, the count
// of segments the fulfiller backfilled, and an optional error. Idempotent.
func (e *Engine) CloseJob(ctx context.Context, jobID int64, status string, backfilled int, errMsg string) error {
	if status != "done" && status != "failed" {
		status = "failed"
	}
	_, err := e.db.Exec(ctx, `
		UPDATE anr_jobs
		SET status=$2, backfilled_segments=$3, error=NULLIF($4,''), completed_at=now(), updated_at=now()
		WHERE id=$1`,
		jobID, status, backfilled, errMsg)
	if err != nil {
		return fmt.Errorf("close anr job %d: %w", jobID, err)
	}
	log.Printf("ANR job %d closed: status=%s backfilled=%d", jobID, status, backfilled)
	return nil
}

// HandleResult is the anr.result NATS handler (wired at startup): it reads the
// vision fulfiller's result envelope and closes the job. Matches the Handler
// signature of the bus.Subscribe API.
func (e *Engine) HandleResult(ctx context.Context, env events.Envelope) error {
	p := env.Payload
	jobID := asInt64(p["job_id"])
	if jobID == 0 {
		return nil // not our event / malformed — ignore
	}
	status, _ := p["status"].(string)
	backfilled := int(asInt64(p["backfilled_segments"]))
	errMsg, _ := p["error"].(string)
	return e.CloseJob(ctx, jobID, status, backfilled, errMsg)
}

// ListJobs returns recent ANR jobs for a tenant (newest first), optionally
// filtered to a camera. limit bounds the result (default 50).
func (e *Engine) ListJobs(ctx context.Context, tenant, camera string, limit int) ([]Job, error) {
	if limit <= 0 || limit > 500 {
		limit = 50
	}
	q := `SELECT id, tenant_id, camera_id, profile, gap_from, gap_to, status,
	             backfilled_segments, coalesce(error,''), created_at, completed_at
	      FROM anr_jobs WHERE tenant_id=$1`
	args := []any{tenant}
	if camera != "" {
		q += ` AND camera_id=$2`
		args = append(args, camera)
	}
	q += fmt.Sprintf(` ORDER BY created_at DESC LIMIT %d`, limit)

	rows, err := e.db.Query(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list anr jobs: %w", err)
	}
	defer rows.Close()
	out := []Job{}
	for rows.Next() {
		var j Job
		var completed *time.Time
		if err := rows.Scan(&j.ID, &j.TenantID, &j.CameraID, &j.Profile, &j.GapFrom, &j.GapTo,
			&j.Status, &j.BackfilledSegments, &j.Error, &j.CreatedAt, &completed); err != nil {
			return nil, err
		}
		j.CompletedAt = completed
		out = append(out, j)
	}
	return out, rows.Err()
}

// recordPathFor returns the active recording target's record_path for a camera
// (the layout the fulfiller writes pulled segments under). Empty when the camera
// has no active target — the fulfiller then uses its own default layout.
func (e *Engine) recordPathFor(ctx context.Context, tenant, cam, profile string) string {
	var recPath string
	_ = e.db.QueryRow(ctx,
		`SELECT record_path FROM recording_targets
		 WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3 AND active = true`,
		tenant, cam, profile).Scan(&recPath)
	return recPath
}

// asInt64 coerces a JSON number (float64 from encoding/json, or an int/int64) to
// int64 — NATS payloads round-trip numbers as float64.
func asInt64(v any) int64 {
	switch n := v.(type) {
	case float64:
		return int64(n)
	case int64:
		return n
	case int:
		return int64(n)
	case json.Number:
		i, _ := n.Int64()
		return i
	default:
		return 0
	}
}
