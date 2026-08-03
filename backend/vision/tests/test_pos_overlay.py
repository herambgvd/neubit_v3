"""POS overlay ingest → buffer → stream fan-out tests (feature G).

Exercises the real pipeline end-to-end WITHOUT a live POS terminal: the in-process
``PosHub`` (ring buffer + subscriber fan-out) and the router's ``_ingest`` /
``stream_pos`` handlers against an in-memory SQLite camera row. No network devices,
no NATS — the push path works with zero external infra (honest).

pytest-asyncio auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.db import Base
from app.vms.models import Camera
from app.vms.pos.hub import PosHub, hub, hub_key
from app.vms.pos.router import _ingest, stream_pos
from app.vms.pos.schemas import PosIngestBody, PosIngestLineIn

TENANT = uuid.uuid4()


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with Session() as s:
        yield s
    await engine.dispose()


async def _make_camera(db, *, source="POS-1", enabled=True):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Till Cam",
        brand="onvif",
        pos_overlay={"enabled": enabled, "source": source, "position": "bottom"},
    )
    db.add(cam)
    await db.commit()
    return cam


# --------------------------------------------------------------------- hub unit


def test_hub_ring_and_fanout():
    h = PosHub(ring_size=3)
    key = hub_key(str(TENANT), "POS-1")
    q = h.subscribe(key)
    for i in range(5):
        h.publish(key, {"terminal": "POS-1", "text": f"line{i}"})
    # Ring keeps only the last 3.
    assert [x["text"] for x in h.recent(key)] == ["line2", "line3", "line4"]
    # Subscriber saw every published line (queue bound is large).
    got = []
    while not q.empty():
        got.append(q.get_nowait()["text"])
    assert got == ["line0", "line1", "line2", "line3", "line4"]
    h.unsubscribe(key, q)
    assert h.subscribe  # still usable


def test_hub_no_subscribers_is_noop():
    h = PosHub()
    key = hub_key(None, "T")
    assert h.publish(key, {"text": "x"}) == 0
    assert h.recent(key) == [{"text": "x"}]


# ------------------------------------------------------------- ingest handler


class _Req:
    """Minimal stand-in for a Starlette Request with a bearer header."""

    def __init__(self, token):
        self.headers = {"authorization": f"Bearer {token}"}

    async def is_disconnected(self):
        return False


def _access_token():
    """Mint an operator access token that grants vms.config.manage in TENANT."""
    import jwt as _jwt
    from kernel.config import get_settings

    payload = {
        "sub": str(uuid.uuid4()),
        "tenant_id": str(TENANT),
        "type": "access",
        "permissions": ["vms.config.manage"],
    }
    return _jwt.encode(payload, get_settings().jwt_secret, algorithm="HS256")


async def test_ingest_single_then_stream_replays(db):
    cam = await _make_camera(db, source="POS-1")
    key = hub_key(str(TENANT), "POS-1")
    # Ingest a single line via the operator-JWT path.
    body = PosIngestBody(terminal="POS-1", text="ITEM  MILK  1.99")
    res = await _ingest(body, _Req(_access_token()), db)
    assert res.accepted == 1 and res.terminals == ["POS-1"]
    # It landed in the ring keyed by (tenant, terminal).
    assert hub.recent(key)[-1]["text"] == "ITEM  MILK  1.99"


async def test_ingest_batch_and_camera_id_resolves_terminal(db):
    cam = await _make_camera(db, source="POS-2")
    # Batch where the line omits terminal but gives camera_id → terminal from source.
    body = PosIngestBody(
        lines=[
            PosIngestLineIn(camera_id=cam.id, text="SUBTOTAL 5.00"),
            PosIngestLineIn(terminal="POS-2", text="TOTAL 5.50"),
        ]
    )
    res = await _ingest(body, _Req(_access_token()), db)
    assert res.accepted == 2
    key = hub_key(str(TENANT), "POS-2")
    assert [x["text"] for x in hub.recent(key)][-2:] == ["SUBTOTAL 5.00", "TOTAL 5.50"]


async def test_ingest_rejects_bad_token(db):
    from fastapi import HTTPException

    await _make_camera(db)
    with pytest.raises(HTTPException) as ei:
        await _ingest(PosIngestBody(terminal="X", text="hi"), _Req("garbage"), db)
    assert ei.value.status_code == 401


async def test_stream_delivers_live_line(db):
    """End-to-end: open the SSE stream, ingest a line, assert it streams out."""
    cam = await _make_camera(db, source="POS-LIVE")
    token = _access_token()

    resp = await stream_pos(_Req(token), camera_id=cam.id, token=token, db=db)
    agen = resp.body_iterator

    # First frame is the ": connected" primer.
    first = await agen.__anext__()
    assert "connected" in first

    # Ingest a line AFTER the stream is open → it should be pushed live.
    await _ingest(PosIngestBody(terminal="POS-LIVE", text="CARD **** 4242"), _Req(token), db)

    frame = await asyncio.wait_for(agen.__anext__(), timeout=2)
    assert "event: pos.line" in frame
    data = json.loads(frame.split("data: ", 1)[1].strip())
    assert data["text"] == "CARD **** 4242"
    await agen.aclose()


async def test_stream_disabled_overlay_keepalive_only(db):
    """A disabled overlay opens the stream but never binds a terminal (no fabrication)."""
    cam = await _make_camera(db, source="POS-OFF", enabled=False)
    token = _access_token()
    resp = await stream_pos(_Req(token), camera_id=cam.id, token=token, db=db)
    agen = resp.body_iterator
    first = await agen.__anext__()
    assert "connected" in first
    # Even if a matching terminal gets data, a disabled overlay is not subscribed.
    hub.publish(hub_key(str(TENANT), "POS-OFF"), {"terminal": "POS-OFF", "text": "nope"})
    await agen.aclose()
