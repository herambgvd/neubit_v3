"""The /auth surface, split by what the routes are FOR.

`router.py` was 1,044 lines holding five unrelated jobs — signing in, editing your
own profile, administering other people's accounts, defining roles, and minting
service credentials. They have different blast radii and different reviewers, and
the file gave no signal about which one you were reading.

TWO ROUTERS, and the split is load-bearing rather than cosmetic. `admin_router`
carries `require_tenant_active`, so a suspended tenant — or one past its licence
grace window — stops managing users, roles and API keys, while its people can still
sign in far enough to be TOLD they are suspended, and sign out. One router could not
express both.

Import order matters: the router objects must exist before the modules that decorate
them are imported, which is why the imports are at the bottom.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends

from ...tenancy.features import require_tenant_active

router = APIRouter(prefix="/auth", tags=["auth"])

#: The ADMIN surface of /auth — permissions, roles, users, API keys — separate from
#: the self-service surface purely so it can carry `require_tenant_active`.
#:
#: `/auth/token` (exchanging a raw API key for a JWT) deliberately stays on the
#: self-service router: the token it returns is refused by every guarded route
#: anyway, and failing at the point of use tells the caller why instead of 401ing.
admin_router = APIRouter(dependencies=[Depends(require_tenant_active())])

# Registered by importing the modules; each decorates one of the routers above.
# These imports have no NAME to use — the side effect IS the registration — so
# every linter will call them unused and every automatic fixer will delete them.
# Deleting them removes all 47 /auth routes and the app still starts, which is
# why this is spelled out rather than left to a `# noqa`.
from . import api_keys, profile, roles, session, users  # noqa: E402,F401

# Mounted last so the self-service paths keep their declaration order. The two sets
# do not overlap (`/me…` against `/users…`, `/roles…`, `/api-keys…`).
router.include_router(admin_router)

__all__ = ["router", "admin_router"]
