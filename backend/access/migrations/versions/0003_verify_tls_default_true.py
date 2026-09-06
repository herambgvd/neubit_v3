"""verify_tls defaults to TRUE for new controller instances

Revision ID: 0003_verify_tls_default_true
Revises: 0002_access_local_catalog
Create Date: 2026-09-06

verify_tls fed httpx's `verify=`, so a False default meant an encrypted but
unauthenticated link to the controller — an interceptor presents its own cert and
reads the Basic-auth password.

Existing rows are NOT flipped. Controllers are usually LAN boxes with self-signed
certs; changing live rows would break them at the next reconcile with no warning.
The connector logs a warning for each unprotected link instead.

So this only changes what a row inserted without the column gets.
"""

from alembic import op

revision = "0003_verify_tls_default_true"
down_revision = "0002_access_local_catalog"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE access_instances ALTER COLUMN verify_tls SET DEFAULT true")


def downgrade() -> None:
    op.execute("ALTER TABLE access_instances ALTER COLUMN verify_tls SET DEFAULT false")
