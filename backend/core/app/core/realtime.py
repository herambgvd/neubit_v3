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

SCOPE: this hub is single-process, in-memory — connections live in THIS process.
That's perfect for a single app instance. To scale across multiple processes/pods,
back ``broadcast`` with a Redis pub/sub (``settings.redis_url``): publish to a
Redis channel per topic and have each process relay received messages to its local
sockets. Left as a deliberate next step so the common single-node case stays simple.
"""

from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .logging import get_logger
from .ws_auth import authorize_ws

log = get_logger("edge.realtime")


def channel(tenant_id, topic: str) -> str:
    """The key a socket is actually filed under: the tenant AND the topic.

    The hub used to key on the caller-supplied topic string alone — a process-global
    `dict[str, set[WebSocket]]` shared by every tenant. Any authenticated user could
    join any topic name, and a `broadcast("alerts", …)` would have gone to every
    socket on "alerts" regardless of who they belonged to.

    That was not a live leak, and only because nothing publishes: `hub.broadcast` has
    no callers anywhere in `backend/`. It was a cross-tenant leak waiting for the
    first one, behind a docstring that called the missing authorization something
    that "can be layered on later" — and the person writing that first publisher
    would have had no reason to think the hub was not already partitioned.

    Partitioning the KEY is what makes it impossible to get wrong from the publish
    side: there is no way to broadcast to "every tenant's alerts" by accident,
    because that string does not name anything.
    """
    return f"{tenant_id if tenant_id is not None else '__platform__'}:{topic}"


class RealtimeHub:
    """In-memory registry of connected WebSockets, grouped by (tenant, topic).

    ``_topics`` maps a channel key — see :func:`channel` — to the set of live
    sockets subscribed to it. A set gives O(1) add/remove and de-duplication.
    """

    def __init__(self) -> None:
        self._topics: dict[str, set[WebSocket]] = {}

    async def connect(self, ws: WebSocket, topic: str) -> None:
        """Accept the handshake and register the socket under ``topic``.

        ``topic`` is a CHANNEL KEY, not a bare topic name — build it with
        :func:`channel` so a socket can only ever land in its own tenant's set.
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
            # No subscribers left — forget the topic so the dict doesn't grow
            # unbounded with stale empty sets.
            self._topics.pop(topic, None)
        log.debug("ws disconnect topic=%s", topic)

    async def broadcast(self, tenant_id, topic: str, message: dict) -> None:
        """Send ``message`` (as JSON) to every socket of ONE TENANT on ``topic``.

        ``tenant_id`` is required, and ``None`` means the platform — it is not a
        wildcard. Fanning out to every tenant is deliberately not expressible here.

        Sockets that error on send are assumed dead and pruned, so a broken client
        never blocks or breaks delivery to the others. Iterate over a COPY of the
        set because we mutate it while dropping dead sockets.
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


#: Topics this hub will accept a subscription for, and the permission each needs.
#:
#: EMPTY, and that is the state the endpoint is in: `hub.broadcast` has no callers
#: anywhere in `backend/`, so there is no topic whose meaning anyone has decided.
#:
#: Closed by default rather than open by default, because the alternative is what
#: was here — any authenticated user could subscribe to any topic string, and the
#: docstring described the missing authorization as something that "can be layered
#: on later". Whoever writes the first publisher would have had no reason to think
#: the hub was not already gated. Now they cannot publish to a topic without first
#: writing down, here, what a subscriber must hold to see it.
TOPIC_PERMISSIONS: dict[str, str] = {}


realtime_router = APIRouter(prefix="/realtime", tags=["realtime"])


@realtime_router.websocket("/{topic}")
async def realtime_ws(ws: WebSocket, topic: str) -> None:
    """WebSocket endpoint: subscribe to ``topic`` and receive its broadcasts.

    This connection is receive-to-detect-disconnect: the server pushes via
    ``hub.broadcast`` while this loop just waits on ``receive_text`` so it notices
    when the client goes away (WebSocketDisconnect) and can clean up its slot.
    Inbound messages from the client are ignored (this hub is server→client push).

    Authenticated AND authorized: the client passes its access token as
    ``?token=<access>`` on the handshake (see edge.core.ws_auth). ``authorize_ws``
    closes the socket with 4401 for a missing/invalid token or an unknown/inactive
    user and 4403 for a valid one lacking the topic's permission, returning None in
    both cases — we return before ``hub.connect``, so neither ever joins the topic.

    The socket is filed under the CALLER'S OWN tenant (see :func:`channel`), so the
    topic string a client sends can never reach another tenant's subscribers.

    And the topic must be one this process KNOWS: it has to appear in
    ``TOPIC_PERMISSIONS`` with the permission a subscriber needs. That table is
    empty, so every subscription is currently refused — which is correct, because
    nothing publishes. It used to accept any string from any authenticated user
    with no permission check at all, behind a docstring calling that something that
    "can be layered on later"; closed-by-default means the first publisher has to
    decide what its topic means before anyone can subscribe to it, instead of
    inheriting an open hub.
    """
    required = TOPIC_PERMISSIONS.get(topic)
    if required is None:
        # 1008 POLICY_VIOLATION. Closed before the token is even looked at, because
        # there is nothing to authorize against. Note this DOES tell an
        # authenticated caller which topics exist — the set is a small, documented,
        # non-secret table, so that is a fair trade for refusing an unknown topic
        # cheaply rather than after two database reads.
        await ws.close(code=1008)
        return
    # authorize_ws authenticates AND checks the permission, closing the socket
    # itself (4401 / 4403) and returning None. Calling authenticate_ws first as
    # well would decode the token and load the user twice for one handshake.
    user = await authorize_ws(ws, required)
    if user is None:
        return
    key = channel(getattr(user, "tenant_id", None), topic)
    await hub.connect(ws, key)
    try:
        while True:
            # We don't act on client messages; this call parks the coroutine and
            # raises WebSocketDisconnect the moment the socket closes.
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        hub.disconnect(ws, key)
