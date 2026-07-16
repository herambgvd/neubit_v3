package sqlitestore

import (
	"context"
	"database/sql"

	"github.com/neubit/nvr/internal/store"
)

// ── audit_log (spec §4.13) ───────────────────────────────────────────────────
//
// Append-only local trail: every estate write handler records a row here so the
// appliance keeps a self-contained audit even when central is unreachable (SP3
// forwards these via the outbound queue).

// AppendAudit inserts an append-only audit row. TS defaults to now when the caller
// leaves it zero; Detail defaults to an empty JSON object.
func (d *DB) AppendAudit(ctx context.Context, e store.AuditEntry) error {
	_, err := d.rw.ExecContext(ctx, `
		INSERT INTO audit_log (ts, actor, actor_kind, action, target, detail, forwarded)
		VALUES (?,?,?,?,?,?,?)`,
		rfc(orNow(e.TS)), e.Actor, defaultStr(e.ActorKind, "system"), e.Action, e.Target,
		jsonText(e.Detail, "{}"), b2i(e.Forwarded),
	)
	return err
}

// ListAudit returns the most recent audit rows, newest first. A non-positive
// limit falls back to 100.
func (d *DB) ListAudit(ctx context.Context, limit int) ([]store.AuditEntry, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := d.ro.QueryContext(ctx, `
		SELECT id, ts, actor, actor_kind, action, target, detail, forwarded
		FROM audit_log ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]store.AuditEntry, 0, limit)
	for rows.Next() {
		var (
			e             store.AuditEntry
			ts            string
			actor, target sql.NullString
			detail        string
			forwarded     int
		)
		if err := rows.Scan(&e.ID, &ts, &actor, &e.ActorKind, &e.Action, &target, &detail, &forwarded); err != nil {
			return nil, err
		}
		e.TS = mustTime(ts)
		e.Actor = strPtr(actor)
		e.Target = strPtr(target)
		e.Detail = []byte(detail)
		e.Forwarded = forwarded == 1
		out = append(out, e)
	}
	return out, rows.Err()
}
