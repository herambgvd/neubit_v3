-- 0001_estate.sql — the autonomous node's full estate schema (design spec §4.2–§4.13).
-- Ordered so referenced tables precede their referents (foreign_keys=on is set at Open).
-- Every column mirrors the corresponding neubit_vision / neubit_nvr model so a
-- migrated row is a straight column-for-column copy. Timestamps are RFC3339 TEXT;
-- JSON columns are TEXT documents; booleans are INTEGER 0/1.

-- ── cameras (spec §4.2) ──────────────────────────────────────────────────────
CREATE TABLE cameras (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT,
  name                  TEXT NOT NULL,
  is_enabled            INTEGER NOT NULL DEFAULT 1,
  status                TEXT NOT NULL DEFAULT 'offline',
  brand                 TEXT NOT NULL DEFAULT 'onvif',
  driver                TEXT,
  connection_type       TEXT NOT NULL DEFAULT 'onvif',
  network_info          TEXT NOT NULL DEFAULT '{}',
  onvif_host            TEXT,
  onvif_port            INTEGER,
  onvif_user            TEXT,
  onvif_enc_pass        TEXT,
  onvif_profile_token   TEXT,
  onvif_capabilities    TEXT NOT NULL DEFAULT '{}',
  onvif_events_enabled  INTEGER NOT NULL DEFAULT 0,
  onvif_event_topics    TEXT NOT NULL DEFAULT '[]',
  recording_mode        TEXT NOT NULL DEFAULT 'continuous',
  recording_schedule    TEXT NOT NULL DEFAULT '{}',
  recording_fps         INTEGER,
  record_substream      INTEGER NOT NULL DEFAULT 0,
  retention_days        INTEGER NOT NULL DEFAULT 30,
  pre_buffer_seconds    INTEGER NOT NULL DEFAULT 5,
  post_buffer_seconds   INTEGER NOT NULL DEFAULT 5,
  anr_enabled           INTEGER NOT NULL DEFAULT 0,
  audio_enabled         INTEGER NOT NULL DEFAULT 0,
  privacy_masks         TEXT NOT NULL DEFAULT '[]',
  motion_zones          TEXT NOT NULL DEFAULT '[]',
  motion_config         TEXT NOT NULL DEFAULT '{}',
  pos_overlay           TEXT NOT NULL DEFAULT '{}',
  dewarp                TEXT NOT NULL DEFAULT '{}',
  backchannel           TEXT NOT NULL DEFAULT '{}',
  ptz_capable           INTEGER NOT NULL DEFAULT 0,
  ptz_presets           TEXT NOT NULL DEFAULT '[]',
  site_id               TEXT,
  floor_id              TEXT,
  zone_id               TEXT,
  nvr_id                TEXT,
  nvr_channel_number    INTEGER,
  storage_pool_id       TEXT,
  media_node_id         TEXT,
  sub_stream_codec      TEXT,
  web_codec_enforced_at TEXT,
  display_order         INTEGER NOT NULL DEFAULT 0,
  thumbnail_path        TEXT,
  last_seen_at          TEXT,
  last_error            TEXT,
  created_by            TEXT,
  updated_by            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX ix_cameras_tenant_status ON cameras (tenant_id, status);
CREATE INDEX ix_cameras_tenant_name   ON cameras (tenant_id, name);
CREATE INDEX ix_cameras_nvr           ON cameras (nvr_id);

-- ── media_profiles (spec §4.3) ───────────────────────────────────────────────
CREATE TABLE media_profiles (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT,
  camera_id   TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT 'main',
  codec       TEXT,
  resolution  TEXT,
  fps         INTEGER,
  rtsp_path   TEXT,
  bitrate     INTEGER,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX ix_media_profiles_camera ON media_profiles (camera_id);

-- ── nvrs (spec §4.4) ─────────────────────────────────────────────────────────
CREATE TABLE nvrs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT,
  name          TEXT NOT NULL,
  is_enabled    INTEGER NOT NULL DEFAULT 1,
  brand         TEXT NOT NULL DEFAULT 'onvif',
  driver        TEXT,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL DEFAULT 80,
  username      TEXT NOT NULL DEFAULT '',
  enc_creds     TEXT,
  channel_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'unknown',
  storage_info  TEXT NOT NULL DEFAULT '{}',
  capabilities  TEXT NOT NULL DEFAULT '{}',
  version_info  TEXT NOT NULL DEFAULT '{}',
  last_seen_at  TEXT,
  last_error    TEXT,
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX ix_nvrs_tenant_status ON nvrs (tenant_id, status);

-- ── recording_targets (spec §4.5) ────────────────────────────────────────────
CREATE TABLE recording_targets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id         TEXT NOT NULL,
  camera_id         TEXT NOT NULL,
  profile           TEXT NOT NULL DEFAULT 'main',
  node_id           TEXT,
  path_name         TEXT NOT NULL,
  record_path       TEXT NOT NULL,
  active            INTEGER NOT NULL DEFAULT 1,
  trigger_type      TEXT NOT NULL DEFAULT 'continuous',
  redundant         INTEGER NOT NULL DEFAULT 0,
  secondary_node_id TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, camera_id, profile)
);
CREATE INDEX ix_recording_targets_active ON recording_targets (active);

-- ── recording_segments (spec §4.6) ───────────────────────────────────────────
CREATE TABLE recording_segments (
  path             TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,
  camera_id        TEXT NOT NULL,
  profile          TEXT NOT NULL DEFAULT 'main',
  started_at       TEXT,
  ended_at         TEXT,
  duration         REAL,
  file_size        INTEGER,
  codec            TEXT,
  resolution       TEXT,
  trigger_type     TEXT NOT NULL DEFAULT 'continuous',
  storage_pool_id  TEXT,
  checksum         TEXT,
  integrity_status TEXT NOT NULL DEFAULT 'unchecked',
  locked           INTEGER NOT NULL DEFAULT 0,
  locked_by        TEXT,
  locked_at        TEXT,
  has_motion       INTEGER NOT NULL DEFAULT 0,
  event_markers    TEXT NOT NULL DEFAULT '[]',
  emitted          INTEGER NOT NULL DEFAULT 0,
  emitted_at       TEXT
);
CREATE INDEX ix_recording_segments_camera ON recording_segments (camera_id, started_at);
CREATE INDEX ix_recording_segments_locked ON recording_segments (locked);

-- ── storage_pools (spec §4.7) ────────────────────────────────────────────────
CREATE TABLE storage_pools (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT,
  name              TEXT NOT NULL,
  pool_type         TEXT NOT NULL DEFAULT 'local',
  path              TEXT,
  priority          INTEGER NOT NULL DEFAULT 0,
  max_size_bytes    INTEGER,
  is_default        INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  nas_server        TEXT,
  nas_share         TEXT,
  nas_protocol      TEXT,
  nas_username      TEXT,
  nas_enc_password  TEXT,
  nas_domain        TEXT,
  nas_mount_options TEXT,
  mount_state       TEXT,
  last_mount_error  TEXT,
  s3_endpoint       TEXT,
  s3_bucket         TEXT,
  s3_region         TEXT,
  s3_access_key     TEXT,
  s3_enc_secret_key TEXT,
  s3_use_ssl        INTEGER NOT NULL DEFAULT 1,
  reachable         INTEGER,
  raid_level        TEXT,
  raid_device       TEXT,
  created_by        TEXT,
  updated_by        TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX ix_storage_pools_tenant_default ON storage_pools (tenant_id, is_default);

-- ── storage_tier_rules (spec §4.8) ───────────────────────────────────────────
CREATE TABLE storage_tier_rules (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT,
  name            TEXT NOT NULL,
  source_pool_id  TEXT NOT NULL,
  target_pool_id  TEXT NOT NULL,
  after_age_hours INTEGER NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  last_run_at     TEXT,
  created_by      TEXT,
  updated_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX ix_storage_tier_rules_enabled ON storage_tier_rules (enabled);

-- ── raid_arrays (spec §4.9) — node-global hardware health, not tenant-scoped ──
CREATE TABLE raid_arrays (
  device            TEXT PRIMARY KEY,
  level             TEXT NOT NULL DEFAULT 'unknown',
  state             TEXT,
  health            TEXT NOT NULL DEFAULT 'unknown',
  working_devices   INTEGER NOT NULL DEFAULT 0,
  failed_devices    INTEGER NOT NULL DEFAULT 0,
  total_devices     INTEGER NOT NULL DEFAULT 0,
  rebuild_status    TEXT,
  rebuild_percent   INTEGER,
  first_degraded_at TEXT,
  last_seen_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX ix_raid_arrays_health ON raid_arrays (health);

-- ── ptz_presets + ptz_patrols (spec §4.10) ───────────────────────────────────
CREATE TABLE ptz_presets (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT,
  camera_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  preset_token TEXT,
  position     TEXT,
  created_by   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX ix_ptz_presets_camera ON ptz_presets (camera_id);

CREATE TABLE ptz_patrols (
  id         TEXT PRIMARY KEY,
  tenant_id  TEXT,
  camera_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  stops      TEXT NOT NULL DEFAULT '[]',
  speed      REAL NOT NULL DEFAULT 0.5,
  is_active  INTEGER NOT NULL DEFAULT 1,
  is_running INTEGER NOT NULL DEFAULT 0,
  schedule   TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_ptz_patrols_camera ON ptz_patrols (camera_id);

-- ── media_nodes + stream_shards (spec §4.11) ─────────────────────────────────
CREATE TABLE media_nodes (
  id             TEXT PRIMARY KEY,
  api_url        TEXT NOT NULL,
  hls_base       TEXT NOT NULL,
  webrtc_base    TEXT NOT NULL,
  rtsp_base      TEXT NOT NULL,
  healthy        INTEGER NOT NULL DEFAULT 1,
  last_seen_at   TEXT NOT NULL,
  last_heartbeat TEXT NOT NULL,
  dead_since     TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE stream_shards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id  TEXT NOT NULL,
  camera_id  TEXT NOT NULL,
  profile    TEXT NOT NULL DEFAULT 'main',
  node_id    TEXT NOT NULL REFERENCES media_nodes(id),
  path_name  TEXT NOT NULL,
  rtsp_url   TEXT NOT NULL,
  redundant  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, camera_id, profile)
);
CREATE INDEX ix_stream_shards_node ON stream_shards (node_id);

-- ── anr_jobs (spec §4.12) ────────────────────────────────────────────────────
CREATE TABLE anr_jobs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id           TEXT NOT NULL,
  camera_id           TEXT NOT NULL,
  profile             TEXT NOT NULL DEFAULT 'main',
  gap_from            TEXT NOT NULL,
  gap_to              TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued',
  backfilled_segments INTEGER NOT NULL DEFAULT 0,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  completed_at        TEXT
);
CREATE INDEX ix_anr_jobs_camera  ON anr_jobs (camera_id, created_at);
CREATE INDEX ix_anr_jobs_status  ON anr_jobs (status);
CREATE UNIQUE INDEX ux_anr_jobs_active ON anr_jobs (tenant_id, camera_id, profile, gap_from, gap_to)
  WHERE status IN ('queued','running');

-- ── node-only tables (spec §4.13) ────────────────────────────────────────────
CREATE TABLE node_identity (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  tenant_id         TEXT,
  central_base_url  TEXT,
  node_credential   TEXT,
  enroll_state      TEXT NOT NULL DEFAULT 'standalone',
  jwt_public_key    TEXT,
  secret_key_enc    TEXT,
  enrolled_at       TEXT,
  last_sync_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE local_users (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  full_name            TEXT,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'operator',
  is_active            INTEGER NOT NULL DEFAULT 1,
  is_bootstrap         INTEGER NOT NULL DEFAULT 0,
  failed_login_count   INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE local_sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES local_users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX ix_local_sessions_user ON local_sessions (user_id);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  actor      TEXT,
  actor_kind TEXT NOT NULL,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT NOT NULL DEFAULT '{}',
  forwarded  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_audit_log_ts ON audit_log (ts);

CREATE TABLE outbound_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  subject     TEXT,
  payload     TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX ix_outbound_queue_next ON outbound_queue (next_try_at);
