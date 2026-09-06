"""`AuthService`, assembled from one mixin per concern.

A composition rather than five separate services because the methods call each
other freely (`create_user` needs `_require_role` and `_set_password`): one
object, one `self`, one transaction.

Mixin order is alphabetical and carries no meaning — no method is defined twice,
so the MRO never has to choose. Fix a future collision by renaming, not by
reordering this line.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .api_keys import ApiKeyMixin
from .roles import RolesMixin
from .sessions import SessionMixin
from .totp import TotpMixin
from .users import UsersMixin


class AuthService(ApiKeyMixin, RolesMixin, SessionMixin, TotpMixin, UsersMixin):
    def __init__(self, db: AsyncSession) -> None:
        self.db = db


__all__ = ["AuthService"]
