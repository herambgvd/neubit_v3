"""tenant offboard: erase what must go, and stop destroying what must stay

Revision ID: 0024_tenant_erasure
Revises: 0023_scoped_api_keys
Create Date: 2026-09-05

0022 found this and stated it rather than hiding it:

    "core's own `sites` and `tags` carry a bare `tenant_id` and are erased by
     neither mechanism"

— neither the FK cascade, nor ``kernel.lifecycle.subscribe_tenant_offboard``,
because core PUBLISHES the offboard event and does not consume its own. The
service that owns tenancy was exempt from the erase it demands of every
satellite.

It was an undercount, and only because the comment named the two tables it
happened to be looking at. Enumerating the live schema found:

  * ELEVEN tables with a bare tenant_id and no FK at all — sites, floors, zones,
    device_placements, site_tariff_slabs, site_emission_factors, tags, tag_links,
    report_jobs, dual_auth_requests, audit_log;
  * FOUR carrying ON DELETE **SET NULL** — branding, app_settings,
    channel_configs, email_templates. This is worse than no erase, not a milder
    version of it: tenant_id NULL is this schema's marker for a PLATFORM DEFAULT,
    so an offboarded tenant's logo, its customised email copy, its integration
    settings and its stored SMTP / webhook credentials would all SURVIVE and be
    promoted to the defaults every other tenant inherits. A right-to-erase failure
    and a cross-tenant leak in one row;
  * THREE with no tenant_id at all that nonetheless hold the tenant's people —
    notifications and device_tokens (user_id, and despite the name NOT foreign
    keys, so the cascade that removes the users leaves them behind) and
    alert_states (the tenant's uuid inside a string ``alert_key``). Invisible to
    any mechanism that looks for a column called tenant_id, which is every
    mechanism that existed.

The erase itself is code, not schema — ``app/tenancy/erasure.py``, run inside the
same transaction as the tenant delete and BEFORE it, so the SET NULL constraints
never fire. This migration is the two things that had to change in the DATABASE.

── 1. billing_invoices STOPS BEING CASCADE-DELETED ───────────────────────────

"Delete everything" is not automatically right, and this is the table where it was
wrong. ``billing_invoices.tenant_id`` was an FK with ON DELETE CASCADE, so
offboarding a tenant DESTROYED its issued invoices — books of account that the
Companies Act 2013 s.128(5) requires be preserved for eight years and the CGST Act
s.36 for six. DPDP s.8(7) makes retention required by law an exception to erasure,
so keeping them is not a hole in the right-to-erase; deleting them was a different
violation wearing compliance's clothes, and one that also destroys the evidence a
tax authority would ask for.

So the constraint is DROPPED and tenant_id stays as a bare, indexed column. The
cost — nothing enforces the reference any more — is paid deliberately and offset
by ``tenant_name``, snapshotted onto the row at offboard so a retained financial
record still names a real party. That is the device audit_log already uses to stay
readable after a user is deleted, reused rather than invented.

What survives is a company name, an invoice number and an amount. That is what the
statute requires be kept, and no more: nothing about the tenant's people, its
sites, its devices or its readings is in this table.

``billing_subscriptions`` keeps its CASCADE and is deliberately NOT retained with
it. A subscription is the live commercial relationship, not the record of it; the
invoices are the record, and a subscription still addressing a tenant that no
longer exists would be picked up by the next billing run.

``audit_log`` is the other RETAIN and needs no migration — it has never had an FK,
so it already survives. What changes is that its survival is now a decision with a
reason attached (erasure.py) instead of an accident of a missing constraint. Its
erasure path is its own retention policy (``audit_retention_days``), not tenant
lifecycle, and the residual is named there: these rows carry actor_email and
actor_name, so a departed tenant's staff stay identifiable until retention evicts
them. Pseudonymising was considered and rejected — it destroys the trail's
evidential value to solve something the retention policy already answers, and that
is a call for whoever sets the policy, not a rider on this.

── 2. WHY THERE IS NO NEW CONSTRAINT FOR THE ELEVEN ──────────────────────────

The obvious fix — give every bare tenant_id an ON DELETE CASCADE — was rejected.
It would work for the eleven and do nothing at all for the three that have no
tenant_id, which are the ones most likely to be missed next time precisely because
they are invisible; and it would make the SET NULL group's promotion-to-default
problem harder to see rather than easier, by making the whole area look handled.
More importantly it cannot express RETAIN: a constraint has no vocabulary for "this
one stays, and here is the statute". So the erase is an explicit, classified,
reviewed list, and the guard against the next table is a check that every table is
CLASSIFIED — which fails a test AND refuses an offboard, rather than quietly
sweeping or quietly skipping depending on which mechanism happened to see it.

No data is moved and no row is deleted by this migration. On the live stack
billing_invoices held 0 rows when it was written.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0024_tenant_erasure"
down_revision = "0023_scoped_api_keys"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("billing_invoices", sa.Column("tenant_name", sa.String(), nullable=True))
    # Named constraint drop: the name is Postgres's default for this FK and is what
    # `\d billing_invoices` shows. If a deployment renamed it, this fails loudly
    # rather than leaving the cascade in place while reporting success — which for
    # this particular constraint means silently still destroying invoices.
    op.drop_constraint(
        "billing_invoices_tenant_id_fkey", "billing_invoices", type_="foreignkey"
    )


def downgrade() -> None:
    # Restoring the FK re-arms the cascade that destroys invoices, and it will FAIL
    # outright if any retained row names a tenant that no longer exists — which is
    # the state this migration exists to create. That is correct: going back means
    # deciding what to do with the records that were kept, and a migration must not
    # make that decision by deleting them.
    op.create_foreign_key(
        "billing_invoices_tenant_id_fkey",
        "billing_invoices",
        "tenants",
        ["tenant_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.drop_column("billing_invoices", "tenant_name")
