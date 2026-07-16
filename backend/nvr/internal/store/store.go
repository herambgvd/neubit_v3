package store

import "context"

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
}
