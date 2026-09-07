"""A live session for a camera the VMS has no row for.

Under single ownership the recorders own the cameras, so there are no ``Camera``
rows here — and any caller holding only a camera id used to get a 404 from
``/vms/cameras/{id}/live``. That is not an edge case: it is an alarm popup and a
video wall cell, both of which hold a camera and nothing else, because an incident
carries a camera and a saved wall layout stores a camera.

These cover the resolve-then-relay path and, more importantly, the ways it must NOT
go wrong: it must not answer for a camera no recorder has, must not keep asking a
recorder that turned out not to have it, and must not let one unreachable box make
every camera on the estate unresolvable.
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import NotFoundError

from app.db import Base
from app.vms.common import owning_node as owning
from app.vms.live.service import LiveService, LiveUpstreamError
from app.vms.models import MediaNode

TENANT = uuid.uuid4()
CAM = "cam-on-the-recorder"


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


@pytest.fixture(autouse=True)
def _clear_cache():
    owning._CACHE.clear()  # noqa: SLF001 — the cache is the thing under test
    yield
    owning._CACHE.clear()  # noqa: SLF001


def _scope():
    return Scope(tenant_id=TENANT, is_superadmin=False)


async def _node(db, name, url, *, cameras=None):
    row = MediaNode(
        id=str(uuid.uuid4()), tenant_id=TENANT, name=name, host=name,
        api_url=url, credential=f"key-{name}", status="online",
    )
    db.add(row)
    await db.commit()
    return row


def _estate(monkeypatch, by_url: dict, *, down: set = frozenset()):
    """Answer list_estate_cameras per node url; `down` urls raise."""
    asked = []

    async def _list(api_url, credential=None):
        asked.append(api_url)
        if api_url in down:
            from app.vms.federation.client import NodeUnavailable

            raise NodeUnavailable("connection refused")
        return [{"id": c} for c in by_url.get(api_url, [])]

    monkeypatch.setattr("app.vms.federation.client.list_estate_cameras", _list)
    return asked


def _mint(monkeypatch, result=None, *, fails=False):
    calls = []

    async def _m(api_url, camera_id, *, profile=None, credential=None):
        calls.append((api_url, camera_id, profile, credential))
        if fails:
            from app.vms.federation.client import NodeUnavailable

            raise NodeUnavailable("recorder said no")
        return result or {"session_id": "s1", "hls_url": "https://rec/a.m3u8", "token": "t"}

    monkeypatch.setattr("app.vms.federation.client.mint_estate_live", _m)
    return calls


async def test_it_relays_the_session_the_owning_recorder_mints(db, monkeypatch):
    node = await _node(db, "rec-a", "http://rec-a:8000")
    _estate(monkeypatch, {"http://rec-a:8000": [CAM]})
    calls = _mint(monkeypatch)

    out = await LiveService(db, _scope()).start_live(CAM, "sub", actor=None)

    assert calls == [("http://rec-a:8000", CAM, "sub", "key-rec-a")]
    assert out["hls_url"] == "https://rec/a.m3u8"
    # Which recorder answered — two nodes' sessions must be tellable apart.
    assert out["node_id"] == str(node.id) and out["node_name"] == "rec-a"


async def test_the_second_call_does_not_re_ask_every_recorder(db, monkeypatch):
    """The placement is cached. Without that, an estate of ten recorders pays ten
    camera-list calls for every tile on a wall."""
    await _node(db, "rec-a", "http://rec-a:8000")
    asked = _estate(monkeypatch, {"http://rec-a:8000": [CAM]})
    _mint(monkeypatch)

    svc = LiveService(db, _scope())
    await svc.start_live(CAM, "sub", actor=None)
    await svc.start_live(CAM, "sub", actor=None)
    assert len(asked) == 1, f"re-resolved on the second call: {asked}"


async def test_a_camera_no_recorder_has_is_not_found(db, monkeypatch):
    """404, not a stream from whichever recorder answered first."""
    await _node(db, "rec-a", "http://rec-a:8000")
    _estate(monkeypatch, {"http://rec-a:8000": ["some-other-camera"]})
    calls = _mint(monkeypatch)

    with pytest.raises(NotFoundError):
        await LiveService(db, _scope()).start_live(CAM, "sub", actor=None)
    assert calls == [], "asked a recorder to mint for a camera it does not have"


async def test_one_unreachable_recorder_does_not_hide_the_others(db, monkeypatch):
    """A rebooting box must not make every camera on the estate unresolvable."""
    await _node(db, "rec-a", "http://rec-a:8000")
    await _node(db, "rec-b", "http://rec-b:8000")
    _estate(monkeypatch, {"http://rec-b:8000": [CAM]}, down={"http://rec-a:8000"})
    calls = _mint(monkeypatch)

    out = await LiveService(db, _scope()).start_live(CAM, "sub", actor=None)
    assert out["node_name"] == "rec-b"
    assert calls[0][0] == "http://rec-b:8000"


async def test_a_refusing_recorder_drops_the_cached_placement(db, monkeypatch):
    """If the box we believed owns it cannot serve it, the NEXT attempt must
    re-resolve — otherwise a moved camera stays broken for the whole TTL."""
    await _node(db, "rec-a", "http://rec-a:8000")
    _estate(monkeypatch, {"http://rec-a:8000": [CAM]})
    _mint(monkeypatch, fails=True)

    with pytest.raises(LiveUpstreamError):
        await LiveService(db, _scope()).start_live(CAM, "sub", actor=None)
    assert CAM not in owning._CACHE, "kept a placement the recorder just disproved"  # noqa: SLF001


async def test_another_tenants_recorder_is_not_asked(db, monkeypatch):
    """Placement resolution must not become a way to reach across tenants."""
    other = MediaNode(
        id=str(uuid.uuid4()), tenant_id=uuid.uuid4(), name="theirs", host="theirs",
        api_url="http://theirs:8000", credential="k", status="online",
    )
    db.add(other)
    await db.commit()
    asked = _estate(monkeypatch, {"http://theirs:8000": [CAM]})

    with pytest.raises(NotFoundError):
        await LiveService(db, _scope()).start_live(CAM, "sub", actor=None)
    assert asked == [], "asked another tenant's recorder for a camera"
