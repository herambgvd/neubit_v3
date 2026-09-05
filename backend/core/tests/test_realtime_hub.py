"""The WebSocket hub is partitioned by tenant, and /features has no open fallback.

Two latent cross-tenant defects — neither reachable today, both one ordinary commit
from being reachable, and both behind a comment saying they were fine.

  * `RealtimeHub` keyed on the caller-supplied topic STRING in a process-global
    dict. Any authenticated user could join any topic name, and a
    `broadcast("alerts", …)` would have reached every socket on "alerts" whoever
    they belonged to. Not a live leak only because `hub.broadcast` has no callers
    anywhere in backend/ — while the endpoint's docstring called the missing
    authorization something that "can be layered on later", which is exactly what
    would have reassured the person writing the first publisher.

  * The legacy signed-licence `/features` route guarded itself with "only register
    if nothing has claimed this path", scanning `app.routes`. This FastAPI version
    defers `include_router`, so an included router appears there as a wrapper with
    no `.path` — the scan found nothing and the route was registered EVERY time. It
    was harmless because the tenant-aware router happened to be included first and
    matched first. An ordering accident, not a check.
"""

from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.asyncio


class _FakeSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.accepted = False

    async def accept(self) -> None:
        self.accepted = True

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


def test_the_channel_key_carries_the_tenant():
    from app.core.realtime import channel

    a, b = uuid.uuid4(), uuid.uuid4()
    assert channel(a, "alerts") != channel(b, "alerts")
    assert "alerts" in channel(a, "alerts")
    # A NULL tenant is the platform, not a wildcard and not a collision with a
    # tenant whose id happens to render as "None".
    assert channel(None, "alerts") == "__platform__:alerts"


async def test_a_broadcast_reaches_only_its_own_tenants_sockets():
    from app.core.realtime import RealtimeHub, channel

    hub = RealtimeHub()
    a, b = uuid.uuid4(), uuid.uuid4()
    sock_a, sock_b = _FakeSocket(), _FakeSocket()
    await hub.connect(sock_a, channel(a, "alerts"))
    await hub.connect(sock_b, channel(b, "alerts"))

    await hub.broadcast(a, "alerts", {"hello": "a"})
    assert sock_a.sent == [{"hello": "a"}]
    assert sock_b.sent == [], "a broadcast crossed tenants on a shared topic name"


async def test_there_is_no_way_to_broadcast_to_every_tenant():
    """Fanning out across tenants is deliberately not expressible: `tenant_id` is a
    required positional, and no value of it means "all"."""
    import inspect

    from app.core.realtime import RealtimeHub

    sig = inspect.signature(RealtimeHub.broadcast)
    assert "tenant_id" in sig.parameters
    assert sig.parameters["tenant_id"].default is inspect.Parameter.empty


async def test_a_dead_socket_is_pruned_from_the_right_channel():
    """The prune path used the unscoped topic name, which would have removed nothing
    once the key was partitioned — a slow leak of dead sockets."""
    from app.core.realtime import RealtimeHub, channel

    class _Broken(_FakeSocket):
        async def send_json(self, message: dict) -> None:
            raise RuntimeError("closed")

    hub = RealtimeHub()
    tenant = uuid.uuid4()
    broken = _Broken()
    await hub.connect(broken, channel(tenant, "alerts"))
    await hub.broadcast(tenant, "alerts", {"x": 1})
    assert hub._topics.get(channel(tenant, "alerts")) in (None, set())


def test_the_unauthenticated_features_fallback_is_not_registered():
    """Registered every time until the claim check was fixed. Asserting on the app
    rather than on the check, so a future refactor of either is still caught."""
    from app.app import create_base_app

    app = create_base_app(title="test")
    top_level = [r for r in app.routes if getattr(r, "path", "") == "/api/v1/features"]
    assert not top_level, (
        "the legacy signed-licence /features is registered; it is unauthenticated "
        "and returns the licence, limits and module list"
    )


# --- the hub is closed by default --------------------------------------------
#
# `WS /realtime/{topic}` accepted ANY topic string from any authenticated user with
# no permission check, behind a docstring calling that something that "can be
# layered on later". `hub.broadcast` still has no callers, so there is no topic
# whose meaning anyone has decided — which is exactly why the table is empty and
# every subscription is refused, rather than every subscription being allowed.


def test_no_topic_is_open_by_default():
    """If this table ever grows an entry, it is because someone wrote a publisher
    and decided what a subscriber must hold. An entry appearing without that is the
    regression."""
    from app.core.realtime import TOPIC_PERMISSIONS

    for topic, permission in TOPIC_PERMISSIONS.items():
        assert permission, f"topic {topic!r} is registered with no permission"


def test_an_unknown_topic_is_refused_before_the_token_is_read():
    """Closed with 1008 without touching the database. The check must come FIRST —
    an unknown topic has nothing to authorize against, and doing it after auth
    would cost two database reads to say no."""
    import inspect

    from app.core import realtime

    src = inspect.getsource(realtime.realtime_ws)
    topic_check = src.index("TOPIC_PERMISSIONS.get(topic)")
    authorize = src.index("authorize_ws(ws, required)")
    assert topic_check < authorize, "the topic check must run before authorization"


def test_a_registered_topic_requires_its_permission():
    """The wiring: the endpoint passes the table's value to authorize_ws, which
    closes 4403 on a user whose role does not grant it."""
    import inspect

    from app.core import realtime

    src = inspect.getsource(realtime.realtime_ws)
    assert "required = TOPIC_PERMISSIONS.get(topic)" in src
    assert "await authorize_ws(ws, required)" in src
    # And it must not fall back to a bare authenticate: that was the bug.
    assert "authenticate_ws(" not in src
