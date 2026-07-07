"""tenant scoping — add tenant_id row-scoping to the leaking tables

Security-critical Phase A of multi-tenancy: every previously global table that a
tenant-admin could read/write across tenants now carries a nullable ``tenant_id``:

    audit_log, report_jobs, roles, api_keys,
    app_settings, branding, channel_configs, email_templates

Semantics of ``tenant_id``:
  * NON-NULL  → the row belongs to exactly that tenant (tenant-scoped).
  * NULL      → the PLATFORM-DEFAULT / GLOBAL scope. For the singleton config
                tables (app_settings / branding / channel_configs / email_templates)
                a NULL row is the default a tenant falls back to when it has no
                own row. For roles, a NULL row is a shared SYSTEM role (the built-in
                Administrator) visible to every tenant.

Constraint changes for the config singletons: their old GLOBAL uniqueness
(app_settings.key PK, channel_configs.channel unique, email_templates.name unique)
would block a second tenant's row, so we rebuild those tables to key on a surrogate
``id`` and enforce PER-TENANT uniqueness (name/key/channel, tenant_id) via a unique
index instead. The batch_alter_table ``recreate`` path makes this run on SQLite
(table-copy) as well as Postgres.

Backfill (Python, against the seeded 'genius-vision' tenant):
  * roles (non-system), api_keys, audit_log, report_jobs rows that logically belong
    to a tenant are stamped with the Genius Vision tenant id. The shared system
    Administrator role stays NULL so every tenant can use it.
  * app_settings / branding / channel_configs / email_templates existing rows are
    LEFT NULL — they become the platform default all tenants inherit.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0007_tenant_scoping"
down_revision = "0006_tenant_license"
branch_labels = None
depends_on = None


# Tenant-OWNED tables: a plain nullable tenant_id column + index + FK (CASCADE on
# tenant delete, since the rows die with the tenant).
_OWNED = [
    ("audit_log", "fk_audit_log_tenant_id_tenants", "ix_audit_log_tenant_id"),
    ("report_jobs", "fk_report_jobs_tenant_id_tenants", "ix_report_jobs_tenant_id"),
    ("roles", "fk_roles_tenant_id_tenants", "ix_roles_tenant_id"),
    ("api_keys", "fk_api_keys_tenant_id_tenants", "ix_api_keys_tenant_id"),
]


def upgrade() -> None:
    bind = op.get_bind()

    # 1a. Tenant-owned tables: add the column, index, and CASCADE FK.
    for table, fk_name, ix_name in _OWNED:
        with op.batch_alter_table(table) as batch:
            batch.add_column(sa.Column("tenant_id", sa.Uuid(), nullable=True))
            batch.create_index(ix_name, ["tenant_id"])
            batch.create_foreign_key(
                fk_name, "tenants", ["tenant_id"], ["id"], ondelete="CASCADE"
            )

    # 1b. branding: no old unique constraint, just add the column + SET NULL FK.
    with op.batch_alter_table("branding") as batch:
        batch.add_column(sa.Column("tenant_id", sa.Uuid(), nullable=True))
        batch.create_index("ix_branding_tenant_id", ["tenant_id"])
        batch.create_foreign_key(
            "fk_branding_tenant_id_tenants", "tenants", ["tenant_id"], ["id"],
            ondelete="SET NULL",
        )

    # 1c. app_settings: drop the single-column ``key`` PK, add a surrogate ``id`` PK
    #     + tenant_id, and a per-tenant unique index on (key, tenant_id). Recreate so
    #     SQLite rebuilds the table with the new PK.
    with op.batch_alter_table("app_settings", recreate="always") as batch:
        batch.add_column(sa.Column("id", sa.Uuid(), nullable=True))
        batch.add_column(sa.Column("tenant_id", sa.Uuid(), nullable=True))
    # Give existing rows a surrogate id (they keep tenant_id NULL → the defaults).
    _backfill_ids(bind, "app_settings")
    with op.batch_alter_table("app_settings", recreate="always") as batch:
        batch.alter_column("id", existing_type=sa.Uuid(), nullable=False)
        batch.create_primary_key("pk_app_settings", ["id"])
        batch.create_index("ix_app_settings_key", ["key"])
        batch.create_index("ix_app_settings_tenant_id", ["tenant_id"])
        batch.create_index(
            "uq_app_settings_key_tenant", ["key", "tenant_id"], unique=True
        )
        batch.create_foreign_key(
            "fk_app_settings_tenant_id_tenants", "tenants", ["tenant_id"], ["id"],
            ondelete="SET NULL",
        )

    # 1d. channel_configs: drop the global unique on ``channel``, add tenant_id +
    #     a per-tenant unique index on (channel, tenant_id).
    with op.batch_alter_table("channel_configs", recreate="always") as batch:
        batch.add_column(sa.Column("tenant_id", sa.Uuid(), nullable=True))
        batch.create_index("ix_channel_configs_channel", ["channel"])
        batch.create_index("ix_channel_configs_tenant_id", ["tenant_id"])
        batch.create_index(
            "uq_channel_configs_channel_tenant", ["channel", "tenant_id"], unique=True
        )
        batch.create_foreign_key(
            "fk_channel_configs_tenant_id_tenants", "tenants", ["tenant_id"], ["id"],
            ondelete="SET NULL",
        )

    # 1e. email_templates: drop the global unique on ``name``, add tenant_id +
    #     a per-tenant unique index on (name, tenant_id).
    with op.batch_alter_table("email_templates", recreate="always") as batch:
        batch.add_column(sa.Column("tenant_id", sa.Uuid(), nullable=True))
        batch.create_index("ix_email_templates_name", ["name"])
        batch.create_index("ix_email_templates_tenant_id", ["tenant_id"])
        batch.create_index(
            "uq_email_templates_name_tenant", ["name", "tenant_id"], unique=True
        )
        batch.create_foreign_key(
            "fk_email_templates_tenant_id_tenants", "tenants", ["tenant_id"], ["id"],
            ondelete="SET NULL",
        )

    # 2. Backfill the tenant-owned tables against the seeded Genius Vision tenant.
    #    On a fresh DB (tenant not yet seeded) there is nothing to backfill — the
    #    seeder runs on startup and the app stamps new rows.
    tenant_id = bind.execute(
        sa.text("SELECT id FROM tenants WHERE slug = :slug"),
        {"slug": "genius-vision"},
    ).scalar()
    if tenant_id is None:
        return

    # Non-system roles → Genius Vision; the shared system Administrator stays NULL.
    bind.execute(
        sa.text(
            "UPDATE roles SET tenant_id = :tid "
            "WHERE tenant_id IS NULL AND is_system = :false"
        ),
        {"tid": tenant_id, "false": False},
    )
    bind.execute(
        sa.text("UPDATE api_keys SET tenant_id = :tid WHERE tenant_id IS NULL"),
        {"tid": tenant_id},
    )
    bind.execute(
        sa.text("UPDATE audit_log SET tenant_id = :tid WHERE tenant_id IS NULL"),
        {"tid": tenant_id},
    )
    bind.execute(
        sa.text("UPDATE report_jobs SET tenant_id = :tid WHERE tenant_id IS NULL"),
        {"tid": tenant_id},
    )
    # Config singletons (app_settings/branding/channel_configs/email_templates) are
    # LEFT NULL on purpose — they are the platform-default rows tenants fall back to.


def _backfill_ids(bind, table: str) -> None:
    """Assign a fresh UUID to any row missing an ``id`` (portable across backends)."""
    import uuid

    rows = bind.execute(sa.text(f"SELECT key FROM {table} WHERE id IS NULL")).fetchall()
    for (key,) in rows:
        bind.execute(
            sa.text(f"UPDATE {table} SET id = :id WHERE key = :key AND id IS NULL"),
            {"id": str(uuid.uuid4()), "key": key},
        )


def downgrade() -> None:
    # Revert the config singletons to their global-unique shape.
    with op.batch_alter_table("email_templates", recreate="always") as batch:
        batch.drop_constraint("fk_email_templates_tenant_id_tenants", type_="foreignkey")
        batch.drop_index("uq_email_templates_name_tenant")
        batch.drop_index("ix_email_templates_tenant_id")
        batch.drop_index("ix_email_templates_name")
        batch.drop_column("tenant_id")
        batch.create_unique_constraint("uq_email_templates_name", ["name"])

    with op.batch_alter_table("channel_configs", recreate="always") as batch:
        batch.drop_constraint("fk_channel_configs_tenant_id_tenants", type_="foreignkey")
        batch.drop_index("uq_channel_configs_channel_tenant")
        batch.drop_index("ix_channel_configs_tenant_id")
        batch.drop_index("ix_channel_configs_channel")
        batch.drop_column("tenant_id")
        batch.create_unique_constraint("uq_channel_configs_channel", ["channel"])

    with op.batch_alter_table("app_settings", recreate="always") as batch:
        batch.drop_constraint("fk_app_settings_tenant_id_tenants", type_="foreignkey")
        batch.drop_index("uq_app_settings_key_tenant")
        batch.drop_index("ix_app_settings_tenant_id")
        batch.drop_index("ix_app_settings_key")
        batch.drop_constraint("pk_app_settings", type_="primary")
        batch.drop_column("tenant_id")
        batch.drop_column("id")
        batch.create_primary_key("pk_app_settings", ["key"])

    with op.batch_alter_table("branding") as batch:
        batch.drop_constraint("fk_branding_tenant_id_tenants", type_="foreignkey")
        batch.drop_index("ix_branding_tenant_id")
        batch.drop_column("tenant_id")

    for table, fk_name, ix_name in reversed(_OWNED):
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(fk_name, type_="foreignkey")
            batch.drop_index(ix_name)
            batch.drop_column("tenant_id")
