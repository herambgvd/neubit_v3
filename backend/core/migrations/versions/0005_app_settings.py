"""app_settings — create the admin-editable key/value settings table

The settings model (`edge.settings.models.AppSetting`) was accidentally left out
of the 0001 baseline's metadata imports, so `app_settings` was never created and
`GET /api/v1/settings/public` 500'd with UndefinedTableError. The baseline is now
fixed for fresh installs; this forward migration creates the table on databases
that already ran the incomplete baseline.

Idempotent: `create(..., checkfirst=True)` is a no-op when the table already
exists (e.g. on a fresh DB where the corrected baseline created it).
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "0005_app_settings"
down_revision = "0004_tenancy"
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.db.base import Base
    import app.settings.models  # noqa: F401  registers app_settings on metadata

    Base.metadata.tables["app_settings"].create(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    from app.db.base import Base
    import app.settings.models  # noqa: F401

    Base.metadata.tables["app_settings"].drop(op.get_bind(), checkfirst=True)
