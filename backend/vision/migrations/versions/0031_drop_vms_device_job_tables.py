"""drop export_jobs, motion_search_jobs, ptz_presets, ptz_patrols

Revision ID: 0031_drop_vms_device_job_tables
Revises: 0030_drop_stream_shards
Create Date: 2026-09-07

Four tables that backed work the VMS no longer does, because the recorder that owns
the footage does it instead.

``export_jobs`` + ``motion_search_jobs`` — both queues fed a VMS-side ffmpeg over the
recorder's /recordings volume. An export is cut from the SEGMENTS and a forensic
search DECODES them, so only the box that wrote them can do either; the VMS running
its own ffmpeg there made it a second writer on files it does not own, and produced
clips nothing could attest to. The recorder signs a chain-of-custody manifest for its
exports and bounds its own searches, neither of which a VMS queue could.

``ptz_presets`` + ``ptz_patrols`` — a preset lives in the CAMERA's firmware and a
patrol is driven by the recorder. These rows were a parallel catalogue: a preset row
with no device token was unrecallable, and the VMS's patrol cycler could step the same
head from a different stop list than the recorder's.

All four are empty in the live deployment. Guarded/idempotent both ways.

The downgrade recreates them from literal DDL, because the models are gone: it gets
the schema back, not the code that used it.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0031_drop_vms_device_job_tables"
down_revision = "0030_drop_stream_shards"
branch_labels = None
depends_on = None

_TABLES = ("export_jobs", "motion_search_jobs", "ptz_presets", "ptz_patrols")


def _has(table: str) -> bool:
    return sa.inspect(op.get_bind()).has_table(table)


def upgrade() -> None:
    for table in _TABLES:
        if _has(table):
            op.drop_table(table)


def downgrade() -> None:
    if not _has("export_jobs"):
        op.create_table(
            "export_jobs",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column(
                "camera_id",
                sa.String(length=36),
                sa.ForeignKey("cameras.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("from_time", sa.DateTime(timezone=True), nullable=False),
            sa.Column("to_time", sa.DateTime(timezone=True), nullable=False),
            sa.Column("format", sa.String(length=8), nullable=False, server_default=sa.text("'mp4'")),
            sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'queued'")),
            sa.Column("file_path", sa.String(length=1024), nullable=True),
            sa.Column("file_size", sa.BigInteger(), nullable=True),
            sa.Column("error", sa.String(length=2048), nullable=True),
            sa.Column("checksum", sa.String(length=64), nullable=True),
            sa.Column("signature", sa.String(length=128), nullable=True),
            sa.Column("manifest_path", sa.String(length=1024), nullable=True),
            sa.Column("watermark", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("requested_by", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_export_jobs_status_created", "export_jobs", ["status", "created_at"])
        op.create_index("ix_export_jobs_tenant_created", "export_jobs", ["tenant_id", "created_at"])
        op.create_index("ix_export_jobs_camera", "export_jobs", ["camera_id"])

    if not _has("motion_search_jobs"):
        op.create_table(
            "motion_search_jobs",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column(
                "camera_id",
                sa.String(length=36),
                sa.ForeignKey("cameras.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("from_time", sa.DateTime(timezone=True), nullable=False),
            sa.Column("to_time", sa.DateTime(timezone=True), nullable=False),
            sa.Column("regions", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("sensitivity", sa.Float(), nullable=False, server_default=sa.text("0.5")),
            sa.Column("sample_fps", sa.Float(), nullable=False, server_default=sa.text("4.0")),
            sa.Column("status", sa.String(length=16), nullable=False, server_default=sa.text("'queued'")),
            sa.Column("progress", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column("hits", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("note", sa.String(length=1024), nullable=True),
            sa.Column("error", sa.String(length=2048), nullable=True),
            sa.Column("requested_by", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        )
        op.create_index("ix_motion_search_status_created", "motion_search_jobs", ["status", "created_at"])
        op.create_index("ix_motion_search_tenant_created", "motion_search_jobs", ["tenant_id", "created_at"])
        op.create_index("ix_motion_search_camera", "motion_search_jobs", ["camera_id"])

    if not _has("ptz_presets"):
        op.create_table(
            "ptz_presets",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("camera_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("preset_token", sa.String(length=255), nullable=True),
            sa.Column("position", sa.JSON(), nullable=True),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_ptz_presets_tenant", "ptz_presets", ["tenant_id"])
        op.create_index("ix_ptz_presets_camera", "ptz_presets", ["camera_id"])
        op.create_index("ix_ptz_presets_tenant_camera", "ptz_presets", ["tenant_id", "camera_id"])

    if not _has("ptz_patrols"):
        op.create_table(
            "ptz_patrols",
            sa.Column("id", sa.String(length=36), primary_key=True),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("camera_id", sa.String(length=36), nullable=False),
            sa.Column("name", sa.String(length=255), nullable=False),
            sa.Column("stops", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
            sa.Column("speed", sa.Float(), nullable=False, server_default=sa.text("0.5")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("is_running", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("schedule", sa.JSON(), nullable=True),
            sa.Column("created_by", sa.String(length=36), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_ptz_patrols_tenant", "ptz_patrols", ["tenant_id"])
        op.create_index("ix_ptz_patrols_camera", "ptz_patrols", ["camera_id"])
        op.create_index("ix_ptz_patrols_tenant_camera", "ptz_patrols", ["tenant_id", "camera_id"])
