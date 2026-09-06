"""Per-tenant pools are bounded and disposed.

Each cached sessionmaker owns a connection pool, so an unbounded cache is
N tenants x pool_size connections against Postgres's max_connections — and nothing
evicted or disposed. Dormant while db-per-tenant is off, which it is, but it is
the kind of thing that only shows up once the flag is flipped in production.
"""

from __future__ import annotations

import uuid

import pytest

from kernel.db import Database


# tenant_url derives the database name from the uuid's hex, so these must parse.
T1 = str(uuid.uuid4())
T2 = str(uuid.uuid4())
T3 = str(uuid.uuid4())
T4 = str(uuid.uuid4())


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv("VE_DB_PER_TENANT", "1")
    d = Database("postgresql+asyncpg://u:p@localhost/base", max_tenant_pools=3)
    yield d


def _per_tenant_on(db, monkeypatch):
    monkeypatch.setattr(db, "_per_tenant_enabled", lambda: True)


def test_the_shared_sessionmaker_is_used_when_there_is_no_tenant(db, monkeypatch):
    _per_tenant_on(db, monkeypatch)
    assert db.sessionmaker_for(None) is db.get_sessionmaker()


def test_the_same_tenant_reuses_one_pool(db, monkeypatch):
    _per_tenant_on(db, monkeypatch)
    first = db.sessionmaker_for(T1)
    assert db.sessionmaker_for(T1) is first
    assert len(db._tenant_sessionmakers) == 1


def test_the_cache_is_bounded(db, monkeypatch):
    _per_tenant_on(db, monkeypatch)
    for _ in range(10):
        db.sessionmaker_for(str(uuid.uuid4()))
    assert len(db._tenant_sessionmakers) <= db.max_tenant_pools


def test_eviction_is_least_recently_used(db, monkeypatch):
    """The oldest by USE, not by creation — otherwise a busy tenant is evicted
    while an idle one is kept."""
    _per_tenant_on(db, monkeypatch)
    db.sessionmaker_for(T1)
    db.sessionmaker_for(T2)
    db.sessionmaker_for(T3)
    db.sessionmaker_for(T1)  # t1 is now the most recent, t2 the oldest
    db.sessionmaker_for(T4)  # evicts t2
    assert T2 not in db._tenant_sessionmakers
    assert T1 in db._tenant_sessionmakers


def test_a_dropped_tenant_can_be_forgotten(db, monkeypatch):
    """After drop_tenant_db the pool keeps reconnecting to a database that no
    longer exists, forever."""
    _per_tenant_on(db, monkeypatch)
    db.sessionmaker_for(T1)
    db.forget_tenant(T1)
    assert T1 not in db._tenant_sessionmakers


def test_forgetting_an_unknown_tenant_is_harmless(db):
    db.forget_tenant(str(uuid.uuid4()))
