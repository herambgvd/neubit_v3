package sqlitestore

import (
	"context"
	"database/sql"

	"github.com/neubit/nvr/internal/store"
)

// Recording repo: recording_targets (spec §4.5, desired state the supervisor
// reconciles) + recording_segments (spec §4.6, emit-once ledger + local playback index).

// ── recording_targets ────────────────────────────────────────────────────────

const targetCols = `id, tenant_id, camera_id, profile, node_id, path_name, record_path,
	active, trigger_type, redundant, secondary_node_id, created_at, updated_at`

func scanTarget(row interface{ Scan(...any) error }) (store.RecordingTarget, error) {
	var (
		t                          store.RecordingTarget
		nodeID, secondaryNodeID    sql.NullString
		active, redundant          int
		createdAt, updatedAt       string
	)
	if err := row.Scan(&t.ID, &t.TenantID, &t.CameraID, &t.Profile, &nodeID, &t.PathName, &t.RecordPath,
		&active, &t.TriggerType, &redundant, &secondaryNodeID, &createdAt, &updatedAt); err != nil {
		return store.RecordingTarget{}, err
	}
	t.NodeID = strPtr(nodeID)
	t.Active = active == 1
	t.Redundant = redundant == 1
	t.SecondaryNodeID = strPtr(secondaryNodeID)
	t.CreatedAt = mustTime(createdAt)
	t.UpdatedAt = mustTime(updatedAt)
	return t, nil
}

// UpsertRecordingTarget writes desired recording state keyed by (tenant,camera,profile).
func (d *DB) UpsertRecordingTarget(ctx context.Context, t store.RecordingTarget) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO recording_targets (tenant_id, camera_id, profile, node_id, path_name, record_path,
			active, trigger_type, redundant, secondary_node_id, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(tenant_id, camera_id, profile) DO UPDATE SET
			node_id=excluded.node_id, path_name=excluded.path_name, record_path=excluded.record_path,
			active=excluded.active, trigger_type=excluded.trigger_type, redundant=excluded.redundant,
			secondary_node_id=excluded.secondary_node_id, updated_at=excluded.updated_at`,
		t.TenantID, t.CameraID, t.Profile, t.NodeID, t.PathName, t.RecordPath,
		b2i(t.Active), t.TriggerType, b2i(t.Redundant), t.SecondaryNodeID, rfc(t.CreatedAt), rfc(t.UpdatedAt),
	)
	return err
}

// ListRecordingTargets returns every target (the supervisor reconciles the full set).
func (d *DB) ListRecordingTargets(ctx context.Context) ([]store.RecordingTarget, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT `+targetCols+` FROM recording_targets`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.RecordingTarget
	for rows.Next() {
		t, err := scanTarget(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// DeleteRecordingTarget removes the target for a camera profile (no-op if absent).
func (d *DB) DeleteRecordingTarget(ctx context.Context, tenantID, cameraID, profile string) error {
	_, err := d.rw.ExecContext(ctx,
		`DELETE FROM recording_targets WHERE tenant_id=? AND camera_id=? AND profile=?`,
		tenantID, cameraID, profile)
	return err
}

// ── recording_segments ───────────────────────────────────────────────────────

const segmentCols = `path, tenant_id, camera_id, profile, started_at, ended_at, duration, file_size,
	codec, resolution, trigger_type, storage_pool_id, checksum, integrity_status,
	locked, locked_by, locked_at, has_motion, event_markers, emitted, emitted_at`

// UpsertRecordingSegment inserts a segment into the ledger/index, reporting
// whether it was newly inserted (emit-once semantics via ON CONFLICT(path) DO NOTHING).
func (d *DB) UpsertRecordingSegment(ctx context.Context, s store.RecordingSegment) (bool, error) {
	res, err := d.rw.ExecContext(ctx, `
		INSERT INTO recording_segments (`+segmentCols+`)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO NOTHING`,
		s.Path, s.TenantID, s.CameraID, s.Profile, nullRFC(s.StartedAt), nullRFC(s.EndedAt), s.Duration, s.FileSize,
		s.Codec, s.Resolution, s.TriggerType, s.StoragePoolID, s.Checksum, s.IntegrityStatus,
		b2i(s.Locked), s.LockedBy, nullRFC(s.LockedAt), b2i(s.HasMotion), jsonText(s.EventMarkers, "[]"),
		b2i(s.Emitted), nullRFC(s.EmittedAt),
	)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

func scanSegment(row interface{ Scan(...any) error }) (store.RecordingSegment, error) {
	var (
		s                                              store.RecordingSegment
		startedAt, endedAt, lockedAt, emittedAt        sql.NullString
		codec, resolution, storagePoolID, checksum, lockedBy sql.NullString
		eventMarkers                                   sql.NullString
		duration                                       sql.NullFloat64
		fileSize                                       sql.NullInt64
		locked, hasMotion, emitted                     int
	)
	if err := row.Scan(&s.Path, &s.TenantID, &s.CameraID, &s.Profile, &startedAt, &endedAt, &duration, &fileSize,
		&codec, &resolution, &s.TriggerType, &storagePoolID, &checksum, &s.IntegrityStatus,
		&locked, &lockedBy, &lockedAt, &hasMotion, &eventMarkers, &emitted, &emittedAt); err != nil {
		return store.RecordingSegment{}, err
	}
	s.StartedAt = scanTime(startedAt)
	s.EndedAt = scanTime(endedAt)
	if duration.Valid {
		s.Duration = &duration.Float64
	}
	if fileSize.Valid {
		s.FileSize = &fileSize.Int64
	}
	s.Codec = strPtr(codec)
	s.Resolution = strPtr(resolution)
	s.StoragePoolID = strPtr(storagePoolID)
	s.Checksum = strPtr(checksum)
	s.Locked = locked == 1
	s.LockedBy = strPtr(lockedBy)
	s.LockedAt = scanTime(lockedAt)
	s.HasMotion = hasMotion == 1
	s.EventMarkers = scanJSON(eventMarkers)
	s.Emitted = emitted == 1
	s.EmittedAt = scanTime(emittedAt)
	return s, nil
}

// ListSegments returns a camera's segments in a time window (by started_at), oldest first.
func (d *DB) ListSegments(ctx context.Context, f store.SegmentFilter) ([]store.RecordingSegment, error) {
	q := `SELECT ` + segmentCols + ` FROM recording_segments WHERE camera_id=?`
	args := []any{f.CameraID}
	if f.Profile != "" {
		q += " AND profile=?"
		args = append(args, f.Profile)
	}
	if f.From != nil {
		q += " AND started_at >= ?"
		args = append(args, rfc(*f.From))
	}
	if f.To != nil {
		q += " AND started_at <= ?"
		args = append(args, rfc(*f.To))
	}
	q += " ORDER BY started_at"
	rows, err := d.ro.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.RecordingSegment
	for rows.Next() {
		s, err := scanSegment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// LockSegment marks a segment retention-exempt (evidence lock).
func (d *DB) LockSegment(ctx context.Context, path, lockedBy string) error {
	now := rfc(nowUTC())
	_, err := d.rw.ExecContext(ctx,
		`UPDATE recording_segments SET locked=1, locked_by=?, locked_at=? WHERE path=?`,
		lockedBy, now, path)
	return err
}

// UnlockSegment clears an evidence lock.
func (d *DB) UnlockSegment(ctx context.Context, path string) error {
	_, err := d.rw.ExecContext(ctx,
		`UPDATE recording_segments SET locked=0, locked_by=NULL, locked_at=NULL WHERE path=?`, path)
	return err
}
