"""Tenant offboard erasure — what core does to its OWN tables, and what it keeps.

WHY THIS FILE EXISTS

Core publishes ``tenant.<id>.tenant.offboarded`` when a super-admin deletes a
tenant, and every satellite reacts by wiping that tenant's rows from its own
database (``kernel.lifecycle.subscribe_tenant_offboard``, which walks every table
carrying a ``tenant_id``). Core does not consume its own event, so its own tables
were covered by exactly one mechanism: an ``ON DELETE CASCADE`` on a foreign key
to ``tenants``. 0022 noticed the hole while adding such a constraint to
``dashforge_embeds`` and wrote it down rather than hiding it:

    "core's own `sites` and `tags` carry a bare `tenant_id` and are erased by
     neither mechanism"

That was the service that OWNS tenancy exempting itself from the erase it demands
of everyone else, which is a DPDP right-to-erase failure in the worst possible
place. It was also an undercount. Enumerating the live schema rather than reading
the comment found **eleven** tables with a bare ``tenant_id``, four more that
carried an ``ON DELETE SET NULL`` (worse than no erase — see below), and three
that hold a tenant's people through a ``user_id`` with no foreign key at all and
are therefore invisible to a tenant_id sweep. sites and tags were two of the two
that happened to be visible from where 0022 was standing.

WHY A REGISTRY AND NOT A SWEEP

kernel's generic "delete every row whose table has a tenant_id" is right for a
satellite, whose tables are all one tenant's operational data. It is wrong here,
because core holds the two categories that a blanket delete gets wrong in
opposite directions:

  * data that a sweep MISSES because the tenant link is not a column named
    tenant_id — a user_id, or a uuid inside a string key, or an id inside a JSON
    array; and
  * data that MUST SURVIVE. Deleting a financial record or an audit trail because
    a script could not tell it apart from a preference blob is not compliance, it
    is a different violation, and it is one that destroys the evidence that the
    erasure itself was performed correctly.

So every table core owns is classified BY HAND with a written reason, and the
classification is enforced (see ``check_classification``): a table that appears
without one fails a test and refuses an offboard, rather than being silently
swept or silently skipped depending on which mechanism happened to see it.

THE DISPOSITIONS

  CASCADE        an FK to tenants with ON DELETE CASCADE already erases it. Not a
                 no-op classification: the check ASSERTS the constraint is really
                 there and really CASCADE, so a table cannot claim this and drift.
  ERASE          explicitly deleted, WHERE tenant_id = the tenant.
  ERASE_BY_USER  explicitly deleted by the tenant's user ids. These have no
                 tenant_id and no FK to users, so nothing else reaches them.
  ERASE_CUSTOM   the tenant reference is not a column value — it is inside a
                 string key or a JSON array — and a handler removes it.
  RETAIN         deliberately kept. A reason is mandatory and the reason has to be
                 a legal or evidential one, not "it seemed useful".
  PLATFORM       holds no tenant data at all. The check refuses this label on any
                 table that HAS a tenant_id, so it cannot be used to look away.
  SUBJECT        the ``tenants`` row itself, deleted last by the caller.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from typing import Callable

from sqlalchemy import delete, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

CASCADE = "cascade"
ERASE = "erase"
ERASE_BY_USER = "erase_by_user"
ERASE_CUSTOM = "erase_custom"
RETAIN = "retain"
PLATFORM = "platform"
SUBJECT = "subject"


@dataclass(frozen=True)
class Disposition:
    how: str
    why: str
    # ERASE_BY_USER only: the column holding a users.id.
    user_column: str | None = None
    # ERASE_CUSTOM only: async (session, tenant_id) -> rows affected.
    handler: Callable | None = None


async def _erase_alert_states(session: AsyncSession, tid: uuid.UUID) -> int:
    """``alert_states.alert_key`` is "license-expired:<tenant_id>" and friends.

    The tenant id is INSIDE a string, so no column-level sweep can see it and no
    constraint can reference it. What is left behind is a super-admin's
    read/dismissed flag on an alert about a tenant that no longer exists — not
    personal data of the tenant's people, but a dangling reference that will never
    match anything again, and precisely the kind of leftover that a generic
    mechanism is structurally incapable of finding. Erased for hygiene, and listed
    here so the next person to encode an id into a key knows this file is where
    the consequence gets handled.
    """
    from ..alerts.models import AlertState

    result = await session.execute(
        delete(AlertState).where(AlertState.alert_key.like(f"%:{tid}"))
    )
    return result.rowcount or 0


async def _scrub_broadcast_targets(session: AsyncSession, tid: uuid.UUID) -> int:
    """``broadcasts.target_tenant_ids`` is a JSON array of tenant ids.

    The broadcast itself is a PLATFORM record — a super-admin's message, not the
    tenant's data — so it is not deleted. But leaving the id in its target list
    keeps a reference to an erased tenant in a row that outlives it, and a
    re-issued uuid would silently address the wrong audience. The id is removed
    from the array and the broadcast survives.

    Read-modify-write rather than a JSON operator: the column is SQLAlchemy's
    portable ``JSON`` so the same code has to run on Postgres and on the SQLite the
    tests use, and the row count here is a handful.
    """
    from ..broadcasts.models import Broadcast

    changed = 0
    rows = (await session.execute(select(Broadcast))).scalars().all()
    for row in rows:
        targets = list(row.target_tenant_ids or [])
        kept = [t for t in targets if str(t) != str(tid)]
        if len(kept) != len(targets):
            row.target_tenant_ids = kept
            changed += 1
    return changed


async def _snapshot_and_retain_invoices(session: AsyncSession, tid: uuid.UUID) -> int:
    """Detach the retained invoices from the tenant about to be deleted.

    An invoice is kept (see RETENTION below) and its FK to ``tenants`` is gone as
    of 0024, so nothing removes it. But a retained financial record naming only a
    uuid that no longer resolves is not a usable record, so the tenant's NAME is
    snapshotted onto it here — at the one moment it is still readable — exactly as
    ``audit_log`` snapshots an actor's email so the trail survives the user.

    Done at erase time rather than at invoice creation on purpose: the invoice
    service is not touched by this commit, and the snapshot is only ever needed for
    a tenant that is going away.
    """
    from ..billing.models import Invoice
    from .models import Tenant

    tenant = await session.get(Tenant, tid)
    if tenant is None:
        return 0
    result = await session.execute(
        update(Invoice)
        .where(Invoice.tenant_id == tid, Invoice.tenant_name.is_(None))
        .values(tenant_name=tenant.name)
    )
    return result.rowcount or 0


# The classification. Every table core's metadata declares must appear here.
DISPOSITIONS: dict[str, Disposition] = {
    # --- the subject ------------------------------------------------------
    "tenants": Disposition(SUBJECT, "the row being deleted; the caller deletes it last"),

    # --- already erased by an ON DELETE CASCADE ---------------------------
    "users": Disposition(CASCADE, "the tenant's people; the FK cascade removes them"),
    "roles": Disposition(
        CASCADE,
        "custom roles carry the tenant_id; the built-in system roles carry NULL and "
        "are shared, so the cascade correctly leaves them alone",
    ),
    "api_keys": Disposition(CASCADE, "the tenant's service credentials"),
    "dashforge_embeds": Disposition(CASCADE, "which DashForge dashboards this tenant showed"),
    "security_policies": Disposition(CASCADE, "the tenant's 2FA-enforcement policy"),
    "directory_configs": Disposition(CASCADE, "the tenant's LDAP/AD binding, incl. a stored secret"),
    "sso_configs": Disposition(CASCADE, "the tenant's OIDC client, incl. a stored secret"),
    "billing_subscriptions": Disposition(
        CASCADE,
        "the tenant's CURRENT commercial state, which is not a financial record — "
        "the invoices are, and they are retained separately. Keeping a live "
        "subscription for a tenant that no longer exists would leave the billing "
        "run addressing a ghost",
    ),

    # --- erased because nothing else reaches them -------------------------
    # These carry a bare tenant_id: no FK, so no cascade, and core does not consume
    # its own offboard event, so no kernel sweep either. This is the set 0022's
    # comment named two members of.
    "sites": Disposition(ERASE, "the tenant's estate — named in 0022 as uncovered"),
    "floors": Disposition(ERASE, "floors of the tenant's sites; not even FK'd to sites"),
    "zones": Disposition(ERASE, "zones of the tenant's floors; not even FK'd to floors"),
    "device_placements": Disposition(
        ERASE, "where the tenant's devices sit on its floor plans — location data"
    ),
    "site_tariff_slabs": Disposition(ERASE, "the tenant's commercial energy tariffs"),
    "site_emission_factors": Disposition(ERASE, "the tenant's emission factors"),
    "tags": Disposition(ERASE, "the tenant's labels — named in 0022 as uncovered"),
    "tag_links": Disposition(
        ERASE,
        "what those labels were attached to. Cascades from tags anyway, but it "
        "carries its own tenant_id and a link whose tag is gone is still this "
        "tenant's data — erased on its own terms rather than as a side effect",
    ),
    "report_jobs": Disposition(
        ERASE, "the tenant's report runs, including the storage key of the output"
    ),
    "dual_auth_requests": Disposition(
        ERASE,
        "four-eyes requests: who asked for what, who approved it, and their emails. "
        "This is a record of decisions, but it is the TENANT's internal approval "
        "workflow, not a statutory record, and audit_log independently records the "
        "actions that were actually taken",
    ),

    # --- erased BECAUSE an ON DELETE SET NULL is worse than nothing --------
    # A SET NULL here does not orphan the row harmlessly: tenant_id NULL is this
    # schema's marker for a PLATFORM DEFAULT. So the tenant's branding, its SMTP
    # and webhook credentials, its integration settings and its customised email
    # copy would all SURVIVE the offboard and be promoted to the defaults every
    # other tenant inherits. That is a right-to-erase failure and a cross-tenant
    # leak in the same row. The explicit DELETE runs BEFORE the tenant row is
    # removed, so the SET NULL never gets the chance to fire.
    "branding": Disposition(ERASE, "the tenant's logo, colours and product name — SET NULL would promote them to the platform default"),
    "app_settings": Disposition(ERASE, "the tenant's integration settings, including stored secrets — SET NULL would promote them to the platform default"),
    "channel_configs": Disposition(ERASE, "the tenant's SMTP/webhook/push credentials — SET NULL would promote them to the platform default"),
    "email_templates": Disposition(ERASE, "the tenant's customised email copy — SET NULL would promote it to the platform default"),

    # --- erased through the tenant's users --------------------------------
    # No tenant_id, and — despite holding a user_id — no foreign key to users
    # either, so the cascade that removes the users leaves these behind. Invisible
    # to every mechanism that existed before this file.
    "notifications": Disposition(
        ERASE_BY_USER,
        "in-app notification bodies addressed to the tenant's people — content, "
        "not metadata",
        user_column="user_id",
    ),
    "device_tokens": Disposition(
        ERASE_BY_USER,
        "FCM push tokens for the tenant's people's personal phones. Left behind, "
        "these are live handles to a device belonging to someone whose account was "
        "erased",
        user_column="user_id",
    ),

    # --- erased by a handler, because the reference is not a column -------
    "alert_states": Disposition(
        ERASE_CUSTOM,
        "the tenant id is inside alert_key, where no sweep can see it",
        handler=_erase_alert_states,
    ),
    "broadcasts": Disposition(
        ERASE_CUSTOM,
        "a platform record that must survive, but its target_tenant_ids array must "
        "not keep pointing at an erased tenant",
        handler=_scrub_broadcast_targets,
    ),

    # --- RETAINED, deliberately -------------------------------------------
    "audit_log": Disposition(
        RETAIN,
        "The record of who did what, and the only evidence that this erasure was "
        "performed at all — the tenant.delete entry is written to it moments "
        "before this runs. An audit trail that a subject can delete by leaving is "
        "not an audit trail, and DPDP s.17(1) exempts processing necessary for "
        "compliance and for the enforcement of legal rights. It is NOT retained "
        "forever by omission: audit_log has its own retention policy "
        "(audit_retention_days, core/audit.py) and that policy — not tenant "
        "lifecycle — is the erasure path for it. The residual is named rather than "
        "hidden: these rows carry actor_email and actor_name, so a deleted "
        "tenant's staff remain identifiable in the trail until retention evicts "
        "them. Pseudonymising them instead was considered and rejected: it would "
        "destroy the trail's evidential value to solve a problem the retention "
        "policy already answers, and that is a decision for whoever sets the "
        "policy, not a rider on this commit",
    ),
    "billing_invoices": Disposition(
        RETAIN,
        "A financial record. India's Companies Act 2013 s.128(5) requires books of "
        "account to be preserved for eight years and the CGST Act s.36 for six, "
        "and DPDP s.8(7) makes retention required by law an exception to erasure. "
        "Destroying an issued invoice because its customer left is not compliance "
        "with one law, it is non-compliance with another. This one was ACTIVELY "
        "CHANGED to be retained: it carried ON DELETE CASCADE until 0024, i.e. the "
        "records were being destroyed. The tenant's NAME is snapshotted onto the "
        "surviving rows at erase time so the record stays attributable; the "
        "personal data that survives is a company name and an amount, which is "
        "exactly what the statute requires be kept and no more. "
        "billing_subscriptions is deliberately NOT retained with it — the live "
        "commercial relationship is not the record of it",
    ),

    # --- no tenant data ----------------------------------------------------
    "refresh_tokens": Disposition(PLATFORM, "FK users ON DELETE CASCADE; goes with the user"),
    "password_reset_tokens": Disposition(PLATFORM, "FK users ON DELETE CASCADE; goes with the user"),
    "billing_plans": Disposition(PLATFORM, "the platform's plan catalogue, identical for every tenant"),
    "modules": Disposition(PLATFORM, "the platform's module catalogue"),
    "device_brands": Disposition(PLATFORM, "the platform's supported-device catalogue"),
    "permission_registrations": Disposition(PLATFORM, "permission keys published by services, not by tenants"),
}


class UnclassifiedTable(RuntimeError):
    """A table core owns has no erasure disposition.

    Raised by the offboard path itself, not only by the test, and it ABORTS THE
    DELETE. That is deliberate and it is the fail-closed direction: refusing to
    offboard a tenant is loud, reversible and lands on whoever added the table,
    whereas erasing "everything the code happens to know about" quietly leaves the
    new table's rows behind forever and nobody finds out.
    """


def check_classification(metadata) -> None:
    """Assert every table core owns is classified, and that each claim is TRUE.

    Called by ``erase_tenant_data`` before it deletes anything, and by the test
    suite against metadata assembled by walking every ``app.*`` module — so a new
    models file cannot escape by simply not being imported anywhere the check can
    see it.

    The claims are verified, not trusted, because a disposition that is merely a
    string is a comment with extra steps:

      * CASCADE must have a real FK to tenants with ondelete=CASCADE. A table that
        says "the cascade handles it" and then loses its constraint in a refactor
        silently becomes uncovered, which is the exact 0022 failure.
      * PLATFORM must NOT have a tenant_id column. Without this, the cheapest way
        past a failing check is to relabel the new table as platform, and the
        mechanism becomes decorative.
      * RETAIN must carry a reason. Keeping personal data with no stated basis is
        the violation, not the absence of a delete statement.
    """
    problems: list[str] = []
    for table in metadata.sorted_tables:
        d = DISPOSITIONS.get(table.name)
        if d is None:
            problems.append(
                f"{table.name}: no erasure disposition. Add one to "
                f"app/tenancy/erasure.py:DISPOSITIONS saying whether a tenant's rows "
                f"are erased on offboard, and why."
            )
            continue
        has_tenant = "tenant_id" in table.c
        if d.how == PLATFORM and has_tenant:
            problems.append(
                f"{table.name}: classified PLATFORM but has a tenant_id column."
            )
        if d.how in (ERASE, CASCADE) and not has_tenant:
            problems.append(f"{table.name}: classified {d.how} but has no tenant_id column.")
        if d.how == CASCADE:
            fks = [
                fk
                for fk in table.foreign_keys
                if fk.parent.name == "tenant_id" and fk.column.table.name == "tenants"
            ]
            if not fks:
                problems.append(f"{table.name}: classified CASCADE but has no FK to tenants.")
            elif not any((fk.ondelete or "").upper() == "CASCADE" for fk in fks):
                problems.append(
                    f"{table.name}: classified CASCADE but its tenants FK is "
                    f"ondelete={fks[0].ondelete!r}, not CASCADE."
                )
        if d.how == ERASE_BY_USER and (
            not d.user_column or d.user_column not in table.c
        ):
            problems.append(
                f"{table.name}: classified ERASE_BY_USER but column "
                f"{d.user_column!r} is not on the table."
            )
        if d.how == ERASE_CUSTOM and d.handler is None:
            problems.append(f"{table.name}: classified ERASE_CUSTOM with no handler.")
        if d.how == RETAIN and not (d.why or "").strip():
            problems.append(f"{table.name}: classified RETAIN with no stated reason.")
    if problems:
        raise UnclassifiedTable(
            "core's tenant-erasure classification is incomplete or wrong:\n  - "
            + "\n  - ".join(problems)
        )


async def erase_tenant_data(db: AsyncSession, tenant_id: uuid.UUID) -> dict[str, int]:
    """Erase one tenant's rows from core's own tables. Returns {table: rows}.

    Runs INSIDE the caller's transaction and BEFORE the ``tenants`` row is
    deleted. Both matter:

      * before, because four tables carry ON DELETE SET NULL and a row that
        reaches that constraint is promoted to a platform default rather than
        removed. Deleting first means the constraint never fires;
      * inside, because a partially erased tenant that still exists is the worst
        outcome available, and the caller's commit is what makes it all-or-nothing.

    It does not touch the CASCADE tables — the constraint does that when the
    tenant row goes — and it does not touch the RETAIN tables except to snapshot
    the tenant's name onto the invoices that are about to lose their parent.
    """
    from ..auth.models import User
    from ..db.base import Base

    check_classification(Base.metadata)

    tid = uuid.UUID(str(tenant_id))
    removed: dict[str, int] = {}
    tables = {t.name: t for t in Base.metadata.sorted_tables}

    # The tenant's user ids, read BEFORE anything is deleted: the ERASE_BY_USER
    # tables have no FK to users, so once the cascade takes the users away there is
    # no way left to find their rows.
    user_ids = list(
        (await db.execute(select(User.id).where(User.tenant_id == tid))).scalars().all()
    )

    removed["billing_invoices"] = await _snapshot_and_retain_invoices(db, tid)

    for name, d in DISPOSITIONS.items():
        table = tables.get(name)
        if table is None:  # a classified table this deployment does not carry
            continue
        if d.how == ERASE:
            result = await db.execute(table.delete().where(table.c.tenant_id == tid))
            removed[name] = result.rowcount or 0
        elif d.how == ERASE_BY_USER:
            if not user_ids:
                removed[name] = 0
                continue
            col = table.c[d.user_column]
            result = await db.execute(table.delete().where(col.in_(user_ids)))
            removed[name] = result.rowcount or 0
        elif d.how == ERASE_CUSTOM:
            removed[name] = await d.handler(db, tid)
    return removed
