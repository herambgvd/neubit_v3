// Package db provides a pgx connection pool + a light, dependency-free migration
// runner for Go services.
//
// Migration runner (chosen over golang-migrate to keep the module lean and the
// runtime image tiny): a service embeds its .sql files (via go:embed) and passes
// the fs.FS to Migrate(). Files are applied in lexical order; each is recorded in
// a `_migrations` table and skipped on re-run. This matches the SPIRIT of the
// Python services' idempotent `0001_baseline` (create_all + checkfirst) — a fresh
// DB gets the full schema, re-runs are safe.
package db

import (
	"context"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pgx pool against the given DSN (already normalized to a libpq
// DSN by config.NormalizedDSN — pgx cannot parse SQLAlchemy "+asyncpg" URLs).
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("open pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	return pool, nil
}

// Migrate applies every *.sql file in fsys (lexical order) that has not already
// been recorded in `_migrations`. Each file runs in its own transaction and is
// then recorded; a failure rolls back that file and aborts. Safe to re-run.
//
// dir is the path within fsys to scan ("." or e.g. "migrations").
func Migrate(ctx context.Context, pool *pgxpool.Pool, fsys fs.FS, dir string) (applied []string, err error) {
	if _, err = pool.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS _migrations (
			version    text        PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)`); err != nil {
		return nil, fmt.Errorf("ensure _migrations: %w", err)
	}

	entries, err := fs.ReadDir(fsys, dir)
	if err != nil {
		return nil, fmt.Errorf("read migrations dir: %w", err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)

	for _, name := range files {
		var exists bool
		if err = pool.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM _migrations WHERE version = $1)`, name,
		).Scan(&exists); err != nil {
			return applied, fmt.Errorf("check %s: %w", name, err)
		}
		if exists {
			continue
		}
		sqlBytes, rerr := fs.ReadFile(fsys, dir+"/"+name)
		if rerr != nil {
			return applied, fmt.Errorf("read %s: %w", name, rerr)
		}
		if err = runOne(ctx, pool, name, string(sqlBytes)); err != nil {
			return applied, err
		}
		applied = append(applied, name)
	}
	return applied, nil
}

func runOne(ctx context.Context, pool *pgxpool.Pool, name, sqlText string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin %s: %w", name, err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	if strings.TrimSpace(sqlText) != "" {
		if _, err = tx.Exec(ctx, sqlText); err != nil {
			return fmt.Errorf("apply %s: %w", name, err)
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO _migrations (version) VALUES ($1)`, name); err != nil {
		return fmt.Errorf("record %s: %w", name, err)
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit %s: %w", name, err)
	}
	return nil
}

// Ensure pgx is referenced (kept for callers that type against it).
var _ = pgx.ErrNoRows
