package sqlitestore

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

// Migrate applies every unapplied migrations/*.sql in lexical order, each in its
// own transaction, recording it in the _migrations ledger. Mirrors the Postgres
// gokernel/db.Migrate pattern; idempotent (re-running is a no-op).
func (d *DB) Migrate(ctx context.Context) error {
	if _, err := d.rw.ExecContext(ctx,
		`CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`); err != nil {
		return fmt.Errorf("ledger: %w", err)
	}
	entries, err := migrationsFS.ReadDir("migrations")
	if err != nil {
		return err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	for _, name := range names {
		var seen int
		if err := d.rw.QueryRowContext(ctx, "SELECT COUNT(*) FROM _migrations WHERE version=?", name).Scan(&seen); err != nil {
			return err
		}
		if seen > 0 {
			continue
		}
		sqlBytes, err := migrationsFS.ReadFile("migrations/" + name)
		if err != nil {
			return err
		}
		tx, err := d.rw.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, string(sqlBytes)); err != nil {
			tx.Rollback()
			return fmt.Errorf("apply %s: %w", name, err)
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO _migrations(version) VALUES(?)", name); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}
