package sqlitestore

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/neubit/nvr/internal/store"
)

// Camera repo (spec §4.2) + media_profiles (spec §4.3). The node is the
// authoritative owner of the full camera record so it can record/stream/manage
// standalone.

// cameraCols is the canonical column order shared by INSERT/scan.
const cameraCols = `id, tenant_id, name, is_enabled, status, brand, driver, connection_type, network_info,
	onvif_host, onvif_port, onvif_user, onvif_enc_pass, onvif_profile_token, onvif_capabilities, onvif_events_enabled, onvif_event_topics,
	recording_mode, recording_schedule, recording_fps, record_substream, retention_days, pre_buffer_seconds, post_buffer_seconds, anr_enabled, audio_enabled,
	privacy_masks, motion_zones, motion_config, pos_overlay, dewarp, backchannel,
	ptz_capable, ptz_presets, site_id, floor_id, zone_id, nvr_id, nvr_channel_number,
	storage_pool_id, media_node_id, sub_stream_codec, web_codec_enforced_at,
	display_order, thumbnail_path, last_seen_at, last_error, created_by, updated_by, created_at, updated_at`

// cameraArgs flattens a Camera into the positional args matching cameraCols.
func cameraArgs(c store.Camera) []any {
	return []any{
		c.ID, c.TenantID, c.Name, b2i(c.IsEnabled), c.Status, c.Brand, c.Driver, c.ConnectionType, jsonText(c.NetworkInfo, "{}"),
		c.OnvifHost, c.OnvifPort, c.OnvifUser, c.OnvifEncPass, c.OnvifProfileToken, jsonText(c.OnvifCapabilities, "{}"), b2i(c.OnvifEventsEnabled), jsonText(c.OnvifEventTopics, "[]"),
		c.RecordingMode, jsonText(c.RecordingSchedule, "{}"), c.RecordingFPS, b2i(c.RecordSubstream), c.RetentionDays, c.PreBufferSeconds, c.PostBufferSeconds, b2i(c.AnrEnabled), b2i(c.AudioEnabled),
		jsonText(c.PrivacyMasks, "[]"), jsonText(c.MotionZones, "[]"), jsonText(c.MotionConfig, "{}"), jsonText(c.PosOverlay, "{}"), jsonText(c.Dewarp, "{}"), jsonText(c.Backchannel, "{}"),
		b2i(c.PtzCapable), jsonText(c.PtzPresets, "[]"), c.SiteID, c.FloorID, c.ZoneID, c.NvrID, c.NvrChannelNumber,
		c.StoragePoolID, c.MediaNodeID, c.SubStreamCodec, nullRFC(c.WebCodecEnforcedAt),
		c.DisplayOrder, c.ThumbnailPath, nullRFC(c.LastSeenAt), c.LastError, c.CreatedBy, c.UpdatedBy, rfc(c.CreatedAt), rfc(c.UpdatedAt),
	}
}

func scanCamera(row interface{ Scan(...any) error }) (store.Camera, error) {
	var c store.Camera
	var (
		tenantID, driver, onvifHost, onvifUser, onvifEncPass, onvifProfileToken       sql.NullString
		networkInfo, onvifCaps, onvifTopics, recSchedule                              sql.NullString
		privacyMasks, motionZones, motionConfig, posOverlay, dewarp, backchannel      sql.NullString
		ptzPresets                                                                    sql.NullString
		siteID, floorID, zoneID, nvrID, storagePoolID, mediaNodeID, subStreamCodec    sql.NullString
		thumbnailPath, lastError, createdBy, updatedBy                                sql.NullString
		webCodecEnforcedAt, lastSeenAt                                                sql.NullString
		onvifPort, recordingFPS, nvrChannelNumber                                     sql.NullInt64
		isEnabled, onvifEventsEnabled, recordSubstream, anrEnabled, audioEnabled, ptzCapable int
		createdAt, updatedAt                                                          string
	)
	err := row.Scan(
		&c.ID, &tenantID, &c.Name, &isEnabled, &c.Status, &c.Brand, &driver, &c.ConnectionType, &networkInfo,
		&onvifHost, &onvifPort, &onvifUser, &onvifEncPass, &onvifProfileToken, &onvifCaps, &onvifEventsEnabled, &onvifTopics,
		&c.RecordingMode, &recSchedule, &recordingFPS, &recordSubstream, &c.RetentionDays, &c.PreBufferSeconds, &c.PostBufferSeconds, &anrEnabled, &audioEnabled,
		&privacyMasks, &motionZones, &motionConfig, &posOverlay, &dewarp, &backchannel,
		&ptzCapable, &ptzPresets, &siteID, &floorID, &zoneID, &nvrID, &nvrChannelNumber,
		&storagePoolID, &mediaNodeID, &subStreamCodec, &webCodecEnforcedAt,
		&c.DisplayOrder, &thumbnailPath, &lastSeenAt, &lastError, &createdBy, &updatedBy, &createdAt, &updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return store.Camera{}, store.ErrNotFound
	}
	if err != nil {
		return store.Camera{}, err
	}
	c.TenantID = strPtr(tenantID)
	c.IsEnabled = isEnabled == 1
	c.Driver = strPtr(driver)
	c.NetworkInfo = scanJSON(networkInfo)
	c.OnvifHost = strPtr(onvifHost)
	c.OnvifPort = intPtr(onvifPort)
	c.OnvifUser = strPtr(onvifUser)
	c.OnvifEncPass = strPtr(onvifEncPass)
	c.OnvifProfileToken = strPtr(onvifProfileToken)
	c.OnvifCapabilities = scanJSON(onvifCaps)
	c.OnvifEventsEnabled = onvifEventsEnabled == 1
	c.OnvifEventTopics = scanJSON(onvifTopics)
	c.RecordingSchedule = scanJSON(recSchedule)
	c.RecordingFPS = intPtr(recordingFPS)
	c.RecordSubstream = recordSubstream == 1
	c.AnrEnabled = anrEnabled == 1
	c.AudioEnabled = audioEnabled == 1
	c.PrivacyMasks = scanJSON(privacyMasks)
	c.MotionZones = scanJSON(motionZones)
	c.MotionConfig = scanJSON(motionConfig)
	c.PosOverlay = scanJSON(posOverlay)
	c.Dewarp = scanJSON(dewarp)
	c.Backchannel = scanJSON(backchannel)
	c.PtzCapable = ptzCapable == 1
	c.PtzPresets = scanJSON(ptzPresets)
	c.SiteID = strPtr(siteID)
	c.FloorID = strPtr(floorID)
	c.ZoneID = strPtr(zoneID)
	c.NvrID = strPtr(nvrID)
	c.NvrChannelNumber = intPtr(nvrChannelNumber)
	c.StoragePoolID = strPtr(storagePoolID)
	c.MediaNodeID = strPtr(mediaNodeID)
	c.SubStreamCodec = strPtr(subStreamCodec)
	c.WebCodecEnforcedAt = scanTime(webCodecEnforcedAt)
	c.ThumbnailPath = strPtr(thumbnailPath)
	c.LastSeenAt = scanTime(lastSeenAt)
	c.LastError = strPtr(lastError)
	c.CreatedBy = strPtr(createdBy)
	c.UpdatedBy = strPtr(updatedBy)
	c.CreatedAt = mustTime(createdAt)
	c.UpdatedAt = mustTime(updatedAt)
	return c, nil
}

// CreateCamera inserts a camera row.
func (d *DB) CreateCamera(ctx context.Context, c store.Camera) error {
	ph := placeholders(51)
	_, err := d.rw.ExecContext(ctx, `INSERT INTO cameras (`+cameraCols+`) VALUES (`+ph+`)`, cameraArgs(c)...)
	return err
}

// GetCamera returns a camera with its media profiles (ErrNotFound if absent).
func (d *DB) GetCamera(ctx context.Context, id string) (store.Camera, error) {
	c, err := scanCamera(d.ro.QueryRowContext(ctx, `SELECT `+cameraCols+` FROM cameras WHERE id=?`, id))
	if err != nil {
		return store.Camera{}, err
	}
	profs, err := d.ListMediaProfiles(ctx, id)
	if err != nil {
		return store.Camera{}, err
	}
	c.Profiles = profs
	return c, nil
}

// ListCameras returns cameras matching the filter, ordered by display_order then name.
func (d *DB) ListCameras(ctx context.Context, f store.CameraFilter) ([]store.Camera, error) {
	var where []string
	var args []any
	if f.Status != "" {
		where = append(where, "status=?")
		args = append(args, f.Status)
	}
	if f.SiteID != "" {
		where = append(where, "site_id=?")
		args = append(args, f.SiteID)
	}
	if f.NvrID != "" {
		where = append(where, "nvr_id=?")
		args = append(args, f.NvrID)
	}
	if f.Name != "" {
		where = append(where, "name LIKE ?")
		args = append(args, "%"+f.Name+"%")
	}
	q := `SELECT ` + cameraCols + ` FROM cameras`
	if len(where) > 0 {
		q += " WHERE " + strings.Join(where, " AND ")
	}
	q += " ORDER BY display_order, name"
	rows, err := d.ro.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.Camera
	for rows.Next() {
		c, err := scanCamera(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// UpdateCamera overwrites all mutable columns of an existing camera.
func (d *DB) UpdateCamera(ctx context.Context, c store.Camera) error {
	// Reuse cameraArgs order but drive an UPDATE by id (id is the last WHERE arg).
	set := `tenant_id=?, name=?, is_enabled=?, status=?, brand=?, driver=?, connection_type=?, network_info=?,
		onvif_host=?, onvif_port=?, onvif_user=?, onvif_enc_pass=?, onvif_profile_token=?, onvif_capabilities=?, onvif_events_enabled=?, onvif_event_topics=?,
		recording_mode=?, recording_schedule=?, recording_fps=?, record_substream=?, retention_days=?, pre_buffer_seconds=?, post_buffer_seconds=?, anr_enabled=?, audio_enabled=?,
		privacy_masks=?, motion_zones=?, motion_config=?, pos_overlay=?, dewarp=?, backchannel=?,
		ptz_capable=?, ptz_presets=?, site_id=?, floor_id=?, zone_id=?, nvr_id=?, nvr_channel_number=?,
		storage_pool_id=?, media_node_id=?, sub_stream_codec=?, web_codec_enforced_at=?,
		display_order=?, thumbnail_path=?, last_seen_at=?, last_error=?, created_by=?, updated_by=?, created_at=?, updated_at=?`
	args := cameraArgs(c)[1:] // drop id from the front (it's the WHERE key)
	args = append(args, c.ID)
	res, err := d.rw.ExecContext(ctx, `UPDATE cameras SET `+set+` WHERE id=?`, args...)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// DeleteCamera removes a camera (media_profiles cascade via FK).
func (d *DB) DeleteCamera(ctx context.Context, id string) error {
	res, err := d.rw.ExecContext(ctx, `DELETE FROM cameras WHERE id=?`, id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return store.ErrNotFound
	}
	return nil
}

// ── media_profiles ───────────────────────────────────────────────────────────

// UpsertMediaProfile inserts or updates a stream profile (by id).
func (d *DB) UpsertMediaProfile(ctx context.Context, p store.MediaProfile) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO media_profiles (id, tenant_id, camera_id, name, codec, resolution, fps, rtsp_path, bitrate, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			tenant_id=excluded.tenant_id, camera_id=excluded.camera_id, name=excluded.name,
			codec=excluded.codec, resolution=excluded.resolution, fps=excluded.fps,
			rtsp_path=excluded.rtsp_path, bitrate=excluded.bitrate, updated_at=excluded.updated_at`,
		p.ID, p.TenantID, p.CameraID, p.Name, p.Codec, p.Resolution, p.FPS, p.RTSPPath, p.Bitrate,
		rfc(p.CreatedAt), rfc(p.UpdatedAt),
	)
	return err
}

// ListMediaProfiles returns a camera's profiles ordered by name.
func (d *DB) ListMediaProfiles(ctx context.Context, cameraID string) ([]store.MediaProfile, error) {
	rows, err := d.ro.QueryContext(ctx, `
		SELECT id, tenant_id, camera_id, name, codec, resolution, fps, rtsp_path, bitrate, created_at, updated_at
		FROM media_profiles WHERE camera_id=? ORDER BY name`, cameraID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.MediaProfile
	for rows.Next() {
		var (
			p                              store.MediaProfile
			tenantID, codec, resolution, rtsp sql.NullString
			fps, bitrate                   sql.NullInt64
			createdAt, updatedAt           string
		)
		if err := rows.Scan(&p.ID, &tenantID, &p.CameraID, &p.Name, &codec, &resolution, &fps, &rtsp, &bitrate, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.TenantID = strPtr(tenantID)
		p.Codec = strPtr(codec)
		p.Resolution = strPtr(resolution)
		p.FPS = intPtr(fps)
		p.RTSPPath = strPtr(rtsp)
		p.Bitrate = intPtr(bitrate)
		p.CreatedAt = mustTime(createdAt)
		p.UpdatedAt = mustTime(updatedAt)
		out = append(out, p)
	}
	return out, rows.Err()
}
