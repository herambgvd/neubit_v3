"""Authentication and authorization for the SSE event streams.

The live streams (`/realtime/vms-events`, `/realtime/wall-events`,
`/realtime/access-events`, `/realtime/incidents`) carry data whose REST equivalents
are permission-gated, so they need the same gate. This is `authorize_ws`, for SSE.

Two things beyond the permission check:

  * Permissions are read from the DATABASE, not the token's `permissions` claim.
    A stale claim on a REST call costs one response; on a stream it costs an open
    pipe for the life of the token.
  * The tenant is checked for being able to operate (suspended, licence expired),
    which is `require_tenant_active`'s job on the REST side.

`principal_or_401` is the step BEFORE all of that: who is this. It lived as a
private copy in each of the three stream modules — byte-identical in two of them
and differing by a comment in the third — which is the wrong number of copies for
any code and a bad one for code that decides whether a request is authenticated.
A fix applied to one of three is the failure mode; there is now one.

The check runs at connect on a session opened and closed for it — it must NOT hold
a database session for the life of the stream, because these connections last hours
and the pool does not.

`StreamGuard` re-runs the same check every `VE_SSE_REVALIDATE_SECONDS` while the
stream is open, so deactivating a user or suspending a tenant takes effect within
one interval instead of never. Polling rather than a signal from the revoking path:
a signal needs every revoking path to publish, possibly from another process.
"""

from __future__ import annotations

import time
import uuid

import jwt
from fastapi import HTTPException, Request, status

from ..auth.models import User
from ..auth.security import decode_token
from ..db import base as db_base
from ..core.config import get_settings
from ..core.logging import get_logger
from ..tenancy.models import Tenant, effective_license_state


log = get_logger("edge.sse")


def _deny(code: str, message: str, status_code: int) -> HTTPException:
    """The platform's error envelope. SSE routes build it by hand — they do not go
    through the normal error handlers."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


def extract_token(request: Request, token_qs: str | None) -> str | None:
    """The access token, from `?token=` first and then a Bearer header.

    Query string first because a browser's EventSource cannot set headers — which
    is the whole reason these streams accept a token there at all.
    """
    if token_qs:
        return token_qs
    auth = request.headers.get("authorization") or request.headers.get("Authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip() or None
    return None


def principal_or_401(request: Request, token_qs: str | None) -> dict:
    """Validate the access token (HS256, shared secret) → claims, or 401.

    Uses core's ``decode_token`` — the same HS256 ``jwt_secret`` the satellite
    services' ``kernel.verify_token`` uses. Core issues the token, so it validates
    locally rather than asking anything.

    Each refusal says which check failed, and they are deliberately distinct: "not
    an access token" and "expired" send an operator to different places.
    """
    token = extract_token(request, token_qs)
    if not token:
        raise _deny("UNAUTHORIZED", "SSE auth required", status.HTTP_401_UNAUTHORIZED)
    try:
        claims = decode_token(token)  # verifies signature + expiry
    except jwt.PyJWTError:
        raise _deny("UNAUTHORIZED", "invalid or expired token", status.HTTP_401_UNAUTHORIZED)
    if claims.get("type") != "access":
        raise _deny("UNAUTHORIZED", "not an access token", status.HTTP_401_UNAUTHORIZED)
    if not claims.get("sub"):
        raise _deny("UNAUTHORIZED", "token missing subject", status.HTTP_401_UNAUTHORIZED)
    return claims


async def authorize_stream(claims: dict, *permissions: str) -> None:
    """Raise unless the caller behind `claims` may open this stream.

    Signature, expiry and token type are already verified by the route's
    `_principal_or_401`. This is the part that needs the database: is the user live
    and active, can their tenant operate, do they hold the permission.
    """
    sub = claims.get("sub")
    if not sub:
        raise _deny("UNAUTHORIZED", "token has no subject", status.HTTP_401_UNAUTHORIZED)
    try:
        user_id = uuid.UUID(str(sub))
    except ValueError:
        # An api-key token carries a non-user sub. Streams are a console surface,
        # and a service credential does not open one — same rule as get_current_user.
        raise _deny("UNAUTHORIZED", "not a user token", status.HTTP_401_UNAUTHORIZED)

    # Resolved through the module, not imported by name, so a test can substitute
    # the factory. Do not take the session from FastAPI's DI: a StreamingResponse
    # holds its dependencies for the life of the stream, and these last hours.
    sessionmaker = db_base.get_sessionmaker()
    async with sessionmaker() as db:
        user = await db.get(User, user_id)
        if user is None or not user.is_active:
            raise _deny(
                "UNAUTHORIZED", "user not found or inactive", status.HTTP_401_UNAUTHORIZED
            )

        # Tenancy comes from the live row, not the claim: a moved or deactivated
        # user keeps a valid-looking token until it expires.
        if not user.is_superadmin and user.tenant_id is not None:
            tenant = await db.get(Tenant, user.tenant_id)
            if tenant is None:
                # Fail closed like require_tenant_active: an unresolvable tenant_id
                # is a deleted tenant whose token is still in a browser.
                raise _deny(
                    "TENANT_SUSPENDED", "the tenant no longer exists", status.HTTP_403_FORBIDDEN
                )
            if tenant.status == "suspended":
                raise _deny(
                    "TENANT_SUSPENDED",
                    "the tenant is suspended — contact support",
                    status.HTTP_403_FORBIDDEN,
                )
            if effective_license_state(tenant) == "expired":
                raise _deny(
                    "LICENSE_EXPIRED",
                    "the tenant's license has expired — renew to continue",
                    status.HTTP_403_FORBIDDEN,
                )

        role = user.role
        missing = [p for p in permissions if not (role is not None and role.grants(p))]
        if missing:
            raise _deny(
                "FORBIDDEN",
                f"missing permission(s): {', '.join(missing)}",
                status.HTTP_403_FORBIDDEN,
            )


class StreamGuard:
    """Re-runs `authorize_stream` periodically for a stream that is already open.

    Asked on each keepalive whether the stream may continue. Returns False rather
    than raising: the status code has already been sent, so the only way to refuse
    is to end the body. Rate-limited to `VE_SSE_REVALIDATE_SECONDS` rather than
    running every tick, so it is not a database round-trip per stream per keepalive.
    """

    def __init__(self, claims: dict, *permissions: str) -> None:
        self._claims = claims
        self._permissions = permissions
        self._interval = float(get_settings().sse_revalidate_seconds)
        self._checked_at = time.monotonic()

    async def still_allowed(self) -> bool:
        now = time.monotonic()
        if now - self._checked_at < self._interval:
            return True
        self._checked_at = now
        try:
            await authorize_stream(self._claims, *self._permissions)
            return True
        except HTTPException as exc:
            log.info(
                "closing SSE stream for sub=%s: %s",
                self._claims.get("sub"),
                (exc.detail or {}).get("code") if isinstance(exc.detail, dict) else exc.detail,
            )
            return False
        except Exception:
            # A database blip must not drop every open stream in the estate. Retry
            # next interval; the token's own expiry is still the outer bound.
            log.warning("SSE revalidation failed to run; keeping the stream", exc_info=True)
            return True
