package supervisor

import (
	"context"
	"fmt"
	"math/rand"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// newTestDB connects to the test postgres (VE_TEST_DATABASE_URL, or the compose
// default) and provisions a FRESH random schema with the media_nodes / stream_shards
// / recording_targets tables (P2-A + P6-A columns) the supervisor touches. Dropped
// on cleanup. Skips when no DB is reachable.
func newTestDB(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("VE_TEST_DATABASE_URL")
	if dsn == "" {
		dsn = "postgres://neubit:neubit@localhost:5432/neubit_nvr?sslmode=disable"
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Skipf("no test DB (%v) — set VE_TEST_DATABASE_URL to run DB-backed tests", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		t.Skipf("test DB unreachable (%v) — set VE_TEST_DATABASE_URL to run DB-backed tests", err)
	}

	schema := fmt.Sprintf("suptest_%d_%d", time.Now().UnixNano(), rand.Intn(1_000_000))
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		pool.Close()
		t.Fatalf("create schema: %v", err)
	}
	pool.Close()

	cfg, _ := pgxpool.ParseConfig(dsn)
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err = pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("reopen pool: %v", err)
	}
	if _, err := pool.Exec(ctx, supTestSchemaDDL); err != nil {
		pool.Close()
		t.Fatalf("create test schema DDL: %v", err)
	}

	t.Cleanup(func() {
		c, _ := pgxpool.ParseConfig(dsn)
		delete(c.ConnConfig.RuntimeParams, "search_path")
		if dropPool, e := pgxpool.NewWithConfig(context.Background(), c); e == nil {
			_, _ = dropPool.Exec(context.Background(), "DROP SCHEMA IF EXISTS "+schema+" CASCADE")
			dropPool.Close()
		}
		pool.Close()
	})
	return pool
}

// supTestSchemaDDL mirrors the P2-A + P6-A columns the supervisor reads/writes.
const supTestSchemaDDL = `
CREATE TABLE media_nodes (
    id           text PRIMARY KEY,
    api_url      text NOT NULL,
    hls_base     text NOT NULL,
    webrtc_base  text NOT NULL,
    rtsp_base    text NOT NULL,
    healthy      boolean NOT NULL DEFAULT true,
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    last_heartbeat timestamptz NOT NULL DEFAULT now(),
    dead_since   timestamptz,
    created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE stream_shards (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     text NOT NULL,
    camera_id     text NOT NULL,
    profile       text NOT NULL DEFAULT 'main',
    node_id       text NOT NULL REFERENCES media_nodes(id),
    path_name     text NOT NULL,
    rtsp_url      text NOT NULL,
    redundant     boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, camera_id, profile)
);
CREATE TABLE recording_targets (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id     text NOT NULL,
    camera_id     text NOT NULL,
    profile       text NOT NULL DEFAULT 'main',
    node_id       text,
    path_name     text NOT NULL DEFAULT '',
    record_path   text NOT NULL DEFAULT '',
    active        boolean NOT NULL DEFAULT true,
    trigger_type  text NOT NULL DEFAULT 'continuous',
    redundant     boolean NOT NULL DEFAULT false,
    secondary_node_id text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, camera_id, profile)
);
`
