"""Widen alembic_version.version_num — 32 chars cannot hold our revision ids

Revision ID: 0020_widen_alembic_version
Revises: 0019_site_tariff_emissions
Create Date: 2026-09-01

Alembic creates its own bookkeeping table with ``version_num VARCHAR(32)`` —
hardcoded in ``alembic/ddl/impl.py`` (still true in 1.19), with no public knob
to change it. Our revision ids are the descriptive filenames, and
``0017_permission_registrations`` is already 29 characters: the next slightly
longer name overflows the column and the upgrade dies mid-flight with
``value too long for type character varying(32)`` (this actually happened; the
migration had to be renamed around it). Widen Alembic's own table to 255 so a
revision id can never overflow again.

Safe to run mid-chain: the ALTER executes inside the migration transaction, and
Alembic's own UPDATE of ``version_num`` for this and every later revision runs
after it on the same connection — longer ids then fit. Note this revision's own
id is deliberately ≤32 chars, as every id up to and including this one must be.

FRESH-DATABASE NOTE (the migrate.sh invariant): on a fresh database migrate.sh
takes the ``upgrade 0001 && stamp head`` branch, so this migration is STAMPED
but never RUN — and it is ``stamp`` itself that creates alembic_version, at
VARCHAR(32). ``alembic_version`` is not in the ORM metadata, so this is exactly
the "something create_all cannot reproduce" case the migrate.sh header warns
about. migrate.sh therefore finishes with an idempotent widen of its own (its
promised third branch); both paths land on VARCHAR(255).
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0020_widen_alembic_version"
down_revision = "0019_site_tariff_emissions"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(32),
        type_=sa.String(255),
        existing_nullable=False,
    )


def downgrade() -> None:
    # Only reachable while every applied revision id fits 32 chars — true by
    # construction when downgrading past this revision, since ids before it all fit.
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(255),
        type_=sa.String(32),
        existing_nullable=False,
    )
