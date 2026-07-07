"""Tenancy dependencies — the super-admin gate.

``require_superadmin`` is a FastAPI dependency that 403s unless the caller is a
platform super-admin (User.is_superadmin True). It builds on the existing
``get_current_user`` (bearer JWT → live User row), so the check is authoritative:
it reads the current DB row, not just a token claim.
"""

from __future__ import annotations

from fastapi import Depends

from ..auth.deps import get_current_user
from ..auth.models import User
from ..core.errors import ForbiddenError


async def require_superadmin(user: User = Depends(get_current_user)) -> User:
    """Allow only platform super-admins through (403 otherwise)."""
    if not user.is_superadmin:
        raise ForbiddenError("super-admin privileges required")
    return user
