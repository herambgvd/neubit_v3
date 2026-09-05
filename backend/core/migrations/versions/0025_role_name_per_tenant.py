"""role names are unique PER TENANT, not across the platform

Revision ID: 0025_role_name_per_tenant
Revises: 0024_tenant_erasure
Create Date: 2026-09-05

``roles.name`` carried a plain ``UNIQUE (name)``. auth/service.py wrote the
tradeoff down at the time ("Per-tenant name reuse would need a composite unique +
migration; not required here"), and it has since become required, because a global
name is a cross-tenant coupling on a per-tenant table:

  * The first tenant to create "Analyst" takes the name away from every other
    tenant on the platform, permanently.
  * The second tenant is told "a role with this name already exists" about a row
    it cannot see in any listing — an existence oracle for another tenant's data,
    and the one place core answers CONFLICT where it answers NOT_FOUND everywhere
    else precisely to avoid that.

The new key is ``(tenant_id, name)`` with **NULLS NOT DISTINCT**, so the shared
system roles (tenant_id NULL) still collide with each other and there can be only
one platform-wide "Administrator". Without that clause Postgres treats every NULL
as distinct and the shared namespace would lose its uniqueness entirely — the same
reasoning as workflow's 0007_one_initial_state.

NULLS NOT DISTINCT needs Postgres 15+. The stack runs 16; the guard below fails
the migration with a readable message rather than silently creating an index that
does not hold what this file says it holds.

Nothing is dropped or rewritten: the constraint is swapped, rows are untouched.
Existing data cannot violate the new key, because the old key was strictly
stronger.
"""

from alembic import op
import sqlalchemy as sa

revision = "0025_role_name_per_tenant"
down_revision = "0024_tenant_erasure"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    if bind.dialect.server_version_info < (15,):
        raise RuntimeError(
            "0025 needs PostgreSQL 15+ for UNIQUE NULLS NOT DISTINCT; "
            f"this server is {bind.dialect.server_version_info}. Without it the shared "
            "(tenant_id NULL) role namespace would have no uniqueness at all."
        )
    # The constraint name Postgres generated for the original `unique=True`.
    op.execute("ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_name_key")
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_roles_tenant_name "
        "ON roles (tenant_id, name) NULLS NOT DISTINCT"
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute("DROP INDEX IF EXISTS uq_roles_tenant_name")
    # Only re-creatable if no two tenants have since reused a name. Left to fail
    # loudly if they have: silently dropping one tenant's role to restore a global
    # constraint would be data loss to satisfy a schema.
    op.execute("ALTER TABLE roles ADD CONSTRAINT roles_name_key UNIQUE (name)")
