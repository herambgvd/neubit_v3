"""Enterprise security module (P6-D) — VMS-grade hardening.

Adds LDAP/AD sync, OIDC SSO, per-tenant 2FA enforcement, four-eyes dual
authorization, and DPDP/GDPR video-op audit ingest + right-to-erasure on top of the
auth hardening already in ``app/auth`` and the ``app/core/audit`` trail.

Mounted by ``app/app.py`` via ``security.routers``.
"""

from __future__ import annotations

from .router import routers  # noqa: F401
from .service import SecurityService  # noqa: F401
