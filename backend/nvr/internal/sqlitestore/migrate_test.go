package sqlitestore

import (
	"context"
	"path/filepath"
	"testing"
)

func TestMigrateCreatesTablesIdempotent(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "node.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer db.Close()
	ctx := context.Background()

	if err := db.Migrate(ctx); err != nil {
		t.Fatalf("migrate #1: %v", err)
	}
	if err := db.Migrate(ctx); err != nil { // idempotent
		t.Fatalf("migrate #2: %v", err)
	}

	for _, tbl := range []string{
		"cameras", "media_profiles", "nvrs", "recording_targets", "recording_segments",
		"storage_pools", "storage_tier_rules", "raid_arrays", "ptz_presets", "ptz_patrols",
		"media_nodes", "stream_shards", "anr_jobs",
		"node_identity", "local_users", "local_sessions", "audit_log", "outbound_queue",
		"_migrations",
	} {
		var n int
		row := db.ro.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", tbl)
		if err := row.Scan(&n); err != nil || n != 1 {
			t.Fatalf("table %s missing (n=%d err=%v)", tbl, n, err)
		}
	}

	// The partial unique index on anr_jobs must exist too (guards active dupes).
	var idx int
	if err := db.ro.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name='ux_anr_jobs_active'").Scan(&idx); err != nil || idx != 1 {
		t.Fatalf("ux_anr_jobs_active missing (idx=%d err=%v)", idx, err)
	}
}
