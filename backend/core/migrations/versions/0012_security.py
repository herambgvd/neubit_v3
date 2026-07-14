"""security — enterprise hardening tables (P6-D)

Revision ID: 0012_security
Revises: 0011_device_placements
Create Date: 2026-07-09

Adds the enterprise security surface on top of the auth hardening already in the
baseline (TOTP/lockout/password-policy) + the append-only audit_log:

  * security_policies   — per-tenant 2FA-enforcement (require_2fa + role narrowing).
  * directory_configs   — LDAP/AD server config (bind password Fernet-encrypted).
  * sso_configs         — OIDC IdP config (client secret Fernet-encrypted).
  * dual_auth_requests  — the four-eyes approval ledger for sensitive ops.

All TENANT-SCOPED (nullable tenant_id, NULL = platform/system row).

Created idempotently: the 0001 baseline builds the full current schema from the ORM
metadata (create_all), so on a fresh DB these tables already exist and each block is
a no-op. This migration exists for an EXISTING DB upgrading in place.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0012_security"
down_revision = "0011_device_placements"
branch_labels = None
depends_on = None


def _has_table(bind, name: str) -> bool:
    return sa.inspect(bind).has_table(name)


def upgrade() -> None:
    bind = op.get_bind()

    if not _has_table(bind, "security_policies"):
        op.create_table(
            "security_policies",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("require_2fa", sa.Boolean(), server_default=sa.text("false"), nullable=False),
            sa.Column("require_2fa_roles", sa.JSON(), nullable=False),
            sa.Column("session_idle_minutes", sa.Integer(), server_default=sa.text("0"), nullable=False),
            sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_security_policies"),
            sa.UniqueConstraint("tenant_id", name="uq_security_policies_tenant"),
        )
        op.create_index("ix_security_policies_tenant_id", "security_policies", ["tenant_id"])

    if not _has_table(bind, "directory_configs"):
        op.create_table(
            "directory_configs",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("name", sa.String(), nullable=False),
            sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("server_uri", sa.String(), nullable=False),
            sa.Column("base_dn", sa.String(), nullable=False),
            sa.Column("bind_dn", sa.String(), nullable=False),
            sa.Column("bind_password", sa.String(), nullable=True),
            sa.Column("use_ssl", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("user_dn_base", sa.String(), nullable=True),
            sa.Column("user_filter", sa.String(), nullable=False),
            sa.Column("email_attr", sa.String(), nullable=False),
            sa.Column("name_attr", sa.String(), nullable=False),
            sa.Column("group_attr", sa.String(), nullable=False),
            sa.Column("group_role_map", sa.JSON(), nullable=False),
            sa.Column("default_role", sa.String(), nullable=True),
            sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_directory_configs"),
            sa.UniqueConstraint("tenant_id", name="uq_directory_configs_tenant"),
        )
        op.create_index("ix_directory_configs_tenant_id", "directory_configs", ["tenant_id"])

    if not _has_table(bind, "sso_configs"):
        op.create_table(
            "sso_configs",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("provider", sa.String(), nullable=False),
            sa.Column("enabled", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("issuer", sa.String(), nullable=False),
            sa.Column("client_id", sa.String(), nullable=False),
            sa.Column("client_secret", sa.String(), nullable=True),
            sa.Column("scopes", sa.String(), nullable=False),
            sa.Column("redirect_uri", sa.String(), nullable=True),
            sa.Column("email_claim", sa.String(), nullable=False),
            sa.Column("name_claim", sa.String(), nullable=False),
            sa.Column("groups_claim", sa.String(), nullable=True),
            sa.Column("group_role_map", sa.JSON(), nullable=False),
            sa.Column("default_role", sa.String(), nullable=True),
            sa.Column("auto_provision", sa.Boolean(), server_default=sa.text("true"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_sso_configs"),
            sa.UniqueConstraint("tenant_id", name="uq_sso_configs_tenant"),
        )
        op.create_index("ix_sso_configs_tenant_id", "sso_configs", ["tenant_id"])

    if not _has_table(bind, "dual_auth_requests"):
        op.create_table(
            "dual_auth_requests",
            sa.Column("id", sa.Uuid(), nullable=False),
            sa.Column("tenant_id", sa.Uuid(), nullable=True),
            sa.Column("action", sa.String(), nullable=False),
            sa.Column("target_type", sa.String(), nullable=True),
            sa.Column("target_id", sa.String(), nullable=True),
            sa.Column("reason", sa.String(), nullable=True),
            sa.Column("payload", sa.JSON(), nullable=False),
            sa.Column("status", sa.String(), server_default=sa.text("'pending'"), nullable=False),
            sa.Column("requested_by", sa.Uuid(), nullable=True),
            sa.Column("requested_by_email", sa.String(), nullable=True),
            sa.Column("decided_by", sa.Uuid(), nullable=True),
            sa.Column("decided_by_email", sa.String(), nullable=True),
            sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("decision_note", sa.String(), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
            sa.PrimaryKeyConstraint("id", name="pk_dual_auth_requests"),
        )
        op.create_index("ix_dual_auth_requests_tenant_id", "dual_auth_requests", ["tenant_id"])
        op.create_index("ix_dual_auth_requests_action", "dual_auth_requests", ["action"])
        op.create_index("ix_dual_auth_requests_status", "dual_auth_requests", ["status"])
        op.create_index("ix_dual_auth_requests_created_at", "dual_auth_requests", ["created_at"])


def downgrade() -> None:
    bind = op.get_bind()
    for tbl in ("dual_auth_requests", "sso_configs", "directory_configs", "security_policies"):
        if _has_table(bind, tbl):
            op.drop_table(tbl)
