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
}
