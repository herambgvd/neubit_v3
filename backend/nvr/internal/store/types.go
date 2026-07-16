// Package store is the persistence seam for the Go nvr node. Two backends
// implement the Store interface: pgstore (default, wraps today's Postgres) and
// sqlitestore (the autonomous embedded-SQLite node). The types here are the
// shared, backend-agnostic representation of the node's estate; they mirror the
// columns in the node-agent design spec (§4.2–§4.13) so a row round-trips
// identically through either backend.
//
// Conventions:
//   - time.Time for timestamps (the SQLite layer converts to/from RFC3339 TEXT;
//     Postgres uses native timestamptz). Nullable timestamps are *time.Time.
//   - json.RawMessage for JSON columns (stored TEXT in SQLite, jsonb in Postgres).
//   - *string / *int for nullable scalars; plain types for NOT NULL columns.
//   - JSON struct tags are snake_case to match the estate API request/response
//     shapes (which mirror vision/app/vms/cameras/schemas.py).
package store

import (
	"encoding/json"
	"time"
)

// Camera is the node's authoritative camera record (spec §4.2). It carries the
// full config the node needs to record/stream/manage the camera standalone.
type Camera struct {
	ID              string  `json:"id"`
	TenantID        *string `json:"tenant_id"`
	Name            string  `json:"name"`
	IsEnabled       bool    `json:"is_enabled"`
	Status          string  `json:"status"` // online|offline|connecting|error
	Brand           string  `json:"brand"`
	Driver          *string `json:"driver"`
	ConnectionType  string  `json:"connection_type"` // rtsp|onvif|nvr_channel
	NetworkInfo     json.RawMessage `json:"network_info"` // {ip,port,rtsp_port,mac}

	// ONVIF connection (password reversibly encrypted)
	OnvifHost         *string         `json:"onvif_host"`
	OnvifPort         *int            `json:"onvif_port"`
	OnvifUser         *string         `json:"onvif_user"`
	OnvifEncPass      *string         `json:"onvif_enc_pass"` // enc:...
	OnvifProfileToken *string         `json:"onvif_profile_token"`
	OnvifCapabilities json.RawMessage `json:"onvif_capabilities"`
	OnvifEventsEnabled bool           `json:"onvif_events_enabled"`
	OnvifEventTopics   json.RawMessage `json:"onvif_event_topics"`

	// recording config
	RecordingMode     string          `json:"recording_mode"` // continuous|schedule|motion|manual
	RecordingSchedule json.RawMessage `json:"recording_schedule"`
	RecordingFPS      *int            `json:"recording_fps"`
	RecordSubstream   bool            `json:"record_substream"`
	RetentionDays     int             `json:"retention_days"`
	PreBufferSeconds  int             `json:"pre_buffer_seconds"`
	PostBufferSeconds int             `json:"post_buffer_seconds"`
	AnrEnabled        bool            `json:"anr_enabled"`
	AudioEnabled      bool            `json:"audio_enabled"`

	// advanced config (JSON)
	PrivacyMasks json.RawMessage `json:"privacy_masks"`
	MotionZones  json.RawMessage `json:"motion_zones"`
	MotionConfig json.RawMessage `json:"motion_config"`
	PosOverlay   json.RawMessage `json:"pos_overlay"`
	Dewarp       json.RawMessage `json:"dewarp"`
	Backchannel  json.RawMessage `json:"backchannel"`

	// PTZ (denormalized flags; presets/patrols also in their own tables)
	PtzCapable bool            `json:"ptz_capable"`
	PtzPresets json.RawMessage `json:"ptz_presets"` // legacy inline; canonical = ptz_presets table

	// placement refs (geo owned centrally; refs kept for display)
	SiteID  *string `json:"site_id"`
	FloorID *string `json:"floor_id"`
	ZoneID  *string `json:"zone_id"`

	// NVR-channel linkage
	NvrID            *string `json:"nvr_id"`
	NvrChannelNumber *int    `json:"nvr_channel_number"`

	// storage + media-node placement
	StoragePoolID *string `json:"storage_pool_id"`
	MediaNodeID   *string `json:"media_node_id"`

	// stream codec policy
	SubStreamCodec     *string    `json:"sub_stream_codec"`
	WebCodecEnforcedAt *time.Time `json:"web_codec_enforced_at"`

	DisplayOrder  int        `json:"display_order"`
	ThumbnailPath *string    `json:"thumbnail_path"`
	LastSeenAt    *time.Time `json:"last_seen_at"`
	LastError     *string    `json:"last_error"`
	CreatedBy     *string    `json:"created_by"`
	UpdatedBy     *string    `json:"updated_by"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`

	// Populated by GetCamera (join); not a column.
	Profiles []MediaProfile `json:"profiles,omitempty"`
}

// CameraFilter narrows ListCameras (spec §6.1 list filters).
type CameraFilter struct {
	Status string
	Name   string
	SiteID string
	NvrID  string
}

// MediaProfile is a camera stream profile (spec §4.3).
type MediaProfile struct {
	ID         string    `json:"id"`
	TenantID   *string   `json:"tenant_id"`
	CameraID   string    `json:"camera_id"`
	Name       string    `json:"name"` // main|sub|third
	Codec      *string   `json:"codec"`
	Resolution *string   `json:"resolution"` // "1920x1080"
	FPS        *int      `json:"fps"`
	RTSPPath   *string   `json:"rtsp_path"`
	Bitrate    *int      `json:"bitrate"` // kbps
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// NVR is a registered NVR/DVR appliance onboarded as a channel source (spec §4.4).
type NVR struct {
	ID           string          `json:"id"`
	TenantID     *string         `json:"tenant_id"`
	Name         string          `json:"name"`
	IsEnabled    bool            `json:"is_enabled"`
	Brand        string          `json:"brand"`
	Driver       *string         `json:"driver"`
	Host         string          `json:"host"`
	Port         int             `json:"port"`
	Username     string          `json:"username"`
	EncCreds     *string         `json:"enc_creds"` // enc:...
	ChannelCount int             `json:"channel_count"`
	Status       string          `json:"status"`
	StorageInfo  json.RawMessage `json:"storage_info"`
	Capabilities json.RawMessage `json:"capabilities"`
	VersionInfo  json.RawMessage `json:"version_info"`
	LastSeenAt   *time.Time      `json:"last_seen_at"`
	LastError    *string         `json:"last_error"`
	CreatedBy    *string         `json:"created_by"`
	UpdatedBy    *string         `json:"updated_by"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

// RecordingTarget is desired recording state the supervisor reconciles (spec §4.5).
type RecordingTarget struct {
	ID              int64     `json:"id"`
	TenantID        string    `json:"tenant_id"`
	CameraID        string    `json:"camera_id"`
	Profile         string    `json:"profile"`
	NodeID          *string   `json:"node_id"`
	PathName        string    `json:"path_name"`
	RecordPath      string    `json:"record_path"`
	Active          bool      `json:"active"`
	TriggerType     string    `json:"trigger_type"`
	Redundant       bool      `json:"redundant"`
	SecondaryNodeID *string   `json:"secondary_node_id"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

// RecordingSegment is the emit-once ledger + local playback index (spec §4.6).
type RecordingSegment struct {
	Path            string          `json:"path"` // absolute segment file path (PK)
	TenantID        string          `json:"tenant_id"`
	CameraID        string          `json:"camera_id"`
	Profile         string          `json:"profile"`
	StartedAt       *time.Time      `json:"started_at"`
	EndedAt         *time.Time      `json:"ended_at"`
	Duration        *float64        `json:"duration"`
	FileSize        *int64          `json:"file_size"`
	Codec           *string         `json:"codec"`
	Resolution      *string         `json:"resolution"`
	TriggerType     string          `json:"trigger_type"`
	StoragePoolID   *string         `json:"storage_pool_id"`
	Checksum        *string         `json:"checksum"`
	IntegrityStatus string          `json:"integrity_status"`
	Locked          bool            `json:"locked"`
	LockedBy        *string         `json:"locked_by"`
	LockedAt        *time.Time      `json:"locked_at"`
	HasMotion       bool            `json:"has_motion"`
	EventMarkers    json.RawMessage `json:"event_markers"`
	Emitted         bool            `json:"emitted"`
	EmittedAt       *time.Time      `json:"emitted_at"`
}

// SegmentFilter narrows ListSegments (camera + time window).
type SegmentFilter struct {
	CameraID string
	Profile  string
	From     *time.Time
	To       *time.Time
}

// StoragePool is a recording destination (spec §4.7).
type StoragePool struct {
	ID              string     `json:"id"`
	TenantID        *string    `json:"tenant_id"`
	Name            string     `json:"name"`
	PoolType        string     `json:"pool_type"` // local|nfs|smb|s3
	Path            *string    `json:"path"`
	Priority        int        `json:"priority"`
	MaxSizeBytes    *int64     `json:"max_size_bytes"`
	IsDefault       bool       `json:"is_default"`
	IsActive        bool       `json:"is_active"`
	NasServer       *string    `json:"nas_server"`
	NasShare        *string    `json:"nas_share"`
	NasProtocol     *string    `json:"nas_protocol"`
	NasUsername     *string    `json:"nas_username"`
	NasEncPassword  *string    `json:"nas_enc_password"` // enc:...
	NasDomain       *string    `json:"nas_domain"`
	NasMountOptions *string    `json:"nas_mount_options"`
	MountState      *string    `json:"mount_state"`
	LastMountError  *string    `json:"last_mount_error"`
	S3Endpoint      *string    `json:"s3_endpoint"`
	S3Bucket        *string    `json:"s3_bucket"`
	S3Region        *string    `json:"s3_region"`
	S3AccessKey     *string    `json:"s3_access_key"`
	S3EncSecretKey  *string    `json:"s3_enc_secret_key"` // enc:...
	S3UseSSL        bool       `json:"s3_use_ssl"`
	Reachable       *bool      `json:"reachable"`
	RaidLevel       *string    `json:"raid_level"`
	RaidDevice      *string    `json:"raid_device"`
	CreatedBy       *string    `json:"created_by"`
	UpdatedBy       *string    `json:"updated_by"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// TierRule moves aged recordings between pools (spec §4.8).
type TierRule struct {
	ID            string     `json:"id"`
	TenantID      *string    `json:"tenant_id"`
	Name          string     `json:"name"`
	SourcePoolID  string     `json:"source_pool_id"`
	TargetPoolID  string     `json:"target_pool_id"`
	AfterAgeHours int        `json:"after_age_hours"`
	Enabled       bool       `json:"enabled"`
	LastRunAt     *time.Time `json:"last_run_at"`
	CreatedBy     *string    `json:"created_by"`
	UpdatedBy     *string    `json:"updated_by"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

// RaidArray is node-global hardware RAID health (spec §4.9). Not tenant-scoped.
type RaidArray struct {
	Device          string     `json:"device"` // /dev/md0 (PK)
	Level           string     `json:"level"`
	State           *string    `json:"state"`
	Health          string     `json:"health"` // healthy|degraded|rebuilding|failed|unknown
	WorkingDevices  int        `json:"working_devices"`
	FailedDevices   int        `json:"failed_devices"`
	TotalDevices    int        `json:"total_devices"`
	RebuildStatus   *string    `json:"rebuild_status"`
	RebuildPercent  *int       `json:"rebuild_percent"`
	FirstDegradedAt *time.Time `json:"first_degraded_at"`
	LastSeenAt      time.Time  `json:"last_seen_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

// PtzPreset is a saved PTZ position (spec §4.10).
type PtzPreset struct {
	ID          string          `json:"id"`
	TenantID    *string         `json:"tenant_id"`
	CameraID    string          `json:"camera_id"`
	Name        string          `json:"name"`
	PresetToken *string         `json:"preset_token"`
	Position    json.RawMessage `json:"position"` // {pan,tilt,zoom} advisory
	CreatedBy   *string         `json:"created_by"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

// PtzPatrol is a preset-tour (spec §4.10).
type PtzPatrol struct {
	ID        string          `json:"id"`
	TenantID  *string         `json:"tenant_id"`
	CameraID  string          `json:"camera_id"`
	Name      string          `json:"name"`
	Stops     json.RawMessage `json:"stops"` // [{preset_id,dwell_seconds}]
	Speed     float64         `json:"speed"`
	IsActive  bool            `json:"is_active"`
	IsRunning bool            `json:"is_running"`
	Schedule  json.RawMessage `json:"schedule"`
	CreatedBy *string         `json:"created_by"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

// MediaNode is the placement seam + heartbeat state (spec §4.11). On an
// appliance this holds exactly one local node row.
type MediaNode struct {
	ID            string     `json:"id"`
	APIURL        string     `json:"api_url"`
	HLSBase       string     `json:"hls_base"`
	WebRTCBase    string     `json:"webrtc_base"`
	RTSPBase      string     `json:"rtsp_base"`
	Healthy       bool       `json:"healthy"`
	LastSeenAt    time.Time  `json:"last_seen_at"`
	LastHeartbeat time.Time  `json:"last_heartbeat"`
	DeadSince     *time.Time `json:"dead_since"`
	CreatedAt     time.Time  `json:"created_at"`
}

// StreamShard maps a camera profile to a node's MediaMTX path (spec §4.11).
type StreamShard struct {
	ID        int64     `json:"id"`
	TenantID  string    `json:"tenant_id"`
	CameraID  string    `json:"camera_id"`
	Profile   string    `json:"profile"`
	NodeID    string    `json:"node_id"`
	PathName  string    `json:"path_name"`
	RTSPURL   string    `json:"rtsp_url"`
	Redundant bool      `json:"redundant"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

// AnrJob is an Automatic Network Replenishment backfill job (spec §4.12).
type AnrJob struct {
	ID                  int64      `json:"id"`
	TenantID            string     `json:"tenant_id"`
	CameraID            string     `json:"camera_id"`
	Profile             string     `json:"profile"`
	GapFrom             time.Time  `json:"gap_from"`
	GapTo               time.Time  `json:"gap_to"`
	Status              string     `json:"status"` // queued|running|done|failed
	BackfilledSegments  int        `json:"backfilled_segments"`
	Error               *string    `json:"error"`
	CreatedAt           time.Time  `json:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at"`
	CompletedAt         *time.Time `json:"completed_at"`
}

// NodeIdentity is the node's self — one row, written at bootstrap/enrollment
// (spec §4.13).
type NodeIdentity struct {
	ID             string     `json:"id"`
	Name           string     `json:"name"`
	TenantID       *string    `json:"tenant_id"`
	CentralBaseURL *string    `json:"central_base_url"`
	NodeCredential *string    `json:"-"` // enc: long-lived node token (never serialized)
	EnrollState    string     `json:"enroll_state"` // standalone|enrolled|revoked
	JWTPublicKey   *string    `json:"-"`
	SecretKeyEnc   *string    `json:"-"`
	EnrolledAt     *time.Time `json:"enrolled_at"`
	LastSyncAt     *time.Time `json:"last_sync_at"`
	CreatedAt      time.Time  `json:"created_at"`
	UpdatedAt      time.Time  `json:"updated_at"`
}

// LocalUser is a standalone-console account (spec §4.13).
type LocalUser struct {
	ID                 string     `json:"id"`
	Username           string     `json:"username"`
	FullName           *string    `json:"full_name"`
	PasswordHash       string     `json:"-"` // argon2id, never serialized
	Role               string     `json:"role"` // admin|operator|viewer
	IsActive           bool       `json:"is_active"`
	IsBootstrap        bool       `json:"is_bootstrap"`
	FailedLoginCount   int        `json:"-"`
	LockedUntil        *time.Time `json:"locked_until"`
	MustChangePassword bool       `json:"must_change_password"`
	LastLoginAt        *time.Time `json:"last_login_at"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

// LocalSession is an opaque session token for standalone login (spec §4.13).
type LocalSession struct {
	ID        string     `json:"id"`
	UserID    string     `json:"user_id"`
	TokenHash string     `json:"-"` // sha256 of the bearer
	ExpiresAt time.Time  `json:"expires_at"`
	CreatedAt time.Time  `json:"created_at"`
	RevokedAt *time.Time `json:"revoked_at"`
}

// AuditEntry is an append-only local trail row (spec §4.13).
type AuditEntry struct {
	ID        int64           `json:"id"`
	TS        time.Time       `json:"ts"`
	Actor     *string         `json:"actor"`
	ActorKind string          `json:"actor_kind"` // local|central|system
	Action    string          `json:"action"`
	Target    *string         `json:"target"`
	Detail    json.RawMessage `json:"detail"`
	Forwarded bool            `json:"forwarded"`
}

// OutboundMsg is a spooled offline event/snapshot (spec §4.13).
type OutboundMsg struct {
	ID        int64      `json:"id"`
	Kind      string     `json:"kind"` // snapshot|recording.segment|event|audit|status
	Subject   *string    `json:"subject"`
	Payload   json.RawMessage `json:"payload"`
	Attempts  int        `json:"attempts"`
	NextTryAt *time.Time `json:"next_try_at"`
	CreatedAt time.Time  `json:"created_at"`
}
