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
//   - file mtimes and emits the NATS event ONCE (deduped via recording_segments).
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
	db   *pgxpool.Pool
	mtx  *mediamtx.Client
	sup  *supervisor.Supervisor
	bus  Publisher
	src  string // service name / event source
	dir  string // mounted recordings dir (nvr side of the volume)
	segT string // MediaMTX record segment duration (e.g. "60s")
	tick time.Duration

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
	// Day-foldered: segments land under a per-day subdir (%Y-%m-%d/) with a time-only
	// filename. This keeps each directory to ONE day of files (~1440 segments) instead
	// of an unbounded flat dir that grows to tens of thousands over the retention window
	// — far cheaper to list/scan for playback + retrieval, and human-navigable on disk.
	return strings.TrimRight(dir, "/") + "/%path/%Y-%m-%d/%H-%M-%S-%f"
}

// Active is the caller-facing view of one recording target.
type Active struct {
	CameraID    string `json:"camera_id"`
	Profile     string `json:"profile"`
	Node        string `json:"node"`
	PathName    string `json:"path_name"`
	TriggerType string `json:"trigger_type"`
	Recording   bool   `json:"recording"`
	// Redundant + SecondaryNode surface failover recording (P6-A): when Redundant
	// is set, record is driven on BOTH Node (primary) and SecondaryNode. An empty
	// SecondaryNode with Redundant=true means no second node was available yet
	// (single-node dev) — the reconcile tick re-attempts the secondary on node join.
	Redundant     bool   `json:"redundant"`
	SecondaryNode string `json:"secondary_node,omitempty"`
}

// StartRecording turns recording ON for (tenant, camera, profile): it ensures the
// MediaMTX live path exists (via the stream-supervisor), flips record on, and
// upserts the desired-state row. Idempotent. rtspURL is required to (re)provision
// the path; trigger defaults to "continuous".
//
// Graceful: a down MediaMTX / bad RTSP returns an error the handler maps to a 502
// — never a crash.
func (s *Supervisor) StartRecording(ctx context.Context, tenantID, cameraID, profile, rtspURL, trigger string, redundant bool, recordDir string) (Active, error) {
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
	// Per-camera storage: record into the camera's assigned pool dir when provided
	// (enterprise VMS — spread cameras across RAID virtual drives), else the default
	// recordings volume. The chosen dir is baked into record_path so the tracker +
	// playback + reconcile all resolve segments from the same place.
	dir := s.dir
	if strings.TrimSpace(recordDir) != "" {
		dir = recordDir
	}
	recPath := recordPathTemplate(dir)
	if err := s.mtx.SetRecord(ctx, node, name, true, mediamtx.RecordOpts{
		RecordPath:      recPath,
		SegmentDuration: s.segT,
	}); err != nil {
		return Active{}, fmt.Errorf("enable record: %w", err)
	}

	// Redundant / failover recording (P6-A): also drive record on a SECONDARY
	// node so a single node loss does not lose footage. The secondary records the
	// SAME path (cameras/<tenant>/<cam>/<profile>) on its own MediaMTX + its own
	// recordings mount; on primary-node loss the rebalance repoints live to it and
	// its copy already covers the outage. Best-effort: no second node yet (single-
	// node dev) leaves secondaryID empty and the reconcile re-attempts on node join.
	var secondaryID string
	if redundant {
		if sec, ok := s.sup.SecondaryNode(ctx, node.ID); ok {
			if err := s.mtx.EnsurePath(ctx, sec, name, rtspURL, nil); err != nil {
				log.Printf("redundant: ensure secondary path %s on %s: %v", name, sec.ID, err)
			} else if err := s.mtx.SetRecord(ctx, sec, name, true, mediamtx.RecordOpts{
				RecordPath:      recPath,
				SegmentDuration: s.segT,
			}); err != nil {
				log.Printf("redundant: enable secondary record %s on %s: %v", name, sec.ID, err)
			} else {
				secondaryID = sec.ID
				log.Printf("redundant recording: %s primary=%s secondary=%s", name, node.ID, sec.ID)
			}
		} else {
			log.Printf("redundant recording requested for %s but no secondary node available — single copy for now", name)
		}
		// Mark the shard redundant too so live-failover intent travels with it.
		if _, err := s.db.Exec(ctx,
			`UPDATE stream_shards SET redundant = true WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
			tenantID, cameraID, profile); err != nil {
			log.Printf("redundant: flag shard %s: %v", name, err)
		}
	}

	// Pin the RTSP on the target so reconcile can self-heal a dropped path even
	// after the live stream_shard is torn down (DropStream). Keep an existing
	// non-empty value if this start passes a blank (don't clobber a good URL).
	if _, err := s.db.Exec(ctx, `
		INSERT INTO recording_targets
			(tenant_id, camera_id, profile, node_id, path_name, record_path, active, trigger_type, redundant, secondary_node_id, rtsp_url)
		VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10)
		ON CONFLICT (tenant_id, camera_id, profile) DO UPDATE SET
			node_id = EXCLUDED.node_id,
			path_name = EXCLUDED.path_name,
			record_path = EXCLUDED.record_path,
			active = true,
			trigger_type = EXCLUDED.trigger_type,
			redundant = EXCLUDED.redundant,
			secondary_node_id = EXCLUDED.secondary_node_id,
			rtsp_url = CASE WHEN EXCLUDED.rtsp_url <> '' THEN EXCLUDED.rtsp_url ELSE recording_targets.rtsp_url END,
			updated_at = now()`,
		tenantID, cameraID, profile, node.ID, name, recPath, trigger, redundant, nullStr(secondaryID), rtspURL); err != nil {
		return Active{}, fmt.Errorf("persist recording target: %w", err)
	}
	log.Printf("recording started: %s (node=%s, trigger=%s, redundant=%v)", name, node.ID, trigger, redundant)
	_ = st // stream URLs unused here — recording only needs the path up
	return Active{
		CameraID: cameraID, Profile: profile, Node: node.ID,
		PathName: name, TriggerType: trigger, Recording: true,
		Redundant: redundant, SecondaryNode: secondaryID,
	}, nil
}

// RebindRecording implements supervisor.RecordRebinder: after a rebalance moved a
// camera's shard to a new node, re-assert record on that node so recording resumes
// without a control-plane round-trip. A no-op if the camera has no ACTIVE recording
// target. Best-effort — a down MediaMTX is logged, not fatal (satisfies the
// interface's graceful contract during a node-loss sweep).
func (s *Supervisor) RebindRecording(ctx context.Context, tenantID, cameraID, profile string) {
	if profile == "" {
		profile = "main"
	}
	var recPath string
	err := s.db.QueryRow(ctx,
		`SELECT record_path FROM recording_targets
		 WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3 AND active = true`,
		tenantID, cameraID, profile).Scan(&recPath)
	if err != nil {
		return // not recording (or no such target) — nothing to rebind
	}
	node, err := s.sup.Assign(ctx, tenantID, cameraID, profile)
	if err != nil {
		return
	}
	name := mediamtx.PathName(tenantID, cameraID, profile)
	if recPath == "" {
		recPath = recordPathTemplate(s.dir)
	}
	if err := s.mtx.SetRecord(ctx, node, name, true, mediamtx.RecordOpts{
		RecordPath:      recPath,
		SegmentDuration: s.segT,
	}); err != nil {
		log.Printf("rebind recording %s on %s: %v", name, node.ID, err)
		return
	}
	log.Printf("recording rebound after rebalance: %s → node %s", name, node.ID)
}

// nullStr converts an empty string to nil so a NULL is stored (rather than ”),
// keeping secondary_node_id honest for "no secondary yet".
func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
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
	// Event clips are short single-copy recordings — redundancy is for continuous
	// footage, not motion bursts, so redundant=false here.
	act, err := s.StartRecording(ctx, tenantID, cameraID, profile, rtspURL, trigger, false, "")
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
		`SELECT camera_id, profile, coalesce(node_id,''), path_name, trigger_type, active,
		        redundant, coalesce(secondary_node_id,'')
		 FROM recording_targets WHERE active = true ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list recording targets: %w", err)
	}
	defer rows.Close()
	out := []Active{}
	for rows.Next() {
		var a Active
		if err := rows.Scan(&a.CameraID, &a.Profile, &a.Node, &a.PathName, &a.TriggerType, &a.Recording,
			&a.Redundant, &a.SecondaryNode); err != nil {
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
		`SELECT tenant_id, camera_id, profile, coalesce(node_id,''), path_name, record_path,
		        redundant, coalesce(secondary_node_id,''), coalesce(rtsp_url,'')
		 FROM recording_targets WHERE active = true`)
	if err != nil {
		log.Printf("recording reconcile: list targets: %v", err)
		return
	}
	type tgt struct {
		tenant, cam, profile, node, name, recPath, secondary, rtsp string
		redundant                                                  bool
	}
	var targets []tgt
	for rows.Next() {
		var t tgt
		if err := rows.Scan(&t.tenant, &t.cam, &t.profile, &t.node, &t.name, &t.recPath,
			&t.redundant, &t.secondary, &t.rtsp); err == nil {
			targets = append(targets, t)
		}
	}
	rows.Close()

	for _, t := range targets {
		node, err := s.sup.Assign(ctx, t.tenant, t.cam, t.profile)
		if err != nil {
			continue // no node — try next tick
		}
		// Self-heal: if the MediaMTX path still EXISTS, just (re)assert record — a
		// no-op patch, cheap + no config churn. Only when the path is MISSING (dropped
		// by a live-viewer teardown that removed the shard, config reload, or a restart)
		// do we re-add it from a known RTSP first, else SetRecord 404s "path not found"
		// forever. Prefer the live shard's RTSP (freshest); fall back to the RTSP pinned
		// on the target, which survives shard/live teardown — without that fallback a
		// record-only camera whose shard was reaped could never recover (CH-51 bug).
		configured := false
		if ok, err := s.mtx.PathConfigured(ctx, node, t.name); err == nil {
			configured = ok
		}
		// (When the config check itself errors — node hiccup — we can't be sure, so
		// leave `configured=false` and attempt the ensure; EnsurePath is idempotent.)
		if !configured {
			rtsp := t.rtsp
			var shardRTSP string
			if err := s.db.QueryRow(ctx,
				`SELECT rtsp_url FROM stream_shards WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
				t.tenant, t.cam, t.profile).Scan(&shardRTSP); err == nil && shardRTSP != "" {
				rtsp = shardRTSP
			}
			if rtsp != "" {
				if err := s.mtx.EnsurePath(ctx, node, t.name, rtsp, nil); err != nil {
					log.Printf("recording reconcile ensure %s: %v", t.name, err)
				}
			}
		}
		// PATCH record on. MediaMTX ignores a no-op patch, so this is cheap + idempotent;
		// it re-establishes the record flag once the path exists.
		if err := s.mtx.SetRecord(ctx, node, t.name, true, mediamtx.RecordOpts{
			RecordPath:      t.recPath,
			SegmentDuration: s.segT,
		}); err != nil {
			log.Printf("recording reconcile %s: %v", t.name, err)
		}
		// Redundant targets: keep the secondary copy alive too. If a secondary was
		// never assigned (single-node dev when it started) OR the recorded node
		// changed after a rebalance, (re)pick + (re)drive one now.
		if t.redundant {
			s.reconcileSecondary(ctx, node.ID, t.tenant, t.cam, t.profile, t.name, t.recPath, t.secondary)
		}
	}
}

// reconcileSecondary keeps a redundant target's second copy healthy: it ensures a
// secondary node is chosen (least-loaded that is NOT the primary) and re-asserts
// record on it. Idempotent + best-effort. Persists a newly-chosen secondary so
// ListActive/rebalance can see it. Single-node dev (no secondary available) is a
// clean no-op that retries on the next node join.
func (s *Supervisor) reconcileSecondary(ctx context.Context, primaryID, tenant, cam, profile, name, recPath, current string) {
	sec, ok := s.sup.SecondaryNode(ctx, primaryID)
	if !ok {
		return // no second node yet
	}
	// Re-provision the secondary path from the shard's RTSP source (the secondary
	// pulls the SAME camera independently). A missing shard row → skip this tick.
	var rtsp string
	if err := s.db.QueryRow(ctx,
		`SELECT rtsp_url FROM stream_shards WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenant, cam, profile).Scan(&rtsp); err != nil || rtsp == "" {
		return
	}
	if err := s.mtx.EnsurePath(ctx, sec, name, rtsp, nil); err != nil {
		log.Printf("reconcile secondary ensure %s on %s: %v", name, sec.ID, err)
	}
	if err := s.mtx.SetRecord(ctx, sec, name, true, mediamtx.RecordOpts{
		RecordPath:      recPath,
		SegmentDuration: s.segT,
	}); err != nil {
		log.Printf("reconcile secondary record %s on %s: %v", name, sec.ID, err)
		return
	}
	if sec.ID != current {
		if _, err := s.db.Exec(ctx,
			`UPDATE recording_targets SET secondary_node_id=$1, updated_at=now()
			 WHERE tenant_id=$2 AND camera_id=$3 AND profile=$4`,
			sec.ID, tenant, cam, profile); err != nil {
			log.Printf("reconcile secondary persist %s: %v", name, err)
		}
	}
}

// trackSegments scans the recordings dir + emits a NATS segment event for each
// NEWLY-finalized fmp4 segment (deduped via recording_segments). A segment is
// finalized when a newer segment exists in the same path dir (MediaMTX rolled to
// the next one) OR its size has been stable since the last tick. Graceful: a
// missing dir / unreadable file is skipped.
func (s *Supervisor) trackSegments(ctx context.Context) {
	// Walk <root>/cameras/<tenant>/<cam>/<profile>/*.mp4. We use the on-disk tree
	// rather than the MediaMTX API as the source of truth for size/mtime (the API
	// only reports start), but a failed walk is non-fatal.
	//
	// Multi-pool: footage lives under the DEFAULT dir AND under any non-default
	// storage-pool root a camera records to (enterprise VMS spreads cameras across
	// RAID drives). A pool root may be OUTSIDE the default dir (e.g. a RAID mount
	// /mnt/raid3), so walking only s.dir would never index that pool's segments.
	// Collect every distinct root: the default dir + each active target's pool root
	// (the prefix of record_path before "/%path"). parsePath then locates the
	// `cameras/` marker at any depth, so nested-under-default pools also work.
	roots := s.segmentRoots(ctx)
	var entries []segFile
	for _, root := range roots {
		got, err := collectSegments(root)
		if err != nil {
			continue // root not present yet (no recording there) — normal
		}
		entries = append(entries, got...)
	}
	if len(entries) == 0 {
		return // nothing recorded yet — normal
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

// segmentRoots returns every on-disk root the segment tracker must scan: the
// default recordings dir plus each distinct pool root a currently-active recording
// target writes to. A pool root is the record_path prefix before the "/%path"
// template marker (e.g. record_path "/recordings/poolB/%path/%Y-..." → root
// "/recordings/poolB"). This makes indexing pool-agnostic even when a pool is a
// separate mount outside the default dir. Graceful: a DB error falls back to just
// the default dir (default-pool footage still indexes).
func (s *Supervisor) segmentRoots(ctx context.Context) []string {
	seen := map[string]bool{s.dir: true}
	roots := []string{s.dir}
	rows, err := s.db.Query(ctx,
		`SELECT DISTINCT record_path FROM recording_targets WHERE active = true`)
	if err != nil {
		return roots
	}
	defer rows.Close()
	for rows.Next() {
		var rp string
		if err := rows.Scan(&rp); err != nil {
			continue
		}
		root := recordRootOf(rp)
		if root == "" || seen[root] {
			continue
		}
		seen[root] = true
		roots = append(roots, root)
	}
	return roots
}

// recordRootOf extracts the on-disk pool root from a MediaMTX record_path template
// by taking everything before the "/%path" marker (the recordPathTemplate always
// inserts "/%path" right after the pool dir). Returns "" if the marker is absent.
func recordRootOf(recordPath string) string {
	i := strings.Index(recordPath, "/%path")
	if i < 0 {
		return ""
	}
	return recordPath[:i]
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

// dayFolderCutoff is the oldest day-folder date (YYYY-MM-DD, UTC) the segment
// tracker still scans. Older day-folders are already indexed and are pruned from
// the walk — see collectSegments. Kept as a small margin (3 days) so a date
// rollover or a late-finalizing segment near the boundary is never missed.
func dayFolderCutoff(now time.Time) string {
	return now.UTC().AddDate(0, 0, -2).Format("2006-01-02")
}

// staleDayFolder reports whether dir name is a day-folder (exactly "YYYY-MM-DD")
// strictly older than cutoff. Non-date dirs (…/cameras/<t>/<c>/<profile>) are never
// stale — the walk must descend through them to reach the day-folders.
func staleDayFolder(name, cutoff string) bool {
	if len(name) != 10 || name[4] != '-' || name[7] != '-' {
		return false
	}
	for i := 0; i < 10; i++ {
		if i == 4 || i == 7 {
			continue
		}
		if name[i] < '0' || name[i] > '9' {
			return false
		}
	}
	return name < cutoff
}

// collectSegments walks the recordings tree and returns every *.mp4 segment. A
// non-existent root returns an error the caller treats as "no recordings yet".
//
// Scale: day-folders older than the cutoff are PRUNED from the walk (SkipDir).
// Without this the tracker re-stats the ENTIRE retention history every tick — tens
// of thousands of files on slow drvfs — which stalls indexing (new segments never
// get indexed in time → the dashboard shows recording as idle). Old day-folders are
// already indexed, so skipping them is safe; the flat-file fallback is unaffected
// (a flat segment is not inside a YYYY-MM-DD dir).
func collectSegments(root string) ([]segFile, error) {
	if _, err := os.Stat(root); err != nil {
		return nil, err
	}
	cutoff := dayFolderCutoff(time.Now())
	var out []segFile
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil //nolint:nilerr // skip unreadable entries, keep walking
		}
		if d.IsDir() {
			if staleDayFolder(d.Name(), cutoff) {
				return filepath.SkipDir
			}
			return nil
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
			start: parseSegmentStart(p),
		})
		return nil
	})
	return out, nil
}

// parseSegmentStart derives a segment's start time from its PATH. Two on-disk layouts
// are supported so the switch to day-folders doesn't orphan older footage:
//   - day-foldered (current): …/<YYYY-MM-DD>/<HH-MM-SS-ffffff>.mp4 — date from the
//     parent directory, time from the filename.
//   - flat (legacy): …/<YYYY-MM-DD_HH-MM-SS-ffffff>.mp4 — full stamp in the filename.
// Falls back to zero on any parse failure (emitSegment then uses the mtime boundary).
func parseSegmentStart(p string) time.Time {
	base := strings.TrimSuffix(filepath.Base(p), filepath.Ext(p))
	// Legacy flat filename already carries the full "<date>_<time>" stamp.
	if t, ok := parseStamp(base); ok {
		return t
	}
	// Day-foldered: prepend the parent dir's date (YYYY-MM-DD) to the time-only name.
	if t, ok := parseStamp(filepath.Base(filepath.Dir(p)) + "_" + base); ok {
		return t
	}
	return time.Time{}
}

// parseStamp parses a "2006-01-02_15-04-05[-ffffff]" stamp (MediaMTX separates the
// microseconds with '-', not the '.' Go's fractional layout expects, so the micros
// are parsed by hand). ok=false when the string is not such a stamp.
func parseStamp(s string) (time.Time, bool) {
	// Fast path: no microseconds (…_15-04-05).
	if t, err := time.Parse("2006-01-02_15-04-05", s); err == nil {
		return t.UTC(), true
	}
	// With microseconds: split on the LAST '-' → "<date_...-05>" + "<micros>".
	i := strings.LastIndex(s, "-")
	if i <= 0 {
		return time.Time{}, false
	}
	head, frac := s[:i], s[i+1:]
	t, err := time.Parse("2006-01-02_15-04-05", head)
	if err != nil {
		return time.Time{}, false
	}
	// frac is microseconds (up to 6 digits); pad/truncate to nanoseconds.
	if len(frac) > 6 {
		frac = frac[:6]
	}
	var micros int
	for _, r := range frac {
		if r < '0' || r > '9' {
			return t.UTC(), true // non-numeric frac → drop sub-second precision
		}
		micros = micros*10 + int(r-'0')
	}
	for k := len(frac); k < 6; k++ {
		micros *= 10
	}
	return t.Add(time.Duration(micros) * time.Microsecond).UTC(), true
}

// parsePath derives (tenant, camera, profile) from a segment file path laid out as
// <root>/cameras/<tenant>/<camera>/<profile>/<segment>.mp4 (the recordPath
// template). Returns ok=false if the layout does not match.
//
// Multi-pool: <root> is NOT necessarily the default recordings dir — a camera on a
// non-default storage pool records under <pool_path>/cameras/... (e.g.
// /recordings/poolB/cameras/... or a RAID mount /mnt/raid3/cameras/...). The scan
// walks the default dir recursively (pool dirs nested under it in dev) AND any extra
// pool roots, so a segment's `cameras/` marker may appear at any depth. Rather than
// assume it sits immediately after `dir`, LOCATE the `cameras/` segment anywhere in
// the path and read the four components after it. This makes indexing pool-agnostic
// (the prior `parts[0]=="cameras"` check silently dropped every non-default-pool
// segment → its recordings were never indexed → playback 404'd).
func parsePath(p, dir string) (tenant, camera, profile string, ok bool) {
	rel := strings.TrimPrefix(p, strings.TrimRight(dir, "/")+"/")
	parts := strings.Split(rel, "/")
	// Find the "cameras" marker; the four fields after it are tenant/cam/profile/seg.
	for i, seg := range parts {
		if seg == "cameras" && len(parts)-i >= 5 {
			return parts[i+1], parts[i+2], parts[i+3], true
		}
	}
	return "", "", "", false
}
