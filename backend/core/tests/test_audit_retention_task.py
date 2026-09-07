"""The scheduled audit purge actually reads the retention setting — and honours
each tenant's own.

Two defects lived here, both silent:

  1. The task looked the setting up with ``db.get(AppSetting, "audit_...")``.
     ``Session.get`` looks up the PRIMARY KEY, and AppSetting's is a surrogate
     UUID ``id`` — the key column is not it. So the read never found the row, the
     window fell back to 0 ("keep forever"), and the daily purge deleted nothing
     no matter what an admin set. The Settings screen offered a control that
     governed nothing.

  2. Settings are per-tenant (key, tenant_id). Purging every tenant's trail by one
     platform number would delete records a tenant had chosen to keep — the
     opposite failure, and unrecoverable.
"""

from __future__ import annotations

import datetime as dt
import uuid

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.audit import AuditLog
from app.db.base import Base
from app.settings.models import AppSetting
from app.tasks import base as tasks_base
from app.tasks.retention import cleanup_old_audit


@pytest.fixture()
def sync_db(tmp_path, monkeypatch):
    """A real synchronous session, which is what the worker uses.

    The task builds its own engine from settings; pointing the module's cached
    sessionmaker at a temp file is the seam, and it means the task under test runs
    exactly as it does in a worker rather than through an async shim.
    """
    engine = create_engine(f"sqlite:///{tmp_path}/retention.db")
    Base.metadata.create_all(engine)
    maker = sessionmaker(engine, expire_on_commit=False, class_=Session)
    monkeypatch.setattr(tasks_base, "_sync_sessionmaker", maker)
    monkeypatch.setattr(tasks_base, "_sync_engine", engine)
    return maker


def _entry(db: Session, *, days_ago: int, tenant_id: uuid.UUID | None) -> uuid.UUID:
    row = AuditLog(
        id=uuid.uuid4(),
        action="test.event",
        tenant_id=tenant_id,
        meta={},
        ts=dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=days_ago),
    )
    db.add(row)
    db.commit()
    return row.id


def _setting(db: Session, *, days: int, tenant_id: uuid.UUID | None) -> None:
    db.add(
        AppSetting(
            id=uuid.uuid4(), key="audit_retention_days", value=days, tenant_id=tenant_id
        )
    )
    db.commit()


def _ids(db: Session) -> set[uuid.UUID]:
    return set(db.execute(select(AuditLog.id)).scalars().all())


def test_reads_the_configured_window(sync_db):
    with sync_db() as db:
        _setting(db, days=30, tenant_id=None)
        old = _entry(db, days_ago=90, tenant_id=None)
        recent = _entry(db, days_ago=2, tenant_id=None)

    assert cleanup_old_audit() == 1

    with sync_db() as db:
        assert _ids(db) == {recent}
        assert old not in _ids(db)


def test_keeps_everything_when_no_window_is_set(sync_db):
    with sync_db() as db:
        old = _entry(db, days_ago=900, tenant_id=None)

    assert cleanup_old_audit() == 0

    with sync_db() as db:
        assert _ids(db) == {old}


def test_a_tenant_that_asked_to_keep_forever_is_not_purged(sync_db):
    keeper = uuid.uuid4()
    purged = uuid.uuid4()
    with sync_db() as db:
        _setting(db, days=30, tenant_id=None)  # platform default
        _setting(db, days=0, tenant_id=keeper)  # this tenant keeps everything
        kept = _entry(db, days_ago=400, tenant_id=keeper)
        gone = _entry(db, days_ago=400, tenant_id=purged)

    cleanup_old_audit()

    with sync_db() as db:
        remaining = _ids(db)
    assert kept in remaining, "a tenant's own retention choice was overridden"
    assert gone not in remaining


def test_a_tenants_shorter_window_is_used_for_its_own_rows(sync_db):
    strict = uuid.uuid4()
    with sync_db() as db:
        _setting(db, days=365, tenant_id=None)
        _setting(db, days=7, tenant_id=strict)
        strict_old = _entry(db, days_ago=30, tenant_id=strict)
        platform_old = _entry(db, days_ago=30, tenant_id=None)

    cleanup_old_audit()

    with sync_db() as db:
        remaining = _ids(db)
    assert strict_old not in remaining
    assert platform_old in remaining, "the platform's 365-day window was not applied"


def test_an_explicit_argument_still_overrides_the_policy(sync_db):
    with sync_db() as db:
        old = _entry(db, days_ago=10, tenant_id=None)

    assert cleanup_old_audit(days=5) == 1

    with sync_db() as db:
        assert old not in _ids(db)
