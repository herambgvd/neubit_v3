"""Connector factory — pick a ControllerConnector by ``instance.brand``.

This is the seam that makes future controller brands pluggable. v2 hardcoded DDS
everywhere; here the service layer only ever calls ``get_connector(instance,
secret)`` and gets back something implementing ``ControllerConnector``. Adding a
brand (ESSL, …) = add a module + one line here, no service changes.

The caller decrypts the instance secret first (the factory/connector never touch
the DB or the encryption key). ``secret`` may be empty for an unconfigured
instance — the connector will simply fail ``test_connection`` gracefully.
"""

from __future__ import annotations

import logging
from typing import Any

from .base import ControllerConnector
from .dds import DDSConnector

log = logging.getLogger("access.connector")


def _warn_about_transport(instance: Any, verify_tls: bool) -> None:
    """Say, out loud and per connector build, when a controller link is unprotected.

    Neither case below is BLOCKED, and that is deliberate: an access controller is
    usually a box on a building LAN with a self-signed certificate or no TLS at
    all, and refusing to talk to it would not make the deployment safer — it would
    make this service unusable and get the whole integration bypassed. What was
    wrong was that both were SILENT.

    Both send the controller's password. `_auth()` puts it in an HTTP Basic header,
    which is base64, not encryption.
    """
    base_url = str(getattr(instance, "base_url", "") or "")
    name = getattr(instance, "name", None) or getattr(instance, "id", "?")

    if base_url.startswith("http://"):
        log.warning(
            "access instance %s talks to its controller over PLAIN HTTP (%s) — the "
            "controller password is sent base64-encoded in a Basic auth header and "
            "is readable by anything on the path",
            name, base_url,
        )
    elif not verify_tls:
        log.warning(
            "access instance %s has TLS verification DISABLED (%s) — the connection "
            "is encrypted but unauthenticated, so anything that can intercept it can "
            "present its own certificate and read the controller password",
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
        # Default TRUE when the attribute is missing. It used to default False
        # here and in the schema, so an operator who never thought about TLS got
        # an unauthenticated connection and no indication of it.
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
