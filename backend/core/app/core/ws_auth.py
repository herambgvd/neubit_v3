"""WebSocket authentication/authorization helpers.

``Depends(require_permission(...))`` does not run on a WebSocket handshake —
Starlette only invokes the endpoint coroutine — so a WS route is open unless it
authenticates itself. These helpers validate the same HS256 access token the REST
API uses, so a socket enforces the same RBAC.

The browser ``WebSocket`` constructor cannot set headers, so ``?token=<access>`` is
the canonical transport, with ``Authorization: Bearer`` and
``Sec-WebSocket-Protocol`` as fallbacks for native clients. Always the short-lived
access token, never the refresh token, so a leaked WS URL expires quickly.

Close codes: 4401 unauthenticated, 4403 authenticated but not permitted.
"""

from __future__ import annotations

import uuid

import jwt
from fastapi import WebSocket

from ..auth.security import decode_token
from ..db.base import get_sessionmaker
from .logging import get_logger

log = get_logger("edge.ws_auth")


def _extract_token(websocket: WebSocket) -> str | None:
    """Pull the access token off the handshake: ?token=, then Bearer, then the
    Sec-WebSocket-Protocol subprotocol. None if there is no token anywhere."""
    # Query string — the browser path; WebSocket cannot set headers.
    token = websocket.query_params.get("token")
    if token:
        return token
    # Authorization header — native clients and proxies.
    auth = websocket.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    # Subprotocol — some clients pass the token as the requested subprotocol.
    proto = websocket.headers.get("sec-websocket-protocol")
    if proto:
        # Comma-separated; the first non-empty entry is the token.
        first = proto.split(",")[0].strip()
        return first or None
    return None


async def authenticate_ws(websocket: WebSocket):
    """Authenticate a WebSocket from its access token.

    Returns the live ``User``, or closes the socket with 4401 and returns None. The
    caller must ``return`` immediately on None.
    """
    # Lazy: auth.models -> db.base -> ... -> core is an import cycle.
    from ..auth.models import User

    token = _extract_token(websocket)
    if not token:
        log.debug("ws auth: no token on handshake")
        await websocket.close(code=4401)
        return None

    try:
        claims = decode_token(token)  # verifies HS256 signature + expiry
    except jwt.PyJWTError:
        log.debug("ws auth: token decode failed")
        await websocket.close(code=4401)
        return None

    # A refresh token must never open a socket.
    if claims.get("type") != "access":
        log.debug("ws auth: non-access token type=%s", claims.get("type"))
        await websocket.close(code=4401)
        return None

    sub = claims.get("sub")
    try:
        user_id = uuid.UUID(str(sub))
    except (ValueError, TypeError):
        log.debug("ws auth: malformed sub claim")
        await websocket.close(code=4401)
        return None

    # Load fresh so a deactivation takes effect immediately, as on HTTP.
    async with get_sessionmaker()() as db:
        user = await db.get(User, user_id)

    if user is None or not user.is_active:
        log.debug("ws auth: user missing or inactive")
        await websocket.close(code=4401)
        return None

    return user


async def authorize_ws(websocket: WebSocket, permission: str):
    """Authenticate, then require the user's role to grant ``permission``.

    Returns the ``User``, or closes with 4401 (unauthenticated) or 4403 (not
    permitted) and returns None. The caller must ``return`` on None.
    """
    user = await authenticate_ws(websocket)
    if user is None:
        # Already closed with 4401.
        return None
    if not user.role.grants(permission):
        log.debug("ws auth: user %s lacks permission %s", user.id, permission)
        await websocket.close(code=4403)
        return None
    return user
