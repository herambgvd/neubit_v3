"""signed-export columns on export_jobs + report_schedules table (P6-B)

Revision ID: 0010_signed_export_reports
Revises: 0009_linkage_rules
Create Date: 2026-07-09

Two changes for tamper-proof signed export + operational reporting:

  1. ``export_jobs`` gains ``checksum`` (SHA-256 hex), ``signature`` (base64 Ed25519 sig
     over the manifest), ``manifest_path`` (the ``<job>.manifest.json`` sidecar path), and
     ``watermark`` (whether the clip was re-encoded with a visible drawtext overlay). Each
     ADD COLUMN is inspector-guarded → idempotent + safe to re-run.
  2. ``report_schedules`` — the recurring operational-report table (kind + cadence +
     recipients + filters). Created off the live model metadata (checkfirst=True), the
     v3 baseline pattern (matches 0001-0009).

Idempotent throughout. A fresh deploy gets the columns + table from the 0001 baseline
sweep (both list them); this migration lands them on already-deployed DBs.
"""

from alembic import op
from sqlalchemy import inspect

revision = "0010_signed_export_reports"
down_revision = "0009_linkage_rules"
branch_labels = None
depends_on = None


def _has_column(bind, table: str, column: str) -> bool:
    insp = inspect(bind)
    try:
        return column in {c["name"] for c in insp.get_columns(table)}
    except Exception:  # noqa: BLE001 — table may not exist on a truly fresh DB
        return False


def _export_columns():
    import sqlalchemy as sa

    return [
        ("checksum", sa.Column("checksum", sa.String(64), nullable=True)),
        ("signature", sa.Column("signature", sa.String(128), nullable=True)),
        ("manifest_path", sa.Column("manifest_path", sa.String(1024), nullable=True)),
        (
            "watermark",
            sa.Column(
                "watermark", sa.Boolean(), nullable=False, server_default=sa.text("false")
            ),
        ),
    ]


def _report_table():
    from app.vms.models import ReportSchedule

    return ReportSchedule.__table__


def upgrade() -> None:
    bind = op.get_bind()
    # 1. export_jobs signing columns (idempotent).
    for name, col in _export_columns():
        if not _has_column(bind, "export_jobs", name):
            op.add_column("export_jobs", col)
    # 2. report_schedules table (idempotent off the model metadata).
    _report_table().create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    _report_table().drop(bind, checkfirst=True)
    for name, _col in reversed(_export_columns()):
        if _has_column(bind, "export_jobs", name):
            op.drop_column("export_jobs", name)
