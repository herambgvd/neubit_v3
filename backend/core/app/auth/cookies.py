"""Refresh-token cookie helpers.

The refresh token is transported as an httpOnly cookie so it is invisible to
JavaScript (XSS cannot exfiltrate it). The short-lived access token continues to
travel as a Bearer header from the SPA's memory. Only ``/auth/refresh`` and
``/auth/logout`` need the cookie, so we scope its Path to the auth sub-tree.
"""

from __future__ import annotations

from fastapi import Response

from ..core.config import get_settings
from .security import REFRESH_TTL


def _cookie_path() -> str:
    return f"{get_settings().api_prefix}/auth"


def _secure() -> bool:
    s = get_settings()
    # Explicit override wins; otherwise Secure everywhere except local dev (HTTP).
    if s.refresh_cookie_secure is not None:
        return s.refresh_cookie_secure
    return s.env != "dev"


def set_refresh_cookie(response: Response, token: str) -> None:
    """Attach the httpOnly refresh cookie to an outgoing response."""
    s = get_settings()
    response.set_cookie(
        key=s.refresh_cookie_name,
        value=token,
        max_age=int(REFRESH_TTL.total_seconds()),
        httponly=True,
        secure=_secure(),
        samesite=s.refresh_cookie_samesite,
        path=_cookie_path(),
    )


def clear_refresh_cookie(response: Response) -> None:
    """Remove the refresh cookie (logout). Path/SameSite must match to delete it."""
    s = get_settings()
    response.delete_cookie(
        key=s.refresh_cookie_name,
        path=_cookie_path(),
        httponly=True,
        secure=_secure(),
        samesite=s.refresh_cookie_samesite,
    )
