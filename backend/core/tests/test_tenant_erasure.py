"""Tenant offboard erasure — the classification, and that it actually erases.

The guard: ``test_every_table_core_owns_is_classified`` walks the ``app.`` package,
imports every module, and checks the resulting metadata — so a table added next year
is covered without anyone remembering this file, and without it having to reach
conftest's hand-written ``_import_all_models`` (which already misses three modules).

The behaviour: the rest prove the classification is true, not merely present —
erased tables are emptied, retained tables keep their attribution, and the tables no
column sweep can reach are reached.
"""

from __future__ import annotations

import importlib
import pkgutil
import uuid

import pytest
import pytest_asyncio

from app.tenancy.erasure import (
    CASCADE,
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
    """Base.metadata after importing every app module, not a curated list.

    A hand-maintained import list is only as complete as the last person to remember
    it, and this check's value is that it cannot be escaped by forgetting.
    """
    import app
    from app.db.base import Base

    for mod in pkgutil.walk_packages(app.__path__, prefix="app."):
        # Import broadly on purpose: a table declared in a router or service file
        # must not slip through because its module is not named "models".
        try:
            importlib.import_module(mod.name)
        except Exception:  # noqa: BLE001 - a module that cannot import declares no table
            continue
    return Base.metadata


async def test_every_table_core_owns_is_classified():
    """If this fails, a table was added without deciding what happens to a tenant's
    rows in it on offboard."""
    check_classification(_metadata_of_every_module())


async def test_the_guard_actually_fails_on_an_unclassified_table():
    """Proves the check bites, using a table it has never seen rather than mutating
    the real registry."""
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


async def test_the_guard_refuses_the_cheap_way_out():
    """Relabelling a tenant table as PLATFORM must not silence the check."""
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


async def test_the_guard_verifies_a_cascade_claim_rather_than_trusting_it():
    """"The FK cascade handles it" is a claim that goes silently false, so a table
    that says CASCADE and has no such constraint must fail."""
    import sqlalchemy as sa

    from app.tenancy.erasure import CASCADE, Disposition

    md = sa.MetaData()
    sa.Table("tenants", md, sa.Column("id", sa.Uuid, primary_key=True))
    sa.Table(
        "claims_cascade",
        md,
        sa.Column("id", sa.Uuid, primary_key=True),
        # A real FK to tenants, but SET NULL — the constraint that promotes a row to
        # a platform default instead of deleting it.
        sa.Column("tenant_id", sa.Uuid, sa.ForeignKey("tenants.id", ondelete="SET NULL")),
    )
    DISPOSITIONS["claims_cascade"] = Disposition(CASCADE, "no it does not")
    try:
        with pytest.raises(UnclassifiedTable, match="not CASCADE"):
            check_classification(md)
    finally:
        DISPOSITIONS.pop("claims_cascade")


async def test_every_retained_table_states_a_reason():
    """Keeping personal data with no stated basis is the violation; the absence of a
    DELETE statement is not."""
    retained = {n: d for n, d in DISPOSITIONS.items() if d.how == RETAIN}
    assert set(retained) == {"audit_log", "billing_invoices"}
    for name, d in retained.items():
        assert len(d.why) > 80, f"{name} is retained with a one-liner for a reason"


async def test_the_set_null_tables_are_erased_explicitly():
    """The four where the existing constraint is worse than none: SET NULL promotes
    the row to a platform default rather than removing it."""
    for name in ("branding", "app_settings", "channel_configs", "email_templates"):
        assert DISPOSITIONS[name].how == ERASE
        assert "platform default" in DISPOSITIONS[name].why


async def test_the_tables_no_sweep_can_reach_are_reached():
    """notifications and device_tokens reach the tenant's people through a user_id
    that is not a foreign key, and alert_states holds the tenant uuid inside a
    string. A tenant_id sweep sees none of the three."""
    assert DISPOSITIONS["notifications"].how == ERASE_BY_USER
    assert DISPOSITIONS["device_tokens"].how == ERASE_BY_USER
    assert DISPOSITIONS["alert_states"].how == ERASE_CUSTOM


# --- the behaviour -----------------------------------------------------------
async def _seed_two_tenants(db):
    """Two tenants with the same shape, so every assertion can check the other is
    untouched — an erase that takes too much fails as surely as one that takes too
    little."""
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
    """tenant_id NULL means platform default here, so a SET NULL does not orphan the
    row — it hands the departed tenant's SMTP password to everybody."""
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
    # The point of retaining it: it must still name a party. The uuid alone stops
    # resolving the moment the tenant row goes.
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

    Refusing is loud, reversible, and lands on whoever added the table. Erasing
    "everything the code happens to know about" silently leaves rows behind.
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


# --- the cascades, actually fired --------------------------------------------
#
# The tests above assert the CONSTRAINT is declared. These watch a row vanish.
# They need their own engine: SQLite ignores foreign keys unless the connection
# issues `PRAGMA foreign_keys=ON`, and conftest's shared `db` does not, so a
# cascade assertion made against it would pass by never deleting anything.

#: What each CASCADE table needs beyond tenant_id to satisfy its NOT NULLs.
#: users also needs a role, wired up in the test.
_CASCADE_ROWS: dict[str, dict] = {
    "users": {"email": "person@doomed.io", "password_hash": "x"},
    "roles": {"name": "doomed-role"},
    "api_keys": {"name": "k", "prefix": "ve_abc", "key_hash": "h"},
    "dashforge_embeds": {"name": "d", "workspace_ref": "w", "dashboard_ref": "b"},
    "security_policies": {},
    "directory_configs": {"server_uri": "ldap://x", "base_dn": "dc=x", "bind_dn": "cn=x"},
    "sso_configs": {"issuer": "https://idp.test", "client_id": "c"},
    "billing_subscriptions": {"plan_key": "pro"},
}

_CASCADE_TABLES = sorted(n for n, d in DISPOSITIONS.items() if d.how == CASCADE)


@pytest_asyncio.fixture
async def fk_db():
    """A session on a connection that enforces foreign keys."""
    from sqlalchemy import event
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.db.base import Base

    _metadata_of_every_module()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")

    @event.listens_for(engine.sync_engine, "connect")
    def _foreign_keys_on(dbapi_connection, _record):  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with maker() as session:
        yield session
    await engine.dispose()


def _tables() -> dict:
    from app.db.base import Base

    return {t.name: t for t in Base.metadata.sorted_tables}


async def _row_exists(session, table, row_id) -> bool:
    """By primary key, not by tenant_id: an ON DELETE SET NULL also empties a
    tenant_id count, and SET NULL is the bug CASCADE is being asserted against."""
    from sqlalchemy import func, select

    stmt = select(func.count()).select_from(table).where(table.c.id == row_id)
    return int(await session.scalar(stmt) or 0) > 0


async def test_every_cascade_table_has_a_row_to_probe_with():
    """A CASCADE table added later must be observed, not just declared."""
    assert set(_CASCADE_TABLES) == set(_CASCADE_ROWS)


async def test_the_cascade_fixture_really_enforces_foreign_keys(fk_db):
    """Without the pragma every cascade test below would pass by doing nothing."""
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError):
        await fk_db.execute(
            _tables()["security_policies"].insert().values(tenant_id=uuid.uuid4())
        )


@pytest.mark.parametrize("table_name", _CASCADE_TABLES)
async def test_a_cascade_table_loses_its_row_when_the_tenant_is_deleted(fk_db, table_name):
    """The row is gone after DELETE FROM tenants, with no explicit DELETE for it."""
    tables = _tables()
    tenants = tables["tenants"]
    tid = uuid.uuid4()
    await fk_db.execute(
        tenants.insert().values(id=tid, name="Doomed", slug=f"doomed-{tid.hex[:8]}")
    )

    values = dict(_CASCADE_ROWS[table_name], tenant_id=tid)
    if table_name == "users":
        # A shared built-in role (tenant_id NULL), so this probes the users
        # cascade and not the roles one.
        role_id = uuid.uuid4()
        await fk_db.execute(
            tables["roles"].insert().values(id=role_id, name=f"system-{role_id.hex[:8]}")
        )
        values["role_id"] = role_id

    table = tables[table_name]
    result = await fk_db.execute(table.insert().values(**values))
    row_id = result.inserted_primary_key[0]
    assert await _row_exists(fk_db, table, row_id), f"{table_name} row was not seeded"

    await fk_db.execute(tenants.delete().where(tenants.c.id == tid))
    assert not await _row_exists(fk_db, table, row_id), f"{table_name} survived its tenant"
