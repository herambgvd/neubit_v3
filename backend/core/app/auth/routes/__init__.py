"""The /auth surface, split by what the routes are for: signing in, your own
profile, other people's accounts, roles, and service credentials.

The two routers are load-bearing. `admin_router` carries `require_tenant_active`,
so a suspended tenant stops managing users, roles and API keys while its people
can still sign in far enough to be told they are suspended, and sign out.

Import order matters: the router objects must exist before the modules that
decorate them are imported, which is why those imports are at the bottom.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...tenancy.features import require_tenant_active

router = APIRouter(prefix="/auth", tags=["auth"])

#: The admin surface of /auth — permissions, roles, users, API keys — separate
#: from the self-service surface purely so it can carry `require_tenant_active`.
#:
#: `/auth/token` stays on the self-service router: the token it returns is refused
#: by every guarded route anyway, and failing at the point of use says why.
admin_router = APIRouter(dependencies=[Depends(require_tenant_active())])

# Imported for the side effect: each module registers its routes. Deleting these
# removes all 47 /auth routes and the app still starts. Do not "fix".
from . import api_keys, profile, roles, session, users  # noqa: E402,F401

# Mounted last so the self-service paths keep their declaration order. The two sets
# do not overlap (`/me…` against `/users…`, `/roles…`, `/api-keys…`).
router.include_router(admin_router)

__all__ = ["router", "admin_router"]
