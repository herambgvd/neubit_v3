"""Pick a ControllerConnector by instance.brand.

The caller decrypts the instance secret first — the factory and connectors never
touch the DB or the encryption key. An unknown brand raises rather than falling
back silently.
"""

from __future__ import annotations

import logging
from typing import Any

from .base import ControllerConnector
from .dds import DDSConnector

log = logging.getLogger("access.connector")


def _warn_about_transport(instance: Any, verify_tls: bool) -> None:
    """Warn when a controller link is unprotected. Both cases send the password.

    Not blocked: controllers are usually LAN boxes with self-signed certs, and
    refusing them would get the integration bypassed rather than fixed. Loud, not
    forbidden.
    """
    base_url = str(getattr(instance, "base_url", "") or "")
    name = getattr(instance, "name", None) or getattr(instance, "id", "?")

    if base_url.startswith("http://"):
        log.warning(
            "access instance %s uses PLAIN HTTP (%s) — the controller password is "
            "sent as base64 in a Basic auth header",
            name, base_url,
        )
    elif not verify_tls:
        log.warning(
            "access instance %s has TLS verification DISABLED (%s) — encrypted but "
            "unauthenticated; an interceptor can present its own cert",
            name, base_url,
        )


def get_connector(instance: Any, *, secret: str = "") -> ControllerConnector:
    """Return the connector for ``instance.brand``.

    ``instance`` is an ``Instance`` ORM row (or anything exposing ``brand`` /
    ``base_url`` / ``auth_type`` / ``username``). Raises ``NotImplementedError``
    for a brand with no connector yet (clear, not a silent fallback).
    """
    brand = (getattr(instance, "brand", None) or "dds").lower()

    if brand == "dds":
        # Default True: an operator with no opinion should get a verified link.
        verify_tls = bool(getattr(instance, "verify_tls", True))
        _warn_about_transport(instance, verify_tls)
        return DDSConnector(
            base_url=instance.base_url,
            auth_type=getattr(instance, "auth_type", "basic") or "basic",
            username=getattr(instance, "username", "") or "",
            secret=secret,
            verify_tls=verify_tls,
        )

    raise NotImplementedError(
        f"no connector implemented for controller brand '{brand}' "
        f"(only 'dds' is supported in this phase)"
    )
