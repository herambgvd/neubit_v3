"""audit_log is indexed on the shape its purge and its listing actually filter on.

The retention sweep deletes per tenant — `tenant_id = ? AND ts < ?` — and the audit
screen lists one tenant's rows newest-first. The table had indexes on `id`, `ts` and
`tenant_id` and nothing on the pair, on the one table in core designed to grow
forever and the one the nightly purge exists to bound.

The model and the database have to say the same thing, so this checks both halves:
the declaration, and the migration that puts it there on an existing install. A
composite declared only in the model is a fresh-install-only index, and every
appliance already in the field is exactly the case that needs it.
"""


from pathlib import Path

from app.core.audit import AuditLog

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations" / "versions"


def _index_columns() -> set[tuple[str, ...]]:
    return {tuple(c.name for c in ix.columns) for ix in AuditLog.__table__.indexes}


def test_the_model_declares_the_composite_the_purge_filters_on():
    assert ("tenant_id", "ts") in _index_columns()


def test_the_redundant_single_column_index_is_gone():
    """A composite serves queries on its own leading column, so keeping both means
    two index writes per audited action to answer one question."""
    assert ("tenant_id",) not in _index_columns()


def test_a_migration_carries_it_to_an_existing_database():
    sql = "\n".join(p.read_text() for p in MIGRATIONS.glob("*.py"))
    assert "ix_audit_log_tenant_ts ON audit_log (tenant_id, ts)" in sql
    assert "DROP INDEX IF EXISTS ix_audit_log_tenant_id" in sql
