"""Backwards-compatible re-export of :class:`AuthService` and its module constants.

The implementation moved to `app/auth/services/` (one module per concern). This
module stays because a dozen import sites name `app.auth.service`, and a rename
that touches every one of them is a worse change than a short shim.

`ADMIN_ROLE_NAME` is re-exported because `tenancy/service.py` imports it from here;
`RESET_TTL` because it is the kind of constant a test reaches for.
"""

from .services import AuthService
from .services._constants import ADMIN_ROLE_NAME, RESET_TTL

__all__ = ["AuthService", "ADMIN_ROLE_NAME", "RESET_TTL"]
