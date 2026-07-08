"""P2-B live-streaming control-plane tests (no network).

Exercises the full vision side of live streaming against an in-memory SQLite DB
with the Go ``nvr`` call stubbed (monkeypatched ``NvrClient``): session issue →
token mint + persist + URL assembly (``?token=``), verify (valid / bad / expired /
wrong-type), renew (re-mint without re-ensuring), release (row gone + best-effort
nvr drop), tenant scoping, and graceful upstream errors (nvr down → 502).

Mirrors the driver-test discipline: every network boundary is a fabricated stub;
``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import jwt
import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from kernel.auth import Scope
from kernel.errors import ForbiddenError, NotFoundError, UnauthorizedError

from app.db import Base
from app.vms.common import media_token
from app.vms.common.nvr_client import NvrUnavailable
from app.vms.live import service as live_service
from app.vms.live.service import LiveService, LiveUpstreamError
from app.vms.models import Camera, MediaProfile

TENANT = uuid.uuid4()
OTHER_TENANT = uuid.uuid4()


class _Actor:
    user_id = uuid.uuid4()


class _StubNvr:
    """Stub Go-nvr client: records calls, returns canned ensure URLs."""

    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.ensured: list[dict] = []
        self.dropped: list[tuple[str, str]] = []

    async def ensure_stream(self, *, camera_id, rtsp_url, profile):
        self.ensured.append({"camera_id": camera_id, "rtsp_url": rtsp_url, "profile": profile})
        if self.fail:
            raise NvrUnavailable("nvr data-plane unreachable: boom")
        name = f"cameras/{TENANT}/{camera_id}/{profile}"
        return {
            "name": name,
            "node": "mediamtx-0",
            "hls_url": f"http://localhost:8888/{name}/index.m3u8",
            "webrtc_url": f"http://localhost:8889/{name}/whep",
            "rtsp_url": f"rtsp://localhost:8554/{name}",
            "ready": True,
            "readers": 0,
        }

    async def drop_stream(self, *, camera_id, profile):
        self.dropped.append((camera_id, profile))
        return True


@pytest_asyncio.fixture
async def db():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with Session() as s:
        yield s
    await engine.dispose()


@pytest_asyncio.fixture
async def camera(db):
    cam = Camera(
        id=str(uuid.uuid4()),
        tenant_id=TENANT,
        name="Cam A",
        connection_type="rtsp",
        onvif_user="admin",
    )
    db.add(cam)
    db.add(
        MediaProfile(
            camera_id=cam.id,
            tenant_id=TENANT,
            name="sub",
            rtsp_path="rtsp://cam.local:554/sub",
        )
    )
    await db.commit()
    return cam


def _scope(tenant=TENANT):
    return Scope(tenant_id=tenant, is_superadmin=False)


def _svc(db, stub, tenant=TENANT):
    svc = LiveService(db, _scope(tenant), bearer="fake.jwt")
    svc.nvr = stub
    return svc


# ── issue ────────────────────────────────────────────────────────────────


async def test_start_live_issues_session_with_token_urls(db, camera):
    stub = _StubNvr()
    out = await _svc(db, stub).start_live(camera.id, "sub", actor=_Actor())

    # nvr was asked to ensure the sub-stream RTSP.
    assert stub.ensured and stub.ensured[0]["profile"] == "sub"
    assert stub.ensured[0]["rtsp_url"].startswith("rtsp://")
    # URLs carry the media token as ?token= (browser HLS/WHEP auth).
    assert "?token=" in out.hls_url and "?token=" in out.webrtc_url
    assert out.token and out.ready is True
    # SQLite drops tzinfo on read-back (Postgres keeps it — column is timestamptz);
    # normalise to naive-UTC for the comparison so the test is backend-agnostic.
    exp = out.expires_at
    if exp.tzinfo is not None:
        exp = exp.astimezone(timezone.utc).replace(tzinfo=None)
    assert exp > datetime.now(timezone.utc).replace(tzinfo=None)

    # The token is a valid media token bound to this session + camera + tenant.
    claims = media_token.verify_media_token(out.token)
    assert claims["sub_type"] == "media"
    assert claims["camera_id"] == camera.id
    assert claims["session_id"] == out.session_id
    assert claims["tenant_id"] == str(TENANT)


async def test_start_live_persists_only_token_hash(db, camera):
    stub = _StubNvr()
    out = await _svc(db, stub).start_live(camera.id, "sub", actor=_Actor())
    from app.vms.models import PlaybackSession

    row = await db.get(PlaybackSession, out.session_id)
    assert row is not None
    assert row.token_hash == media_token.token_hash(out.token)
    # Raw token is NEVER at rest.
    assert out.token not in (row.token_hash or "")
    assert row.mediamtx_name and row.node == "mediamtx-0"


async def test_start_live_nvr_down_is_502_not_500(db, camera):
    stub = _StubNvr(fail=True)
    with pytest.raises(LiveUpstreamError) as ei:
        await _svc(db, stub).start_live(camera.id, "sub", actor=_Actor())
    assert ei.value.status_code == 502


async def test_start_live_no_rtsp_is_502(db):
    # Camera with no media profile + no host → nothing derivable → clean 502.
    cam = Camera(id=str(uuid.uuid4()), tenant_id=TENANT, name="No RTSP", connection_type="rtsp")
    db.add(cam)
    await db.commit()
    with pytest.raises(LiveUpstreamError):
        await _svc(db, _StubNvr()).start_live(cam.id, "sub", actor=_Actor())


async def test_start_live_tenant_isolation(db, camera):
    # A different tenant cannot see the camera → NotFound (not 500/502).
    with pytest.raises(NotFoundError):
        await _svc(db, _StubNvr(), tenant=OTHER_TENANT).start_live(
            camera.id, "sub", actor=_Actor()
        )


# ── verify (hot path) ──────────────────────────────────────────────────────


async def test_verify_valid_token(db, camera):
    out = await _svc(db, _StubNvr()).start_live(camera.id, "sub", actor=_Actor())
    claims = await _svc(db, _StubNvr()).verify(out.token)
    assert claims["session_id"] == out.session_id


async def test_verify_bad_token_raises_401(db):
    with pytest.raises(UnauthorizedError):
        await _svc(db, _StubNvr()).verify("not.a.jwt")


async def test_verify_expired_token_raises_401(db, camera):
    # Mint an already-expired media token by hand (negative TTL).
    from app.vms.common.media_token import _secret

    now = int(datetime.now(timezone.utc).timestamp())
    tok = jwt.encode(
        {"sub_type": "media", "camera_id": camera.id, "session_id": "x", "iat": now - 10, "exp": now - 1},
        _secret(),
        algorithm="HS256",
    )
    with pytest.raises(UnauthorizedError):
        await _svc(db, _StubNvr()).verify(tok)


async def test_verify_rejects_access_token(db):
    # An access-typed token must not pass media verify (type confusion guard).
    from app.vms.common.media_token import _secret

    now = int(datetime.now(timezone.utc).timestamp())
    tok = jwt.encode({"type": "access", "sub": "u", "exp": now + 300}, _secret(), algorithm="HS256")
    with pytest.raises(UnauthorizedError):
        await _svc(db, _StubNvr()).verify(tok)


async def test_verify_check_camera_tenant_mismatch(db, camera):
    out = await _svc(db, _StubNvr()).start_live(camera.id, "sub", actor=_Actor())
    # Forge a token for a real session but claiming a different tenant.
    from app.vms.common.media_token import _secret

    now = int(datetime.now(timezone.utc).timestamp())
    tok = jwt.encode(
        {
            "sub_type": "media",
            "camera_id": camera.id,
            "session_id": out.session_id,
            "tenant_id": str(OTHER_TENANT),
            "iat": now,
            "exp": now + 300,
        },
        _secret(),
        algorithm="HS256",
    )
    with pytest.raises(NotFoundError):
        await _svc(db, _StubNvr()).verify(tok, check_camera=True)


# ── renew + release ────────────────────────────────────────────────────────


async def test_renew_remints_without_reensuring(db, camera):
    issue_stub = _StubNvr()
    out = await _svc(db, issue_stub).start_live(camera.id, "sub", actor=_Actor())

    renew_stub = _StubNvr()
    renewed = await _svc(db, renew_stub).renew(out.session_id, actor=_Actor())
    # Renew did NOT call ensure again.
    assert renew_stub.ensured == []
    # New token still valid + bound to the same session.
    claims = media_token.verify_media_token(renewed.token)
    assert claims["session_id"] == out.session_id


async def test_release_deletes_row_and_drops_path(db, camera):
    out = await _svc(db, _StubNvr()).start_live(camera.id, "sub", actor=_Actor())
    drop_stub = _StubNvr()
    await _svc(db, drop_stub).release(out.session_id, actor=_Actor())
    from app.vms.models import PlaybackSession

    assert await db.get(PlaybackSession, out.session_id) is None
    assert drop_stub.dropped == [(camera.id, "sub")]


async def test_release_other_tenant_cannot(db, camera):
    out = await _svc(db, _StubNvr()).start_live(camera.id, "sub", actor=_Actor())
    with pytest.raises(NotFoundError):
        await _svc(db, _StubNvr(), tenant=OTHER_TENANT).release(out.session_id, actor=_Actor())


# ── url/token helpers ──────────────────────────────────────────────────────


def test_append_token_query():
    assert live_service._append_token("http://h/x.m3u8", "T").endswith("?token=T")
    assert "&token=T" in live_service._append_token("http://h/x?a=1", "T")
    assert live_service._append_token(None, "T") is None


def test_media_token_ttl_env(monkeypatch):
    monkeypatch.setenv("VE_MEDIA_TOKEN_TTL_SEC", "42")
    assert media_token.media_token_ttl() == 42
    monkeypatch.setenv("VE_MEDIA_TOKEN_TTL_SEC", "bad")
    assert media_token.media_token_ttl() == 300
