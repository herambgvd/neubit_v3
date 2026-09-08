"""Service-to-service JWT for workflow's BACKGROUND callers.

The transition path renders a notification with no HTTP request behind it (a
correlation-created incident, an escalation sweep), so there is no operator
bearer to forward. It mints a short-lived SUPERADMIN token here, signed with the
same kernel ``jwt_secret`` core verifies — exactly the shape vision uses for its
placement and audit calls (``app/vms/common/service_token.py`` there).

ONLY for internal calls; never returned to a browser.
"""

from __future__ import annotations

import time

import jwt

from kernel.config import get_settings

#: A fixed, reserved system-actor UUID for background service calls.
#: "…0f" ≈ workflow. Distinct from vision's "…ec" so an audit row says which
#: service acted.
_SYSTEM_SUB = "00000000-0000-0000-0000-00000000000f"
_ALG = "HS256"
_TTL_SEC = 120  # short-lived; minted fresh per call


def mint_service_token(*, tenant_id: str | None = None) -> str:
    """A short-lived superadmin service token for an internal core call."""
    now = int(time.time())
    return jwt.encode(
        {
            "sub": _SYSTEM_SUB,
            # Both kernels verify an ACCESS token; anything else is a 401.
            "type": "access",
            "tenant_id": tenant_id,
            "is_superadmin": True,
            "permissions": ["*"],
            "iat": now,
            "exp": now + _TTL_SEC,
        },
        get_settings().jwt_secret,
        algorithm=_ALG,
    )
