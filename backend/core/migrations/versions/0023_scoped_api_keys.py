"""api_keys becomes a scoped service credential; audit_log learns what an actor IS

Revision ID: 0023_scoped_api_keys
Revises: 0022_dashforge_embeds
Create Date: 2026-09-05

WHY THIS EXISTS

DashForge — a peer product, its own repo — reads this platform's BI data through
``POST /api/v1/bi/query``. It authenticates with ``NEUBIT_BI_USER`` and
``NEUBIT_BI_PASSWORD``: a service account's EMAIL AND PASSWORD, encrypted at
rest, exchanged for a 12-hour access token and re-exchanged on 401. Its own
connector says why, and says it as a limitation of THIS platform rather than a
choice of its own:

    "NeuBit has no API-key facility -- `kernel.auth.verify_token` accepts only an
     access JWT minted by core's /auth/login"

That was accurate. A password is the wrong credential for a machine in four ways
that no amount of care at the far end can fix: it opens the console UI, it cannot
be narrowed to "read BI", revoking it means disabling a human account, and in the
audit trail it is indistinguishable from a person at a keyboard. This migration is
the storage half of the credential that replaces it.

NOTHING IS MIGRATED, BECAUSE THERE IS NOTHING TO MIGRATE

``api_keys`` held 0 rows on the live stack when this was written (checked before
anything was altered) and no route in any of the nine backends depended on the
``get_api_key`` header dependency that read it, so the table authorized nothing.
That is what makes the column changes below safe to make in place instead of
building a second table beside it. A second table would have been worse than the
work it saved: two things called "API key", one scoped and one role-powered,
sitting next to each other for someone to pick the wrong one out of.

THE ONE THING THAT CANNOT BE CARRIED FORWARD is the old key FORMAT — ``vz_`` plus
a secret, with the first 11 characters kept as the lookup prefix, i.e. the handle
printed in every listing was a slice of the secret itself. Any such key is
unverifiable after this (``security.api_key_prefix`` refuses the shape), which
costs nothing here and would cost a re-issue on an installation that had them.
Two live formats were rejected on purpose: the branch that decides between them
is exactly where a fail-open gets written.

WHAT ``scopes`` IS FOR, AND WHY NOT ``role_id``

``role_id`` stays, nullable, unread. A role is a LIVING set — someone widens
"Analyst" next quarter and every key wearing it widens with it, silently, which is
how a BI reader becomes able to create users. ``scopes`` is a snapshot taken when
a human decided what this credential is for, and it changes only when a human
changes it. Creating a key from a role still works and copies that role's
permissions INTO scopes at that moment; naming the Administrator role is refused,
because it would resolve to the wildcard, and an unbounded machine credential is
what this replaces rather than a way of configuring it.

WHY ``audit_log.actor_type`` IS IN THE SAME MIGRATION

Because a credential that cannot be told apart from a person in the trail has not
actually solved the problem it was built for, and the two columns have to land
together or there is a window in which keys exist and the trail cannot say so.
The existing snapshot columns cannot carry it: a key has no email, and a key NAMED
"DashForge BI reader" appearing in ``actor_name`` beside real names is a row that
reads like a person with an odd name.

Backfill: every existing row becomes 'user' via the server default, EXCEPT rows
with no actor at all, which become 'system' — that is what they always meant, and
the column is the first place it could be said. (On the live stack: 393 rows, 0 of
them actor-less, so the UPDATE below is a no-op there and is written for the
installations where it is not.)
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0023_scoped_api_keys"
down_revision = "0022_dashforge_embeds"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- api_keys: the scoped service credential ---------------------------
    op.add_column(
        "api_keys",
        # NOT NULL with an empty default. An empty scope list grants NOTHING —
        # ``ApiKey.grants`` is a plain membership test with no wildcard branch —
        # so a row that somehow arrives without scopes is inert rather than
        # permissive. Nullable would have made "no scopes" and "scopes unknown"
        # the same value, and only one of those is safe to treat as deny.
        sa.Column("scopes", sa.JSON(), nullable=False, server_default=sa.text("'[]'")),
    )
    op.add_column("api_keys", sa.Column("description", sa.String(), nullable=True))
    # Expiry an operator sets, and the revocation instant. ``revoked_at`` is
    # separate from the existing ``is_active`` because "when did this credential
    # stop being trusted" is the question an incident asks and a boolean cannot
    # answer.
    op.add_column("api_keys", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("api_keys", sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True))
    # Who minted it. The audit trail records what a key DID; this records who
    # created it, which is the other half of the question and is not recoverable
    # from the trail once the creating admin has left. Deliberately NOT an FK to
    # users: the answer must survive that admin being deleted, exactly as
    # audit_log's actor snapshot does.
    op.add_column("api_keys", sa.Column("created_by", sa.Uuid(), nullable=True))
    # role_id becomes nullable — every key created from here on stores NULL.
    op.alter_column("api_keys", "role_id", existing_type=sa.Uuid(), nullable=True)
    # The prefix is now a dedicated id segment carrying no secret material, and it
    # is what every exchange looks a key up by. UNIQUE so a collision is a failed
    # INSERT rather than an ambiguous lookup: ``authenticate_api_key`` uses
    # scalar_one_or_none, which would raise on two rows — a 500 instead of a 401,
    # on the one endpoint where the difference is information.
    op.create_index("uq_api_keys_prefix", "api_keys", ["prefix"], unique=True)

    # --- audit_log: what kind of actor wrote this row ----------------------
    op.add_column(
        "audit_log",
        sa.Column("actor_type", sa.String(length=16), nullable=False, server_default="user"),
    )
    op.execute("UPDATE audit_log SET actor_type = 'system' WHERE actor_id IS NULL")


def downgrade() -> None:
    op.drop_column("audit_log", "actor_type")
    op.drop_index("uq_api_keys_prefix", table_name="api_keys")
    # role_id back to NOT NULL would fail on any scoped key (they store NULL), so
    # the downgrade DELETES them. That is destructive and is the honest thing for
    # this direction to be: a scoped key cannot be represented by the schema it is
    # going back to, and leaving rows behind that the old code would authorize
    # with a NULL role is worse than losing them. Reverting means re-issuing.
    op.execute("DELETE FROM api_keys WHERE role_id IS NULL")
    op.alter_column("api_keys", "role_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_column("api_keys", "created_by")
    op.drop_column("api_keys", "revoked_at")
    op.drop_column("api_keys", "expires_at")
    op.drop_column("api_keys", "description")
    op.drop_column("api_keys", "scopes")
