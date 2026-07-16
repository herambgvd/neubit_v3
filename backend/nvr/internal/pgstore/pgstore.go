// Package pgstore is the Postgres backend of the nvr Store seam — the default,
// central-mode persistence path. It wraps the existing *pgxpool.Pool (this
// service's own neubit_nvr database) and ports the ENGINE-facing SQL the
// streams/recording/anr/supervisor engines run today, so those engines can talk
// to a store.Store instead of the raw pool without any change in behaviour.
//
// Scope: pgstore implements ONLY the engine subset of store.Store by hand (the
// queries that exist today against Postgres). The node/SQLite-only ESTATE surface
// (cameras/media_profiles/nvrs/storage_pools/tier_rules/raid/ptz/local_users/
// local_sessions/node_identity CRUD) is never used in central/Postgres mode; those
// methods are satisfied by the embedded estateUnimplemented struct, which returns a
// clear error if ever called. This keeps the interface additive (main.go can pick a
// backend) while pgstore stays a thin, faithful wrapper of today's SQL.
package pgstore

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/neubit/nvr/internal/store"
)

// PgStore wraps the pool and satisfies store.Store: the engine methods are
// hand-written (today's SQL), the estate methods come from estateUnimplemented.
type PgStore struct {
	estateUnimplemented
	pool *pgxpool.Pool
}

// Compile-time proof that PgStore satisfies the full seam.
var _ store.Store = (*PgStore)(nil)

// New wraps an existing pool as a store.Store. The pool's lifecycle stays with
// the caller (main.go closes it); Close is a no-op here so the seam does not
// double-close a pool that other code (playback, whoami) still shares in P2.
func New(pool *pgxpool.Pool) *PgStore {
	return &PgStore{pool: pool}
}

// Pool exposes the underlying pool for the transitional call sites that have not
// yet been moved behind the seam (bespoke, test-locked SQL such as ANR's
// partial-unique dedupe and the supervisor's load-count queries). It lets an
// engine hold ONE store.Store dependency yet still run its remaining raw queries.
func (s *PgStore) Pool() *pgxpool.Pool { return s.pool }

// Migrate is a no-op for pgstore: the Postgres schema is created by the embedded
// SQL migrations run in main.go (db.Migrate) before the store is constructed, so
// there is nothing for the seam to do. Present to satisfy store.Store.
func (s *PgStore) Migrate(ctx context.Context) error { return nil }

// Close is a no-op — main.go owns the pool and closes it via defer pool.Close().
func (s *PgStore) Close() error { return nil }

// ── stream shards + media nodes (spec §4.11) — ports supervisor.go SQL ─────────

// UpsertStreamShard persists a shard (idempotent upsert on tenant/camera/profile).
// Ported verbatim from supervisor.EnsureStream's INSERT … ON CONFLICT.
func (s *PgStore) UpsertStreamShard(ctx context.Context, sh store.StreamShard) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO stream_shards (tenant_id, camera_id, profile, node_id, path_name, rtsp_url)
		VALUES ($1, $2, $3, $4, $5, $6)
		ON CONFLICT (tenant_id, camera_id, profile) DO UPDATE SET
			node_id = EXCLUDED.node_id,
			path_name = EXCLUDED.path_name,
			rtsp_url = EXCLUDED.rtsp_url,
			updated_at = now()`,
		sh.TenantID, sh.CameraID, sh.Profile, sh.NodeID, sh.PathName, sh.RTSPURL)
	if err != nil {
		return fmt.Errorf("persist shard: %w", err)
	}
	return nil
}

// DeleteStreamShard removes a shard (idempotent). Ported from supervisor.DropStream.
func (s *PgStore) DeleteStreamShard(ctx context.Context, tenantID, cameraID, profile string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM stream_shards WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile)
	if err != nil {
		return fmt.Errorf("drop shard: %w", err)
	}
	return nil
}

// ListStreamShards returns every shard ordered by created_at. Ported from
// supervisor.ListStreams' shard query (extended to the full column set so the
// returned struct is complete; the engine reads the fields it needs).
func (s *PgStore) ListStreamShards(ctx context.Context) ([]store.StreamShard, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, camera_id, profile, node_id, path_name, rtsp_url,
		       redundant, created_at, updated_at
		FROM stream_shards ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("list shards: %w", err)
	}
	defer rows.Close()
	var out []store.StreamShard
	for rows.Next() {
		var sh store.StreamShard
		if err := rows.Scan(&sh.ID, &sh.TenantID, &sh.CameraID, &sh.Profile, &sh.NodeID,
			&sh.PathName, &sh.RTSPURL, &sh.Redundant, &sh.CreatedAt, &sh.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, sh)
	}
	return out, rows.Err()
}

// UpsertMediaNode registers/refreshes a media node. Ported verbatim from
// supervisor.EnsureNode (now()-stamped heartbeats + dead_since cleared on upsert).
func (s *PgStore) UpsertMediaNode(ctx context.Context, n store.MediaNode) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO media_nodes (id, api_url, hls_base, webrtc_base, rtsp_base, healthy, last_seen_at, last_heartbeat)
		VALUES ($1, $2, $3, $4, $5, true, now(), now())
		ON CONFLICT (id) DO UPDATE SET
			api_url = EXCLUDED.api_url,
			hls_base = EXCLUDED.hls_base,
			webrtc_base = EXCLUDED.webrtc_base,
			rtsp_base = EXCLUDED.rtsp_base,
			healthy = true,
			last_seen_at = now(),
			last_heartbeat = now(),
			dead_since = NULL`,
		n.ID, n.APIURL, n.HLSBase, n.WebRTCBase, n.RTSPBase)
	if err != nil {
		return fmt.Errorf("register media node %q: %w", n.ID, err)
	}
	return nil
}

// GetMediaNode returns a node by id (store.ErrNotFound when absent).
func (s *PgStore) GetMediaNode(ctx context.Context, id string) (store.MediaNode, error) {
	var n store.MediaNode
	err := s.pool.QueryRow(ctx, `
		SELECT id, api_url, hls_base, webrtc_base, rtsp_base, healthy, last_seen_at,
		       last_heartbeat, dead_since, created_at
		FROM media_nodes WHERE id=$1`, id).Scan(
		&n.ID, &n.APIURL, &n.HLSBase, &n.WebRTCBase, &n.RTSPBase, &n.Healthy,
		&n.LastSeenAt, &n.LastHeartbeat, &n.DeadSince, &n.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.MediaNode{}, store.ErrNotFound
	}
	if err != nil {
		return store.MediaNode{}, err
	}
	return n, nil
}

// ── recording targets + segments (spec §4.5/§4.6) — ports recording.go SQL ─────

// ListRecordingTargets returns every recording target (full column set). Callers
// filter (active, trigger_type, DISTINCT record_path) in Go — the same rows the
// engines' inline `WHERE active=true` / `trigger_type='continuous'` queries
// returned, just selected once and narrowed by the caller.
func (s *PgStore) ListRecordingTargets(ctx context.Context) ([]store.RecordingTarget, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT id, tenant_id, camera_id, profile, node_id, path_name, record_path,
		       active, trigger_type, redundant, secondary_node_id, created_at, updated_at
		FROM recording_targets`)
	if err != nil {
		return nil, fmt.Errorf("list recording targets: %w", err)
	}
	defer rows.Close()
	var out []store.RecordingTarget
	for rows.Next() {
		var t store.RecordingTarget
		if err := rows.Scan(&t.ID, &t.TenantID, &t.CameraID, &t.Profile, &t.NodeID,
			&t.PathName, &t.RecordPath, &t.Active, &t.TriggerType, &t.Redundant,
			&t.SecondaryNodeID, &t.CreatedAt, &t.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// UpsertRecordingTarget persists desired recording state (idempotent upsert).
// Ported from recording.StartRecording's INSERT … ON CONFLICT.
func (s *PgStore) UpsertRecordingTarget(ctx context.Context, t store.RecordingTarget) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO recording_targets
			(tenant_id, camera_id, profile, node_id, path_name, record_path, active, trigger_type, redundant, secondary_node_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
		ON CONFLICT (tenant_id, camera_id, profile) DO UPDATE SET
			node_id = EXCLUDED.node_id,
			path_name = EXCLUDED.path_name,
			record_path = EXCLUDED.record_path,
			active = EXCLUDED.active,
			trigger_type = EXCLUDED.trigger_type,
			redundant = EXCLUDED.redundant,
			secondary_node_id = EXCLUDED.secondary_node_id,
			updated_at = now()`,
		t.TenantID, t.CameraID, t.Profile, t.NodeID, t.PathName, t.RecordPath,
		t.Active, t.TriggerType, t.Redundant, t.SecondaryNodeID)
	if err != nil {
		return fmt.Errorf("persist recording target: %w", err)
	}
	return nil
}

// DeleteRecordingTarget removes a recording target (idempotent).
func (s *PgStore) DeleteRecordingTarget(ctx context.Context, tenantID, cameraID, profile string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM recording_targets WHERE tenant_id=$1 AND camera_id=$2 AND profile=$3`,
		tenantID, cameraID, profile)
	if err != nil {
		return fmt.Errorf("delete recording target: %w", err)
	}
	return nil
}

// UpsertRecordingSegment claims a segment path (emit-once ledger): reports whether
// the row was NEWLY inserted via ON CONFLICT(path) DO NOTHING + RowsAffected.
// Ported verbatim from recording.emitSegment's dedupe insert.
func (s *PgStore) UpsertRecordingSegment(ctx context.Context, seg store.RecordingSegment) (bool, error) {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO recording_segments (path, tenant_id, camera_id, profile, started_at)
		VALUES ($1,$2,$3,$4,$5)
		ON CONFLICT (path) DO NOTHING`,
		seg.Path, seg.TenantID, seg.CameraID, seg.Profile, seg.StartedAt)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ListSegments returns a camera's segments in a time window (by started_at). Not
// yet wired to an engine in Postgres mode (playback reads its own model) — present
// for the seam; selects the full segment row.
func (s *PgStore) ListSegments(ctx context.Context, f store.SegmentFilter) ([]store.RecordingSegment, error) {
	q := `SELECT path, tenant_id, camera_id, profile, started_at, ended_at, duration, file_size,
	             codec, resolution, trigger_type, storage_pool_id, checksum, integrity_status,
	             locked, locked_by, locked_at, has_motion, event_markers, emitted, emitted_at
	      FROM recording_segments WHERE camera_id=$1`
	args := []any{f.CameraID}
	if f.Profile != "" {
		q += fmt.Sprintf(" AND profile=$%d", len(args)+1)
		args = append(args, f.Profile)
	}
	if f.From != nil {
		q += fmt.Sprintf(" AND started_at >= $%d", len(args)+1)
		args = append(args, *f.From)
	}
	if f.To != nil {
		q += fmt.Sprintf(" AND started_at <= $%d", len(args)+1)
		args = append(args, *f.To)
	}
	q += " ORDER BY started_at"
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.RecordingSegment
	for rows.Next() {
		var seg store.RecordingSegment
		if err := rows.Scan(&seg.Path, &seg.TenantID, &seg.CameraID, &seg.Profile, &seg.StartedAt,
			&seg.EndedAt, &seg.Duration, &seg.FileSize, &seg.Codec, &seg.Resolution, &seg.TriggerType,
			&seg.StoragePoolID, &seg.Checksum, &seg.IntegrityStatus, &seg.Locked, &seg.LockedBy,
			&seg.LockedAt, &seg.HasMotion, &seg.EventMarkers, &seg.Emitted, &seg.EmittedAt); err != nil {
			return nil, err
		}
		out = append(out, seg)
	}
	return out, rows.Err()
}

// LockSegment marks a segment retention-exempt (evidence lock).
func (s *PgStore) LockSegment(ctx context.Context, path, lockedBy string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE recording_segments SET locked=true, locked_by=$2, locked_at=now() WHERE path=$1`,
		path, lockedBy)
	return err
}

// UnlockSegment clears an evidence lock.
func (s *PgStore) UnlockSegment(ctx context.Context, path string) error {
	_, err := s.pool.Exec(ctx,
		`UPDATE recording_segments SET locked=false, locked_by=NULL, locked_at=NULL WHERE path=$1`,
		path)
	return err
}

// ── anr jobs (spec §4.12) — ports anr.go SQL ───────────────────────────────────

// CreateAnrJob queues a backfill job, returning its assigned id. Mirrors the
// sqlitestore contract (plain insert); ANR's own OpenJob keeps its partial-unique
// dedupe insert on the pool (Pool()) since that SQL is test-locked.
func (s *PgStore) CreateAnrJob(ctx context.Context, j store.AnrJob) (int64, error) {
	status := j.Status
	if status == "" {
		status = "queued"
	}
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO anr_jobs (tenant_id, camera_id, profile, gap_from, gap_to, status, backfilled_segments, error, completed_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,NULLIF($8,''),$9)
		RETURNING id`,
		j.TenantID, j.CameraID, j.Profile, j.GapFrom, j.GapTo, status, j.BackfilledSegments,
		derefStr(j.Error), j.CompletedAt).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id, nil
}

// UpdateAnrJob writes progress/terminal state for a job.
func (s *PgStore) UpdateAnrJob(ctx context.Context, j store.AnrJob) error {
	tag, err := s.pool.Exec(ctx, `
		UPDATE anr_jobs SET status=$2, backfilled_segments=$3, error=$4, updated_at=now(), completed_at=$5 WHERE id=$1`,
		j.ID, j.Status, j.BackfilledSegments, j.Error, j.CompletedAt)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return store.ErrNotFound
	}
	return nil
}

const anrCols = `id, tenant_id, camera_id, profile, gap_from, gap_to, status, backfilled_segments, error, created_at, updated_at, completed_at`

// ListAnrJobs returns a camera's jobs, newest first (full struct).
func (s *PgStore) ListAnrJobs(ctx context.Context, cameraID string) ([]store.AnrJob, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+anrCols+` FROM anr_jobs WHERE camera_id=$1 ORDER BY created_at DESC`, cameraID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.AnrJob
	for rows.Next() {
		j, err := scanAnrJob(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, j)
	}
	return out, rows.Err()
}

// ClaimAnrJob atomically transitions the oldest queued job to running and returns
// it, or store.ErrNotFound when the queue is empty.
func (s *PgStore) ClaimAnrJob(ctx context.Context) (store.AnrJob, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return store.AnrJob{}, err
	}
	defer tx.Rollback(ctx)

	var id int64
	err = tx.QueryRow(ctx,
		`SELECT id FROM anr_jobs WHERE status='queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return store.AnrJob{}, store.ErrNotFound
	}
	if err != nil {
		return store.AnrJob{}, err
	}
	if _, err := tx.Exec(ctx, `UPDATE anr_jobs SET status='running', updated_at=now() WHERE id=$1`, id); err != nil {
		return store.AnrJob{}, err
	}
	j, err := scanAnrJob(tx.QueryRow(ctx, `SELECT `+anrCols+` FROM anr_jobs WHERE id=$1`, id))
	if err != nil {
		return store.AnrJob{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return store.AnrJob{}, err
	}
	return j, nil
}

// scanAnrJob scans a full anr_jobs row into store.AnrJob (nullable error/completed_at).
func scanAnrJob(row interface{ Scan(...any) error }) (store.AnrJob, error) {
	var j store.AnrJob
	if err := row.Scan(&j.ID, &j.TenantID, &j.CameraID, &j.Profile, &j.GapFrom, &j.GapTo,
		&j.Status, &j.BackfilledSegments, &j.Error, &j.CreatedAt, &j.UpdatedAt, &j.CompletedAt); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.AnrJob{}, store.ErrNotFound
		}
		return store.AnrJob{}, err
	}
	return j, nil
}

// derefStr returns the pointed-to string (or "" for nil) — for the NULLIF idiom.
func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
