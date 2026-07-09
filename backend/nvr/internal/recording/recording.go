// Package recording is the nvr recording-supervisor: it owns the DESIRED
// recording state (which camera/profile records now) and reconciles it against
// MediaMTX's actual path record flag, drives MediaMTX native recording
// (record=yes on the path → fmp4 segments to a mounted `recordings` volume), and
// tracks finalized segments → emits a NATS `tenant.<id>.vms.recording.segment`
// event the Python `vision` control-plane consumes into Recording rows.
//
// Design (P3-A):
//   - DESIRED state lives in the nvr DB (recording_targets, migration 0003). The
//     control-plane (vision) drives it via POST /recording/{cam}/{profile}/start|
//     stop; the reconcile tick self-heals paths the nvr owns (re-asserts record on
//     a MediaMTX that restarted / lost the flag).
//   - Recording implies the live path exists — StartRecording ensures the MediaMTX
//     path (via the stream-supervisor) THEN flips record on. Continuous recording
//     also flips sourceOnDemand off (SetRecord) so the source stays connected with
//     no live viewer.
//   - The segment TRACKER polls MediaMTX /v3/recordings/list every tick and scans
//     the mounted recordings dir; when a segment file is finalized (a NEWER segment
//     for the same path exists, or the file has been size-stable across a tick) it
//     derives {camera, profile, start, end, size, duration} from the path template
//     + file mtimes and emits the NATS event ONCE (deduped via recording_segments).
//   - motion/event: StartEventClip is the entry point P5 fires (pre/post buffer) —
//     wired here but the actual trigger is a P5 event. It records a short window.
//
// Every method is graceful: a down camera / MediaMTX / missing recordings dir
// never crashes the supervisor or the service.
package recording

import (
	"context"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/neubit/gokernel/events"

	"github.com/neubit/nvr/internal/mediamtx"
	"github.com/neubit/nvr/internal/supervisor"
)

// Publisher is the subset of the NATS bus the tracker needs (Publish only) — an
// interface so tests can capture emitted segment events without a broker.
type Publisher interface {
	Publish(subj string, payload map[string]any) error
}

// Supervisor coordinates recording. Construct with New, then Start to run the
// reconcile + segment-tracker loop. It shares the stream-supervisor's node
// registry (to ensure the live path + resolve the node) and the MediaMTX client.
type Supervisor struct {
	db    *pgxpool.Pool
	mtx   *mediamtx.Client
	sup   *supervisor.Supervisor
	bus   Publisher
	src   string // service name / event source
	dir   string // mounted recordings dir (nvr side of the volume)
	segT  string // MediaMTX record segment duration (e.g. "60s")
	tick  time.Duration

	mu sync.Mutex
	// sizeSeen tracks (path→size) across ticks so a segment is treated as
	// finalized only once its size is stable (no longer being written).
	sizeSeen map[string]int64
}

// Config tunes the recording supervisor.
type Config struct {
	// Dir is the recordings directory as the nvr container sees it (the mounted
	// `recordings` volume). Default /recordings.
	Dir string
	// SegmentDuration is MediaMTX's recordSegmentDuration (default 60s).
	SegmentDuration string
	// Tick is the reconcile + segment-scan interval (default 15s).
	Tick time.Duration
}

// New builds a recording Supervisor.
func New(db *pgxpool.Pool, mtx *mediamtx.Client, sup *supervisor.Supervisor, bus Publisher, source string, cfg Config) *Supervisor {
	if cfg.Dir == "" {
		cfg.Dir = "/recordings"
	}
	if cfg.SegmentDuration == "" {
		cfg.SegmentDuration = "60s"
	}
	if cfg.Tick <= 0 {
		cfg.Tick = 15 * time.Second
	}
	return &Supervisor{
		db:       db,
		mtx:      mtx,
		sup:      sup,
		bus:      bus,
		src:      source,
		dir:      cfg.Dir,
		segT:     cfg.SegmentDuration,
		tick:     cfg.Tick,
		sizeSeen: map[string]int64{},
	}
}

// recordPathTemplate builds the MediaMTX recordPath for a path name. %path is the
// path name (cameras/<tenant>/<cam>/<profile>) → segments land under
// <dir>/cameras/<tenant>/<cam>/<profile>/<timestamp>. This lets the tracker derive
// tenant/camera/profile straight from the on-disk path.
func recordPathTemplate(dir string) string {
	return strings.TrimRight(dir, "/") + "/%path/%Y-%m-%d_%H-%M-%S-%f"
}

// Active is the caller-facing view of one recording target.
type Active struct {
	CameraID    string `json:"camera_id"`
	Profile     string `json:"profile"`
	Node        string `json:"node"`
	PathName    string `json:"path_name"`
	TriggerType string `json:"trigger_type"`
	Recording   bool   `json:"recording"`
}

// StartRecording turns recording ON for (tenant, camera, profile): it ensures the
// MediaMTX live path exists (via the stream-supervisor), flips record on, and
// upserts the desired-state row. Idempotent. rtspURL is required to (re)provision
// the path; trigger defaults to "continuous".
//
// Graceful: a down MediaMTX / bad RTSP returns an error the handler maps to a 502
// — never a crash.
func (s *Supervisor) StartRecording(ctx context.Context, tenantID, cameraID, profile, rtspURL, trigger string) (Active, error) {
	if profile == "" {
		profile = "main"
	}
	if trigger == "" {
		trigger = "continuous"
	}
	// Ensure the live path first (record needs a live source). Reuse the stream
	// supervisor so recording shares the same node/path as live.
	st, err := s.sup.EnsureStream(ctx, tenantID, cameraID, profile, rtspURL)
	if err != nil {
		return Active{}, fmt.Errorf("ensure live path for recording: %w", err)
	}
	name := mediamtx.PathName(tenantID, cameraID, profile)
	node, err := s.sup.Assign(ctx, tenantID, cameraID, profile)
	if err != nil {
		return Active{}, err
	}
	recPath := recordPathTemplate(s.dir)
	if err := s.mtx.SetRecord(ctx, node, name, true, mediamtx.RecordOpts{
		RecordPath:      recPath,
		SegmentDuration: s.segT,
	}); err != nil {
		return Active{}, fmt.Errorf("enable record: %w", err)
	}

	if _, err := s.db.Exec(ctx, `
		INSERT INTO recording_targets
			(tenant_id, camera_id, profile, node_id, path_name, record_path, active, trigger_type)
		VALUES ($1,$2,$3,$4,$5,$6,true,$7)
		ON CONFLICT (tenant_id, camera_id, profile) DO UPDATE SET
			node_id = EXCLUDED.node_id,
			path_name = EXCLUDED.path_name,
			record_path = EXCLUDED.record_path,
			active = true,
			trigger_type = EXCLUDED.trigger_type,
			updated_at = now()`,
		tenantID, cameraID, profile, node.ID, name, recPath, trigger); err != nil {
		return Active{}, fmt.Errorf("persist recording target: %w", err)
	}
	log.Printf("recording started: %s (node=%s, trigger=%s)", name, node.ID, trigger)
	_ = st // stream URLs unused here — recording only needs the path up
	return Active{
		CameraID: cameraID, Profile: profile, Node: node.ID,
		PathName: name, TriggerType: trigger, Recording: true,
	}, nil
}

// StopRecording turns recording OFF for (tenant, camera, profile): flips record
// off on MediaMTX (restoring sourceOnDemand) and marks the target inactive.
// Idempotent — a missing target / down node is not an error (best-effort).
func (s *Supervisor) StopRecording(ctx context.Context, tenantID, cameraID, profile string) error {
	if profile == "" {
		profile = "main"
	}
	name := mediamtx.PathName(tenantID, cameraID, profile)
	// Resolve the pinned node from the target (fall back to Assign).
	var nodeID string
	_ = s.db.QueryRow(ctx,
		`SELECT node_id FROM recording_targets WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile).Scan(&nodeID)
	node, err := s.sup.Assign(ctx, tenantID, cameraID, profile)
	if err == nil {
		if err := s.mtx.SetRecord(ctx, node, name, false, mediamtx.RecordOpts{}); err != nil {
			// Log but continue — a down node must not block the state update.
			log.Printf("stop recording %s: mediamtx note: %v", name, err)
		}
	}
	if _, err := s.db.Exec(ctx,
		`UPDATE recording_targets SET active=false, updated_at=now()
		 WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile); err != nil {
		return fmt.Errorf("mark recording target inactive: %w", err)
	}
	log.Printf("recording stopped: %s", name)
	return nil
}

// StartEventClip is the motion/event recording entry point (P5 fires it). It
// records a short window with a post buffer, then stops — for a pre-buffer, a
// production build keeps the source hot / MediaMTX's playback of already-buffered
// segments (P4). In P3-A this WIRES the seam: it starts recording (trigger tag
// "motion"/"event") and schedules a stop after (pre+post) seconds. The actual
// trigger + real pre-roll is P5.
//
// It is best-effort + non-blocking: the stop is scheduled on a goroutine so a
// caller (a NATS event handler) is not held.
func (s *Supervisor) StartEventClip(ctx context.Context, tenantID, cameraID, profile, rtspURL, trigger string, pre, post int) (Active, error) {
	if trigger == "" {
		trigger = "event"
	}
	act, err := s.StartRecording(ctx, tenantID, cameraID, profile, rtspURL, trigger)
	if err != nil {
		return Active{}, err
	}
	window := time.Duration(pre+post) * time.Second
	if window <= 0 {
		window = 30 * time.Second
	}
	go func() {
		timer := time.NewTimer(window)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			// A fresh short context — the parent request ctx is long gone by now.
			c, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			if err := s.StopRecording(c, tenantID, cameraID, profile); err != nil {
				log.Printf("event-clip auto-stop %s/%s: %v", cameraID, profile, err)
			}
		}
	}()
	return act, nil
}

// ListActive returns every active recording target (status endpoint).
func (s *Supervisor) ListActive(ctx context.Context) ([]Active, error) {
	rows, err := s.db.Query(ctx,
		`SELECT camera_id, profile, coalesce(node_id,''), path_name, trigger_type, active
		 FROM recording_targets WHERE active = true ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list recording targets: %w", err)
	}
	defer rows.Close()
	out := []Active{}
	for rows.Next() {
		var a Active
		if err := rows.Scan(&a.CameraID, &a.Profile, &a.Node, &a.PathName, &a.TriggerType, &a.Recording); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Start launches the reconcile + segment-tracker loop; stops when ctx is done.
func (s *Supervisor) Start(ctx context.Context) {
	go func() {
		t := time.NewTicker(s.tick)
		defer t.Stop()
		log.Printf("recording supervisor started (dir=%s, tick=%s, segment=%s)", s.dir, s.tick, s.segT)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.reconcile(ctx)
				s.trackSegments(ctx)
			}
		}
	}()
}

// reconcile re-asserts record=on for every active target whose MediaMTX path has
// lost the flag (self-heal after a MediaMTX restart). Desired state is the DB;
// actual state is the path config. Best-effort per target — one down node does
// not stop the sweep.
func (s *Supervisor) reconcile(ctx context.Context) {
	rows, err := s.db.Query(ctx,
		`SELECT tenant_id, camera_id, profile, coalesce(node_id,''), path_name, record_path
		 FROM recording_targets WHERE active = true`)
	if err != nil {
		log.Printf("recording reconcile: list targets: %v", err)
		return
	}
	type tgt struct{ tenant, cam, profile, node, name, recPath string }
	var targets []tgt
	for rows.Next() {
		var t tgt
		if err := rows.Scan(&t.tenant, &t.cam, &t.profile, &t.node, &t.name, &t.recPath); err == nil {
			targets = append(targets, t)
		}
	}
	rows.Close()

	for _, t := range targets {
		node, err := s.sup.Assign(ctx, t.tenant, t.cam, t.profile)
		if err != nil {
			continue // no node — try next tick
		}
		// Best-effort: PATCH record on. MediaMTX ignores a no-op patch, so this is
		// cheap + idempotent; it re-establishes the flag if MediaMTX dropped it.
		if err := s.mtx.SetRecord(ctx, node, t.name, true, mediamtx.RecordOpts{
			RecordPath:      t.recPath,
			SegmentDuration: s.segT,
		}); err != nil {
			log.Printf("recording reconcile %s: %v", t.name, err)
		}
	}
}

// trackSegments scans the recordings dir + emits a NATS segment event for each
// NEWLY-finalized fmp4 segment (deduped via recording_segments). A segment is
// finalized when a newer segment exists in the same path dir (MediaMTX rolled to
// the next one) OR its size has been stable since the last tick. Graceful: a
// missing dir / unreadable file is skipped.
func (s *Supervisor) trackSegments(ctx context.Context) {
	// Walk <dir>/cameras/<tenant>/<cam>/<profile>/*.mp4. We use the on-disk tree
	// rather than the MediaMTX API as the source of truth for size/mtime (the API
	// only reports start), but a failed walk is non-fatal.
	root := s.dir
	entries, err := collectSegments(root)
	if err != nil {
		return // dir not present yet (no recording has started) — normal
	}
	// Group by path dir so we can tell which is the newest (still-writing) segment.
	byDir := map[string][]segFile{}
	for _, f := range entries {
		byDir[f.dir] = append(byDir[f.dir], f)
	}
	now := time.Now()
	for _, files := range byDir {
		sort.Slice(files, func(i, j int) bool { return files[i].name < files[j].name })
		for i, f := range files {
			isNewest := i == len(files)-1
			finalized := false
			if !isNewest {
				finalized = true // a newer segment exists → this one is closed
			} else {
				// Newest: finalized only if its size is stable across a tick.
				s.mu.Lock()
				prev, seen := s.sizeSeen[f.path]
				s.sizeSeen[f.path] = f.size
				s.mu.Unlock()
				if seen && prev == f.size && f.size > 0 {
					finalized = true
				}
			}
			if !finalized {
				continue
			}
			s.emitSegment(ctx, f, files, i, now)
		}
	}
}

// emitSegment publishes ONE NATS segment event for a finalized segment, deduped
// by an insert into recording_segments (the PK on path makes the emit idempotent
// across ticks + restarts). end/duration are derived from the next segment's
// start (or the file mtime for the last segment).
func (s *Supervisor) emitSegment(ctx context.Context, f segFile, siblings []segFile, idx int, now time.Time) {
	tenant, cam, profile, ok := parsePath(f.path, s.dir)
	if !ok {
		return
	}
	// Dedupe: try to claim this path. If it already exists, we've emitted it.
	tag, err := s.db.Exec(ctx, `
		INSERT INTO recording_segments (path, tenant_id, camera_id, profile, started_at)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (path) DO NOTHING`,
		f.path, tenant, cam, profile, f.start)
	if err != nil {
		log.Printf("segment dedupe insert %s: %v", f.path, err)
		return
	}
	if tag.RowsAffected() == 0 {
		return // already emitted
	}

	// end = next sibling's start (this segment closed when the next opened); for
	// the last segment, use the file mtime.
	end := f.mtime
	if idx+1 < len(siblings) && !siblings[idx+1].start.IsZero() {
		end = siblings[idx+1].start
	}
	duration := end.Sub(f.start).Seconds()
	if duration < 0 {
		duration = 0
	}
	tid := tenant
	subj := events.Subject(&tid, "vms", "recording.segment")
	payload := map[string]any{
		"camera_id": cam,
		"profile":   profile,
		"path":      f.path,
		"start":     f.start.UTC().Format(time.RFC3339Nano),
		"end":       end.UTC().Format(time.RFC3339Nano),
		"size":      f.size,
		"duration":  duration,
		"format":    "fmp4",
	}
	if err := s.bus.Publish(subj, payload); err != nil {
		log.Printf("segment publish %s: %v", f.path, err)
		return
	}
	log.Printf("recording segment emitted: %s (%.0fs, %d bytes)", f.path, duration, f.size)
}

// segFile is one on-disk segment: absolute path, its dir, name, size, mtime, and
// the start time parsed from the MediaMTX filename template.
type segFile struct {
	path, dir, name string
	size            int64
	mtime           time.Time
	start           time.Time
}

// collectSegments walks the recordings tree and returns every *.mp4 segment. A
// non-existent root returns an error the caller treats as "no recordings yet".
func collectSegments(root string) ([]segFile, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	var out []segFile
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil //nolint:nilerr // skip unreadable entries, keep walking
		}
		if !strings.HasSuffix(p, ".mp4") {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		out = append(out, segFile{
			path:  p,
			dir:   filepath.Dir(p),
			name:  d.Name(),
			size:  info.Size(),
			mtime: info.ModTime(),
			start: parseSegmentStart(d.Name()),
		})
		return nil
	})
	return out, nil
}

// parseSegmentStart parses MediaMTX's %Y-%m-%d_%H-%M-%S-%f segment filename into a
// start time. MediaMTX separates the microseconds with a '-' (not the '.' Go's
// fractional layout expects), so the microsecond field is parsed by hand. Falls
// back to zero on any parse failure (emitSegment then uses the mtime boundary).
func parseSegmentStart(name string) time.Time {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	// Fast path: no microseconds (…_15-04-05).
	if t, err := time.Parse("2006-01-02_15-04-05", base); err == nil {
		return t.UTC()
	}
	// With microseconds: split on the LAST '-' → "<...-05>" + "<micros>".
	i := strings.LastIndex(base, "-")
	if i <= 0 {
		return time.Time{}
	}
	head, frac := base[:i], base[i+1:]
	t, err := time.Parse("2006-01-02_15-04-05", head)
	if err != nil {
		return time.Time{}
	}
	// frac is microseconds (up to 6 digits); pad/truncate to nanoseconds.
	if len(frac) > 6 {
		frac = frac[:6]
	}
	var micros int
	for _, r := range frac {
		if r < '0' || r > '9' {
			return t.UTC() // non-numeric frac → drop sub-second precision
		}
		micros = micros*10 + int(r-'0')
	}
	for k := len(frac); k < 6; k++ {
		micros *= 10
	}
	return t.Add(time.Duration(micros) * time.Microsecond).UTC()
}

// parsePath derives (tenant, camera, profile) from a segment file path laid out as
// <dir>/cameras/<tenant>/<camera>/<profile>/<segment>.mp4 (the recordPath
// template). Returns ok=false if the layout does not match.
func parsePath(p, dir string) (tenant, camera, profile string, ok bool) {
	rel := strings.TrimPrefix(p, strings.TrimRight(dir, "/")+"/")
	parts := strings.Split(rel, "/")
	// cameras / <tenant> / <camera> / <profile> / <segment>
	if len(parts) >= 5 && parts[0] == "cameras" {
		return parts[1], parts[2], parts[3], true
	}
	return "", "", "", false
}
