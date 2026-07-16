"""Global search — one ``GET /search?q=`` the command palette (⌘K) calls.

Searches the core entities the caller is allowed to see (users, roles) and returns
a flat, uniformly-shaped result list the frontend renders and links to. Scenarios
can extend coverage later by adding their own searchers; the shape stays the same.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth.deps import get_current_user
from ..auth.models import Role, User
from ..auth.permissions import CorePerm
from ..auth.service import AuthService
from ..db.base import get_db
from ..tenancy.scope import scope_of, scoped

router = APIRouter(prefix="/search", tags=["search"])

_LIMIT = 8  # per category — keep the palette snappy


@router.get("")
async def search(
    q: str = Query(default="", min_length=0),
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Return up to a handful of matches per entity the caller can access."""
    term = q.strip()
    results: list[dict] = []
    if not term:
        return {"results": results}
    like = f"%{term}%"
    # Tenant isolation: a tenant-admin must only ever see THEIR tenant's users/roles
    # here, exactly like the /users and /roles lists. Super-admins see everyone.
    scope = scope_of(user)

    if user.role.grants(CorePerm.USER_READ):
        rows = (
            await db.execute(
                scoped(
                    select(User).where(
                        or_(User.email.ilike(like), User.full_name.ilike(like))
                    ),
                    User,
                    scope,
                ).limit(_LIMIT)
            )
        ).scalars().all()
        for u in rows:
            results.append(
                {
                    "type": "user",
                    "id": str(u.id),
                    "label": u.full_name or u.email,
                    "sublabel": u.email,
                    "href": "/users",
                    "icon": "heroicons-outline:user",
                }
            )

    if user.role.grants(CorePerm.ROLE_READ):
        # roles_query already scopes to own-tenant + shared system roles (NULL tenant);
        # super-admins get all. Just add the name filter + limit.
        rows = (
            await db.execute(
                AuthService(db).roles_query(scope).where(Role.name.ilike(like)).limit(_LIMIT)
            )
        ).scalars().all()
        for r in rows:
            results.append(
                {
                    "type": "role",
                    "id": str(r.id),
                    "label": r.name,
                    "sublabel": r.description or "Role",
                    "href": "/roles",
                    "icon": "heroicons-outline:shield-check",
                }
            )

    return {"results": results}
