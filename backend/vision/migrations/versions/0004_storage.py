"""storage pools + tier rules (P3-B)

Revision ID: 0004_storage
Revises: 0003_recordings
Create Date: 2026-07-09

Adds the two P3-B tables:
  * ``storage_pools``     — where recorded segments live (local / nfs / smb / s3);
    secrets (SMB password, S3 secret key) stored REVERSIBLY ENCRYPTED.
  * ``storage_tier_rules`` — move recordings older than N hours source→target pool.

Tenant-scoped; plain-string ``pool_type`` / ``mount_state`` (no PG enum). The
``recordings`` table already carries ``storage_pool_id`` / ``checksum`` /
``integrity_status`` (P3-A) — P3-B just FILLS them.

Idempotent — ``Table.create(checkfirst=True)`` off the live model metadata (the v3
baseline pattern, matches ``0001``/``0002``/``0003``). A fresh deploy gets these
tables from the baseline sweep too (0001 lists them); this migration lands them on
already-deployed DBs.
"""

from alembic import op

revision = "0004_storage"
down_revision = "0003_recordings"
branch_labels = None
depends_on = None


def _tables():
    # Import here so the models register on Base.metadata at migration time.
    from app.vms.models import StoragePool, TierRule

    return [StoragePool.__table__, TierRule.__table__]


def upgrade() -> None:
    bind = op.get_bind()
    for table in _tables():
        table.create(bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(_tables()):
        table.drop(bind, checkfirst=True)
