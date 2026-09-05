"""Tenant offboard erasure — the classification, and that it actually erases.

Two jobs, and the first is the more important one.

1. THE GUARD. ``test_every_table_core_owns_is_classified`` imports every module
   under ``app.`` by walking the package, then checks the resulting metadata. A
   table added next year is therefore covered whether or not anyone remembers this
   file exists, and — critically — whether or not anyone adds it to conftest's
   hand-written ``_import_all_models``, which already misses three modules
   (app.alerts, app.billing, app.broadcasts) and is exactly the kind of list that
   makes a completeness check incomplete. The failure message tells the author what
   to do.

2. THE BEHAVIOUR. The rest prove the classification is not merely present but
   true: erased tables are emptied, retained tables survive with their attribution
   intact, and the tables that no column-sweep can reach are reached.
"""

from __future__ import annotations

import importlib
import pkgutil
import uuid

import pytest

from app.tenancy.erasure import (
    DISPOSITIONS,
    ERASE,
    ERASE_BY_USER,
    ERASE_CUSTOM,
    PLATFORM,
    RETAIN,
    UnclassifiedTable,
    check_classification,
    erase_tenant_data,
)

pytestmark = pytest.mark.asyncio


def _metadata_of_every_module():
    """Base.metadata after importing EVERY app module, not a curated list.

    A hand-maintained import list can only be as complete as the last person to
    remember it, and this check's whole value is that it cannot be escaped by
    forgetting. Walking the package is the difference between "every table someone
    listed" and "every table there is".
    """
    import app
    from app.db.base import Base

    for mod in pkgutil.walk_packages(app.__path__, prefix="app."):
        # Only model-bearing modules matter, but importing broadly is the point:
        # a table declared in a router or a service file must not slip through
        # because its module was not named "models".
        try:
            importlib.import_module(mod.name)
        except Exception:  # noqa: BLE001 - a module that cannot import declares no table
            continue
    return Base.metadata


def test_every_table_core_owns_is_classified():
    """The regression guard. If this fails, a table was added without deciding
    what happens to a tenant's rows in it on offboard."""
    check_classification(_metadata_of_every_module())


def test_the_guard_actually_fails_on_an_unclassified_table():
    """A check that cannot fail is a comment. This proves it bites, using a table
    it has never seen rather than by mutating the real registry."""
    import sqlalchemy as sa

    md = sa.MetaData()
    sa.Table("tenants", md, sa.Column("id", sa.Uuid, primary_key=True))
    sa.Table(
        "some_table_added_next_year",
        md,
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("tenant_id", sa.Uuid),
    )
    with pytest.raises(UnclassifiedTable) as exc:
        check_classification(md)
    assert "some_table_added_next_year" in str(exc.value)
    assert "erasure.py" in str(exc.value)


def test_the_guard_refuses_the_cheap_way_out():
    """Relabelling a tenant table as PLATFORM must not silence the check —
    otherwise the mechanism is decorative and the first person under time pressure
    will find that out."""
    import sqlalchemy as sa

    from app.tenancy.erasure import Disposition

    md = sa.MetaData()
    sa.Table("tenants", md, sa.Column("id", sa.Uuid, primary_key=True))
    sa.Table(
        "pretend_platform",
        md,
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("tenant_id", sa.Uuid),
    )
    DISPOSITIONS["pretend_platform"] = Disposition(PLATFORM, "it is not")
    try:
        with pytest.raises(UnclassifiedTable, match="classified PLATFORM but has a tenant_id"):
            check_classification(md)
    finally:
        DISPOSITIONS.pop("pretend_platform")


def test_the_guard_verifies_a_cascade_claim_rather_than_trusting_it():
    """'The FK cascade handles it' is the claim that silently became false in the
    first place. A table that says CASCADE and has no such constraint must fail."""
    import sqlalchemy as sa

    from app.tenancy.erasure import CASCADE, Disposition

    md = sa.MetaData()
    sa.Table("tenants", md, sa.Column("id", sa.Uuid, primary_key=True))
    sa.Table(
        "claims_cascade",
        md,
        sa.Column("id", sa.Uuid, primary_key=True),
        # A real FK to tenants — but SET NULL, the constraint that promotes a row
        # to a platform default instead of deleting it.
        sa.Column("tenant_id", sa.Uuid, sa.ForeignKey("tenants.id", ondelete="SET NULL")),
    )
    DISPOSITIONS["claims_cascade"] = Disposition(CASCADE, "no it does not")
    try:
        with pytest.raises(UnclassifiedTable, match="not CASCADE"):
            check_classification(md)
    finally:
        DISPOSITIONS.pop("claims_cascade")


def test_every_retained_table_states_a_reason():
    """Keeping personal data with no stated basis is the violation. The absence of
    a DELETE statement is not."""
    retained = {n: d for n, d in DISPOSITIONS.items() if d.how == RETAIN}
    assert set(retained) == {"audit_log", "billing_invoices"}
    for name, d in retained.items():
        assert len(d.why) > 80, f"{name} is retained with a one-liner for a reason"


def test_the_set_null_tables_are_erased_explicitly():
    """These are the four where the constraint that exists is worse than none: a
    SET NULL promotes the row to a platform default rather than removing it."""
    for name in ("branding", "app_settings", "channel_configs", "email_templates"):
        assert DISPOSITIONS[name].how == ERASE
        assert "platform default" in DISPOSITIONS[name].why


def test_the_tables_no_sweep_can_reach_are_reached():
    """notifications / device_tokens hold the tenant's people through a user_id
    that is not a foreign key; alert_states holds the tenant's uuid inside a
    string. A tenant_id sweep — which is what every satellite runs — sees none of
    the three."""
    assert DISPOSITIONS["notifications"].how == ERASE_BY_USER
    assert DISPOSITIONS["device_tokens"].how == ERASE_BY_USER
    assert DISPOSITIONS["alert_states"].how == ERASE_CUSTOM


# --- the behaviour -----------------------------------------------------------
async def _seed_two_tenants(db):
    """Two tenants with the same shape, so every assertion below can check that
    the OTHER tenant is untouched. An erase that takes too much is as much a
    failure as one that takes too little, and only a neighbour can show it."""
    from app.alerts.models import AlertState
    from app.auth.models import Role, User
    from app.auth.security import hash_password
    from app.billing.models import Invoice
    from app.branding.models import Branding
    from app.broadcasts.models import Broadcast
    from app.core.audit import AuditLog
    from app.messaging.inapp import Notification
    from app.messaging.push import DeviceToken
    from app.settings.models import AppSetting
    from app.sites.site.models import Site
    from app.tags.models import Tag
    from app.tenancy.models import Tenant

    made = {}
    for slug in ("doomed", "neighbour"):
        tenant = Tenant(id=uuid.uuid4(), name=slug.title(), slug=slug)
        db.add(tenant)
        await db.flush()
        role = Role(name=f"{slug}-role", permissions=["bi.read"], tenant_id=tenant.id)
        db.add(role)
        await db.flush()
        user = User(
            email=f"person@{slug}.io", full_name="A Person", role_id=role.id,
            tenant_id=tenant.id, password_hash=hash_password("Passw0rd!"),
        )
        db.add(user)
        await db.flush()
        db.add_all([
            Site(name=f"{slug} HQ", tenant_id=tenant.id),
            Tag(name=f"{slug}-tag", tenant_id=tenant.id),
            Branding(tenant_id=tenant.id, app_name=f"{slug} co"),
            AppSetting(key=f"smtp_password_{slug}", value="hunter2", tenant_id=tenant.id),
            Notification(user_id=user.id, title=f"hello {slug}", body="private"),
            DeviceToken(user_id=user.id, token=f"fcm-{slug}", platform="android"),
            AlertState(alert_key=f"license-expired:{tenant.id}", actor_id=uuid.uuid4()),
            Invoice(tenant_id=tenant.id, number=f"INV-{slug}-1", amount_cents=1000),
            AuditLog(tenant_id=tenant.id, action="user.create", actor_email=f"a@{slug}.io"),
        ])
        made[slug] = (tenant, user)
    db.add(
        Broadcast(
            title="planned outage", body="…", target_type="tenants",
            target_tenant_ids=[str(made["doomed"][0].id), str(made["neighbour"][0].id)],
        )
    )
    await db.commit()
    return made


async def test_erase_removes_everything_it_says_it_does(db):
    from sqlalchemy import func, select

    from app.alerts.models import AlertState
    from app.branding.models import Branding
    from app.messaging.inapp import Notification
    from app.messaging.push import DeviceToken
    from app.settings.models import AppSetting
    from app.sites.site.models import Site
    from app.tags.models import Tag

    made = await _seed_two_tenants(db)
    doomed, _ = made["doomed"]
    neighbour, _ = made["neighbour"]

    removed = await erase_tenant_data(db, doomed.id)
    await db.commit()

    async def count(model, **where):
        stmt = select(func.count()).select_from(model)
        for k, v in where.items():
            stmt = stmt.where(getattr(model, k) == v)
        return int(await db.scalar(stmt) or 0)

    # Erased for the doomed tenant...
    for model in (Site, Tag, Branding, AppSetting):
        assert await count(model, tenant_id=doomed.id) == 0, model.__tablename__
        # ...and untouched for its neighbour.
        assert await count(model, tenant_id=neighbour.id) == 1, model.__tablename__

    # The three nothing else could reach.
    assert await count(Notification) == 1  # only the neighbour's
    assert await count(DeviceToken) == 1
    assert await count(AlertState) == 1
    assert removed["notifications"] == 1 and removed["device_tokens"] == 1
    assert removed["alert_states"] == 1


async def test_the_settings_that_a_set_null_would_have_promoted_are_gone(db):
    """The specific failure: tenant_id NULL means PLATFORM DEFAULT here, so a
    SET NULL does not orphan the row, it hands the departed tenant's SMTP password
    to everybody. This asserts no such row exists after the erase."""
    from sqlalchemy import func, select

    from app.settings.models import AppSetting

    made = await _seed_two_tenants(db)
    await erase_tenant_data(db, made["doomed"][0].id)
    await db.commit()

    promoted = int(
        await db.scalar(
            select(func.count()).select_from(AppSetting).where(AppSetting.tenant_id.is_(None))
        )
        or 0
    )
    assert promoted == 0, "an offboarded tenant's setting became a platform default"


async def test_retained_records_survive_and_stay_attributable(db):
    from sqlalchemy import select

    from app.billing.models import Invoice
    from app.core.audit import AuditLog

    made = await _seed_two_tenants(db)
    doomed, _ = made["doomed"]

    await erase_tenant_data(db, doomed.id)
    await db.commit()

    invoice = (
        await db.execute(select(Invoice).where(Invoice.tenant_id == doomed.id))
    ).scalar_one()
    assert invoice.number == "INV-doomed-1"
    # The whole point of retaining it: it must still name a party. The uuid alone
    # stops resolving the moment the tenant row goes.
    assert invoice.tenant_name == "Doomed"

    trail = (
        await db.execute(select(AuditLog).where(AuditLog.tenant_id == doomed.id))
    ).scalars().all()
    assert len(trail) == 1 and trail[0].actor_email == "a@doomed.io"


async def test_a_platform_broadcast_survives_but_stops_naming_the_erased_tenant(db):
    from sqlalchemy import select

    from app.broadcasts.models import Broadcast

    made = await _seed_two_tenants(db)
    doomed, _ = made["doomed"]
    neighbour, _ = made["neighbour"]

    await erase_tenant_data(db, doomed.id)
    await db.commit()

    b = (await db.execute(select(Broadcast))).scalar_one()
    assert b.target_tenant_ids == [str(neighbour.id)]


async def test_the_erase_refuses_rather_than_half_finishing(db, monkeypatch):
    """An unclassified table aborts the whole thing before a single DELETE runs.

    Refusing to offboard is loud, reversible, and lands on whoever added the
    table. Erasing "everything the code happens to know about" leaves the new
    table's rows behind forever and nobody finds out.
    """
    from sqlalchemy import func, select

    import app.tenancy.erasure as erasure
    from app.sites.site.models import Site

    made = await _seed_two_tenants(db)
    doomed, _ = made["doomed"]

    def _boom(metadata):
        raise UnclassifiedTable("pretend a table was added")

    monkeypatch.setattr(erasure, "check_classification", _boom)
    with pytest.raises(UnclassifiedTable):
        await erasure.erase_tenant_data(db, doomed.id)

    assert int(
        await db.scalar(select(func.count()).select_from(Site).where(Site.tenant_id == doomed.id))
        or 0
    ) == 1, "rows were deleted despite the refusal"
