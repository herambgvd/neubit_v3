"""merge security + alerts heads

Revision ID: 0014_merge_security_alerts
Revises: 0012_security, 0013_alerts_broadcasts
Create Date: 2026-07-14

Reconciles the two migration heads that diverged when the ``feat/vms`` branch
(which added ``0012_security`` off ``0011_device_placements``) was merged into
the main line (``0012_billing`` -> ``0013_alerts_broadcasts``). Pure merge node:
no schema changes of its own.
"""

from __future__ import annotations

revision = "0014_merge_security_alerts"
down_revision = ("0012_security", "0013_alerts_broadcasts")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
