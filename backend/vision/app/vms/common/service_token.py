"""Service-to-service JWT for vision's BACKGROUND callers (P3-A).

The recording SCHEDULER + segment CONSUMER run outside any HTTP request, so they
have no operator bearer to forward to the Go ``nvr`` for start/stop. They mint a
short-lived **service token** here: a core-shaped superadmin JWT signed with the
SAME kernel ``jwt_secret`` the gokernel verifies. It carries ``is_superadmin: true``
(so it satisfies any ``vms.*`` permission on the nvr side) and a fixed system
``sub`` UUID (the gokernel requires ``sub`` to be a valid UUID).

This is ONLY for internal service calls (never returned to a browser). It mirrors
the claim shape gokernel/auth consumes: ``sub`` / ``tenant_id`` / ``is_superadmin``
/ ``permissions`` / ``iat`` / ``exp``.
"""

from __future__ import annotations

import time

import jwt

from kernel.config import get_settings

# A fixed, reserved system-actor UUID for background service calls (audit trail).
_SYSTEM_SUB = "00000000-0000-0000-0000-0000000000ec"  # "…ec" ≈ recording engine
_ALG = "HS256"
_TTL_SEC = 120  # short-lived; minted fresh per call


def mint_service_token(*, tenant_id: str | None = None) -> str:
    """Mint a short-lived superadmin service token for an internal nvr call.

    ``tenant_id`` scopes the path namespacing on the nvr side (the nvr derives the
    MediaMTX path tenant from the token). Pass the camera's tenant so recording
    lands under ``cameras/<tenant>/...``; ``None`` → the platform namespace.
    """
    now = int(time.time())
    claims = {
        "sub": _SYSTEM_SUB,
        # Both kernels verify an ACCESS token (Go: Type != "access" → 401; Python:
        # payload["type"] != "access" → 401). Set it so nvr accepts the call.
        "type": "access",
        "tenant_id": tenant_id,  # None → gokernel treats as platform
        "is_superadmin": True,
        "permissions": ["*"],
        "iat": now,
        "exp": now + _TTL_SEC,
    }
    return jwt.encode(claims, get_settings().jwt_secret, algorithm=_ALG)
