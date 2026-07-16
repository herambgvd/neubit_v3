package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// Storage repo: storage_pools (§4.7) + storage_tier_rules (§4.8) + raid_arrays (§4.9).

// ── storage_pools ────────────────────────────────────────────────────────────

const poolCols = `id, tenant_id, name, pool_type, path, priority, max_size_bytes, is_default, is_active,
	nas_server, nas_share, nas_protocol, nas_username, nas_enc_password, nas_domain, nas_mount_options,
	mount_state, last_mount_error, s3_endpoint, s3_bucket, s3_region, s3_access_key, s3_enc_secret_key,
	s3_use_ssl, reachable, raid_level, raid_device, created_by, updated_by, created_at, updated_at`

func poolArgs(p store.StoragePool) []any {
	return []any{
		p.ID, p.TenantID, p.Name, p.PoolType, p.Path, p.Priority, p.MaxSizeBytes, b2i(p.IsDefault), b2i(p.IsActive),
		p.NasServer, p.NasShare, p.NasProtocol, p.NasUsername, p.NasEncPassword, p.NasDomain, p.NasMountOptions,
		p.MountState, p.LastMountError, p.S3Endpoint, p.S3Bucket, p.S3Region, p.S3AccessKey, p.S3EncSecretKey,
		b2i(p.S3UseSSL), p.Reachable, p.RaidLevel, p.RaidDevice, p.CreatedBy, p.UpdatedBy, rfc(p.CreatedAt), rfc(p.UpdatedAt),
	}
}

func scanPool(row interface{ Scan(...any) error }) (store.StoragePool, error) {
	var p store.StoragePool
	var (
		tenantID, path, nasServer, nasShare, nasProtocol, nasUsername, nasEncPassword sql.NullString
		nasDomain, nasMountOptions, mountState, lastMountError                        sql.NullString
		s3Endpoint, s3Bucket, s3Region, s3AccessKey, s3EncSecretKey                   sql.NullString
		raidLevel, raidDevice, createdBy, updatedBy                                   sql.NullString
		maxSizeBytes                                                                  sql.NullInt64
		reachable                                                                     sql.NullBool
		isDefault, isActive, s3UseSSL                                                 int
		createdAt, updatedAt                                                          string
	)
	err := row.Scan(&p.ID, &tenantID, &p.Name, &p.PoolType, &path, &p.Priority, &maxSizeBytes, &isDefault, &isActive,
		&nasServer, &nasShare, &nasProtocol, &nasUsername, &nasEncPassword, &nasDomain, &nasMountOptions,
		&mountState, &lastMountError, &s3Endpoint, &s3Bucket, &s3Region, &s3AccessKey, &s3EncSecretKey,
		&s3UseSSL, &reachable, &raidLevel, &raidDevice, &createdBy, &updatedBy, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.StoragePool{}, store.ErrNotFound
	}
	if err != nil {
		return store.StoragePool{}, err
	}
	p.TenantID = strPtr(tenantID)
	p.Path = strPtr(path)
	p.MaxSizeBytes = int64Ptr(maxSizeBytes)
	p.IsDefault = isDefault == 1
	p.IsActive = isActive == 1
	p.NasServer = strPtr(nasServer)
	p.NasShare = strPtr(nasShare)
	p.NasProtocol = strPtr(nasProtocol)
	p.NasUsername = strPtr(nasUsername)
	p.NasEncPassword = strPtr(nasEncPassword)
	p.NasDomain = strPtr(nasDomain)
	p.NasMountOptions = strPtr(nasMountOptions)
	p.MountState = strPtr(mountState)
	p.LastMountError = strPtr(lastMountError)
	p.S3Endpoint = strPtr(s3Endpoint)
	p.S3Bucket = strPtr(s3Bucket)
	p.S3Region = strPtr(s3Region)
	p.S3AccessKey = strPtr(s3AccessKey)
	p.S3EncSecretKey = strPtr(s3EncSecretKey)
	p.S3UseSSL = s3UseSSL == 1
	p.Reachable = boolPtr(reachable)
	p.RaidLevel = strPtr(raidLevel)
	p.RaidDevice = strPtr(raidDevice)
	p.CreatedBy = strPtr(createdBy)
	p.UpdatedBy = strPtr(updatedBy)
	p.CreatedAt = mustTime(createdAt)
	p.UpdatedAt = mustTime(updatedAt)
	return p, nil
}

func (d *DB) CreateStoragePool(ctx context.Context, p store.StoragePool) error {
	_, err := d.rw.ExecContext(ctx, `INSERT INTO storage_pools (`+poolCols+`) VALUES (`+placeholders(31)+`)`, poolArgs(p)...)
	return err
}

func (d *DB) GetStoragePool(ctx context.Context, id string) (store.StoragePool, error) {
	return scanPool(d.ro.QueryRowContext(ctx, `SELECT `+poolCols+` FROM storage_pools WHERE id=?`, id))
}

func (d *DB) ListStoragePools(ctx context.Context) ([]store.StoragePool, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT `+poolCols+` FROM storage_pools ORDER BY priority, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.StoragePool
	for rows.Next() {
		p, err := scanPool(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (d *DB) UpdateStoragePool(ctx context.Context, p store.StoragePool) error {
	set := `tenant_id=?, name=?, pool_type=?, path=?, priority=?, max_size_bytes=?, is_default=?, is_active=?,
		nas_server=?, nas_share=?, nas_protocol=?, nas_username=?, nas_enc_password=?, nas_domain=?, nas_mount_options=?,
		mount_state=?, last_mount_error=?, s3_endpoint=?, s3_bucket=?, s3_region=?, s3_access_key=?, s3_enc_secret_key=?,
		s3_use_ssl=?, reachable=?, raid_level=?, raid_device=?, created_by=?, updated_by=?, created_at=?, updated_at=?`
	args := poolArgs(p)[1:]
	args = append(args, p.ID)
	res, err := d.rw.ExecContext(ctx, `UPDATE storage_pools SET `+set+` WHERE id=?`, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (d *DB) DeleteStoragePool(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM storage_pools WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ── storage_tier_rules ───────────────────────────────────────────────────────

const tierCols = `id, tenant_id, name, source_pool_id, target_pool_id, after_age_hours, enabled,
	last_run_at, created_by, updated_by, created_at, updated_at`

func scanTierRule(row interface{ Scan(...any) error }) (store.TierRule, error) {
	var r store.TierRule
	var (
		tenantID, createdBy, updatedBy sql.NullString
		lastRunAt                      sql.NullString
		enabled                        int
		createdAt, updatedAt           string
	)
	err := row.Scan(&r.ID, &tenantID, &r.Name, &r.SourcePoolID, &r.TargetPoolID, &r.AfterAgeHours, &enabled,
		&lastRunAt, &createdBy, &updatedBy, &createdAt, &updatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.TierRule{}, store.ErrNotFound
	}
	if err != nil {
		return store.TierRule{}, err
	}
	r.TenantID = strPtr(tenantID)
	r.Enabled = enabled == 1
	r.LastRunAt = scanTime(lastRunAt)
	r.CreatedBy = strPtr(createdBy)
	r.UpdatedBy = strPtr(updatedBy)
	r.CreatedAt = mustTime(createdAt)
	r.UpdatedAt = mustTime(updatedAt)
	return r, nil
}

func (d *DB) CreateTierRule(ctx context.Context, r store.TierRule) error {
	_, err := d.rw.ExecContext(ctx, `INSERT INTO storage_tier_rules (`+tierCols+`) VALUES (`+placeholders(12)+`)`,
		r.ID, r.TenantID, r.Name, r.SourcePoolID, r.TargetPoolID, r.AfterAgeHours, b2i(r.Enabled),
		nullRFC(r.LastRunAt), r.CreatedBy, r.UpdatedBy, rfc(r.CreatedAt), rfc(r.UpdatedAt))
	return err
}

func (d *DB) ListTierRules(ctx context.Context) ([]store.TierRule, error) {
	rows, err := d.ro.QueryContext(ctx, `SELECT `+tierCols+` FROM storage_tier_rules ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.TierRule
	for rows.Next() {
		r, err := scanTierRule(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (d *DB) UpdateTierRule(ctx context.Context, r store.TierRule) error {
	res, err := d.rw.ExecContext(ctx, `
		UPDATE storage_tier_rules SET tenant_id=?, name=?, source_pool_id=?, target_pool_id=?,
			after_age_hours=?, enabled=?, last_run_at=?, updated_by=?, updated_at=? WHERE id=?`,
		r.TenantID, r.Name, r.SourcePoolID, r.TargetPoolID, r.AfterAgeHours, b2i(r.Enabled),
		nullRFC(r.LastRunAt), r.UpdatedBy, rfc(r.UpdatedAt), r.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

func (d *DB) DeleteTierRule(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM storage_tier_rules WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ── raid_arrays (node-global hardware health) ────────────────────────────────

// UpsertRaidArray writes RAID health keyed by device (the RAID monitor upserts each cycle).
func (d *DB) UpsertRaidArray(ctx context.Context, a store.RaidArray) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO raid_arrays (device, level, state, health, working_devices, failed_devices, total_devices,
			rebuild_status, rebuild_percent, first_degraded_at, last_seen_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(device) DO UPDATE SET
			level=excluded.level, state=excluded.state, health=excluded.health,
			working_devices=excluded.working_devices, failed_devices=excluded.failed_devices,
			total_devices=excluded.total_devices, rebuild_status=excluded.rebuild_status,
			rebuild_percent=excluded.rebuild_percent, first_degraded_at=excluded.first_degraded_at,
			last_seen_at=excluded.last_seen_at, updated_at=excluded.updated_at`,
		a.Device, a.Level, a.State, a.Health, a.WorkingDevices, a.FailedDevices, a.TotalDevices,
		a.RebuildStatus, a.RebuildPercent, nullRFC(a.FirstDegradedAt), rfc(a.LastSeenAt), rfc(a.UpdatedAt))
	return err
}

func (d *DB) ListRaidArrays(ctx context.Context) ([]store.RaidArray, error) {
	rows, err := d.ro.QueryContext(ctx, `
		SELECT device, level, state, health, working_devices, failed_devices, total_devices,
			rebuild_status, rebuild_percent, first_degraded_at, last_seen_at, updated_at
		FROM raid_arrays ORDER BY device`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.RaidArray
	for rows.Next() {
		var (
			a                                  store.RaidArray
			state, rebuildStatus               sql.NullString
			firstDegradedAt                    sql.NullString
			rebuildPercent                     sql.NullInt64
			lastSeenAt, updatedAt              string
		)
		if err := rows.Scan(&a.Device, &a.Level, &state, &a.Health, &a.WorkingDevices, &a.FailedDevices, &a.TotalDevices,
			&rebuildStatus, &rebuildPercent, &firstDegradedAt, &lastSeenAt, &updatedAt); err != nil {
			return nil, err
		}
		a.State = strPtr(state)
		a.RebuildStatus = strPtr(rebuildStatus)
		a.RebuildPercent = intPtr(rebuildPercent)
		a.FirstDegradedAt = scanTime(firstDegradedAt)
		a.LastSeenAt = mustTime(lastSeenAt)
		a.UpdatedAt = mustTime(updatedAt)
		out = append(out, a)
	}
	return out, rows.Err()
}
