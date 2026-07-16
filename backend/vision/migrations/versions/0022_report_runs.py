"""report_runs table — persist every scheduled report run (history + on-disk artefact)

Revision ID: 0022_report_runs
Revises: 0021_nvr_channels
Create Date: 2026-07-16

The recurring-report pipeline computed + rendered + notified but PERSISTED nothing —
scheduled reports vanished after sending, and large reports were truncated at the 256 KB
inline cap. This lands ``report_runs``: one row per fired schedule (or ad-hoc run) with
the rendered artefact written under the downloads volume (``output_path``), so past
reports keep history + a downloadable file. A compute failure still records a row
(``status='error'``) so failures surface in history.

Created off the live model metadata (checkfirst=True) — the v3 baseline pattern (matches
0001-0021); the two indexes defined on ``ReportRun.__table_args__`` are created with the
table. Idempotent. A fresh deploy gets the table from the 0001 baseline sweep (which also
lists it); this migration lands it on already-deployed DBs.
"""

from alembic import op

revision = "0022_report_runs"
down_revision = "0021_nvr_channels"
branch_labels = None
depends_on = None


def _report_run_table():
    from app.vms.models import ReportRun

    return ReportRun.__table__


def upgrade() -> None:
    bind = op.get_bind()
    _report_run_table().create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    _report_run_table().drop(bind, checkfirst=True)
