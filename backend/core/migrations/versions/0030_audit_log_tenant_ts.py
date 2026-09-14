"""audit_log: index (tenant_id, ts), drop the redundant index on tenant_id alone

Revision ID: 0030_audit_log_tenant_ts
Revises: 0029_widen_placement_device_id
Create Date: 2026-09-14

The retention sweep that purges audit entries now actually runs (app/retention.py;
before this change it had never executed). It deletes PER TENANT — `tenant_id = ?
AND ts < ?` — and audit_log had indexes on `id`, `ts` and `tenant_id` but nothing
on the pair. That is the one table in core designed to grow forever, so the purge
that exists to bound it would have been planned as a bitmap AND of two indexes, or
a scan by ts, every night on the whole retained table.

`ix_audit_log_tenant_id` is dropped with the same argument migration 0026 made for
`api_keys.prefix`: a composite index serves queries on its own leading column, so
keeping both means paying for two index writes per audited action to answer one
question. The scoped audit listing (`WHERE tenant_id = ? ORDER BY ts DESC`) is
strictly better off — it can now walk the composite instead of sorting.

CONCURRENTLY is deliberately NOT used. Alembic runs each migration inside a
transaction and CREATE INDEX CONCURRENTLY cannot run in one; core's audit_log is
small enough on an appliance that the exclusive lock is brief, and the migration
runs before the app comes up (see deploy's migrate step), not against live traffic.
"""

from alembic import op

revision = "0030_audit_log_tenant_ts"
down_revision = "0029_widen_placement_device_id"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_log_tenant_ts ON audit_log (tenant_id, ts)")
    op.execute("DROP INDEX IF EXISTS ix_audit_log_tenant_id")


def downgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_audit_log_tenant_id ON audit_log (tenant_id)")
    op.execute("DROP INDEX IF EXISTS ix_audit_log_tenant_ts")
