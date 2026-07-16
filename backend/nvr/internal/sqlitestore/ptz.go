package sqlitestore

import (
	"context"
	"database/sql"

	"github.com/neubit/nvr/internal/store"
)

// PTZ repo (spec §4.10): ptz_presets + ptz_patrols.

func (d *DB) CreatePtzPreset(ctx context.Context, p store.PtzPreset) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO ptz_presets (id, tenant_id, camera_id, name, preset_token, position, created_by, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		p.ID, p.TenantID, p.CameraID, p.Name, p.PresetToken, jsonTextOrNull(p.Position), p.CreatedBy,
		rfc(p.CreatedAt), rfc(p.UpdatedAt))
	return err
}

func (d *DB) ListPtzPresets(ctx context.Context, cameraID string) ([]store.PtzPreset, error) {
	rows, err := d.ro.QueryContext(ctx, `
		SELECT id, tenant_id, camera_id, name, preset_token, position, created_by, created_at, updated_at
		FROM ptz_presets WHERE camera_id=? ORDER BY name`, cameraID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.PtzPreset
	for rows.Next() {
		var (
			p                              store.PtzPreset
			tenantID, presetToken, createdBy sql.NullString
			position                       sql.NullString
			createdAt, updatedAt           string
		)
		if err := rows.Scan(&p.ID, &tenantID, &p.CameraID, &p.Name, &presetToken, &position, &createdBy, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.TenantID = strPtr(tenantID)
		p.PresetToken = strPtr(presetToken)
		p.Position = scanJSON(position)
		p.CreatedBy = strPtr(createdBy)
		p.CreatedAt = mustTime(createdAt)
		p.UpdatedAt = mustTime(updatedAt)
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) DeletePtzPreset(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM ptz_presets WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (d *DB) CreatePtzPatrol(ctx context.Context, p store.PtzPatrol) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO ptz_patrols (id, tenant_id, camera_id, name, stops, speed, is_active, is_running, schedule, created_by, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.ID, p.TenantID, p.CameraID, p.Name, jsonText(p.Stops, "[]"), p.Speed, b2i(p.IsActive), b2i(p.IsRunning),
		jsonTextOrNull(p.Schedule), p.CreatedBy, rfc(p.CreatedAt), rfc(p.UpdatedAt))
	return err
}

func scanPatrol(row interface{ Scan(...any) error }) (store.PtzPatrol, error) {
	var (
		p                       store.PtzPatrol
		tenantID, createdBy     sql.NullString
		stops, schedule         sql.NullString
		isActive, isRunning     int
		createdAt, updatedAt    string
	)
	if err := row.Scan(&p.ID, &tenantID, &p.CameraID, &p.Name, &stops, &p.Speed, &isActive, &isRunning,
		&schedule, &createdBy, &createdAt, &updatedAt); err != nil {
		return store.PtzPatrol{}, err
	}
	p.Stops = scanJSON(stops)
	p.TenantID = strPtr(tenantID)
	p.IsActive = isActive == 1
	p.IsRunning = isRunning == 1
	p.Schedule = scanJSON(schedule)
	p.CreatedBy = strPtr(createdBy)
	p.CreatedAt = mustTime(createdAt)
	p.UpdatedAt = mustTime(updatedAt)
	return p, nil
}

func (d *DB) ListPtzPatrols(ctx context.Context, cameraID string) ([]store.PtzPatrol, error) {
	rows, err := d.ro.QueryContext(ctx, `
		SELECT id, tenant_id, camera_id, name, stops, speed, is_active, is_running, schedule, created_by, created_at, updated_at
		FROM ptz_patrols WHERE camera_id=? ORDER BY name`, cameraID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.PtzPatrol
	for rows.Next() {
		p, err := scanPatrol(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) UpdatePtzPatrol(ctx context.Context, p store.PtzPatrol) error {
	res, err := d.rw.ExecContext(ctx, `
		UPDATE ptz_patrols SET name=?, stops=?, speed=?, is_active=?, is_running=?, schedule=?, updated_at=? WHERE id=?`,
		p.Name, jsonText(p.Stops, "[]"), p.Speed, b2i(p.IsActive), b2i(p.IsRunning), jsonTextOrNull(p.Schedule),
		rfc(p.UpdatedAt), p.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (d *DB) DeletePtzPatrol(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM ptz_patrols WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}
