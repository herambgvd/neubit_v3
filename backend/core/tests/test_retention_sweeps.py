"""Core's housekeeping sweeps — the three purges, and the loop that runs them.

The predecessors of these functions were Celery tasks that had never executed: no
core worker exists, the Celery app's ``include`` named a package (``edge``) that is
not in this repo, and the beat schedule asked for task names nothing registers. So
the first property pinned here is not a purge at all — it is that the sweep is
started by the lifespan, because that is the part that was missing.

The audit purge keeps the behaviour its old test pinned (it is per tenant, and a
tenant that chose "keep forever" keeps everything), plus the default that decides
whether this change destroys anything on its first run: with no window configured
it deletes nothing.
"""


import asyncio
import datetime as dt
import uuid

import pytest

from app.core.audit import AuditLog
from app.settings.models import AppSetting

pytestmark = pytest.mark.asyncio


def _utcnow() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


async def _entry(db, *, days_ago: int, tenant_id: uuid.UUID | None) -> uuid.UUID:
    row = AuditLog(
        id=uuid.uuid4(),
        action="test.event",
        tenant_id=tenant_id,
        meta={},
        ts=_utcnow() - dt.timedelta(days=days_ago),
    )
    db.add(row)
    await db.commit()
    return row.id


async def _setting(db, *, days: int, tenant_id: uuid.UUID | None) -> None:
    db.add(
        AppSetting(id=uuid.uuid4(), key="audit_retention_days", value=days, tenant_id=tenant_id)
    )
    await db.commit()


async def _ids(db) -> set:
    from sqlalchemy import select

    return set((await db.execute(select(AuditLog.id))).scalars().all())


# --- where the sweep runs ----------------------------------------------------
async def test_the_lifespan_starts_the_sweep_and_cancels_it_on_shutdown(
    sessionmaker_, monkeypatch
):
    """The whole point of the change: nothing else starts this.

    The old path needed a worker process, a beat process and two import paths that
    did not exist; this one needs the API process, which is already running.
    """
    import app.main as main

    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def fake_sweep(sessionmaker):
        started.set()
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            cancelled.set()
            raise

    monkeypatch.setattr(main, "sweep_forever", fake_sweep)
    # Everything else the lifespan does needs a live database or NATS, and none of
    # it is what this test is about.
    monkeypatch.setattr(main.events_nats, "connect", lambda: asyncio.sleep(0))
    monkeypatch.setattr(main.events_nats, "close", lambda: asyncio.sleep(0))
    monkeypatch.setattr(main.events_nats, "publish", lambda *a, **k: asyncio.sleep(0))
    monkeypatch.setattr(main, "install_signal_handlers", lambda: None)

    async def _no_seed(*a, **k):
        return None

    monkeypatch.setattr(main, "get_sessionmaker", lambda: sessionmaker_)
    monkeypatch.setattr(main, "seed_tenancy", _no_seed)
    monkeypatch.setattr(main, "seed_modules", _no_seed)
    monkeypatch.setattr(main, "seed_brands", _no_seed)

    async with main.lifespan(object()):
        await asyncio.wait_for(started.wait(), 1)
    assert cancelled.is_set(), "the sweep outlived the process it was started in"


# --- the audit window --------------------------------------------------------
async def test_reads_the_configured_window(db, sessionmaker_):
    from app.retention import purge_audit

    await _setting(db, days=30, tenant_id=None)
    old = await _entry(db, days_ago=90, tenant_id=None)
    recent = await _entry(db, days_ago=2, tenant_id=None)

    assert await purge_audit(sessionmaker_) == 1

    remaining = await _ids(db)
    assert remaining == {recent}
    assert old not in remaining


async def test_the_default_of_zero_keeps_the_compliance_trail(db, sessionmaker_):
    """0 = keep forever, and 0 is the shipped default.

    This sweep has never run before, so a non-zero default would mean the first
    startup after this change silently deletes years of audit trail that nobody
    asked it to delete. Growth is visible and recoverable; the trail is not.
    """
    from app.retention import purge_audit

    old = await _entry(db, days_ago=900, tenant_id=None)

    assert await purge_audit(sessionmaker_) == 0
    assert await _ids(db) == {old}


async def test_a_tenant_that_asked_to_keep_forever_is_not_purged(db, sessionmaker_):
    from app.retention import purge_audit

    keeper = uuid.uuid4()
    purged = uuid.uuid4()
    await _setting(db, days=30, tenant_id=None)  # platform default
    await _setting(db, days=0, tenant_id=keeper)  # this tenant keeps everything
    kept = await _entry(db, days_ago=400, tenant_id=keeper)
    gone = await _entry(db, days_ago=400, tenant_id=purged)

    await purge_audit(sessionmaker_)

    remaining = await _ids(db)
    assert kept in remaining, "a tenant's own retention choice was overridden"
    assert gone not in remaining


async def test_a_tenants_shorter_window_is_used_for_its_own_rows(db, sessionmaker_):
    from app.retention import purge_audit

    strict = uuid.uuid4()
    await _setting(db, days=365, tenant_id=None)
    await _setting(db, days=7, tenant_id=strict)
    strict_old = await _entry(db, days_ago=30, tenant_id=strict)
    platform_old = await _entry(db, days_ago=30, tenant_id=None)

    await purge_audit(sessionmaker_)

    remaining = await _ids(db)
    assert strict_old not in remaining
    assert platform_old in remaining, "the platform's 365-day window was not applied"


async def test_an_explicit_argument_still_overrides_the_policy(db, sessionmaker_):
    from app.retention import purge_audit

    old = await _entry(db, days_ago=10, tenant_id=None)

    assert await purge_audit(sessionmaker_, days=5) == 1
    assert old not in await _ids(db)


async def test_a_purge_larger_than_one_batch_finishes(db, sessionmaker_, monkeypatch):
    """The batching exists so a first sweep on a years-old table cannot hold one
    long lock — but a loop that stops after the first batch bounds nothing."""
    import app.retention as retention

    monkeypatch.setattr(retention, "BATCH", 2)
    await _setting(db, days=1, tenant_id=None)
    for _ in range(5):
        await _entry(db, days_ago=9, tenant_id=None)

    assert await retention.purge_audit(sessionmaker_) == 5
    assert await _ids(db) == set()


# --- the other two sweeps ----------------------------------------------------
async def test_expired_reset_tokens_are_deleted_and_live_ones_are_not(db, sessionmaker_):
    from sqlalchemy import select

    from app.auth.models import PasswordResetToken, Role, User
    from app.auth.security import hash_password
    from app.retention import purge_expired_reset_tokens

    role = Role(name="R", permissions=[])
    db.add(role)
    await db.flush()
    user = User(
        email="u@x.io", full_name="U", role_id=role.id, password_hash=hash_password("Passw0rd!")
    )
    db.add(user)
    await db.flush()
    db.add_all([
        PasswordResetToken(
            user_id=user.id, token_hash="stale", expires_at=_utcnow() - dt.timedelta(hours=1)
        ),
        PasswordResetToken(
            user_id=user.id, token_hash="live", expires_at=_utcnow() + dt.timedelta(hours=1)
        ),
    ])
    await db.commit()

    assert await purge_expired_reset_tokens(sessionmaker_) == 1
    left = (await db.execute(select(PasswordResetToken.token_hash))).scalars().all()
    assert left == ["live"]


async def test_an_old_report_takes_its_export_with_it(db, sessionmaker_, tmp_path, monkeypatch):
    """The row holds the ONLY reference to the stored file, so deleting the row
    first is how an object store fills up with exports nothing can name."""
    from app.core import config, storage
    from app.reports.models import ReportJob
    from app.retention import purge_old_reports

    monkeypatch.setenv("VE_STORAGE_LOCAL_DIR", str(tmp_path / "storage"))
    config.get_settings.cache_clear()
    storage.get_storage.cache_clear()
    try:
        store = storage.get_storage()
        await store.put("reports/old.csv", b"a,b\n", "text/csv")
        await store.put("reports/new.csv", b"a,b\n", "text/csv")
        db.add_all([
            ReportJob(
                name="old", format="csv", status="done", result_key="reports/old.csv",
                created_at=_utcnow() - dt.timedelta(days=90),
            ),
            ReportJob(
                name="new", format="csv", status="done", result_key="reports/new.csv",
                created_at=_utcnow(),
            ),
        ])
        await db.commit()

        assert await purge_old_reports(sessionmaker_) == 1
        assert not await store.exists("reports/old.csv"), "the export outlived its job row"
        assert await store.exists("reports/new.csv")
    finally:
        config.get_settings.cache_clear()
        storage.get_storage.cache_clear()


async def test_a_blob_that_will_not_delete_keeps_its_row(db, sessionmaker_, monkeypatch):
    """Dropping the row anyway is exactly the bug this sweep is fixing: it would
    orphan the file permanently. Keep the row and try again next hour."""
    from sqlalchemy import select

    from app.core import storage
    from app.reports.models import ReportJob
    from app.retention import purge_old_reports

    class _Stuck:
        async def delete(self, key):
            raise OSError("storage is unhappy")

    monkeypatch.setattr(storage, "get_storage", lambda: _Stuck())
    db.add(
        ReportJob(
            name="old", format="csv", status="done", result_key="reports/stuck.csv",
            created_at=_utcnow() - dt.timedelta(days=90),
        )
    )
    await db.commit()

    assert await purge_old_reports(sessionmaker_) == 0
    assert (await db.execute(select(ReportJob.name))).scalars().all() == ["old"]


async def test_a_failing_sweep_does_not_stop_the_loop(sessionmaker_, monkeypatch):
    """A background task that dies on one bad cycle is a sweep that silently stops
    running — which is the failure this whole module exists to end."""
    import app.retention as retention

    calls = []
    twice = asyncio.Event()

    async def boom(sm):
        calls.append(1)
        if len(calls) >= 2:
            twice.set()
        raise RuntimeError("database went away")

    monkeypatch.setattr(retention, "sweep_once", boom)
    monkeypatch.setattr(retention, "SWEEP_INTERVAL_SEC", 0)

    task = asyncio.create_task(retention.sweep_forever(sessionmaker_))
    try:
        await asyncio.wait_for(twice.wait(), 2)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    assert len(calls) >= 2
