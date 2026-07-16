package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// anr_jobs repo (spec §4.12) — Automatic Network Replenishment backfill jobs.

// CreateAnrJob queues a backfill job, returning its assigned id. The partial
// unique index ux_anr_jobs_active prevents duplicate active jobs for the same gap.
func (d *DB) CreateAnrJob(ctx context.Context, j store.AnrJob) (int64, error) {
	res, err := d.rw.ExecContext(ctx, `
		INSERT INTO anr_jobs (tenant_id, camera_id, profile, gap_from, gap_to, status, backfilled_segments, error, created_at, updated_at, completed_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		j.TenantID, j.CameraID, j.Profile, rfc(j.GapFrom), rfc(j.GapTo), defaultStr(j.Status, "queued"),
		j.BackfilledSegments, j.Error, rfc(orNow(j.CreatedAt)), rfc(orNow(j.UpdatedAt)), nullRFC(j.CompletedAt))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateAnrJob writes progress/terminal state for a job.
func (d *DB) UpdateAnrJob(ctx context.Context, j store.AnrJob) error {
	res, err := d.rw.ExecContext(ctx, `
		UPDATE anr_jobs SET status=?, backfilled_segments=?, error=?, updated_at=?, completed_at=? WHERE id=?`,
		j.Status, j.BackfilledSegments, j.Error, rfc(orNow(j.UpdatedAt)), nullRFC(j.CompletedAt), j.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func scanAnrJob(row interface{ Scan(...any) error }) (store.AnrJob, error) {
	var (
		j                    store.AnrJob
		errMsg               sql.NullString
		completedAt          sql.NullString
		gapFrom, gapTo       string
		createdAt, updatedAt string
	)
	err := row.Scan(&j.ID, &j.TenantID, &j.CameraID, &j.Profile, &gapFrom, &gapTo, &j.Status,
		&j.BackfilledSegments, &errMsg, &createdAt, &updatedAt, &completedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.AnrJob{}, store.ErrNotFound
	}
	if err != nil {
		return store.AnrJob{}, err
	}
	j.GapFrom = mustTime(gapFrom)
	j.GapTo = mustTime(gapTo)
	j.Error = strPtr(errMsg)
	j.CreatedAt = mustTime(createdAt)
	j.UpdatedAt = mustTime(updatedAt)
	j.CompletedAt = scanTime(completedAt)
	return j, nil
}

const anrCols = `id, tenant_id, camera_id, profile, gap_from, gap_to, status, backfilled_segments, error, created_at, updated_at, completed_at`

// ListAnrJobs returns a camera's jobs, newest first.
func (d *DB) ListAnrJobs(ctx context.Context, cameraID string) ([]store.AnrJob, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT `+anrCols+` FROM anr_jobs WHERE camera_id=? ORDER BY created_at DESC`, cameraID)
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

// ClaimAnrJob atomically transitions the oldest queued job to running and
// returns it, or ErrNotFound if the queue is empty. The single serialized writer
// (rw MaxOpenConns(1)) makes the select-then-update race-free.
func (d *DB) ClaimAnrJob(ctx context.Context) (store.AnrJob, error) {
	tx, err := d.rw.BeginTx(ctx, nil)
	if err != nil {
		return store.AnrJob{}, err
	}
	defer tx.Rollback()

	var id int64
	err = tx.QueryRowContext(ctx,
		`SELECT id FROM anr_jobs WHERE status='queued' ORDER BY created_at LIMIT 1`).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return store.AnrJob{}, store.ErrNotFound
	}
	if err != nil {
		return store.AnrJob{}, err
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE anr_jobs SET status='running', updated_at=? WHERE id=?`, rfc(nowUTC()), id); err != nil {
		return store.AnrJob{}, err
	}
	j, err := scanAnrJob(tx.QueryRowContext(ctx, `SELECT `+anrCols+` FROM anr_jobs WHERE id=?`, id))
	if err != nil {
		return store.AnrJob{}, err
	}
	if err := tx.Commit(); err != nil {
		return store.AnrJob{}, err
	}
	return j, nil
}
