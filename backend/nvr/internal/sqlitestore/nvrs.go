package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// NVR repo (spec §4.4) — registered NVR/DVR appliances onboarded as channel sources.

const nvrCols = `id, tenant_id, name, is_enabled, brand, driver, host, port, username, enc_creds,
	channel_count, status, storage_info, capabilities, version_info, last_seen_at, last_error,
	created_by, updated_by, created_at, updated_at`

func nvrArgs(n store.NVR) []any {
	return []any{
		n.ID, n.TenantID, n.Name, b2i(n.IsEnabled), n.Brand, n.Driver, n.Host, n.Port, n.Username, n.EncCreds,
		n.ChannelCount, n.Status, jsonText(n.StorageInfo, "{}"), jsonText(n.Capabilities, "{}"), jsonText(n.VersionInfo, "{}"),
		nullRFC(n.LastSeenAt), n.LastError, n.CreatedBy, n.UpdatedBy, rfc(n.CreatedAt), rfc(n.UpdatedAt),
	}
}

func scanNVR(row interface{ Scan(...any) error }) (store.NVR, error) {
	var n store.NVR
	var (
		tenantID, driver, encCreds, lastError, createdBy, updatedBy sql.NullString
		storageInfo, capabilities, versionInfo, lastSeenAt          sql.NullString
		isEnabled                                                   int
		createdAt, updatedAt                                        string
	)
	err := row.Scan(
		&n.ID, &tenantID, &n.Name, &isEnabled, &n.Brand, &driver, &n.Host, &n.Port, &n.Username, &encCreds,
		&n.ChannelCount, &n.Status, &storageInfo, &capabilities, &versionInfo, &lastSeenAt, &lastError,
		&createdBy, &updatedBy, &createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return store.NVR{}, store.ErrNotFound
	}
	if err != nil {
		return store.NVR{}, err
	}
	n.TenantID = strPtr(tenantID)
	n.IsEnabled = isEnabled == 1
	n.Driver = strPtr(driver)
	n.EncCreds = strPtr(encCreds)
	n.StorageInfo = scanJSON(storageInfo)
	n.Capabilities = scanJSON(capabilities)
	n.VersionInfo = scanJSON(versionInfo)
	n.LastSeenAt = scanTime(lastSeenAt)
	n.LastError = strPtr(lastError)
	n.CreatedBy = strPtr(createdBy)
	n.UpdatedBy = strPtr(updatedBy)
	n.CreatedAt = mustTime(createdAt)
	n.UpdatedAt = mustTime(updatedAt)
	return n, nil
}

func (d *DB) CreateNVR(ctx context.Context, n store.NVR) error {
	_, err := d.rw.ExecContext(ctx, `INSERT INTO nvrs (`+nvrCols+`) VALUES (`+placeholders(21)+`)`, nvrArgs(n)...)
	return err
}

func (d *DB) GetNVR(ctx context.Context, id string) (store.NVR, error) {
	return scanNVR(d.ro.QueryRowContext(ctx, `SELECT `+nvrCols+` FROM nvrs WHERE id=?`, id))
}

func (d *DB) ListNVRs(ctx context.Context) ([]store.NVR, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT `+nvrCols+` FROM nvrs ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.NVR
	for rows.Next() {
		n, err := scanNVR(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

func (d *DB) UpdateNVR(ctx context.Context, n store.NVR) error {
	set := `tenant_id=?, name=?, is_enabled=?, brand=?, driver=?, host=?, port=?, username=?, enc_creds=?,
		channel_count=?, status=?, storage_info=?, capabilities=?, version_info=?, last_seen_at=?, last_error=?,
		created_by=?, updated_by=?, created_at=?, updated_at=?`
	args := nvrArgs(n)[1:]
	args = append(args, n.ID)
	res, err := d.rw.ExecContext(ctx, `UPDATE nvrs SET `+set+` WHERE id=?`, args...)
	if err != nil {
		return err
	}
	if k, _ := res.RowsAffected(); k == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (d *DB) DeleteNVR(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM nvrs WHERE id=?`, id)
	if err != nil {
		return err
	}
	if k, _ := res.RowsAffected(); k == 0 {
		return store.ErrNotFound
	}
	return nil
}
