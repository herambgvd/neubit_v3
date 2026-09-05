"""drop the redundant non-unique index on api_keys.prefix

Revision ID: 0026_drop_redundant_prefix_index
Revises: 0025_role_name_per_tenant
Create Date: 2026-09-05

`api_keys.prefix` ended up with two indexes: `uq_api_keys_prefix` (unique, created
by 0023, and the one `authenticate_api_key` relies on) and `ix_api_keys_prefix`
(non-unique, created by the model's `index=True`). The second indexes nothing the
first does not, and its presence is what made the two descriptions of this column
disagree — the model said "indexed", the database said "unique".

The model now declares the unique index it actually has, so this drops the leftover.
`alembic check` comes back clean afterwards, which is the point: the one piece of
drift in this service was sitting on the credential lookup path, and drift that is
routinely ignored is drift that hides the next one.
"""

from alembic import op

revision = "0026_drop_redundant_prefix_index"
down_revision = "0025_role_name_per_tenant"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_api_keys_prefix")


def downgrade() -> None:
    op.execute("CREATE INDEX IF NOT EXISTS ix_api_keys_prefix ON api_keys (prefix)")
