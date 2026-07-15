"""Best-effort video-access audit client tests (``report_video_audit``) — no network.

Exercises the vision-side audit client against a monkeypatched ``httpx.AsyncClient`` so
NO real core is touched. Covers the three contract points from Task 3:

  * ``VE_CORE_URL`` unset  → no HTTP call is made (no-op), returns cleanly.
  * ``VE_CORE_URL`` set    → POSTs to ``<core>/api/v1/security/audit/video`` with a
    Bearer header + a body carrying action/target_id/actor_id/tenant_id.
  * a failing POST         → the error is SWALLOWED (best-effort); it never raises.

``pytest-asyncio`` auto mode runs the ``async def test_*`` coroutines.
"""

from __future__ import annotations

import uuid

import httpx
import pytest

from app.vms.common import core_audit


class _Principal:
    """Minimal stand-in for ``kernel.auth.Principal`` (only the fields the client reads)."""

    def __init__(self, user_id: uuid.UUID, tenant_id: uuid.UUID | None):
        self.user_id = user_id
        self.tenant_id = tenant_id


class _FakeResponse:
    def __init__(self, status_code: int = 201):
        self.status_code = status_code


class _FakeClient:
    """Records the POST it receives; stands in for ``httpx.AsyncClient``."""

    calls: list[dict] = []

    def __init__(self, *args, **kwargs):
        self.headers = kwargs.get("headers", {})

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def post(self, url, json=None):
        _FakeClient.calls.append({"url": url, "json": json, "headers": self.headers})
        return _FakeResponse(201)


@pytest.fixture(autouse=True)
def _reset_calls():
    _FakeClient.calls = []
    yield
    _FakeClient.calls = []


async def test_no_op_when_core_url_unset(monkeypatch):
    """``VE_CORE_URL`` unset → no HTTP client is constructed at all (silent no-op)."""
    monkeypatch.delenv("VE_CORE_URL", raising=False)

    def _boom(*a, **k):  # pragma: no cover — must not be reached
        raise AssertionError("httpx.AsyncClient must not be built when core is off")

    monkeypatch.setattr(core_audit.httpx, "AsyncClient", _boom)

    # Must return cleanly without raising.
    await core_audit.report_video_audit(
        action="vms.playback.view",
        camera_id="cam-1",
        principal=_Principal(uuid.uuid4(), uuid.uuid4()),
        meta={"from": "a", "to": "b"},
    )
    assert _FakeClient.calls == []


async def test_posts_to_core_with_bearer_and_body(monkeypatch):
    """``VE_CORE_URL`` set → POST to the audit path with Bearer + a well-formed body."""
    monkeypatch.setenv("VE_CORE_URL", "http://core:8000")
    monkeypatch.delenv("VE_API_PREFIX", raising=False)  # → default /api/v1
    monkeypatch.setattr(core_audit.httpx, "AsyncClient", _FakeClient)

    user_id = uuid.uuid4()
    tenant_id = uuid.uuid4()
    await core_audit.report_video_audit(
        action="vms.export.request",
        camera_id="cam-42",
        principal=_Principal(user_id, tenant_id),
        meta={"from": "t0", "to": "t1", "format": "mp4", "job_id": "job-9"},
    )

    assert len(_FakeClient.calls) == 1
    call = _FakeClient.calls[0]
    # URL: <core>/api/v1/security/audit/video
    assert call["url"] == "http://core:8000/api/v1/security/audit/video"
    # Bearer header present.
    auth = call["headers"].get("Authorization", "")
    assert auth.startswith("Bearer ") and len(auth) > len("Bearer ")
    # Body carries the required fields.
    body = call["json"]
    assert body["action"] == "vms.export.request"
    assert body["target_type"] == "camera"
    assert body["target_id"] == "cam-42"
    assert body["actor_id"] == str(user_id)
    assert body["tenant_id"] == str(tenant_id)
    assert body["actor_email"] is None
    assert body["meta"]["job_id"] == "job-9"


async def test_failure_is_swallowed(monkeypatch):
    """A POST that raises must be swallowed — the client returns without raising."""
    monkeypatch.setenv("VE_CORE_URL", "http://core:8000")

    class _RaisingClient(_FakeClient):
        async def post(self, url, json=None):
            raise httpx.ConnectError("core unreachable")

    monkeypatch.setattr(core_audit.httpx, "AsyncClient", _RaisingClient)

    # Best-effort: must NOT raise despite the POST blowing up.
    await core_audit.report_video_audit(
        action="vms.playback.view",
        camera_id="cam-1",
        principal=_Principal(uuid.uuid4(), None),
        meta=None,
    )


async def test_non_2xx_is_swallowed(monkeypatch):
    """A non-2xx response is logged + swallowed (still no raise)."""
    monkeypatch.setenv("VE_CORE_URL", "http://core:8000")

    class _403Client(_FakeClient):
        async def post(self, url, json=None):
            _FakeClient.calls.append({"url": url, "json": json, "headers": self.headers})
            return _FakeResponse(403)

    monkeypatch.setattr(core_audit.httpx, "AsyncClient", _403Client)

    await core_audit.report_video_audit(
        action="vms.export.request",
        camera_id="cam-1",
        principal=_Principal(uuid.uuid4(), uuid.uuid4()),
    )
    # It attempted the POST (and swallowed the 403).
    assert len(_FakeClient.calls) == 1
