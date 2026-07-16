package sqlitestore

import (
	"context"
	"database/sql"
	"errors"

	"github.com/neubit/nvr/internal/store"
)

// media_nodes + stream_shards repo (spec §4.11). On an appliance media_nodes
// holds one local node row; stream_shards map each camera profile to its
// MediaMTX path.

// UpsertMediaNode writes the local node placement/heartbeat row.
func (d *DB) UpsertMediaNode(ctx context.Context, n store.MediaNode) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO media_nodes (id, api_url, hls_base, webrtc_base, rtsp_base, healthy, last_seen_at, last_heartbeat, dead_since, created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(id) DO UPDATE SET
			api_url=excluded.api_url, hls_base=excluded.hls_base, webrtc_base=excluded.webrtc_base,
			rtsp_base=excluded.rtsp_base, healthy=excluded.healthy, last_seen_at=excluded.last_seen_at,
			last_heartbeat=excluded.last_heartbeat, dead_since=excluded.dead_since`,
		n.ID, n.APIURL, n.HLSBase, n.WebRTCBase, n.RTSPBase, b2i(n.Healthy),
		rfc(n.LastSeenAt), rfc(n.LastHeartbeat), nullRFC(n.DeadSince), rfc(n.CreatedAt))
	return err
}

// GetMediaNode returns a node by id (ErrNotFound if absent).
func (d *DB) GetMediaNode(ctx context.Context, id string) (store.MediaNode, error) {
	var (
		n          store.MediaNode
		deadSince  sql.NullString
		healthy    int
		lastSeen, lastHb, createdAt string
	)
	err := d.ro.QueryRowContext(ctx, `
		SELECT id, api_url, hls_base, webrtc_base, rtsp_base, healthy, last_seen_at, last_heartbeat, dead_since, created_at
		FROM media_nodes WHERE id=?`, id).Scan(
		&n.ID, &n.APIURL, &n.HLSBase, &n.WebRTCBase, &n.RTSPBase, &healthy, &lastSeen, &lastHb, &deadSince, &createdAt)
	if errors.Is(err, sql.ErrNoRows) {
		return store.MediaNode{}, store.ErrNotFound
	}
	if err != nil {
		return store.MediaNode{}, err
	}
	n.Healthy = healthy == 1
	n.LastSeenAt = mustTime(lastSeen)
	n.LastHeartbeat = mustTime(lastHb)
	n.DeadSince = scanTime(deadSince)
	n.CreatedAt = mustTime(createdAt)
	return n, nil
}

// UpsertStreamShard writes a shard keyed by (tenant,camera,profile).
func (d *DB) UpsertStreamShard(ctx context.Context, s store.StreamShard) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO stream_shards (tenant_id, camera_id, profile, node_id, path_name, rtsp_url, redundant, created_at, updated_at)
		VALUES (?,?,?,?,?,?,?,?,?)
		ON CONFLICT(tenant_id, camera_id, profile) DO UPDATE SET
			node_id=excluded.node_id, path_name=excluded.path_name, rtsp_url=excluded.rtsp_url,
			redundant=excluded.redundant, updated_at=excluded.updated_at`,
		s.TenantID, s.CameraID, s.Profile, s.NodeID, s.PathName, s.RTSPURL, b2i(s.Redundant),
		rfc(orNow(s.CreatedAt)), rfc(orNow(s.UpdatedAt)))
	return err
}

// DeleteStreamShard removes a shard (no-op if absent).
func (d *DB) DeleteStreamShard(ctx context.Context, tenantID, cameraID, profile string) error {
	_, err := d.rw.ExecContext(ctx,
		`DELETE FROM stream_shards WHERE tenant_id=? AND camera_id=? AND profile=?`,
		tenantID, cameraID, profile)
	return err
}

// ListStreamShards returns every shard (the supervisor reconciles the full set).
func (d *DB) ListStreamShards(ctx context.Context) ([]store.StreamShard, error) {
	rows, err := d.ro.QueryContext(ctx, `
		SELECT id, tenant_id, camera_id, profile, node_id, path_name, rtsp_url, redundant, created_at, updated_at
		FROM stream_shards`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []store.StreamShard
	for rows.Next() {
		var (
			s                    store.StreamShard
			redundant            int
			createdAt, updatedAt string
		)
		if err := rows.Scan(&s.ID, &s.TenantID, &s.CameraID, &s.Profile, &s.NodeID, &s.PathName, &s.RTSPURL, &redundant, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		s.Redundant = redundant == 1
		s.CreatedAt = mustTime(createdAt)
		s.UpdatedAt = mustTime(updatedAt)
		out = append(out, s)
	}
	return out, rows.Err()
}
