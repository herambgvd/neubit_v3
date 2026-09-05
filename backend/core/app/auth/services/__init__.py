"""`AuthService`, assembled from one mixin per concern.

It was a single 956-line class with fifty-odd methods covering five unrelated
jobs — sessions, TOTP, roles, user administration and service credentials. The
methods call each other freely and should keep doing so (`create_user` needs
`_require_role` and `_set_password`), so this is a composition rather than five
separate services: one object, one `self`, one transaction, and files small enough
that the blast radius of a change is visible from the import list.

Mixin order is alphabetical and carries no meaning — no method is defined twice, so
the MRO never has to choose. If a name ever collides, that is a bug to fix by
renaming, not by reordering this line.
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
