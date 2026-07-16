package store

import (
	"context"
	"errors"
)

// ErrNotFound is returned by Get* methods when the row does not exist, so callers
// can distinguish "missing" from a real query error regardless of backend.
var ErrNotFound = errors.New("store: not found")

// Store is the persistence seam. Two backends implement it: pgstore (default,
// wraps today's Postgres) and sqlitestore (the autonomous embedded-SQLite node).
// Methods are grouped and grow per implementation phase — estate, identity,
// local-auth, audit and federation methods are declared in their own phases as
// the repos land. Keeping the interface additive lets main.go pick a backend
// without either backend having to implement the whole surface up front.
type Store interface {
	// lifecycle
	Migrate(ctx context.Context) error
	Close() error

	// --- engine-facing (used today by streams/recording/playback/anr) ---
	// These mirror the queries the existing engines run; pgstore wraps today's
	// SQL and sqlitestore implements them against node.db (Task 2.x).
	UpsertStreamShard(ctx context.Context, s StreamShard) error
	DeleteStreamShard(ctx context.Context, tenantID, cameraID, profile string) error
	ListRecordingTargets(ctx context.Context) ([]RecordingTarget, error)
	// UpsertRecordingSegment reports whether the row was newly inserted (the
	// emit-once ledger semantics), via ON CONFLICT(path) DO NOTHING + RowsAffected.
	UpsertRecordingSegment(ctx context.Context, seg RecordingSegment) (inserted bool, err error)

	// --- node identity (Task 1.3) ---
	UpsertNodeIdentity(ctx context.Context, id NodeIdentity) error
	// GetNodeIdentity returns the single node_identity row, or ErrNotFound if the
	// node has not been bootstrapped yet.
	GetNodeIdentity(ctx context.Context) (NodeIdentity, error)

	// --- local users + sessions (Task 3.1) ---
	CreateLocalUser(ctx context.Context, u LocalUser) error
	GetLocalUserByName(ctx context.Context, username string) (LocalUser, error)
	GetLocalUserByID(ctx context.Context, id string) (LocalUser, error)
	CountLocalUsers(ctx context.Context) (int, error)
	UpdateLocalUser(ctx context.Context, u LocalUser) error
	CreateSession(ctx context.Context, s LocalSession) error
	GetSessionByTokenHash(ctx context.Context, tokenHash string) (LocalSession, error)
	RevokeSession(ctx context.Context, id string) error

	// --- cameras + media profiles (Task 2.1) ---
	CreateCamera(ctx context.Context, c Camera) error
	GetCamera(ctx context.Context, id string) (Camera, error)
	ListCameras(ctx context.Context, f CameraFilter) ([]Camera, error)
	UpdateCamera(ctx context.Context, c Camera) error
	DeleteCamera(ctx context.Context, id string) error
	UpsertMediaProfile(ctx context.Context, p MediaProfile) error
	ListMediaProfiles(ctx context.Context, cameraID string) ([]MediaProfile, error)

	// --- nvrs (Task 2.2) ---
	CreateNVR(ctx context.Context, n NVR) error
	GetNVR(ctx context.Context, id string) (NVR, error)
	ListNVRs(ctx context.Context) ([]NVR, error)
	UpdateNVR(ctx context.Context, n NVR) error
	DeleteNVR(ctx context.Context, id string) error

	// --- recording targets + segments (Task 2.3) ---
	UpsertRecordingTarget(ctx context.Context, t RecordingTarget) error
	DeleteRecordingTarget(ctx context.Context, tenantID, cameraID, profile string) error
	ListSegments(ctx context.Context, f SegmentFilter) ([]RecordingSegment, error)
	LockSegment(ctx context.Context, path, lockedBy string) error
	UnlockSegment(ctx context.Context, path string) error

	// --- storage pools + tier rules + raid (Task 2.4) ---
	CreateStoragePool(ctx context.Context, p StoragePool) error
	GetStoragePool(ctx context.Context, id string) (StoragePool, error)
	ListStoragePools(ctx context.Context) ([]StoragePool, error)
	UpdateStoragePool(ctx context.Context, p StoragePool) error
	DeleteStoragePool(ctx context.Context, id string) error
	CreateTierRule(ctx context.Context, r TierRule) error
	ListTierRules(ctx context.Context) ([]TierRule, error)
	UpdateTierRule(ctx context.Context, r TierRule) error
	DeleteTierRule(ctx context.Context, id string) error
	UpsertRaidArray(ctx context.Context, a RaidArray) error
	ListRaidArrays(ctx context.Context) ([]RaidArray, error)

	// --- ptz (Task 2.5) ---
	CreatePtzPreset(ctx context.Context, p PtzPreset) error
	ListPtzPresets(ctx context.Context, cameraID string) ([]PtzPreset, error)
	DeletePtzPreset(ctx context.Context, id string) error
	CreatePtzPatrol(ctx context.Context, p PtzPatrol) error
	ListPtzPatrols(ctx context.Context, cameraID string) ([]PtzPatrol, error)
	UpdatePtzPatrol(ctx context.Context, p PtzPatrol) error
	DeletePtzPatrol(ctx context.Context, id string) error

	// --- media nodes + stream shards (Task 2.6) ---
	UpsertMediaNode(ctx context.Context, n MediaNode) error
	GetMediaNode(ctx context.Context, id string) (MediaNode, error)
	ListStreamShards(ctx context.Context) ([]StreamShard, error)

	// --- anr jobs (Task 2.6) ---
	CreateAnrJob(ctx context.Context, j AnrJob) (int64, error)
	UpdateAnrJob(ctx context.Context, j AnrJob) error
	ListAnrJobs(ctx context.Context, cameraID string) ([]AnrJob, error)
	ClaimAnrJob(ctx context.Context) (AnrJob, error)
}
