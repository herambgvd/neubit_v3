"""Realtime WebSocket hub — push live updates to the browser by TOPIC.

Scenarios need to stream events to open UIs: a live video wall, an alert feed, a
resource/health meter, in-app notifications. This provides a tiny pub/sub over
WebSockets: clients connect to ``/api/realtime/{topic}`` and any server code can
``await hub.broadcast(topic, {...})`` to fan a JSON message out to everyone on that
topic.

    # server side, from anywhere (a service, a task callback, an event handler):
    from app.core.realtime import hub
    await hub.broadcast("alerts", {"type": "motion", "camera": "front-door"})

    # client side:
    const ws = new WebSocket(`ws://host/api/realtime/alerts`)
    ws.onmessage = (e) => render(JSON.parse(e.data))

Single-process and in-memory: connections live in THIS process. To scale across
pods, back ``broadcast`` with a Redis pub/sub — a channel per topic, each process
relaying to its local sockets. Deliberately not done yet, so single-node stays simple.
"""

from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .logging import get_logger
from .ws_auth import authorize_ws

log = get_logger("edge.realtime")


def channel(tenant_id, topic: str) -> str:
    """The key a socket is filed under: the tenant AND the topic.

    Partitioning the key is what makes cross-tenant fan-out impossible from the
    publish side — "every tenant's alerts" does not name anything. Do not key on
    the caller-supplied topic string alone.
    """
    return f"{tenant_id if tenant_id is not None else '__platform__'}:{topic}"


class RealtimeHub:
    """In-memory registry of connected WebSockets, grouped by (tenant, topic).

    ``_topics`` maps a channel key (see :func:`channel`) to the live sockets on it.
    """

    def __init__(self) -> None:
        self._topics: dict[str, set[WebSocket]] = {}

    async def connect(self, ws: WebSocket, topic: str) -> None:
        """Accept the handshake and register the socket under ``topic``.

        ``topic`` here is a channel key, not a bare topic name — build it with
        :func:`channel` so a socket only lands in its own tenant's set.
        """
        await ws.accept()
        self._topics.setdefault(topic, set()).add(ws)
        log.debug("ws connect topic=%s (n=%d)", topic, len(self._topics[topic]))

    def disconnect(self, ws: WebSocket, topic: str) -> None:
        """Remove the socket from ``topic``; drop the topic once it's empty."""
        conns = self._topics.get(topic)
        if not conns:
            return
        conns.discard(ws)
        if not conns:
            # Forget the topic so the dict doesn't fill with empty sets.
            self._topics.pop(topic, None)
        log.debug("ws disconnect topic=%s", topic)

    async def broadcast(self, tenant_id, topic: str, message: dict) -> None:
        """Send ``message`` as JSON to one tenant's sockets on ``topic``.

        ``tenant_id`` is required and ``None`` means the platform, not a wildcard —
        fanning out to every tenant is deliberately not expressible. Sockets that
        error on send are pruned, so a broken client cannot block the others.
        """
        key = channel(tenant_id, topic)
        dead: list[WebSocket] = []
        for ws in list(self._topics.get(key, ())):
            try:
                await ws.send_json(message)
            except Exception:  # noqa: BLE001 — a dead/closing socket; drop it
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, key)


# The single shared hub for the whole process.
hub = RealtimeHub()


#: Topics this hub accepts a subscription for, and the permission each needs.
#: Empty because nothing publishes yet. Closed by default: adding a publisher means
#: writing down here what a subscriber must hold to see it.
TOPIC_PERMISSIONS: dict[str, str] = {}


realtime_router = APIRouter(prefix="/realtime", tags=["realtime"])


@realtime_router.websocket("/{topic}")
async def realtime_ws(ws: WebSocket, topic: str) -> None:
    """WebSocket endpoint: subscribe to ``topic`` and receive its broadcasts.

    Server→client push only. The receive loop exists to notice a disconnect and
    free the slot; inbound messages are ignored.

    The client passes its access token as ``?token=<access>`` on the handshake.
    ``authorize_ws`` closes the socket itself (4401 / 4403) and returns None, and
    we return before ``hub.connect``, so a refused caller never joins the topic.
    The socket is filed under the caller's own tenant (see :func:`channel`).

    The topic must appear in ``TOPIC_PERMISSIONS``. That table is empty, so every
    subscription is refused today — correct, because nothing publishes yet.
    """
    required = TOPIC_PERMISSIONS.get(topic)
    if required is None:
        # 1008 POLICY_VIOLATION, before the token is read: there is nothing to
        # authorize against. Does reveal which topics exist, which is fine — the
        # table is small and non-secret, and this avoids two database reads to
        # say no.
        await ws.close(code=1008)
        return
    # authorize_ws both authenticates and checks the permission. Do not add a bare
    # authenticate step first — that decodes the token and loads the user twice.
    user = await authorize_ws(ws, required)
    if user is None:
        return
    key = channel(getattr(user, "tenant_id", None), topic)
    await hub.connect(ws, key)
    try:
        while True:
            # Parks the coroutine and raises WebSocketDisconnect when the socket
            # closes. Client messages are not acted on.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws, key)
