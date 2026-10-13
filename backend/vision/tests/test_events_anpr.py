"""ANPR plate reads from a paired recorder (SCRUM-324).

A recorder logs one ``anpr`` event per plate read, carrying the plate and the cameras
it bound to the ANPR camera. The VMS must keep it as its own type (not ``system``),
lead its title with the plate, and never merge two plates read within one dedup
bucket — while a re-read of the SAME recorder event still lands once.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope

from app.db import Base
from app.vms.events import service as events_svc
from app.vms.events import supervisor as sup_mod
from app.vms.events.normalize import normalize_event_type
from app.vms.events.service import VmsEventService
from app.vms.events.supervisor import EventSupervisor, _event_title
from app.vms.federation import client as fed
from app.vms.models import MediaNode

TENANT = uuid.uuid4()
PLATFORM = Scope(tenant_id=None, is_superadmin=True)


@pytest_asyncio.fixture
async def engine():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield eng
    await eng.dispose()


@pytest.fixture
def capture(monkeypatch):
    published: list[tuple] = []

    async def _emit(tenant_id, event_type, payload, **kw):
        published.append((tenant_id, event_type, payload))
        return f"tenant.{tenant_id or 'platform'}.vms.camera.{event_type}"

    monkeypatch.setattr(events_svc, "emit_camera_event", _emit)
    return published


def _read_event(ev_id: str, plate: str, started: str) -> dict:
    return {
        "id": ev_id,
        "camera_id": "anpr-cam",
        "camera_name": "Gate ANPR",
        "type": "anpr",
        "topic": "neubit:anpr/plate",
        "severity": "alarm",
        "source": "anpr_push",
        "payload": {
            "anpr": {"read_id": f"r-{ev_id}", "plate": plate, "list": "visitor", "confidence": 0.9},
            "linked_camera_ids": ["hall-cam"],
        },
        "stateful": False,
        "started_at": started,
        "ended_at": None,
        "created_at": started,
    }


async def _node(maker) -> MediaNode:
    async with maker() as s:
        node = MediaNode(
            id=str(uuid.uuid4()), tenant_id=TENANT, name="recorder-a", host="rec-a",
            api_url="http://rec-a:8000", credential="scoped-key", status="online",
        )
        s.add(node)
        await s.commit()
        return node


def _serve(monkeypatch, batches):
    seq = list(batches)

    async def _list(api_url, *, since=None, limit=200, credential=None):
        return {"items": seq.pop(0) if seq else [], "total": 0}

    monkeypatch.setattr("app.vms.events.supervisor.fed.list_events_node", _list)


def test_anpr_is_its_own_type():
    assert normalize_event_type("anpr") == "anpr"
    # Nothing else moved: an unknown recorder type is still "system".
    assert normalize_event_type("analytics") == "system"


def test_title_leads_with_the_plate():
    assert _event_title(_read_event("e1", "PB10GN4497", "2026-10-12T06:54:31Z")) == "Plate PB10GN4497 · Gate ANPR"
    no_plate = _read_event("e2", "", "2026-10-12T06:54:31Z")
    assert _event_title(no_plate) == "Vehicle without a plate · Gate ANPR"
    assert _event_title({"type": "motion", "camera_name": "Lobby"}) == "Lobby"


async def test_two_plates_in_one_bucket_are_two_alerts(engine, capture, monkeypatch):
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await _node(maker)
    # Two different vehicles 2 s apart — well inside the 10 s dedup bucket.
    a = _read_event("e1", "PB10GN4497", "2026-10-12T06:54:31Z")
    b = _read_event("e2", "HR87K4650", "2026-10-12T06:54:33Z")
    _serve(monkeypatch, [[a, b], [a, b]])

    sup = EventSupervisor(maker)
    await sup._tick()
    # The next poll overlaps and serves both again: still two rows.
    monkeypatch.setattr(sup_mod, "_utcnow", lambda: datetime.now(timezone.utc) + timedelta(hours=1))
    await sup._tick()

    async with maker() as s:
        listed = await VmsEventService(s, PLATFORM).list_()
    assert listed.total == 2
    titles = sorted(e.title for e in listed.items)
    assert titles == ["Plate HR87K4650 · Gate ANPR", "Plate PB10GN4497 · Gate ANPR"]
    assert {e.event_type for e in listed.items} == {"anpr"}
    # The recorder's read id and linked cameras survive in raw, for the plate panel.
    raw = listed.items[0].raw
    assert raw["payload"]["anpr"]["read_id"].startswith("r-")
    assert raw["payload"]["linked_camera_ids"] == ["hall-cam"]
    assert [p[1] for p in capture] == ["anpr", "anpr"]


async def test_a_plate_is_found_by_typing_part_of_it(engine, capture, monkeypatch):
    """SCRUM-325: "every read of this plate" searches the whole history, not the page
    the console holds — case-insensitive, and a typed % or _ is a character."""
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    await _node(maker)
    _serve(monkeypatch, [[
        _read_event("e1", "PB10GN4497", "2026-10-12T06:54:31Z"),
        _read_event("e2", "HR87K4650", "2026-10-12T06:54:33Z"),
    ]])
    await EventSupervisor(maker)._tick()

    async with maker() as s:
        svc = VmsEventService(s, PLATFORM)
        one = await svc.list_(search="pb10gn")
        both = await svc.list_(search="  Gate ANPR ")
        wildcard = await svc.list_(search="PB10%4497")
        blank = await svc.list_(search="   ")
    assert [e.title for e in one.items] == ["Plate PB10GN4497 · Gate ANPR"]
    assert one.total == 1
    assert both.total == 2
    assert wildcard.total == 0
    assert blank.total == 2


async def test_anpr_image_relay_reads_the_recorder_still(monkeypatch):
    jpeg = b"\xff\xd8\xff\xe0plate"
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["cred"] = request.headers.get("X-Node-Credential")
        if request.url.path.endswith("/images/plate"):
            return httpx.Response(200, content=jpeg, headers={"Content-Type": "image/jpeg"})
        return httpx.Response(404, json={"error": {"message": "this read has no such still"}})

    transport = httpx.MockTransport(handler)
    real = httpx.AsyncClient

    def _client(*a, **kw):
        kw["transport"] = transport
        return real(*a, **kw)

    monkeypatch.setattr(fed.httpx, "AsyncClient", _client)

    raw, ctype = await fed.anpr_image_node("http://rec-a:8000", "r 1", "plate", credential="scoped-key")
    assert raw == jpeg
    assert ctype == "image/jpeg"
    assert seen["url"] == "http://rec-a:8000/api/v1/nvr/estate/anpr/reads/r%201/images/plate"
    assert seen["cred"] == "scoped-key"

    with pytest.raises(fed.NodeUnavailable):
        await fed.anpr_image_node("http://rec-a:8000", "r1", "scene", credential="scoped-key")
