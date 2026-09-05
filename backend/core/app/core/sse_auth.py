"""Authorization for the SSE event streams.

The four live streams — `/realtime/vms-events`, `/realtime/wall-events`,
`/realtime/access-events`, `/realtime/incidents` — each decoded the caller's token
and then stopped. Authentication without authorization: any tenant user holding NO
permissions at all received a live feed of camera events, operator popups,
video-wall state, door and cardholder access events and workflow incidents. The
REST equivalents of that data are gated (`vms.camera.read` is enforced at 26 sites
in the vision service, `vms.wall.view` at 6), so the stream was the way around the
permission model rather than a part of it.

`app/system/router.py` already showed the right shape for a socket — it calls
`authorize_ws(websocket, CorePerm.SYSTEM_READ)`. This is that, for SSE.

TWO THINGS BEYOND THE PERMISSION CHECK, both of which matter more here than on a
REST route:

  * The PERMISSIONS ARE READ FROM THE DATABASE, not from the token's `permissions`
    claim. Core's own policy is that the claim is a convenience for satellites and
    core always loads the role fresh (auth/deps.require_permission), and a stream
    is exactly where a stale claim is most expensive: a REST call with a stale
    token is one response, a stream is an open pipe for the life of the token.

  * The TENANT IS CHECKED FOR BEING ABLE TO OPERATE — suspended, or licence expired
    past grace — which is `require_tenant_active`'s job on the REST side. A stream
    that outlives a suspension keeps delivering the suspended tenant's data.

The check happens once, at connect, on a session opened and closed for it. It
deliberately does NOT hold a database session for the life of the stream: these
connections last hours and the pool does not.

WHAT THIS DOES NOT DO is re-check mid-stream. A permission revoked after connect
takes effect when the client reconnects or the token expires. Closing live streams
on revocation needs a signal from the revoking path, which is a bigger change than
this; it is written down here rather than left to be assumed.
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException, status

from ..auth.models import User
from ..db import base as db_base
from ..tenancy.models import Tenant, effective_license_state


def _deny(code: str, message: str, status_code: int) -> HTTPException:
    """The platform's error envelope, which SSE routes build by hand because they
    are not going through the normal error handlers."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})


async def authorize_stream(claims: dict, *permissions: str) -> None:
    """Raise unless the caller behind `claims` may open this stream.

    `claims` comes from the route's own `_principal_or_401`, so the signature,
    expiry and token type have already been verified. What is left is the part that
    needs the database: does this user still exist and is active, can their tenant
    still operate, and do they hold the permission.
    """
    sub = claims.get("sub")
    if not sub:
        raise _deny("UNAUTHORIZED", "token has no subject", status.HTTP_401_UNAUTHORIZED)
    try:
        user_id = uuid.UUID(str(sub))
    except ValueError:
        # An api-key token carries a non-user sub. Streams are a console surface;
        # a service credential does not open one, the same rule get_current_user
        # enforces for the REST console path.
        raise _deny("UNAUTHORIZED", "not a user token", status.HTTP_401_UNAUTHORIZED)

    # Resolved through the module rather than imported by name so a test can
    # substitute the factory. These routes cannot take a session from FastAPI's DI:
    # a StreamingResponse holds its dependencies for the LIFE OF THE STREAM, and
    # these streams last hours — fifteen open consoles would exhaust the pool. The
    # check needs a session for a few milliseconds and gives it straight back.
    sessionmaker = db_base.get_sessionmaker()
    async with sessionmaker() as db:
        user = await db.get(User, user_id)
        if user is None or not user.is_active:
            raise _deny(
                "UNAUTHORIZED", "user not found or inactive", status.HTTP_401_UNAUTHORIZED
            )

        # Tenancy comes from the LIVE row, not the claim. A user moved between
        # tenants, or deactivated, keeps a valid-looking token until it expires.
        if not user.is_superadmin and user.tenant_id is not None:
            tenant = await db.get(Tenant, user.tenant_id)
            if tenant is None:
                # Fail closed, for the same reason require_tenant_active does: a
                # tenant_id that no longer resolves is a deleted tenant whose token
                # is still in someone's browser.
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
