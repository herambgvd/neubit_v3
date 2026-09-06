"""Backwards-compatible re-export of :class:`AuthService` and its constants.

The implementation lives in `app/auth/services/`; this shim stays because a dozen
import sites name `app.auth.service`. `ADMIN_ROLE_NAME` is re-exported for
`tenancy/service.py` and `RESET_TTL` for the tests.
"""

from .services import AuthService
from .services._constants import ADMIN_ROLE_NAME, RESET_TTL

__all__ = ["AuthService", "ADMIN_ROLE_NAME", "RESET_TTL"]
