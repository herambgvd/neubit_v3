"""verify_tls defaults to TRUE for new controller instances

Revision ID: 0003_verify_tls_default_true
Revises: 0002_access_local_catalog
Create Date: 2026-09-06

`access_instances.verify_tls` defaulted to false, and the value goes straight to
``httpx.AsyncClient(verify=...)``. So an operator who never thought about TLS got a
connection to their access controller that was encrypted but UNAUTHENTICATED —
anything able to intercept it presents its own certificate and reads the Basic-auth
password in the clear.

EXISTING ROWS ARE NOT TOUCHED, and that is the whole decision in this file. An
access controller is usually a box on a building LAN with a self-signed
certificate; flipping live rows to true would break every one of those deployments
at the next reconcile, with no operator action and no warning. The insecure state
is now VISIBLE instead — `connectors/factory.py` logs a warning every time it
builds a connector over plain HTTP or with verification off — and an operator can
fix each instance deliberately.

So this changes exactly one thing: what a row inserted without the column gets.
The service always sets it explicitly from the request schema (also now true), so
in practice this keeps the model, the database and the API telling the same story.
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
