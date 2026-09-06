"""Tenant offboard erasure — what core does to its own tables, and what it keeps.

Satellites erase a tenant with the kernel's generic "delete every row whose table
has a tenant_id" sweep. Core cannot use that: some of its tables link to a tenant
by something other than a tenant_id column (a user_id, a uuid inside a string
key, an id inside a JSON array), and some must survive an erase for legal
reasons. So every table core owns is classified by hand below with a reason, and
``check_classification`` enforces it — an unclassified table fails a test and
refuses the offboard rather than being silently swept or silently skipped.

The dispositions:

  CASCADE        an FK to tenants with ON DELETE CASCADE already erases it. The
                 check asserts the constraint is really there and really CASCADE.
  ERASE          deleted explicitly, WHERE tenant_id = the tenant.
  ERASE_BY_USER  deleted by the tenant's user ids; these have no tenant_id and no
                 FK to users, so nothing else reaches them.
  ERASE_CUSTOM   the tenant reference is inside a string key or a JSON array, and
                 a handler removes it.
  RETAIN         deliberately kept. A legal or evidential reason is mandatory.
  PLATFORM       holds no tenant data. The check refuses this label on a table
                 that has a tenant_id, so it cannot be used to look away.
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

    The id is inside a string, so no column sweep sees it and no constraint
    reaches it. Erased for hygiene: what is left otherwise is a super-admin's
    dismissed flag pointing at a tenant that no longer exists.
    """
    from ..alerts.models import AlertState

    result = await session.execute(
        delete(AlertState).where(AlertState.alert_key.like(f"%:{tid}"))
    )
    return result.rowcount or 0


async def _scrub_broadcast_targets(session: AsyncSession, tid: uuid.UUID) -> int:
    """``broadcasts.target_tenant_ids`` is a JSON array of tenant ids.

    The broadcast is a platform record and survives; only the id is dropped from
    its target list, so a re-issued uuid cannot silently address the wrong
    audience. Read-modify-write rather than a JSON operator because the column is
    SQLAlchemy's portable ``JSON`` and has to run on the SQLite the tests use.
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
    """Snapshot the tenant's name onto the invoices that will outlive it.

    Invoices are RETAIN and have no FK to ``tenants``, so a retained financial
    record would name only a uuid that no longer resolves. Same trick as
    ``audit_log`` snapshotting an actor's email. Done at erase time because it is
    only ever needed for a tenant that is going away.
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
    # its own offboard event, so no kernel sweep either.
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

    # --- erased because an ON DELETE SET NULL is worse than nothing --------
    # tenant_id NULL marks a platform default in this schema, so a SET NULL would
    # promote the tenant's branding, credentials and email copy to the defaults
    # every other tenant inherits — a right-to-erase failure and a cross-tenant
    # leak in one row. The explicit DELETE runs before the tenant row goes, so the
    # constraint never fires.
    "branding": Disposition(ERASE, "the tenant's logo, colours and product name — SET NULL would promote them to the platform default"),
    "app_settings": Disposition(ERASE, "the tenant's integration settings, including stored secrets — SET NULL would promote them to the platform default"),
    "channel_configs": Disposition(ERASE, "the tenant's SMTP/webhook/push credentials — SET NULL would promote them to the platform default"),
    "email_templates": Disposition(ERASE, "the tenant's customised email copy — SET NULL would promote it to the platform default"),

    # --- erased through the tenant's users --------------------------------
    # No tenant_id, and no FK to users despite holding a user_id, so the cascade
    # that removes the users leaves these behind.
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

    Raised by the offboard path, not only by the test, and it aborts the delete.
    Fail closed on purpose: refusing to offboard is loud and reversible, whereas
    erasing only what the code happens to know about leaves the new table's rows
    behind forever and nobody finds out.
    """


def check_classification(metadata) -> None:
    """Assert every table core owns is classified, and that each claim is true.

    Called by ``erase_tenant_data`` before it deletes anything, and by the test
    suite against metadata assembled by walking every ``app.*`` module, so a new
    models file cannot escape by not being imported anywhere the check can see it.

    The claims are verified, not trusted:

      * CASCADE must have a real FK to tenants with ondelete=CASCADE, or a table
        that loses its constraint in a refactor silently becomes uncovered.
      * PLATFORM must not have a tenant_id column, or relabelling a table is the
        cheapest way past a failing check.
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

    Must run inside the caller's transaction and before the ``tenants`` row is
    deleted: before, because four tables carry ON DELETE SET NULL and would be
    promoted to platform defaults rather than removed; inside, so a failure cannot
    leave a half-erased tenant behind.

    It leaves the CASCADE tables to the constraint, and the RETAIN tables alone
    apart from snapshotting the tenant name onto the invoices.
    """
    from ..auth.models import User
    from ..db.base import Base

    check_classification(Base.metadata)

    tid = uuid.UUID(str(tenant_id))
    removed: dict[str, int] = {}
    tables = {t.name: t for t in Base.metadata.sorted_tables}

    # Read before anything is deleted: the ERASE_BY_USER tables have no FK to
    # users, so once the cascade takes the users away their rows are unfindable.
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
